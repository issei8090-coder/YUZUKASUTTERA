/* 配信物に、画面が参照しているファイルが全部入っているかを検査する。
 *
 * art/ をコピーし忘れて本番だけ画像が全滅していたことがある。ローカルには
 * ファイルがあるので気づけず、デプロイして初めて分かる種類の事故なので、
 * 配信直前の成果物そのものを見る関門をここに置く。 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = process.argv[2] || '_site';
if(!existsSync(root)){ console.error(`配信物が見つかりません: ${root}`); process.exit(1); }

const files = [];
(function walk(d){
  for(const e of readdirSync(d)){
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(root);

// href/src/import から参照先を拾う。外部 URL と data: は対象外。
const PATTERNS = [
  /\b(?:src|href)\s*=\s*["']([^"']+)["']/g,
  /\bfrom\s*["'](\.[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  /\bfetch\s*\(\s*["']([^"':?]+)["']/g,
  /url\(\s*["']?([^"')]+)["']?\s*\)/g,
];
const SKIP = /^(https?:|data:|javascript:|blob:|about:|mailto:|tel:|#|\/\/)/;

let bad = 0, checked = 0;
for(const f of files){
  if(!/\.(html|js|mjs|css)$/.test(f)) continue;
  // 取り込んだ第三者コード（圧縮済み）は走査しない。内部の文字列が
  // 参照に見えて誤検知になるだけで、こちらが書いた参照ではない。
  if(/[\\/]vendor[\\/]/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  const base = dirname(f);
  for(const re of PATTERNS){
    for(const m of src.matchAll(re)){
      let ref = m[1].trim();
      if(!ref || SKIP.test(ref)) continue;
      // テンプレートリテラルで組み立てる参照は実行時にしか決まらない。
      // 静的には追えないので対象外にする（画像のキーなどが該当）。
      if(ref.includes('${') || ref.includes('`')) continue;
      ref = ref.split(/[?#]/)[0];
      if(!ref) continue;
      const target = ref.startsWith('/')
        ? resolve(root, '.' + ref)
        : resolve(base, ref);
      checked++;
      if(!existsSync(target)){
        console.error(`✗ ${f} → ${ref}  (配信物に無い)`);
        bad++;
      }
    }
  }
}
console.log(`参照 ${checked} 件を検査 / 欠落 ${bad} 件`);
if(bad){ console.error('配信物に欠落があります。コピー漏れを直してください。'); process.exit(1); }
console.log('✓ 参照はすべて配信物に含まれています');
