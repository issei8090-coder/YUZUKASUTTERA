#!/usr/bin/env bash
# Google Fonts を vendor/fonts/ に取り込む。
#
# フォントが落ちても代替書体で読めるが、模擬店の意匠が別物になる。
# 会場の回線に依存させないため、実際に使う字形だけ取り込んで自前で配信する。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor/fonts
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
URL='https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;500;600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap'

curl -fsS -A "$UA" "$URL" -o vendor/fonts/fonts.css
# CSS が指す woff2 を全部落とし、参照を相対パスに差し替える。
grep -o 'https://fonts.gstatic.com/[^)]*\.woff2' vendor/fonts/fonts.css | sort -u | while read -r u; do
  f="$(basename "$u")"
  [ -f "vendor/fonts/$f" ] || curl -fsS "$u" -o "vendor/fonts/$f"
  perl -pi -e "s{\Q$u\E}{./$f}g" vendor/fonts/fonts.css
done

if grep -q 'fonts.gstatic.com' vendor/fonts/fonts.css; then
  echo "!! gstatic への参照が残っています" >&2; exit 1
fi
echo "==> 完了: $(ls vendor/fonts/*.woff2 | wc -l | tr -d ' ') ファイル / $(du -sh vendor/fonts | cut -f1)"

# 注: 日本語フォントは unicode-range で 800 以上のサブセットに分割されるため、
# 取り込むと 20MB を超える。iPad には Hiragino Mincho ProN / Hiragino Sans が
# 標準で入っていて代替書体として十分に働くので、既定では取り込まない。
# 会場の回線でどうしても意匠を固定したい場合だけ、これを実行して _site に含める。
