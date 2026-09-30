// Package order は文化祭模擬店（ベビーカステラ）注文管理システムのドメインロジック。
//
// ブラウザ・Firebase・syscall/js に一切依存しないため、通常の `go test` で
// 検証できる。WASM ブリッジ (ルートの main.go) はこのパッケージを呼ぶだけの薄い層。
package order

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// JST は表示・CSV 出力で使う固定タイムゾーン。
// js/wasm の time.Local はブラウザのタイムゾーンに追従しないため、
// 国内の模擬店運用に合わせて JST を明示的に固定する。
var JST = time.FixedZone("JST", 9*60*60)

// 注文の制約。UI 側のバリデーションもこの値を参照する（goLabels 経由）。
const (
	MinQuantity  = 1
	MaxQuantity  = 10 // 1 注文あたりの既定上限。config/limits で変更できる
	MinUnitPrice = 1
	MaxUnitPrice = 100000
	MaxSeq       = 999999

	// MaxPerOrderCap は「1注文あたりの上限」として設定できる最大値。
	// 設定ミスで実質無制限にならないよう、ここで頭を押さえる。
	MaxPerOrderCap = 99
	// MaxStock は作り置きの総数として設定できる最大値。
	MaxStock = 99999
	// MaxTagCount は番号札の枚数として設定できる最大値。
	MaxTagCount = 999
	// DefaultTagCount は番号札の既定枚数。
	DefaultTagCount = 50
)

// Status は注文のライフサイクル上の状態。
type Status string

const (
	StatusPending   Status = "pending"   // 受付済み・調理待ち
	StatusReady     Status = "ready"     // 調理完了・受渡待ち
	StatusCompleted Status = "completed" // 受渡完了
	StatusCancelled Status = "cancelled" // 中止
)

var statusLabels = map[Status]string{
	StatusPending:   "未処理",
	StatusReady:     "受渡待ち",
	StatusCompleted: "完了",
	StatusCancelled: "キャンセル",
}

// StatusOrder は UI・CSV での安定した並び順。
var StatusOrder = []Status{StatusPending, StatusReady, StatusCompleted, StatusCancelled}

// transitions は許可された状態遷移の唯一の正。
//
// 受渡待ちからの差し戻し (ready -> pending)、受渡完了の取り消し (completed -> ready)、
// 誤タップした中止の復活 (cancelled -> pending) を認める。復活を認めないと
// 中止の押し間違いが会計不能な形で確定してしまうため。
var transitions = map[Status][]Status{
	StatusPending:   {StatusReady, StatusCancelled},
	StatusReady:     {StatusCompleted, StatusPending, StatusCancelled},
	StatusCompleted: {StatusReady, StatusCancelled},
	StatusCancelled: {StatusPending},
}

// transitionLabels は「その遷移を起こすボタン」の文言。
var transitionLabels = map[Status]map[Status]string{
	StatusPending:   {StatusReady: "用意した", StatusCancelled: "中止"},
	StatusReady:     {StatusCompleted: "渡した", StatusPending: "未処理へ戻す", StatusCancelled: "中止"},
	StatusCompleted: {StatusReady: "受渡を取消", StatusCancelled: "中止"},
	StatusCancelled: {StatusPending: "復活"},
}

// KnownStatus は status が定義済みかを返す。
func KnownStatus(s Status) bool {
	_, ok := statusLabels[s]
	return ok
}

// StatusLabel は日本語表示名を返す。未知の値はそのまま返す（データを隠さない）。
func StatusLabel(s Status) string {
	if l, ok := statusLabels[s]; ok {
		return l
	}
	return string(s)
}

// TransitionResult は遷移可否の判定結果。
type TransitionResult struct {
	Valid  bool   `json:"valid"`
	Reason string `json:"reason"`
}

// CanTransition は from -> to の遷移が許可されているかを判定する。
func CanTransition(from, to Status) TransitionResult {
	if !KnownStatus(from) {
		return TransitionResult{Reason: fmt.Sprintf("現在のステータスが不正です: %q", from)}
	}
	if !KnownStatus(to) {
		return TransitionResult{Reason: fmt.Sprintf("変更先のステータスが不正です: %q", to)}
	}
	if from == to {
		return TransitionResult{Reason: fmt.Sprintf("すでに「%s」です", StatusLabel(to))}
	}
	for _, allowed := range transitions[from] {
		if allowed == to {
			return TransitionResult{Valid: true}
		}
	}
	return TransitionResult{Reason: fmt.Sprintf("「%s」から「%s」へは変更できません", StatusLabel(from), StatusLabel(to))}
}

// StatusOption は UI がボタンを描画するための遷移候補。
type StatusOption struct {
	Value  Status `json:"value"`
	Label  string `json:"label"`  // 遷移先のステータス名
	Action string `json:"action"` // ボタン文言
}

// NextStatuses は from から遷移可能なステータス一覧を返す。
// UI のボタン出し分けをこの表に従わせ、遷移規則の二重定義を防ぐ。
func NextStatuses(from Status) []StatusOption {
	opts := []StatusOption{}
	for _, to := range transitions[from] {
		opts = append(opts, StatusOption{
			Value:  to,
			Label:  StatusLabel(to),
			Action: transitionLabels[from][to],
		})
	}
	return opts
}

// Flavor は取り扱う商品。追加はこの表に 1 行足すだけで UI まで反映される。
type Flavor struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// Short は厨房の伝票など、離れた位置から一瞥する画面で使う短い名前。
	// 正式名称は文字数が多く、同じ幅に収めると字が小さくなって読めなくなる。
	Short        string `json:"short"`
	Unit         string `json:"unit"`   // 数え方（カップ）
	Pieces       int    `json:"pieces"` // 1 カップに入る個数
	Note         string `json:"note"`   // 受付画面に出す一言説明
	DefaultPrice int    `json:"defaultPrice"`
	DefaultStock int    `json:"defaultStock"` // 作り置きの既定数
}

// Flavors は商品マスタ。並び順が UI の表示順になる。
// Key は Realtime Database 上の既存データと互換を保つため plain / flavor_b のまま据え置く。
var Flavors = []Flavor{
	{Key: "plain", Label: "ゆずカステラ", Short: "ゆず", Unit: "カップ", Pieces: 6, DefaultPrice: 250, DefaultStock: 100,
		Note: "ゆずの爽やかな香りが広がる、しっとりとしたカステラです。"},
	{Key: "flavor_b", Label: "チョコカステラ", Short: "チョコ", Unit: "カップ", Pieces: 6, DefaultPrice: 250, DefaultStock: 100,
		Note: "ほどよい甘さのチョコレートが香る、しっとりカステラです。"},
}

// LookupFlavor はキーから商品マスタを引く。
func LookupFlavor(key string) (Flavor, bool) {
	for _, f := range Flavors {
		if f.Key == key {
			return f, true
		}
	}
	return Flavor{}, false
}

// FlavorLabel は表示名を返す。未知のキーはそのまま返す（データを隠さない）。
func FlavorLabel(key string) string {
	if f, ok := LookupFlavor(key); ok {
		return f.Label
	}
	return key
}

// FlavorShort は短縮名を返す。設定が無ければ正式名称にそのまま落とす。
func FlavorShort(key string) string {
	if f, ok := LookupFlavor(key); ok && f.Short != "" {
		return f.Short
	}
	return FlavorLabel(key)
}

// FlavorUnit は数え方を返す。未知のキーは「カップ」とする。
func FlavorUnit(key string) string {
	if f, ok := LookupFlavor(key); ok && f.Unit != "" {
		return f.Unit
	}
	return "カップ"
}

// DefaultStocks は作り置きの既定数。config/limits が未設定のときに使う。
func DefaultStocks() map[string]int {
	m := make(map[string]int, len(Flavors))
	for _, f := range Flavors {
		m[f.Key] = f.DefaultStock
	}
	return m
}

// Limits は運用中に変えられる上限設定。
//
// 商品は作り置きなので、当日用意した数 (Stock) を超えて売らないことが要件。
// MaxPerOrder は 1 組のお客様に買い占められないようにするための上限。
type Limits struct {
	MaxPerOrder int            `json:"maxPerOrder"`
	Stock       map[string]int `json:"stock"`
	// TagCount は手元にある番号札の枚数。札は使い回すので、
	// 番号はこの枚数の範囲で循環させ、まだ出ている番号は飛ばす。
	TagCount int `json:"tagCount"`
}

// LimitsResult は上限設定のバリデーション結果。
type LimitsResult struct {
	OK     bool    `json:"ok"`
	Error  string  `json:"error,omitempty"`
	Limits *Limits `json:"limits,omitempty"`
}

// DefaultLimits は初期設定。
func DefaultLimits() Limits {
	return Limits{MaxPerOrder: MaxQuantity, Stock: DefaultStocks(), TagCount: DefaultTagCount}
}

// NextTag は次に使う番号札を選ぶ。
//
// last の次から昇順に探し、いま出ている札 (inUse) は飛ばす。端まで行ったら 1 に戻る。
// 空きが 1 つも無ければ 0 を返す（＝札切れ。呼び出し側で受付を止める）。
func NextTag(last, tagCount int, inUse map[int]bool) int {
	if tagCount < 1 || tagCount > MaxTagCount {
		tagCount = DefaultTagCount
	}
	if last < 1 || last > tagCount {
		last = 0
	}
	for i := 1; i <= tagCount; i++ {
		t := (last+i-1)%tagCount + 1
		if !inUse[t] {
			return t
		}
	}
	return 0
}

// ValidateLimits は上限設定を検証し、全商品分が揃った形に整えて返す。
func ValidateLimits(maxPerOrder float64, stock map[string]float64, tagCount float64) LimitsResult {
	if maxPerOrder != float64(int(maxPerOrder)) {
		return LimitsResult{Error: "1注文あたりの上限は整数で入力してください"}
	}
	if tagCount != float64(int(tagCount)) {
		return LimitsResult{Error: "番号札の枚数は整数で入力してください"}
	}
	tc := int(tagCount)
	if tc < 1 || tc > MaxTagCount {
		return LimitsResult{Error: fmt.Sprintf("番号札の枚数は 1〜%d の範囲で入力してください", MaxTagCount)}
	}
	m := int(maxPerOrder)
	if m < MinQuantity || m > MaxPerOrderCap {
		return LimitsResult{Error: fmt.Sprintf("1注文あたりの上限は %d〜%d の範囲で入力してください", MinQuantity, MaxPerOrderCap)}
	}

	out := make(map[string]int, len(Flavors))
	for _, f := range Flavors {
		v, ok := stock[f.Key]
		if !ok {
			return LimitsResult{Error: fmt.Sprintf("%s の用意した数が入力されていません", FlavorLabel(f.Key))}
		}
		if v != float64(int(v)) {
			return LimitsResult{Error: fmt.Sprintf("%s の用意した数は整数で入力してください", FlavorLabel(f.Key))}
		}
		n := int(v)
		if n < 0 || n > MaxStock {
			return LimitsResult{Error: fmt.Sprintf("%s の用意した数は 0〜%d の範囲で入力してください", FlavorLabel(f.Key), MaxStock)}
		}
		out[f.Key] = n
	}
	return LimitsResult{OK: true, Limits: &Limits{MaxPerOrder: m, Stock: out, TagCount: tc}}
}

// DefaultPrices は初期単価。config/prices が未設定のときに使う。
func DefaultPrices() map[string]int {
	p := make(map[string]int, len(Flavors))
	for _, f := range Flavors {
		p[f.Key] = f.DefaultPrice
	}
	return p
}

// Item は 1 注文に含まれる 1 商品の明細。
// 受付画面で商品ごとに数量を入力できるため、1 注文が複数商品を持ちうる。
type Item struct {
	Flavor    string `json:"flavor"`
	Quantity  int    `json:"quantity"`
	UnitPrice int    `json:"unitPrice"`
	Price     int    `json:"price"` // UnitPrice * Quantity
}

// FlavorText は表示用の商品名。
func (i Item) FlavorText() string { return FlavorLabel(i.Flavor) }

// UnitText は数え方（個 / パック）。
func (i Item) UnitText() string { return FlavorUnit(i.Flavor) }

// Order は 1 件の注文。JSON タグは Firebase Realtime Database 上のキーと一致する。
//
// createdAt は既存データとの互換のため「HH:MM:SS の表示文字列」のまま残し、
// 並べ替え・集計に使える真の時刻は createdMs / createdISO に持たせる。
type Order struct {
	ID  string `json:"id"`
	Seq int    `json:"seq,omitempty"` // 受付順。記録の並べ替えと ID に使う通し番号
	// Tag は実際に手渡した番号札。札は使い回すので Seq とは一致せず、
	// その場で渡して札を出さなかった注文では 0 になる。
	Tag    int    `json:"tag,omitempty"`
	Number string `json:"number"` // 表示用。札がなければ空

	// Items が明細の唯一の正。単一商品だった旧レコードは normalize で
	// 1 要素の Items に寄せるため、読み出し側は常に Items だけを見ればよい。
	Items []Item `json:"items,omitempty"`

	// 以下 3 つは旧データ互換のために残す射影。単一商品のときだけ値が入る。
	Flavor    string `json:"flavor,omitempty"`
	Quantity  int    `json:"quantity"` // 注文全体の合計個数
	UnitPrice int    `json:"unitPrice,omitempty"`
	Price     int    `json:"price"` // 注文全体の合計金額
	Status    Status `json:"status"`

	// 支払いは受渡ステータスとは独立した軸。
	// 受付で先に受け取ることも、受渡口や支払い口で後から受け取ることもあるため、
	// Status に混ぜず別に持つ。Paid が false のまま completed になった注文が
	// 「渡したのに未払い」＝取りはぐれとして集計に出る。
	Paid   bool  `json:"paid"`
	PaidMs int64 `json:"paidMs,omitempty"`

	// CalledAt は呼び出し表示で強調を始めた時刻。厨房が「用意した」を押すと入る。
	CalledAt int64 `json:"calledAt,omitempty"`

	// Session は営業回。リハーサルと本番を同じ DB で回すための仕切りで、
	// 集計と画面はこれで絞る。注文を消さずに仕切れるので記録が失われない。
	// 空の旧データは DefaultSession に属するものとして扱う。
	Session string `json:"session,omitempty"`

	CreatedAt  string `json:"createdAt"`
	CreatedISO string `json:"createdISO,omitempty"`
	CreatedMs  int64  `json:"createdMs,omitempty"`
	UpdatedMs  int64  `json:"updatedMs,omitempty"`
}

// DefaultSession は session を持たない旧データが属する営業回。
const DefaultSession = "default"

// SessionOf は営業回を返す。未設定なら既定の回とみなす。
func (o Order) SessionOf() string {
	if o.Session == "" {
		return DefaultSession
	}
	return o.Session
}

// FlavorText は表示用の商品名。複数商品なら「A 2個 / B 1個」の形にまとめる。
func (o Order) FlavorText() string {
	switch len(o.Items) {
	case 0:
		return FlavorLabel(o.Flavor)
	case 1:
		return FlavorLabel(o.Items[0].Flavor)
	}
	parts := make([]string, 0, len(o.Items))
	for _, it := range o.Items {
		parts = append(parts, fmt.Sprintf("%s %d%s", it.FlavorText(), it.Quantity, it.UnitText()))
	}
	return strings.Join(parts, " / ")
}

// IsMultiItem は複数商品の注文かどうか。
func (o Order) IsMultiItem() bool { return len(o.Items) > 1 }

// PaymentText は表示用の支払い状態。
func (o Order) PaymentText() string {
	if o.Paid {
		return "支払済"
	}
	return "未払い"
}

// PaidDisplay は CSV 用の支払日時。未払いなら空。
func (o Order) PaidDisplay() string {
	if !o.Paid || o.PaidMs <= 0 {
		return ""
	}
	return time.UnixMilli(o.PaidMs).In(JST).Format("2006-01-02 15:04:05")
}

// StatusText は表示用のステータス名。
func (o Order) StatusText() string { return StatusLabel(o.Status) }

// Counts は集計対象かどうか（キャンセルは売上に数えない）。
func (o Order) Counts() bool { return o.Status != StatusCancelled }

// CreatedTime は受付時刻を JST で返す。createdMs が無い旧データでは false。
func (o Order) CreatedTime() (time.Time, bool) {
	if o.CreatedMs <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(o.CreatedMs).In(JST), true
}

// CreatedDisplay は CSV 用の日時文字列。createdMs があれば日付込み、
// 無ければ旧データの表示文字列にフォールバックする。
func (o Order) CreatedDisplay() string {
	if t, ok := o.CreatedTime(); ok {
		return t.Format("2006-01-02 15:04:05")
	}
	return o.CreatedAt
}

// idPattern: order_%06d_%d で生成した ID から seq / createdMs を復元するための分解。
func splitID(id string) (seq int, ms int64, ok bool) {
	parts := strings.Split(id, "_")
	if len(parts) != 3 || parts[0] != "order" {
		return 0, 0, false
	}
	s, err1 := strconv.Atoi(parts[1])
	m, err2 := strconv.ParseInt(parts[2], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return s, m, true
}

// seqFromNumber は "#012" のような表示番号から連番を復元する。
func seqFromNumber(number string) int {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, number)
	if digits == "" {
		return 0
	}
	n, err := strconv.Atoi(digits)
	if err != nil {
		return 0
	}
	return n
}

// normalize は DB から読んだレコードの欠損を補う。
//
// 集計から黙って落とすと売上が合わなくなるため、ここでは「捨てる」のではなく
// 「解釈できる形に寄せる」方針を取る。未知のフレーバーもキーのまま残す。
func (o *Order) normalize(key string) {
	if o.ID == "" {
		o.ID = key
	}
	if o.Status == "" {
		o.Status = StatusPending
	}
	if o.Session == "" {
		o.Session = DefaultSession
	}
	if o.Seq == 0 {
		o.Seq = seqFromNumber(o.Number)
	}
	if s, ms, ok := splitID(o.ID); ok {
		if o.Seq == 0 {
			o.Seq = s
		}
		if o.CreatedMs == 0 {
			o.CreatedMs = ms
		}
	}
	if o.Tag == 0 && o.Number != "" {
		o.Tag = seqFromNumber(o.Number) // 札番号を持たない旧データから復元
	}
	if o.Number == "" && o.Tag > 0 {
		o.Number = FormatNumber(o.Tag)
	}
	if o.Quantity < 0 {
		o.Quantity = 0
	}
	if o.Price < 0 {
		o.Price = 0
	}
	if o.UnitPrice <= 0 && o.Quantity > 0 && o.Price > 0 {
		o.UnitPrice = o.Price / o.Quantity
	}
	if t, ok := o.CreatedTime(); ok {
		if o.CreatedAt == "" {
			o.CreatedAt = t.Format("15:04:05")
		}
		if o.CreatedISO == "" {
			o.CreatedISO = t.Format(time.RFC3339)
		}
	}
	o.normalizeItems()
}

// normalizeItems は明細を Items に一本化し、注文全体の合計を導出する。
//
// 旧レコード（flavor / quantity が直接生えている単一商品）は 1 要素の Items に
// 畳み直す。これにより集計・CSV・UI は分岐なしに Items だけを見ればよくなる。
func (o *Order) normalizeItems() {
	if len(o.Items) == 0 {
		if o.Flavor == "" && o.Quantity == 0 {
			return
		}
		o.Items = []Item{{
			Flavor:    o.Flavor,
			Quantity:  o.Quantity,
			UnitPrice: o.UnitPrice,
			Price:     o.Price,
		}}
	}

	kept := o.Items[:0]
	totalPrice, totalQty := 0, 0
	for _, it := range o.Items {
		if it.Quantity < 0 {
			it.Quantity = 0
		}
		if it.Price < 0 {
			it.Price = 0
		}
		if it.UnitPrice <= 0 && it.Quantity > 0 && it.Price > 0 {
			it.UnitPrice = it.Price / it.Quantity
		}
		if it.Price == 0 && it.UnitPrice > 0 {
			it.Price = it.UnitPrice * it.Quantity
		}
		if it.Flavor == "" && it.Quantity == 0 {
			continue // 中身のない明細は落とす
		}
		kept = append(kept, it)
		totalPrice += it.Price
		totalQty += it.Quantity
	}
	o.Items = kept

	o.Price = totalPrice
	o.Quantity = totalQty
	if len(o.Items) == 1 {
		o.Flavor = o.Items[0].Flavor
		o.UnitPrice = o.Items[0].UnitPrice
	} else {
		// 複数商品では「この注文の商品」は一意に決まらない。
		// 旧フィールドに嘘の値を残すより空にするほうが安全。
		o.Flavor = ""
		o.UnitPrice = 0
	}
}

// FormatNumber は連番から注文番号表示を作る。
func FormatNumber(seq int) string { return fmt.Sprintf("#%03d", seq) }

// tagNumber は番号札の表示文字列。札を出さない注文は空にする。
func tagNumber(tag int) string {
	if tag <= 0 {
		return ""
	}
	return FormatNumber(tag)
}

// FormatID は連番と受付時刻から衝突しない注文 ID を作る。
//
// seq は Firebase のトランザクション採番なので全端末で一意。時刻だけに依存した
// 旧実装 (order_<Date.now()>) は、同一ミリ秒に 2 台が注文すると衝突していた。
// 先頭を 0 埋め seq にすることで、キーの辞書順＝受付順になる。
func FormatID(seq int, ms int64) string { return fmt.Sprintf("order_%06d_%d", seq, ms) }

// DecodeResult は注文一覧のデコード結果。
type DecodeResult struct {
	Orders  []Order
	Invalid int
	Errors  []string
}

const maxCollectedErrors = 5

// DecodeOrders は注文一覧を配列形式・オブジェクト形式どちらでも受け付ける。
//
// snapshot.val() をそのまま渡しても、Object.values() 済みの配列を渡しても動く。
// 1 件壊れていても残りは集計できるよう、要素単位でデコードする。
func DecodeOrders(data []byte) (DecodeResult, error) {
	var res DecodeResult
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return res, nil
	}

	var raws []json.RawMessage
	var keys []string

	switch trimmed[0] {
	case '[':
		if err := json.Unmarshal(trimmed, &raws); err != nil {
			return res, fmt.Errorf("注文一覧の解析に失敗しました: %w", err)
		}
		keys = make([]string, len(raws))
	case '{':
		var m map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &m); err != nil {
			return res, fmt.Errorf("注文一覧の解析に失敗しました: %w", err)
		}
		keys = make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		raws = make([]json.RawMessage, 0, len(m))
		for _, k := range keys {
			raws = append(raws, m[k])
		}
	default:
		return res, fmt.Errorf("注文一覧は配列またはオブジェクトである必要があります")
	}

	res.Orders = make([]Order, 0, len(raws))
	for i, raw := range raws {
		var o Order
		if err := json.Unmarshal(raw, &o); err != nil {
			res.Invalid++
			if len(res.Errors) < maxCollectedErrors {
				res.Errors = append(res.Errors, fmt.Sprintf("%d件目: %v", i+1, err))
			}
			continue
		}
		o.normalize(keys[i])
		if o.ID == "" {
			res.Invalid++
			if len(res.Errors) < maxCollectedErrors {
				res.Errors = append(res.Errors, fmt.Sprintf("%d件目: id がありません", i+1))
			}
			continue
		}
		res.Orders = append(res.Orders, o)
	}
	SortOrders(res.Orders)
	return res, nil
}

// SortOrders は受付順（連番→受付時刻→ID）に並べ替える。
func SortOrders(orders []Order) {
	sort.SliceStable(orders, func(i, j int) bool {
		a, b := orders[i], orders[j]
		if a.Seq != b.Seq {
			return a.Seq < b.Seq
		}
		if a.CreatedMs != b.CreatedMs {
			return a.CreatedMs < b.CreatedMs
		}
		return a.ID < b.ID
	})
}

// ItemRequest は受付画面の商品 1 行分の入力。
type ItemRequest struct {
	Flavor   string `json:"flavor"`
	Quantity int    `json:"quantity"`
}

// NewOrderRequest は受付画面からの注文生成依頼。
//
// Items が入力の正。Flavor / Quantity は単一商品だった頃の呼び出しを
// そのまま動かすための後方互換で、Items が空のときだけ使う。
type NewOrderRequest struct {
	Seq   int           `json:"seq"` // Firebase のトランザクション採番値
	Items []ItemRequest `json:"items"`

	Flavor   string `json:"flavor"`
	Quantity int    `json:"quantity"`

	Prices map[string]int `json:"prices"`
	NowMs  int64          `json:"nowMs"`

	// MaxPerOrder は 1 注文あたりの合計上限。0 なら MaxQuantity を使う。
	MaxPerOrder int `json:"maxPerOrder"`
	// Remaining は商品ごとの残り数。nil なら在庫チェックをしない。
	// 作り置きのため、ここを超える注文は受け付けてはいけない。
	Remaining map[string]int `json:"remaining"`

	// Immediate はその場で渡し切る注文。列がないときは番号札を出す意味がないため、
	// 受付と同時に受渡完了として記録する（売上には通常どおり計上される）。
	Immediate bool `json:"immediate"`

	// Session は営業回。空なら既定の回。
	Session string `json:"session"`
	// Paid は受付時点で代金を受け取ったか。番号札を使わない「その場渡し」は
	// 定義上その場で受け取っているので true で立てる。未払いで立てると
	// 支払い口に「渡したのに未払い」として積み上がり、回収する手間が生まれる。
	Paid bool `json:"paid"`

	// Tag は手渡す番号札。0 なら札を出さない。
	Tag int `json:"tag"`
	// TagCount は札の総枚数、InUseTags はいま出ている札。二重発行を防ぐために見る。
	TagCount  int   `json:"tagCount"`
	InUseTags []int `json:"inUseTags"`
}

// BuildResult は注文生成の結果。Path は書き込み先の RTDB パス。
type BuildResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Path  string `json:"path,omitempty"`
	Order *Order `json:"order,omitempty"`
}

// BuildOrder は注文レコードを組み立てる。
//
// 金額計算・ID 採番・時刻整形をすべてここに集約し、画面側では計算しない。
// 旧実装は id と書き込みパスで Date.now() を別々に 2 回呼んでいたため、
// ミリ秒をまたぐと「id と実際のパスが食い違う注文」が生まれ、
// ステータス変更が存在しないノードへ書き込まれる可能性があった。
func BuildOrder(req NewOrderRequest) BuildResult {
	fail := func(format string, args ...any) BuildResult {
		return BuildResult{Error: fmt.Sprintf(format, args...)}
	}

	if req.Seq <= 0 || req.Seq > MaxSeq {
		return fail("注文番号の採番に失敗しました (seq=%d)", req.Seq)
	}
	if req.NowMs <= 0 {
		return fail("受付時刻が取得できませんでした")
	}

	// 入力を Items に寄せる。旧形式 (Flavor/Quantity) は 1 行の Items とみなす。
	reqItems := req.Items
	legacy := false
	if len(reqItems) == 0 {
		reqItems = []ItemRequest{{Flavor: req.Flavor, Quantity: req.Quantity}}
		legacy = true
	}

	maxPerOrder := req.MaxPerOrder
	if maxPerOrder < MinQuantity || maxPerOrder > MaxPerOrderCap {
		maxPerOrder = MaxQuantity
	}

	// 同じ商品が 2 行に分かれて届いても 1 行にまとめる。
	order := []string{}
	merged := map[string]int{}
	for _, ri := range reqItems {
		if _, ok := LookupFlavor(ri.Flavor); !ok {
			return fail("商品が選択されていません (flavor=%q)", ri.Flavor)
		}
		if ri.Quantity < 0 || ri.Quantity > maxPerOrder {
			return fail("%s は 0〜%d%s で指定してください (指定=%d)", FlavorLabel(ri.Flavor), maxPerOrder, FlavorUnit(ri.Flavor), ri.Quantity)
		}
		// 単一商品の旧呼び出しでは 0 を「未入力」として弾く。
		if legacy && ri.Quantity < MinQuantity {
			return fail("個数は %d〜%d で指定してください (指定=%d)", MinQuantity, maxPerOrder, ri.Quantity)
		}
		if _, seen := merged[ri.Flavor]; !seen {
			order = append(order, ri.Flavor)
		}
		merged[ri.Flavor] += ri.Quantity
	}

	items := make([]Item, 0, len(order))
	total := 0
	totalQty := 0
	for _, key := range order {
		qty := merged[key]
		if qty == 0 {
			continue // 0 個の商品は注文に含めない
		}
		if qty > maxPerOrder {
			return fail("%s は 0〜%d%s で指定してください (指定=%d)", FlavorLabel(key), maxPerOrder, FlavorUnit(key), qty)
		}
		// 作り置きなので、用意した数を超える注文は受け付けない。
		if req.Remaining != nil {
			left, ok := req.Remaining[key]
			if !ok || left <= 0 {
				return fail("%s は売り切れです", FlavorLabel(key))
			}
			if qty > left {
				return fail("%s は残り %d%s です", FlavorLabel(key), left, FlavorUnit(key))
			}
		}
		unitPrice, ok := req.Prices[key]
		if !ok {
			return fail("%s の単価が設定されていません", FlavorLabel(key))
		}
		if unitPrice < MinUnitPrice || unitPrice > MaxUnitPrice {
			return fail("%s の単価が不正です (%d円)", FlavorLabel(key), unitPrice)
		}
		price := unitPrice * qty
		items = append(items, Item{Flavor: key, Quantity: qty, UnitPrice: unitPrice, Price: price})
		total += price
		totalQty += qty
	}
	if len(items) == 0 {
		return fail("商品が 1 つも選ばれていません")
	}
	if totalQty > maxPerOrder {
		return fail("1回のご注文は合計 %d カップまでです (指定=%d)", maxPerOrder, totalQty)
	}

	// 番号札の決定。その場渡しは札を使わない（使うと実在しない札を飛ばすことになる）。
	tag := 0
	if !req.Immediate {
		tag = req.Tag
		if tag == 0 {
			tag = req.Seq // 札を指定しない旧呼び出しは通し番号をそのまま使う
		} else {
			tagCount := req.TagCount
			if tagCount < 1 || tagCount > MaxTagCount {
				tagCount = DefaultTagCount
			}
			if tag < 1 || tag > tagCount {
				return fail("番号札 %d は 1〜%d の範囲外です", tag, tagCount)
			}
			for _, u := range req.InUseTags {
				if u == tag {
					return fail("番号札 %d はまだ出ています", tag)
				}
			}
		}
	}

	session := req.Session
	if session == "" {
		session = DefaultSession
	}

	t := time.UnixMilli(req.NowMs).In(JST)
	o := Order{
		ID:       FormatID(req.Seq, req.NowMs),
		Seq:      req.Seq,
		Tag:      tag,
		Number:   tagNumber(tag),
		Items:    items,
		Quantity: totalQty,
		Price:    total,
		Status:   StatusPending,
		// 支払いは原則として未払いで始まる。受付・支払い口・受渡口のどこで
		// 受け取るかは運用次第なので、受付時点で支払い済みと決めつけない。
		// 例外は番号札を使わない「その場渡し」で、これは受付で受け取っている。
		Paid:       req.Paid,
		Session:    session,
		CreatedAt:  t.Format("15:04:05"),
		CreatedISO: t.Format(time.RFC3339),
		CreatedMs:  req.NowMs,
		UpdatedMs:  req.NowMs,
	}
	if len(items) == 1 {
		o.Flavor = items[0].Flavor
		o.UnitPrice = items[0].UnitPrice
	}
	if req.Immediate {
		o.Status = StatusCompleted
	}
	if o.Paid {
		o.PaidMs = req.NowMs
	}
	return BuildResult{OK: true, Path: "orders/" + o.ID, Order: &o}
}

// PaymentResult は支払い状態の変更可否。
type PaymentResult struct {
	Valid  bool   `json:"valid"`
	Reason string `json:"reason"`
}

// CanSetPaid は支払い状態の変更が意味を持つかを判定する。
//
// 打ち消し（支払済み→未払い）も認める。レジの打ち間違いを直せないと、
// 売上が実際の現金と合わなくなるため。
func CanSetPaid(current, next bool, status Status) PaymentResult {
	if current == next {
		if next {
			return PaymentResult{Reason: "すでに支払い済みです"}
		}
		return PaymentResult{Reason: "すでに未払いです"}
	}
	if status == StatusCancelled && next {
		return PaymentResult{Reason: "中止された注文には支払いを記録できません"}
	}
	return PaymentResult{Valid: true}
}

// PriceResult は単価設定のバリデーション結果。
type PriceResult struct {
	OK     bool           `json:"ok"`
	Error  string         `json:"error,omitempty"`
	Prices map[string]int `json:"prices,omitempty"`
}

// ValidatePrices は単価設定を検証し、全フレーバー分が揃った map を返す。
//
// 旧実装は isNaN しか見ていなかったため、0 円・マイナス・小数が保存できた。
func ValidatePrices(in map[string]float64) PriceResult {
	out := make(map[string]int, len(Flavors))
	for _, f := range Flavors {
		v, ok := in[f.Key]
		if !ok {
			return PriceResult{Error: fmt.Sprintf("%s の単価が入力されていません", FlavorLabel(f.Key))}
		}
		if v != float64(int(v)) {
			return PriceResult{Error: fmt.Sprintf("%s の単価は整数で入力してください", FlavorLabel(f.Key))}
		}
		n := int(v)
		if n < MinUnitPrice || n > MaxUnitPrice {
			return PriceResult{Error: fmt.Sprintf("%s の単価は %d〜%d円の範囲で入力してください", FlavorLabel(f.Key), MinUnitPrice, MaxUnitPrice)}
		}
		out[f.Key] = n
	}
	return PriceResult{OK: true, Prices: out}
}

// PaymentDisplay は支払い口がお客様側の端末へ配信する金額表示。
//
// 画面側にしか存在しない形だと、ルールの $other:false と食い違った瞬間に
// 「配信だけが黙って拒否される」。items[] 追加・limits 追加・支払い追加の 3 回とも
// この食い違いで起きているので、型として置いてテストの対象に入れる。
type PaymentDisplay struct {
	OrderID string `json:"orderId"`
	Number  string `json:"number"`
	Items   string `json:"items"`
	Amount  int    `json:"amount"`
	At      int64  `json:"at"`
}
