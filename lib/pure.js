/* ============================================================
   画面にもFirebaseにも依存しない純粋なロジック。
   ここに置いたものは Node からそのまま import してテストできる。

   置く基準は「間違うと売上か行列が壊れるか」。DOM を触る処理は app.js に、
   金額・在庫・札・並び順のような壊れると困る判断はここに集める。
   ============================================================ */

export const yen = n => Number(n || 0).toLocaleString('ja-JP');

/* 商品マスタ引き。マスタに無いキーはキーのまま返す（データを隠さない）。 */
export const flavorOf = (flavors, key) => flavors.find(f => f.key === key) || null;
export const labelOf  = (flavors, key) => flavorOf(flavors, key)?.label || key;
export const unitOf   = (flavors, key) => flavorOf(flavors, key)?.unit  || 'カップ';

/* ---------- 営業回 ----------
   リハーサルと本番を同じ DB で回すため、注文は営業回 (session) で仕切る。
   古いデータには session が無いので、既定の 'default' に属するとみなす。 */
export const DEFAULT_SESSION = 'default';
export const sessionOf = o => o.session || DEFAULT_SESSION;
export const inSession = (o, session) => sessionOf(o) === (session || DEFAULT_SESSION);

/* ---------- 在庫 ----------
   作り置きなので「用意した数 − 売れた数」が売れる数。
   キャンセル以外は、未処理も受渡済みもすべて在庫を消費している。 */
export function soldOf(orders, key){
  let n = 0;
  for(const o of orders){
    if(o.status === 'cancelled') continue;
    for(const i of (o.items || [])) if(i.flavor === key) n += i.quantity || 0;
  }
  return n;
}
export const stockOf = (limits, key) =>
  Number.isFinite(limits?.stock?.[key]) ? limits.stock[key] : 0;
export const remainingOf = (orders, limits, key) =>
  Math.max(0, stockOf(limits, key) - soldOf(orders, key));

/* いまカートに入れられる上限＝残り在庫と、1注文の残り枠の小さいほう。 */
export function headroomOf(orders, limits, cart, flavors, key){
  const others = flavors.reduce((s, f) => s + (f.key === key ? 0 : (cart[f.key] || 0)), 0);
  return Math.max(0, Math.min(remainingOf(orders, limits, key), (limits.maxPerOrder || 0) - others));
}

/* ---------- 番号札 ----------
   いま出ている札＝お客様が持っている札。未処理と受渡待ちが該当する。
   支払い済みかどうかは札の所在と無関係なので見ない。 */
export function tagsInUse(orders){
  const out = [];
  for(const o of orders){
    if((o.status === 'pending' || o.status === 'ready') && o.tag > 0) out.push(o.tag);
  }
  return out;
}

/* 次に出す札。Go の order.NextTag と同じ規則（前回の次から昇順・出ている札は
   飛ばす・端で折り返す）。空きが無ければ 0。
   受付係が実物を見て選び直せるよう、これは「提案」であって強制ではない。 */
export function nextFreeTag(last, tagCount, inUse){
  const n = (tagCount >= 1 && tagCount <= 999) ? tagCount : 50;
  const set = new Set(inUse || []);
  const from = (last >= 1 && last <= n) ? last : 0;
  for(let i = 1; i <= n; i++){
    const t = ((from + i - 1) % n) + 1;
    if(!set.has(t)) return t;
  }
  return 0;
}

/* ---------- 並び順 ---------- */
export const seqOf  = o => (o.seq || 0) * 1e14 + (o.createdMs || 0);
export const byOrder = (a, b) => seqOf(a) - seqOf(b);

/* ---------- 表示整形 ---------- */
export function itemsText(flavors, o){
  return (o.items || [])
    .map(i => `${labelOf(flavors, i.flavor)} ${i.quantity}${unitOf(flavors, i.flavor)}`)
    .join(' ／ ');
}

export const elapsedSec = (ms, now = Date.now()) => ms ? Math.max(0, Math.floor((now - ms) / 1000)) : 0;
export const mmss = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');

/* しきい値はファストフードの KDS に合わせて 3 分・6 分。
   「困ってから」ではなく「困る前」に気づける位置に置く。 */
export const KDS_WARN_SEC = 180;
export const KDS_LATE_SEC = 360;
export const ageOf = sec => sec >= KDS_LATE_SEC ? 'late' : sec >= KDS_WARN_SEC ? 'warn' : 'ok';

export function waitText(ms, now = Date.now()){
  if(!ms) return '';
  const m = Math.floor((now - ms) / 60000);
  return m < 1 ? 'たった今' : `${m}分経過`;
}
export function waitClass(ms, now = Date.now()){
  if(!ms) return '';
  const m = (now - ms) / 60000;
  return m >= 10 ? 't-late' : m >= 5 ? 't-warn' : '';
}

/* ---------- 旧データの正規化 ----------
   items を持たない単一商品の旧レコードを 1 明細に寄せ、描画側を分岐させない。 */
export function normalize(o, key){
  const r = { ...o, id: o.id || key };
  if(!Array.isArray(r.items) || !r.items.length){
    r.items = r.flavor
      ? [{ flavor: r.flavor, quantity: r.quantity || 0, unitPrice: r.unitPrice || 0, price: r.price || 0 }]
      : [];
  }
  r.price    = r.price    ?? r.items.reduce((s, i) => s + (i.price || 0), 0);
  r.quantity = r.quantity ?? r.items.reduce((s, i) => s + (i.quantity || 0), 0);
  r.paid     = r.paid === true;
  return r;
}

/* ---------- WASM が落ちているときの注文組み立て ----------
   集計モジュールが読めなくても受付だけは止めない。Go の order.BuildOrder と
   同じ結果になることを test/pure_parity_test.mjs で突き合わせている
   （二重実装なので、ズレたら気づけるようにしておく）。 */
export function fallbackBuild(req){
  const {
    seq, nowMs, items, prices, flavors,
    maxPerOrder, remaining, immediate, tag, tagCount, inUseTags, session, paid
  } = req;

  const fail = error => ({ ok: false, error });
  if(!(seq > 0 && seq <= 999999)) return fail(`注文番号の採番に失敗しました (seq=${seq})`);
  if(!(nowMs > 0))                return fail('受付時刻が取得できませんでした');

  const cap = (maxPerOrder >= 1 && maxPerOrder <= 99) ? maxPerOrder : 10;

  // 同じ商品が 2 行に分かれて届いても 1 行にまとめる。
  const order = [];
  const merged = {};
  for(const it of (items || [])){
    if(!flavorOf(flavors, it.flavor)) return fail(`商品が選択されていません (flavor="${it.flavor}")`);
    if(it.quantity < 0 || it.quantity > cap)
      return fail(`${labelOf(flavors, it.flavor)} は 0〜${cap}${unitOf(flavors, it.flavor)}で指定してください (指定=${it.quantity})`);
    if(!(it.flavor in merged)) order.push(it.flavor);
    merged[it.flavor] = (merged[it.flavor] || 0) + it.quantity;
  }

  const built = [];
  let total = 0, totalQty = 0;
  for(const key of order){
    const qty = merged[key];
    if(qty === 0) continue;
    if(qty > cap)
      return fail(`${labelOf(flavors, key)} は 0〜${cap}${unitOf(flavors, key)}で指定してください (指定=${qty})`);
    if(remaining){
      const left = remaining[key];
      if(!(left > 0))  return fail(`${labelOf(flavors, key)} は売り切れです`);
      if(qty > left)   return fail(`${labelOf(flavors, key)} は残り ${left}${unitOf(flavors, key)} です`);
    }
    const up = prices?.[key];
    if(up === undefined || up === null) return fail(`${labelOf(flavors, key)} の単価が設定されていません`);
    if(!(up >= 1 && up <= 100000))      return fail(`${labelOf(flavors, key)} の単価が不正です (${up}円)`);
    const price = up * qty;
    built.push({ flavor: key, quantity: qty, unitPrice: up, price });
    total += price; totalQty += qty;
  }
  if(!built.length)       return fail('商品が 1 つも選ばれていません');
  if(totalQty > cap)      return fail(`1回のご注文は合計 ${cap} カップまでです (指定=${totalQty})`);

  // 札の決定。その場渡しは札を使わない（使うと実在しない札を飛ばすことになる）。
  let useTag = 0;
  if(!immediate){
    useTag = tag || seq;
    if(tag){
      const n = (tagCount >= 1 && tagCount <= 999) ? tagCount : 50;
      if(tag < 1 || tag > n)                return fail(`番号札 ${tag} は 1〜${n} の範囲外です`);
      if((inUseTags || []).includes(tag))   return fail(`番号札 ${tag} はまだ出ています`);
    }
  }

  const id = `order_${String(seq).padStart(6, '0')}_${nowMs}`;
  const d = new Date(nowMs);
  const jst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60000);
  const hhmmss = [jst.getHours(), jst.getMinutes(), jst.getSeconds()]
    .map(v => String(v).padStart(2, '0')).join(':');

  const o = {
    id, seq,
    number: useTag > 0 ? '#' + String(useTag).padStart(3, '0') : '',
    items: built,
    quantity: totalQty,
    price: total,
    status: immediate ? 'completed' : 'pending',
    paid: paid === true,
    createdAt: hhmmss,
    createdMs: nowMs,
    updatedMs: nowMs,
    session: session || DEFAULT_SESSION
  };
  // Go は tag=0 を書かない（json:"tag,omitempty"）。
  // 書き込む形が一致していないと、同じ注文でも DB 上の姿が端末によって変わる。
  if(useTag > 0) o.tag = useTag;
  if(paid === true) o.paidMs = nowMs;
  if(built.length === 1){ o.flavor = built[0].flavor; o.unitPrice = built[0].unitPrice; }
  return { ok: true, path: 'orders/' + id, order: o };
}

/* ---------- 金額表示へ渡す明細 ----------
   お客様側の端末では商品名ではなく水彩の絵で見せたいので、配信する明細は
   「表示済みの文章」ではなく「商品キーと個数」を保つ形にする。

   display/payment の items は 200 文字までの文字列 1 つ（ルールで固定）。
   ここを配列に変えるとルールの改訂と再公開が要るため、文字列のまま
   "plain:4|flavor_b:2" という詰め方で持つ。読み書きは必ずこの 2 つを通す。 */
export function encodeLines(items){
  return (items || [])
    .filter(i => i && i.flavor && i.quantity > 0)
    .map(i => `${i.flavor}:${i.quantity}`)
    .join('|')
    .slice(0, 200);
}

export function decodeLines(str){
  if(!str) return [];
  // 旧い形式（「ゆずカステラ 4カップ」のような文章）が来たら空にする。
  // 絵に変換できないものを無理に出すより、金額だけを見せるほうがよい。
  if(!/^[a-z0-9_]+:\d+(\|[a-z0-9_]+:\d+)*$/i.test(str)) return [];
  return str.split('|').map(part => {
    const [flavor, qty] = part.split(':');
    return { flavor, quantity: parseInt(qty, 10) || 0 };
  }).filter(i => i.quantity > 0);
}
