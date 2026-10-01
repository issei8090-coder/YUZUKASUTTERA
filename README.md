# 文化祭 模擬店（ベビーカステラ）注文管理Webシステム

Go言語 (WebAssembly) と Firebase Realtime Database を使用して構築された、文化祭模擬店向けの画面切替型注文管理システムです。

受付・厨房・受渡・支払い口などの端末がリアルタイムに同じ注文データを見ます。
端末ごとに URL の `#` を決めて使います。

| URL | 画面 | 誰が使うか |
|---|---|---|
| （なし） | 受付 | お客様に向ける。商品を選んで確定する |
| `#kitchen` | 厨房 | 焼き待ちの伝票。置きっぱなしにする |
| `#ready` | 受渡 | 品物を渡し、代金も受け取る。置きっぱなしにする |
| `#pay` | 支払い口 | 未収の回収に専念する（`#pay:2` で 2 口目） |
| `#amount` | 金額表示 | お客様に向ける。会計中の金額だけを出す |
| `#call` | 呼び出し表示 | お客様に向ける。番号札の番号を大きく出す |
| `#records` | 記録・売上 | 本部。記録表・売上・CSV・営業回の締め |
| `#control` | 管理 | 本部。番号札を使うかどうかの切り替えと、受付機の在席。スマートフォンから触れる |

注文の一生と場合分けは **[`docs/FLOW.md`](docs/FLOW.md)** にまとめてあります。
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
| `firebase.json` | `firebase deploy` の設定（Hosting の配信内容とヘッダ、Database のルール） |
| `firebase-config.sample.js` | 接続設定のひな形。コピーして `firebase-config.js` を作る |
| `test/wasm_contract_test.mjs` | ビルド済み `main.wasm` を Node から叩く契約テスト |
| `docs/FLOW.md` | 注文の一生と、場合分けの一覧（コードから起こしたもの） |
| `docs/ISSUES.md` | 見つかっている問題と、直したもの |
| `build.sh` | ローカル用のビルド & 配信スクリプト（`public/` も組むので手動デプロイに使える） |
| `render.yaml` | Render（静的サイト・無料）の設定。`render` ブランチの中身をそのまま配る |
| `.github/workflows/deploy.yml` | テスト → ビルド → GitHub Pages と Render へデプロイ |

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

**ルールは CI では出ません。** 配信先は GitHub Pages なので、画面だけが自動で出ます。
`database.rules.json` を変えたら上のコマンド、または Firebase コンソール →
Realtime Database → ルール に貼って公開してください。貼り忘れると
`$other: false` によって全書き込みが拒否されます（過去 4 回これで止まっています）。
画面は起動時に `rulesVersion` を測り、古ければ上部に赤い帯を出します。

ルールで担保していること:

- **認証必須** — 匿名サインイン済みの端末だけが読み書きできる。
- **状態遷移の強制** — `pending → ready → completed` などの許可された遷移のみ通す。
  クライアントを改造しても、調理を飛ばして受渡完了にはできない。
- **確定値の不変性** — 金額・数量・商品・注文番号・受付時刻は作成後に変更できない。
- **注文の削除禁止** — 取り消しは `status: cancelled` で行い、記録は残す。
  （データを消す場合は Firebase コンソールから行う）
- **金額・数量の範囲検証** — 数量 1〜10、単価 1〜100,000 円。
- **受付機の名乗り** — `desks/1`〜`desks/4` だけを受け付ける（それ以外のキーは拒否）。

> **今回ルールを更新しています。** 受付機の名乗り (`desks`) を足したので、
> `rulesVersion` は **v7** になりました。古いルールのままだと名乗りが拒否され、
> 受付機を選べません。`database.rules.json` を公開し直してください。
>
> **目印は古い版を消さずに並べること。** ルールは画面より先に出ます（コンソールに
> 貼った瞬間に全端末へ効くが、画面は CI と Render を通るので数分遅れる）。
> その間、配信中の古い画面は自分が測る版（v6）を探しに行きます。置き換えてしまうと
> **古い画面に「ルールが古い」と誤報が出ます**（ルールは正しく、注文も通っているのに）。
> 新しい版を足し、全端末が入れ替わったことを確かめてから古い版を消します。

Go 側の検証（WASM）はあくまで操作性のためのもので、**権限の境界はルール側**にあります。

---

## 🧪 テスト

```bash
go test ./internal/...                 # ドメインロジック
node test/wasm_contract_test.mjs       # ビルド済み WASM と JS の契約（要 ./build.sh）
```

CI では両方に加えて `gofmt` / `go vet` が走ります。

---

## 🚀 デプロイ（GitHub Actions → GitHub Pages / Render）

`main` に push すると、GitHub Actions が
テスト → WASM ビルド → `firebase-config.js` 生成 → 配信物の参照チェック →
**GitHub Pages と Render の両方**へのデプロイまで流します。
公開先は `https://<ユーザー名>.github.io/<リポジトリ名>/` と
`https://<サイト名>.onrender.com` です。

**当日に使うのは Render 側です。** 会場の端末の設定で `*.github.io` が開けないため。
設置手順は「Render（onrender.com）へも出す」の節にあります。

**出るのは画面だけです。** `database.rules.json` は CI では反映されないので、
変えたときは人が貼ります（「セキュリティ」の節）。忘れると全書き込みが拒否され、
症状は「画面では確定できるのに何も保存されない」になります。その代わり、
画面が起動時に `rulesVersion` を測って赤い帯を出すので、当日はそこで気づけます。

プルリクエストではビルドと参照チェックまで走り、デプロイはしません。

### 1. Pages を有効にする

**Settings → Pages → Build and deployment → Source を「GitHub Actions」**にします。
ブランチを選ぶ方式ではありません（ワークフローが成果物を直接上げます）。

サービスアカウント（`FIREBASE_SERVICE_ACCOUNT`）は要りません。Pages への配信には
`GITHUB_TOKEN` しか使わないので、リポジトリに置く秘密情報はゼロになります。

### 2. リポジトリに登録する

**Settings → Secrets and variables → Actions** で登録します。

**Secrets**（1 つだけ。これが唯一の秘密情報です）

| 名前 | 中身 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | 上で発行した JSON をそのまま貼る |

**Variables**（Firebase の Web API キーは公開前提の値なので、Secrets でなくてよい。
データの保護は `database.rules.json` が行います）

| 名前 | 例 |
|---|---|
| `FIREBASE_API_KEY` | `AIza...` |
| `FIREBASE_AUTH_DOMAIN` | `your-project.firebaseapp.com` |
| `FIREBASE_DATABASE_URL` | `https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_PROJECT_ID` | `your-project` |
| `FIREBASE_STORAGE_BUCKET` | `your-project.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | `1234567890` |
| `FIREBASE_APP_ID` | `1:123:web:abc` |

Secrets 側に同じ名前で入れても動きます（ワークフローが両方を見ます）。

### 3. 当日に効くこと

**戻し方。** Pages にはリリース一覧が無いので、戻すときは `git revert` して push、
または Actions の前の成功 run を **Re-run all jobs** します。どちらもビルドを
一度通すので、数分かかります。

**手でも出せる。** GitHub や Actions が使えないときの逃げ道として、手元から直接出せます。
`firebase.json` は残してあるので、Firebase Hosting を使う形にも戻せます。

```bash
./build.sh serve                             # public/ を組んで http://localhost:8080
firebase deploy --only database              # ルールだけを出す（要 firebase login）
```

**キャッシュに注意。** GitHub Pages は応答に `Cache-Control: max-age=600` を付けます
（こちらからは変えられません）。`sw.js` は network-first ですが、その手前のブラウザの
HTTP キャッシュが古い応答を返すと network-first が効かず、**修正を出しても最大 10 分は
端末が古いまま動きます**。会期中に直したものを急いで行き渡らせるときは、
端末側でスーパーリロード（またはタブを開き直す）が要ります。

**古い画面が居座らない。** `firebase.json` で全ファイルに `Cache-Control: no-cache`
を付けています。`sw.js` は network-first ですが、その手前でブラウザの HTTP キャッシュが
古い応答を返すと network-first 自体が効かず、**会期中に修正を出しても端末が古いまま
動き続けます**。`no-cache` は「保存はするが毎回確認する」なので、変更がなければ 304 で
終わり、通信量はほとんど増えません。`.wasm` には `application/wasm` を明示しています
（`instantiateStreaming` が MIME を見るため。外れても `app.js` が読み込み直すので
落ちはしませんが、起動が遅くなります）。

---

## 🌐 Render（onrender.com）へも出す

**なぜ。** 会場で使う端末の設定で `*.github.io` が開けない。`onrender.com` は開ける。
そこで**当日の正を `https://<サイト名>.onrender.com` にします**。Pages への配信は
止めていません（片方が開けなくなったときの逃げ道として両方残します）。

**仕組み。** Render ではビルドを何もしません。`main` に push すると、いつもの
テスト → WASM ビルド → 参照チェックを通った `public/` そのものが `render`
ブランチに押され、Render がその中身をそのまま配ります。
Render 側に Go も Node も要らないので、**向こうで組み立てに失敗する経路がありません**。

### 1. Render にサイトを作る（一度だけ）

無料です。クレジットカードも要りません。

最初は `render` ブランチがまだ無いので、**先に `main` へ一度 push**
（または Actions を手動実行）してブランチを作ってから、Render の設定に進みます。

その前に **Settings → Actions → General → Workflow permissions** を
**「Read and write permissions」**にしてください。ここが読み取り専用だと、
ワークフローが `render` ブランチへ押す所で `403` で落ちます
（job 側で `contents: write` を宣言していても、リポジトリ設定が上限になります）。

Blueprint を使うなら **New → Blueprint → このリポジトリ → `main`** を選ぶだけで、
`render.yaml` の通りに作られます。手で作る場合は:

| 項目 | 値 |
|---|---|
| 種類 | **Static Site**（Web Service ではない） |
| Branch | `render` |
| Build Command | 空（または `echo ok`） |
| Publish Directory | `.` |

**種類を間違えないこと。** 無料の Web Service は 15 分アクセスが無いと停止し、
次に開いた人が数十秒待たされます。Static Site は停止せず、稼働時間の上限も
ありません（帯域 100GB/月）。2 日間の運用なら余ります。

公開 URL は Render の画面に出ます。`yuzukastera` が他で使われていると
`yuzukastera-xxxx.onrender.com` のような名前になるので、**表示された URL を
そのまま端末に入れてください**（推測しない）。

#### Render と GitHub のアカウントが別のとき

**Render のログイン用メールが GitHub と違っているだけなら、何もしなくてよいです。**
Render → Account Settings → GitHub → Connect でこのリポジトリの持ち主
（`issei8090-coder`）を繋げば済みます。両者が一致している必要はありません。

Render が既に別の GitHub アカウントと繋がっていて外せない場合は、どちらかを選びます。

1. **リポジトリの持ち主の GitHub で Render に新しくサインアップする。**
   無料なので増やしても費用はかからず、連携は自動で終わります。
2. **公開リポジトリとして URL で繋ぐ。** 作成画面の「Public Git repository」に
   `https://github.com/issei8090-coder/YUZUKASUTTERA` を貼ります。
   この形だと Render 側が webhook を張れないので push に自動では気づきません。
   そこは Deploy Hook で埋めます:

   - Render → そのサイト → Settings → **Deploy Hook** の URL を写す
   - GitHub → Settings → Secrets and variables → Actions → **Secrets** に
     `RENDER_DEPLOY_HOOK` として貼る（URL に鍵が入っているので Variables ではなく Secrets）

   以後、`main` に push するとワークフローがこの URL を叩いて配り直させます。
   **GitHub 連携を入れた場合はこの secret を設定しないこと**
   （両方あると 1 回の push で 2 回配り直します）。未設定なら手順は何もしません。

### 2. Firebase 側に新しいドメインを教える

配信元が変わります。ここを忘れると**画面は出るのに注文が通らない**形で出ます。

- **Firebase コンソール → Authentication → Settings → 承認済みドメイン**
  に `<サイト名>.onrender.com` を追加します。匿名ログイン（`signInAnonymously`）の
  入口がここです。
- Google Cloud 側で Web API キーに **HTTP リファラー制限**をかけている場合は、
  そこにも `https://<サイト名>.onrender.com/*` を追加します。
  かけていなければ何もしなくてよいです。

`database.rules.json` は配信元に依存しないので、貼り直しは要りません。

### 3. 端末を入れ直すときの注意

`#pay:2` のような支払い口の指定は localStorage に残りますが、**配信元ごとに別です**。
github.io で設定した端末を onrender.com に切り替えたら、
**もう一度 `https://<サイト名>.onrender.com/#pay:2` の形で開いてください**。
開き直さないと、その端末は `main`（1 番目の口）として振る舞います。

匿名ログインのセッションも配信元ごとなので、各端末で一度オンラインにする必要があります。
`sw.js` のキャッシュも配信元ごとなので、github.io 側に残った古い画面は干渉しません。

### 4. 戻し方

Render の **Deploys → 前の成功した配信 → Rollback** で戻せます。ビルドが無いので
数秒で終わります。Pages にはこの導線が無いので、当日はこちらのほうが速いです。

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

### 受付機は名乗ってから使う

受付は複数台置きます（受付機1・2・3と、予備の受付機4）。端末は起動したとき、
どの受付機かを選んでから受付に入ります。**すでに起動している受付機は選べません。**
同じ番号で 2 台立つと、受付係も受渡口も「どちらの端末が受けた注文か」を追えなくなるためです。

名乗りは `desks/<番号>` に置き、`onDisconnect` で片づけます。画面を閉じる・
電池が切れる・回線が落ちる、のいずれでも席は自動で空きに戻ります。それでも
「起動中」のまま残ったときは、管理画面 (`#control`) の「空ける」で戻します
（最後に名乗ってから 3 分を過ぎた席は「起動中（応答なし）」と出ます）。

重なりの判定はトランザクションで行います。購読している値で判定すると、
2 台が同時に同じ番号を押したとき両方が通ってしまうためです。

受付機を訊くのは受付の画面だけです。厨房・受渡・支払い口・表示の端末は名乗りません。

### 管理画面はスマートフォンから

番号札を使うかどうかは店全体の決めごとなので、受付の画面には置いていません
（受付はお客様に向くため、お客様の手の届くところに切り替えを置けない）。
`#control` を手元のスマートフォンで開き、列の様子を見ながら切り替えます。
幅が狭いときは見出しを畳み、押すところを画面いっぱいに広げます。

### 受渡は「確定した時点」から出る

受渡の画面には、受付で注文が確定した時点から **ご用意中** として出ます。
厨房が用意し終えるまで何も出ないと、いま何件来ているのかが受渡口から見えず、
人の配りどころも釣銭の用意も決められないためです。

並びは **お渡し待ち → ご用意中 → お渡し済み** の順で、押す対象が必ず上に来ます。
上の札で絞り込めます（既定は「すべて」）。渡したのに未払いの注文は、
支払い口と同じようにここでも赤く出し、その場で回収できます。

「最長待ち」はまだ渡していない注文だけを数えます。

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
