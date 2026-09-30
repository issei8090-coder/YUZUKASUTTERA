// 番号札まわりの契約を index.html が呼ぶとおりに検証する。
// 実行: node test/tag_contract_test.mjs  (先に ./build.sh が必要)
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

const ready = new Promise((resolve) => { globalThis.onGoWasmReady = resolve; });
const go = new Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(root, 'main.wasm')), go.importObject);
go.run(instance);
await ready;

const PRICES = { plain: 250, flavor_b: 250 };
const NOW = 1790654327731;
const order = (o = {}) => goBuildOrder({
  seq: 31, items: [{ flavor: 'plain', quantity: 1 }], prices: PRICES,
  nowMs: NOW, maxPerOrder: 10, tagCount: 50, ...o,
});

console.log('\n[1] goNextTag — 札は使い回すので循環する');
check('最初は 1', goNextTag({ last: 0, tagCount: 5, inUse: [] }).tag === 1);
check('前回の次へ進む', goNextTag({ last: 3, tagCount: 5, inUse: [] }).tag === 4);
check('端まで行ったら 1 に戻る', goNextTag({ last: 5, tagCount: 5, inUse: [] }).tag === 1);
check('出ている札は飛ばす', goNextTag({ last: 5, tagCount: 5, inUse: [1, 2, 4] }).tag === 3);
{
  const full = goNextTag({ last: 2, tagCount: 5, inUse: [1, 2, 3, 4, 5] });
  check('全部出ていたら受け付けない', full.ok === false && full.tag === 0);
  check('理由を返す', typeof full.error === 'string' && full.error.length > 0);
}

console.log('\n[2] goBuildOrder — 札の割り当て');
{
  const r = order({ tag: 7 });
  check('札が番号になる', r.ok && r.order.tag === 7 && r.order.number === '#007');
  check('通し番号は札と別に残る', r.order.seq === 31);
}
check('枚数を超える札を拒否', order({ tag: 51 }).ok === false);
check('0 以下の札は通し番号にフォールバック', order({ tag: 0 }).order.number === '#031');
check('出ている札の二重発行を拒否', order({ tag: 7, inUseTags: [7] }).ok === false);

console.log('\n[3] goBuildOrder — 番号札を使わない注文');
{
  const im = order({ immediate: true, tag: 0 });
  // 飛ばすのは厨房だけ。受渡待ちから始め、受渡口で渡して代金も受け取る。
  check('厨房を飛ばして受渡待ちになる', im.ok && im.order.status === 'ready');
  check('受付では支払い済みにしない', im.ok && im.order.paid !== true);
  check('札を消費しない', !im.order.tag);
  check('番号は空', im.order.number === '');
  // 番号を出さなくても売上と在庫は通常どおり
  check('金額は計上される', im.order.price === 250);
  check('在庫は超えられない',
    order({ immediate: true, items: [{ flavor: 'plain', quantity: 3 }], remaining: { plain: 2, flavor_b: 5 } }).ok === false);
}

console.log('\n[4] goValidateLimits — 札の枚数');
check('正常値を受理', goValidateLimits({ maxPerOrder: 6, stock: { plain: 40, flavor_b: 30 }, tagCount: 50 }).ok === true);
check('0 枚を拒否', goValidateLimits({ maxPerOrder: 6, stock: { plain: 40, flavor_b: 30 }, tagCount: 0 }).ok === false);
check('上限超えを拒否', goValidateLimits({ maxPerOrder: 6, stock: { plain: 40, flavor_b: 30 }, tagCount: 1000 }).ok === false);
check('小数を拒否', goValidateLimits({ maxPerOrder: 6, stock: { plain: 40, flavor_b: 30 }, tagCount: 12.5 }).ok === false);

console.log(failures ? `\nFAIL — ${failures} 件` : '\nPASS — 番号札の契約 OK');
process.exit(failures ? 1 : 0);
