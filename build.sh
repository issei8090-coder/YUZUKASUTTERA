#!/usr/bin/env bash
# ローカル開発用のビルド & 配信スクリプト。
#   ./build.sh        # ビルドのみ
#   ./build.sh serve  # ビルドして http://localhost:8080 で配信
set -euo pipefail
cd "$(dirname "$0")"

echo "==> テスト"
go test ./internal/...

echo "==> main.wasm をビルド"
GOOS=js GOARCH=wasm go build -ldflags "-s -w" -o main.wasm .

echo "==> wasm_exec.js をコピー"
GOROOT="$(go env GOROOT)"
if   [ -f "$GOROOT/lib/wasm/wasm_exec.js" ];  then cp "$GOROOT/lib/wasm/wasm_exec.js" .   # Go 1.24+
elif [ -f "$GOROOT/misc/wasm/wasm_exec.js" ]; then cp "$GOROOT/misc/wasm/wasm_exec.js" .  # Go 1.23 以前
else echo "wasm_exec.js が見つかりません" >&2; exit 1
fi

# CI (.github/workflows/deploy.yml) と同じ一式を、同じ順で走らせる。
# ここが CI より少ないと「手元は通るのに配信されない」が起きる（実際に 3 回起きた）。
# TZ=UTC でも回すのは、CI が UTC で走るため。時刻の表示は端末のローカル時刻を
# 使う設計なので、テストがそこに引きずられていないことを確かめる。
echo "==> 画面側のテスト"
for t in wasm_contract wasm_ready_guard tag_contract pure_logic pure_parity dom_wiring audio_smoke; do
  node "test/${t}_test.mjs" >/dev/null || { echo "!! test/${t}_test.mjs が失敗しました" >&2; exit 1; }
done
TZ=UTC node test/pure_logic_test.mjs >/dev/null || { echo "!! pure_logic が UTC で失敗しました（CI は UTC で走ります）" >&2; exit 1; }
echo "    すべて通りました"

if [ ! -d vendor/firebase ]; then
  echo "==> Firebase SDK を取り込みます（初回のみ）"
  ./tools/vendor-firebase.sh
fi

if [ ! -f firebase-config.js ]; then
  echo "!! firebase-config.js がありません。firebase-config.sample.js をコピーして作成してください。" >&2
fi

# CI と同じ配信物を手元にも作る。回線や CI が使えない当日に
#   firebase deploy --only hosting,database
# で人が直接出せる逃げ道を残しておくため。内容は .gitlab-ci.yml の site と同じ。
echo "==> 配信物 public/ を組む"
rm -rf public && mkdir -p public
cp index.html app.js sw.js main.wasm wasm_exec.js public/
[ -f firebase-config.js ] && cp firebase-config.js public/ || true
cp -r art lib vendor public/
[ -f tailwind.local.js ] && cp tailwind.local.js public/ || true
# firebase-config.js が無いと index.html の参照が欠けるため、
# 設定がまだの人の手元で関門が誤爆しないようにする（CI では必ず生成される）。
if [ -f public/firebase-config.js ]; then
  node tools/check-site.mjs public
else
  echo "   （firebase-config.js が無いため、参照チェックは飛ばしました）"
fi

echo "==> 完了"
if [ "${1:-}" = "serve" ]; then
  # file:// では WASM も ES モジュールも読み込めないため、HTTP で配信する。
  echo "==> http://localhost:8080 で配信中 (Ctrl+C で停止)"
  exec python3 -m http.server 8080
fi
