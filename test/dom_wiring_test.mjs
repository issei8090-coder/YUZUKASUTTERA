// app.js が触る id が index.html に実在するか、静的に照合する。
//
// $('typo') は実行時まで気づけず、しかも多くの場合 catch されずに
// その画面の描画だけが黙って止まる。当日に初めて分かる種類の事故なので、
// 配線のずれはここで落とす。
// 実行: node test/dom_wiring_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// index.html にある id と、app.js がテンプレートで組み立てる id の両方。
// 単価設定の入力欄のように、開いたときに作られるものがある。
const ids = new Set([
  ...[...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
  ...[...js.matchAll(/\bid="([^"$]+)"/g)].map(m => m[1]),
]);

let failures = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); failures++; };

console.log('\n[1] app.js が参照する id が index.html にあるか');
const used = new Set([...js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map(m => m[1]));
for (const id of [...used].sort()) {
  if (ids.has(id)) console.log(`  ok   #${id}`);
  else fail(`#${id} を app.js が触っているが index.html に無い`);
}

console.log('\n[2] 画面（タブ）の対応');
// switchTab は VIEWS の各名前について #view-<名前> を必ず触る。
const views = js.match(/const VIEWS = \[([^\]]+)\]/)?.[1]
  ?.split(',').map(s => s.trim().replace(/'/g, '')) || [];
if (!views.length) fail('VIEWS を app.js から読み取れない');
for (const v of views) {
  if (ids.has(`view-${v}`)) console.log(`  ok   #view-${v}`);
  else fail(`VIEWS に ${v} があるが #view-${v} が無い`);
  const nav = html.includes(`data-go="${v}"`);
  if (nav) console.log(`  ok   ナビに ${v}`);
  else fail(`${v} に切り替えるナビのボタンが無い`);
}

console.log('\n[3] aria-labelledby の参照先が実在するか');
// 参照先が無いと、読み上げでは名前の無いパネルとして扱われる。
for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
  for (const ref of m[1].split(/\s+/)) {
    if (ids.has(ref)) console.log(`  ok   aria-labelledby=${ref}`);
    else fail(`aria-labelledby="${ref}" の参照先が存在しない`);
  }
}
for (const m of html.matchAll(/aria-controls="([^"]+)"/g)) {
  if (!ids.has(m[1])) fail(`aria-controls="${m[1]}" の参照先が存在しない`);
}

console.log('\n[4] 注文一覧を受け取る純粋関数の包み');
// lib/pure.js 側は対象の注文一覧を必ず引数で受け取る（Node からテストするため）。
// app.js では「いまの営業回」が既定なので、必ず包んでから使う。
// 素のまま呼ぶと引数の渡し忘れが実行時エラーになり、その画面の描画が黙って止まる。
// 実際、tagsInUse を包み忘れて「決定」が無反応になったことがある。
for (const fn of ['soldOf', 'remainingOf', 'headroomOf', 'tagsInUse']) {
  const wrapped = new RegExp(`const\\s+${fn}\\s*=`).test(js);
  if (wrapped) console.log(`  ok   ${fn} は包まれている`);
  else fail(`${fn} を包まずに使っている（引数の渡し忘れで描画が止まる）`);
}
// 包みを迂回して pure 版を直接呼んでいないか。
for (const m of js.matchAll(/\bpure([A-Z]\w+)\s*\(/g)) {
  const name = 'pure' + m[1];
  const decl = new RegExp(`const\\s+\\w+\\s*=\\s*[^;]*${name}\\s*\\(`);
  if (!decl.test(js)) fail(`${name} を包みの外から直接呼んでいる`);
}

console.log('\n[5] 呼んでいる関数が定義されているか');
// ブロック単位で書き換えたとき、定義ごと消してしまう事故が 2 回起きている。
// 実行時にしか分からず、その操作だけが黙って効かなくなる（タップしても無反応）。
{
  // コメントと文字列の中身を外す。テンプレートの ${...} は本物のコードなので残す。
  const strip = (src) => {
    let out = '', i = 0, tpl = [];
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; out += ' '; continue; }
      if (c === "'" || c === '"') {
        const q = c; i++;
        while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
        i++; out += ' '; continue;
      }
      if (c === '`') {
        i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '`') { i++; break; }
          if (src[i] === '$' && src[i + 1] === '{') {   // 中は本物のコード
            let depth = 1; i += 2; const from = i;
            while (i < src.length && depth) {
              if (src[i] === '{') depth++;
              else if (src[i] === '}') depth--;
              if (depth) i++;
            }
            tpl.push(src.slice(from, i)); i++; continue;
          }
          i++;
        }
        out += ' '; continue;
      }
      out += c; i++;
    }
    return out + '\n' + tpl.map(strip).join('\n');
  };

  const code = strip(js);
  const declared = new Set();
  for (const re of [/\bfunction\s+(\w+)\s*\(/g, /\b(?:const|let|var)\s+(\w+)\s*=/g]) {
    for (const m of code.matchAll(re)) declared.add(m[1]);
  }
  for (const m of js.matchAll(/import\s*(?:\*\s*as\s*(\w+)|\{([^}]+)\}|(\w+))\s*from/g)) {
    if (m[1]) declared.add(m[1]);
    if (m[3]) declared.add(m[3]);
    if (m[2]) m[2].split(',').forEach(x => declared.add(x.split(/\s+as\s+/).pop().trim()));
  }
  // 仮引数も定義済みとして扱う（括弧つき・括弧なし・関数宣言の 3 通り）
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g))
    m[1].split(',').forEach(a => { const n = a.trim().split(/[=:\s]/)[0]; if (/^\w+$/.test(n)) declared.add(n); });
  for (const m of code.matchAll(/(?:^|[(,=\s])(\w+)\s*=>/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*\w*\s*\(([^)]*)\)/g))
    m[1].split(',').forEach(a => { const n = a.trim().split(/[=:\s]/)[0]; if (/^\w+$/.test(n)) declared.add(n); });

  const BUILTIN = new Set(['if','for','while','switch','catch','return','typeof','await','function',
    'console','JSON','Object','Array','String','Number','Boolean','Math','Date','Promise','Set','Map',
    'parseInt','parseFloat','isNaN','setTimeout','setInterval','clearTimeout','clearInterval','fetch',
    'requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener','matchMedia',
    'URL','Blob','Error','RegExp','Go','WebAssembly','localStorage','navigator','document','window',
    'of','in','new','do','else','try','case','delete','void','yield']);

  const missing = new Map();
  for (const m of code.matchAll(/(?<![.\w$])\b([a-z_]\w*)\s*\(/g)) {
    const n = m[1];
    if (declared.has(n) || BUILTIN.has(n)) continue;
    missing.set(n, (missing.get(n) || 0) + 1);
  }
  if (missing.size) for (const [n, c] of missing) fail(`${n}() を ${c} 箇所で呼んでいるが定義が無い（操作が無反応になる）`);
  else console.log('  ok   呼んでいる関数はすべて定義されている');
}

console.log('\n[6] ルールの版');
// 公開されているルールが古いと、$other:false により全書き込みが拒否される。
// app.js が測る版と、ルール側が名乗る版がずれていると検知が働かない。
{
  const want = js.match(/const RULES_VERSION = '([^']+)'/)?.[1];
  const rules = fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8');
  const have = Object.keys(JSON.parse(rules).rules.rulesVersion || {});
  if (!want) fail('app.js に RULES_VERSION が無い');
  else if (!have.includes(want)) fail(`app.js は ${want} を測るのに、ルールには ${have.join(',') || '何も'} しかない`);
  else console.log(`  ok   ルールの版 ${want}`);
}

console.log('\n[7] 取り込んだ資源');
for (const rel of ['lib/pure.js', 'lib/audio.js', 'lib/motion.js',
                   'vendor/firebase/firebase-app.js',
                   'vendor/firebase/firebase-auth.js',
                   'vendor/firebase/firebase-database.js']) {
  if (fs.existsSync(path.join(root, rel))) console.log(`  ok   ${rel}`);
  else fail(`${rel} が無い（tools/vendor-firebase.sh を実行してください）`);
}
// 起動経路に外部ネットワークを残さない。会場の回線が詰まると起動しなくなる。
if (/from\s+["']https?:/.test(js)) fail('app.js が外部 URL から import している');
else console.log('  ok   外部 URL からの import は無い');

console.log(failures ? `\n✗ ${failures} 件の配線ずれ` : '\n✓ 配線は一致しています');
process.exit(failures ? 1 : 0);
