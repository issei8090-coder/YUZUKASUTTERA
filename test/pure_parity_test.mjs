// lib/pure.js の fallbackBuild が、Go の order.BuildOrder と同じ判断をするか検証する。
//
// WASM が読めないとき受付を止めないために、同じ規則が 2 つの言語で書かれている。
// 二重実装は片方だけ直す事故を生むので、ここで必ず突き合わせる。
// 実行: node test/pure_parity_test.mjs  (先に ./build.sh が必要)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { fallbackBuild } from '../lib/pure.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.performance ??= (await import('node:perf_hooks')).performance;
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
vm.runInThisContext(fs.readFileSync(path.join(root, 'wasm_exec.js'), 'utf8'), { filename: 'wasm_exec.js' });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};

const ready = new Promise((r) => { globalThis.onGoWasmReady = r; });
const go = new Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(root, 'main.wasm')), go.importObject);
go.run(instance);
await ready;

const FLAVORS = goLabels().flavors;
const prices = { plain: 250, flavor_b: 300 };
const NOW = 1_700_000_000_000;

// 実際に起きる分岐を一通り。「通る」ケースだけでなく、
// 断り方（文言ではなく可否）が一致することが大事。
const CASES = [
  ['単品', { items: [{ flavor: 'plain', quantity: 2 }] }],
  ['複数商品', { items: [{ flavor: 'plain', quantity: 2 }, { flavor: 'flavor_b', quantity: 1 }] }],
  ['同じ商品が2行', { items: [{ flavor: 'plain', quantity: 1 }, { flavor: 'plain', quantity: 2 }] }],
  ['0個を含む', { items: [{ flavor: 'plain', quantity: 3 }, { flavor: 'flavor_b', quantity: 0 }] }],
  ['売り切れ', { items: [{ flavor: 'plain', quantity: 1 }], remaining: { plain: 0, flavor_b: 5 } }],
  ['残りを超える', { items: [{ flavor: 'plain', quantity: 6 }], remaining: { plain: 3, flavor_b: 5 } }],
  ['1注文の上限超え', { items: [{ flavor: 'plain', quantity: 8 }, { flavor: 'flavor_b', quantity: 5 }] }],
  ['未知の商品', { items: [{ flavor: 'nope', quantity: 1 }] }],
  ['単価なし', { items: [{ flavor: 'plain', quantity: 1 }], prices: { flavor_b: 300 } }],
  ['商品が空', { items: [] }],
  ['札を指定', { items: [{ flavor: 'plain', quantity: 1 }], tag: 7, tagCount: 50 }],
  ['札が範囲外', { items: [{ flavor: 'plain', quantity: 1 }], tag: 99, tagCount: 50 }],
  ['札が使用中', { items: [{ flavor: 'plain', quantity: 1 }], tag: 7, tagCount: 50, inUseTags: [7] }],
  // 札なし（厨房を飛ばす）。画面は paid を常に false で渡すので、そちらで突き合わせる。
  ['札なし', { items: [{ flavor: 'plain', quantity: 2 }], immediate: true, paid: false }],
  ['札なし・受付で受取済み', { items: [{ flavor: 'plain', quantity: 2 }], immediate: true, paid: true }],
  ['営業回つき', { items: [{ flavor: 'plain', quantity: 1 }], session: 'r2' }],
  ['採番が不正', { items: [{ flavor: 'plain', quantity: 1 }], seq: 0 }],
];

console.log('\n[parity] lib/pure.js fallbackBuild  vs  Go order.BuildOrder');
for (const [name, over] of CASES) {
  const req = {
    seq: 12, nowMs: NOW, prices, maxPerOrder: 10,
    remaining: { plain: 100, flavor_b: 100 },
    tagCount: 50, inUseTags: [], session: 'default',
    ...over,
  };
  const goRes = goBuildOrder(req);
  const jsRes = fallbackBuild({ ...req, flavors: FLAVORS });

  if (goRes.ok !== jsRes.ok) {
    check(name, false, `可否が違う go=${goRes.ok} js=${jsRes.ok} (go: ${goRes.error} / js: ${jsRes.error})`);
    continue;
  }
  if (!goRes.ok) { check(`${name}（どちらも拒否）`, true); continue; }

  // 記録として残る値が一致すること。文言は一致させない（別の言語で書くため）。
  const KEYS = ['id', 'seq', 'tag', 'number', 'quantity', 'price', 'status', 'paid', 'session'];
  const diff = KEYS.filter(k => JSON.stringify(goRes.order[k]) !== JSON.stringify(jsRes.order[k]));
  const gi = JSON.stringify(goRes.order.items);
  const ji = JSON.stringify(jsRes.order.items);
  check(name, diff.length === 0 && gi === ji && goRes.path === jsRes.path,
    diff.length ? `差分=${diff.map(k => `${k}: go=${goRes.order[k]} js=${jsRes.order[k]}`).join(', ')}`
                : (gi !== ji ? `明細が違う\n    go=${gi}\n    js=${ji}` : `path go=${goRes.path} js=${jsRes.path}`));
}

console.log(failures ? `\n✗ ${failures} 件ずれています` : '\n✓ 2 つの実装は一致しています');
process.exit(failures ? 1 : 0);
