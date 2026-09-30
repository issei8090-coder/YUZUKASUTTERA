// 画面側のロジック（在庫・番号札・営業回・並び順）の検証。
//
// ここは長らくテストが 1 つも無く、「売り過ぎ」「札の二重発行」「リハーサルの
// 注文が本番の売上に混ざる」という、いずれも当日まで気づけない種類の
// 間違いが起きる場所だった。lib/pure.js に切り出して Node から叩けるようにしてある。
// 実行: node test/pure_logic_test.mjs
import {
  soldOf, remainingOf, headroomOf, tagsInUse, nextFreeTag,
  inSession, sessionOf, normalize, byOrder, waitText, ageOf, DEFAULT_SESSION,
  encodeLines, decodeLines,
} from '../lib/pure.js';

let failures = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}\n       期待 ${w}\n       実際 ${g}`); failures++; }
};

const order = (o) => ({ status: 'pending', items: [], tag: 0, ...o });
const ITEMS = [
  order({ id: 'a', status: 'pending',   tag: 3, items: [{ flavor: 'plain', quantity: 2 }] }),
  order({ id: 'b', status: 'ready',     tag: 7, items: [{ flavor: 'plain', quantity: 1 }, { flavor: 'flavor_b', quantity: 2 }] }),
  order({ id: 'c', status: 'completed', tag: 9, items: [{ flavor: 'plain', quantity: 4 }] }),
  order({ id: 'd', status: 'cancelled', tag: 5, items: [{ flavor: 'plain', quantity: 9 }] }),
];
const limits = { maxPerOrder: 10, stock: { plain: 20, flavor_b: 6 }, tagCount: 10 };

console.log('\n[1] 在庫');
// 中止した注文は在庫を戻す。ここを間違えると「売れていないのに売り切れ」になる。
eq('売れた数はキャンセルを除く', soldOf(ITEMS, 'plain'), 7);
eq('受渡済みも在庫を消費する', soldOf(ITEMS, 'flavor_b'), 2);
eq('残り', remainingOf(ITEMS, limits, 'plain'), 13);
eq('残りは負にならない', remainingOf(ITEMS, { stock: { plain: 3 } }, 'plain'), 0);
eq('在庫未設定は 0 扱い', remainingOf(ITEMS, { stock: {} }, 'plain'), 0);

console.log('\n[2] 1注文に入れられる数');
const FL = [{ key: 'plain' }, { key: 'flavor_b' }];
eq('残り在庫が上限', headroomOf(ITEMS, limits, { plain: 0, flavor_b: 0 }, FL, 'flavor_b'), 4);
// もう一方をカートに入れた分だけ、こちらの枠は減る。
eq('1注文の枠も効く', headroomOf(ITEMS, limits, { plain: 0, flavor_b: 3 }, FL, 'plain'), 7);
eq('枠を使い切ると 0', headroomOf(ITEMS, limits, { plain: 0, flavor_b: 10 }, FL, 'plain'), 0);

console.log('\n[3] 番号札');
// 出ている札＝お客様が持っている札。渡し終わった札と中止した札は戻ってくる。
eq('出ている札は未処理と受渡待ちだけ', tagsInUse(ITEMS).sort(), [3, 7]);
eq('次の空き', nextFreeTag(3, 10, [3, 7]), 4);
eq('出ている札は飛ばす', nextFreeTag(6, 10, [3, 7]), 8);
eq('端で折り返す', nextFreeTag(10, 10, [1, 2]), 3);
eq('全部出ていたら 0（札切れ）', nextFreeTag(1, 3, [1, 2, 3]), 0);
eq('範囲外の前回値は無視', nextFreeTag(999, 5, []), 1);

console.log('\n[4] 営業回');
eq('未設定は既定の回', sessionOf({}), DEFAULT_SESSION);
eq('既定の回に属する', inSession({}, DEFAULT_SESSION), true);
// リハーサルの注文が本番の集計に入らないこと。
eq('別の回は混ざらない', inSession({ session: 'r1' }, 'r2'), false);
eq('同じ回', inSession({ session: 'r2' }, 'r2'), true);

console.log('\n[5] 旧データの読み替え');
const legacy = normalize({ flavor: 'plain', quantity: 3, unitPrice: 250, price: 750, status: 'ready' }, 'k1');
eq('items に畳む', legacy.items, [{ flavor: 'plain', quantity: 3, unitPrice: 250, price: 750 }]);
eq('id はキーで補う', legacy.id, 'k1');
eq('paid が無ければ未払い', legacy.paid, false);
eq('paid は真偽値に正規化', normalize({ paid: 'yes', items: [] }, 'k').paid, false);

console.log('\n[6] 並び順と表示');
const shuffled = [{ seq: 3, createdMs: 1 }, { seq: 1, createdMs: 9 }, { seq: 2, createdMs: 5 }];
eq('受付順', [...shuffled].sort(byOrder).map(o => o.seq), [1, 2, 3]);
eq('経過 0 分', waitText(Date.now()), 'たった今');
eq('経過 7 分', waitText(Date.now() - 7 * 60000), '7分経過');
eq('3分未満は ok', ageOf(120), 'ok');
eq('3分で warn', ageOf(180), 'warn');
eq('6分で late', ageOf(360), 'late');

console.log('\n[7] 金額表示へ渡す明細');
// お客様側では絵で見せるので、商品キーと個数を保ったまま渡す必要がある。
const enc = encodeLines([{flavor:'plain',quantity:4},{flavor:'flavor_b',quantity:2}]);
eq('詰める', enc, 'plain:4|flavor_b:2');
eq('往復して戻る', decodeLines(enc),
   [{flavor:'plain',quantity:4},{flavor:'flavor_b',quantity:2}]);
eq('0個は落とす', encodeLines([{flavor:'plain',quantity:0},{flavor:'flavor_b',quantity:1}]), 'flavor_b:1');
eq('空でも落ちない', decodeLines(''), []);
// 旧い形式（文章）が届いても、絵に変換できないので空で返す。金額だけ出す。
eq('旧い文章は空', decodeLines('ゆずカステラ 4カップ'), []);
eq('壊れた値は空', decodeLines('plain:x|:'), []);

console.log(failures ? `\n✗ ${failures} 件失敗` : '\n✓ すべて通りました');
process.exit(failures ? 1 : 0);
