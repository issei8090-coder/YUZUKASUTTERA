#!/usr/bin/env bash
# ローカル開発用のビルド & 配信スクリプト。
#   ./build.sh        # ビルドのみ
#   ./build.sh serve  # ビルドして http://localhost:8080 で配信
set -euo pipefail
cd "$(dirname "$0")"

echo "==> テスト"
go test ./internal/...

echo "==> main.wasm をビルド"
GOOS=js GOARCH=wasm go build -o main.wasm .

echo "==> wasm_exec.js をコピー"
GOROOT="$(go env GOROOT)"
if   [ -f "$GOROOT/lib/wasm/wasm_exec.js" ];  then cp "$GOROOT/lib/wasm/wasm_exec.js" .   # Go 1.24+
elif [ -f "$GOROOT/misc/wasm/wasm_exec.js" ]; then cp "$GOROOT/misc/wasm/wasm_exec.js" .  # Go 1.23 以前
else echo "wasm_exec.js が見つかりません" >&2; exit 1
fi

if [ ! -f firebase-config.js ]; then
  echo "!! firebase-config.js がありません。firebase-config.sample.js をコピーして作成してください。" >&2
fi

echo "==> 完了"
if [ "${1:-}" = "serve" ]; then
  # file:// では WASM も ES モジュールも読み込めないため、HTTP で配信する。
  echo "==> http://localhost:8080 で配信中 (Ctrl+C で停止)"
  exec python3 -m http.server 8080
fi
