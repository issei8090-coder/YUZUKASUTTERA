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
  tagsInUse as pureTagsInUse, nextFreeTag, fallbackBuild, normalize, inSession, DEFAULT_SESSION,
  seqOf, byOrder, waitText, waitClass, elapsedSec, mmss, ageOf,
  encodeLines, decodeLines
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
/* 商品は作り置き。stock は「当日用意した総数」で、売れた分を引いた残りが売れる数。
   maxPerOrder は 1 組のお客様が買い占めないための 1 注文あたりの合計上限。 */
let limits = { maxPerOrder:10, stock:{ plain:100, flavor_b:100 }, tagCount:50 };
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
function station(){
  const m = (location.hash || '').match(/^#(?:pay|amount):([A-Za-z0-9_-]{1,16})$/);
  if(m){ try{ localStorage.setItem('payStation', m[1]); }catch(e){} return m[1]; }
  try{ return localStorage.getItem('payStation') || 'main'; }catch(e){ return 'main'; }
}
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
const tagCount    = () => limits.tagCount || 50;
const remainingOf = (k, list) => pureRemaining(list || orders, limits, k);
const headroomOf  = key => pureHeadroom(orders, limits, cart, FLAVORS, key);

/* ---------- トースト ---------- */
let toastT;
/* undo を渡すと「戻す」が付く。
   厨房の「用意した」のように、止めると行列が詰まるが押し間違いもある操作は、
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
  renderKitchen(); renderReady(); renderPay(); renderRows();
  renderFigures(); renderCall(); renderTags(); syncCart();
}

function renderMenu(){
  $('menu').innerHTML = FLAVORS.map(f=>`
    <article class="item" data-key="${f.key}">
      <div class="item-head">
        <div class="item-photo"><img src="${MARK[f.key]||''}" alt="${f.label}"></div>
        <div class="item-body">
          <h3 class="item-name">${f.label}</h3>
          <p class="item-note">${f.note||''}</p>
          <div class="price-row">
            <p class="item-price" data-price="${f.key}">${yen(prices[f.key]??f.defaultPrice)}<small>円</small>
              <span class="item-per">1${f.unit}${f.pieces?`（${f.pieces}個入り）`:''}</span></p>
          </div>
          <p class="item-stock" data-stock="${f.key}"></p>
        </div>
      </div>
      <div class="stepper">
        <button type="button" class="step" data-step="-1" data-key="${f.key}" aria-label="${f.label}を1${f.unit}減らす">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
        </button>
        <span class="qty" data-qty="${f.key}" data-zero="true" role="status" aria-label="${f.label}の数量">0<small>${f.unit}</small></span>
        <button type="button" class="step" data-step="1" data-key="${f.key}" aria-label="${f.label}を1${f.unit}増やす">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </article>`).join('');
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
    if(q){ q.innerHTML = `${n}<small>${f.unit}</small>`; q.dataset.zero = String(n===0); }
    const p = document.querySelector(`[data-price="${f.key}"]`);
    if(p) p.innerHTML = `${yen(prices[f.key] ?? f.defaultPrice)}<small>円</small>`
      + `<span class="item-per">1${f.unit}${f.pieces?`（${f.pieces}個入り）`:''}</span>`;

    const st = document.querySelector(`[data-stock="${f.key}"]`);
    if(st){
      st.textContent = soldOut ? '売り切れ' : `残り ${left}${f.unit}`;
      st.dataset.state = soldOut ? 'out' : (left <= 10 ? 'low' : 'ok');
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
  // 受付には、いまどちらの運用かだけを出す。切り替えの導線は置かない。
  const note = $('lane-note');
  if(note){
    note.textContent = useTags
      ? '番号札を使っています。'
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
let desksKnown = false;     // 名乗りが一度でも届いたか
let deskClaiming = false;   // 掴みに行っている最中
let deskBooted = false;     // 起動時の取り直しを一度だけ試す

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
  renderDeskAdmin();
}

/* 管理画面の在席表。どの受付機が起動しているかと、残ってしまった席を空ける道。 */
function renderDeskAdmin(){
  const grid = $('desk-admin');
  if(!grid) return;
  grid.innerHTML = DESKS.map(d=>{
    const on   = desksOnline[d.id];
    const mine = !!on && on.client === clientId;
    const state = !on ? '空いています'
      : mine ? '起動中（この端末）'
      : deskStale(d.id) ? '起動中（応答なし）' : '起動中';
    return `<div class="desk-cell" data-busy="${!!on}" data-mine="${mine}">
      <span class="desk-name">${d.label}${d.note ? `（${d.note}）` : ''}</span>
      <span class="desk-state">${state}</span>
      <button type="button" class="desk-free" data-act="deskfree" data-id="${d.id}"
              ${on ? '' : 'disabled'} aria-label="${d.label} を空きに戻す">空ける</button>
    </div>`;
  }).join('');
  const busy = DESKS.filter(d=>desksOnline[d.id]).length;
  const c = $('desk-count');
  if(c) c.textContent = `起動中 ${busy}台 ／ 空き ${DESKS.length - busy}台（全${DESKS.length}台）`;
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
  }catch(e){ console.error('受付機を空けられませんでした:', e); }
}

/* 席を掴む。購読の値で判定すると、2 台が同時に同じ番号を押したとき両方通る。
   トランザクションにして、後から来たほうを必ず弾く。 */
async function claimDesk(id, quiet){
  if(deskClaiming) return false;
  deskClaiming = true;
  const err = $('desk-err');
  const say = msg => { if(err){ err.textContent = msg; err.classList.add('show'); } };
  try{
    await authReady;
    const prev = myDesk;
    const r = ref(db, 'desks/' + id);
    const tx = await runTransaction(r, cur=>{
      if(cur && cur.client && cur.client !== clientId) return;   // 起動中 → 中止
      return { client: clientId, at: Date.now() };
    });
    if(!tx.committed){
      say(`${deskLabel(id)} は別の端末が起動しています。ほかの受付機を選んでください。`);
      return false;
    }
    // 繋がりが切れたら席を空ける。画面を閉じる・電池切れ・回線断のどれでも効く。
    try{ await onDisconnect(r).remove(); }catch(e){}
    if(prev && prev !== id) await releaseDesk(prev);
    myDesk = id;
    try{ localStorage.setItem('deskNo', id); }catch(e){}
    if(err){ err.textContent = ''; err.classList.remove('show'); }
    paintDesks();
    if(openEl?.id === 'm-desk') closeModal();
    if(!quiet) toast(`この端末は ${deskLabel(id)} です。`, 'info');
    return true;
  }catch(e){
    say(writeHint(e, '受付機を登録できませんでした'));
    return false;
  }finally{ deskClaiming = false; }
}

/* 受付の画面は、受付機を名乗るまで使わせない。
   誰が起動中か分からないうちは訊かない（空いている席まで「起動中」に見えてしまう）。 */
function ensureDesk(){
  if(document.body.dataset.tab !== 'order') return;
  if(myDesk || deskClaiming || !desksKnown) return;
  if(openEl && openEl.id !== 'm-desk') return;   // 別の確認が出ている間は割り込まない
  openModal('m-desk', ()=>{ setTimeout(ensureDesk, 0); });
}

/* 名乗りが届いたら、この端末が覚えている席と突き合わせる。 */
function reconcileDesk(){
  if(deskClaiming) return;
  if(myDesk){
    const on = desksOnline[myDesk];
    if(on && on.client === clientId) return;     // そのまま
    // 管理画面から空けられた／別の端末に取られた。名乗りを捨てて選び直させる。
    dropDisconnect(myDesk);
    myDesk = null;
    try{ localStorage.removeItem('deskNo'); }catch(e){}
    paintDesks();
    toast('この端末の受付機が空きに戻されました。もう一度選んでください。');
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
       && remembered && DESKS.some(d=>d.id===remembered) && !deskTaken(remembered)){
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

/* 名乗りの時刻を書き直す。onDisconnect が届かなかった席を
   管理画面で「応答なし」として見分けられるようにするため。 */
setInterval(()=>{
  if(!myDesk) return;
  update(ref(db,'desks/'+myDesk), { at: Date.now() }).catch(()=>{});
}, 60000);

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
  d.textContent = padValue || '—';
  d.dataset.empty = String(padValue === '');
  $('pad-ok').disabled = padValue === '';
}
/* 次に使える札を先に入れておく。受付係が実際に取った札と違えば打ち直せる。
   毎回ゼロから打たせるより速く、打ち間違いも減る。 */
function padReset(){
  const suggest = nextFreeTag(lastIssuedTag(), tagCount(), tagsInUse(orders));
  padValue = suggest > 0 ? String(suggest) : '';
  padErr('');
  padRender();
}

// 直近に出した札。次の提案はこの続きから探す。
function lastIssuedTag(){
  let last = 0, newest = -1;
  for(const o of orders){
    if(o.tag > 0 && (o.createdMs || 0) > newest){ newest = o.createdMs || 0; last = o.tag; }
  }
  return last;
}

function padSubmit(){
  const n = tagCount();
  const t = parseInt(padValue, 10);
  if(!Number.isFinite(t) || t < 1 || t > n) return padErr(`1〜${n} の番号を入れてください`);
  if(tagsInUse().includes(t))              return padErr(`${t}番はまだお渡し中です`);

  // テンキーの「決定」は押し間違えやすいので、最後に一度だけ確かめる。
  pendingPlace = t;
  const total = cartItems().reduce((sum,i)=>sum+i.qty*i.unitPrice, 0);
  $('place-sub').innerHTML = `番号札 <b>${t}</b> 番　合計 <b>${yen(total)}</b> 円`;
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
      const snap = await get(ref(db, 'orders'));
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
    const req = { items, prices, nowMs, maxPerOrder: limits.maxPerOrder, remaining,
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

    const seq = await nextSeq();
    watchLap(w, '採番');
    const built = build({ ...req, seq });
    if(!built.ok){ closeModal(); toast(built.error || '注文を作成できませんでした。'); return; }

    await tracked(set(ref(db, built.path), built.order));
    watchLap(w, '書き込み');
    closeModal();
    if(soundOn()) audio.confirm();
    showThanks(built.order);
    cart = {}; syncCart();
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
  // 札なしの注文は受渡口へ回る。代金もそこで受け取るので、受付では受け取らない。
  // ここを書かないと、受付係が現金を受け取ってしまい二重取りになる。
  $('done-next').textContent = o.number
    ? 'お呼び出しまで少々お待ちください。'
    : 'お渡し口でお品物とお会計をご用意しております。';
  openModal('m-done');
  // 受け付けが済んだ合図。番号が出た瞬間にだけ、短く散らす。
  requestAnimationFrame(()=>bloom($('done-sheet'), 16));
  setTimeout(()=>{ if(openEl && openEl.id === 'm-done') closeModal(); }, 3500);
}
$('m-done').addEventListener('click', closeModal);

/* ---------- 通知音 ----------
   音は lib/audio.js が持つ。ここは「鳴らすかどうか」だけを決める。

   旧実装は鳴らすたびに AudioContext を new していた。ブラウザの同時生成上限
   （4〜6 個）に当たると以降ずっと無音になり、しかも例外を握り潰していたので
   誰も気づけなかった。context は 1 つを使い回す。

   iOS は操作を経ていない AudioContext を動かさない。厨房・呼び出し・金額表示は
   誰も触らない端末なので、最初の操作で必ず起こしにいく。 */
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
function paintNet(){
  const el = $('net-state');
  if(!el) return;
  el.hidden = online && inFlight === 0;
  el.innerHTML = online
    ? `送信中の操作が <b>${inFlight}</b> 件あります。`
    : `オフライン：未送信 <b>${inFlight}</b> 件。送信が済むまでページを閉じないでください。`;
}
/* .info/connected は認証不要。authReady の内側に置くと、
   オフラインでサインインが返らない間オフライン表示まで出なくなる。 */
onValue(ref(db,'.info/connected'), snap=>{
  online = snap.val() === true;
  paintNet();
});

/* ---------- 金額表示 ----------
   支払い口で選んだ注文の金額を、お客様に向けた別の端末へ出す。

   配信先は支払い口ごとに分ける。1 本の共有ノードにすると、支払い口を
   2 箇所にした瞬間に互いの金額を上書きし合う。既定は 'main'、
   URL の #pay:2 / #amount:2 で 2 番目の口になる。

   時刻の比較はサーバー時刻で行う。端末の時計がずれていると、
   「一度も表示されない」か「永久に消えない」のどちらかになる。 */
const AMOUNT_HOLD_MS = 10 * 60 * 1000;
let amountShown = null, amountTimer = null;
let serverSkew = 0;   // サーバー時刻 − この端末の時刻
const nowServer = () => Date.now() + serverSkew;

function renderAmount(){
  const live = $('amount-live'), idle = $('amount-idle');
  if(!live || !idle) return;
  clearTimeout(amountTimer);

  const d = amountShown;
  const age = d?.at ? nowServer() - d.at : Infinity;
  const fresh = !!d && d.amount > 0 && age < AMOUNT_HOLD_MS;

  live.classList.toggle('hidden', !fresh);
  idle.classList.toggle('hidden', !!fresh);
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
const RULES_VERSION = 'v7';
(async ()=>{
  try{
    await get(ref(db, 'rulesVersion/' + RULES_VERSION));
  }catch(e){
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
   「困ってから」ではなく「困る前」に気づける位置に置いている。 */

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
        ${(o.items||[]).map(i=>`<li><span class="kds-qty">${i.quantity}</span><span class="kds-name">${shortLabel(i.flavor)}</span></li>`).join('')}
      </ul>
      <button type="button" class="kds-bump" data-act="ready" data-id="${o.id}"
        aria-label="${numOf(o)} を受渡待ちにする">用意した</button>
    </article>`;
  }).join('');

  seenTickets = new Set(list.map(o => o.id));
  $('kitchen-list').classList.toggle('hidden', list.length === 0);
  $('kitchen-empty').classList.toggle('hidden', list.length > 0);

  // 調理者が最初に見るべきは「いま用意する数」。
  // 以前ここに出していた「残り」は、まだ売れる数＝受付側の都合で、
  // 目の前の仕事量ではなかった。焼き待ちを主役にし、残りは焼き足しの合図として添える。
  const todo = {};
  for(const f of FLAVORS) todo[f.key] = 0;
  for(const o of list) for(const i of (o.items||[])) {
    if(i.flavor in todo) todo[i.flavor] += i.quantity || 0;
  }
  $('queue').innerHTML = FLAVORS.map(f=>{
    const left = remainingOf(f.key);
    const n = todo[f.key];
    return `
    <div class="kds-batch-cell" data-todo="${n > 0}"
         data-zero="${left === 0}" data-low="${left > 0 && left <= 10}">
      <span class="kds-batch-n">${n}</span>
      <span class="kds-batch-name">${f.short || f.label}</span>
      <span class="kds-batch-todo">${f.unit} 焼き待ち</span>
      <span class="kds-batch-left">${left === 0
        ? 'この先は売り切れです'
        : `この先あと <b>${left}</b>${f.unit} 売れます`}</span>
    </div>`;
  }).join('');

  $('kds-tickets').textContent = list.length;
  tickKitchen();
  // 読み上げ領域は厨房を開いているときだけ更新する。受付端末でも書き換えると、
  // お客様に向いた画面で厨房の件数がずっと読み上げられ続ける。
  if(document.body.dataset.tab === 'kitchen'){
    $('live').textContent = `未処理 ${list.length}件。残り `
      + FLAVORS.map(f=>`${f.short || f.label} ${remainingOf(f.key)}${f.unit}`).join('、');
  }
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

  const list = all
    .filter(o => readyFilter === 'all' || o.status === readyFilter)
    .sort((a,b)=> (READY_RANK[a.status] - READY_RANK[b.status]) || byOrder(a,b));

  // 未収＝まだ代金をもらっていない注文。中止以外のすべてを数える。
  const unpaid = all.filter(o=>!o.paid);

  paintList($('ready-list'), list.map(o=>{
    const sec  = elapsedSec(o.createdMs);
    const due  = !o.paid;
    const prep = o.status === 'pending';
    const done = o.status === 'completed';
    // 渡したのに未払い＝取りはぐれ。支払い口と同じく赤く出し、ここでも回収できるようにする。
    const lost = done && due;
    const amount = yen(o.price||0);
    // 時計の色は「まだ渡していない注文」にだけ意味がある。
    const age = done ? 'ok' : ageOf(sec);
    const state = prep ? 'ご用意中' : done ? (lost ? 'お渡し済み・未払い' : 'お渡し済み') : '';

    // 押すところはカード 1 枚につき 1 つ。状態ごとに「普通の道」だけを大きく出す。
    const actions = prep
      // ご用意中は見るだけ。厨房が「用意した」を押すまで渡せない。
      ? ''
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
               ${o.number ? `<button type="button" class="ops-sub" data-act="flash" data-id="${o.id}">呼ぶ</button>` : ''}
               <button type="button" class="ops-sub" data-act="done" data-id="${o.id}">未払いのまま渡す</button>
             </div>`
          : `<button type="button" class="ops-do" data-act="done" data-id="${o.id}"
                     aria-label="${numOf(o)} を渡した">渡した</button>
             ${o.number ? `<div class="ops-row">
               <button type="button" class="ops-sub" data-act="flash" data-id="${o.id}">呼ぶ</button>
             </div>` : ''}`;

    return `
    <article class="ops-card" id="rc-${o.id}" data-state="${o.status}" data-lost="${lost}"
             data-ms="${o.createdMs||0}" data-age="${age}" data-wait="${!done}"
             aria-label="${numOf(o)}${state ? ' ' + state : ''}${due ? ` 未収 ${amount}円` : ''}">
      <div class="ops-head">
        <span class="ops-num">${numOf(o)}</span>
        ${done
          ? `<span class="ops-state" data-kind="done">${state}</span>`
          : `<span class="ops-timer">${o.createdMs ? mmss(sec) : '—'}</span>`}
      </div>
      ${prep ? '<span class="ops-state" data-kind="prep">ご用意中</span>' : ''}
      ${opsLines(o)}
      ${due ? `<p class="ops-amount">${amount}<small>円</small></p>` : ''}
      ${actions}
    </article>`;
  }).join(''));

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
  $('ready-count').textContent = count.ready;
  $('ready-prep').textContent  = count.pending;
  // 未収は他の端末の操作で増減する。0 のときは出さない。
  const dueBadge = $('ready-due');
  if(dueBadge){
    dueBadge.hidden = unpaid.length === 0;
    $('ready-unpaid').textContent = unpaid.length;
  }
  tickReady();
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
   厨房が「用意した」を押すと自動で呼び出しになる（changeStatus が calledAt を
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
  const ready = orders.filter(o=>o.status === 'ready' && o.number).sort(byOrder);
  $('call-grid').innerHTML = ready.map(o=>
    `<span class="call-num" data-called-at="${o.calledAt||0}">${o.number}</span>`).join('');
  $('call-grid').classList.toggle('hidden', ready.length === 0);
  $('call-empty').classList.toggle('hidden', ready.length > 0);
  $('call-pending').textContent = orders.filter(o=>o.status === 'pending').length;
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
    clearAmount();
  }

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
          <button type="button" class="ops-sub" data-act="paydone" data-id="${o.id}">受け取って渡した</button>
        </div>` : ''}`}
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
  $('pay-sum').textContent   = yen(allUnpaid.reduce((n,o)=>n+(o.price||0), 0));
  const lw = $('pay-lost-wrap');
  if(lw){
    lw.hidden = lost.length === 0;
    $('pay-lost').textContent = lost.length;
  }

  $('paid-list').innerHTML = paid.map(o=>`
    <div class="ops-paid-row">
      <span class="ops-paid-num">${numOf(o)}</span>
      <span class="ops-paid-yen">${yen(o.price||0)}円</span>
      <button type="button" class="ops-mini" data-act="unpay" data-id="${o.id}" data-num="${numOf(o)}"
              aria-label="${numOf(o)} を未払いに戻す">未払いに戻す</button>
    </div>`).join('');
  $('paid-empty').classList.toggle('hidden', paid.length>0);
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
        ${o.status!=='cancelled' && o.paid ? `<button type="button" class="mini" data-act="unpay" data-id="${o.id}" data-num="${o.number}" aria-label="${o.number} を未払いに戻す">未払いに戻す</button>`:''}
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
    ...FLAVORS.map(f=>[`${f.label} 残り`, `${remainingOf(f.key)}<small>${f.unit}</small>`]),
    // 受注額と手元の現金は一致しない。締めで照合できるよう必ず分けて出す。
    ['受注額',      `${yen(s.totalSales||0)}<small>円</small>`],
    ['受取済み',    `${yen(s.paidSales||0)}<small>円</small>`],
    ['未収',        `${yen(s.unpaidSales||0)}<small>円</small>`],
    ['お渡し済み',  `${s.completedPacks||0}<small>カップ</small>`],
    ['未お渡し',    `${s.pendingPacks||0}<small>カップ</small>`],
    ['注文数',      `${s.totalOrders||0}<small>件</small>`],
    // 渡したのに未払い＝取りはぐれ。締めで真っ先に見る数字なので独立して出す。
    ['渡したのに未払い', `${yen(s.unpaidDeliveredSales||0)}<small>円 / ${s.unpaidDeliveredOrders||0}件</small>`],
    ['平均客単価',  `${yen(s.avgOrderYen||0)}<small>円</small>`]
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
  $('unpaid-total').innerHTML = `${yen(o.price||0)}<small>円</small>`;
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
    setPaid(id, false).then(ok=>{
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
  showAmount(o);          // お客様側の端末に金額を出す
  renderPay();
}

/* 会計をやめる。お客様の前に金額を出しっぱなしにしない。 */
function cancelCollect(){
  if(!collecting) return;
  collecting = null;
  clearAmount();
  renderPay();
}

async function confirmCollect(){
  const c = collecting;
  if(!c) return;
  const o = orders.find(x=>x.id===c.id);
  const amount = o ? yen(o.price||0) : '';
  collecting = null;
  clearAmount();
  renderPay();
  if(await setPaid(c.id, true)){
    if(soundOn()) audio.paid();
    if(c.alsoHandOver) changeStatus(c.id,'ready','completed');
    // 会計中のカードは押した時点で一覧から消える。何を記録したのかを
    // 番号と金額で言い直し、その場から戻せるようにする。
    cashDone(`${numOf(o)} ${amount}円 受け取りました`, c.id, c.alsoHandOver);
  }
}

/* 未払い確認ダイアログの対象。モーダルを閉じたら必ず捨てる。 */
let pendingHandOver = null;

$('unpaid-back').addEventListener('click', ()=>{ pendingHandOver = null; closeModal(); });

$('unpaid-take').addEventListener('click', async ()=>{
  const id = pendingHandOver; pendingHandOver = null; closeModal();
  if(!id) return;
  if(await setPaid(id, true)) changeStatus(id,'ready','completed');
});

$('unpaid-skip').addEventListener('click', ()=>{
  const id = pendingHandOver; pendingHandOver = null; closeModal();
  if(id) changeStatus(id,'ready','completed');
});

/* 支払いは受渡ステータスとは独立した軸。
   受付・支払い口・受渡口のどこで受け取るか決まっていないため、
   どの画面からでも打てる。打ち間違いの取り消しも認める（現金と合わなくなるため）。 */
async function setPaid(id, next){
  let ng = null;
  try{
    await authReady;
    const tx = await tracked(runTransaction(ref(db,'orders/'+id), cur=>{
      ng = null;
      if(cur === null){ ng = '注文が見つかりません'; return; }
      const now = !!cur.paid;
      if(window.wasmReady && window.goSetPaid){
        const r = window.goSetPaid(now, next, cur.status || 'pending');
        if(!r.valid){ ng = r.reason; return; }
      }else if(now === next){
        ng = next ? 'すでに支払い済みです' : 'すでに未払いです'; return;
      }
      cur.paid = next;
      if(next) cur.paidMs = Date.now();
      else delete cur.paidMs;
      cur.updatedMs = Date.now();
      return cur;
    }));
    if(ng){ toast(ng); return false; }
    if(!tx.committed){ toast('支払いを記録できませんでした。もう一度お試しください。'); return false; }
    return true;
  }catch(e){
    console.error(e);
    toast(writeHint(e, '支払いを記録できませんでした'));
    return false;
  }
}

/* 呼び出し表示で目立たせる。CALL_HOLD_MS の間だけ強調される。 */
const CALL_HOLD_MS = 40000;
async function callOrder(id){
  try{
    await authReady;
    await update(ref(db,'orders/'+id), { calledAt: Date.now() });
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
      cur.status = to;
      // 受渡待ちになった時点で呼び出しも済ませる。別に「呼ぶ」を押させると、
      // 焼き上げてから呼ぶまでの間が人の気づき待ちになる。
      // ここで書けば writer は「用意した」を押した 1 台だけで、書き込みも 1 回。
      if(to === 'ready' && !cur.calledAt) cur.calledAt = Date.now();
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
    case 'ready': {
      const o = orders.find(x=>x.id===id);
      changeStatus(id,'pending','ready');
      // 確認で止めると行列が詰まる。止めずに、後から取り消せるようにする。
      // 取り消せないと、押し間違いを直すために別の画面まで行く必要があった。
      toast(`${numOf(o)} を受渡待ちにしました`, 'info',
            ()=>changeStatus(id,'ready','pending'), 7000);
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
      setPaid(id, true).then(ok=>{ if(ok && soundOn()) audio.paid(); });
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
      setPaid(id, true).then(ok=>{
        unlockTap(b, id);
        if(!ok) return;                       // 支払いを記録できなければ渡さない
        if(soundOn()) audio.paid();
        changeStatus(id,'ready','completed');
        // 現金を受け取った記録が残ったことを、音とは別に目でも示す。
        // 音は切れる（soundOn が false・周りがうるさい）ので、これが唯一の合図。
        cashDone(`${numOf(o)} ${amount}円 受け取って渡しました`, id, true);
      });
      break;
    }
    case 'collect-ok':     confirmCollect(); break;
    case 'collect-cancel': cancelCollect(); break;
    case 'unpay':
      ask({
        title: '支払いを「未払い」に戻しますか？',
        sub: `${b.dataset.num||''} の記録を未払いに戻します。`,
        warn: 'お客様に現金をお返しする場合は、忘れずに行ってください。',
        onYes: ()=>setPaid(id, false)
      });
      break;

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
    // 管理画面から受付機を空ける。電池切れなどで onDisconnect が届かず、
    // 「起動中」のまま残った席を手で戻すための逃げ道。
    case 'deskfree': {
      const d = DESKS.find(x=>x.id===id);
      const mine = desksOnline[id]?.client === clientId;
      ask({
        title: `${d?.label||''} を空けますか？`,
        sub: 'その受付機がまだ使われている場合、受付の途中で選び直すことになります。',
        warn: mine ? 'これはこの端末です。空けると、この端末でもう一度選び直します。' : '',
        onYes: async ()=>{
          await releaseDesk(id, true);
          if(mine){
            myDesk = null;
            try{ localStorage.removeItem('deskNo'); }catch(e){}
            paintDesks();
            ensureDesk();
          }
        }
      });
      break;
    }
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
function paintSession(){
  const el = $('session-name');
  if(!el) return;
  const live = allOrders.filter(o => inSession(o, session));
  el.textContent = session === DEFAULT_SESSION
    ? '営業回：既定（仕切りなし）'
    : `営業回：${session}`;
  const sub = $('session-sub');
  if(sub) sub.textContent =
    `この回の注文 ${live.length}件 ／ これより前の記録 ${allOrders.length - live.length}件（消さずに残っています）`;
}

$('session-new')?.addEventListener('click', ()=>{
  ask({
    title: '締めて、次の回を始めますか？',
    sub: '今の回のCSVを保存してから切り替えます。売上・在庫・番号札の集計が 0 から始まります。',
    warn: '注文は消えません。これまでの記録はそのまま残ります。',
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
      if(!saveCSV('orders')) return;
      // ダウンロードを続けて 2 回起こすと、2 枚目が黙って落ちない端末がある。
      // 1 枚目が保存ダイアログを抜けるまで少し待つ。
      await new Promise(r=>setTimeout(r, 800));
      if(!saveCSV('summary')) return;
      const d = new Date(Date.now() + 9*3600*1000);   // JST で名前を付ける
      const id = d.toISOString().slice(0,16).replace(/[-:T]/g,'').replace(/(\d{8})(\d{4})/,'$1-$2');
      try{
        await authReady;
        await tracked(set(ref(db,'config/session'), id));
        toast(`新しい営業回 ${id} を始めました。`, 'info');
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
  const day = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `${kind === 'summary' ? 'summary' : 'orders'}_${session}_${day}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
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
  // 受付機を訊くのは受付の画面だけ。他の画面（厨房・受渡・表示）は名乗らない。
  if(t === 'order') ensureDesk();
  else if(openEl?.id === 'm-desk') closeModal();
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
