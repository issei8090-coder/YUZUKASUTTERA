// 回帰テスト: onGoWasmReady が例外を投げても Go ランタイムが死なないこと。
//
// 実際に起きた事故の再現。onGoWasmReady 内で JSON.parse(オブジェクト) が投げ、
// その例外が Go の main ゴルーチンまで伝播して
//   panic: "[object Object]" is not valid JSON
// で Go が終了。以後どの画面でも集計と CSV が完全に死んでいた。
//
// 実行: node test/wasm_ready_guard_test.mjs  (先に ./build.sh が必要)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.performance ??= (await import('node:perf_hooks')).performance;
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
vm.runInThisContext(fs.readFileSync(path.join(root, 'wasm_exec.js'), 'utf8'), { filename: 'wasm_exec.js' });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};

// 事故と同じ形の例外を投げるコールバックを仕掛ける。
let called = false;
globalThis.onGoWasmReady = () => {
  called = true;
  JSON.parse({ not: 'json' }); // TypeError/SyntaxError を投げる
};

const go = new Go();
let exited = false;
const exitPromise = go.exit;
const { instance } = await WebAssembly.instantiate(
  fs.readFileSync(path.join(root, 'main.wasm')),
  go.importObject,
);
go.run(instance).then(() => { exited = true; });

// Go 側が recover して select{} まで到達するのを待つ（マイクロタスクを回す）。
for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));

console.log('\n[回帰] onGoWasmReady が例外を投げたあとも Go が生きていること');
check('コールバックは実際に呼ばれた', called === true);
check('go.run() が解決していない', exited === false, 'ランタイムが終了した');

// 関数オブジェクトの存在だけでは判定にならない。ランタイムが死んでいても
// typeof は 'function' のままで、呼んだ瞬間に "Go program has already exited" が飛ぶ。
// ここで捕まえないと Node ごと落ちて CI の出力が読めなくなる。
const call = (name, fn) => {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: e.message }; }
};

const orders = [
  { id: 'order_000001_1', seq: 1, number: '#001', items: [{ flavor: 'plain', quantity: 2, unitPrice: 300, price: 600 }], quantity: 2, price: 600, status: 'completed', createdAt: '10:00:00', createdMs: 1790654327731 },
];

const stats = call('goCalculateStats', () => globalThis.goCalculateStats(orders));
check('例外のあとでも集計できる (totalSales=600)',
  stats.ok && stats.value?.totalSales === 600,
  stats.ok ? JSON.stringify(stats.value) : stats.error);

const csv = call('goGenerateOrdersCSV', () => globalThis.goGenerateOrdersCSV(orders));
check('例外のあとでも CSV を生成できる',
  csv.ok && csv.value instanceof Uint8Array && csv.value.length > 0,
  csv.ok ? '' : csv.error);

console.log(`\n${failures === 0 ? 'PASS — Go は JS の例外で死なない' : `FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
