/* ============================================================
   音。外部ファイルを持たず、その場で合成する。

   音源を持たないのは会場の回線対策でもある（読み込めずに無音、が起きない）。
   合成エンジンは chime-candidates 第7弾のものをそのまま使っている。
   音色・残響・音量の設計はそこで詰め切ってあるので、ここでは触らない。

   AudioContext は 1 つだけ作って使い回す。呼ぶたびに new すると
   ブラウザの同時生成上限（4〜6 個）に当たり、以降ずっと無音になる。
   iOS は操作を経ないと鳴らせないので、最初のタップで起こす。

   採用した音（第8弾で選定）:
     ステッパー   T4 温かい鐘
     上限         L2 半音下
     注文確定     S2 低音の風格
     支払い受取   S8 大きなうねり
     厨房の着信   K2 フロントベル二打
     お呼び出し   C5 ターン・モチーフ
     エラー       E3 短い下降
   ============================================================ */

let ctx = null, comp = null, verb = null;
let enabled = true, level = 0.45;

/* ---------- エンジン（第7弾から移植） ---------- */

/* 畳み込み用のインパルス応答をその場で作る。音源ファイルを持たずに
   本物の残響を得るための手段。ディレイを重ねる方式より濁らない。 */
function mkIR(sec, decay){
  const len = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for(let ch = 0; ch < 2; ch++){
    const d = b.getChannelData(ch);
    for(let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

function build(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return false;
  ctx = new AC();
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 24; comp.ratio.value = 4;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  comp.connect(ctx.destination);
  verb = ctx.createConvolver();
  verb.buffer = mkIR(2.6, 2.2);
  verb.connect(comp);
  return true;
}

export function unlock(){
  if(!enabled) return;
  if(!ctx && !build()) return;
  if(ctx.state === 'suspended') ctx.resume().catch(()=>{});
}
export const ready = () => !!ctx && ctx.state === 'running';
export function setEnabled(on){ enabled = !!on; }
/* 会場の騒がしさに合わせて上げ下げできるようにしておく。 */
export function setLevel(v){ level = Math.max(0, Math.min(1, Number(v) || 0)); }
export const getLevel = () => level;

const vol = () => level * 0.7;
const live = () => enabled && ctx && ctx.state === 'running';

function bus(node, wet, pan){
  let end = node;
  if(pan && ctx.createStereoPanner){
    const pn = ctx.createStereoPanner(); pn.pan.value = pan;
    node.connect(pn); end = pn;
  }
  end.connect(comp);
  if(wet){ const s = ctx.createGain(); s.gain.value = wet; end.connect(s); s.connect(verb); }
}

function toneX(o){
  if(!live()) return;
  const c = ctx, t0 = c.currentTime + (o.t || 0), d = o.d || 0.5;
  const peak = Math.max((o.p || 1) * vol(), 0.0001);
  const g = c.createGain();
  let dest = g;
  if(o.filter){
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(o.filter, t0);
    if(o.fend) flt.frequency.exponentialRampToValueAtTime(o.fend, t0 + d);
    flt.Q.value = o.fq || 0.7;
    flt.connect(g); dest = flt;
  }
  const n = o.voices || 1;
  for(let i = 0; i < n; i++){
    const os = c.createOscillator();
    os.type = o.type || 'sine';
    os.frequency.setValueAtTime(o.f, t0);
    if(o.glide) os.frequency.exponentialRampToValueAtTime(o.glide, t0 + (o.gd || d));
    if(n > 1) os.detune.value = (i - (n - 1) / 2) * (o.det || 6);
    os.connect(dest); os.start(t0); os.stop(t0 + d + 0.12);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak / Math.sqrt(n), t0 + (o.a || 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  if(o.trem){
    const lo = c.createOscillator(), lg = c.createGain();
    lo.frequency.value = o.trem.f;
    lg.gain.value = peak * (o.trem.depth || 0.35);
    lo.connect(lg); lg.connect(g.gain);
    lo.start(t0); lo.stop(t0 + d + 0.12);
  }
  bus(g, o.wet || 0, o.pan || 0);
}

function partialsX(o){
  const base = o.d || 1;
  for(const pt of o.parts){
    toneX({ f: o.f * pt[0], t: o.t || 0, d: base * (pt[2] || 1), p: (o.p || 1) * pt[1],
            a: o.a || 0.004, type: o.type || 'sine', wet: o.wet || 0, pan: o.pan || 0, trem: o.trem });
  }
}

/* ---------- 音色 ---------- */
const HARP = [[1,1,1],[2,.3,.7]];
const GLA  = [[1,1,1],[2.76,.35,.6],[5.4,.15,.4]];        // グロッケン／ガラス
const WBEL = [[1,1,1],[2,.32,.8],[2.92,.12,.5]];          // 温かい鐘
const DSK  = [[1,1,1],[2.71,.55,.7],[5.15,.3,.5],[8.2,.12,.3]]; // フロントベル

const harp = (f, t, p, pan) => partialsX({ f, parts: HARP, t, d: .9, p, wet: .55, pan: pan || 0 });
const gliss = (notes, stepT, p, pan, t0) =>
  notes.forEach((f, i) => harp(f, (t0 || 0) + i * stepT, p, pan ? (i % 2 ? pan : -pan) : 0));
const pad = (fs, o) =>
  fs.forEach(f => toneX(Object.assign({ type:'sawtooth', voices:2, det:6, a:.09 }, o, { f })));
const sub = (f, o) => toneX(Object.assign({ a:.04 }, o, { f }));
function felt(f, t, p){
  toneX({ f, t, d:1.2, p:p*.7, type:'triangle', filter:1500, a:.01, wet:.5 });
  toneX({ f:f/2, t, d:1.3, p:p*.4, a:.012, wet:.5 });
}

/* ステッパー専用。残響を .26 に落としてあるのが肝で、
   ここを他と同じ .55 にすると連打で尾が積み上がり、5 回目には濁る。 */
const tap = (parts, f, p, d, wet) =>
  partialsX({ f, parts, d: d || .42, p: p || .34, wet: wet === undefined ? .26 : wet });

/* C5 から 10 段。1 注文の上限まで昇り切る。 */
const CMAJ = [523.25, 587.33, 659.26, 698.46, 783.99, 880, 987.77, 1046.5, 1174.66, 1318.5];
const degUp = i => CMAJ[Math.min(Math.max(i, 0), CMAJ.length - 1)];

/* ---------- 採用音 ---------- */

/* T4 温かい鐘。個数に合わせて音階を昇り降りする。 */
export function step(up, lv){
  unlock();
  tap(WBEL, degUp((lv || 1) - 1), up ? .32 : .24, up ? .48 : .36);
}

/* L2 半音下。鳴るはずの音から半音下がる＝「そこではない」。 */
export function limit(){
  unlock();
  tap(HARP, 493.88, .3, .34, .2);
}

/* S2 低音の風格。6 音の上昇＋きらめき＋maj9 パッド＋低音の下支え。 */
export function confirm(){
  unlock();
  gliss([523.25, 587.33, 659.26, 783.99, 880, 1046.5], .055, .42);
  partialsX({ f:2093, parts:GLA, t:.4, d:1, p:.15, wet:.7 });
  pad([261.63, 329.63, 392, 493.88], { d:1.6, p:.13, filter:1000, a:.12, wet:.6 });
  felt(130.81, 0, .5);
  sub(65.41, { d:1.6, p:.24, wet:.3 });
}

/* S8 大きなうねり。低い音から 8 音で駆け上がる。 */
export function paid(){
  unlock();
  gliss([392, 440, 493.88, 523.25, 587.33, 659.26, 783.99, 1046.5], .06, .42, .18);
  partialsX({ f:2093, parts:GLA, t:.55, d:1.1, p:.15, wet:.72 });
  pad([196, 261.63, 293.66, 392], { d:2, p:.13, filter:900, a:.14, wet:.6 });
  sub(98, { d:1.8, p:.24, wet:.32 });
}

/* K2 フロントベル二打。厨房で最も通る。 */
export function newOrder(){
  unlock();
  partialsX({ f:1318.5, parts:DSK, d:.9,  p:.44, wet:.42 });
  partialsX({ f:1318.5, parts:DSK, t:.22, d:1.1, p:.40, wet:.45 });
}

/* C5 ターン・モチーフ。上がって回って着地する完結した節。 */
export function call(){
  unlock();
  gliss([523.25, 659.26, 587.33, 783.99], .08, .42);
  partialsX({ f:1568, parts:GLA, t:.4, d:.9, p:.1, wet:.72 });
  pad([261.63, 392, 493.88], { d:1.8, p:.11, filter:950, a:.12, wet:.6 });
}

/* E3 短い下降。行列を止めない長さに抑えてある。 */
export function error(){
  unlock();
  gliss([783.99, 659.26, 587.33, 493.88], .05, .36);
  pad([220, 293.66], { d:.9, p:.1, filter:800, a:.08, wet:.5 });
}


/* ---------- 音作りの部品を外に出す ----------
   候補ページ（chime-candidates-*.html）がこれを import して鳴らす。
   試聴用に別のエンジンを書くと「聴いた音と出荷する音が違う」が起きるため、
   本番と完全に同じ経路で鳴らせるようにしてある。 */
export const lab = { toneX, partialsX, harp, gliss, pad, sub, felt, tap, degUp,
                     HARP, GLA, WBEL, DSK, CMAJ };

/* 読み上げ（音声合成）は使わない。
   端末に入っている日本語音声は compact 版しか無いことが多く、機械的に響いて
   店の印象を下げる。speechSynthesis の出力は Web Audio を通らないため、
   こちらから音質を補正する手段も無い。番号はチャイムと画面表示で伝える。 */
