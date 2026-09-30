# 文化祭 模擬店（ベビーカステラ）注文管理Webシステム

Go言語 (WebAssembly) と Firebase Realtime Database を使用して構築された、文化祭模擬店向けの 3モード切替型注文管理システムです。

受付・厨房・受渡の 3 台以上の端末がリアルタイムに同じ注文データを見ます。
金額計算・採番・状態遷移・集計・CSV 出力といった「間違うと売上が合わなくなる処理」は
すべて Go 側 (WASM) に集約し、画面側では計算しません。

---

## 📁 ファイル構成

| パス | 役割 |
|---|---|
| `index.html` | 画面の構造と意匠（マークアップと CSS） |
| `app.js` | 画面の配線。Firebase 同期・WASM ロード・描画 |
| `lib/pure.js` | 画面側の純粋ロジック（在庫・番号札・営業回・並び順）。Node からテストできる |
| `lib/audio.js` | 通知音。合成でその場で鳴らす（音源ファイルを持たない） |
| `lib/motion.js` | 受付の手応え（数え札・合計の走り・完了の演出） |
| `vendor/firebase/` | Firebase SDK の取り込み。**起動経路から外部ネットワークを外すため** |
| `sw.js` | Service Worker。回線が切れていても再読み込みから復帰できる |
| `main.go` | WASM ブリッジ。JavaScript との値の受け渡しのみを担当 |
| `internal/order/` | ドメインロジック（状態遷移・集計・CSV）。ブラウザに依存せずテスト可能 |
| `tools/` | SDK の取り込みと、配信物の参照チェック |
| `database.rules.json` | **Realtime Database のセキュリティルール（必ず適用すること）** |
| `firebase.json` | `firebase deploy --only database` 用の設定 |
| `firebase-config.sample.js` | 接続設定のひな形。コピーして `firebase-config.js` を作る |
| `test/wasm_contract_test.mjs` | ビルド済み `main.wasm` を Node から叩く契約テスト |
| `build.sh` | ローカル用のビルド & 配信スクリプト |
| `.github/workflows/deploy.yml` | テスト → ビルド → GitHub Pages デプロイ |

`main.wasm` / `wasm_exec.js` / `firebase-config.js` は生成物のため Git 管理外です。

---

## 🛠️ セットアップ

### 1. Firebase プロジェクト側の準備

1. Realtime Database を作成する。
2. **Authentication → ログイン方法 → 「匿名」を有効にする。**
   セキュリティルールが `auth != null` を要求するため、これを忘れると
   画面に「ログインに失敗しました」と表示され、注文が一切保存されません。
3. セキュリティルールを適用する（下記「セキュリティ」参照）。

### 2. 接続設定

```bash
cp firebase-config.sample.js firebase-config.js
# firebase-config.js を自分のプロジェクトの値に書き換える
```

この値は秘密情報ではありません。Firebase の Web API キーは公開前提で、
データの保護は `database.rules.json` の側で行います。

### 3. ビルドと起動

```bash
./build.sh serve      # テスト → WASM ビルド → http://localhost:8080 で配信
```

`file://` で `index.html` を直接開くことはできません（WASM と ES モジュールが
読み込めないため）。必ず HTTP 経由で開いてください。

手動でビルドする場合:

```bash
GOOS=js GOARCH=wasm go build -o main.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" .   # Go 1.24 以降
# Go 1.23 以前は misc/wasm/wasm_exec.js
```

---

## 🔒 セキュリティ

`database.rules.json` を必ず適用してください。未適用のままだと、データベース URL を
知っている人が売上データを全件読み取り・全消去できます。

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only database
```

ルールで担保していること:

- **認証必須** — 匿名サインイン済みの端末だけが読み書きできる。
- **状態遷移の強制** — `pending → ready → completed` などの許可された遷移のみ通す。
  クライアントを改造しても、調理を飛ばして受渡完了にはできない。
- **確定値の不変性** — 金額・数量・商品・注文番号・受付時刻は作成後に変更できない。
- **注文の削除禁止** — 取り消しは `status: cancelled` で行い、記録は残す。
  （データを消す場合は Firebase コンソールから行う）
- **金額・数量の範囲検証** — 数量 1〜10、単価 1〜100,000 円。

Go 側の検証（WASM）はあくまで操作性のためのもので、**権限の境界はルール側**にあります。

---

## 🧪 テスト

```bash
go test ./internal/...                 # ドメインロジック
node test/wasm_contract_test.mjs       # ビルド済み WASM と JS の契約（要 ./build.sh）
```

CI では両方に加えて `gofmt` / `go vet` が走ります。

---

## 🚀 デプロイ（GitHub Pages）

リポジトリの **Settings → Secrets and variables → Actions → Variables** に以下を登録します。

| 名前 | 例 |
|---|---|
| `FIREBASE_API_KEY` | `AIza...` |
| `FIREBASE_AUTH_DOMAIN` | `your-project.firebaseapp.com` |
| `FIREBASE_DATABASE_URL` | `https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_PROJECT_ID` | `your-project` |
| `FIREBASE_STORAGE_BUCKET` | `your-project.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | `1234567890` |
| `FIREBASE_APP_ID` | `1:123:web:abc` |

**Settings → Pages → Source** を「GitHub Actions」にしたうえで `main` に push すると、
テスト → WASM ビルド → `firebase-config.js` 生成 → Pages 公開まで自動で流れます。

---

## 📐 設計メモ

### 注文 ID

`order_<6桁ゼロ埋めの連番>_<受付ミリ秒>` 形式です（例 `order_000007_1790654327731`）。
連番は Firebase のトランザクションで採番するため全端末で一意になり、
同じミリ秒に複数台から注文が入っても衝突しません。
キーの辞書順がそのまま受付順になります。

### 状態遷移

```
pending ──→ ready ──→ completed
   ↑          ↓  ↑         │
   └──────────┘  └─────────┘      （差し戻し・受渡の取り消し）
   
すべての状態 ──→ cancelled ──→ pending   （中止と、誤操作からの復活）
```

`internal/order/order.go` の `transitions` が唯一の定義で、
`database.rules.json` の `status` ルールがこれと同じ内容を強制します。

### 売上の数え方

会計は受付時（注文確定時）に済ませる運用のため、**売上はキャンセル以外の全注文**を計上します。
受渡が済んでいない分は `outstandingSales`（未受渡金額）で別途追えます。

- `totalSales` = `completedSales` + `outstandingSales`
- `pendingPacks`（未受渡）= 調理待ち + 受渡待ち
- `queuePacks` / `queueByFlavor`（焼き待ち）= 調理待ちのみ

### CSV

UTF-8 BOM + CRLF で出力するため、Excel でそのまま開いても文字化けしません。
明細 (`goGenerateOrdersCSV`) と集計サマリ (`goGenerateSummaryCSV`) の 2 種類があります。

### WASM が公開する関数

| 関数 | 戻り値 |
|---|---|
| `goLabels()` | 商品マスタ・ステータス名・入力上限 |
| `goUpdateOrderStatus(現在, 変更先)` | `{valid, reason}` |
| `goNextStatuses(現在)` | `{statuses: [{value, label, action}]}` |
| `goBuildOrder({seq, flavor, quantity, prices, nowMs})` | `{ok, error, path, order}` |
| `goValidatePrices({...})` | `{ok, error, prices}` |
| `goCalculateStats(注文一覧)` | 集計結果オブジェクト |
| `goGenerateOrdersCSV(注文一覧)` | `Uint8Array` |
| `goGenerateSummaryCSV(注文一覧)` | `Uint8Array` |

いずれも **JS オブジェクト**を返します（`JSON.parse` は不要）。
引数の注文一覧は配列・オブジェクト・JSON 文字列のいずれでも受け付けます。
内部で panic が起きても `{ok:false, valid:false, error}` を返すため、UI が固まることはありません。

---

## 🤝 運用の前提（設計判断の記録）

### 営業回で仕切る（注文は消さない）

リハーサルと本番を同じデータベースで回せるよう、注文は `session` で仕切っています。
記録タブの「締めて次の回を始める」を押すと、

1. その回の明細CSVと集計CSVを自動で保存し、
2. 新しい営業回を始めます（売上・在庫・番号札の集計が 0 から）。

**注文は 1 件も削除されません。** 「本番前にデータを消す」という取り返しのつかない
手作業を無くすための仕組みです。ルール上も注文の削除は禁止しています。

### 番号札を使わないモードは「受付で受け取り済み」

`番号札なしで渡しています` に切り替えると、注文は受付時点で
**受渡完了・支払い済み** として記録されます。その場で渡してその場で代金を
いただく運用なので、未払いで立てると支払い口に「渡したのに未払い」として
積み上がり、回収する手間だけが生まれます。

このモードの注文は厨房の画面に出ません（作り置きを前提とした設計です）。

### 呼び出しは自動

厨房が「用意した」を押した時点で呼び出しになります（同じトランザクションで
`calledAt` を書きます）。別に「呼ぶ」を押させると、焼き上げてから呼ぶまでが
人の気づき待ちになるためです。音は呼び出し表示を開いている端末だけが鳴らします。

**読み上げ（音声合成）は使いません。** 端末に入っている日本語音声は compact 版だけの
ことが多く機械的に響きます。`speechSynthesis` の出力は Web Audio を通らないため、
こちらから音質を補正する手段もありません。番号はチャイムと画面の大きな数字で伝えます。

### 売り過ぎと札の二重発行について

在庫と番号札は、書き込む直前にサーバーの値を読み直して確認します
（購読しているスナップショットは数百ミリ秒〜数秒古く、受付が 2 台あると
「最後の 1 カップを両方が売る」が実際に起きるため）。

**これは危険な窓を 1 往復ぶんまで縮めるもので、完全に消すものではありません。**
消すには在庫と札をサーバー側のトランザクションで確保する必要がありますが、
その方式は端末が落ちたときに在庫が取り残される別の事故を生みます。
100 カップ規模では窓を縮めるほうが割に合うと判断しています。

### 誰でも設定を書き換えられること

匿名認証のため、**ページを開ける人は誰でも**単価・在庫・金額表示を書き換えられます。
これは公開 Web API キー + 匿名認証という構成の必然です。

営業時間で書き込みを閉じる仕組みも検討しましたが、**時計や設定のずれで
当日にスタッフ自身が締め出される危険のほうが大きい**と判断し、入れていません。
URL を配る相手は意識してください。注文の削除と過去の書き換えはルールで禁じてあります。

---

## 🧪 テスト

```bash
go test ./internal/...        # ドメインロジック + ルールとの照合
node test/pure_logic_test.mjs    # 画面側のロジック（在庫・札・営業回）
node test/pure_parity_test.mjs   # Go と JS の二重実装がずれていないか
node test/dom_wiring_test.mjs    # $('id') と index.html の照合
node test/wasm_contract_test.mjs # WASM と JS の受け渡し契約
node tools/check-site.mjs _site  # 配信物に参照先が全部入っているか
```

`internal/order/rules_test.go` は Go の構造体と `database.rules.json` を
reflect で突き合わせます。ルールは `$other: false` で閉じているため、
**Go にフィールドを足した瞬間に全注文の書き込みが拒否されます**
（症状は「画面では確定できるのに DB だけが拒否する」で、原因が見えません）。
同じ事故が 3 回起きたので、ここで本番前に落とします。
