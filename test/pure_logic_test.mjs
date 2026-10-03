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
  leftOf, madeOf, allMade, backlogCups, oldestWaitMin, measuredRate,
  forecast, reserveOn, stopIntake, hhmm,
  kitchenOf, cyclePieces, rateFromKitchen, planBakers, piecesLeft,
  soldRate, stockOutMin, bowlsFor, gramsFor, weightText,
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

console.log('\n[8] 焼き待ちと受け取り時刻');
// 作り置きができないので、注文は「まだ焼けていないカップ数」で数える。
// 部分的に受け取った分を引かないと、焼き待ちが実際より多く出て時刻が遅れていく。
// 端末の時計で 10/3 12:00。絶対時刻（+09:00 付き）で書くと、UTC で走る CI では
// hhmm が 03:08 を返して落ちる。hhmm は会場の時計をそのまま使う設計なので、
// テストの基準もローカル時刻で作る。
const NOW = new Date(2026, 9, 3, 12, 0, 0, 0).getTime();
const cup = (q, st, minAgo, made, extra = {}) => ({
  status: st, quantity: q, createdMs: NOW - minAgo * 60000,
  items: [{ flavor: 'plain', quantity: q }], made, ...extra });

eq('未処理は注文数ぶん残っている', leftOf(cup(3, 'pending', 1)), 3);
eq('受け取った分は引く',          leftOf(cup(3, 'pending', 1, { plain: 1 })), 2);
eq('受渡待ちは焼き待ちでない',    leftOf(cup(3, 'ready', 1)), 0);
eq('注文数を超えて数えない',      madeOf(cup(2, 'pending', 1, { plain: 9 }), 'plain'), 2);
eq('そろった',                    allMade(cup(2, 'pending', 1, { plain: 2 })), true);
eq('そろっていない',              allMade(cup(2, 'pending', 1, { plain: 1 })), false);

const QUEUE = [cup(3, 'pending', 9), cup(2, 'pending', 1, { plain: 1 }), cup(1, 'ready', 5)];
eq('焼き待ちの合計', backlogCups(QUEUE), 4);
eq('最長待ちは未処理だけを見る', oldestWaitMin(QUEUE, NOW), 9);

// 1 分 1 カップなら、4 カップ待ち ＋ 2 カップの注文 = 6 分 ＋ 手間 2 分。
const f = forecast(QUEUE, { now: NOW, rate: 1, addCups: 2 });
eq('見積もり（分）', f.waitMin, 8);
eq('受け取り時刻',   hhmm(f.pickupMs), '12:08');
// 空いていても、その注文を焼く時間だけはかかる（2カップ＝2分＋手間2分）。
eq('空いていても自分のぶんはかかる', forecast([], { now: NOW, rate: 1, addCups: 2 }).waitMin, 4);
// 何も注文していない＝いまの待ち時間を訊いただけなら 0 分。
eq('焼き待ちが無ければ 0 分', forecast([], { now: NOW, rate: 1 }).waitMin, 0);
// 速さが倍なら半分。設定を変えたら見積もりも動くこと。
eq('速さを上げると縮む', forecast(QUEUE, { now: NOW, rate: 2, addCups: 2 }).waitMin, 5);

eq('8分で予約が始まる',      reserveOn('auto', QUEUE, NOW, false), true);
eq('7分では始まらない',      reserveOn('auto', [cup(1, 'pending', 7)], NOW, false), false);
eq('始まったら5分までは続く', reserveOn('auto', [cup(1, 'pending', 6)], NOW, true), true);
eq('5分を切ったら戻る',      reserveOn('auto', [cup(1, 'pending', 4)], NOW, true), false);
eq('手動ONは待ち時間を見ない', reserveOn('on', [], NOW, false), true);
eq('手動OFFは混んでも出さない', reserveOn('off', QUEUE, NOW, true), false);

eq('30分を超えたら受付を止める', stopIntake(31, false), true);
eq('30分ちょうどは止めない',     stopIntake(30, false), false);
eq('止めたあとは25分まで戻さない', stopIntake(26, true), true);
eq('25分以下で再開',             stopIntake(25, true), false);

// 実測は件数が足りないと使わない（たまたま 1 件出ただけで速さを決めない）。
eq('実測が足りなければ null', measuredRate([{ status:'ready', quantity:2, calledAt: NOW - 60000 }], NOW), null);
eq('実測は毎分カップ数',
   measuredRate([{ status:'ready', quantity:6, calledAt: NOW - 60000 },
                 { status:'completed', quantity:4, calledAt: NOW - 5 * 60000 },
                 { status:'completed', quantity:9, calledAt: NOW - 30 * 60000 }], NOW), 1);

console.log('\n[9] 厨房の体制（人数で決まる）');
// 焼ける量を決めているのは台ではなく人。1 人が同時に見られるのは 12 マス
// （＝2カップ）くらいで、大きい台はマスを余らせて使う。
// ここがずれると、約束する受け取り時刻が全部ずれる。
eq('1回ぶんの個数（4人×12マス）', cyclePieces({ people:4 }), 48);
eq('4人なら 4分に8カップ＝毎分2カップ', rateFromKitchen({ people:4, holes:12, cycleMin:4, margin:100 }), 2);
eq('6人なら毎分3カップ',             rateFromKitchen({ people:6, holes:12, cycleMin:4, margin:100 }), 3);
eq('2人なら毎分1カップ',             rateFromKitchen({ people:2, holes:12, cycleMin:4, margin:100 }), 1);
eq('見込み率で落とせる',             rateFromKitchen({ people:4, holes:12, cycleMin:4, margin:50 }), 1);
eq('でたらめな設定は既定に戻す', kitchenOf({ people:'x', holes:0, cycleMin:-1, margin:999 }),
   { people:4, holes:12, cycleMin:4, margin:100 });

const ord = (seq, f, q, made) => ({
  seq, createdMs: NOW - (100 - seq) * 60000, status: 'pending', quantity: q,
  items: [{ flavor: f, quantity: q }], made });
const plan = (list, kitchen) => planBakers(list, kitchen, ['plain','flavor_b'])
  .map(p => `${p.label}:${p.flavor || '空き'}${p.pieces ? '/' + p.pieces : ''}`).join(' ');

eq('残りは個で数える（受け取り済みを引く）',
   piecesLeft([ord(1, 'plain', 3, { plain: 1 })], 'plain'), 12);
// 1 つの台に 1 つの味しか載らない。多いほうへ寄せ切ると、古い注文の味が焼かれない。
eq('古い注文の味にも 1 台は当てる',
   plan([ord(1, 'flavor_b', 1), ord(2, 'plain', 10)], { people:4 }),
   '台1:plain/12 台2:plain/12 台3:plain/12 台4:flavor_b/6');
// 注文より口が多ければ、その数だけ載せる（作り置きはできないので焼き足さない）。
eq('注文が少なければ空きのまま',
   plan([ord(1, 'plain', 1)], { people:3 }),
   '台1:plain/6 台2:空き 台3:空き');
eq('焼くものが無ければ全部空き', plan([], { people:2 }), '台1:空き 台2:空き');
// 先頭の注文だけで口が全部埋まるなら、この 1 回はその味だけになる（受付順）。
eq('先頭の注文で埋まるときは 1 色',
   plan([ord(1, 'plain', 20), ord(2, 'flavor_b', 20)], { people:2 }),
   '台1:plain/12 台2:plain/12');

console.log('\n[10] 売れる速さと生地切れ');
// 売り切れは必ず起きる。何分前に分かるかが全てなので、実績が薄いうちは言わない。
const sold = (minAgo, q) => ({ status:'ready', createdMs: NOW - minAgo * 60000,
  items:[{ flavor:'plain', quantity:q }] });
eq('実績が薄ければ言わない', soldRate([sold(1, 2)], 'plain', NOW), null);
eq('直近10分で20カップなら毎分2', soldRate([sold(1, 10), sold(9, 10)], 'plain', NOW), 2);
eq('窓の外は数えない',        soldRate([sold(1, 10), sold(30, 90)], 'plain', NOW), 1);
eq('中止は数えない',
   soldRate([sold(1, 10), { ...sold(2, 90), status:'cancelled' }], 'plain', NOW), 1);
eq('残り40カップ・毎分2 → 20分', stockOutMin(40, 2), 20);
eq('売れていなければ言わない',   stockOutMin(40, null), null);
eq('残り0なら0分',               stockOutMin(0, 2), 0);

console.log('\n[11] 生地（ボウル）');
// 1 ボウル 400g で 3 カップ。端数は 1 ボウル余分に要る（混ぜ足せない）。
eq('3カップ＝1ボウル',   bowlsFor(3), 1);
eq('4カップ＝2ボウル',   bowlsFor(4), 2);
eq('100カップ＝34ボウル', bowlsFor(100), 34);
eq('0カップ＝0ボウル',   bowlsFor(0), 0);
eq('100カップ＝13.6kg',  weightText(gramsFor(100)), '13.6kg');
eq('3カップは400g',      weightText(gramsFor(3)), '400g');

console.log(failures ? `\n✗ ${failures} 件失敗` : '\n✓ すべて通りました');
process.exit(failures ? 1 : 0);
