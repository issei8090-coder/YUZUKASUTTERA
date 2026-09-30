// index.html が呼ぶとおりに main.wasm を叩き、契約が守られているか検証する。
// 実行: node test/wasm_contract_test.mjs  (先に ./build.sh が必要)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// wasm_exec.js は globalThis に Go を生やす古典スクリプト。
globalThis.performance ??= (await import('node:perf_hooks')).performance;
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
vm.runInThisContext(fs.readFileSync(path.join(root, 'wasm_exec.js'), 'utf8'), { filename: 'wasm_exec.js' });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};

const ready = new Promise((resolve) => { globalThis.onGoWasmReady = resolve; });

const go = new Go();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(root, 'main.wasm')), go.importObject);
go.run(instance);
await ready;

console.log('\n[1] goLabels — 商品マスタ・数量上限');
{
  const r = goLabels();
  check('ok:true', r.ok === true);
  check('flavors に plain と flavor_b', r.flavors.map((f) => f.key).join(',') === 'plain,flavor_b', JSON.stringify(r.flavors));
  check('limits.maxQuantity = 10', r.limits.maxQuantity === 10);
  check('statuses に 4 状態', Object.keys(r.statuses).length === 4);
}

console.log('\n[2] goUpdateOrderStatus — 状態遷移');
{
  check('pending→ready は許可', goUpdateOrderStatus('pending', 'ready').valid === true);
  check('pending→completed は拒否', goUpdateOrderStatus('pending', 'completed').valid === false);
  check('completed→ready (戻す) は許可', goUpdateOrderStatus('completed', 'ready').valid === true);
  check('cancelled→pending (復活) は許可', goUpdateOrderStatus('cancelled', 'pending').valid === true);
  const bad = goUpdateOrderStatus('pending', 'completed');
  check('拒否時に理由が入る', typeof bad.reason === 'string' && bad.reason.length > 0, bad.reason);
  check('不正な引数でも落ちない', goUpdateOrderStatus(undefined, null).valid === false);
}

console.log('\n[3] goBuildOrder — 注文の組み立て');
const prices = { plain: 300, flavor_b: 350 };
let built;
{
  built = goBuildOrder({ seq: 7, flavor: 'flavor_b', quantity: 2, prices, nowMs: 1790654327731 });
  check('ok:true', built.ok === true, built.error);
  check('number = #007', built.order.number === '#007');
  check('金額 = 700', built.order.price === 700);
  check('status = pending', built.order.status === 'pending');
  check('path と id が一致', built.path === `orders/${built.order.id}`);
  check('id は seq 起点', built.order.id === 'order_000007_1790654327731', built.order.id);

  const ng = goBuildOrder({ seq: 1, flavor: 'plain', quantity: 99, prices, nowMs: 1 });
  check('数量超過を拒否', ng.ok === false && !!ng.error, JSON.stringify(ng));
  check('壊れた引数でも落ちない', goBuildOrder('not json').ok === false);
}

console.log('\n[4] goValidatePrices — 単価検証');
{
  check('正常値を受理', goValidatePrices({ plain: 300, flavor_b: 350 }).ok === true);
  check('0円を拒否', goValidatePrices({ plain: 0, flavor_b: 350 }).ok === false);
  check('マイナスを拒否', goValidatePrices({ plain: -1, flavor_b: 350 }).ok === false);
  check('小数を拒否', goValidatePrices({ plain: 300.5, flavor_b: 350 }).ok === false);
  check('欠落を拒否', goValidatePrices({ plain: 300 }).ok === false);
  check('NaN を拒否', goValidatePrices({ plain: NaN, flavor_b: 350 }).ok === false);
}

// index.html の実データ形状（Object.entries(...).map で組み立てたもの）
const orders = [
  { id: 'order_000001_1000', seq: 1, number: '#001', flavor: 'plain',    quantity: 2, unitPrice: 300, price: 600, status: 'completed', createdAt: '10:00:00', createdMs: 1790654327731 },
  { id: 'order_000002_2000', seq: 2, number: '#002', flavor: 'flavor_b', quantity: 1, unitPrice: 350, price: 350, status: 'ready',     createdAt: '10:01:00', createdMs: 1790654328731 },
  { id: 'order_000003_3000', seq: 3, number: '#003', flavor: 'plain',    quantity: 3, unitPrice: 300, price: 900, status: 'pending',   createdAt: '10:02:00', createdMs: 1790654329731 },
  { id: 'order_000004_4000', seq: 4, number: '#004', flavor: 'flavor_b', quantity: 2, unitPrice: 350, price: 700, status: 'cancelled', createdAt: '10:03:00', createdMs: 1790654330731 },
];

console.log('\n[5] goCalculateStats — 集計');
{
  const s = goCalculateStats(orders);
  check('戻り値は JS オブジェクト（文字列ではない）', typeof s === 'object' && s !== null, typeof s);
  check('totalSales = 1850 (キャンセル除く)', s.totalSales === 1850, String(s.totalSales));
  check('completedPacks = 2', s.completedPacks === 2);
  check('pendingPacks = 4 (未受渡 pending+ready)', s.pendingPacks === 4, String(s.pendingPacks));
  check('queueByFlavor.plain = 3 (調理待ちのみ)', s.queueByFlavor.plain === 3);
  check('plainCompleted:flavorBCompleted = 2:0', s.plainCompleted === 2 && s.flavorBCompleted === 0);
  check('cancelledSales = 700', s.cancelledSales === 700);
  check('空配列でも落ちない', goCalculateStats([]).totalSales === 0);
  check('null でも落ちない', goCalculateStats(null).totalSales === 0);
  // 旧 index.html の呼び方（JSON 文字列渡し）も引き続き通ること
  check('JSON 文字列を渡しても動く', goCalculateStats(JSON.stringify(orders)).totalSales === 1850);
}

console.log('\n[6] goGenerateOrdersCSV / goGenerateSummaryCSV');
{
  const bytes = goGenerateOrdersCSV(JSON.stringify(orders));
  check('Uint8Array が返る', bytes instanceof Uint8Array, typeof bytes);
  check('UTF-8 BOM 付き', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  const text = Buffer.from(bytes).toString('utf8');
  check('CRLF 改行', text.includes('\r\n'));
  check('ヘッダー行', text.includes('注文番号'));
  // 商品名は goLabels() のマスタから取る（商品名の変更でテストが壊れないように）。
  const plainLabel = goLabels().flavors.find((f) => f.key === 'plain').label;
  check('日本語が化けない', text.includes(plainLabel), `期待:${plainLabel} / 実際:${text.slice(0, 120)}`);
  check('受付順に並ぶ', text.indexOf('#001') < text.indexOf('#004'));
  check('キャンセルも明細に残る', text.includes('キャンセル'));

  const sum = Buffer.from(goGenerateSummaryCSV(orders)).toString('utf8');
  // 「総売上金額」は受注額と受取額のどちらとも読めるため「受注金額」に改名した。
  check('サマリに受注金額', sum.includes('受注金額(円),1850'), sum.split('\r\n')[1]);
  check('サマリに現金の照合', sum.includes('受取済み金額(円)') && sum.includes('未収金額(円)'), sum.slice(0, 200));
}

console.log('\n[7] goNextStatuses — 遷移候補');
{
  const r = goNextStatuses('ready');
  check('ready から 3 候補', r.statuses.length === 3, JSON.stringify(r.statuses));
  check('各候補にボタン文言', r.statuses.every((s) => s.action && s.label));
  check('cancelled からは 1 候補(復活)', goNextStatuses('cancelled').statuses.length === 1);
}

console.log(`\n${failures === 0 ? 'PASS — 全契約 OK' : `FAIL — ${failures} 件`}`);
process.exit(failures === 0 ? 0 : 1);
