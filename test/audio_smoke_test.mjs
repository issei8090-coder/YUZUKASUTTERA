// 採用している音が、ぜんぶ合成経路を最後まで通るか。
//
// 音の失敗は無音として出るだけで、例外も出ないことが多い。
// 「鳴らないまま誰も気づかない」が実際に起きている（AudioContext を
// 鳴らすたびに new していた頃、上限に当たって以降ずっと無音だった）。
// ここでは Web Audio を型だけ真似て、各音が実際に発振器を作るところまでを見る。
// 音色の良し悪しは測れない。測れるのは「経路が切れていないこと」。
// 実行: node test/audio_smoke_test.mjs
const made = { osc: 0 };
const param = () => ({ value: 0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, linearRampToValueAtTime(){} });
const node = () => ({ connect(){}, disconnect(){} });

class Ctx {
  constructor(){ this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; }
  createBuffer(ch, len){ return { getChannelData: () => new Float32Array(len) }; }
  createDynamicsCompressor(){ return Object.assign(node(), { threshold:param(), knee:param(), ratio:param(), attack:param(), release:param() }); }
  createConvolver(){ return Object.assign(node(), { buffer: null }); }
  createGain(){ return Object.assign(node(), { gain: param() }); }
  createStereoPanner(){ return Object.assign(node(), { pan: param() }); }
  createBiquadFilter(){ return Object.assign(node(), { type:'', frequency:param(), Q:param() }); }
  createOscillator(){ made.osc++; return Object.assign(node(), { type:'', frequency:param(), detune:param(), start(){}, stop(){} }); }
  resume(){ return Promise.resolve(); }
}
globalThis.window = { AudioContext: Ctx };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

const audio = await import('../lib/audio.js');
audio.unlock();

let failures = 0;
const fail = m => { console.log(`  FAIL ${m}`); failures++; };

console.log('\n[1] 音を出せる状態になるか');
if (audio.ready()) console.log('  ok   unlock() で鳴らせる状態になった');
else fail('unlock() のあとも鳴らせる状態にならない');

console.log('\n[2] 採用している音が合成経路を通るか');
// app.js から呼んでいる音をすべて並べる。足したらここにも足す。
const SOUNDS = ['step', 'limit', 'confirm', 'next', 'paid', 'newOrder', 'call', 'error'];
for (const name of SOUNDS) {
  if (typeof audio[name] !== 'function') { fail(`${name}() が lib/audio.js に無い`); continue; }
  const before = made.osc;
  try {
    name === 'step' ? audio[name](true, 3) : audio[name]();
  } catch (e) { fail(`${name}() が投げた: ${e.message}`); continue; }
  const n = made.osc - before;
  if (n > 0) console.log(`  ok   ${name}() → 発振 ${n} 本`);
  else fail(`${name}() は音を 1 本も作らなかった（無音になる）`);
}

console.log('\n[3] app.js が呼んでいる音が実在するか');
// 定義を消したまま呼び出しだけ残ると、その場面だけが黙って無音になる。
const fs = await import('node:fs');
const js = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const used = new Set([...js.matchAll(/\baudio\.(\w+)\s*\(/g)].map(m => m[1]));
for (const name of [...used].sort()) {
  if (typeof audio[name] === 'function') console.log(`  ok   audio.${name}()`);
  else fail(`app.js が audio.${name}() を呼んでいるが lib/audio.js に無い`);
}

console.log(failures ? `\n✗ ${failures} 件` : '\n✓ 音はすべて合成できます');
process.exit(failures ? 1 : 0);
