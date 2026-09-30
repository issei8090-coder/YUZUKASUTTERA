#!/usr/bin/env bash
# Firebase SDK を vendor/firebase/ に取り込む。
#
# 会場の回線が詰まると gstatic からの読み込みが返らず、アプリが起動すらしない。
# 起動経路から外部ネットワークを外すため、SDK は取り込んで自前で配信する。
# 版を上げるときは FIREBASE_VERSION を変えてこれを実行し、結果をコミットする。
set -euo pipefail
cd "$(dirname "$0")/.."
FIREBASE_VERSION="${FIREBASE_VERSION:-10.8.0}"
BASE="https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}"
mkdir -p vendor/firebase

for m in app auth database; do
  echo "==> firebase-$m.js"
  curl -fsS "$BASE/firebase-$m.js" -o "vendor/firebase/firebase-$m.js"
  # モジュール同士の参照は gstatic の絶対 URL なので、相対参照に書き換える。
  # ここを直さないと、取り込んだのに結局 gstatic を見に行く。
  perl -pi -e "s{\Q$BASE/firebase-app.js\E}{./firebase-app.js}g" "vendor/firebase/firebase-$m.js"
done

echo "${FIREBASE_VERSION}" > vendor/firebase/VERSION
if grep -rl 'gstatic.com/firebasejs' vendor/firebase/ >/dev/null 2>&1; then
  echo "!! gstatic への参照が残っています" >&2; exit 1
fi
echo "==> 完了 (firebase ${FIREBASE_VERSION})"
