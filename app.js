/* Firebase SDK は取り込んで自前で配信する（vendor/firebase/、tools/vendor-firebase.sh）。
   gstatic から直接読むと、会場の回線が詰まった瞬間にアプリが起動すらしない。
   ここが起動経路上の唯一の外部依存だったので外した。版を上げるときは
   tools/vendor-firebase.sh を実行して結果をコミットする。 */
import { initializeApp } from "./vendor/firebase/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "./vendor/firebase/firebase-auth.js";
import { getDatabase, ref, onValue, set, update, onDisconnect, runTransaction, get }
  from "./vendor/firebase/firebase-database.js";

import * as audio from "./lib/audio.js";
import { countUp, bloom, nudge, reduced } from "./lib/motion.js";
import {
  soldOf as pureSold, remainingOf as pureRemaining, headroomOf as pureHeadroom,
  tagsInUse as pureTagsInUse, fallbackBuild, normalize, inSession, DEFAULT_SESSION,
  seqOf, byOrder, waitText, waitClass, elapsedSec, mmss, ageOf,
  encodeLines, decodeLines,
  madeOf, backlogCups, oldestWaitMin, measuredRate, planDeal, dealDemand,
  voidedOf, wantOf, netPriceOf, netQtyOf, heldOf,
  forecast, reserveOn, stopIntake, hhmm,
  kitchenOf, cyclePieces, rateFromKitchen, planBakers, piecesLeft,
  usedPlates, kitchenPeople, batterRate,
  soldRate, stockOutMin, bowlsFor, gramsFor, weightText,
  PIECES_PER_CUP, KITCHEN_DEFAULT
} from "./lib/pure.js";

/* DB 書き込みの失敗理由を切り分ける。
   PERMISSION_DENIED を「通信を確かめて」と出すと、原因がルールや認証にあるのに
   回線を疑わせることになり、原因探しが遠回りになる。 */
function writeHint(err, what){
  const code = String(err?.code || err?.message || '');
  if(code.includes('PERMISSION_DENIED') || code.includes('permission_denied'))
    return what + '：データベースに拒否されました。ルールの公開と「匿名ログイン」の有効化を確認してください。';
  if(code.includes('network') || code.includes('unavailable'))
    return what + '：通信を確かめて、もう一度お試しください。';
  return what + '：' + (err?.message || code || '不明なエラー');
}

/* 接続設定は firebase-config.js に置く（環境ごとに異なり、CI が生成する）。
   ここの値は秘密ではない。データの保護は database.rules.json が担う。 */
const firebaseConfig = window.FIREBASE_CONFIG;
/* 足りないものを名指しする。「設定がありません」とだけ出すと、
   どの値が欠けているのか分からず原因探しが遠回りになる。 */
const configProblem = (()=>{
  if(!firebaseConfig) return 'firebase-config.js が読み込まれていません。firebase-config.sample.js をコピーして作ってください。';
  if(String(firebaseConfig.apiKey||'').startsWith('YOUR_') || !firebaseConfig.apiKey)
    return 'firebase-config.js の apiKey が未設定です。';
  if(!firebaseConfig.databaseURL)
    return 'Realtime Database の URL（databaseURL）が未設定です。Firebase コンソールで Realtime Database を作成し、表示された URL を firebase-config.js に貼ってください。';
  return null;
})();
if(configProblem){
  document.body.insertAdjacentHTML('afterbegin',
    '<div role="alert" style="background:#b91c1c;color:#fff;padding:16px;text-align:center;font-weight:700;line-height:1.7">'+
    configProblem+'</div>');
  throw new Error('FIREBASE_CONFIG: '+configProblem);
}
const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);
const db    = getDatabase(fbApp);

/* 商品マスタは goLabels() が唯一の正。WASM が来るまでは写真どおりの既定値で描く。 */
let FLAVORS = [
  { key:'plain',    label:'ゆずカステラ',   short:'ゆず',   unit:'カップ', pieces:6, defaultPrice:250, defaultStock:100,
    note:'ゆずの爽やかな香りが広がる、しっとりとしたカステラです。' },
  { key:'flavor_b', label:'チョコカステラ', short:'チョコ', unit:'カップ', pieces:6, defaultPrice:250, defaultStock:100,
    note:'ほどよい甘さのチョコレートが香る、しっとりカステラです。' }
];
/* 商品の絵は水彩イラストを使う。写真は使わない。
   生成写真は意匠（水彩の和菓子包み）から浮き、画面の品を落とすため外した。 */
const MARK  = { plain:'art/mark-yuzu.png', flavor_b:'art/mark-cacao.png' };
let MAX_QTY = 10;

let prices = { plain:250, flavor_b:250 };
/* stock は「その日に出せる上限」＝用意した生地で作れるカップ数。
   作り置きはできないので棚にある数ではないが、売れる数の上限は同じ。
   maxPerOrder は 1 組のお客様が買い占めないための 1 注文あたりの合計上限。 */
let limits = { maxPerOrder:10, stock:{ plain:100, flavor_b:100 }, tagCount:60 };
/* 番号札を使うかどうかは時間帯で変わる（空いていれば札は不要）。
   店全体の運用なので端末ごとではなく共有する。 */
let useTags = true;
let cart   = { plain:0,   flavor_b:0   };
/* allOrders は DB にある全部、orders は「いまの営業回」だけ。
   画面と集計は必ず orders を見る。リハーサルの注文が本番の売上に混ざるのを
   ここで断つ（注文を消さずに仕切れるので、記録も失われない）。 */
let allOrders = [];
let orders = [];
let session = DEFAULT_SESSION;
/* 新規着信の検知は件数ではなく ID の集合で見る。件数だと
   「1 件が次へ進む」と「1 件増える」が同時に起きたとき差が 0 になり、鳴らない。 */
let knownIds = new Set();
let firstSnap = true;

const $ = id => document.getElementById(id);

/* 支払い口の番号。金額の配信先を口ごとに分けるために使う。
   URL に #pay:2 のように付けると、その端末は 2 番目の口として振る舞う。 */
/* URL に番号が無ければ main。以前は端末に覚えさせていたが、前に #pay:2 で
   使った iPad を素の #pay で開くと黙って 2 口目として振る舞い、お客様側の
   画面に金額が出ない（しかも原因を示すものが画面に何も出ない）。
   読み込み時に一度だけ決めて、以後ハッシュを変えても動かさない
   （購読は読み込み時に張るので、書き込み先だけがずれると配信が迷子になる）。 */
const STATION = (()=>{
  const m = (location.hash || '').match(/^#(?:pay|amount):([A-Za-z0-9_-]{1,16})$/);
  return m ? m[1] : 'main';
})();
function station(){ return STATION; }
const label = k => (FLAVORS.find(f=>f.key===k)||{}).label || k;
/* 厨房は 1m 離れて一瞥する画面。正式名称を同じ幅に収めると字が小さくなって
   読めなくなるので、そこだけ短い名前を使う。 */
const shortLabel = k => (FLAVORS.find(f=>f.key===k)||{}).short || label(k);
const unit  = k => (FLAVORS.find(f=>f.key===k)||{}).unit  || '個';
/* 画面に出す番号。番号札を使わない注文には札が無いので、受付順の通し番号を出す。
   札の番号と紛れないよう「受付」を頭に付ける。ここが空欄のままだと、
   受渡口と支払い口で「どの注文か」を口頭で確かめるしかなくなる。 */
const numOf = o => o?.number || (o?.seq ? `受付${o.seq}` : '—');
const yen   = n => n.toLocaleString('ja-JP');
const pieces = k => (FLAVORS.find(f=>f.key===k)||{}).pieces || 0;

/* 在庫・札・並び順の判断は lib/pure.js が持つ（Node からテストできる）。
   ここはそれに「いまの営業回の注文」を渡すだけの薄い層。 */
const soldOf      = (k, list) => pureSold(list || orders, k);
/* 引数を省いたら「いまの営業回の注文」を見る。純粋関数側は対象を必ず受け取る形に
   してあるので、ここで既定を与えないと呼び忘れが実行時エラーになる。 */
const tagsInUse   = list => pureTagsInUse(list || orders);
const stockOf     = k => Number.isFinite(limits.stock?.[k]) ? limits.stock[k] : 0;
const tagCount    = () => limits.tagCount || 60;
const remainingOf = (k, list) => pureRemaining(list || orders, limits, k);
const headroomOf  = key => pureHeadroom(orders, limits, cart, FLAVORS, key);

/* ---------- トースト ---------- */
let toastT;
/* undo を渡すと「戻す」が付く。
   受渡の「用意できた」のように、止めると行列が詰まるが押し間違いもある操作は、
   確認ダイアログで止めるのではなく、後から取り消せるようにする。 */
function toast(msg, kind='error', undo=null, ms=5200){
  const t = $('toast');
  t.textContent = msg;
  t.dataset.kind = kind;
  if(undo){
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-undo'; b.textContent = '戻す';
    b.addEventListener('click', ()=>{ t.classList.remove('show'); undo(); });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(()=>t.classList.remove('show'), ms);
}

/* ---------- モーダル（フォーカストラップ・Esc・復帰） ---------- */
const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
let openEl = null, lastFocus = null, onClose = null;
/* 閉じたときに必ず走らせたい後始末を預ける。
   ボタン側にだけ書くと、Esc や別モーダルへの差し替えで閉じたときに走らない。
   支払い口ではこれが「お客様の画面に金額が出しっぱなし」に直結する。 */
function openModal(id, cleanup){
  // 前のモーダルを閉じずに重ねると、openEl が差し替わって前の 1 枚が
  // .open のまま取り残され、閉じる手段が無くなる。必ず差し替えにする。
  if(openEl){
    if(openEl.id === id) return;
    openEl.classList.remove('open');
  }else{
    lastFocus = document.activeElement;   // 戻り先は最初の 1 枚だけ覚える
  }
  if(onClose){ const f = onClose; onClose = null; f(); }
  onClose = cleanup || null;
  openEl = $(id); openEl.classList.add('open');
  // どの紙が出ているかを body に残す。受付機を訊く 1 枚の上だけ、
  // 右下の切り替えを前に出すために CSS から見分ける必要がある。
  document.body.dataset.modal = id;
  // 紙は visibility で出し入れしている。class を足した直後はまだ
  // visibility:hidden のままなので、ここで一度組み直させないと
  // 下の focus() が黙って効かない（visibility:hidden には焦点が乗らない）。
  void openEl.offsetWidth;
  $('main').setAttribute('aria-hidden','true');
  // 札のグリッドは「押した瞬間に確定」なので、開いた直後に乗せない。
  const first = [...openEl.querySelectorAll(FOCUSABLE)]
    .find(el => !el.closest('.pad-keys') && !el.disabled);
  (first || openEl.querySelector(FOCUSABLE))?.focus();
}
function closeModal(){
  if(!openEl) return;
  if(onClose){ const f = onClose; onClose = null; f(); }
  openEl.classList.remove('open'); openEl = null;
  delete document.body.dataset.modal;
  $('main').removeAttribute('aria-hidden');
  if(lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
document.addEventListener('keydown', e=>{
  if(!openEl) return;
  if(e.key==='Escape'){ closeModal(); return; }
  if(e.key!=='Tab') return;
  const items=[...openEl.querySelectorAll(FOCUSABLE)].filter(n=>n.offsetParent!==null);
  if(!items.length) return;
  const first=items[0], last=items[items.length-1];
  if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
});

/* ---------- WASM ---------- */
window.wasmReady = false;
window.onGoWasmReady = function(){
  // この関数は Go の main ゴルーチン上で同期実行される。
  // 例外を漏らすと Go が panic して終了し、以後 集計も CSV も使えなくなるため、
  // 中で必ず受け止めて外に投げない。
  window.wasmReady = true;
  try{
    const res = window.goLabels?.();
    if(res?.ok){
      if(Array.isArray(res.flavors) && res.flavors.length) FLAVORS = res.flavors;
      if(res.limits?.maxQuantity) MAX_QTY = res.limits.maxQuantity;
      if(res.defaultPrices) prices = { ...res.defaultPrices, ...prices };
      if(res.defaultLimits) limits = {
        maxPerOrder: limits.maxPerOrder || res.defaultLimits.maxPerOrder,
        stock: { ...res.defaultLimits.stock, ...limits.stock },
        tagCount: limits.tagCount || res.defaultLimits.tagCount
      };
      renderMenu();
    }
  }catch(e){ console.error('goLabels:', e); }
  try{ renderFigures(); }catch(e){ console.error('renderFigures:', e); }
  /* 記録表の状態変更ボタンは goNextStatuses を見て組む。注文のスナップショットは
     WASM (4.6MB) より先に着くので、ここで描き直さないと「用意した・渡した・中止」が
     1 つも無い表のまま、次に注文が動くまで直らない（中止＝返金の唯一の導線）。 */
  try{ renderRows(); }catch(e){ console.error('renderRows:', e); }
};
const go = new Go();
async function loadWasm(){
  try{
    // no-cache は「使う前に必ずサーバーへ確認する」。変わっていなければ 304 で
    // 済むので費用は小さく、会期中に更新しても古い wasm が残り続けない。
    const res = await fetch("main.wasm", { cache: 'no-cache' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    let mod;
    try{
      mod = await WebAssembly.instantiateStreaming(res.clone(), go.importObject);
    }catch(_){
      // Content-Type が application/wasm でない配信環境向けのフォールバック
      mod = await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject);
    }
    go.run(mod.instance);
  }catch(e){
    console.error(e);
    // 一度の失敗で諦めない。会場の回線は復活することがある。
    if(wasmTries < 3){
      wasmTries++;
      toast(`集計モジュールを読み込めません。${wasmTries}回目の再試行をします…`, 'info');
      setTimeout(loadWasm, 2000 * wasmTries);
      return;
    }
    toast("集計モジュールを読み込めません。売上とCSVは使えませんが、受付と受渡は続けられます。");
    renderFigures();
  }
}
let wasmTries = 0;
loadWasm();

/* ---------- 受付：商品カード ---------- */
/* 営業回で絞り込み、全画面を描き直す。新規着信の判定もここで行う。 */
function applySession(){
  orders = allOrders.filter(o => inSession(o, session));

  const ids = new Set(orders.filter(o => o.status === 'pending').map(o => o.id));
  // 鳴らすのは厨房の画面を開いている端末だけ。受渡の着信音・呼び出しのチャイムと
  // 同じ理由で、全端末で鳴らすと重なって何も聞き取れなくなる。
  // ここだけ条件が漏れていたため、受付で注文を確定した端末自身が厨房の呼び鈴を
  // 鳴らしていた。確定音（和音）に金属的な二打が重なるので、成功したのに
  // 「エラー音が混じる」と聞こえる。
  if(!firstSnap && document.body.dataset.tab === 'kitchen'){
    for(const id of ids) if(!knownIds.has(id)){ ping(); break; }
  }
  knownIds = ids;
  firstSnap = false;

  announce();
  arrived();
  // 混み具合は注文が動くたびに出し直す。受付の覆いと受け取り時刻がここで決まる。
  tickFlow();
  // 仕事が入ったら幕を上げる。暗いまま見逃すのがいちばん重い。
  if(workCount() > 0) wakeSaver();
  renderKitchen(); renderReady(); renderPay(); renderRows();
  renderFigures(); renderCall(); renderTags(); syncCart();
}

/* 商品は左右に 2 枚並べ、1 枚を味の色で塗り潰す。
   上に縦書きの味の名前と絵、下に値段と増減。色と縦書きで、
   文字を読む前にどちらかが分かる。

   地は木の色。柚子色（パステル）に白文字は 1.45:1 で読めず、色相を保ったまま
   白が乗る濃さまで落とすと、もう柚子色ではなくなる。木の色なら白文字が乗る。
   2 枚は木（胡桃）とチョコで、明度の差 2.01 倍で見分けが付く。

   説明文は出さない。読まれないまま高さだけを食っていた。 */
/* 商品名を 2 行に割る。「ゆず」を大きく、「カステラ」を下に小さく。
   2 列にしたらカードが細くなり、「チョコカステラ」が途中で折り返していた。
   機械の折り返しに任せると、どこで切れるかが幅ごとに変わる。
   意味の切れ目（味／種類）で人が割っておけば、どの幅でも同じ形に収まる。

   味の名前は short を正とする（厨房が使っているものと同じ）。
   label が short で始まらない商品が来たら、割らずにそのまま出す。 */
function flavorName(f, sharedKind){
  const head = f.short || '';
  const rest = head && f.label.startsWith(head) ? f.label.slice(head.length) : '';
  if(!rest) return f.label;
  // 種類を真ん中に 1 つ出すときは、カードからは外す（同じ語を 3 回出さない）。
  if(sharedKind) return `<span class="item-flavor">${head}</span>`;
  return `<span class="item-flavor">${head}</span><span class="item-kind">${rest}</span>`;
}

/* 全商品が同じ語尾なら、その語尾を返す（「ゆずカステラ」「チョコカステラ」→「カステラ」）。
   同じ語を 2 回出す代わりに、2 枚の間に 1 つだけ置けるようにする。

   使えるのは 2 品で語尾が揃っているときだけ。商品が増えたり、語尾の違う品が
   入ったら空を返し、カードごとの表記に自動で戻る。商品マスタは Go 側が持っていて
   ここからは変えられないので、形のほうが合わせる。 */
/* ---------- アレルギー ----------
   食べ物を出す以上、出さないという選択肢が無い。受付係に口頭で訊かせると、
   並んでいるあいだ訊けないし、答えが人によってぶれる。お客様が自分で開いて
   確かめられる位置に置く。

   中身は商品ごとに持つ。いまは 2 品とも同じ生地なので同じだが、
   品が増えて中身が変わったときに、ここだけ直せば済む形にしておく。
   絵は線で描く（意匠に合わせる。アイコン集は持ち込まない）。 */
const ALLERGEN_MARK = {
  wheat: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M24 44V20"/>
            <path d="M24 20c0-5-4-8.5-8-9.5.5 5.5 3 9 8 9.5zM24 20c0-5 4-8.5 8-9.5-.5 5.5-3 9-8 9.5z"/>
            <path d="M24 29c0-5-4-8.5-8-9.5.5 5.5 3 9 8 9.5zM24 29c0-5 4-8.5 8-9.5-.5 5.5-3 9-8 9.5z"/>
            <path d="M24 38c0-5-4-8.5-8-9.5.5 5.5 3 9 8 9.5zM24 38c0-5 4-8.5 8-9.5-.5 5.5-3 9-8 9.5z"/>
          </svg>`,
  egg: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M24 6c7.5 0 13 11.5 13 20a13 13 0 0 1-26 0C11 17.5 16.5 6 24 6z"/>
          <path d="M18 29a6 6 0 0 0 6 6"/>
        </svg>`,
  milk: `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M19 5h10v8l4.5 7V40a3 3 0 0 1-3 3h-13a3 3 0 0 1-3-3V20l4.5-7z"/>
           <path d="M14.5 27h19"/>
           <path d="M19 13h10"/>
         </svg>`
};
const ALLERGEN_NAME = { wheat:'小麦粉', egg:'卵', milk:'牛乳' };
// 商品ごとの中身。載っていない商品は既定を使う。
const ALLERGENS = { _default: ['wheat', 'egg', 'milk'] };
const allergensOf = key => ALLERGENS[key] || ALLERGENS._default;

function openAllergy(key){
  const f = FLAVORS.find(x => x.key === key);
  $('allergy-sub').textContent = f ? f.label : '';
  $('allergy-list').innerHTML = allergensOf(key).map(a => `
    <div class="allergy-item">
      ${ALLERGEN_MARK[a] || ''}
      <span class="allergy-name">${ALLERGEN_NAME[a] || a}</span>
    </div>`).join('');
  openModal('m-allergy');
}
$('allergy-close')?.addEventListener('click', closeModal);

/* 真ん中に挟む語は欧文にする。縦書きの和文 2 つに和文を挟むと 3 つ目の主役に
   なってしまうが、欧文なら字面が変わるぶん添え物として収まる。
   知らない語は訳さずそのまま出す（商品マスタは Go 側が持っていて増えうる）。 */
const KIND_EN = { 'カステラ': 'CASTELLA' };

function commonKind(){
  if(FLAVORS.length !== 2) return '';
  const rest = FLAVORS.map(f =>
    (f.short && f.label.startsWith(f.short)) ? f.label.slice(f.short.length) : '');
  return (rest[0] && rest[0] === rest[1]) ? rest[0] : '';
}

function renderMenu(){
  const kind = commonKind();
  const cards = FLAVORS.map(f=>`
    <article class="item" data-key="${f.key}">
      <div class="item-top">
        <h3 class="item-name" data-len="${(f.short || f.label).length}">${flavorName(f, kind)}</h3>
        <div class="item-photo"><img src="${MARK[f.key]||''}" alt="${f.label}"></div>
      </div>
      <div class="item-foot">
        <div class="item-meta">
          <p class="item-price" data-price="${f.key}">${yen(prices[f.key]??f.defaultPrice)}<small>円</small>
            <span class="item-per">1${f.unit}${f.pieces?`（${f.pieces}個入り）`:''}</span></p>
          <!-- 丸の中は「i」。麦の穂は小麦だけを指してしまい、卵と牛乳が
               入っていることが読み取れない。「！」は警告に見えて、ただの
               原材料の案内には強すぎる。ここにあるのは情報なので「i」。 -->
          <button type="button" class="item-allergy" data-act="allergy" data-key="${f.key}"
                  aria-label="${f.label}のアレルギー情報を見る">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                 stroke-linecap="round" aria-hidden="true">
              <path d="M12 6.4v.1"/>
              <path d="M12 11v7"/>
            </svg>
          </button>
        </div>
        <p class="item-stock" data-stock="${f.key}"></p>
        <div class="stepper">
          <button type="button" class="step" data-step="-1" data-key="${f.key}" aria-label="${f.label}を1${f.unit}減らす">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
          <span class="qty" data-qty="${f.key}" data-zero="true" role="status"><span class="sr-only">${f.label} </span>0<small>${f.unit}</small></span>
          <button type="button" class="step" data-step="1" data-key="${f.key}" aria-label="${f.label}を1${f.unit}増やす">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
    </article>`);
  const menu = $('menu');
  menu.dataset.shared = String(!!kind);
  // 真ん中に挟む。読み上げでは商品名が二重になるので、ここは飾りとして伏せる
  // （増減のボタンは aria-label に正式名称を持っている）。
  menu.innerHTML = kind
    ? cards[0] + `<p class="menu-kind" aria-hidden="true">${KIND_EN[kind] || kind}</p>` + cards[1]
    : cards.join('');
  syncCart();
}

function syncCart(){
  // 別の端末が売り切ったときのために、まずカートを残り在庫まで詰め直す。
  // 黙って減らすと、お客様が言った数と確定する数が食い違う。必ず知らせる。
  FLAVORS.forEach(f=>{
    const left = remainingOf(f.key);
    const had = cart[f.key] || 0;
    if(had > left){
      cart[f.key] = left;
      toast(left <= 0
        ? `${f.label}が売り切れました。ご注文から外しました。`
        : `${f.label}の残りが ${left}${f.unit} になりました。数量を直しました。`);
    }
  });

  let total = 0, count = 0;
  FLAVORS.forEach(f=>{ count += cart[f.key] || 0; });

  FLAVORS.forEach(f=>{
    const n = cart[f.key] || 0;
    const left = remainingOf(f.key);
    const soldOut = left <= 0;
    total += n * (prices[f.key] ?? f.defaultPrice);

    const q = document.querySelector(`[data-qty="${f.key}"]`);
    if(q){ q.innerHTML = `<span class="sr-only">${f.label} </span>${n}<small>${f.unit}</small>`;
           q.dataset.zero = String(n===0); }
    const p = document.querySelector(`[data-price="${f.key}"]`);
    if(p) p.innerHTML = `${yen(prices[f.key] ?? f.defaultPrice)}<small>円</small>`
      + `<span class="item-per">1${f.unit}${f.pieces?`（${f.pieces}個入り）`:''}</span>`;
    // 残りの数は出さない。お客様には要らない情報で、
    // 「あと3つしかない」と急かす効果まで付いてくる。
    // 売り切れだけは出す。出さないと「＋を押しても増えない」になる。
    const st = document.querySelector(`[data-stock="${f.key}"]`);
    if(st){
      st.textContent = soldOut ? '売り切れ' : '';
      st.dataset.state = soldOut ? 'out' : 'ok';
    }
    const card = document.getElementById('card-'+f.key) || document.querySelector(`.item[data-key="${f.key}"]`);
    if(card) card.dataset.soldout = String(soldOut);

    const minus = document.querySelector(`.step[data-step="-1"][data-key="${f.key}"]`);
    const plus  = document.querySelector(`.step[data-step="1"][data-key="${f.key}"]`);
    if(minus) minus.disabled = n <= 0;
    if(plus)  plus.disabled  = soldOut || n >= left || count >= limits.maxPerOrder;
  });

  // 合計は走らせる。桁が動く途中も読める値であってほしいので値そのものを補間する。
  countUp($('total'), lastTotal, total, v => `${yen(v)}<small>円</small>`);
  lastTotal = total;
  renderTally();
  $('submit-btn').disabled = count === 0;
  return { total, count };
}

/* 数え札。1つ＝1カップ。商品ごとに区画を分けておくと、片方だけ増減しても
   もう片方の並びが動かず、増えた分だけを animate できる。 */
let lastTotal = 0;
function renderTally(){
  const host = $('tally');
  if(!host) return;
  for(const f of FLAVORS){
    let g = host.querySelector(`.tally-group[data-key="${f.key}"]`);
    if(!g){
      g = document.createElement('span');
      g.className = 'tally-group'; g.dataset.key = f.key;
      host.appendChild(g);
    }
    const want = cart[f.key] || 0;
    const live = [...g.children].filter(el => el.dataset.out !== 'true');
    if(want > live.length){
      for(let i = live.length; i < want; i++){
        // 手で並べたように見せるため 1 つずつ角度を変える。
        // 全部同じ向きだと判で押したようになり、水彩の良さが死ぬ。
        const tilt = (i * 37) % 11 - 5;
        const img = document.createElement('img');
        img.className = 'tally-mark';
        img.src = MARK[f.key] || ''; img.alt = ''; img.setAttribute('aria-hidden','true');
        img.style.setProperty('--tilt', tilt + 'deg');
        img.style.setProperty('--tilt-from', (tilt - 5) + 'deg');
        img.dataset.in = 'true';
        img.style.animationDelay = ((i - live.length) * 60) + 'ms';
        g.appendChild(img);
      }
    }else if(want < live.length){
      for(let i = live.length - 1; i >= want; i--){
        const el = live[i];
        el.dataset.in = 'false'; el.dataset.out = 'true';
        setTimeout(() => el.remove(), reduced() ? 0 : 340);
      }
    }
  }
}

document.addEventListener('click', e=>{
  const s = e.target.closest('.step');
  if(!s) return;
  const k = s.dataset.key, d = Number(s.dataset.step);
  const before = cart[k] || 0;
  const next = Math.max(0, Math.min(headroomOf(k), before + d));
  if(next === before){
    // 効かないときに無反応だと「壊れている」と受け取られる。音と揺れで返す。
    if(soundOn()) audio.limit();
    nudge(document.querySelector(`[data-qty="${k}"]`));
    const left = remainingOf(k);
    toast(left <= 0
      ? `${label(k)}は売り切れです。`
      : `1回のご注文は合計 ${limits.maxPerOrder} カップまでです。`);
    return;
  }
  cart[k] = next;
  // 最初の「＋」までが迷っている時間。残り時間の見積もりに効くので記録する。
  if(d > 0) noteFirstTap(); else lastTouchAt = Date.now();
  if(soundOn()) audio.step(d > 0, next || 1);
  syncCart();
});

/* ---------- 番号札モード ---------- */
function paintTagMode(){
  document.body.dataset.tags = String(useTags);
  const sub = $('confirm-sub');
  if(sub) sub.textContent = useTags
    ? 'よろしければ、お渡しする番号札の番号を入力してください。'
    : 'よろしければ「注文を確定する」を押してください。';
  if(useTags && openEl?.id === 'm-confirm') padReset();
  const now = $('confirm-now');
  if(now) now.textContent = '注文を確定する';
  // 切り替えは管理画面にある。受付の画面はお客様に向くので、押せるものは置かない。
  const t = $('tagmode-toggle');
  if(t){
    t.setAttribute('aria-pressed', String(useTags));
    t.textContent = useTags ? '番号札を使っています' : '番号札なしで渡しています';
  }
  const hint = $('tagmode-hint');
  if(hint){
    hint.textContent = useTags
      ? '押すと、番号札なしの運用に切り替わります。'
      : '押すと、番号札を使う運用に戻ります。いまは厨房を通さず、受渡口でお品物と代金をお渡ししています。';
    hint.dataset.warn = String(!useTags);
  }
  // 受付の画面はお客様に向く。番号札を使っているかどうかは店の内部事情なので、
  // 平常時は何も出さない。札なしのときだけ、受付係に向けて出す
  // （その場で代金をいただく運用に変わるため、知らないと取り損ねる）。
  const note = $('lane-note');
  if(note){
    note.textContent = useTags
      ? ''
      : '番号札は使いません。その場でお渡しし、受付で代金をいただきます。';
    note.dataset.warn = 'false';
  }
  syncCart();
}

async function setTagMode(on){
  useTags = on; paintTagMode();
  try{
    await authReady;
    await set(ref(db,'config/useTags'), on);
  }catch(e){ toast('番号札の設定を共有できませんでした。この端末だけ切り替わっています。'); }
}

$('tagmode-toggle')?.addEventListener('click', ()=>setTagMode(!useTags));

/* ---------- 受付機 ----------
   受付は複数台置く。どの端末がどの受付機かを端末自身に名乗らせ、
   同じ番号で 2 台立つのを止める。2 台立つと、受付係も受渡口も
   「どちらの端末が受けた注文か」を追えなくなる。

   名乗りは desks/<番号> に置き、onDisconnect で片づける。画面を閉じる・
   電池が切れる・回線が落ちる、のいずれでも席は空きに戻るので「使用中のまま
   誰も使えない」が残りにくい。それでも残ったときは管理画面から空ける。 */
const DESKS = [
  { id:'1', label:'受付機1', note:'' },
  { id:'2', label:'受付機2', note:'' },
  { id:'3', label:'受付機3', note:'' },
  { id:'4', label:'受付機4', note:'予備' }
];
/* 席が「自分のもの」かを見分ける印。リロードを挟んでも同じ印でいる必要がある。
   毎回変えると、onDisconnect が片づける前にリロードした自分自身を
   「他の端末が使用中」と読んで、自分で自分を締め出す。 */
const clientId = (()=>{
  const mk = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  try{
    let v = localStorage.getItem('deskClient');
    if(!v){ v = mk(); localStorage.setItem('deskClient', v); }
    return v;
  }catch(e){ return mk(); }
})();

let myDesk = null;          // いま名乗っている受付機の番号
let desksOnline = {};       // DB にある名乗り（番号 → {client, at}）
/* 受付機の決めごと（待機かどうか）。在席ノード desks/ は回線が切れると
   onDisconnect で消えるため、そこに置いた待機は数十秒で勝手に解けていた
   （RTDB は裏で繋ぎ直すので、切れること自体は毎回起きる）。
   消えてはいけない決めごとは config 側に置く。 */
let deskPolicy = {};        // 番号 → {mode, hold, auto}
let desksKnown = false;     // 名乗りが一度でも届いたか
let deskClaiming = false;   // 掴みに行っている最中
let deskBooted = false;     // 起動時の取り直しを一度だけ試す
let deskClaimedAt = 0;      // 最後に掴んだ時刻。直後の誤判定を避けるために見る

const deskLabel = id => (DESKS.find(d=>d.id===id)||{}).label || '';
// 自分以外の端末が起動している席。
const deskTaken = id => {
  const d = desksOnline[id];
  return !!d && !!d.client && d.client !== clientId;
};
// 名乗りが古い席。onDisconnect が届かなかった可能性がある（電池切れなど）。
const DESK_STALE_MS = 3 * 60 * 1000;
const deskStale = id => {
  const d = desksOnline[id];
  return !!d && (Date.now() - (d.at || 0)) > DESK_STALE_MS;
};

/* 受付機の様子。mode は 'open'（注文受付中）か 'standby'（待機）。
   待機は管理画面から遠隔で切り替える。help は「店員を呼ぶ」が押された時刻。

   hold は「人が決めた」印。自動の増減（autoScale）と「店員を呼ぶ」は、
   この印が付いた席に触らない。人が待機にしたのに数秒で開き直すのは、
   操作が効いていないのと同じで、押した人には故障にしか見えない。 */
const deskMode = id => (deskPolicy[id]?.mode === 'standby') ? 'standby' : 'open';
const deskHold = id => deskPolicy[id]?.hold === true;
const deskAuto = id => deskPolicy[id]?.auto === true;
/* 強制解除された端末の印。本部が「強制解除」を押すと、そのとき席を持っていた
   端末の印がここに入る。

   名乗りを消すだけでは席は空かない。消えた名乗りは「回線が切れただけ」と
   区別が付かないので、持っていた端末が黙って取り直すように作ってある
   （受付の途中で選び直させないため）。本部から見ると、押しても何も起きない。
   だから「この端末はもう使わない」を、消えない場所に残す。 */
const deskKick = id => deskPolicy[id]?.kick || '';
const kicked   = id => deskKick(id) === clientId;
const deskHelp = id => Number(desksOnline[id]?.help || 0);
// 呼び出しが出ている受付機。古い順に並べる（待たせている順に片づける）。
const helpingDesks = () => DESKS.filter(d=>deskHelp(d.id) > 0)
                                .sort((a,b)=>deskHelp(a.id) - deskHelp(b.id));

function paintDesks(){
  // 受付の画面に出す札。お客様に向く画面なので主張させない。
  const chip = $('desk-chip');
  if(chip){
    chip.textContent = myDesk ? deskLabel(myDesk) : '受付機を選ぶ';
    chip.dataset.set = String(!!myDesk);
    chip.setAttribute('aria-label', myDesk
      ? `この端末は${deskLabel(myDesk)}です。押すと選び直せます`
      : 'この端末がどの受付機かを選ぶ');
  }
  // 選ぶ画面。起動中の受付機は押せない。
  const pick = $('desk-pick');
  if(pick){
    pick.innerHTML = DESKS.map(d=>{
      const taken = deskTaken(d.id);
      const mine  = myDesk === d.id;
      const sub = taken ? (deskStale(d.id) ? '起動中（応答なし）' : '起動中')
                        : mine ? 'この端末' : (d.note || '空いています');
      return `<button type="button" data-desk="${d.id}" ${taken ? 'disabled' : ''}
        aria-label="${d.label}${d.note ? `（${d.note}）` : ''}${taken ? '。起動中のため選べません' : ''}">
        ${d.label}<small>${sub}</small></button>`;
    }).join('');
  }
  // 選び直しをやめる道。名乗る前は出さない（選ばないと受付が使えない）。
  const cancel = $('desk-cancel');
  if(cancel) cancel.hidden = !myDesk;
  paintStandby();
  paintGate();
  renderDeskAdmin();
  renderHelp();
  autoScale();
}

/* 待機の覆いと「店員を呼ぶ」。受付の画面にだけ出す。
   覆いが出ている間は注文を受けない（placeOrder でも塞いである）。 */
function paintStandby(){
  const standing = !!myDesk && deskMode(myDesk) === 'standby';
  const sb = $('standby');
  if(sb) sb.hidden = !standing;
  document.body.dataset.standby = String(standing);

  // 呼び出し中は押し直させない。押しても時刻は更新しない。
  const called = !!myDesk && deskHelp(myDesk) > 0;
  const hc = $('helpcall');
  if(hc){
    hc.dataset.called = String(called);
    hc.setAttribute('aria-label', called
      ? '店員をお呼びしています。少々お待ちください'
      : '店員を呼ぶ');
  }
  const hw = $('helpwait');
  if(hw) hw.hidden = !called;
}

/* 管理画面の在席表。どの受付機が起動しているかと、残ってしまった席を空ける道。 */
function renderDeskAdmin(){
  const grid = $('desk-admin');
  if(!grid) return;
  grid.innerHTML = DESKS.map(d=>{
    const on   = desksOnline[d.id];
    const mine = !!on && on.client === clientId;
    const standby = deskMode(d.id) === 'standby';
    const serving = deskBusy(d.id);
    const auto = deskAuto(d.id);
    const kick = !!deskKick(d.id);
    const state = standby ? (on ? '待機中（お客様には他の窓口を案内）' : '待機中（空いています）')
      : !on ? (kick ? '解除済み（元の端末は戻りません）' : '空いています')
      : serving ? `接客中（${helpAgo(on.busy)}）`
      : mine ? '注文受付中・空き（この端末）'
      : deskStale(d.id) ? '注文受付中（応答なし）' : '注文受付中・空き';
    return `<div class="desk-cell" data-busy="${!!on}" data-mine="${mine}"
                 data-standby="${standby}" data-serving="${serving}">
      <span class="desk-name">${d.label}${d.note ? `（${d.note}）` : ''}${auto ? '<small class="desk-auto">自動</small>' : ''}</span>
      <span class="desk-state">${state}</span>
      <button type="button" class="desk-mode" data-act="deskmode" data-id="${d.id}"
              data-to="${standby ? 'open' : 'standby'}"
              aria-pressed="${standby}"
              aria-label="${d.label} を${standby ? '注文受付中に戻す' : '待機にする'}">
        ${standby ? '注文受付中に戻す' : '待機にする'}</button>
      <button type="button" class="desk-free" data-act="deskfree" data-id="${d.id}"
              ${on ? '' : 'disabled'}
              aria-label="${d.label} を強制解除して空きに戻す">強制解除</button>
    </div>`;
  }).join('');
  const at = $('auto-toggle');
  if(at){
    at.setAttribute('aria-pressed', String(autoScaling));
    at.textContent = autoScaling ? '自動で台数を決めています' : '台数は手動で決めています';
  }
  const ph = $('pace-hint');
  if(ph) ph.textContent = pace.n
    ? `実測 ${pace.n}件：1件あたり ${Math.round(pace.ms/1000)}秒（うち選び始めるまで ${Math.round(pace.think/1000)}秒）`
    : 'まだ実測がありません。1件あたり 45秒とみなして判断します。';
  const sm = $('saver-min');
  if(sm && document.activeElement !== sm) sm.value = String(saverMin);

  const busy = DESKS.filter(d=>desksOnline[d.id]).length;
  const open = DESKS.filter(d=>desksOnline[d.id] && deskMode(d.id) === 'open').length;
  const c = $('desk-count');
  if(c) c.textContent =
    `注文受付中 ${open}台 ／ 待機 ${busy - open}台 ／ 空き ${DESKS.length - busy}台（全${DESKS.length}台）`;
}

/* ============================================================
   混み具合・受け取り時刻のご案内（予約）・受付の歯止め

   ベビーカステラは作り置きができない。生地は途中で交換が要るし、焼いたものは
   置けない。プレートは 3 枚（大 1・小 2）しかなく、補充と取り出しの間は止まる。
   だから混むと「列が長くなる」ではなく「渡せる時刻が遠くなる」形で詰まる。

   立って待たせ続けるかわりに、札を持って出直してもらう。
     ・最長待ちが 8 分以上になったら、受け取り時刻のご案内を始める（自動）
     ・見積もりが 30 分を超えたら、受付そのものを止める
   どちらも戻すしきい値を別に置いてある（境目で案内が点滅しないため）。

   判断の計算は lib/pure.js にあり、Node からテストできる。ここは配線だけ。
   ============================================================ */
let rulesNote     = '';             // ルールが古いときの説明。空なら公開済み
let closeAt       = '';             // config/closeAt: 'HH:MM'。過ぎたら受付を止める
let reserveMode   = 'auto';          // config/reserve: 'auto' | 'on' | 'off'
let kitchen       = { ...KITCHEN_DEFAULT };   // config/kitchen: 何人で、1人いくつ焼くか
let cupRate       = rateFromKitchen(kitchen); // そこから出る毎分カップ数
let reserveNow    = false;           // いま受け取り時刻をご案内しているか
let intakeStopped = false;           // いま受付を止めているか
let closed = false;                 // 終了時刻を過ぎたか
let flow = { backlog:0, cups:0, rate:1, waitMin:0, pickupMs:0 };

/* 終了時刻の判定。'HH:MM' は JST で見る。端末のタイムゾーンで見ると、
   日本以外の設定になっている端末だけが「開店した瞬間に閉店」または
   「いつまでも閉まらない」になる。日付をまたぐ運用はしない。 */
function isClosed(now = Date.now()){
  const m = /^(\d{1,2}):(\d{2})$/.exec(closeAt || '');
  if(!m) return false;
  const jst = new Date(now + 9 * 3600 * 1000);
  const mins = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return mins >= Number(m[1]) * 60 + Number(m[2]);
}

function tickFlow(){
  const now = Date.now();
  // 新しい注文を足さない見積もり＝「いま焼き待ちを捌き切るまで」。
  // 受付を止めるかどうかはこれで決める。
  flow = forecast(orders, { now, rate: cupRate });

  // 8 分で始めて 5 分まで続ける、の「いま続いているか」は端末の記憶で持たない。
  // 受付機は複数あり、後から開いた端末は記憶を持たないので、同じ列を見ながら
  // 隣の端末と違う案内を出してしまう。直前の注文に受け取り時刻が入っているかは
  // 全端末で同じに見えるので、それを「続いているか」の印として使う。
  const last = orders.filter(o => o.status !== 'cancelled').sort(byOrder).pop();
  reserveNow    = reserveOn(reserveMode, orders, now, !!last?.pickupMs);
  // 終了時刻を過ぎたら、混み具合に関わらず受付を閉じる。
  // 人が閉め忘れても、約束できない注文を受け続けることにはならない。
  closed = isClosed(now);
  intakeStopped = closed || stopIntake(flow.waitMin, intakeStopped);
  paintFlow();
}
// 時間が経つだけでも混み具合は変わる（誰も触らなくても最長待ちは伸びる）。
setInterval(tickFlow, 10000);

/* 混み具合を各画面に出す。数字は 1 本（flow）から配る。 */
function paintFlow(){
  document.body.dataset.reserve = String(reserveNow);
  document.body.dataset.full    = String(intakeStopped);

  // 受付：止めている間は門を出さず、覆いを出す（接客中の人は最後まで通す）。
  paintGate();
  const full = $('full');
  if(full){
    const standing = !!myDesk && deskMode(myDesk) === 'standby';
    full.hidden = !(intakeStopped && !!myDesk && !standing && gateState !== 'open');
    full.dataset.why = closed ? 'closed' : 'busy';
    const main = full.querySelector('.standby-main');
    const sub  = full.querySelector('.standby-sub');
    if(main) main.innerHTML = closed
      ? '本日の販売は<br>終了しました'
      : 'ただいま<br>受付を止めています';
    if(sub) sub.textContent = closed
      ? 'ご来店ありがとうございました'
      : 'お作りしている分で手一杯です。少々お待ちください';
  }

  // 厨房・受渡：いまの見積もりを上のバーに出す。
  const txt = flow.waitMin > 0 ? `${flow.waitMin}分` : 'すぐ';
  for(const id of ['kds-wait','ready-wait']){
    const el = $(id);
    if(el) el.textContent = txt;
  }
  for(const id of ['kds-reserve','ready-reserve']){
    const el = $(id);
    if(el) el.hidden = !reserveNow;
  }
  paintReserveAdmin();
}

/* 管理画面の「受け取り時刻のご案内」。 */
function paintReserveAdmin(){
  const now = Date.now();
  document.querySelectorAll('#reserve-mode [data-reserve]').forEach(b=>{
    b.setAttribute('aria-pressed', String(b.dataset.reserve === reserveMode));
  });
  const st = $('reserve-state');
  if(st){
    st.textContent = (reserveNow
      ? `いま：受け取り時刻をご案内しています（最長待ち ${oldestWaitMin(orders, now)}分）`
      : `いま：その場でお渡ししています（最長待ち ${oldestWaitMin(orders, now)}分）`)
      + (intakeStopped ? ' ／ 受付を止めています' : '');
    st.dataset.on = String(reserveNow);
  }
  const hint = $('rate-hint');
  if(hint){
    const m = measuredRate(orders, now);
    // 実測と設定が離れていたら言う。直すのは人（生地交換で一瞬落ちた数字を
    // 拾って自動で変えると、お客様への約束時刻が勝手に伸び縮みする）。
    const off = m !== null && cupRate > 0 && Math.abs(m - cupRate) / cupRate > 0.3;
    hint.dataset.warn = String(off);
    hint.textContent = `焼き待ち ${backlogCups(orders)}カップ・いまの見積もり ${flow.waitMin}分`
      + (m === null ? '／実測はまだありません' : `／実測 ${m.toFixed(1)}カップ/分（直近10分）`)
      + (off ? `　← 設定（${cupRate.toFixed(1)}）とずれています。人数を確かめてください`
             : '');
  }
  // 生地が尽きるまで。本部が締めの段取りを決めるための数字。
  const outLine = $('stock-out');
  if(outLine){
    outLine.innerHTML = FLAVORS.map(f=>{
      const stock = remainingOf(f.key);
      const out   = stockOutMin(stock, soldRate(orders, f.key, now));
      return `<span data-soon="${out !== null && out <= 15}"><b>${f.short || f.label}</b> 残り ${stock}カップ`
        + (stock > 0 ? `（生地 ${bowlsFor(stock, kitchen)}ボウル・${weightText(gramsFor(stock, kitchen))}）` : '')
        + (stock === 0 ? '（売り切れ）' : out !== null ? `・約${out}分で尽きます` : '')
        + '</span>';
    }).join('　／　');
  }
  const rules = $('rules-state');
  if(rules){
    rules.hidden = !rulesNote;
    rules.textContent = rulesNote;
  }
  const closeEl = $('close-at');
  if(closeEl && document.activeElement !== closeEl) closeEl.value = closeAt;
  const closeHint = $('close-hint');
  if(closeHint){
    closeHint.dataset.warn = String(closed);
    closeHint.textContent = !closeAt
      ? '空のままなら、時刻では閉めません（混み具合だけで止まります）。'
      : closed ? `${closeAt} を過ぎたので、受付を閉じています。`
               : `${closeAt} になったら、受付を自動で閉じます。`;
  }
  paintPlates();
  const calc = $('kit-calc');
  if(calc){
    const bake = cyclePieces(kitchen) / PIECES_PER_CUP / kitchen.cycleMin;
    const batter = batterRate(kitchen);
    // どちらが上限になっているかを出す。台を増やしても生地が追いつかなければ
    // 焼ける量は変わらない（そこが分からないと、増やす判断を間違える）。
    const bound = batter < bake ? '生地' : '焼き';
    calc.innerHTML =
      `使う台 ${usedPlates(kitchen).map(p=>`${p.label} ${p.holes}マス`).join(' ＋ ')}`
      + ` ＝ <b>${cyclePieces(kitchen)}個</b>（${(cyclePieces(kitchen)/PIECES_PER_CUP).toFixed(1)}カップ）`
      + `を ${kitchen.cycleMin}分ごと　焼く人 ${kitchenPeople(kitchen)}人<br>`
      + `焼く側 ${bake.toFixed(1)} ／ 生地側 ${batter.toFixed(1)} カップ/分`
      + `（${bound}が上限）`
      + `${kitchen.margin < 100 ? `・見込み ${kitchen.margin}%` : ''}`
      + ` → <b>毎分 ${cupRate.toFixed(1)}カップ</b>`;
  }
  for(const [id, v] of [['kit-cycle', kitchen.cycleMin], ['kit-margin', kitchen.margin],
                        ['kit-bowls', kitchen.bowls.count], ['kit-bowl-pieces', kitchen.bowls.pieces],
                        ['kit-bowl-grams', kitchen.bowls.grams], ['kit-wash', kitchen.bowls.washMin]]){
    const el = $(id);
    if(el && document.activeElement !== el) el.value = String(v);
  }
}

/* 台の設定。実物のマス数がそのまま並ぶ。使わない台は外しておく。 */
function paintPlates(){
  const host = $('kit-plates');
  if(!host) return;
  const act = document.activeElement;
  host.innerHTML = Object.keys(kitchen.plates).sort().map(key=>{
    const p = kitchen.plates[key];
    return `
    <div class="plate-row" data-use="${p.use}">
      <span class="plate-name">台${key}</span>
      <div class="field">
        <label for="plate-h-${key}">マス</label>
        <input type="number" id="plate-h-${key}" data-plate="${key}" data-k="holes"
               min="1" max="99" step="1" inputmode="numeric" value="${p.holes}">
      </div>
      <div class="field">
        <label for="plate-p-${key}">人</label>
        <input type="number" id="plate-p-${key}" data-plate="${key}" data-k="people"
               min="0" max="12" step="1" inputmode="numeric" value="${p.people}">
      </div>
      <label class="plate-use">
        <input type="checkbox" data-plate="${key}" data-k="use" ${p.use ? 'checked' : ''}>
        <span>${p.use ? '使う' : '予備'}</span>
      </label>
    </div>`;
  }).join('');
  // 打っている最中の欄に戻る（描き直しで指が外れると数字を打ち切れない）。
  if(act?.dataset?.plate){
    const back = host.querySelector(`[data-plate="${act.dataset.plate}"][data-k="${act.dataset.k}"]`);
    back?.focus();
  }
}

/* ---------- 省エネ ----------
   薄暗くするだけにする。真っ黒にすると何が起きているか読めなくなり、
   「壊れた」と思って誰かが触りに行く。消費電力の大半は液晶のバックライトで、
   ブラウザからは輝度を触れないので、できるのは黒を重ねて実効輝度を落とすことと、
   動き続けるものを止めること。

   入る条件は画面ごとに違う。
     受付      … この受付機が待機になったとき（お客様の前では暗くしない）
     受渡・支払い … 仕事が 1 件も無いまま saverMin 分たったとき
   受渡と支払い口は、仕事が入った瞬間に自動で戻す。暗いまま見逃すのが
   いちばん重いので、復帰は人の操作を待たない。 */
let saverMin = 3;           // 受渡・支払い口が暗くなるまでの分（0 = 暗くしない）
let saverOn = false;
let busySince = Date.now(); // 最後に仕事があった時刻

function workCount(){
  const tab = document.body.dataset.tab;
  if(tab === 'ready') return orders.filter(o=>o.status==='ready'||o.status==='pending').length;
  if(tab === 'pay')   return orders.filter(o=>o.status!=='cancelled' && !o.paid).length;
  return 0;
}

function setSaver(on){
  if(saverOn === on) return;
  saverOn = on;
  const el = $('saver');
  if(el) el.hidden = !on;
  document.body.dataset.saver = String(on);
}

function tickSaver(){
  const tab = document.body.dataset.tab;
  // 受付は「この受付機が待機のとき」だけ。お客様の前にある画面を勝手に暗くしない。
  if(tab === 'order'){
    setSaver(!!myDesk && deskMode(myDesk) === 'standby' && !openEl);
    return;
  }
  if(tab !== 'ready' && tab !== 'pay'){ setSaver(false); return; }
  if(saverMin <= 0){ setSaver(false); return; }
  if(workCount() > 0){ busySince = Date.now(); setSaver(false); return; }
  setSaver(Date.now() - busySince >= saverMin * 60000);
}
setInterval(tickSaver, 2000);

// どこを触っても明るさが戻る。戻したぶんの猶予を取り直す。
function wakeSaver(){
  busySince = Date.now();
  setSaver(false);
}
$('saver')?.addEventListener('click', wakeSaver);
['pointerdown','keydown'].forEach(ev => addEventListener(ev, ()=>{ if(saverOn) wakeSaver(); }, true));

/* ---------- 受付機の台数を自動で決める ----------
   開いている受付機が全部ふさがったら、待機している受付機を 1 台開ける。
   ただし「もうすぐ空きそう」なときは開けない。開けた直後に全部空くと、
   お客様から見て窓口が増えたり減ったりするだけで、何も速くならない。

   残り時間は実測から見積もる。
     ・まだ「＋」を押していない → 迷っている。残りは 1 件ぶん丸ごと
     ・押している              → 平均から経過を引いたぶん
   どれか 1 台でも SOON_MS 以内に空きそうなら、待って任せる。

   決めるのは「待機している中でいちばん若い番号の端末」だけ。
   全端末が同じ判断をすると、同時に何台も開いてしまう。自分のことだけを
   書く形にすると、取り合いが起きない（自分の席にしか書き込まない）。

   手動で開けた席は自動で閉じない（auto:true の席だけを戻す）。
   人が意図して開けたものを機械が畳むと、何が起きたか分からなくなる。 */
const SOON_MS      = 12000;    // これ以内に空きそうなら、増やさずに待つ
const AUTO_IDLE_MS = 60000;    // 自動で開けた席を、空いたまま何秒で畳むか
let autoScaling = true;        // 自動で増減するか（管理画面から切れる）
let idleSince = 0;             // この席が空いたままになった時刻

// 受付機の残り時間の見積もり。小さいほど早く空く。
function remainingAt(id){
  const d = desksOnline[id];
  if(!d || !d.busy) return 0;
  const elapsed = Date.now() - d.busy;
  // まだ選び始めていない人は、ここから 1 件ぶんかかると見る。
  if(!d.firstAt) return Math.max(pace.ms - elapsed, pace.ms * 0.6);
  return Math.max(0, pace.ms - elapsed);
}

const deskOnlineOpen = () => DESKS.filter(d => desksOnline[d.id] && deskMode(d.id) === 'open');
const deskBusy = id => !!desksOnline[id]?.busy;

function autoScale(){
  if(!autoScaling || !myDesk) return;
  const open = deskOnlineOpen();
  const busy = open.filter(d => deskBusy(d.id));
  const free = open.length - busy.length;

  // 人が決めた席は動かさない。待機にした直後に機械が開き直すと、
  // 押した人からは「待機にできない」としか見えない。
  if(deskHold(myDesk)) return;

  // --- 増やす：自分が待機していて、待機の中でいちばん若い番号のときだけ考える
  if(deskMode(myDesk) === 'standby'){
    const waiting = DESKS.filter(d => desksOnline[d.id] && deskMode(d.id) === 'standby'
                                      && !deskHold(d.id));
    if(waiting[0]?.id !== myDesk) return;        // 開けるのは 1 台だけ
    if(!open.length) return;                      // 1 台も開いていない＝人の判断に任せる
    if(free > 0) return;                          // まだ空きがある
    // もうすぐ空きそうなら増やさない。「もう終わるだろう」の予測がこれ。
    const soonest = Math.min(...busy.map(d => remainingAt(d.id)));
    if(soonest <= SOON_MS) return;
    setDeskMode(myDesk, 'open', 'auto');
    return;
  }

  // --- 戻す：自動で開いた席が、空いたまま十分に経ったら待機へ返す
  if(!deskAuto(myDesk)) return;                   // 人が開けた席は畳まない
  if(deskBusy(myDesk) || gateState === 'open'){ idleSince = 0; return; }
  // 自分以外にも空いている受付機があるときだけ畳む。最後の 1 台は閉じない。
  const othersFree = open.filter(d => d.id !== myDesk && !deskBusy(d.id)).length;
  if(othersFree === 0){ idleSince = 0; return; }
  if(!idleSince){ idleSince = Date.now(); return; }
  if(Date.now() - idleSince < AUTO_IDLE_MS) return;
  idleSince = 0;
  setDeskMode(myDesk, 'standby', 'auto');
}
// 判断は時間でも変わる（経過が延びれば「もうすぐ空く」が覆る）。
setInterval(autoScale, 3000);

/* ---------- 受付の門と、接客時間の計測 ----------
   注文が始まっていない間は門を閉じておく。門を押した瞬間が接客の始まりで、
   確定が終わり。この 2 点が取れると「1 件に何分かかるか」が実測で分かり、
   受付機を何台開けるべきかを当て推量ではなく数字で決められる。

   計測はこの端末の中で行い、結果（移動平均）だけを共有する。
   1 件ごとの記録を DB に積むと、お客様の滞在を残すことになるうえ、
   会期中ずっと増え続ける。平均と件数があれば判断には足りる。 */
const GATE_THANKS_MS = 4200;      // 緑を出しておく長さ
const DONE_HOLD_MS   = 6000;      // 番号札の画面を出しておく長さ
const GATE_IDLE_MS   = 90000;     // 触られないまま放置された接客を畳むまで
const PACE_DEFAULT   = { ms: 45000, think: 9000, n: 0 };
const PACE_ALPHA     = 0.3;       // 移動平均の重み。直近を厚く見る

let pace = { ...PACE_DEFAULT };
let gateState = 'welcome';        // 'welcome' | 'thanks' | 'open'（接客中）
let gateTimer = null;
let orderStartedAt = 0;           // 門を押した時刻
let firstTapAt = 0;               // 最初に「＋」が押された時刻
let lastTouchAt = 0;              // 接客中の最後の操作

/* 門を描く。待機中はそもそも門を出さない（赤い覆いが前に出る）。 */
function paintGate(){
  const g = $('gate');
  if(!g) return;
  const standing = !!myDesk && deskMode(myDesk) === 'standby';
  // 受付機を選んでいない間も門は出さない。選ぶ画面が先に立つ。
  // 受付を止めている間も出さない（代わりに満員の覆いが出る）。接客中の人は
  // 最後まで通すので、ここで見るのは「次のお客様を迎えるかどうか」だけ。
  const show = !!myDesk && !standing && !intakeStopped && gateState !== 'open';
  // 引いている最中は触らない。別の端末の操作で描き直されると、
  // 動きが 1 フレームで切り落とされて「消えた」になる。
  if(g.dataset.leaving === 'true') return;
  g.hidden = !show;
  g.dataset.state = gateState === 'thanks' ? 'thanks' : 'welcome';
  // 注文中かどうかで、呼ぶ丸の寸法を変える。門の上では商品に被らないので
  // 大きく出せるが、商品を選んでいる間はカードに被らせない。
  document.body.dataset.ordering = String(gateState === 'open');
  if(!show) return;
  // 緑は「この窓口は開いています」の一枚。前のお客様への礼ではなく、
  // 次のお客様への呼びかけにする（礼は番号札を出す画面で済んでいる）。
  const thanks = gateState === 'thanks';
  $('gate-top').textContent   = thanks ? '次の方どうぞ' : 'いらっしゃいませ';
  $('gate-sub').textContent   = '';
  $('gate-start').textContent = '注文を始める';
}

/* 門を開ける＝接客の始まり。ここから時間を計り、席を「接客中」にする。 */
const GATE_OUT_MS = 460;   // 門が引き切るまで。CSS の gate-out と合わせる

function openGate(){
  if(!myDesk) { ensureDesk(); return; }
  if(deskMode(myDesk) === 'standby') return;
  if(gateState === 'open') return;          // 連打で二重に始めない
  clearTimeout(gateTimer);
  gateState = 'open';
  orderStartedAt = Date.now();
  firstTapAt = 0;
  lastTouchAt = orderStartedAt;
  cart = {}; syncCart();
  markBusy(orderStartedAt, 0);

  const g = $('gate');
  // 門をぱっと消すと「画面が切り替わった」になる。引かせて、
  // その裏で受付の面を順に立ち上げると「開いた」になる。
  if(g && !g.hidden && !reduced()){
    g.dataset.leaving = 'true';
    document.body.dataset.entering = 'true';
    setTimeout(()=>{
      delete g.dataset.leaving;
      paintGate();
    }, GATE_OUT_MS);
    setTimeout(()=>{ delete document.body.dataset.entering; }, GATE_OUT_MS + 900);
  }else{
    paintGate();
  }
}

/* 門を閉じる。done なら緑を出してから「いらっしゃいませ」へ戻る。 */
function closeGate(done){
  clearTimeout(gateTimer);
  gateState = done ? 'thanks' : 'welcome';
  orderStartedAt = 0; firstTapAt = 0;
  cart = {}; syncCart();
  paintGate();
  markBusy(0, 0);
  if(done){
    thanksCued = false;
    // 番号札のモーダルが開かなかった場合の保険。これが無いと緑のまま止まる。
    clearTimeout(gateTimer);
    gateTimer = setTimeout(gateThanks, 4000);
  }
}

/* 緑が実際に見えるようになった時点で、次の方への音を鳴らして数え始める。

   確定の直後は番号札を出すモーダルが 3.5 秒かぶっている。そこで鳴らすと
   確定音と重なって潰し合い、緑もほとんど見えないまま切り替わる。
   モーダルが閉じてから鳴らす。

   保険の時計と、モーダルを閉じる時計の両方から呼ばれるので、
   1 回の接客で一度しか鳴らないよう印で止める。 */
let thanksCued = false;
function gateThanks(){
  clearTimeout(gateTimer);
  if(gateState !== 'thanks' || thanksCued) return;
  thanksCued = true;
  if(soundOn()) audio.next();
  gateTimer = setTimeout(()=>{ gateState = 'welcome'; paintGate(); }, GATE_THANKS_MS);
}

/* 席の「接客中」を共有する。台数の自動判断はこの値だけを見る。
   何を買ったかは書かない（判断に要らないし、お客様の買い物が他の端末に出る）。 */
function markBusy(startedMs, firstMs){
  if(!myDesk) return;
  // 席が消えている間に書くと、client/at の無い幽霊席を作りにいって拒否される。
  if(!desksOnline[myDesk]) return;
  update(ref(db,'desks/'+myDesk), {
    busy: startedMs > 0 ? startedMs : null,
    firstAt: firstMs > 0 ? firstMs : null
  }).catch(()=>{});
}

/* 最初の「＋」。ここまでが「迷っている時間」。
   迷いが長い人は全体も長くなるので、残り時間の見積もりに効く。 */
function noteFirstTap(){
  lastTouchAt = Date.now();
  if(gateState !== 'open' || firstTapAt) return;
  firstTapAt = Date.now();
  markBusy(orderStartedAt, firstTapAt);
}

/* 1 件終わった。かかった時間を移動平均に混ぜて共有する。 */
async function notePace(){
  if(!orderStartedAt) return;
  const total = Date.now() - orderStartedAt;
  const think = firstTapAt ? firstTapAt - orderStartedAt : total;
  // 置き忘れ・離席のぶんは混ぜない。平均が実態から離れると判断が狂う。
  if(total <= 0 || total > GATE_IDLE_MS) return;
  // 受付機は 4 台ある。購読の値から計算して書くと、同じ窓で終えた台のぶんが
  // 片方消える（開店直後は全台が n=1 になり、互いを潰し合う）。
  try{
    await authReady;
    await runTransaction(ref(db,'config/pace'), cur=>{
      const base = cur || PACE_DEFAULT;
      const n = (base.n || 0) + 1;
      const a = n === 1 ? 1 : PACE_ALPHA;   // 1 件目はそのまま採る
      return {
        ms:    Math.round((base.ms    ?? PACE_DEFAULT.ms)    * (1 - a) + total * a),
        think: Math.round((base.think ?? PACE_DEFAULT.think) * (1 - a) + think * a),
        n
      };
    });
  }catch(e){ /* 共有できなくても受付は止めない */ }
}

/* 放置された接客を畳む。お客様が去ったあと席が「接客中」のまま残ると、
   自動の台数判断がずっと「混んでいる」と読み、要らない受付機を開け続ける。 */
setInterval(()=>{
  if(gateState !== 'open' || !lastTouchAt) return;
  if(Date.now() - lastTouchAt < GATE_IDLE_MS) return;
  closeGate(false);
}, 5000);

// 門はどこを触っても開く。お客様に「どこを押すか」を考えさせない。
$('gate')?.addEventListener('click', openGate);

/* 接客中の「触られている」判定は、画面のどこでも拾う。
   商品の増減だけを見ていると、確定画面で番号札をゆっくり打っている間に
   放置とみなされ、かごごと消える。 */
addEventListener('pointerdown', ()=>{
  if(gateState === 'open') lastTouchAt = Date.now();
}, { passive: true, capture: true });

/* ---------- 待機と、店員を呼ぶ ----------
   待機は「この受付機だけ閉じている」状態。店が閉じているわけではないので、
   お客様には他の窓口へ回っていただく。切り替えは管理画面から遠隔で行う。 */
async function setDeskMode(id, to, by = 'hand'){
  try{
    await authReady;
    await update(ref(db,'config/desks/'+id), {
      mode: to,
      // 人が決めた席は、以後ここが自動で動かさない（解くのも人の操作）。
      hold: by === 'hand',
      // 自動で開けた席だけを、自動で待機へ返す。
      auto: by === 'auto' && to === 'open'
    });
  }catch(e){ toast(writeHint(e, '受付機の状態を変えられませんでした')); }
}

/* 店員を呼ぶ。押した受付機に時刻を書き、管理画面と受渡の画面に出す。

   このとき、待機している受付機をすべて注文受付中に戻す。
   店員が 1 台に付きっきりになるので、他が開いていないと列がそこで止まる。
   人が気づいて戻すのを待っていては間に合わないため、ここで自動で開ける。 */
async function callStaff(){
  if(!myDesk) return;
  if(deskHelp(myDesk) > 0) return;        // 既に呼んでいる。押し直させない
  try{
    await authReady;
    await tracked(update(ref(db,'desks/'+myDesk), { help: Date.now() }));
    for(const d of DESKS){
      // 人が待機にした席は開けない。そこに立てる人が居ないから待機にしてある。
      if(desksOnline[d.id] && deskMode(d.id) === 'standby' && !deskHold(d.id)){
        await setDeskMode(d.id, 'open', 'auto');
      }
    }
  }catch(e){
    toast(writeHint(e, '店員を呼べませんでした'));
  }
}

/* 呼び出しに対応した。管理画面からも受渡の画面からも解除できる。
   解除すると、呼び出し表示の「しばらくお待ちください」も一緒に畳む
   （出したまま忘れると、お客様は理由の分からないまま待たされる）。 */
async function clearHelp(id){
  try{
    await authReady;
    await tracked(update(ref(db,'desks/'+id), { help: null }));
    if(helpingDesks().filter(d=>d.id !== id).length === 0) await setNotice(false);
  }catch(e){ toast(writeHint(e, '呼び出しを解除できませんでした')); }
}

/* 呼び出し表示に出す「しばらくお待ちください」。店全体の決めごとなので共有する。 */
let notice = false;
async function setNotice(on){
  try{
    await authReady;
    await set(ref(db,'config/notice'), on === true);
  }catch(e){ toast(writeHint(e, '呼び出し表示の案内を切り替えられませんでした')); }
}

// 呼ばれてからの経過。待たせている時間が見えないと、どれから片づけるか決められない。
const helpAgo = ms => mmss(Math.max(0, Math.floor((Date.now() - ms) / 1000)));

function renderHelp(){
  const list = helpingDesks();
  const rowsBoard = list.map(d=>`
    <div class="callboard-row">
      <span class="callboard-num">${d.label}</span>
      <span class="callboard-ago" data-help="${deskHelp(d.id)}">${helpAgo(deskHelp(d.id))} 経過</span>
      <button type="button" class="callboard-done" data-act="helpdone" data-id="${d.id}"
              aria-label="${d.label} の呼び出しに対応した">対応した</button>
    </div>`).join('');
  const board = $('help-board');
  if(board){
    board.hidden = list.length === 0;
    $('help-list').innerHTML = rowsBoard;
    $('help-head').textContent = list.length > 1
      ? `店員が呼ばれています（${list.length}台）`
      : '店員が呼ばれています';
  }

  const bar = $('ready-help');
  if(bar){
    bar.hidden = list.length === 0;
    $('ready-help-list').innerHTML = list.map(d=>`
      <div class="callbar-row">
        <span class="callbar-num">${d.label}</span>
        <span class="callbar-ago" data-help="${deskHelp(d.id)}">${helpAgo(deskHelp(d.id))}</span>
        <button type="button" class="callbar-done" data-act="helpdone" data-id="${d.id}"
                aria-label="${d.label} の呼び出しに対応した">対応した</button>
      </div>`).join('');
    $('ready-help-head').textContent = list.length > 1
      ? `店員が呼ばれています（${list.length}台）`
      : '店員が呼ばれています';
  }

  const a = $('notice-toggle'), b = $('ready-notice-toggle');
  if(a) a.checked = notice;
  if(b) b.checked = notice;
  const cn = $('call-notice');
  if(cn) cn.hidden = !notice;

  // 鳴らすのは管理と受渡の画面だけ。受付の端末で鳴らすとお客様の前で鳴る。
  const ids = new Set(list.map(d=>d.id));
  const tab = document.body.dataset.tab;
  if(announceReady && (tab === 'control' || tab === 'ready')){
    for(const id of ids) if(!knownHelp.has(id)){
      if(soundOn()) audio.error();
      lastHelpChime = Date.now();
      break;
    }
  }
  knownHelp = ids;
}
let knownHelp = new Set();

// 経過だけを毎秒書き換える。全体を描き直すと「対応した」が押せなくなる瞬間ができる。
let lastHelpChime = 0;
const HELP_REPEAT_MS = 30000;
setInterval(()=>{
  document.querySelectorAll('[data-help]').forEach(el=>{
    const ms = Number(el.dataset.help);
    if(ms) el.textContent = el.closest('.callboard-row') ? `${helpAgo(ms)} 経過` : helpAgo(ms);
  });
  // 一度きりだと聞き逃す。対応されるまで鳴らし直す。
  // お客様はその間ずっと立って待っているので、気づかないのがいちばん重い。
  const tab = document.body.dataset.tab;
  if(!helpingDesks().length || (tab !== 'control' && tab !== 'ready')) return;
  if(Date.now() - lastHelpChime < HELP_REPEAT_MS) return;
  lastHelpChime = Date.now();
  if(soundOn()) audio.error();
}, 1000);

$('helpcall')?.addEventListener('click', ()=>{
  if(!myDesk || deskHelp(myDesk) > 0) return;   // 既に呼んでいるなら何もしない
  // 押し間違いで店員が走ってくると、本当に困っている人の呼び出しが埋もれる。
  // お客様に向けた画面なので、確認は一度だけ、短く訊く。
  ask({
    title: '店員をお呼びしますか？',
    sub: 'お近くの店員がうかがいます。',
    onYes: callStaff
  });
});
$('auto-toggle')?.addEventListener('click', async ()=>{
  autoScaling = !autoScaling;
  renderDeskAdmin();
  try{ await authReady; await set(ref(db,'config/auto'), autoScaling); }
  catch(e){ toast(writeHint(e, '自動の設定を共有できませんでした')); }
});
$('saver-min')?.addEventListener('change', async e=>{
  const v = Math.max(0, Math.min(120, parseInt(e.target.value, 10) || 0));
  e.target.value = String(v);
  try{ await authReady; await set(ref(db,'config/saver'), v); }
  catch(err){ toast(writeHint(err, '省エネの設定を共有できませんでした')); }
});
/* 受け取り時刻のご案内。自動／常に出す／出さない。 */
$('reserve-mode')?.addEventListener('click', async e=>{
  const b = e.target.closest('button[data-reserve]');
  if(!b) return;
  try{ await authReady; await set(ref(db,'config/reserve'), b.dataset.reserve); }
  catch(err){ toast(writeHint(err, 'ご案内の設定を共有できませんでした')); }
});

/* 厨房の体制。ここを変えると、見積もりも厨房の板の割り当ても一緒に変わる。
   シフトで人数が変わるたびに触る場所なので、押しやすい増減で持つ。 */
async function setKitchen(patch){
  // 触った鍵だけを送る。4 鍵まとめて書き戻すと、本部が人数を変えたのと
  // 厨房が穴数を変えたのが重なったとき、片方が古い値で上書きされる。
  const full = kitchenOf({ ...kitchen, ...patch });
  const next = {};
  for(const k of Object.keys(patch)) next[k] = full[k];
  try{ await authReady; await update(ref(db,'config/kitchen'), next); }
  catch(err){ toast(writeHint(err, '厨房の体制を共有できませんでした')); }
}
$('kit-plates')?.addEventListener('change', e=>{
  const el = e.target.closest('[data-plate]');
  if(!el) return;
  const key = el.dataset.plate, k = el.dataset.k;
  const v = k === 'use' ? el.checked : Number(el.value);
  setKitchen({ plates: { ...kitchen.plates, [key]: { ...kitchen.plates[key], [k]: v } } });
});
$('kit-cycle')?.addEventListener('change', e=>setKitchen({ cycleMin: Number(e.target.value) }));
$('kit-margin')?.addEventListener('change', e=>setKitchen({ margin: Number(e.target.value) }));
const setBowl = patch => setKitchen({ bowls: { ...kitchen.bowls, ...patch } });
$('kit-bowls')?.addEventListener('change',       e=>setBowl({ count:   Number(e.target.value) }));
$('kit-bowl-pieces')?.addEventListener('change', e=>setBowl({ pieces:  Number(e.target.value) }));
$('kit-bowl-grams')?.addEventListener('change',  e=>setBowl({ grams:   Number(e.target.value) }));
$('kit-wash')?.addEventListener('change',        e=>setBowl({ washMin: Number(e.target.value) }));

/* 終了時刻。人が閉め忘れても、約束できない注文を受け続けないための歯止め。 */
$('close-at')?.addEventListener('change', async e=>{
  const v = (e.target.value || '').trim();
  if(v && !/^\d{1,2}:\d{2}$/.test(v)){ toast('終了時刻は 15:30 のように入れてください。'); return; }
  try{ await authReady; await set(ref(db,'config/closeAt'), v); }
  catch(err){ toast(writeHint(err, '終了時刻を共有できませんでした')); }
});

$('notice-toggle')?.addEventListener('change', e=>setNotice(e.target.checked));
$('ready-notice-toggle')?.addEventListener('change', e=>setNotice(e.target.checked));

/* 在席ノードに書き戻す値。残すのは在席に関わるものだけにする。

   丸ごと書き戻す（{...cur}）と、古い版が置いた mode / auto がノードに残って
   いた場合にそれも一緒に送ることになり、新しいルールの $other:false に弾かれて
   受付機を掴めなくなる。知っている鍵だけを通す。 */
function deskSeat(cur){
  const seat = { client: clientId, at: Date.now() };
  for(const k of ['help','busy','firstAt']) if(cur?.[k]) seat[k] = cur[k];
  return seat;
}

/* 「切れたら消す」の予約を外す。外し忘れると、別の端末がその席を取った後に
   こちらの回線が切れた瞬間、他人の名乗りを消してしまう。 */
async function dropDisconnect(id){
  if(!id) return;
  try{ await onDisconnect(ref(db,'desks/'+id)).cancel(); }catch(e){}
}

/* 席を空ける。force なしでは自分の席しか触らない（他の端末の名乗りを黙って奪わない）。 */
async function releaseDesk(id, force){
  if(!id) return;
  await dropDisconnect(id);
  try{
    await authReady;
    await runTransaction(ref(db,'desks/'+id), cur=>{
      if(!cur) return null;
      if(!force && cur.client !== clientId) return;   // 自分の席でなければ中止
      return null;                                     // null を返すと削除
    });
  }catch(e){
    // 黙って失敗すると、本部からは「押しても何も起きない」にしか見えない。
    console.error('受付機を空けられませんでした:', e);
    toast(writeHint(e, '受付機を空けられませんでした'));
  }
}

/* 強制解除。席を空けるだけでなく、持っていた端末に「もう使うな」を残す。
   消えた名乗りだけでは端末が取り直してしまうので、ここが本体。 */
async function kickDesk(id){
  const holder = desksOnline[id]?.client || '';
  let marked = true;
  try{
    await authReady;
    // 端末が居ない席は、印を残しても意味がない（次に取る端末が困るだけ）。
    if(holder) await tracked(update(ref(db,'config/desks/'+id), { kick: holder }));
  }catch(e){
    // 印が書けなくても、席を空けるところまでは必ずやる。
    // ここで止めると「押しても何も起きない」に戻る（ルール未公開のとき実際に起きた）。
    marked = false;
    console.error('強制解除の印を残せません:', e);
  }
  await releaseDesk(id, true);
  toast(marked
    ? `${deskLabel(id)} を解除しました。`
    : `${deskLabel(id)} を空けました。ただし元の端末が取り直す場合があります`
      + '（ルールが古いままかもしれません。管理画面の下を確認してください）。',
    marked ? 'info' : 'error');
}

/* 席を掴む。購読の値で判定すると、2 台が同時に同じ番号を押したとき両方通る。
   トランザクションにして、後から来たほうを必ず弾く。 */
async function claimDesk(id, quiet){
  if(deskClaiming) return false;
  // 自動の取り直しは、強制解除された席には行かない。
  // 人が画面で選び直したときだけ解ける（その端末が目の前にあるということ）。
  if(quiet && kicked(id)) return false;
  deskClaiming = true;
  const err = $('desk-err');
  const say = msg => { if(err){ err.textContent = msg; err.classList.add('show'); } };
  try{
    await authReady;
    const prev = myDesk;
    const r = ref(db, 'desks/' + id);
    const tx = await runTransaction(r, cur=>{
      if(cur && cur.client && cur.client !== clientId) return;   // 起動中 → 中止
      // 呼び出しと接客中の印は残す（待機は config 側にあるので消えない）。
      return deskSeat(cur);
    });
    if(!tx.committed){
      say(`${deskLabel(id)} は別の端末が起動しています。ほかの受付機を選んでください。`);
      return false;
    }
    // 繋がりが切れたら席を空ける。画面を閉じる・電池切れ・回線断のどれでも効く。
    try{ await onDisconnect(r).remove(); }catch(e){}
    if(prev && prev !== id) await releaseDesk(prev);
    // 人が選び直した席の強制解除は、ここで解く。
    if(!quiet && deskKick(id)){
      update(ref(db,'config/desks/'+id), { kick: null }).catch(()=>{});
    }
    myDesk = id;
    deskClaimedAt = Date.now();
    try{ localStorage.setItem('deskNo', id); }catch(e){}
    if(err){ err.textContent = ''; err.classList.remove('show'); }
    paintDesks();
    // 受付停止・終了の覆いは tickFlow でしか描き直されない。席を取った直後に
    // 呼ばないと、止めている最中に交代した端末が 10 秒ほど空白の画面になる。
    tickFlow();
    if(openEl?.id === 'm-desk') closeModal();
    if(!quiet) toast(`この端末は ${deskLabel(id)} です。`, 'info');
    return true;
  }catch(e){
    say(writeHint(e, '受付機を登録できませんでした'));
    return false;
  }finally{ deskClaiming = false; }
}

/* 受付の画面を離れたら、その席を空ける。
   受付機は 4 台しかないのに、厨房や管理を見に行っただけの端末が席を
   掴んだままで、他の端末から「起動中」で選べなくなっていた。
   覚えている番号（deskNo）は消さない。戻ってきたら黙って取り直す。 */
function leaveDesk(){
  if(!myDesk) return;
  const id = myDesk;
  myDesk = null;
  idleSince = 0;
  releaseDesk(id).then(paintDesks).catch(()=>{});
  paintDesks();
}

/* 受付の画面に戻ってきた。覚えている席が空いていれば黙って取り直す。
   名乗りが届く前は何もしない（届いた時点で reconcileDesk が同じことをする）。 */
function resumeDesk(){
  if(myDesk || deskClaiming) return;
  if(!desksKnown){ ensureDesk(); return; }
  let remembered = null;
  try{ remembered = localStorage.getItem('deskNo'); }catch(e){}
  if(remembered && DESKS.some(d=>d.id===remembered) && !deskTaken(remembered)
     && !kicked(remembered)){
    claimDesk(remembered, true).then(ok=>{ if(!ok) ensureDesk(); });
    return;
  }
  ensureDesk();
}

/* 受付の画面は、受付機を名乗るまで使わせない。
   誰が起動中か分からないうちは訊かない（空いている席まで「起動中」に見えてしまう）。 */
function ensureDesk(){
  if(document.body.dataset.tab !== 'order') return;
  if(myDesk || deskClaiming || !desksKnown) return;
  if(openEl && openEl.id !== 'm-desk') return;   // 別の確認が出ている間は割り込まない
  openModal('m-desk', ()=>{ setTimeout(ensureDesk, 0); });
}

/* 本部に強制解除されていたら、その席を手放す。
   回線が切れていた端末にも、戻ってきた時点で効く（印は消えない場所にある）。 */
function checkKick(){
  if(!myDesk || !kicked(myDesk)) return;
  const id = myDesk;
  dropDisconnect(id);
  myDesk = null;
  try{ localStorage.removeItem('deskNo'); }catch(e){}
  releaseDesk(id, true);
  paintDesks();
  toast(`${deskLabel(id)} は本部が解除しました。受付機を選び直してください。`);
  ensureDesk();
}

/* 名乗りが届いたら、この端末が覚えている席と突き合わせる。 */
function reconcileDesk(){
  if(deskClaiming) return;
  if(myDesk){
    const on = desksOnline[myDesk];
    if(on && on.client === clientId) return;     // そのまま
    // 掴んだ直後は判定しない。自分の書き込みが返る前に「消された」と読んでしまう。
    if(Date.now() - deskClaimedAt < 5000) return;
    // オフライン中は判定しない。手元の値が欠けているだけのことがある。
    if(!online) return;
    if(!on){
      // 席が消えているだけ。回線が切れて onDisconnect が実行された場合がこれで、
      // 受付の途中で選び直させるのは重すぎる。黙って取り直す。
      // 他の端末のものになっていた場合（下）だけ、本当に明け渡す。
      rearmDesk();
      return;
    }
    // 別の端末がこの席を名乗った。明け渡して選び直させる。
    dropDisconnect(myDesk);
    myDesk = null;
    try{ localStorage.removeItem('deskNo'); }catch(e){}
    paintDesks();
    toast('この受付機は別の端末が使い始めました。もう一度選んでください。');
    ensureDesk();
    return;
  }
  if(!deskBooted){
    deskBooted = true;
    let remembered = null;
    try{ remembered = localStorage.getItem('deskNo'); }catch(e){}
    // リロードでは onDisconnect の片づけがまだ終わっていないことがある。
    // 自分の印が付いた席は自分のものとして黙って取り直す（毎回選ばせない）。
    // 取り直すのは受付の画面を開いている端末だけ。厨房や受渡の端末が
    // 「前は受付だった」記憶で席を占めると、受付が 1 台使えなくなる。
    if(document.body.dataset.tab === 'order'
       && remembered && DESKS.some(d=>d.id===remembered) && !deskTaken(remembered)
       && !kicked(remembered)){
      claimDesk(remembered, true).then(ok=>{ if(!ok) ensureDesk(); });
      return;
    }
  }
  paintDesks();
  ensureDesk();
}

/* 名乗りが届かないまま始まることもある（通信が遅い・DB が読めない）。
   それでも受付機は選ばせる。重なりはトランザクションが弾く。 */
setTimeout(()=>{ desksKnown = true; ensureDesk(); }, 2500);

/* 名乗りを張り直す。

   onDisconnect は「予約した時につながっていた 1 本の接続」に結び付く。
   回線が一瞬でも切れると、サーバーはその予約を実行して席を消す。
   RTDB は裏で勝手に繋ぎ直す（最初の接続方式の切り替えでも一度切れる）ので、
   張り直さないと「選んだはずなのに、しばらくして戻される」が起きる。
   Firebase の在席検知が .info/connected を見て毎回書き直す形なのはこのため。

   ついでに at も新しくなるので、管理画面の「応答なし」判定もここで保たれる。
   待機はこのノードに無い（config/desks にある）ので、ここで消えることはない。 */
function rearmDesk(){
  if(!myDesk) return;
  if(kicked(myDesk)) return;      // 強制解除された席は取りに行かない
  const id = myDesk;
  const r = ref(db, 'desks/' + id);
  runTransaction(r, cur=>{
    // 他の端末のものになっていたら触らない。取り返しに行かない。
    if(cur && cur.client && cur.client !== clientId) return;
    return deskSeat(cur);
  }).then(tx=>{
    if(tx.committed) onDisconnect(r).remove().catch(()=>{});
  }).catch(()=>{});
}
// 取りこぼしても 1 分で自分で直る。接続の立ち上がりだけに頼らない。
setInterval(rearmDesk, 60000);

$('desk-pick')?.addEventListener('click', e=>{
  const b = e.target.closest('button[data-desk]');
  if(!b || b.disabled) return;
  claimDesk(b.dataset.desk);
});
$('desk-chip')?.addEventListener('click', ()=>{
  desksKnown = true;
  openModal('m-desk', ()=>{ setTimeout(ensureDesk, 0); });
});
$('desk-cancel')?.addEventListener('click', closeModal);

/* ---------- 確認 ---------- */
function cartItems(){
  return FLAVORS.filter(f=>(cart[f.key]||0) > 0)
    .map(f=>({ key:f.key, label:f.label, unit:f.unit, qty:cart[f.key], unitPrice:prices[f.key] ?? f.defaultPrice }));
}

/* 番号入力パッド。
   お客様に向く画面なので、残り枚数や「次の番号」といった内部の事情は出さない。
   出すのは打った番号と、間違ったときの理由だけ。 */
let padValue = '';
const padErr = msg => { $('pad-err').textContent = msg || ''; };

function padRender(){
  const d = $('pad-display');
  // 値だけを差し替える。要素ごと textContent で潰すと、読み上げ用の
  // 「入力中の番号」の文言まで消える（aria-label を使うと今度は数字が読まれない）。
  const v = $('pad-value');
  if(v) v.textContent = padValue || '—';
  else d.textContent = padValue || '—';
  d.dataset.empty = String(padValue === '');
  $('pad-ok').disabled = padValue === '';
}
/* 空から打たせる。

   以前は「次に使える札」を先に入れていた。毎回ゼロから打つより速く、
   打ち間違いも減るという理由だったが、速さと引き換えに、画面の数字が
   手元の札と無関係に決まっていた。入っている数字をそのまま確定すれば、
   札をケースから取らなくても注文が立つ（画面では出ていることになるのに、
   お客様は何も持っていない）。

   空にすると、打つ人は必ず手元の札を見る。番号の出どころが実物になるので、
   取らずに確定する道がふさがる。1 件あたり数秒遅くなるが、
   当日その場で直せない種類の事故を 1 つ減らすほうを採る。 */
function padReset(){
  padValue = '';
  padErr('');
  padRender();
}

function padSubmit(){
  const n = tagCount();
  const t = parseInt(padValue, 10);
  const inUse = tagsInUse();
  // 札を配り切った状態。番号ごとに「まだお渡し中」と断っても、
  // 「もう配れる札が無い」ことは画面のどこにも出ていなかった。
  if(inUse.length >= n){
    return padErr(`番号札が全部出ています（${n}枚）。回収できた札を使うか、受付を一度止めてください。`);
  }
  if(!Number.isFinite(t) || t < 1 || t > n) return padErr(`1〜${n} の番号を入れてください`);
  if(inUse.includes(t))                    return padErr(`${t}番はまだお渡し中です`);

  // テンキーの「決定」は押し間違えやすいので、最後に一度だけ確かめる。
  pendingPlace = t;
  const total = cartItems().reduce((sum,i)=>sum+i.qty*i.unitPrice, 0);
  // 確かめるのは番号ではなく「ケースから取ったか」。番号だけを読み合わせても、
  // 札がケースに残ったまま確定される事故（画面では出ていることになっているのに、
  // お客様は何も持っていない）は防げない。
  $('place-sub').innerHTML =
    `ケースから <b>${t}</b> 番の札をお取りください<br>` +
    `<span class="place-amount">合計 <b>${yen(total)}</b> 円</span>`;
  // 絵の札にも同じ番号を入れる。手元の札と見比べる対象になる。
  $('place-tag-num').textContent = String(t);
  openModal('m-place');
}

/* 確定待ちの番号札。モーダルを閉じたら必ず捨てる。 */
let pendingPlace = null;

$('place-no').addEventListener('click', ()=>{
  pendingPlace = null;
  openModal('m-confirm');   // 番号を打ち直せるよう確定画面に戻す
});

$('place-yes').addEventListener('click', ()=>{
  const t = pendingPlace; pendingPlace = null;
  closeModal();
  if(t !== null) placeOrder(false, t);
});

$('pad-keys')?.addEventListener('click', e=>{
  const b = e.target.closest('button[data-k]');
  if(!b || b.disabled) return;
  const k = b.dataset.k;
  if(k === 'ok') return padSubmit();
  if(k === 'back') padValue = padValue.slice(0, -1);
  else if(padValue.length < String(tagCount()).length) padValue = (padValue + k).replace(/^0+/, '');
  padErr('');
  padRender();
});

$('submit-btn').addEventListener('click', ()=>{
  const items = cartItems();
  if(!items.length) return;
  // 受付機を名乗っていない端末に受付をさせない。名乗りが届いていなくても、
  // ここまで来たなら選ばせる（選ばないまま注文が立つほうが困る）。
  if(!myDesk){ desksKnown = true; ensureDesk(); return; }
  // 待機中は受けない。覆いが CSS の 1 行で消えても事故にしない。
  if(deskMode(myDesk) === 'standby') return;
  $('recap-items').innerHTML = items.map(i=>`
    <div class="recap-item">
      <img src="${MARK[i.key]||''}" alt="">
      <div>
        <div class="recap-name">${i.label}</div>
        <div class="recap-price">${yen(i.unitPrice)}<small>円</small></div>
        <span class="recap-qty">${i.qty}${i.unit}</span>
      </div>
    </div>`).join('');
  $('recap-total').innerHTML = `${yen(items.reduce((s,i)=>s+i.qty*i.unitPrice,0))}<small>円</small>`;
  // 受け取り時刻の見込み。ここで出しておかないと、確定してから初めて
  // 「30分後です」と知らせることになり、断る機会をお客様から奪う。
  const pk = $('confirm-pickup');
  if(pk){
    const cups = items.reduce((s,i)=>s+i.qty, 0);
    const f = forecast(orders, { rate: cupRate, addCups: cups });
    pk.hidden = !reserveNow;
    pk.innerHTML = `お渡しは <b>${hhmm(f.pickupMs)}</b> ごろの見込みです（約${f.waitMin}分）`;
  }
  if(useTags) padReset();
  openModal('m-confirm');
});
$('confirm-back').addEventListener('click', closeModal);

/* ---------- どこで待たされているか ----------
   「確定が遅い」だけでは、認証・注文の読み直し・採番・書き込みのどれが
   遅いのか切り分けられない。段階ごとの所要時間を console に出す。
   画面には出さない（受付の画面はお客様に向く）。

   メソッド呼び出しの形にすると dom_wiring_test が定義を見つけられないので、
   素の関数に状態を渡す形にしてある。 */
function watchStart(name){
  const t = performance.now();
  return { name, t0:t, last:t, laps:[] };
}
function watchLap(w, label){
  const now = performance.now();
  w.laps.push(`${label} ${Math.round(now - w.last)}ms`);
  w.last = now;
}
function watchEnd(w){
  // console.debug は Chrome の既定で隠れる（詳細/Verbose のみ）。log で出す。
  console.log(`[${w.name}] ${w.laps.join(' / ')} → 合計 ${Math.round(performance.now() - w.t0)}ms`);
}

/* 列がないときは番号札を出す意味がないので、札を出さずに受け付ける。
   飛ばすのは厨房だけで、受渡と支払いは通常の注文とまったく同じ経路を通す。
   売上・在庫も同じに扱う（記録から漏らさない）。 */
async function placeOrder(immediate, pickedTag){
  // 札モード中に札なしで確定させると、札を持っているお客様の注文が
  // 札なしとして立ち、受渡口で誰のものか分からなくなる。
  // これを止めているのが CSS の display:none だけだと、CSS を 1 行触った
  // だけで事故が戻る。ここでも塞ぐ。
  if(immediate && useTags){
    toast('番号札を入力してから確定してください。');
    return;
  }
  // 確定を開いている間に遠隔で待機へ切り替わることがある。ここでも断つ。
  if(myDesk && deskMode(myDesk) === 'standby'){
    closeModal();
    toast('この受付機は待機中です。他の窓口でお受けします。');
    return;
  }
  const w = watchStart('注文確定');
  const btn = $('confirm-now');
  const keep = btn.innerHTML;
  const keys = $('pad-keys');
  btn.disabled = true;
  if(keys) keys.querySelectorAll('button').forEach(b=>b.disabled = true);
  if(immediate) btn.textContent = '送信中…';
  try{
    await authReady;   // 描画は待たせないが、書き込みは認証の後でしか通らない
    watchLap(w, '認証');

    // 受付機を名乗っていない端末に注文を立てさせない。押す側のハンドラにも
    // 同じ関門があるが、CSS や描画の順番で片方が外れることがあるので二重にする。
    if(!myDesk){ closeModal(); desksKnown = true; ensureDesk(); return; }
    const noTag = immediate || !useTags;
    // 札は受付係が実物を見てタップしたものを使う。山の並び順に依存させない。
    const tag = noTag ? 0 : (pickedTag || 0);
    if(!noTag && !tag){
      closeModal(); toast('番号札を選んでください。'); return;
    }
    const items = cartItems().map(i=>({ flavor:i.key, quantity:i.qty }));

    // 在庫と札は、購読しているスナップショットではなくサーバーの今の値で見る。
    //
    // 購読の値は数百ミリ秒〜数秒古いことがあり、受付が 2 台あると
    // 「最後の 1 カップを両方が売る」「同じ札を両方が出す」が実際に起きる。
    // ここで一度読み直すことで、危険な窓を 1 往復ぶんまで縮める。
    //
    // 完全には消えない（読んでから書くまでの間は残る）。消すには在庫と札を
    // サーバー側のトランザクションで確保する必要があり、その方式は
    // 端末が落ちたときに在庫が取り残される別の事故を生む。文化祭の規模では
    // 窓を縮めるほうが割に合うと判断した。
    let live = orders;
    try{
      const snap = await tracked(get(ref(db, 'orders')));
      const v = snap.val();
      if(v) live = Object.entries(v).map(([k,o]) => normalize(o,k));
    }catch(e){ /* 読めなければ購読の値で進む。受付は止めない */ }
    watchLap(w, '注文の読み直し');

    const inSess = live.filter(o => inSession(o, session));
    const remaining = {};
    FLAVORS.forEach(f=>{ remaining[f.key] = remainingOf(f.key, inSess); });
    const inUse = tagsInUse(inSess);
    if(!noTag && inUse.includes(tag)){
      closeModal(); toast(`番号札 ${tag} はまだお渡し中です。別の札を使ってください。`); return;
    }

    const nowMs = Date.now();
    // 受け取り時刻は、読み直したサーバーの値 (inSess) で出す。手元の購読値だと
    // 直前に別の受付機が受けた注文が入っておらず、守れない時刻を約束する。
    const addCups = items.reduce((s,i)=>s+(i.quantity||0), 0);
    const pickupMs = reserveNow
      ? forecast(inSess, { now: nowMs, rate: cupRate, addCups }).pickupMs : 0;

    const req = { items, prices, nowMs, maxPerOrder: limits.maxPerOrder, remaining, pickupMs,
                  // immediate は「厨房を飛ばす」の意味。札なしの注文は焼き待ちに出さず、
                  // 受渡待ち (ready) から始めて受渡口で渡す。
                  immediate: noTag, tag, tagCount: tagCount(), inUseTags: inUse,
                  session,
                  // 支払いは必ず未払いで立てる。以前は札なしを支払い済みで立てていたが、
                  // 受付係が代金を受け取り忘れても誰も気づけず、締めでも
                  // 「受注額＝受取済み」で一致してしまい、差額が最後まで出なかった。
                  paid: false };

    // 採番より先に中身を検証する。順番が逆だと、売り切れで弾かれるたびに
    // 採番だけが進み、注文番号が飛んで実際の件数と合わなくなる。
    const dry = build({ ...req, seq: 1 });
    if(!dry.ok){ closeModal(); toast(dry.error || '注文を作成できませんでした。'); return; }

    const seq = await tracked(nextSeq());
    watchLap(w, '採番');
    const built = build({ ...req, seq });
    if(!built.ok){ closeModal(); toast(built.error || '注文を作成できませんでした。'); return; }

    await tracked(set(ref(db, built.path), built.order));
    watchLap(w, '書き込み');
    closeModal();
    if(soundOn()) audio.confirm();
    showThanks(built.order);
    // 1 件ぶんの実測を平均に混ぜてから門を閉じる（閉じると起点が消える）。
    notePace();
    closeGate(true);
  }catch(err){
    closeModal();
    if(soundOn()) audio.error();
    toast(writeHint(err, '注文を保存できませんでした'));
    console.error(err);
  }finally{
    watchEnd(w);
    btn.disabled = false;
    btn.innerHTML = keep;
    if(keys){ keys.querySelectorAll('button').forEach(b=>b.disabled = false); padReset(); }
  }
}

/* 注文の組み立ては Go を唯一の正とする。WASM が落ちているときだけ、
   同じ規則を写した lib/pure.js で受付を続ける（集計と CSV は諦める）。
   2 つの実装がずれないことは test/pure_parity_test.mjs で突き合わせている。 */
function build(req){
  if(window.goBuildOrder) return window.goBuildOrder(req);
  return fallbackBuild({ ...req, flavors: FLAVORS });
}

$('confirm-now').addEventListener('click', ()=>placeOrder(true));

/* ---------- 番号の提示と呼び戻し ---------- */
function itemsText(o){
  return (o.items||[]).map(i=>`${label(i.flavor)} ${i.quantity}${unit(i.flavor)}`).join(' ／ ');
}
/* 受け付け終わりの画面。番号札を出した注文だけ番号を添える。
   すぐ閉じて受付に戻し、次のお客様へ回せるようにする。 */
function showThanks(o){
  const num = $('done-num');
  num.textContent = numOf(o);
  num.hidden = false;
  $('done-meta').textContent = `${itemsText(o)}　合計 ${yen(o.price)}円`;
  // 次に何をすればよいかを出す。ここが抜けていると、お客様は番号札を持ったまま
  // その場に立ち止まる（実際、どこで払うのかはこの画面にしか書いていない）。
  // 札なしの注文は受渡口へ回る。代金もそこで受け取るので、受付では受け取らない。
  // ここを書かないと、受付係が現金を受け取ってしまい二重取りになる。
  const tagged = !!o.number;
  // 受け取り時刻のご案内。番号だけ出して帰すと、お客様はその場に立って待つ。
  // 「いつ戻ればよいか」はこの画面にしか書いていない。
  const when = $('done-pickup');
  if(when){
    when.hidden = !o.pickupMs;
    if(o.pickupMs) when.innerHTML =
      `<b>${hhmm(o.pickupMs)}</b> ごろ<span>お越しください</span>`;
  }
  $('done-next').textContent = o.pickupMs
    ? '番号札を持って、会計口へお進みください（お品物はお時間になってから）'
    : tagged
      ? '番号札を持って、会計口にお進みください'
      : 'お渡し口で、お品物とお会計をご用意しております';
  // SVG に hidden は効かない（HTML 要素の性質なので、代入しても属性にならない）。
  // 親の印で出し分ける。
  $('done-guide').dataset.mode = tagged ? 'tag' : 'notag';
  openModal('m-done');
  // 受け付けが済んだ合図。番号が出た瞬間にだけ、短く散らす。
  requestAnimationFrame(()=>bloom($('done-sheet'), 16));
  // 6 秒。お客様が番号を読み、札を受け取り、進む向きを確かめるまでの時間。
  // 短いと、札を手にする前に画面が変わって「何番だったか」が消える。
  // 時刻をご案内したときは長めに出す（番号に加えて時刻も覚えてもらうため）。
  setTimeout(()=>{
    if(openEl && openEl.id === 'm-done') closeModal();
    gateThanks();   // 番号札が消えてから、緑を見せる時間を数え始める
  }, o.pickupMs ? DONE_HOLD_MS + 3500 : DONE_HOLD_MS);
}
$('m-done').addEventListener('click', closeModal);

/* ---------- 通知音 ----------
   音は lib/audio.js が持つ。ここは「鳴らすかどうか」だけを決める。

   旧実装は鳴らすたびに AudioContext を new していた。ブラウザの同時生成上限
   （4〜6 個）に当たると以降ずっと無音になり、しかも例外を握り潰していたので
   誰も気づけなかった。context は 1 つを使い回す。

   iOS は操作を経ていない AudioContext を動かさない。厨房・呼び出し・金額表示は
   誰も触らない端末なので、最初の操作で必ず起こしにいく。 */
/* 通知音のスイッチは厨房と管理の 2 か所に置く。どちらを触っても揃える。
   以前は厨房タブにしか無く、呼び出し表示や金額表示の端末で音を止めるには、
   お客様に向けた画面でナビを開いて「見るだけ」と書いた厨房へ移るしかなかった。 */
addEventListener('DOMContentLoaded', ()=>{
  const a = document.getElementById('sound'), b = document.getElementById('sound-ctl');
  if(!a || !b) return;
  b.checked = a.checked;
  a.addEventListener('change', ()=>{ b.checked = a.checked; });
  b.addEventListener('change', ()=>{ a.checked = b.checked; });
});

const soundOn = () => $('sound') ? $('sound').checked : true;
function ping(){ if(soundOn()) audio.newOrder(); }

// 画面のどこを触っても音を起こす。受付はお客様の前で必ず触るので確実に通る。
//
// once:true だと「1 回目の操作では起こせなかった」場合に二度と試さない。
// iOS の resume() は非同期なので 1 回目で起き切らないことがあり、さらに
// 他アプリへ移る・画面を消す・通話が入ると context は止まる。
// 起きるまで（止まったらまた）何度でも試す形にする。
const WAKE_EVENTS = ['pointerdown','keydown','touchstart'];
function wakeAudio(){
  audio.unlock();
  if(audio.ready()) WAKE_EVENTS.forEach(ev => removeEventListener(ev, wakeAudio));
}
WAKE_EVENTS.forEach(ev => addEventListener(ev, wakeAudio, { passive: true }));

/* 音が止まっていることを画面に出す。
   iOS は「一度も触られていない端末」では音を出せない。厨房・呼び出し・金額表示は
   誰も触らない端末なので、ここが無いと注文が来ても鳴らないまま誰も気づけない
   （鳴らない理由が画面のどこにも出ない）。押す操作そのものが解錠になる。 */
const audioWake = $('audio-wake');
function refreshAudioWake(){
  if(!audioWake) return;
  audioWake.hidden = !soundOn() || audio.ready();
}
audioWake?.addEventListener('click', () => {
  audio.unlock();
  // resume() は非同期。起きたかどうかは少し待ってから見る。
  setTimeout(refreshAudioWake, 400);
});
// 画面を離れると iOS は context を止める。止まったらまた出す。
setInterval(refreshAudioWake, 1000);
refreshAudioWake();
$('sound')?.addEventListener('change', e => {
  audio.setEnabled(e.target.checked);
  if(e.target.checked) audio.unlock();
});

/* ---------- 再読み込みで死なせない ----------
   会場で一番困るのは、うっかり再読み込みして二度と戻ってこないこと。
   注文データは Firebase が持つので、控えるのは画面そのものだけ。
   network-first なので、オンラインなら常に新しいほうが使われる。 */
// && は || より強く結び付く。括弧が無いと、対応していない端末でも localhost なら
// 登録を試みてしまう。
if('serviceWorker' in navigator &&
   (location.protocol === 'https:' || location.hostname === 'localhost')){
  addEventListener('load', ()=>{
    navigator.serviceWorker?.register('sw.js').catch(e => console.warn('sw:', e));
  });
}

/* ---------- 画面を消させない ----------
   厨房・呼び出し・金額表示は置きっぱなしの端末なので、数分で暗転する。
   文化祭で最も起きやすい事故なので、対応していれば必ず取りに行く。
   タブを戻したときに解放されているため、復帰時に取り直す。 */
let wakeLock = null;
async function keepAwake(){
  try{
    if(!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    if(wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  }catch(e){ /* 電池が少ない等で断られる。運用は続ける */ }
}
// 取り直す機会を増やす。OS は通話・通知・低電力で黙って解除するので、
// visibilitychange だけに頼ると、置きっぱなしの端末からいつの間にか効果が消える。
setInterval(keepAwake, 30000);
['pointerdown','keydown','touchstart'].forEach(ev =>
  addEventListener(ev, keepAwake, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible') keepAwake();
});
keepAwake();

/* ---------- Firebase ---------- */
/* サインイン失敗の原因はコードで切り分かる。まとめて「匿名を有効に」と出すと、
   接続設定がダミーのときに的外れな案内になり、原因探しが遠回りになる。 */
const PREVIEW_PROJECT = 'ui-preview-placeholder';
function authHint(code){
  if(firebaseConfig.projectId === PREVIEW_PROJECT)
    return 'firebase-config.js がプレビュー用のダミーのままです。実在するプロジェクトの値に差し替えてください。';
  switch(code){
    case 'auth/api-key-not-valid':
    case 'auth/invalid-api-key':
      return 'firebase-config.js の apiKey が正しくありません。';
    case 'auth/configuration-not-found':
    case 'auth/operation-not-allowed':
      return 'Firebase の Authentication →「ログイン方法」で「匿名」を有効にしてください。';
    case 'auth/network-request-failed':
      return 'ネットワークに繋がりません。通信を確かめてください。';
    case 'auth/unauthorized-domain':
      return 'このドメインが Authentication の承認済みドメインに入っていません。';
    default:
      return 'ログインできません（'+code+'）。';
  }
}

/* ルールが auth != null を要求するため、購読を張る前にサインインを済ませる。
   匿名セッションは localStorage に残るので 2 回目以降はオフラインでも即通る。 */
const authReady = new Promise(resolve=>{
  const unsub = onAuthStateChanged(auth, user=>{
    if(user){ unsub(); resolve(); return; }
    signInAnonymously(auth).catch(e=>{
      unsub();
      toast(authHint(e.code));
      resolve();   // 購読は張る。復帰時に Firebase が読み直す。
    });
  });
});

/* オフラインでも Firebase は書き込みを端末内に溜めるだけなので、画面上は成功に見える。
   しかも RTDB のキューはメモリ上にあり、この状態でリロードすると注文は消える。
   気づけるよう接続状態を常時出す。 */
let online = true;
/* オフライン中の書き込みは端末内に溜まるだけで、この状態でリロードすると消える。
   「何件が宙に浮いているか」が見えないと、閉じてよいか判断できない。
   RTDB は未送信数を教えてくれないので、こちらの書き込みを自分で数える。 */
let inFlight = 0;
async function tracked(promise){
  inFlight++; paintNet();
  try{ return await promise; }
  finally{ inFlight--; paintNet(); }
}
/* 帯を出すまでの待ち。
   .info/connected は購読した瞬間に必ず一度 false を返すので、待ちを置かないと
   読み込みのたびに全端末の上端で赤い帯が焚かれる。繋ぎ直しの瞬きも同じ。
   赤はこの配色では「中止・取消」の色なので、常時出していると、
   本当に送れていないときに誰も読まなくなる。
   出すのは「読んで手を動かす必要があるとき」だけに絞る。 */
const NET_OFFLINE_GRACE = 4000;   // これより短い切断は黙って通す
const NET_SENDING_GRACE = 6000;   // 書き込みは普通 1 秒で終わる。遅いときだけ知らせる
let offlineSince = 0, sendingSince = 0, netTimer = null;

function paintNet(){
  const el = $('net-state');
  if(!el) return;
  const now = Date.now();
  if(netTimer){ clearTimeout(netTimer); netTimer = null; }

  // 溜まり始めた時刻。0 件に戻ったら忘れる。
  if(inFlight > 0){ if(!sendingSince) sendingSince = now; }
  else sendingSince = 0;

  let kind = '', html = '', waitUntil = 0;
  if(!online){
    // 繋がっていない。この状態でリロードすると溜めた書き込みは消えるので、
    // 件数があるかどうかに関わらず伝える必要がある。ここだけ赤。
    if(offlineSince && now - offlineSince >= NET_OFFLINE_GRACE){
      kind = 'offline';
      html = inFlight > 0
        ? `オフライン：未送信 <b>${inFlight}</b> 件。送信が済むまでページを閉じないでください。`
        : 'オフライン：ほかの端末と繋がっていません。';
    }else{
      waitUntil = (offlineSince || now) + NET_OFFLINE_GRACE;
    }
  }else if(sendingSince){
    // 繋がったまま送っている最中。異常ではないので赤では出さない。
    if(now - sendingSince >= NET_SENDING_GRACE){
      kind = 'busy';
      html = `送信中の操作が <b>${inFlight}</b> 件あります。ページを閉じないでください。`;
    }else{
      waitUntil = sendingSince + NET_SENDING_GRACE;
    }
  }

  el.hidden = !kind;
  if(kind){ el.dataset.kind = kind; el.innerHTML = html; }
  // 待ちが明けた時点で描き直す。これが無いと、黙ったまま二度と出ない。
  if(waitUntil) netTimer = setTimeout(paintNet, Math.max(250, waitUntil - now));
}
/* .info/connected は認証不要。authReady の内側に置くと、
   オフラインでサインインが返らない間オフライン表示まで出なくなる。 */
let wasConnected = false;
onValue(ref(db,'.info/connected'), snap=>{
  online = snap.val() === true;
  // 切れていた長さで帯を出すか決める。繋がったら起点を捨てる。
  if(online) offlineSince = 0;
  else if(!offlineSince) offlineSince = Date.now();
  paintNet();
  // 繋がり直したら名乗りを張り直す。切れている間にサーバーが席を消しているため。
  if(online && !wasConnected) rearmDesk();
  wasConnected = online;
});

/* ---------- 金額表示 ----------
   支払い口で選んだ注文の金額を、お客様に向けた別の端末へ出す。

   配信先は支払い口ごとに分ける。1 本の共有ノードにすると、支払い口を
   2 箇所にした瞬間に互いの金額を上書きし合う。既定は 'main'、
   URL の #pay:2 / #amount:2 で 2 番目の口になる。

   時刻の比較はサーバー時刻で行う。端末の時計がずれていると、
   「一度も表示されない」か「永久に消えない」のどちらかになる。 */
const AMOUNT_HOLD_MS = 10 * 60 * 1000;
/* 受け取りが済んだあとの面を出しておく長さ。会計中より短くする。
   次のお客様が前の人の受け取り時刻を見てしまうと、その時刻に戻ってくる。 */
const AMOUNT_DONE_MS = 40 * 1000;
let amountShown = null, amountTimer = null;
let serverSkew = 0;   // サーバー時刻 − この端末の時刻
const nowServer = () => Date.now() + serverSkew;

function renderAmount(){
  const live = $('amount-live'), idle = $('amount-idle'), done = $('amount-done');
  if(!live || !idle) return;
  clearTimeout(amountTimer);

  const d = amountShown;
  const age = d?.at ? nowServer() - d.at : Infinity;
  // 金額が入っていれば会計中、0 のまま注文が残っていれば「受け取りが済んだ」面。
  // 配信ノードに項目を足さずに 2 つの面を分けるため、amount の 0 を印に使う。
  const fresh = !!d && d.amount > 0 && age < AMOUNT_HOLD_MS;
  const paid  = !!d && !fresh && !!d.orderId && age < AMOUNT_DONE_MS;

  live.classList.toggle('hidden', !fresh);
  if(done) done.classList.toggle('hidden', !paid);
  idle.classList.toggle('hidden', fresh || paid);

  if(paid && done){
    $('amount-done-num').textContent = d.number || '';
    // 受け取り時刻は配信ノードではなく注文そのものから引く。
    // この端末も注文を購読しているので、ルールを変えずに出せる。
    const o = orders.find(x => x.id === d.orderId) || allOrders.find(x => x.id === d.orderId);
    const when = $('amount-when');
    const show = !!o && !!o.pickupMs && o.status !== 'completed' && o.status !== 'cancelled';
    when.hidden = !show;
    if(show) when.innerHTML = `<b>${hhmm(o.pickupMs)}</b><i>ごろ</i>`
      + `<span>この時刻ごろにお越しください</span>`;
    amountTimer = setTimeout(renderAmount, Math.max(1000, AMOUNT_DONE_MS - age));
    return;
  }
  if(!fresh) return;

  $('amount-num').textContent = d.number || '';
  // 絵 × 個数。お客様は商品名を読むより、絵と数で確かめるほうが速い。
  const lines = decodeLines(d.items);
  $('amount-items').innerHTML = lines.length
    ? lines.map(i => `
        <span class="amount-line">
          <span class="amount-mark"><img src="${MARK[i.flavor]||''}" alt="${label(i.flavor)}"></span>
          <span class="amount-x" aria-hidden="true">×</span>
          <span class="amount-n">${i.quantity}<small>${unit(i.flavor)}</small></span>
        </span>`).join('')
    : '';
  // 金額は走らせる。切り替わったことがひと目で分かる。
  countUp($('amount-yen'), 0, d.amount, v => `${yen(v)}<small>円</small>`, 520);

  // 期限が来たら自分で引っ込める。支払い口の端末が落ちて消去が届かなかった
  // 場合の保険なので、DB の更新は当てにできない。
  amountTimer = setTimeout(renderAmount, Math.max(1000, AMOUNT_HOLD_MS - age));
}

authReady.then(()=>{
onValue(ref(db,'orders'), snap=>{
  const v = snap.val();
  allOrders = v ? Object.entries(v).map(([k,o])=>normalize(o,k)) : [];
  applySession();
}, ()=>toast('注文データに接続できません。通信を確かめてください。'));

/* 営業回。リハーサルと本番を同じ DB で回すための仕切り。
   注文は消さずに残したまま、集計と画面の対象だけを切り替える。 */
onValue(ref(db,'config/session'), snap=>{
  session = snap.val() || DEFAULT_SESSION;
  paintSession();
  applySession();
}, ()=>{});

/* ---------- 公開されているルールが古くないか ----------
   ルールは $other:false で閉じているため、Go / 画面がフィールドを 1 つ足した時点で
   「公開されているルールが古いと全書き込みが拒否される」状態になる。
   症状は「画面では確定できるのに、何も保存されない」で、原因が見えない。
   実際にこれで 4 回止まっている。

   仕組み：ルール側に rulesVersion/<版> という空ノードの .read だけを置く。
   データは入っていないので読めば null が返るが、その版のルールが公開されて
   いなければ読み取り自体が拒否される。値ではなく「読めるかどうか」で版を測る。
   互換性を壊す変更をしたら、ここと database.rules.json の両方を上げる
   （食い違いは test/dom_wiring_test.mjs が落とす）。 */
const RULES_VERSION = 'v13';
(async ()=>{
  try{
    await get(ref(db, 'rulesVersion/' + RULES_VERSION));
    rulesNote = '';
    renderDeskAdmin();
  }catch(e){
    // 本部が自分で切り分けられるように、管理画面にも同じことを出す。
    rulesNote = `データベースのルールが古いままです（${RULES_VERSION} 未公開）。`
      + '待機・強制解除・厨房の人数・終了時刻は保存できません。'
      + 'database.rules.json を Firebase コンソールで公開してください。';
    renderDeskAdmin();
    document.body.insertAdjacentHTML('afterbegin',
      '<div role="alert" style="background:#b91c1c;color:#fff;padding:14px 18px;text-align:center;' +
      'font-weight:700;line-height:1.8;position:sticky;top:0;z-index:99">' +
      'データベースのルールが古いままです（' + RULES_VERSION + ' 未公開）。<br>' +
      '注文は保存されません。database.rules.json を Firebase コンソールで公開してください。' +
      '</div>');
    console.error('ルールが古い:', e);
  }
})();

/* 新しいデータベースは空で、config/prices が存在しない。
   ルールは注文の flavor が config/prices に載っていることを要求するため、
   ここを初期化しないと注文が 1 件も通らない。
   トランザクションにして、既に値があるときは絶対に上書きしない。 */
async function seedDefaults(){
  const defaults = (window.goLabels?.().defaultPrices) || prices;
  try{
    await runTransaction(ref(db,'config/prices'), cur => cur === null ? defaults : cur);
  }catch(e){
    console.error('config/prices の初期化に失敗:', e);
    toast(writeHint(e, '初期設定を書き込めませんでした'));
  }
}
seedDefaults();

/* 金額表示の購読。display/payment は auth が要るため、認証の後に張る
   （PERMISSION_DENIED で切られた購読は自動では戻らない）。 */
onValue(ref(db,'.info/serverTimeOffset'), snap=>{
  const v = snap.val();
  if(typeof v === 'number') serverSkew = v;
  renderAmount();
}, ()=>{});

onValue(ref(db, 'display/payment/' + station()), snap=>{
  amountShown = snap.val();
  renderAmount();
}, ()=>{ /* 読めないときは何も出さない */ });

onValue(ref(db,'config/prices'), snap=>{
  const v = snap.val();
  if(v){ prices = v; syncCart(); }
}, ()=>toast('単価を読み込めません。通信を確かめてください。'));

/* 受付機の名乗り。どの端末が起動しているかを全台で共有する。
   これが届くまでは「どの席が空いているか」が分からないので、選ばせない。 */
onValue(ref(db,'desks'), snap=>{
  desksOnline = snap.val() || {};
  desksKnown = true;
  paintDesks();
  reconcileDesk();
}, ()=>{ desksKnown = true; ensureDesk(); });

/* 1 件にかかる時間の見積もり。台数の自動判断が唯一これを見る。 */
onValue(ref(db,'config/pace'), snap=>{
  const v = snap.val();
  if(v) pace = { ms: v.ms || PACE_DEFAULT.ms, think: v.think || PACE_DEFAULT.think, n: v.n || 0 };
  renderDeskAdmin();
}, ()=>{});

/* 終了時刻。過ぎたら受付を自動で閉じる。空なら閉めない。 */
onValue(ref(db,'config/closeAt'), snap=>{
  const v = snap.val();
  closeAt = (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) ? v : '';
  tickFlow();
}, ()=>{});

/* 受け取り時刻のご案内（予約）の切り替え。店全体の決めごと。 */
onValue(ref(db,'config/reserve'), snap=>{
  const v = snap.val();
  reserveMode = (v === 'on' || v === 'off') ? v : 'auto';
  tickFlow();
}, ()=>{});

/* 厨房の体制。焼ける量を決めているのは台ではなく人なので、人数を主に置く。 */
onValue(ref(db,'config/kitchen'), snap=>{
  kitchen = kitchenOf(snap.val());
  cupRate = rateFromKitchen(kitchen);
  tickFlow();
  renderKitchen();
}, ()=>{});

/* 受付機の決めごと（待機・人が決めた印）。在席と違い、回線が切れても消えない。 */
onValue(ref(db,'config/desks'), snap=>{
  deskPolicy = snap.val() || {};
  checkKick();
  paintDesks();
  paintStandby();
  tickSaver();
}, ()=>{});

onValue(ref(db,'config/auto'), snap=>{
  const v = snap.val();
  autoScaling = (v === null || v === undefined) ? true : v === true;
  renderDeskAdmin();
}, ()=>{});

/* 手元にある分（作り置き＋届いた分）。受渡の 2 面目だけが使う。 */
onValue(ref(db,'config/onhand'), snap=>{
  onhand = snap.val() || {};
  renderDeal();
}, ()=>{ /* 読めないときはこの端末の値で続ける */ });

onValue(ref(db,'config/saver'), snap=>{
  const v = snap.val();
  saverMin = Number.isFinite(v) ? v : 3;
  renderDeskAdmin();
  tickSaver();
}, ()=>{});

/* 呼び出し表示に出す「しばらくお待ちください」。対応中だけ出す。 */
onValue(ref(db,'config/notice'), snap=>{
  notice = snap.val() === true;
  renderHelp();
}, ()=>{});

onValue(ref(db,'config/useTags'), snap=>{
  const v = snap.val();
  useTags = (v === null || v === undefined) ? true : v === true;
  paintTagMode();
}, ()=>paintTagMode());

onValue(ref(db,'config/limits'), snap=>{
  const v = snap.val();
  if(v){
    limits = { maxPerOrder: v.maxPerOrder || limits.maxPerOrder,
               stock: v.stock || limits.stock,
               tagCount: v.tagCount || limits.tagCount };
    renderMenu(); renderKitchen(); renderFigures();
  }
}, ()=>toast('上限の設定を読み込めません。通信を確かめてください。'));

/* ---------- 採番トランザクションの下ごしらえ ----------
   runTransaction は「その端末が今持っている値」から計算を始め、その値の
   ハッシュを添えてサーバーへ投げる。config/orderCounter/lane0 を誰も購読して
   いないと手元の値は空なので、1 回目は必ず 1 を書こうとしてハッシュが合わず
   datastale で弾かれる。正しい値が届いてから投げ直すので、注文 1 件ごとに
   余計な往復を払っていた（しかも runTransaction が内部で張る購読は終了時に
   外れるため、次の注文でまた同じことが起きる）。
   ここで購読を張っておくと、1 回目から正しい値で投げられる。値は使わない。 */
onValue(ref(db,'config/orderCounter/lane0'), ()=>{}, ()=>{});

});   // authReady.then

setInterval(renderReady, 15000);   // 厨房は tickKitchen が毎秒更新するので対象外

/* ---------- 厨房（キッチンディスプレイ） ----------
   伝票は受付順に左から並べ、経過時間で色を変える。
   しきい値はファストフードの KDS に合わせて 3 分・6 分。
   「困ってから」ではなく「困る前」に気づける位置に置いている。

   この画面は壁に立てかけて置くだけで、誰も触らない（生地と油を扱う手では
   画面を押せないし、押させるべきでもない）。だから
     ・押すところを置かない。「用意できた」は受渡口が打つ
     ・手で送れないので、画面に入り切る枚数だけ出す
   の 2 つを守る。隠れた伝票は、この画面では永遠にめくられない。 */

// 直前の描画に出ていた伝票。差分が新着で、そこだけ立ち上げる。
let seenTickets = new Set();

function renderKitchen(){
  const list = orders.filter(o=>o.status==='pending').sort(byOrder);

  $('kitchen-list').innerHTML = list.map((o, idx)=>{
    const sec = elapsedSec(o.createdMs);
    // 受付順の先頭＝次に用意する 1 枚。ここだけ大きくして、探させない。
    const next = idx === 0;
    // 前回の描画に居なかった伝票は新着。焼いている最中に増えても気づける。
    const fresh = !seenTickets.has(o.id);
    return `
    <article class="kds-ticket" data-ms="${o.createdMs||0}" data-age="${ageOf(sec)}"
             data-next="${next}" data-fresh="${fresh}">
      <div class="kds-head">
        <span class="kds-num">${numOf(o)}</span>
        <span class="kds-timer">${o.createdMs ? mmss(sec) : '—'}</span>
      </div>
      ${next ? '<span class="kds-next-tag">次に用意する</span>' : ''}
      <ul class="kds-lines">
        ${(o.items||[]).map(i=>{
          const got  = madeOf(o, i.flavor);
          const left = Math.max(0, (i.quantity||0) - got);
          // 残りを主にする。注文数のままだと、半分渡した伝票を見てもう一度焼く。
          return `<li data-done="${left === 0}">
            <span class="kds-qty">${left}</span>
            <span class="kds-name">${shortLabel(i.flavor)}</span>
            ${got > 0 ? `<span class="kds-got">${got} 済</span>` : ''}
          </li>`;
        }).join('')}
      </ul>
    </article>`;
  }).join('');

  seenTickets = new Set(list.map(o => o.id));
  $('kitchen-list').classList.toggle('hidden', list.length === 0);
  $('kitchen-empty').classList.toggle('hidden', list.length > 0);
  fitBoard();

  // 調理者が最初に見るべきは「次にどの口へ何を何個載せるか」。
  //
  // 以前ここに出していたのは味ごとの焼き待ち合計だった。合計は「あとどれだけ
  // 残っているか」であって「いま手を動かす内容」ではないので、毎回その場で
  // 頭の中で台数と味に割り振り直すことになる。板は立てかけてあるだけで
  // 触れないのだから、割り振りまで出し切る。
  const spots = planBakers(orders, kitchen, FLAVORS.map(f=>f.key));
  $('plates').innerHTML = spots.map(sp=>{
    const f = sp.flavor ? FLAVORS.find(x=>x.key === sp.flavor) : null;
    const cups = sp.pieces / PIECES_PER_CUP;
    return `
    <div class="kds-plate" data-idle="${!f}" data-flavor="${sp.flavor||''}">
      <span class="kds-plate-name">${sp.label}</span>
      ${f ? `<span class="kds-plate-flavor">
               <img src="${MARK[f.key]||''}" alt="">${f.short || f.label}</span>
             <span class="kds-plate-n">${sp.pieces}<small>個</small></span>
             <span class="kds-plate-sub">＝${
               Number.isInteger(cups) ? `${cups}カップ`
                 : `${Math.floor(cups)}カップ+${sp.pieces % PIECES_PER_CUP}個`}</span>`
          : `<span class="kds-plate-idle">空き</span>
             <span class="kds-plate-sub">焼く注文がありません</span>`}
    </div>`;
  }).join('');

  // 味ごとの残り。割り当ての下に 1 行で添える（これは「あとどれだけ」の話）。
  const leftLine = $('kds-left');
  if(leftLine){
    const now = Date.now();
    leftLine.innerHTML = FLAVORS.map(f=>{
      const pieces = piecesLeft(orders, f.key);
      const stock  = remainingOf(f.key);
      // 生地が尽きるまで。売れている速さで割るだけだが、
      // 「あと何分で終わるか」が分かるかどうかで、締め方がまるで変わる。
      const out = stockOutMin(stock, soldRate(orders, f.key, now));
      const soon = out !== null && out <= 15;
      const cups = pieces / PIECES_PER_CUP;
      return `<span class="kds-left-cell" data-zero="${stock === 0}" data-soon="${soon}">
        <b>${f.short || f.label}</b> 焼き待ち ${pieces}個（${cups.toFixed(0)}カップ`
        + `${cups > 0 ? ` ＝ 生地${bowlsFor(cups, kitchen)}ボウル` : ''}）`
        + `・${stock === 0 ? 'この先は売り切れ'
             : `この先あと${stock}カップ${out !== null ? `（約${out}分）` : ''}`}</span>`;
    }).join('');
  }

  $('kds-tickets').textContent = list.length;
  tickKitchen();
  // 読み上げ領域は厨房を開いているときだけ更新する。受付端末でも書き換えると、
  // お客様に向いた画面で厨房の件数がずっと読み上げられ続ける。
  if(document.body.dataset.tab === 'kitchen'){
    $('live').textContent = `未処理 ${list.length}件。残り `
      + FLAVORS.map(f=>`${f.short || f.label} ${remainingOf(f.key)}${f.unit}`).join('、');
  }
}

/* 立てかけた画面は誰も送れないので、下にはみ出した伝票は永遠に見られない。
   入り切らなかった枚数を、画面の下に 1 行で必ず出す。
   何枚入るかは端末の高さと列数で決まるため、描いたあとに測って決める。

   下の 1 行は注文が 1 件でもあれば常に出す（「控えはありません」も出す）。
   あるときだけ出すと一覧の高さが変わり、測り直しが要る形になる。 */
/* 呼び出し表示に札が入り切っているか。立てかけた画面は誰も送れないので、
   見切れていること自体を文字で出す（厨房の「ほか N 件」と同じ考え方）。 */
function fitCall(total){
  const grid = $('call-grid'), more = $('call-more');
  if(!grid || !more) return;
  if(document.body.dataset.tab !== 'call' || total === 0){ more.hidden = true; return; }
  const nums = Array.from(grid.querySelectorAll('.call-num'));
  const room = grid.getBoundingClientRect().bottom;
  let over = 0;
  for(const el of nums){ if(el.getBoundingClientRect().bottom > room + 2) over++; }
  more.hidden = over === 0;
  if(over) more.textContent = `ほか ${over}件 お呼び出し中`;
}

function fitBoard(){
  const grid = $('kitchen-list'), foot = $('kitchen-more');
  if(!grid || !foot) return;
  const cards = Array.from(grid.querySelectorAll('.kds-ticket'));
  cards.forEach(el => el.removeAttribute('data-over'));   // 測る前に必ず戻す
  foot.classList.toggle('hidden', cards.length === 0);
  const base = grid.getBoundingClientRect().top;
  // 横向きの 1 画面組みでは一覧自身の高さが上限になる。縦向きでは一覧が
  // 伸びて画面の下へ出ていくので、画面の下端のほうが上限になる。低いほうを採る。
  const room = Math.min(grid.clientHeight, innerHeight - base - 16);
  // 厨房を開いていない端末では高さが測れない（display:none で 0 になる）。
  // そのときは 1 枚も隠さず、開いた時点で測り直す（switchTab から呼ぶ）。
  if(document.body.dataset.tab !== 'kitchen' || room < 80){
    foot.textContent = '';
    return;
  }
  let over = 0;
  // 先頭＝「次に用意する」1 枚は、はみ出していても必ず残す。
  // 伝票が 1 枚も出ない板は、ただの黒い画面になる。
  for(let i = 1; i < cards.length; i++){
    // 2px は端末ごとの端数。1px の差で 1 枚落とすほうが害が大きい。
    if(cards[i].getBoundingClientRect().bottom - base <= room + 2) continue;
    over = cards.length - i;
    for(let j = i; j < cards.length; j++) cards[j].dataset.over = 'true';
    break;
  }
  foot.innerHTML = over > 0
    ? `<b>${over}</b>件 このあとに控えています（上の焼き待ちの数には入っています）`
    : 'このあとに控えている注文はありません';
}

/* 毎秒ここだけを書き換える。1 秒ごとに全体を描き直すと
   スクロール位置とボタンの押下状態が飛んで、かえって使えなくなる。 */
function tickKitchen(){
  let oldest = -1;
  document.querySelectorAll('.kds-ticket[data-ms]').forEach(el=>{
    const ms = Number(el.dataset.ms);
    if(!ms) return;
    const sec = elapsedSec(ms);
    if(sec > oldest) oldest = sec;
    const t = el.querySelector('.kds-timer');
    if(t) t.textContent = mmss(sec);
    const age = ageOf(sec);
    if(el.dataset.age !== age) el.dataset.age = age;
  });
  const el = $('kds-oldest');
  if(el) el.textContent = oldest >= 0 ? mmss(oldest) : '—';
}
setInterval(()=>{ tickKitchen(); tickReady(); tickCall(); }, 1000);
// 立てかけた端末でも、向きが変われば入る枚数は変わる。描き直さず測り直すだけ。
addEventListener('resize', fitBoard);

/* ---------- 受渡 ----------
   お渡し口に置く端末。厨房と同じ性格の画面なので、同じ地・同じ寸法で組む。

   ここが代金を受け取る場所にもなった。番号札を使わない注文は厨房を通らず、
   受付から直接ここへ来て、品物と代金の両方をここで済ませる。
   だから 1 枚のカードに「いくら受け取るか」と「押すところ」を必ず出す。 */

/* 明細は「絵 × 個数」。受渡口と支払い口は番号を照合して品物を取る場所なので、
   商品名を読ませるより、絵と数を見せるほうが速く間違いも少ない。
   絵には alt を入れて、読み上げでは商品名が読まれるようにしておく。
   商品の絵は透過なので、この画面の暗い地でもそのまま乗る。 */
function opsLines(o){
  return `<ul class="ops-lines">` + (o.items||[]).map(i=>
    `<li>
       <span class="ops-mark"><img src="${MARK[i.flavor]||''}" alt="${label(i.flavor)}"></span>
       <span class="ops-x" aria-hidden="true">×</span>
       <span class="ops-qty">${i.quantity}</span>
       <span class="ops-name">${unit(i.flavor)}</span>
     </li>`).join('') + `</ul>`;
}

/* 焼き上がったカップを 1 つずつ受け取る行。
   注文は普通それ自体が分割して焼き上がる（プレートは 3 枚しかなく、
   2 つの味を同時には焼けない）。注文を塊として「用意できた」だけで扱うと、
   半分だけ出来ている注文が、出来ていない注文と見分けられない。 */
function fillRows(o){
  return `<div class="ops-fill">` + (o.items||[]).map(i=>{
    // やめたぶんを引いた数で数える。「3 つのうち 1 つは大丈夫です」と
    // 言われたあとは、2 つそろえば用意できたことになる。
    const want = wantOf(o, i.flavor);
    const off  = voidedOf(o, i.flavor);
    const got  = madeOf(o, i.flavor);
    return `<div class="ops-fill-row" data-done="${got >= want}">
      <span class="ops-mark"><img src="${MARK[i.flavor]||''}" alt="${label(i.flavor)}"></span>
      <span class="ops-fill-n"><b>${got}</b><small>/${want}${off ? ` <i>(${off}やめた)</i>` : ''}</small></span>
      <button type="button" class="ops-fill-minus" data-act="unmade" data-id="${o.id}"
              data-flavor="${i.flavor}" ${got <= 0 ? 'disabled' : ''}
              aria-label="${label(i.flavor)} を 1 減らす">−</button>
      <button type="button" class="ops-fill-plus" data-act="made" data-id="${o.id}"
              data-flavor="${i.flavor}" ${got >= want ? 'disabled' : ''}
              aria-label="${label(i.flavor)} を 1 受け取った">＋1</button>
    </div>`;
  }).join('') + `</div>`;
}

/* 一覧を描き替えても、手元の位置を動かさない。
   innerHTML を差し替えるとその要素の scrollTop は 0 に戻り、フォーカスも失われる。
   この 2 画面は別の端末の操作でも描き替わるため、混んでいる時ほど
   自分は何も触っていないのに一覧が先頭へ飛んでいた。
   時計の更新については tickReady が既に全体描き直しを避けている。同じ理由。 */
function paintList(el, html){
  if(!el) return;
  const top = el.scrollTop;
  const a   = document.activeElement;
  // 押していたボタンは「操作の種類 + 注文」で見分ける。消えていれば戻さない
  // （渡し終えた注文に勝手にフォーカスを移さないため）。
  const keep = (a && el.contains(a) && a.dataset)
    ? { act:a.dataset.act||'', id:a.dataset.id||'' } : null;
  el.innerHTML = html;
  el.scrollTop = top;
  if(!keep) return;
  const back = Array.from(el.querySelectorAll('button[data-act]')).find(
    b => (b.dataset.act||'') === keep.act && (b.dataset.id||'') === keep.id);
  if(back) back.focus();
}

/* ---------- 受渡 2 面目：届いた分を配る ----------
   厨房は注文ごとではなく板ごと持ってくる（ゆず 12・チョコ 6 のように）。
   1 カップずつ押していると、混んだときに押す回数そのものが行列の律速になり、
   実際、当日いちばん待たせた時間帯は焼く速さではなく処理の順番で伸びていた。

   味ごとの総数を受け取り、受付順に焼き待ちの注文へ割り当てる。
   割り当ての規則は lib/pure.js の planDeal が唯一の正（Node からも試せる）。 */
/* 手元にある分（作り置き＋厨房から届いた分）。
   営業開始の前に焼いておく運用があるので、受渡はこれを持ち続ける必要がある。
   全端末で共有したいので config/onhand に置く。ルールがまだ公開されていない
   DB では書き込みが拒否されるので、その端末の中だけで数え続ける（止めない）。 */
let onhand = {};
let onhandLocal = null;        // ルール未公開のときの逃げ道
const ONHAND_KEY = 'onhand';

function readLocalOnhand(){
  try{ return JSON.parse(localStorage.getItem(ONHAND_KEY) || '{}') || {}; }catch(e){ return {}; }
}
function writeLocalOnhand(v){
  try{ localStorage.setItem(ONHAND_KEY, JSON.stringify(v)); }catch(e){}
}
/* いま手元に何カップあるか。共有できていればその値、できていなければ端末の値。 */
function onhandMap(){
  const src = onhandLocal || onhand;
  const out = {};
  FLAVORS.forEach(f=>{ out[f.key] = Math.max(0, Math.floor(Number(src[f.key]) || 0)); });
  return out;
}

/* 手元の数を増減する。別の端末も触るのでトランザクションで足し引きする
   （読んでから書くと、同時に押したぶんが片方消える）。 */
async function bumpOnhand(key, delta){
  if(onhandLocal){
    onhandLocal[key] = Math.max(0, Math.min(9999, (onhandLocal[key] || 0) + delta));
    writeLocalOnhand(onhandLocal); renderDeal(); return;
  }
  try{
    await authReady;
    await tracked(runTransaction(ref(db,'config/onhand/'+key),
      cur => Math.max(0, Math.min(9999, (Number(cur) || 0) + delta))));
  }catch(e){
    // ルールがまだ公開されていない DB。その端末の中だけで数え続ける。
    console.warn('手元の数を共有できません。この端末の中だけで数えます:', e);
    onhandLocal = { ...onhandMap() };
    onhandLocal[key] = Math.max(0, Math.min(9999, (onhandLocal[key] || 0) + delta));
    writeLocalOnhand(onhandLocal);
    renderDeal();
  }
}

function renderDeal(){
  const rowsEl = $('deal-rows'); if(!rowsEl) return;
  const need = dealDemand(orders);
  const have = onhandMap();
  const plan = planDeal(orders, have);          // 手元から、焼き待ちへ自動で振り分ける

  rowsEl.innerHTML = FLAVORS.map(f=>{
    const n = have[f.key] || 0;
    const want = need[f.key] || 0;
    return `
    <div class="deal-row">
      <span class="deal-mark"><img src="${MARK[f.key]||''}" alt=""></span>
      <span class="deal-name">${shortLabel(f.key)}
        <span class="deal-need">焼き待ち ${want}${f.unit}</span></span>
      <button type="button" class="deal-step" data-act="deal-step" data-key="${f.key}" data-step="-1"
              aria-label="${f.label} の手元を 1 減らす" ${n <= 0 ? 'disabled' : ''}>−</button>
      <span class="deal-n" data-zero="${n === 0}" role="status"
            aria-label="${f.label} 手元に ${n}${f.unit}">${n}</span>
      <button type="button" class="deal-step" data-act="deal-step" data-key="${f.key}" data-step="1"
              aria-label="${f.label} の手元を 1 増やす">＋1</button>
      <button type="button" class="deal-step deal-step5" data-act="deal-step" data-key="${f.key}" data-step="5"
              aria-label="${f.label} の手元を 5 増やす">＋5</button>
    </div>`;
  }).join('');

  const note = $('deal-note');
  if(note) note.hidden = !onhandLocal;

  const planEl = $('deal-plan');
  planEl.innerHTML = plan.rows.map(r=>{
    const what = Object.entries(r.add)
      .map(([k,v])=>`${shortLabel(k)} ${v}${unit(k)}`).join(' ／ ');
    return `
    <div class="deal-bundle" data-done="${r.done}">
      <span class="deal-bnum">${r.number || ('受付' + r.seq)}</span>
      <span class="deal-badd">${what}</span>
      ${r.done ? '<span class="deal-bdone">お渡し待ちへ</span>' : ''}
    </div>`;
  }).join('')
    + (Object.keys(plan.left).length
        ? `<p class="deal-left">配ったあと手元に残ります：`
          + Object.entries(plan.left).map(([k,v])=>`${shortLabel(k)} ${v}${unit(k)}`).join('／')
          + `</p>` : '');

  const empty = $('deal-empty');
  if(empty) empty.classList.toggle('hidden',
    Object.values(need).some(n=>n > 0) || plan.rows.length > 0);

  const go = $('deal-go');
  if(go){
    const cups = plan.rows.reduce((s,r)=>s+r.cups, 0);
    go.disabled = plan.rows.length === 0;
    go.textContent = cups === 0 ? '配れる注文がありません'
      : `手元から ${cups}カップを ${plan.rows.length}件に配る`;
  }
}

/* 1 件ぶんの割り当て。足す数で書く（絶対値で書くと、別の端末が
   先に数えていた分を消してしまう）。そろえば受渡待ちにして呼び出しも始める。 */
async function dealOne(id, add){
  let ng = null;
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null;
      if(cur === null){ ng = '注文が見つかりません'; return; }
      if(cur.status !== 'pending'){ ng = 'この注文はもう焼き待ちではありません'; return; }
      const items = cur.items || [];
      const made = { ...(cur.made || {}) };
      for(const [k, v] of Object.entries(add)){
        const want = (items.find(i=>i.flavor === k) || {}).quantity || 0;
        made[k] = Math.max(0, Math.min(want, (Number(made[k]) || 0) + v));
      }
      cur.made = made;
      if(items.every(i => (Number(made[i.flavor]) || 0) >= (i.quantity || 0))){
        cur.status = 'ready';
        cur.calledAt = Date.now();
        cur.calls = 1;
      }
      cur.updatedMs = Date.now();
      return cur;
    }));
    if(ng || !tx.committed) return { ok:false, why: ng || '記録できませんでした' };
    return { ok:true };
  }catch(e){
    console.error(e);
    return { ok:false, why: writeHint(e, '記録できませんでした') };
  }
}

async function applyDeal(){
  const plan = planDeal(orders, onhandMap());
  if(!plan.rows.length) return;
  const go = $('deal-go'); if(go) go.disabled = true;

  // 取り消しのために、押す前の姿を控える。束でまとめて動かすので、
  // 1 件ずつ戻すのは現実的ではない。
  const before = plan.rows.map(r=>{
    const o = orders.find(x=>x.id === r.id) || {};
    return { id: r.id, made: { ...(o.made || {}) }, status: o.status || 'pending' };
  });

  let okN = 0, cups = 0, ready = 0, ngMsg = '';
  const used = {};
  for(const r of plan.rows){
    knownReady.add(r.id);        // 自分の操作では受渡の着信音を鳴らさない
    const res = await dealOne(r.id, r.add);
    if(res.ok){
      okN++; cups += r.cups; if(r.done) ready++;
      for(const [k,v] of Object.entries(r.add)) used[k] = (used[k] || 0) + v;
    }else ngMsg = res.why;
  }
  // 配れたぶんだけ手元から引く（失敗した注文のぶんは手元に残す）。
  for(const [k,v] of Object.entries(used)) await bumpOnhand(k, -v);
  renderDeal();

  if(!okN){ toast(ngMsg || '配れませんでした。もう一度お試しください。'); return; }
  if(soundOn()) audio.confirm();
  const msg = `${cups}カップを ${okN}件に配りました`
            + (ready ? `（お渡し待ち ${ready}件）` : '')
            + (okN < plan.rows.length ? `／${plan.rows.length - okN}件は配れませんでした` : '');
  toast(msg, 'ok', ()=>undoDeal(before, used), 9000);
}

/* 配ったのを取り消す。押す前の made と状態に戻し、カップは手元へ返す。 */
async function undoDeal(before, used){
  for(const b of before){
    try{
      await authReady;
      await tracked(runTransaction(ref(db,'orders/'+b.id), cur=>{
        if(cur === null) return;
        cur.made = { ...b.made };
        if(cur.status === 'ready' && b.status === 'pending') cur.status = 'pending';
        cur.updatedMs = Date.now();
        return cur;
      }));
    }catch(e){ console.error(e); }
  }
  for(const [k,v] of Object.entries(used || {})) await bumpOnhand(k, v);
  toast('配ったのを戻しました（カップは手元に戻しました）', 'ok');
}

/* ---------- 横に送って面を替える ----------
   受渡と支払い口は 1 台で何役も持つ。1 画面に全部出すと字が小さくなり、
   立って 1m 離れて使えなくなる。面を分けて指で送り、下の札でも移れるようにする
   （スワイプだけだと、誰も送れることに気づかない）。 */
function initDeck(deckId, dotsId){
  const deck = $(deckId), dots = $(dotsId);
  if(!deck || !dots) return;
  let t = 0;
  const paint = ()=>{
    const i = Math.round(deck.scrollLeft / Math.max(1, deck.clientWidth));
    dots.querySelectorAll('button[data-page]').forEach(b=>{
      if(Number(b.dataset.page) === i) b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    });
  };
  // 指を離したあとに決める。送っている最中に札が点滅すると、酔う。
  deck.addEventListener('scroll', ()=>{ clearTimeout(t); t = setTimeout(paint, 90); },
                        { passive:true });
  dots.addEventListener('click', e=>{
    const b = e.target.closest('button[data-page]');
    if(!b) return;
    deck.scrollTo({ left: deck.clientWidth * Number(b.dataset.page), behavior:'smooth' });
  });
  paint();
}

/* 受渡に出す注文の絞り込み。既定は「すべて」。
   受渡口は「いま渡す 1 件」を探す場所であると同時に、
   いま店が何件抱えているかを見る場所でもある。 */
let readyFilter = 'all';
$('ready-filter')?.addEventListener('click', e=>{
  const b = e.target.closest('button[data-rf]');
  if(!b) return;
  readyFilter = b.dataset.rf;
  renderReady();
});
// お渡し待ち → ご用意中 → お渡し済み。押す対象が必ず上に来る。
const READY_RANK = { ready:0, pending:1, completed:2 };
// 絞り込みで 1 件も無いときは文言を差し替える。既定の文は作り直せるよう覚えておく。
const READY_EMPTY_HTML = $('ready-empty')?.innerHTML || '';

function renderReady(){
  // 受付で確定した時点から出す。厨房が用意し終えるまで受渡口に何も出ないと、
  // いま何件来ているのかが分からず、人の配りどころも釣銭の用意も決められない。
  const all = orders.filter(o=>o.status!=='cancelled');
  const count = { all: all.length, ready:0, pending:0, completed:0 };
  for(const o of all) if(o.status in count) count[o.status]++;

  // 約束に遅れている注文を、状態より先に上へ出す。
  // 待たせている相手から片づけるのが、行列のなかでいちばん効く。
  const nowMs = Date.now();
  // 後回しにした人は、期限まで並びの後ろへ送る（来たらいつでも渡せる）。
  const heldAt = o => heldOf(o, nowMs) ? 1 : 0;
  const lateOf = o => (!heldOf(o, nowMs) && o.status !== 'completed'
                       && o.pickupMs && o.pickupMs < nowMs) ? 0 : 1;
  const list = all
    .filter(o => readyFilter === 'all' || o.status === readyFilter)
    .sort((a,b)=> (heldAt(a) - heldAt(b))
               || (lateOf(a) - lateOf(b))
               || (READY_RANK[a.status] - READY_RANK[b.status]) || byOrder(a,b));

  // 未収＝まだ代金をもらっていない注文。中止以外のすべてを数える。
  const unpaid = all.filter(o=>!o.paid);

  paintList($('ready-list'), list.map(o=>{
    const sec  = elapsedSec(o.createdMs);
    const due  = !o.paid;
    const prep = o.status === 'pending';
    const done = o.status === 'completed';
    // 渡したのに未払い＝取りはぐれ。支払い口と同じく赤く出し、ここでも回収できるようにする。
    const lost = done && due;
    // 約束した時刻を過ぎた注文。お客様は時刻どおりに来るので、
    // ここが分かっていないと「お待たせしました」の相手すら分からない。
    const late = !done && !!o.pickupMs && o.pickupMs < Date.now();
    // 一部だけやめた注文があるので、金額は必ず「実際にいただく額」で出す。
    const amount = yen(netPriceOf(o));
    // 時計の色は「まだ渡していない注文」にだけ意味がある。
    const age = done ? 'ok' : ageOf(sec);
    const state = prep ? 'ご用意中' : done ? (lost ? 'お渡し済み・未払い' : 'お渡し済み') : '';

    // 押すところはカード 1 枚につき 1 つ。状態ごとに「普通の道」だけを大きく出す。
    const actions = prep
      // 厨房は手が汚れていて画面を押せない（衛生上、押させない）。
      // 焼き上がった品物を受け取ったこちらで打つ。まとめて届いたときのために
      // 「ぜんぶ」を主にし、1 カップずつ届くときは上の行で数える。
      // そろった時点で呼び出しも始まる（fillCup / fillAll が calledAt を書く）。
      ? `<button type="button" class="ops-do" data-act="madeall" data-id="${o.id}"
                 aria-label="${numOf(o)} はぜんぶ用意できた">ぜんぶ用意できた</button>
         <div class="ops-row">
           <button type="button" class="ops-sub" data-act="voidpart" data-id="${o.id}"
                   aria-label="${numOf(o)} の一部をやめる">一部やめる</button>
         </div>`
      : done
        ? `${lost ? `<button type="button" class="ops-do" data-kind="cash" data-act="takepaid" data-id="${o.id}" data-num="${numOf(o)}"
                   aria-label="${numOf(o)} の ${amount}円 を受け取る">${amount}円 受け取る</button>` : ''}
           <div class="ops-row">
             <button type="button" class="ops-sub" data-act="move" data-id="${o.id}"
                     data-status="completed" data-to="ready" data-num="${numOf(o)}"
                     aria-label="${numOf(o)} をお渡し待ちに戻す">お渡し待ちに戻す</button>
           </div>`
        : due
          // 未払いの注文は「受け取って渡す」が普通の道。1 タップで済ませる。
          // 以前はどちらも「渡した」から確認ダイアログを通していたが、
          // 行列のなかで毎回 2 タップになり、急ぐと「そのまま渡す」を押してしまう。
          ? `<button type="button" class="ops-do" data-kind="cash" data-act="handpaid" data-id="${o.id}"
                     aria-label="${numOf(o)} の代金 ${amount}円 を受け取って渡す">
               ${amount}円 受け取って渡した</button>
             <div class="ops-row">
               ${o.number ? `<button type="button" class="ops-sub" data-act="flash" data-id="${o.id}"
                       aria-label="${numOf(o)} をもう一度呼ぶ">呼ぶ</button>` : ''}
               <button type="button" class="ops-sub" data-act="done" data-id="${o.id}"
                       aria-label="${numOf(o)} を代金を受け取らずに渡す">未払いのまま渡す</button>
             </div>
             <div class="ops-row">
               <button type="button" class="ops-sub" data-act="voidpart" data-id="${o.id}"
                       aria-label="${numOf(o)} の一部をやめる">一部やめる</button>
             </div>`
          : `<button type="button" class="ops-do" data-act="done" data-id="${o.id}"
                     aria-label="${numOf(o)} を渡した">渡した</button>
             <div class="ops-row">
               <button type="button" class="ops-sub" data-act="voidpart" data-id="${o.id}"
                       aria-label="${numOf(o)} の一部をやめる">一部やめる</button>
             </div>
             ${o.number ? `<div class="ops-row">
               <button type="button" class="ops-sub" data-act="flash" data-id="${o.id}"
                       aria-label="${numOf(o)} をもう一度呼ぶ">呼ぶ</button>
             </div>` : ''}`;

    return `
    <article class="ops-card" id="rc-${o.id}" data-state="${o.status}" data-lost="${lost}"
             data-late="${late}"
             data-ms="${o.createdMs||0}" data-age="${age}" data-wait="${!done}"
             aria-label="${numOf(o)}${state ? ' ' + state : ''}${due ? ` 未収 ${amount}円` : ''}">
      <div class="ops-head">
        <span class="ops-num">${numOf(o)}</span>
        ${done
          ? `<span class="ops-state" data-kind="done">${state}</span>`
          : `<span class="ops-timer">${o.createdMs ? mmss(sec) : '—'}</span>`}
      </div>
      ${heldOf(o) ? `<span class="ops-state" data-kind="held">後回し　${hhmm(o.holdUntil)} まで</span>` : ''}
      ${!prep && !done && o.pickupMs
        ? `<span class="ops-when" data-late="${late}">${hhmm(o.pickupMs)} お越しの予定${
            late ? `（${Math.floor((Date.now() - o.pickupMs)/60000)}分 過ぎています）` : ''}</span>` : ''}
      ${prep ? `<span class="ops-state" data-kind="prep" data-late="${late}">ご用意中${
        o.pickupMs ? ` ・ ${hhmm(o.pickupMs)} お渡し予定${
          late ? `（${Math.floor((Date.now() - o.pickupMs)/60000)}分 遅れ）` : ''}` : ''}</span>` : ''}
      ${prep || (o.status === 'ready' && !done) ? fillRows(o) : opsLines(o)}
      ${due ? `<p class="ops-amount">${amount}<small>円</small></p>` : ''}
      ${actions}
    </article>`;
  }).join(''));

  renderDeal();   // 2 面目も同じ注文を見ているので一緒に描き直す

  // 絞り込みの札。件数も出す（押さなくても全体の内訳が読める）。
  document.querySelectorAll('#ready-filter [data-rf]').forEach(b=>{
    b.setAttribute('aria-pressed', String(b.dataset.rf === readyFilter));
    const n = $('rf-' + b.dataset.rf);
    if(n) n.textContent = count[b.dataset.rf] ?? 0;
  });

  const empty = $('ready-empty');
  if(empty){
    empty.classList.toggle('hidden', list.length > 0);
    // 「注文が無い」と「絞り込みに当てはまらない」は別の話。取り違えると、
    // 絞ったままの画面を見て「注文が来ていない」と読んでしまう。
    const html = count.all === 0
      ? READY_EMPTY_HTML
      : '<b>この絞り込みに当てはまる注文はありません</b>「すべて」を押すと、この回の注文がすべて出ます。';
    if(empty.innerHTML !== html) empty.innerHTML = html;
  }
  renderRecall();
  $('ready-count').textContent = count.ready;
  $('ready-prep').textContent  = count.pending;
  // 約束に遅れている件数。0 のときは出さない（普段は無い札）。
  const lateN = all.filter(o => lateOf(o) === 0).length;
  const lateBadge = $('ready-late');
  if(lateBadge){
    lateBadge.hidden = lateN === 0;
    $('ready-late-n').textContent = lateN;
  }
  // 未収は他の端末の操作で増減する。0 のときは出さない。
  const dueBadge = $('ready-due');
  if(dueBadge){
    dueBadge.hidden = unpaid.length === 0;
    $('ready-unpaid').textContent = unpaid.length;
  }
  tickReady();
}

/* 呼び出しの状況。お客様側の表示に何が出ているかを、受渡口から確かめる面。
   取りに来ない札は、ここから呼び直す。 */
function renderRecall(){
  const list = $('recall-list');
  if(!list) return;
  const now = Date.now();
  // 呼んでから長い順。いちばん戻ってきていない人を先頭に置く。
  // 何度呼んでも来ていない札を先頭に寄せる。誰を後回しにすべきかを
  // 人が全部の札から探すのではなく、画面のほうから出す。
  // 「何分後にするか」はお客様との会話でしか決まらないので、そこは人が押す。
  const CALLS_MANY = 3;
  const many = o => !heldOf(o, now) && (o.calls || 0) >= CALLS_MANY;
  const waiting = orders.filter(o => o.status === 'ready' && o.number)
                        .sort((a,b)=> (heldOf(a, now) ? 1 : 0) - (heldOf(b, now) ? 1 : 0)
                                   || (many(b) ? 1 : 0) - (many(a) ? 1 : 0)
                                   || (a.calledAt||0) - (b.calledAt||0));
  paintList(list, waiting.map(o=>{
    const held = heldOf(o, now);
    const on  = !held && !!o.calledAt && now - o.calledAt < CALL_HOLD_MS;
    const min = o.calledAt ? Math.floor((now - o.calledAt) / 60000) : null;
    const late = !held && !!o.pickupMs && o.pickupMs < now;
    const calls = o.calls || 0;
    return `
    <article class="ops-card" data-call="${on}" data-late="${late}" data-held="${held}"
             data-many="${many(o)}">
      <div class="ops-head">
        <span class="ops-num">${numOf(o)}</span>
        <span class="ops-timer">${o.createdMs ? mmss(elapsedSec(o.createdMs)) : '—'}</span>
      </div>
      ${o.pickupMs ? `<span class="ops-when" data-late="${late}">${hhmm(o.pickupMs)} お越しの予定</span>` : ''}
      ${many(o) ? `<p class="ops-alert ops-many"><b>${calls}回</b> 呼んでも来ていません</p>` : ''}
      <p class="ops-hint">${held
        ? `<b class="ops-held">後回し　${hhmm(o.holdUntil)} まで</b>`
        : on ? 'いま呼び出し表示に出ています'
        : min === null ? 'まだ呼んでいません'
        : min < 1 ? `さきほど呼びました${calls > 1 ? `（${calls}回目）` : ''}`
                  : `${min}分前に呼びました${calls > 1 ? `（${calls}回目）` : ''}`}</p>
      ${held
        ? `<button type="button" class="ops-do" data-act="unhold" data-id="${o.id}"
                   aria-label="${numOf(o)} の後回しをやめて、いま呼ぶ">後回しをやめて呼ぶ</button>`
        : `<button type="button" class="ops-do" data-act="flash" data-id="${o.id}"
                   aria-label="${numOf(o)} をもう一度呼ぶ">もう一度呼ぶ</button>
           <p class="ops-hold-head">来なかったときは、後回しにできます</p>
           <div class="ops-row">
             ${[5,10,20].map(m=>`
             <button type="button" class="ops-sub" data-act="hold" data-id="${o.id}" data-min="${m}"
                     aria-label="${numOf(o)} を ${m}分 後回しにする">${m}分</button>`).join('')}
           </div>`}
    </article>`;
  }).join(''));
  $('recall-list').classList.toggle('hidden', waiting.length === 0);
  $('recall-empty').classList.toggle('hidden', waiting.length > 0);
  const manyN = waiting.filter(many).length;
  const head = $('recall-head');
  if(head && manyN){
    head.innerHTML = `お呼び出し中 ${waiting.length}件`
      + ` ／ <b class="ops-many-n">${manyN}件</b> は ${CALLS_MANY}回以上 呼んでも来ていません`;
    return;
  }
  if(head) head.textContent = waiting.length
    ? `お呼び出し中 ${waiting.length}件（呼んでから長い順）`
    : '呼び出しの状況';
}

/* 毎秒ここだけを書き換える。全体を描き直すとスクロール位置が飛ぶ。 */
function tickReady(){
  let oldest = -1;
  document.querySelectorAll('#ready-list .ops-card[data-ms][data-wait="true"]').forEach(el=>{
    const ms = Number(el.dataset.ms);
    if(!ms) return;
    const sec = elapsedSec(ms);
    if(sec > oldest) oldest = sec;
    const t = el.querySelector('.ops-timer');
    if(t) t.textContent = mmss(sec);
    const age = ageOf(sec);
    if(el.dataset.age !== age) el.dataset.age = age;
  });
  const el = $('ready-oldest');
  if(el) el.textContent = oldest >= 0 ? mmss(oldest) : '—';
}

/* ---------- 受渡の着信 ----------
   厨房の着信音 (ping) は未処理の注文だけを見る。番号札を使わない注文は厨房を
   通らず受渡待ちで生まれるので、そのままだと受渡口には何の合図も出ない。
   置きっぱなしの端末で、お客様が来ているのに誰も気づかない、が起きる。

   受渡待ちは、この端末が「用意できた」を押しても増える。自分の操作で鳴っても
   合図にならないので、押した注文は knownReady に先に入れて鳴らさない
   （下の 'ready' の打ち返しがそれを行う）。

   鳴らすのは受渡の画面を開いている端末だけ。全端末で鳴らすと重なって
   何も聞き取れなくなる（呼び出し表示と同じ理由）。 */
// 起動直後の一括読み込みで、既にある受渡待ちを全部鳴らしてしまわないよう一度見送る。
// 受渡の着信音と、呼び出し表示のチャイムが共有する。
let announceReady = false;
setTimeout(()=>{ announceReady = true; }, 3000);

let knownReady = new Set();
function arrived(){
  const ready = orders.filter(o => o.status === 'ready');
  const ids = new Set(ready.map(o => o.id));
  if(announceReady && document.body.dataset.tab === 'ready'){
    for(const id of ids) if(!knownReady.has(id)){ if(soundOn()) audio.newOrder(); break; }
  }
  knownReady = ids;
}

/* ---------- 自動のお呼び出し ----------
   受渡が「用意できた」を押すと自動で呼び出しになる（changeStatus が calledAt を
   書く）。ここはその音を鳴らす側で、呼び出し表示を開いている端末だけが鳴らす。
   全端末で鳴らすと重なって何も聞き取れなくなる。

   読み上げは使わない。番号はチャイムと画面の大きな数字で伝える。 */
const spoken = new Set();

function announce(){
  if(document.body.dataset.tab !== 'call') return;
  const ready = orders.filter(o => o.status === 'ready' && o.number);
  const fresh = ready.filter(o => !spoken.has(o.id));
  for(const o of ready) spoken.add(o.id);
  // 渡し終わった注文は忘れる（同じ札が回ってきたらまた呼ぶ）。
  const liveIds = new Set(ready.map(o => o.id));
  for(const id of [...spoken]) if(!liveIds.has(id)) spoken.delete(id);
  if(!announceReady || !fresh.length) return;

  if(soundOn()) audio.call();
}

/* ---------- 呼び出し表示 ---------- */
function renderCall(){
  // 札を持っていないお客様は呼びようがない（札なしの注文は受渡口で直接渡す）。
  // 番号が空のまま並べると、何も書かれていない枠だけが増えて数が読めなくなる。
  // 後回しにした人は出さない。呼んでも来ない番号で画面が埋まると、
  // いま来ている人の番号が読めなくなる（期限が過ぎれば自動で戻る）。
  const ready = orders.filter(o=>o.status === 'ready' && o.number && !heldOf(o))
                      .sort(byOrder);
  $('call-grid').innerHTML = ready.map(o=>
    `<span class="call-num" data-called-at="${o.calledAt||0}">${o.number}</span>`).join('');
  $('call-grid').classList.toggle('hidden', ready.length === 0);
  $('call-empty').classList.toggle('hidden', ready.length > 0);
  $('call-pending').textContent = orders.filter(o=>o.status === 'pending').length;
  // 入り切らない札があっても、お客様はこの画面を触れないので自分で送れない。
  // 何番まで出ているかを文字で添える（厨房の「ほか N 件」と同じ考え方）。
  fitCall(ready.length);
  tickCall();
}

/* 強調は時間で消える。消すためだけに全体を描き直さない。 */
function tickCall(){
  const now = Date.now();
  document.querySelectorAll('.call-num[data-called-at]').forEach(el=>{
    const at = Number(el.dataset.calledAt) || 0;
    const on = at > 0 && now - at < CALL_HOLD_MS;
    if((el.dataset.on === 'true') !== on) el.dataset.on = String(on);
  });
  recall(now);
}

/* ---------- 呼び出しの自動再掲 ----------
   一度呼んだだけでは、その 40 秒を見ていなかった人には届かない。
   番号札を持ったまま戻らない注文を、5 分おきにもう一度強調して鳴らす。

   書くのは呼び出し表示を開いている端末だけ。全端末が書くと、
   同じ注文に何台も書き込んで鳴り方が重なる（受渡の着信音と同じ理由）。
   30 分を過ぎた注文は諦める。その頃には呼ぶより探しに行くほうが早い。 */
const RECALL_MS   = 5 * 60000;
const RECALL_STOP = 30 * 60000;
let recalled = new Map();          // id → この端末が最後に書いた時刻
function recall(now){
  if(document.body.dataset.tab !== 'call' || !announceReady) return;
  for(const o of orders){
    if(o.status !== 'ready' || !o.number || !o.calledAt) continue;
    if(heldOf(o, now)) continue;        // 後回しの人は呼び直さない
    if(now - o.calledAt < RECALL_MS) continue;
    // 打ち切りは「呼んでから」で測る。受付からの経過で測ると、焼きに時間が
    // かかった注文ほど早く打ち切られ、いちばん待たせた相手を呼ばなくなる。
    if(now - o.calledAt > RECALL_STOP) continue;
    // 自分の書き込みが返るまでの間、二重に書かない。
    if(now - (recalled.get(o.id) || 0) < RECALL_MS) continue;
    recalled.set(o.id, now);
    callOrder(o.id);
  }
}

/* ---------- 番号札の状況 ---------- */
function renderTags(){
  const grid = $('tags-grid');
  if(!grid) return;
  const n = tagCount();
  const out = new Set(tagsInUse());
  let html = '';
  for(let t=1; t<=n; t++) html += `<span class="tag-chip" data-out="${out.has(t)}">${t}</span>`;
  grid.innerHTML = html;
  $('tags-count').textContent = `出ている ${out.size}枚 ／ 手元 ${n - out.size}枚（全${n}枚）`;
}

/* ---------- 記録表 ---------- */
const TAG = { pending:['未処理','tag-pending'], ready:['受渡待ち','tag-ready'], completed:['完了','tag-completed'], cancelled:['中止','tag-cancelled'] };
/* 支払い口。未払い＝回収すべきお会計を並べる。
   受渡が済んでいるのに未払いの注文は取りはぐれなので先頭に出す。 */
let payFilter = '';
$('pay-find')?.addEventListener('input', e=>{
  payFilter = (e.target.value || '').replace(/[^0-9]/g,'');
  renderPay();
});
$('pay-find-clear')?.addEventListener('click', ()=>{
  payFilter = ''; if($('pay-find')) $('pay-find').value = ''; renderPay();
});
// 番号で絞る。行列のなかで目で探させない。
const matchFind = o => !payFilter || String(o.tag||'') === payFilter
                       || (o.number||'').includes(payFilter);

function renderPay(){
  const live   = orders.filter(o=>o.status!=='cancelled' && matchFind(o));
  // 未収は「渡したのに未払い」を先頭に寄せる。ここが取りはぐれで、
  // 時間が経つほど回収できなくなるので、行列の後ろに埋めてはいけない。
  const unpaid = live.filter(o=>!o.paid).sort((a,b)=>{
    const ad = a.status==='completed' ? 0 : 1, bd = b.status==='completed' ? 0 : 1;
    return ad - bd || byOrder(a,b);
  });
  // 絞り込み中は全件、通常は直近 20 件。打ち間違いに昼過ぎに気づいても、
  // 番号を打てば必ず出てくるようにしておく。
  const paidAll = live.filter(o=>o.paid).sort((a,b)=>byOrder(b,a));
  const paid = payFilter ? paidAll : paidAll.slice(0, 20);

  // 会計中の注文が支払い済み・中止で消えたら、選択も金額の配信も畳む。
  if(collecting && !unpaid.some(o => o.id === collecting.id)){
    collecting = null;
    chgPaid = 0;
    clearAmount();
  }
  renderChange();

  paintList($('pay-list'), unpaid.map(o=>{
    const handed = o.status==='completed';   // 渡したのに未払い＝取りはぐれ
    const busy   = collecting?.id === o.id;
    const amount = yen(o.price||0);
    return `
    <article class="ops-card" data-busy="${busy}" data-lost="${handed}"
             aria-label="${numOf(o)} ${amount}円${handed ? ' お渡し済み・未払い' : ''}">
      <div class="ops-head">
        <span class="ops-num">${numOf(o)}</span>
        ${busy
          ? '<span class="ops-state" data-kind="busy">会計中</span>'
          : handed
            ? '<span class="ops-state">お渡し済み・未払い</span>'
            : `<span class="ops-timer">${o.createdAt||''}</span>`}
      </div>
      ${opsLines(o)}
      <p class="ops-amount">${amount}<small>円</small></p>
      ${busy ? `
        <p class="ops-hint">お客様側の画面にこの金額を出しています</p>
        <button type="button" class="ops-do" data-kind="cash" data-act="collect-ok" data-id="${o.id}"
                aria-label="${numOf(o)} の ${amount}円 を受け取った${collecting.alsoHandOver ? '。あわせて渡す' : ''}">
          受け取った${collecting.alsoHandOver ? ' → 渡す' : ''}</button>
        <div class="ops-row">
          <button type="button" class="ops-sub" data-act="collect-cancel"
                  aria-label="${numOf(o)} の会計をやめる">戻る</button>
        </div>`
      : `
        <button type="button" class="ops-do" data-kind="cash" data-act="pay" data-id="${o.id}"
                aria-label="${numOf(o)} の ${amount}円 を受け取る">
          ${amount}円 受け取る</button>
        ${o.status==='ready' ? `<div class="ops-row">
          <button type="button" class="ops-sub" data-act="paydone" data-id="${o.id}"
                  aria-label="${numOf(o)} の ${amount}円 を受け取って渡した">受け取って渡した</button>
        </div>` : ''}
        <div class="ops-row">
          <button type="button" class="ops-sub" data-act="later" data-id="${o.id}"
                  aria-label="${numOf(o)} のお越しの時刻を遅らせる">
            お越しを遅らせる${o.pickupMs ? `（いま ${hhmm(o.pickupMs)}）` : ''}</button>
        </div>`}
    </article>`;
  }).join(''));

  $('pay-empty').classList.toggle('hidden', unpaid.length>0);
  $('pay-empty').textContent = payFilter
    ? `${payFilter} 番の未払いはありません。`
    : '未払いの注文はありません。';

  // 上のバーの数字は、集計モジュール (WASM) を通さずここで数える。
  // 支払い口は現金を扱う画面なので、WASM が落ちている間も数字が出ないと困る。
  // 絞り込みの影響を受けないよう、数える対象は絞り込み前の注文にする。
  const all       = orders.filter(o=>o.status!=='cancelled');
  const allUnpaid = all.filter(o=>!o.paid);
  const lost      = allUnpaid.filter(o=>o.status==='completed');
  $('pay-count').textContent = allUnpaid.length;
  $('pay-sum').textContent   = yen(allUnpaid.reduce((n,o)=>n+netPriceOf(o), 0));
  const lw = $('pay-lost-wrap');
  if(lw){
    lw.hidden = lost.length === 0;
    $('pay-lost').textContent = lost.length;
  }

  $('paid-list').innerHTML = paid.map(o=>`
    <div class="ops-paid-row">
      <span class="ops-paid-num">${numOf(o)}</span>
      <span class="ops-paid-yen">${yen(netPriceOf(o))}円</span>
      <button type="button" class="ops-mini" data-act="unpay" data-id="${o.id}" data-num="${numOf(o)}"
              aria-label="${numOf(o)} を未払いに戻す">未払いに戻す</button>
    </div>`).join('');
  $('paid-empty').classList.toggle('hidden', paid.length>0);
  renderRefund();
}

/* ---------- 受け取り時刻を遅らせる ----------
   受付では混み具合から「◯時◯分ごろ」をご案内するが、お客様の都合で
   それより後にしたいことがある。支払い口は必ず会話をする場所なので、ここで直す。
   直した時刻は受渡の「お越しの予定」と遅れ判定にそのまま効く。 */
let latering = null;        // { id, min }

function openLater(id){
  const o = orders.find(x=>x.id===id);
  if(!o){ toast('注文が見つかりません'); return; }
  latering = { id, min: 0 };
  $('later-sub').textContent = `${numOf(o)}（${itemsText(o)}）`;
  renderLater();
  openModal('m-later');
}
function laterPick(min){
  if(!latering) return;
  latering.min = min;
  renderLater();
}
function renderLater(){
  const o = orders.find(x=>x.id===latering?.id);
  if(!o) return;
  // 基準は、いまご案内している時刻。無ければ今から数える。
  const base = o.pickupMs && o.pickupMs > Date.now() ? o.pickupMs : Date.now();
  const to = base + (latering.min || 0) * 60000;
  $('later-rows').innerHTML = [5,10,15,30].map(m=>`
    <button type="button" class="later-step" data-act="later-step" data-min="${m}"
            aria-pressed="${latering.min === m}"
            aria-label="${m}分 遅らせる">＋${m}分</button>`).join('');
  $('later-total').innerHTML = latering.min
    ? `お越しは <b>${hhmm(base)}</b> → <b>${hhmm(to)}</b> ごろ`
    : (o.pickupMs ? `いまのご案内は <b>${hhmm(o.pickupMs)}</b> ごろです`
                  : 'この注文には時刻のご案内がありません');
  $('later-yes').disabled = !latering.min;
}
$('later-no')?.addEventListener('click', ()=>{ latering = null; closeModal(); });
$('later-yes')?.addEventListener('click', async ()=>{
  const v = latering; latering = null; closeModal();
  if(!v || !v.min) return;
  try{
    await authReady;
    let to = 0;
    await tracked(runTransaction(ref(db,'orders/'+v.id), cur=>{
      if(cur === null) return;
      const base = cur.pickupMs && cur.pickupMs > Date.now() ? cur.pickupMs : Date.now();
      to = base + v.min * 60000;
      cur.pickupMs = to;
      cur.updatedMs = Date.now();
      return cur;
    }));
    const o = orders.find(x=>x.id===v.id);
    toast(`${numOf(o)} のお越しを ${hhmm(to)} ごろにしました`, 'ok');
  }catch(e){
    console.error(e);
    toast(writeHint(e, 'お越しの時刻を変えられませんでした'));
  }
});

/* 後回し（保留）。期限までは呼び出しから外し、受渡の並びでも後ろへ送る。
   0 を渡すと解除して、その場で呼び直す。 */
async function setHold(id, min){
  try{
    await authReady;
    await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      if(cur === null) return;
      if(min > 0) cur.holdUntil = Date.now() + min * 60000;
      else { delete cur.holdUntil; cur.calledAt = Date.now(); }  // 解除＝いま呼ぶ
      cur.updatedMs = Date.now();
      return cur;
    }));
    const o = orders.find(x=>x.id===id);
    toast(min > 0
      ? `${numOf(o)} を ${min}分 後回しにしました（来たらいつでも渡せます）`
      : `${numOf(o)} の後回しをやめて、呼び出しました`, 'ok');
  }catch(e){
    console.error(e);
    toast(writeHint(e, '後回しにできませんでした'));
  }
}

/* ---------- 一部だけやめる ----------
   「3 つのうち 1 つは大丈夫です」と言われる場面。注文そのもの（items・price・
   quantity）は記録として変えない。ルールでも不変にしてあるし、あとから
   「元は何を頼んだのか」が消えると、差額の説明ができなくなる。

   受け取らなかったカップ数を voided に置き、金額も焼き待ちもそれを引いた数で見る。
   すでに焼けていたカップは手元（onhand）に戻し、次のお客様に出せるようにする。
   全部やめるときは、この操作ではなく中止を使う。 */
let voiding = null;    // { id, pick: {flavor: n} }

function openVoid(id){
  const o = orders.find(x=>x.id===id);
  if(!o){ toast('注文が見つかりません'); return; }
  voiding = { id, pick: {} };
  $('void-sub').textContent = `${numOf(o)}（${itemsText(o)}）`;
  renderVoid();
  openModal('m-void');
}

function renderVoid(){
  const o = orders.find(x=>x.id===voiding?.id);
  if(!o) return;
  const rows = $('void-rows');
  rows.innerHTML = (o.items||[]).map(i=>{
    const want = wantOf(o, i.flavor);          // いま用意することになっている数
    const n = voiding.pick[i.flavor] || 0;
    return `
    <div class="void-row">
      <img src="${MARK[i.flavor]||''}" alt="">
      <span class="void-name">${label(i.flavor)}<br>
        <small>${want}${unit(i.flavor)}のうち</small></span>
      <button type="button" class="void-step" data-act="void-step" data-key="${i.flavor}" data-step="-1"
              aria-label="${label(i.flavor)} をやめる数を 1 減らす" ${n<=0?'disabled':''}>−</button>
      <span class="void-n">${n}<small>やめる</small></span>
      <button type="button" class="void-step" data-act="void-step" data-key="${i.flavor}" data-step="1"
              aria-label="${label(i.flavor)} をやめる数を 1 増やす" ${n>=want?'disabled':''}>＋</button>
    </div>`;
  }).join('');

  // 残る金額。すでに受け取っているなら、差額は返金になる。
  const off = (o.items||[]).reduce((n,i)=>n + (voiding.pick[i.flavor]||0) * (i.unitPrice||0), 0);
  const now = netPriceOf(o);
  const left = Math.max(0, now - off);
  const all = (o.items||[]).every(i => (voiding.pick[i.flavor]||0) >= wantOf(o, i.flavor));
  $('void-total').innerHTML = off
    ? `お会計は <b>${yen(now)}</b> 円 → <b>${yen(left)}</b> 円`
    : 'やめるカップを選んでください';
  $('void-note').textContent = all && off
    ? 'ぜんぶやめる場合は、この画面ではなく「中止」を使ってください。'
    : (off && o.paid ? `すでに代金をいただいています。${yen(off)}円 をお返ししてください。` : '');
  $('void-yes').disabled = off === 0 || all;
}

$('void-no')?.addEventListener('click', ()=>{ voiding = null; closeModal(); });
$('void-yes')?.addEventListener('click', async ()=>{
  const v = voiding; voiding = null; closeModal();
  if(!v) return;
  await applyVoid(v.id, v.pick);
});

async function applyVoid(id, pick){
  let ng = null, back = {};
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null; back = {};
      if(cur === null){ ng = '注文が見つかりません'; return; }
      if(cur.status === 'cancelled'){ ng = 'この注文は中止されています'; return; }
      const items = cur.items || [];
      const voided = { ...(cur.voided || {}) };
      const made   = { ...(cur.made || {}) };
      for(const [k, n] of Object.entries(pick)){
        if(!(n > 0)) continue;
        const want = (items.find(i=>i.flavor === k) || {}).quantity || 0;
        const already = Math.max(0, Math.min(want, Number(voided[k]) || 0));
        const add = Math.max(0, Math.min(want - already, n));
        if(!add) continue;
        voided[k] = already + add;
        // すでに焼けていたカップは手元に戻す。注文からは外れるが物は残る。
        const got = Math.max(0, Number(made[k]) || 0);
        const keep = Math.max(0, want - voided[k]);
        if(got > keep){ back[k] = (back[k] || 0) + (got - keep); made[k] = keep; }
      }
      if(!Object.keys(voided).length){ ng = 'やめるカップが選ばれていません'; return; }
      cur.voided = voided;
      cur.made = made;
      // 残りがそろっていれば受渡待ちへ（3 つ中 2 つ焼けていれば、もう渡せる）。
      const ok = items.every(i => {
        const w = Math.max(0, (i.quantity||0) - (Number(voided[i.flavor])||0));
        return (Number(made[i.flavor]) || 0) >= w;
      });
      const left = items.reduce((n,i)=> n + Math.max(0,
        (i.quantity||0) - (Number(voided[i.flavor])||0)), 0);
      if(ok && left > 0 && cur.status === 'pending'){
        cur.status = 'ready';
        cur.calledAt = Date.now();
        cur.calls = 1;
      }
      cur.updatedMs = Date.now();
      return cur;
    }));
    if(ng){ toast(ng); return; }
    if(!tx.committed){ toast('記録できませんでした。もう一度お試しください。'); return; }
  }catch(e){
    console.error(e);
    toast(writeHint(e, '記録できませんでした'));
    return;
  }
  // 焼けていたカップを手元へ返す。次のお客様に出せる。
  for(const [k, n] of Object.entries(back)) await bumpOnhand(k, n);
  const o = orders.find(x=>x.id===id);
  const backText = Object.entries(back).map(([k,n])=>`${shortLabel(k)} ${n}${unit(k)}`).join('／');
  toast(`${numOf(o)} の一部をやめました`
      + (backText ? `（${backText} を手元に戻しました）` : ''), 'ok', null, 7000);
}

/* ---------- 支払い口 3 面目：返金 ----------
   代金を受け取ったあとに中止した注文。キャンセルは受注額からも支払い軸からも
   外れるので、どの数字にも現れないまま現金だけが手元に残る。
   当日（2026-10-03）はこれが 5 件 1,800 円あり、締めで初めて差額として出た。

   返したかどうかを残す欄が無いので、「返したと記録」＝ paid を落とす操作が
   その記録になる。押すと集計の「返金すべき」と金庫の理論値から外れる。 */
function renderRefund(){
  const list = $('refund-list'); if(!list) return;
  const due = orders.filter(o => o.status === 'cancelled' && o.paid).sort(byOrder);
  const sum = due.reduce((n,o)=>n + (o.price||0), 0);

  // 上のバーにも出す。3 面目を開かないと存在に気づけない数字なので。
  const wrap = $('pay-refund-wrap');
  if(wrap){
    wrap.hidden = due.length === 0;
    $('pay-refund').textContent = due.length;
    $('pay-refund-yen').textContent = yen(sum);
  }

  const head = $('refund-sum');
  if(head){
    head.hidden = due.length === 0;
    head.textContent = `お返しする合計 ${yen(sum)}円 ／ ${due.length}件`;
  }

  list.innerHTML = due.map(o=>`
    <article class="ops-card" data-refund="true"
             aria-label="${numOf(o)} 返金 ${yen(o.price||0)}円">
      <header class="ops-head">
        <span class="ops-num">${numOf(o)}</span>
        <span class="ops-timer">${o.createdAt || ''}</span>
      </header>
      <span class="ops-state" data-kind="lost">中止・代金を受け取り済み</span>
      ${opsLines(o)}
      <p class="ops-amount">${yen(o.price||0)}<small>円</small></p>
      <button type="button" class="ops-do" data-kind="cash" data-act="unpay"
              data-id="${o.id}" data-num="${numOf(o)}"
              aria-label="${numOf(o)} に ${yen(o.price||0)}円 を返したと記録する">
        ${yen(o.price||0)}円 返したと記録</button>
    </article>`).join('');

  const empty = $('refund-empty');
  if(empty) empty.classList.toggle('hidden', due.length > 0);
}

/* 記録表の操作ボタン。どの状態から何へ動かせるかは Go の遷移表が唯一の正で、
   ボタン文言もそこから来る。画面に書き写すと、規則を足したときに
   片方だけ古いまま残る（実際、受渡の取消と中止が手書きで二重定義だった）。 */
function transitionButtons(o){
  const opts = window.goNextStatuses
    ? (window.goNextStatuses(o.status)?.statuses || [])
    : [];
  return opts.map(t=>{
    const stop = t.value === 'cancelled' ? ' mini-stop' : '';
    return `<button type="button" class="mini${stop}" data-act="move"
      data-id="${o.id}" data-status="${o.status}" data-to="${t.value}" data-num="${numOf(o)}"
      aria-label="${numOf(o)} を「${t.label}」にする">${t.action || t.label}</button>`;
  }).join('');
}

function renderRows(){
  if(!orders.length){
    $('rows').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:38px 14px">まだ注文がありません。受付で注文を確定するとここに記録されます。</td></tr>`;
    return;
  }
  $('rows').innerHTML = [...orders].sort((a,b)=>byOrder(b,a)).map(o=>{
    const [txt,cls] = TAG[o.status] || [o.status,''];
    return `<tr>
      <td>${o.createdAt||''}</td>
      <td class="num-cell">${numOf(o)}</td>
      <td>${itemsText(o)}</td>
      <td>${o.quantity}</td>
      <td>${yen(o.price||0)}円</td>
      <td><span class="tag ${cls}">${txt}</span>${o.status!=='cancelled' && !o.paid ? ' <span class="tag tag-unpaid">未払い</span>' : ''}</td>
      <td><div class="row-actions">
        ${o.status!=='cancelled' && !o.paid ? `<button type="button" class="mini" data-act="takepaid" data-id="${o.id}" data-num="${numOf(o)}" aria-label="${numOf(o)} の支払いを受け取った">支払い受取</button>`:''}
        ${o.paid ? `<button type="button" class="mini" data-act="unpay" data-id="${o.id}" data-num="${o.number}" aria-label="${o.number} を未払いに戻す">未払いに戻す</button>`:''}
        ${transitionButtons(o)}
      </div></td>
    </tr>`;
  }).join('');
}

/* ---------- 売上 ---------- */
function renderFigures(){
  if(!window.wasmReady || !window.goCalculateStats){
    $('figures').innerHTML =
      `<p class="fig-wait">集計を準備しています。表示されない場合は画面を読み込み直してください。</p>`;
    return;
  }
  const s = window.goCalculateStats(JSON.stringify(orders));
  if(!s || s.ok === false){ $('figures').innerHTML = `<p class="fig-wait">集計に失敗しました: ${s?.error||'不明なエラー'}</p>`; return; }
  const cells = [
    // 残りは売り切れ表示のために 0 で止めてある。記録表だけは実数を出す。
    // 受付が 2 台で最後の 1 カップを同時に売ると、止めた側の表示では
    // 「残り 0」に見えて、売り過ぎていること自体が画面から読めない。
    ...FLAVORS.map(f=>{
      const over = stockOf(f.key) - soldOf(f.key);
      return [`${f.label} 残り`, over < 0
        ? `<b style="color:var(--red)">${over}</b><small>${f.unit}（売り過ぎ）</small>`
        : `${over}<small>${f.unit}</small>`];
    }),
    // 受注額と手元の現金は一致しない。締めで照合できるよう必ず分けて出す。
    ['受注額',      `${yen(s.totalSales||0)}<small>円</small>`],
    ['受取済み',    `${yen(s.paidSales||0)}<small>円</small>`],
    ['未収',        `${yen(s.unpaidSales||0)}<small>円</small>`],
    ['お渡し済み',  `${s.completedPacks||0}<small>カップ</small>`],
    ['未お渡し',    `${s.pendingPacks||0}<small>カップ</small>`],
    ['注文数',      `${s.totalOrders||0}<small>件</small>`],
    // 渡したのに未払い＝取りはぐれ。締めで真っ先に見る数字なので独立して出す。
    ['渡したのに未払い', `${yen(s.unpaidDeliveredSales||0)}<small>円 / ${s.unpaidDeliveredOrders||0}件</small>`],
    // 支払い済みのまま中止された注文。現金だけが手元に残り、受注額にも
    // 受取済みにも入らないので、ここに出さないと締めまで誰も気づけない。
    ['返金すべき', `${yen(s.cancelledPaidSales||0)}<small>円 / ${s.cancelledPaidOrders||0}件</small>`],
    ['金庫にあるべき額', `${yen((s.paidSales||0) + (s.cancelledPaidSales||0))}<small>円（返金前）</small>`],
    ['平均客単価',  `${yen(s.avgOrderYen||0)}<small>円（中止を除く）</small>`]
  ];
  $('figures').innerHTML = cells.map(([k,v])=>`<div><span class="fig-k">${k}</span><span class="fig-v">${v}</span></div>`).join('');
}

/* ---------- 状態変更 ---------- */
/* 遷移の可否はサーバー上の最新値に対して判定する。
   ボタンに焼いた from で判定して update() すると、別端末が先に進めていた場合に
   古い前提のまま上書きしてしまう（厨房と受渡が同時に触るので実際に起きる）。 */
/* 未払いのまま渡してしまう事故を防ぐ。
   ただし完全に止めると、現金を受け取ったのに打ち忘れていた場合に行列が止まる。
   受領を促しつつ、承知のうえで渡す道も残す。 */
function handOver(id){
  const o = orders.find(x=>x.id===id);
  if(!o || o.paid){ changeStatus(id,'ready','completed'); return; }

  $('unpaid-sub').textContent = `${numOf(o)}　${itemsText(o)}`;
  $('unpaid-total').innerHTML = `${yen(netPriceOf(o))}<small>円</small>`;
  pendingHandOver = id;
  openModal('m-unpaid');
}

/* 金額表示は別端末に出すので、DB 経由で渡す。
   配信先は支払い口ごとに分ける（1 本にすると 2 口目が互いに上書きし合う）。
   お客様の前に出しっぱなしにしないよう、会計をやめたら必ず消す。 */
async function showAmount(o){
  try{
    await authReady;
    await set(ref(db,'display/payment/' + station()), {
      orderId: o.id,
      number: numOf(o),
      // 商品名の文章ではなく商品キーと個数を渡す。お客様側では絵で見せるため。
      items: encodeLines(o.items),
      amount: o.price || 0,
      at: nowServer()
    });
  }catch(e){
    console.error('金額表示の配信に失敗:', e);
    toast(writeHint(e, 'お客様側の画面に金額を出せませんでした'));
  }
}

/* 受け取りが済んだ。金額を 0 にして「◯時◯分ごろ」の面に切り替える。
   消さずに残すのは、お客様が番号札を受け取ってから顔を上げるまでに間があるため。 */
async function showPaid(o){
  try{
    await authReady;
    await set(ref(db,'display/payment/' + station()), {
      orderId: o.id,
      number: numOf(o),
      items: encodeLines(o.items),
      amount: 0,
      at: nowServer()
    });
  }catch(e){ console.error('受け取り後の表示に失敗:', e); }
}

async function clearAmount(){
  try{
    await authReady;
    await set(ref(db,'display/payment/' + station()),
              { orderId:'', number:'', items:'', amount:0, at: nowServer() });
  }catch(e){ console.error('金額表示の消去に失敗:', e); }
}

/* ---------- 現金を扱う操作の手応え ----------
   受渡口・支払い口は現金が動く画面なので、押した結果が画面に残る必要がある。
   押すとカードは一覧から消えるが、消えた理由は「自分が記録した」とも
   「別の端末が先に記録した」とも読めてしまい、区別が付かなかった。 */

/* 応答が返るまで押せなくする。行列の中では同じところを二度叩くのが普通で、
   2 回目は必ず「すでに支払い済みです」の赤いエラーになっていた。
   受け取れたのか失敗したのか、画面から区別が付かない状態だった。

   disabled だけでは足りない。応答待ちの間に別の端末の操作で一覧が描き替わると
   ボタンは作り直され、disabled が消えたものが出てくる。注文の側で覚える。 */
const cashBusy = new Set();
function lockTap(b, id){
  if(cashBusy.has(id)) return false;
  cashBusy.add(id);
  if(b && !b.disabled){
    b.disabled = true;
    // aria-label がある要素は文字を差し替えても読み上げに出ない。両方を持ち替える。
    b.dataset.wasText = b.textContent;
    const al = b.getAttribute('aria-label');
    if(al != null) b.dataset.wasAria = al;
    b.textContent = '記録中…';
    b.setAttribute('aria-label', '記録中');
    b.setAttribute('aria-busy', 'true');
  }
  return true;
}
/* 応答が返ったら必ず解く。成功時に解かないと、トーストから戻した注文が
   もう一度は押せない状態で一覧に戻ってくる。 */
function unlockTap(b, id){
  cashBusy.delete(id);
  if(!b) return;
  b.disabled = false;
  b.removeAttribute('aria-busy');
  if(b.dataset.wasText != null){ b.textContent = b.dataset.wasText; delete b.dataset.wasText; }
  if(b.dataset.wasAria != null){ b.setAttribute('aria-label', b.dataset.wasAria); delete b.dataset.wasAria; }
  else b.removeAttribute('aria-label');
}

/* 受け取った記録が残ったことを示し、その場から戻せるようにする。
   戻す導線は「支払い済み」の畳んだ一覧にもあるが、開いて 20 件から
   番号を探す必要があり、直後の押し間違いを直す速さではない。
   金額の記録を先に戻す。状態の差し戻しが失敗しても、現金の記録だけは合う。 */
function cashDone(msg, id, alsoHandOver){
  toast(msg, 'info', ()=>{
    setPaid(id, false).then(({ok})=>{
      if(ok && alsoHandOver) changeStatus(id,'completed','ready');
    });
  }, 7000);
}

/* ---------- 支払い口：会計中の 1 件 ----------
   モーダルで覆うと「いまどれを会計中か」が一覧から見えなくなり、
   お客様側の端末に何を出しているのかもスタッフから分からなくなる。
   一覧の上で選び、選ばれたカードにそのまま金額と操作を出す。

   同時に会計できるのは 1 件だけ。金額の配信先（display/payment/<口>）が
   1 つなので、2 件を並行させるとお客様の画面が入れ替わってしまう。 */
let collecting = null;

function openCollect(id, alsoHandOver){
  const o = orders.find(x=>x.id===id);
  if(!o){ toast('注文が見つかりません'); return; }
  collecting = { id, alsoHandOver };
  chgPaid = 0;            // 前のお客様のお預かりを残さない
  showAmount(o);          // お客様側の端末に金額を出す
  renderPay();
}

/* ---------- おつり（支払い口の 2 面目） ----------
   暗算は行列のなかでいちばん間違える。しかも間違いは現金が合わなくなる形で残る。

   請求は「◯円 受け取る」で選んだ注文から入れる。打つのはお預かりだけにする
   （請求も打たせると、打ち間違いが釣り銭の間違いに直結する）。 */
let chgPaid = 0;                    // いま打ったお預かり
function chgDue(){
  const o = collecting ? orders.find(x => x.id === collecting.id) : null;
  return o ? (o.price || 0) : 0;
}
function renderChange(){
  const due  = chgDue();
  const back = chgPaid - due;
  const dueEl = $('chg-due');
  if(!dueEl) return;
  dueEl.textContent = due ? `${yen(due)}円` : '—';
  $('chg-paid').textContent = chgPaid ? `${yen(chgPaid)}円` : '0';
  const row = $('chg-back')?.closest('.chg-row');
  const short = due > 0 && chgPaid > 0 && back < 0;
  if(row) row.dataset.short = String(short);
  $('chg-back').textContent = (due > 0 && chgPaid > 0)
    ? (back >= 0 ? `${yen(back)}円` : `${yen(-back)}円 不足`)
    : '—';
  $('chg-hint').textContent = due === 0
    ? '左の面で「◯円 受け取る」を押すと、その金額がここに入ります。'
    : chgPaid === 0 ? 'お預かりした金額を打ってください。'
    : back >= 0 ? 'お釣りをお渡ししたら、左の面で「受け取った」を押します。'
                : 'お預かりが足りません。';
}
$('chg-keys')?.addEventListener('click', e=>{
  const b = e.target.closest('button[data-k]');
  if(!b) return;
  const k = b.dataset.k;
  if(k === 'back') chgPaid = Math.floor(chgPaid / 10);
  else chgPaid = Math.min(999999, Number(String(chgPaid) + k));
  renderChange();
});
$('chg-quick')?.addEventListener('click', e=>{
  const b = e.target.closest('button');
  if(!b) return;
  if(b.dataset.exact) chgPaid = chgDue();
  else chgPaid = Math.min(999999, chgPaid + Number(b.dataset.add || 0));
  renderChange();
});
$('chg-clear')?.addEventListener('click', ()=>{ chgPaid = 0; renderChange(); });

/* 会計をやめる。お客様の前に金額を出しっぱなしにしない。 */
function cancelCollect(){
  if(!collecting) return;
  collecting = null;
  chgPaid = 0;
  clearAmount();
  renderPay();
}

async function confirmCollect(){
  const c = collecting;
  if(!c) return;
  const o = orders.find(x=>x.id===c.id);
  const amount = o ? yen(o.price||0) : '';
  // 記録が通ってから画面を進める。先に畳むと、支払いの書き込みだけが失敗した
  // ときに「お客様の画面は消えたのに未払いのまま」が残り、締めで差額になる。
  if((await setPaid(c.id, true)).ok){
    collecting = null;
    chgPaid = 0;
    // 受け取りが済んだ面へ。会計中の金額はここで消える。
    if(o) showPaid(o); else clearAmount();
    renderPay();
    if(soundOn()) audio.paid();
    if(c.alsoHandOver) changeStatus(c.id,'ready','completed');
    // 会計中のカードは押した時点で一覧から消える。何を記録したのかを
    // 番号と金額で言い直し、その場から戻せるようにする。
    cashDone(`${numOf(o)} ${amount}円 受け取りました`, c.id, c.alsoHandOver);
    return;
  }
  // 記録できなかった。会計中のまま残し、もう一度押せるようにする。
  renderPay();
}

/* 未払い確認ダイアログの対象。モーダルを閉じたら必ず捨てる。 */
let pendingHandOver = null;

$('unpaid-back').addEventListener('click', ()=>{ pendingHandOver = null; closeModal(); });

$('unpaid-take').addEventListener('click', async ()=>{
  const id = pendingHandOver; pendingHandOver = null; closeModal();
  if(!id) return;
  if((await setPaid(id, true)).ok) changeStatus(id,'ready','completed');
});

$('unpaid-skip').addEventListener('click', ()=>{
  const id = pendingHandOver; pendingHandOver = null; closeModal();
  if(id) changeStatus(id,'ready','completed');
});

/* 支払いは受渡ステータスとは独立した軸。
   受付・支払い口・受渡口のどこで受け取るか決まっていないため、
   どの画面からでも打てる。打ち間違いの取り消しも認める（現金と合わなくなるため）。 */
/* 戻り値は { ok, already }。already は「すでにその状態だった」。
   これを失敗として扱うと、支払い口が先に入金を記録した直後に受渡が
   「◯円 受け取って渡した」を押したとき、お渡しの記録だけが落ちる
   （現金は二重に受け取り、注文は ready のまま呼び出しが鳴り続ける）。 */
async function setPaid(id, next){
  let ng = null, already = false;
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null;
      if(cur === null){ ng = '注文が見つかりません'; return; }
      const now = !!cur.paid;
      already = (now === next);
      if(window.wasmReady && window.goSetPaid){
        const r = window.goSetPaid(now, next, cur.status || 'pending');
        if(!r.valid){ ng = r.reason; return; }
      }else if(already){
        ng = next ? 'すでに支払い済みです' : 'すでに未払いです'; return;
      }
      cur.paid = next;
      if(next) cur.paidMs = Date.now();
      else delete cur.paidMs;
      cur.updatedMs = Date.now();
      return cur;
    }));
    // すでにその状態なら、書き込みはしないが「済んでいる」ので先へ進ませる。
    if(already) return { ok:true, already:true };
    if(ng){ toast(ng); return { ok:false }; }
    if(!tx.committed){ toast('支払いを記録できませんでした。もう一度お試しください。'); return { ok:false }; }
    return { ok:true };
  }catch(e){
    console.error(e);
    toast(writeHint(e, '支払いを記録できませんでした'));
    return { ok:false };
  }
}

/* 焼き上がったカップを受け取った／取り消した。

   そろった時点で受渡待ちにし、呼び出しも同じ 1 回の書き込みで始める。
   別に「用意できた」を押させると、そろってから呼ぶまでが人の気づき待ちになる。
   取り消して足りなくなったら、焼き待ちへ戻す（状態と実物をずらさない）。 */
async function fillCup(id, flavor, delta){
  if(!flavor) return false;
  let ng = null;
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null;
      if(cur === null){ ng = '注文が見つかりません'; return; }
      if(cur.status === 'cancelled'){ ng = 'この注文は中止されています'; return; }
      if(cur.status === 'completed'){ ng = 'この注文はお渡し済みです'; return; }
      const items = cur.items || [];
      const want = (items.find(i=>i.flavor === flavor) || {}).quantity || 0;
      if(!want){ ng = 'この注文にその商品はありません'; return; }
      const made = { ...(cur.made || {}) };
      made[flavor] = Math.max(0, Math.min(want, (Number(made[flavor]) || 0) + delta));
      cur.made = made;
      const all = items.every(i => (Number(made[i.flavor]) || 0) >= (i.quantity || 0));
      if(all && cur.status === 'pending'){
        cur.status = 'ready';
        // 受渡待ちになるたびに呼び直す。前の calledAt を残すと、焼き待ちへ
        // 戻してからそろえ直したとき、呼び出し表示が一度も点かない。
        cur.calledAt = Date.now();
        cur.calls = 1;              // ここが 1 回目
      }else if(!all && cur.status === 'ready'){
        cur.status = 'pending';          // 足りなくなった＝まだ焼き待ち
        delete cur.calledAt;             // 呼んでいない状態に戻す
      }
      cur.updatedMs = Date.now();
      return cur;
    }));
    if(ng){ toast(ng); return false; }
    if(!tx.committed){ toast('記録できませんでした。もう一度お試しください。'); return false; }
    return true;
  }catch(e){
    console.error(e);
    toast(writeHint(e, '記録できませんでした'));
    return false;
  }
}

/* まとめて届いたとき。味も数も全部そろったことにして、受渡待ちにする。
   before を渡すと、その時点の「受け取った数」へ戻せる（トーストの「戻す」）。 */
async function fillAll(id, before){
  let ng = null;
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null;
      if(cur === null){ ng = '注文が見つかりません'; return; }
      if(cur.status === 'cancelled'){ ng = 'この注文は中止されています'; return; }
      const items = cur.items || [];
      if(before){
        // 取り消し。押す前の数に戻し、足りなければ焼き待ちへ返す。
        const made = {};
        for(const i of items) made[i.flavor] = Math.max(0, Math.min(i.quantity || 0,
                                                 Number(before[i.flavor]) || 0));
        cur.made = made;
        const all = items.every(i => (made[i.flavor] || 0) >= (i.quantity || 0));
        if(!all && cur.status === 'ready'){ cur.status = 'pending'; delete cur.calledAt; }
      }else{
        const made = {};
        for(const i of items) made[i.flavor] = i.quantity || 0;
        cur.made = made;
        if(cur.status === 'pending'){
          cur.status = 'ready';
          cur.calledAt = Date.now();
          cur.calls = 1;
        }
      }
      cur.updatedMs = Date.now();
      return cur;
    }));
    if(ng){ toast(ng); return false; }
    if(!tx.committed){ toast('記録できませんでした。もう一度お試しください。'); return false; }
    return true;
  }catch(e){
    console.error(e);
    toast(writeHint(e, '記録できませんでした'));
    return false;
  }
}

/* 呼び出し表示で目立たせる。CALL_HOLD_MS の間だけ強調される。 */
const CALL_HOLD_MS = 40000;
async function callOrder(id){
  try{
    await authReady;
    // 状態を見ずに書くと、別の端末が渡し終えた注文にも呼び出し時刻が入り、
    // あとで「お渡し待ちに戻す」を押した瞬間に誰も呼んでいない番号が鳴る。
    await runTransaction(ref(db,'orders/'+id), cur=>{
      if(cur === null || cur.status !== 'ready') return;   // 中止＝書かない
      cur.calledAt = Date.now();
      cur.calls = (Number(cur.calls) || 0) + 1;
      cur.updatedMs = Date.now();
      return cur;
    });
  }catch(e){
    toast('呼び出しを送れませんでした。通信を確かめてください。');
  }
}

async function changeStatus(id, from, to){
  let ng = null;
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null;                                  // 投機実行と本実行で最後の判定だけ採る
      if(cur === null){ ng = '注文が見つかりません'; return; }
      if(window.wasmReady && window.goUpdateOrderStatus){
        const r = window.goUpdateOrderStatus(cur.status || 'pending', to);
        if(!r.valid){ ng = r.reason; return; }    // undefined を返すと中止
      }
      const was = cur.status;
      cur.status = to;
      // 受渡待ちになった時点で呼び出しも済ませる。別に「呼ぶ」を押させると、
      // 焼き上げてから呼ぶまでの間が人の気づき待ちになる。
      // ここで書けば writer は「用意できた」を押した 1 台だけで、書き込みも 1 回。
      if(to === 'ready'){ cur.calledAt = Date.now(); cur.calls = (was === 'ready' ? (cur.calls||0) : 0) + 1; }
      if(to === 'pending'){ delete cur.calledAt; delete cur.calls; }
      // 記録表から「用意した」を押したときは made が空のまま ready になり、
      // 焼き待ちカップが厨房の板と見積もりから静かに消える。実物に合わせて埋める。
      if(to === 'ready' && was === 'pending'){
        const made = { ...(cur.made || {}) };
        for(const i of (cur.items || [])) made[i.flavor] = i.quantity || 0;
        cur.made = made;
      }
      cur.updatedMs = Date.now();
      return cur;
    }));
    if(ng){ toast('状態を変えられません: ' + ng); return; }
    if(!tx.committed) toast('更新できませんでした。もう一度お試しください。');
  }catch(e){
    console.error(e);
    toast(writeHint(e, '更新できませんでした'));
  }
}

document.addEventListener('click', e=>{
  const b = e.target.closest('button[data-act]');
  if(!b) return;
  const id = b.dataset.id;
  switch(b.dataset.act){
    // 手元にある分の数え上げ。営業前の作り置きも、営業中に厨房から
    // 届いた分も、同じこの数に足す。焼き待ちより多くても構わない。
    case 'deal-step':
      bumpOnhand(b.dataset.key, Number(b.dataset.step) || 0);
      return;
    case 'deal-go': applyDeal(); return;

    // 「3 つのうち 1 つは大丈夫です」。注文は変えず、やめたぶんを別に数える。
    case 'voidpart': openVoid(id); return;

    // 約束の時刻に来ない人を後回しにする。来たらいつでも渡せる。
    case 'hold':   setHold(id, Number(b.dataset.min) || 5); return;
    case 'unhold': setHold(id, 0); return;

    // 受付で「◯時◯分ごろ」とご案内したあと、それより後にしたいと言われる場面。
    case 'later':      openLater(id); return;
    case 'later-step': laterPick(Number(b.dataset.min) || 0); return;
    case 'void-step': {
      if(!voiding) return;
      const o = orders.find(x=>x.id===voiding.id);
      const k = b.dataset.key, d = Number(b.dataset.step) || 0;
      const max = o ? wantOf(o, k) : 0;
      voiding.pick[k] = Math.max(0, Math.min(max, (voiding.pick[k] || 0) + d));
      renderVoid();
      return;
    }

    // 1 カップ受け取った／取り消した。厨房の画面は立てかけてあるだけで
    // 触れないので、品物を受け取った受渡口がここを打つ。
    case 'made':
      knownReady.add(id);          // 自分の操作では受渡の着信音を鳴らさない
      fillCup(id, b.dataset.flavor, +1);
      break;
    case 'unmade':
      fillCup(id, b.dataset.flavor, -1);
      break;
    // ぜんぶまとめて届いたとき。そろうので、呼び出しもここから始まる。
    case 'madeall': {
      const o = orders.find(x=>x.id===id);
      const before = { ...(o?.made || {}) };
      knownReady.add(id);
      fillAll(id);
      // 確認で止めると行列が詰まる。止めずに、後から取り消せるようにする。
      toast(`${numOf(o)} をお渡し待ちにしました`
            + (o?.number ? '・お呼び出しを始めました' : ''), 'info',
            ()=>fillAll(id, before), 7000);
      break;
    }
    case 'done':   handOver(id); break;
    case 'pay':     openCollect(id, false); break;
    case 'paydone': openCollect(id, true); break;
    // 記録表からの支払い受取。openCollect を通すと、いま開いていない支払い口の
    // 画面に会計中の状態ができ、お客様に向けた金額表示にも金額が出たまま残る
    // （記録表には確定も取消もボタンが無いので、誰も消せなくなる）。
    // ここは客側の画面を一切触らず、記録だけを直す。
    case 'takepaid':
      setPaid(id, true).then(({ok})=>{ if(ok && soundOn()) audio.paid(); });
      break;
    // 受渡口の「N円を受け取って渡した」。未払いの注文はこれが普通の道なので、
    // 確認を挟まず 1 タップで済ませる。押し間違いはその場のトーストから戻せる。
    case 'handpaid': {
      const o = orders.find(x=>x.id===id);
      const amount = o ? yen(o.price||0) : '';
      // 通信が遅いと二度押しになる。1 回目の応答が返るまで押せなくしておく。
      // 無しだと 2 回目が「すでに支払い済みです」の赤いエラーになり、
      // 受け取れたのか失敗したのか画面から判断できない。
      if(!lockTap(b, id)) break;
      setPaid(id, true).then(({ok, already})=>{
        unlockTap(b, id);
        if(!ok) return;                       // 支払いを記録できなければ渡さない
        if(soundOn() && !already) audio.paid();
        changeStatus(id,'ready','completed');
        // 現金を受け取った記録が残ったことを、音とは別に目でも示す。
        // 音は切れる（soundOn が false・周りがうるさい）ので、これが唯一の合図。
        cashDone(already
          ? `${numOf(o)} は支払い口で受け取り済みでした。お渡しを記録しました`
          : `${numOf(o)} ${amount}円 受け取って渡しました`, id, !already);
      });
      break;
    }
    case 'collect-ok':     confirmCollect(); break;
    case 'collect-cancel': cancelCollect(); break;
    case 'unpay': {
      // 中止された注文で押すときは「打ち間違いを戻す」ではなく「返金した」の記録。
      // 返したかどうかを残す欄が無いので、この操作がその代わりになっている。
      // 同じ文言のままだと、何を記録しているのか押す人に伝わらない。
      const o = orders.find(x=>x.id===id);
      const refund = !!o && o.status === 'cancelled';
      ask(refund ? {
        title: '現金をお返ししましたか？',
        sub: `${b.dataset.num||''} は中止された注文です。`
           + `${yen(o.price||0)}円 をお返ししたら「はい」を押してください。`,
        warn: 'まだお返ししていなければ「いいえ」。'
            + '「はい」を押すと、この金額は「返金すべき」と金庫の理論値から外れます。',
        onYes: ()=>setPaid(id, false)
      } : {
        title: '支払いを「未払い」に戻しますか？',
        sub: `${b.dataset.num||''} の記録を未払いに戻します。`,
        warn: 'お客様に現金をお返しする場合は、忘れずに行ってください。',
        onYes: ()=>setPaid(id, false)
      });
      break;
    }

    case 'move': {
      const to = b.dataset.to;
      // 中止だけは取り返しが付きにくいので確認する。他は 1 タップで戻せる。
      if(to !== 'cancelled'){ changeStatus(id, b.dataset.status, to); break; }
      const o = orders.find(x=>x.id===id);
      ask({
        title: `${b.dataset.num} を中止しますか？`,
        sub: '中止した注文は売上から外れ、在庫も戻ります。',
        // 支払い済みを中止すると、受け取った現金が売上のどこにも残らない。
        // 返金が必要なことを、押す前に必ず出す。
        warn: o?.paid ? `この注文は支払い済みです。${yen(o.price||0)}円を返金してください。` : '',
        onYes: ()=>changeStatus(id, b.dataset.status, 'cancelled')
      });
      break;
    }
    // 管理画面から受付機を強制解除する。電池切れや置き忘れで「起動中」のまま
    // 残った席を、本部の判断で取り上げるための道。
    // 受付機を待機にする／注文受付中に戻す。遠隔で切り替えるので確認は挟まない
    // （待機は押し間違えてもすぐ戻せるし、止めると行列の捌きが遅れる）。
    case 'deskmode':
      setDeskMode(id, b.dataset.to);
      break;
    // 呼び出しに対応した。管理画面と受渡の画面の両方から解除できる。
    case 'helpdone':
      clearHelp(id);
      break;
    case 'deskfree': {
      const d = DESKS.find(x=>x.id===id);
      const mine = desksOnline[id]?.client === clientId;
      ask({
        title: `${d?.label||''} を強制解除しますか？`,
        sub: 'いま使っている端末からこの受付機を取り上げ、空きに戻します。'
           + 'その端末は自動では戻らず、画面で選び直すまで受付を使えません。',
        warn: mine ? 'これはこの端末です。解除すると、この端末でもう一度選び直します。'
                   : '受付の途中だった場合、その接客は中断します。',
        onYes: async ()=>{
          await kickDesk(id);
          if(mine){
            dropDisconnect(id);
            myDesk = null;
            try{ localStorage.removeItem('deskNo'); }catch(e){}
            paintDesks();
            ensureDesk();
          }
        }
      });
      break;
    }
    // アレルギー。お客様が自分で開く。
    case 'allergy':
      openAllergy(b.dataset.key);
      break;
    case 'flash':
      // 以前は自分の画面のカードを光らせるだけで、お客様には何も届いていなかった。
      // 呼び出し表示を別端末で出す運用なので、時刻を注文に書いて全端末で共有する。
      callOrder(id);
      break;
  }
});

/* ---------- 営業回 ----------
   リハーサルと本番を同じ DB で回すための仕切り。注文は 1 件も消さず、
   集計と画面の対象だけを切り替える。「本番前にデータを消す」という
   危険な手作業を無くすのが目的。 */
/* 稽古中かどうか。営業回の名前で見分ける（端末に覚えさせない。
   受付が 4 台あるので、端末の記憶だと隣と食い違う）。 */
const isTest = () => /^test-/.test(session || '');

function paintSession(){
  const el = $('session-name');
  if(!el) return;
  const live = allOrders.filter(o => inSession(o, session));
  el.textContent = session === DEFAULT_SESSION
    ? '営業回：既定（仕切りなし）'
    : `営業回：${session}`;
  el.dataset.test = String(isTest());
  const tb = $('test-state');
  if(tb) tb.hidden = !isTest();
  document.body.dataset.test = String(isTest());
  const tbtn = $('session-test');
  if(tbtn) tbtn.textContent = isTest() ? 'テストを終えて本番に戻す' : 'テストを始める';
  const nbtn = $('session-new');
  // 稽古中に「締めて次の回」を押されると、本番の営業回が分からなくなる。
  if(nbtn) nbtn.disabled = isTest();
  const sub = $('session-sub');
  if(sub) sub.textContent =
    `この回の注文 ${live.length}件 ／ これより前の記録 ${allOrders.length - live.length}件（消さずに残っています）`
    + (prevSession ? ` ／ ひとつ前の回：${prevSession}` : '');
}

/* ひとつ前の営業回。締めを押し間違えたとき、戻すのに要るのはこの文字列だけ。
   画面にもどこにも残っていないと、CSV のファイル名から拾うしかなかった。 */
let prevSession = (()=>{ try{ return localStorage.getItem('prevSession') || ''; }catch(e){ return ''; } })();

/* ---------- テスト（稽古） ----------
   本番と同じ DB のまま、営業回だけを test- で始まる名前に切り替える。
   画面も売上も在庫も番号札も営業回で絞られているので、これだけで
   「カップ数も変わらない・売上にも入らない」が成り立つ。
   終えると、ひとつ前の営業回にそのまま戻る。 */
$('session-test')?.addEventListener('click', ()=>{
  if(isTest()){
    const back = prevSession;
    if(!back){ toast('戻る先の営業回が分かりません。記録・売上から選び直してください。'); return; }
    ask({
      title: 'テストを終えて本番に戻しますか？',
      sub: `営業回を ${back} に戻します。テスト中に受けた注文は残りますが、画面からは外れます。`,
      warn: 'テストの注文は売上にも在庫にも入りません。',
      onYes: async ()=>{
        try{
          await authReady;
          const from = session;
          await tracked(set(ref(db,'config/session'), back));
          prevSession = from;
          try{ localStorage.setItem('prevSession', from); }catch(e){}
          paintSession();
          toast(`本番（${back}）に戻しました。`, 'ok');
        }catch(e){ toast(writeHint(e, '本番に戻せませんでした')); }
      }
    });
    return;
  }
  const d = new Date(Date.now() + 9*3600*1000);
  const id = 'test-' + d.toISOString().slice(0,16).replace(/[-:T]/g,'')
                        .replace(/(\d{8})(\d{4})/,'$1-$2');
  ask({
    title: 'テストを始めますか？',
    sub: 'いまの画面から注文・受渡・支払いを一通り試せます。'
       + '売上・在庫・番号札はテスト用に 0 から始まります。',
    warn: `終えると ${session} に戻ります。テスト中に本物の注文を受けないでください。`,
    onYes: async ()=>{
      try{
        await authReady;
        const from = session;
        await tracked(set(ref(db,'config/session'), id));
        prevSession = from;
        try{ localStorage.setItem('prevSession', from); }catch(e){}
        paintSession();
        toast(`テストを始めました（${id}）。終えると ${from} に戻ります。`, 'ok', null, 9000);
      }catch(e){ toast(writeHint(e, 'テストを始められませんでした')); }
    }
  });
});

$('session-new')?.addEventListener('click', ()=>{
  // 進行中の件数を実数で出す。「集計が 0 から始まります」を
  // 「焼き待ちの注文が全画面から消える」と読み取れる人はいない。
  const live = orders.filter(o=>o.status === 'pending' || o.status === 'ready').length;
  const owed = orders.filter(o=>!o.paid && o.status !== 'cancelled').length;
  ask({
    title: '締めて、次の回を始めますか？',
    sub: '今の回のCSVを保存してから切り替えます。売上・在庫・番号札の集計が 0 から始まります。',
    warn: (live || owed)
      ? `いま進行中の 焼き待ち・受渡待ち ${live}件、未収 ${owed}件 が、`
        + '厨房・受渡・支払い口・呼び出しの画面から見えなくなります。'
        + `戻すには営業回 ${session} を入れ直す必要があります（画面からは戻せません）。`
      : '注文は消えません。これまでの記録はそのまま残ります。',
    onYes: async ()=>{
      // 締めの CSV を自動で落とす。人手の「保存し忘れ」を無くす。
      //
      // 集計モジュールが落ちていると CSV は 1 行も出ない。以前はそれでも
      // 営業回を切り替えており、しかも失敗のトーストが直後の成功のトーストに
      // 上書きされて消えるので、誰も気づけなかった。切り替える前に確かめる。
      if(!csvReady()){
        toast('集計モジュールが未準備のため、CSVを保存できません。'
            + '画面を読み込み直してから、もう一度締めてください。'
            + '（営業回はまだ切り替えていません）', 'error', null, 9000);
        return;
      }
      // 0 件のまま締めると、ヘッダだけの CSV が「その回の唯一の記録」として
      // 残り、営業回だけが進む。注文の購読がまだ届いていない・切られている
      // ときがこれに当たる（9/29 に 102 バイトの実例が残っている）。
      if(!closeReady()){
        toast('この回の注文がまだ画面に届いていません。'
            + '注文が表に出てから締めてください。'
            + '（営業回はまだ切り替えていません）', 'error', null, 9000);
        return;
      }
      if(!saveCSV('orders')) return;
      // ダウンロードを続けて 2 回起こすと、2 枚目が黙って落ちない端末がある。
      // 1 枚目が保存ダイアログを抜けるまで少し待つ。
      await new Promise(r=>setTimeout(r, 800));
      if(!saveCSV('summary')) return;
      const d = new Date(Date.now() + 9*3600*1000);   // JST で名前を付ける
      const id = d.toISOString().slice(0,16).replace(/[-:T]/g,'').replace(/(\d{8})(\d{4})/,'$1-$2');
      try{
        await authReady;
        const from = session;
        await tracked(set(ref(db,'config/session'), id));
        // 戻すのに要るのはこの文字列だけ。画面にもどこにも残っていないと、
        // CSV のファイル名から拾うしかなかった。
        prevSession = from;
        try{ localStorage.setItem('prevSession', from); }catch(e){}
        paintSession();
        toast(`新しい営業回 ${id} を始めました。（ひとつ前は ${from}）`, 'info', null, 9000);
      }catch(e){ toast(writeHint(e, '営業回を切り替えられませんでした')); }
    }
  });
});

/* ---------- お客様に向けた端末の逃げ道 ----------
   呼び出し表示・金額表示ではナビを畳んである（触られると売上まで見えるため）。
   スタッフが戻れなくなると困るので、左上隅の長押しだけ受け付ける。 */
let kioskTimer = null;
const esc = $('kiosk-escape');
esc?.addEventListener('pointerdown', ()=>{
  kioskTimer = setTimeout(()=>{ location.hash = ''; switchTab('order'); }, 1200);
});
['pointerup','pointerleave','pointercancel'].forEach(ev =>
  esc?.addEventListener(ev, ()=>clearTimeout(kioskTimer)));

/* ---------- 確認ダイアログ ----------
   OS の confirm() は意匠から浮くうえ、補足を添えられない。
   「支払い済みを中止する＝返金が要る」のような、押す前に出すべき事情がある。 */
let askYes = null;
function ask({ title, sub, warn, onYes }){
  $('ask-h').textContent = title;
  $('ask-sub').textContent = sub || '';
  $('ask-warn').textContent = warn || '';
  askYes = onYes;
  openModal('m-ask', ()=>{ askYes = null; });
}
$('ask-yes').addEventListener('click', ()=>{
  const f = askYes;
  closeModal();                 // 後始末（askYes 破棄）は openModal に預けてある
  f?.();
});
$('ask-no').addEventListener('click', closeModal);

/* ---------- 単価 ---------- */
$('price-btn').addEventListener('click', ()=>{
  $('price-fields').innerHTML =
    `<h3 class="field-group">単価</h3>` +
    FLAVORS.map(f=>`
      <div class="field">
        <label for="p-${f.key}">${f.label}（1${f.unit}${f.pieces?` ${f.pieces}個入り`:''}）</label>
        <input type="number" id="p-${f.key}" data-pkey="${f.key}" min="1" step="10" inputmode="numeric"
               value="${prices[f.key] ?? f.defaultPrice}" aria-describedby="price-err">
      </div>`).join('') +
    `<h3 class="field-group">番号札</h3>
     <div class="field">
       <label for="p-tags">手元にある札の枚数</label>
       <input type="number" id="p-tags" min="1" max="999" step="1" inputmode="numeric"
              value="${tagCount()}" aria-describedby="price-err">
       <p class="field-hint">札は使い回します。番号はこの枚数で循環し、出ている札は飛ばします。</p>
     </div>
     <h3 class="field-group">1回の注文で頼める上限</h3>
     <div class="field">
       <label for="p-max">合計カップ数の上限</label>
       <input type="number" id="p-max" min="1" step="1" inputmode="numeric"
              value="${limits.maxPerOrder}" aria-describedby="price-err">
     </div>
     <h3 class="field-group">用意した数（作り置き）</h3>` +
    FLAVORS.map(f=>`
      <div class="field">
        <label for="s-${f.key}">${f.label}</label>
        <input type="number" id="s-${f.key}" data-skey="${f.key}" min="0" step="1" inputmode="numeric"
               value="${stockOf(f.key)}" aria-describedby="price-err">
        <p class="field-hint">売れた ${soldOf(f.key)}${f.unit} ／ 残り ${remainingOf(f.key)}${f.unit}</p>
      </div>`).join('');
  $('price-err').classList.remove('show');
  openModal('m-price');
});
$('price-cancel').addEventListener('click', closeModal);

$('price-save').addEventListener('click', async ()=>{
  const err = $('price-err');
  const fail = (msg, sel)=>{
    err.textContent = msg; err.classList.add('show');
    document.querySelector(sel)?.focus();
  };

  const nextPrices = {}, nextStock = {};
  document.querySelectorAll('[data-pkey]').forEach(el=>{ nextPrices[el.dataset.pkey] = parseInt(el.value,10); });
  document.querySelectorAll('[data-skey]').forEach(el=>{ nextStock[el.dataset.skey] = parseInt(el.value,10); });
  const maxPerOrder = parseInt($('p-max').value, 10);
  const tags = parseInt($('p-tags').value, 10);

  // 検証は Go を唯一の正にする。画面側は入力を集めるだけ。
  const priceCheck = window.goValidatePrices
    ? window.goValidatePrices(nextPrices)
    : (Object.values(nextPrices).every(v=>Number.isInteger(v) && v>=1)
        ? { ok:true, prices:nextPrices }
        : { ok:false, error:'単価は1円以上の整数で入力してください。' });
  if(!priceCheck.ok) return fail(priceCheck.error, '[data-pkey]');

  const limitCheck = window.goValidateLimits
    ? window.goValidateLimits({ maxPerOrder, stock: nextStock, tagCount: tags })
    : ((Number.isInteger(maxPerOrder) && maxPerOrder >= 1 &&
        Number.isInteger(tags) && tags >= 1 && tags <= 999 &&
        Object.values(nextStock).every(v=>Number.isInteger(v) && v >= 0))
        ? { ok:true, limits:{ maxPerOrder, stock:nextStock, tagCount:tags } }
        : { ok:false, error:'枚数・上限・用意した数は正しい整数で入力してください。' });
  if(!limitCheck.ok) return fail(limitCheck.error, '#p-max');

  // すでに売れた数より少ない在庫は設定させない（残りが負になり、売り切れ判定が壊れる）。
  for(const f of FLAVORS){
    const sold = soldOf(f.key);
    if(limitCheck.limits.stock[f.key] < sold){
      return fail(`${f.label}はすでに ${sold}${f.unit} 出ています。用意した数はそれ以上にしてください。`, `#s-${f.key}`);
    }
  }

  err.classList.remove('show');
  try{
    await authReady;   // 書き込みは認証の後でしか通らない
    // 単価と上限は 1 回の更新でまとめて書く（片方だけ反映された状態を作らない）。
    await update(ref(db,'config'), { prices: priceCheck.prices, limits: limitCheck.limits });
    closeModal(); toast('設定を更新しました。','info');
  }catch(e){
    fail('保存できませんでした。通信を確かめてください。', '[data-pkey]');
  }
});

/* ---------- CSV ---------- */
/* CSV を作れる状態か。締めの前に一度だけ確かめ、作れないなら締めを始めない。 */
const csvReady = () =>
  !!(window.wasmReady && window.goGenerateOrdersCSV && window.goGenerateSummaryCSV);
/* 締めてよいか。0 件のまま締めると、ヘッダだけの CSV が「その回の唯一の記録」
   として残り、営業回は進んでしまう（9/29 に 102 バイトの実例が残っている）。
   注文の最初のスナップショットが届く前や、購読が切られている間がこれに当たる。 */
const closeReady = () => csvReady() && !firstSnap && orders.length > 0;

function saveCSV(kind){
  const fn = kind === 'summary' ? window.goGenerateSummaryCSV : window.goGenerateOrdersCSV;
  if(!window.wasmReady || !fn){
    toast('集計モジュールの準備ができていません。少し待ってからもう一度押してください。');
    return false;
  }
  const bytes = fn(JSON.stringify(orders));
  if(!bytes){ toast('CSVを作れませんでした。'); return false; }
  const url = URL.createObjectURL(new Blob([bytes],{type:'text/csv;charset=utf-8;'}));
  const a = document.createElement('a');
  // 日付も JST。UTC で採ると、日本の 0:00〜9:00 に締めたとき前日の名前になる
  // （営業回 ID は JST で付けているので、同じ操作の中で基準が 2 つあった）。
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0,10);
  a.href = url;
  a.download = `${kind === 'summary' ? 'summary' : 'orders'}_${session}_${day}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  // Safari は blob の読み出しを非同期で行うので、click の直後に捨てると
  // 0 バイトで保存される（しかも saveCSV は成功を返す）。
  setTimeout(()=>URL.revokeObjectURL(url), 60000);
  return true;
}
$('csv-btn').addEventListener('click', ()=>saveCSV('orders'));
// 「現金の照合」の表はここからしか出せない。締めで最初に見る数字なので導線を出す。
$('csv-sum-btn')?.addEventListener('click', ()=>saveCSV('summary'));

/* ---------- 受付の採番 ----------
   注文 ID と記録の並び順に使う通し番号。トランザクションなので、
   受付が何台あっても重複しない。

   以前は端末ごとに奇数・偶数へ割り当てを分けていた（物理的な札の山を
   2 台で引くと入れ替わるため）。番号札を受付係が実物を見て選ぶ方式に
   変わった時点で、この割り当ては札と無関係になり、約 80 行の仕組みが
   目的を失っていた。在席検知ごと外してある。 */
async function nextSeq(){
  const tx = await runTransaction(ref(db, 'config/orderCounter/lane0'), c => (c || 0) + 1);
  if(!tx.committed) throw new Error('注文番号を採番できませんでした');
  return tx.snapshot.val();
}

/* ---------- 画面切替 ----------
   端末ごとに URL を決めて使う想定:
     そのまま=受付 / #kitchen=厨房 / #ready=受渡 / #pay=支払い口 / #records=記録・売上
     #call=呼び出し表示 / #amount=金額表示（#pay:2 のように口の番号を足せる）
   受付の画面はお客様に向くため、ナビゲーションは画面上に常設しない。 */
const VIEWS = ['order','kitchen','ready','pay','amount','records','call','control'];
function switchTab(t){
  if(!VIEWS.includes(t)) t = 'order';
  VIEWS.forEach(n=>{
    $('view-'+n).classList.toggle('hidden', n!==t);
    const b = document.querySelector(`.nav-menu [data-go="${n}"]`);
    if(b){ if(n===t) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); }
  });
  document.body.dataset.tab = t;
  closeNav();
  // 受付機を名乗るのは受付の画面だけ。離れたら席は空ける（他の端末が使える）。
  if(t === 'order') resumeDesk();
  else {
    leaveDesk();
    if(openEl?.id === 'm-desk') closeModal();
  }
  // 厨房は display:none の間は高さが測れない。開いた時点で測り直す。
  if(t === 'kitchen') fitBoard();
  if(t === 'call') renderCall();
  // 画面ごとに省エネの条件が違う。切り替えたら必ず取り直す。
  busySince = Date.now();
  setSaver(false);
  tickSaver();
  paintGate();
}
function viewFromHash(){
  // #pay:2 のように支払い口の番号が付くことがある。画面名だけを取り出す。
  return (location.hash || '').replace('#','').split(':')[0] || 'order';
}
window.addEventListener('hashchange', ()=>switchTab(viewFromHash()));

const navToggle = $('nav-toggle'), navMenu = $('nav-menu');
function closeNav(){ const m=$('nav-menu'), t=$('nav-toggle');
  if(m) m.hidden = true;
  if(t) t.setAttribute('aria-expanded','false'); }
navToggle.addEventListener('click', ()=>{
  const open = navMenu.hidden;
  navMenu.hidden = !open;
  navToggle.setAttribute('aria-expanded', String(open));
  if(open) navMenu.querySelector('button')?.focus();
});
navMenu.addEventListener('click', e=>{
  const b = e.target.closest('[data-go]');
  if(!b) return;
  location.hash = b.dataset.go === 'order' ? '' : b.dataset.go;
  switchTab(b.dataset.go);
});
document.addEventListener('keydown', e=>{
  if(e.key==='Escape' && !navMenu.hidden){ closeNav(); navToggle.focus(); }
});
document.addEventListener('click', e=>{
  if(!navMenu.hidden && !e.target.closest('.nav-mini')) closeNav();
});

initDeck('ready-deck', 'ready-dots');
initDeck('pay-deck', 'pay-dots');

switchTab(viewFromHash());

paintTagMode();   // 通信を待たずに既定（番号札を使う）を先に反映する
paintSession();
paintNet();
renderMenu();
renderCall();
renderTags();
renderKitchen();
renderReady();
renderRows();
renderFigures();
paintDesks();   // 名乗りが届く前でも「受付機を選ぶ」とだけは出しておく
paintGate();
tickSaver();
