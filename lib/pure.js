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
   stock は「その日に出せる上限」＝生地で作れるカップ数。作り置きはできないので
   棚にある数ではないが、売れる数の上限であることは変わらない。
   キャンセル以外は、未処理も受渡済みもすべてこの枠を消費している。 */
export function soldOf(orders, key){
  let n = 0;
  for(const o of orders){
    if(o.status === 'cancelled'){
      // 焼く前に中止したぶんは在庫に戻る。焼いたあとに中止したぶんは戻らない
      // （生地はもう使われている）。受け取ったカップ数ぶんだけ数え続ける。
      n += madeOf(o, key);
      continue;
    }
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
  const n = (tagCount >= 1 && tagCount <= 999) ? tagCount : DEFAULT_TAG_COUNT;
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

/* ============================================================
   焼き上がりの見積もりと、受け取り時刻のご案内（予約）

   ベビーカステラは作り置きができない（生地は残らないし、焼いたものは置けない）。
   焼ける速さは決まっていて、プレートは 3 枚しかなく、生地の交換と補充の間は
   止まる。だから「列が伸びる」ではなく「待ち時間が伸びる」形で詰まる。

   立って待たせ続けるかわりに、札を持って出直してもらう。そのために要るのは
     ・いま何カップ焼き待ちか（backlogCups）
     ・毎分何カップ焼けるか（rate。既定は 6個入り 1カップ＝1分）
     ・だからこの注文は何分後か（forecast）
   の 3 つだけ。ここは全部それの計算で、画面にも Firebase にも依存しない。
   ============================================================ */

/* ---------- 厨房の体制（何人で、いくつ焼けるか） ----------

   焼ける量を決めているのは台ではなく人。台は 6×5（30マス）・その半分（15マス）に
   加えて 16マス・32マス も増えるが、**1 人が同時に見られるのは 12 マスくらい**で、
   大きい台はマスを余らせて使う。大きい台を全部回すには厨房に 6 人要る、という
   実際の話がそのまま上限になる。

     1 人 … 12 マス ＝ 2 カップ ／ 1 回（4 分）
     4 人 … 48 マス ＝ 8 カップ ／ 4 分 ＝ 2 カップ/分

   だから設定するのは「いま厨房に何人立っているか」。シフトで人数が変われば、
   見積もりも、厨房の板に出る割り当ても一緒に変わる。
   作り置きはできないので、空いた口に焼き足して溜めることもできない。 */
export const PIECES_PER_CUP = 6;
/* 見込み率の既定は 75%。4 人・12 マス・4 分で 48個 ÷ 6 ÷ 4 × 0.75 = 毎分 1.5 カップ。
   当日（2026-10-03）の実測は、開店 30 分が毎分 1.21〜1.36、午後が 2.04 カップだった。
   100% のままだと立ち上がりで守れない時刻をご案内する（最大 21 分の遅れが出た）。 */
export const KITCHEN_DEFAULT = { people: 4, holes: 12, cycleMin: 4, margin: 75 };

/* 設定を安全な範囲に収める。画面と見積もりはここを通した値だけを見る。 */
export function kitchenOf(v){
  const n = (x, min, max, def) => {
    const i = Math.round(Number(x));
    return Number.isFinite(i) && i >= min && i <= max ? i : def;
  };
  return {
    people:   n(v?.people,   1, 12, KITCHEN_DEFAULT.people),
    holes:    n(v?.holes,    1, 60, KITCHEN_DEFAULT.holes),
    cycleMin: n(v?.cycleMin, 1, 30, KITCHEN_DEFAULT.cycleMin),
    margin:   n(v?.margin,  10, 100, KITCHEN_DEFAULT.margin),
  };
}

/* 1 回（1 サイクル）で焼ける個数。 */
export function cyclePieces(v){
  const k = kitchenOf(v);
  return k.people * k.holes;
}

/* 毎分何カップ焼けるか。見積もりの根拠はこの 1 本。
   4 人・12 マス・4 分・見込み 100% なら 48/6/4 = 2.0 カップ/分。 */
export function rateFromKitchen(v){
  const k = kitchenOf(v);
  const r = cyclePieces(k) / PIECES_PER_CUP / k.cycleMin * (k.margin / 100);
  return r > 0 ? r : RATE_DEFAULT;
}

/* 設定が壊れているときの保険。1 人ぶん（4 分に 2 カップ）。 */
export const RATE_DEFAULT = 0.5;

/* 見積もりに足す手間ぶん。焼き上がってから渡すまでに必ずかかる。 */
export const PICKUP_MARGIN_MIN = 2;
/* 予約（受け取り時刻のご案内）を自動で始める／戻すしきい値。
   始めると戻すで差を付けないと、8 分の前後を行き来するたびに案内が変わる。 */
export const RESERVE_ON_MIN  = 8;
export const RESERVE_OFF_MIN = 5;
/* 受付を止める／再開するしきい値。約束できない時刻を発行しないための歯止め。 */
export const STOP_WAIT_MIN   = 30;
export const RESUME_WAIT_MIN = 25;

/* この注文の、まだ焼けていないカップ数。
   made は「受渡口が受け取ったカップ数」（味ごと）。部分的に焼き上がるので、
   注文を 1 つの塊として数えると、焼き待ちの量が実際より多く出る。 */
export function leftOf(o){
  if(!o || o.status !== 'pending') return 0;
  let n = 0;
  for(const i of (o.items || [])) n += Math.max(0, (i.quantity || 0) - madeOf(o, i.flavor));
  return n;
}
/* 味ごとの「受け取った数」。注文数を超えては数えない。 */
export function madeOf(o, key){
  const want = (o?.items || []).find(i => i.flavor === key)?.quantity || 0;
  return Math.max(0, Math.min(want, Math.floor(o?.made?.[key] || 0)));
}
/* 番号札の既定枚数。実物のケースが 60 枚なので、設定が無いときはこれを使う。 */
export const DEFAULT_TAG_COUNT = 60;

/* ---------- 届いた分をまとめて配る ----------
   厨房は注文ごとではなく「ゆず 12・チョコ 6」のように板ごと持ってくる。
   受渡口が 1 カップずつ押すと、混んでいるときに押す回数が行列の律速になる。
   届いた総数を味ごとに受け取り、焼き待ちの注文へ割り当てる。

   割り当ては受付順。厨房が焼く順がそれなので、物理の束と画面の束が一致する。
   足りない分は後の注文に残り、余った分は left として返す（どこにも書かない）。 */
export function planDeal(list, arrived){
  const left = {};
  for(const [k, v] of Object.entries(arrived || {})){
    const n = Math.floor(Number(v) || 0);
    if(n > 0) left[k] = n;
  }
  const rows = [];
  for(const o of (list || []).filter(x => x.status === 'pending').sort(byOrder)){
    const add = {};
    let any = 0;
    for(const i of (o.items || [])){
      const need = Math.max(0, (i.quantity || 0) - madeOf(o, i.flavor));
      const give = Math.min(need, left[i.flavor] || 0);
      if(give > 0){ add[i.flavor] = give; left[i.flavor] -= give; any += give; }
    }
    if(!any) continue;
    const done = (o.items || []).every(i =>
      madeOf(o, i.flavor) + (add[i.flavor] || 0) >= (i.quantity || 0));
    rows.push({ id: o.id, number: o.number, seq: o.seq, add, cups: any, done });
  }
  for(const k of Object.keys(left)) if(!left[k]) delete left[k];
  return { rows, left };
}

/* いま焼き待ちが欲しているカップ数（味ごと）。配る数の上限に使う。 */
export function dealDemand(list){
  const d = {};
  for(const o of (list || []).filter(x => x.status === 'pending')){
    for(const i of (o.items || [])){
      d[i.flavor] = (d[i.flavor] || 0) + Math.max(0, (i.quantity || 0) - madeOf(o, i.flavor));
    }
  }
  return d;
}

/* 全部そろったか。1 つも頼んでいない注文は「そろっている」とは言わない。 */
export function allMade(o){
  const items = o?.items || [];
  return items.length > 0 && items.every(i => madeOf(o, i.flavor) >= (i.quantity || 0));
}

/* 味ごとの、まだ焼けていない個数（カップではなく穴の数で数える）。
   プレートに載せる数を決めるので、厨房はここだけ個で考える。 */
export function piecesLeft(orders, key){
  let cups = 0;
  for(const o of orders){
    if(o.status !== 'pending') continue;
    for(const i of (o.items || [])){
      if(i.flavor !== key) continue;
      cups += Math.max(0, (i.quantity || 0) - madeOf(o, i.flavor));
    }
  }
  return cups * PIECES_PER_CUP;
}

/* いま焼くものを、1 人ずつ（＝台 1 つずつ）に割り当てる。

   大きいプレートから順に、受付順で先に要る味へ当てる。味ごとの合計が多いほうへ
   単純に寄せると、古い注文の味がいつまでも焼かれない（1 つの台に 1 つの味しか
   載らないため、多いほうだけを焼き続けることになる）。だから先に
   「受付順に、全員ぶんの口が埋まるところまで」拾って、それを配る。 */
export function planBakers(orders, kitchen, flavorKeys){
  const k = kitchenOf(kitchen);
  const list = [];
  for(let i = 0; i < k.people; i++)
    list.push({ label: `台${i+1}`, holes: k.holes, flavor: null, pieces: 0 });

  const cap = k.people * k.holes;
  // 受付順に、口が埋まるまで拾う。
  const want = {};
  for(const key of flavorKeys) want[key] = 0;
  let taken = 0;
  for(const o of [...orders].sort(byOrder)){
    if(o.status !== 'pending') continue;
    for(const i of (o.items || [])){
      if(!(i.flavor in want)) continue;
      const left = Math.max(0, (i.quantity || 0) - madeOf(o, i.flavor)) * PIECES_PER_CUP;
      const put = Math.min(left, cap - taken);
      want[i.flavor] += put;
      taken += put;
      if(taken >= cap) break;
    }
    if(taken >= cap) break;
  }

  // 拾ったぶんを配る。
  //
  // 1 つの台には 1 つの味しか載らないので、多いほうへ素直に寄せると、
  // 少ないほうの味（＝古い注文のことが多い）が最後まで焼かれない。
  // 残りの台数が「まだ 1 つも当たっていない味の数」に並んだら、そちらを先に当てる。
  const served = new Set();
  for(let i = 0; i < list.length; i++){
    const spot = list[i];
    const left = list.length - i;
    const needing  = flavorKeys.filter(key => want[key] > 0);
    if(!needing.length) break;               // 焼くものが無い＝残りは空き
    const unserved = needing.filter(key => !served.has(key));
    const from = (unserved.length >= left && unserved.length) ? unserved : needing;
    const pick = from.reduce((a, b) => (want[b] > want[a] ? b : a));
    spot.flavor = pick;
    spot.pieces = Math.min(want[pick], spot.holes);
    want[pick] -= spot.pieces;
    served.add(pick);
  }
  return list;
}

/* いま焼き待ちのカップ数の合計。 */
export function backlogCups(orders){
  let n = 0;
  for(const o of orders) n += leftOf(o);
  return n;
}

/* いちばん古い焼き待ちが、何分待っているか。予約を始める判断はこれで行う。 */
export function oldestWaitMin(orders, now = Date.now()){
  let oldest = 0;
  for(const o of orders){
    if(o.status !== 'pending' || !o.createdMs) continue;
    const m = (now - o.createdMs) / 60000;
    if(m > oldest) oldest = m;
  }
  return Math.floor(oldest);
}

/* 実測の焼き上がり速度（毎分カップ数）。直近 windowMin 分で受渡待ちになった
   カップ数から求める。calledAt は「用意できた」を押した時刻なので、
   焼き上がった時刻とみなせる。
   件数が少ないうちは当てにならないので、足りなければ null を返す。 */
export function measuredRate(orders, now = Date.now(), windowMin = 10){
  const from = now - windowMin * 60000;
  let cups = 0;
  for(const o of orders){
    if(o.status === 'cancelled') continue;
    const at = o.calledAt || 0;
    if(at < from || at > now) continue;
    cups += o.quantity || 0;
  }
  if(cups < 6) return null;              // 1 分ぶんにも満たない実測は使わない
  return cups / windowMin;
}

/* いま注文を受けたら、いつ渡せるか。
   addCups はこれから受ける注文のカップ数（0 なら「いまの待ち時間」）。 */
export function forecast(orders, { now = Date.now(), rate = RATE_DEFAULT, addCups = 0 } = {}){
  const r = (Number.isFinite(rate) && rate > 0) ? rate : RATE_DEFAULT;
  const add = Math.max(0, addCups);
  const backlog = backlogCups(orders);
  const cups = backlog + add;
  // 焼き待ちが 1 カップも無ければ、その場で焼いて渡せる。
  const waitMin = cups > 0 ? Math.ceil(cups / r) + PICKUP_MARGIN_MIN : 0;
  return { backlog, cups, rate: r, waitMin, pickupMs: now + waitMin * 60000 };
}

/* 予約を出すか。mode は 'auto' | 'on' | 'off'。
   auto のときだけ最長待ちで決める。wasOn を渡すと、戻すしきい値が別になる
   （8 分で始めて、5 分を下回るまで続ける）。 */
export function reserveOn(mode, orders, now = Date.now(), wasOn = false){
  if(mode === 'on')  return true;
  if(mode === 'off') return false;
  const m = oldestWaitMin(orders, now);
  return wasOn ? m >= RESERVE_OFF_MIN : m >= RESERVE_ON_MIN;
}

/* 受付を止めるか。約束した時刻に渡せないほど溜まったら、受けるのをやめる。
   止めたあとは 25 分を下回るまで再開しない（境目で開け閉めしないため）。 */
export function stopIntake(waitMin, wasStopped = false){
  return wasStopped ? waitMin > RESUME_WAIT_MIN : waitMin > STOP_WAIT_MIN;
}

/* ---------- 生地（ボウル） ----------
   1 ボウル 400g で 3 カップ（18 個）。1 カップ ≒ 133g、1 個 ≒ 22g。

   焼く速さより先に、**混ぜる速さ**が効く。4 人で焼けば毎分 2 カップ＝
   1.5 分に 1 ボウル空くので、混ぜ続ける人が常時 1 人要る。その人は焼けない。
   だから厨房の人数（＝焼く人）に、混ぜる人を数えてはいけない。 */
export const BOWL_CUPS  = 3;
export const BOWL_GRAMS = 400;
export const bowlsFor = cups => Math.ceil(Math.max(0, cups) / BOWL_CUPS);
export const gramsFor = cups => bowlsFor(cups) * BOWL_GRAMS;
/* 重さの表示。1kg を超えたら kg にする（4.8kg と 4800g では読む速さが違う）。 */
export const weightText = g => g >= 1000 ? `${(g / 1000).toFixed(1)}kg` : `${g}g`;

/* ---------- 売れる速さと、生地が尽きるまで ----------
   焼ける速さ（人数で決まる）とは別の軸。こちらは「どれだけ出ているか」。
   売り切れは必ず起きるので、何分前に分かるかが全てになる。 */

/* 直近 windowMin 分で売れたカップ数 ÷ 分。中止した注文は数えない。
   実績が薄いうちは当てにならないので、足りなければ null。 */
export function soldRate(orders, key, now = Date.now(), windowMin = 10){
  const from = now - windowMin * 60000;
  let cups = 0;
  for(const o of orders){
    if(o.status === 'cancelled') continue;
    const at = o.createdMs || 0;
    if(at < from || at > now) continue;
    for(const i of (o.items || [])) if(i.flavor === key) cups += i.quantity || 0;
  }
  if(cups < 3) return null;              // 3 カップ未満の実績では決めない
  return cups / windowMin;
}

/* 生地が尽きるまでの分。残り ÷ 売れる速さ。
   売れていない（rate が null か 0）なら null＝まだ言えない。 */
export function stockOutMin(remainingCups, rate){
  if(!(rate > 0)) return null;
  if(!(remainingCups > 0)) return 0;
  return Math.floor(remainingCups / rate);
}

/* 受け取り時刻の表示。端末の時計をそのまま使う（会場の時計と同じであること）。 */
export function hhmm(ms){
  if(!ms) return '';
  // JST で固定する。端末の時計が正しくても、タイムゾーンが日本以外に設定された
  // iPad が 1 台あると、お客様にご案内する時刻だけが別の時刻になる
  // （時計のずれではなく設定の違いなので、気づく手がかりが画面に出ない）。
  const d = new Date(ms + 9 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
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
    maxPerOrder, remaining, immediate, tag, tagCount, inUseTags, session, paid, pickupMs
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

  // 札の決定。札なしの注文は札を使わない（使うと実在しない札を飛ばすことになる）。
  let useTag = 0;
  if(!immediate){
    useTag = tag || seq;
    // 札を指定したかどうかに関わらず検査する。指定したときだけ見ていると、
    // 札切れで 0 が渡ったときに実在しない番号やまだ出ている札が通る。
    const n = (tagCount >= 1 && tagCount <= 999) ? tagCount : DEFAULT_TAG_COUNT;
    if(useTag < 1 || useTag > n)             return fail(`番号札 ${useTag} は 1〜${n} の範囲外です`);
    if((inUseTags || []).includes(useTag))   return fail(`番号札 ${useTag} はまだ出ています`);
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
    // 札なしの注文は厨房を飛ばして受渡待ちから始める。受渡と支払いは必ず通す。
    status: immediate ? 'ready' : 'pending',
    paid: paid === true,
    createdAt: hhmmss,
    createdMs: nowMs,
    updatedMs: nowMs,
    session: session || DEFAULT_SESSION
  };
  // Go は tag=0 を書かない（json:"tag,omitempty"）。
  // 書き込む形が一致していないと、同じ注文でも DB 上の姿が端末によって変わる。
  if(useTag > 0) o.tag = useTag;
  // 受け取り時刻の案内。過去や、丸一日先のような値は記録しない（Go と同じ規則）。
  if(pickupMs > nowMs && pickupMs < nowMs + 24 * 60 * 60 * 1000) o.pickupMs = pickupMs;
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
