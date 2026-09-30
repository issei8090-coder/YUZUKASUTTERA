package order

import (
	"strings"
	"testing"
)

func TestCanTransition(t *testing.T) {
	cases := []struct {
		from, to Status
		want     bool
	}{
		{StatusPending, StatusReady, true},
		{StatusPending, StatusCancelled, true},
		{StatusPending, StatusCompleted, false}, // 調理を飛ばして受渡はできない
		{StatusReady, StatusCompleted, true},
		{StatusReady, StatusPending, true},   // 差し戻し
		{StatusCompleted, StatusReady, true}, // Undo
		{StatusCompleted, StatusPending, false},
		{StatusCancelled, StatusPending, true}, // 誤操作からの復活
		{StatusCancelled, StatusCompleted, false},
		{StatusPending, StatusPending, false},
		{"", StatusReady, false},
		{StatusPending, "unknown", false},
	}
	for _, c := range cases {
		got := CanTransition(c.from, c.to)
		if got.Valid != c.want {
			t.Errorf("CanTransition(%q, %q).Valid = %v, want %v (reason=%q)", c.from, c.to, got.Valid, c.want, got.Reason)
		}
		if !got.Valid && got.Reason == "" {
			t.Errorf("CanTransition(%q, %q) は却下時に理由を返すべき", c.from, c.to)
		}
	}
}

func TestNextStatusesHasActionLabels(t *testing.T) {
	for _, from := range StatusOrder {
		for _, opt := range NextStatuses(from) {
			if opt.Action == "" {
				t.Errorf("%s -> %s のボタン文言が未定義", from, opt.Value)
			}
			if !CanTransition(from, opt.Value).Valid {
				t.Errorf("NextStatuses(%s) が許可されない %s を返した", from, opt.Value)
			}
		}
	}
}

func TestBuildOrder(t *testing.T) {
	prices := map[string]int{"plain": 300, "flavor_b": 350}
	res := BuildOrder(NewOrderRequest{Seq: 12, Flavor: "flavor_b", Quantity: 3, Prices: prices, NowMs: 1790654327731})
	if !res.OK {
		t.Fatalf("BuildOrder 失敗: %s", res.Error)
	}
	o := res.Order
	if o.Price != 1050 {
		t.Errorf("Price = %d, want 1050", o.Price)
	}
	if o.UnitPrice != 350 {
		t.Errorf("UnitPrice = %d, want 350", o.UnitPrice)
	}
	if o.Number != "#012" {
		t.Errorf("Number = %q, want #012", o.Number)
	}
	if o.Status != StatusPending {
		t.Errorf("Status = %q, want pending", o.Status)
	}
	if res.Path != "orders/"+o.ID {
		t.Errorf("Path %q と ID %q が一致しない", res.Path, o.ID)
	}
	if o.CreatedMs != 1790654327731 {
		t.Errorf("CreatedMs = %d", o.CreatedMs)
	}
	// JST で整形されていること (1790654327731 = 2026-09-29 12:58:47 JST)
	if !strings.HasPrefix(o.CreatedISO, "2026-09-29T12:58:47+09:00") {
		t.Errorf("CreatedISO = %q, JST で整形されていない", o.CreatedISO)
	}
}

// 同一ミリ秒の同時注文でも ID が衝突しないこと（旧実装のバグの回帰テスト）。
func TestBuildOrderIDsUniqueWithinSameMillisecond(t *testing.T) {
	prices := DefaultPrices()
	const ms = 1790654327731
	seen := map[string]bool{}
	for seq := 1; seq <= 50; seq++ {
		res := BuildOrder(NewOrderRequest{Seq: seq, Flavor: "plain", Quantity: 1, Prices: prices, NowMs: ms})
		if !res.OK {
			t.Fatalf("seq=%d: %s", seq, res.Error)
		}
		if seen[res.Order.ID] {
			t.Fatalf("ID が衝突した: %s", res.Order.ID)
		}
		seen[res.Order.ID] = true
	}
}

func TestBuildOrderRejectsBadInput(t *testing.T) {
	prices := map[string]int{"plain": 300, "flavor_b": 350}
	base := NewOrderRequest{Seq: 1, Flavor: "plain", Quantity: 1, Prices: prices, NowMs: 1790654327731}

	mutate := func(f func(*NewOrderRequest)) NewOrderRequest {
		r := base
		r.Prices = prices
		f(&r)
		return r
	}
	cases := map[string]NewOrderRequest{
		"seq なし":   mutate(func(r *NewOrderRequest) { r.Seq = 0 }),
		"未知のフレーバー": mutate(func(r *NewOrderRequest) { r.Flavor = "matcha" }),
		"数量 0":     mutate(func(r *NewOrderRequest) { r.Quantity = 0 }),
		"数量が上限超え":  mutate(func(r *NewOrderRequest) { r.Quantity = MaxQuantity + 1 }),
		"単価未設定":    mutate(func(r *NewOrderRequest) { r.Prices = map[string]int{"flavor_b": 350} }),
		"単価 0":     mutate(func(r *NewOrderRequest) { r.Prices = map[string]int{"plain": 0} }),
		"時刻なし":     mutate(func(r *NewOrderRequest) { r.NowMs = 0 }),
	}
	for name, req := range cases {
		if res := BuildOrder(req); res.OK {
			t.Errorf("%s: 受理されてしまった", name)
		} else if res.Error == "" {
			t.Errorf("%s: エラーメッセージが空", name)
		}
	}
}

func TestValidatePrices(t *testing.T) {
	ok := ValidatePrices(map[string]float64{"plain": 300, "flavor_b": 350})
	if !ok.OK || ok.Prices["plain"] != 300 {
		t.Fatalf("正常な単価が拒否された: %+v", ok)
	}
	bad := []map[string]float64{
		{"plain": 300},                      // flavor_b 欠落
		{"plain": 0, "flavor_b": 350},       // 0 円
		{"plain": -100, "flavor_b": 350},    // マイナス
		{"plain": 300.5, "flavor_b": 350},   // 小数
		{"plain": 300, "flavor_b": 1000000}, // 上限超え
	}
	for i, in := range bad {
		if res := ValidatePrices(in); res.OK {
			t.Errorf("case %d: 不正な単価が受理された: %v", i, in)
		}
	}
}

func TestDecodeOrdersAcceptsArrayAndMap(t *testing.T) {
	arr := `[{"id":"order_000002_2","number":"#002","flavor":"plain","quantity":1,"price":300,"status":"ready","createdAt":"10:00:01"},
	         {"id":"order_000001_1","number":"#001","flavor":"plain","quantity":2,"price":600,"status":"pending","createdAt":"10:00:00"}]`
	res, err := DecodeOrders([]byte(arr))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Orders) != 2 {
		t.Fatalf("件数 = %d, want 2", len(res.Orders))
	}
	if res.Orders[0].Number != "#001" {
		t.Errorf("受付順に並んでいない: %q が先頭", res.Orders[0].Number)
	}

	obj := `{"order_000001_1":{"number":"#001","flavor":"plain","quantity":1,"price":300,"status":"pending"}}`
	res2, err := DecodeOrders([]byte(obj))
	if err != nil {
		t.Fatal(err)
	}
	if len(res2.Orders) != 1 || res2.Orders[0].ID != "order_000001_1" {
		t.Fatalf("オブジェクト形式のデコードに失敗: %+v", res2.Orders)
	}
	if res2.Orders[0].Seq != 1 {
		t.Errorf("Seq が ID から復元されていない: %d", res2.Orders[0].Seq)
	}
}

func TestDecodeOrdersEmptyAndNull(t *testing.T) {
	for _, in := range []string{"", "null", "[]", "{}", "   "} {
		res, err := DecodeOrders([]byte(in))
		if err != nil {
			t.Errorf("DecodeOrders(%q) = %v", in, err)
		}
		if len(res.Orders) != 0 {
			t.Errorf("DecodeOrders(%q) が %d 件返した", in, len(res.Orders))
		}
	}
}

// 1 件壊れていても残りの集計を止めないこと。
func TestDecodeOrdersSkipsBrokenRecord(t *testing.T) {
	in := `[{"id":"a","number":"#001","flavor":"plain","quantity":1,"price":300,"status":"pending"},
	        {"id":"b","quantity":"こわれた","price":300}]`
	res, err := DecodeOrders([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Orders) != 1 {
		t.Errorf("生きているレコード数 = %d, want 1", len(res.Orders))
	}
	if res.Invalid != 1 {
		t.Errorf("Invalid = %d, want 1", res.Invalid)
	}
	if len(res.Errors) == 0 {
		t.Error("壊れた理由が記録されていない")
	}
}

// 旧データ（seq / createdMs 無し）でも番号から並べ替えできること。
func TestDecodeOrdersLegacyRecords(t *testing.T) {
	in := `[{"id":"order_1790654327999","number":"#010","flavor":"plain","quantity":1,"price":300,"status":"completed","createdAt":"11:00:00"},
	        {"id":"order_1790654327111","number":"#009","flavor":"plain","quantity":1,"price":300,"status":"completed","createdAt":"10:59:00"}]`
	res, err := DecodeOrders([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if res.Orders[0].Number != "#009" || res.Orders[1].Number != "#010" {
		t.Errorf("旧データの並べ替えに失敗: %q, %q", res.Orders[0].Number, res.Orders[1].Number)
	}
	if res.Orders[0].UnitPrice != 300 {
		t.Errorf("UnitPrice が補完されていない: %d", res.Orders[0].UnitPrice)
	}
}

// 1 注文に複数商品を入れられること（受付画面が商品ごとに個数を持つため）。
func TestBuildOrderMultipleItems(t *testing.T) {
	prices := map[string]int{"plain": 250, "flavor_b": 250}
	res := BuildOrder(NewOrderRequest{
		Seq:    7,
		Items:  []ItemRequest{{Flavor: "plain", Quantity: 1}, {Flavor: "flavor_b", Quantity: 1}},
		Prices: prices, NowMs: 1790654327731,
	})
	if !res.OK {
		t.Fatalf("BuildOrder 失敗: %s", res.Error)
	}
	o := res.Order
	if len(o.Items) != 2 {
		t.Fatalf("明細数 = %d, want 2", len(o.Items))
	}
	if o.Price != 500 {
		t.Errorf("合計金額 = %d, want 500", o.Price)
	}
	if o.Quantity != 2 {
		t.Errorf("合計個数 = %d, want 2", o.Quantity)
	}
	if o.Flavor != "" || o.UnitPrice != 0 {
		t.Errorf("複数商品では単一商品用フィールドを空にすべき: flavor=%q unitPrice=%d", o.Flavor, o.UnitPrice)
	}
	if !o.IsMultiItem() {
		t.Error("IsMultiItem が false")
	}
}

// 0 個の商品は注文に含めず、全部 0 なら拒否すること。
func TestBuildOrderDropsZeroQuantityItems(t *testing.T) {
	prices := map[string]int{"plain": 250, "flavor_b": 250}
	res := BuildOrder(NewOrderRequest{
		Seq:    8,
		Items:  []ItemRequest{{Flavor: "plain", Quantity: 2}, {Flavor: "flavor_b", Quantity: 0}},
		Prices: prices, NowMs: 1790654327731,
	})
	if !res.OK {
		t.Fatalf("BuildOrder 失敗: %s", res.Error)
	}
	if len(res.Order.Items) != 1 || res.Order.Items[0].Flavor != "plain" {
		t.Errorf("0 個の明細が残っている: %+v", res.Order.Items)
	}

	empty := BuildOrder(NewOrderRequest{
		Seq:    9,
		Items:  []ItemRequest{{Flavor: "plain", Quantity: 0}, {Flavor: "flavor_b", Quantity: 0}},
		Prices: prices, NowMs: 1790654327731,
	})
	if empty.OK {
		t.Error("商品 0 個の注文が受理された")
	}
}

// 旧レコード（items 無し）が 1 要素の Items に正規化されること。
func TestDecodeOrdersNormalizesLegacyToItems(t *testing.T) {
	in := `[{"id":"order_000001_1","number":"#001","flavor":"plain","quantity":2,"price":500,"status":"pending"}]`
	res, err := DecodeOrders([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	o := res.Orders[0]
	if len(o.Items) != 1 {
		t.Fatalf("Items = %+v, want 1 件", o.Items)
	}
	if o.Items[0].Flavor != "plain" || o.Items[0].Quantity != 2 || o.Items[0].UnitPrice != 250 {
		t.Errorf("旧データの正規化が不正: %+v", o.Items[0])
	}
}

// 複数商品レコードの合計が明細から導出されること。
func TestDecodeOrdersRecomputesTotalsFromItems(t *testing.T) {
	in := `[{"id":"order_000002_2","number":"#002","status":"pending",
	         "items":[{"flavor":"plain","quantity":2,"unitPrice":250,"price":500},
	                  {"flavor":"flavor_b","quantity":1,"unitPrice":250,"price":250}]}]`
	res, err := DecodeOrders([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	o := res.Orders[0]
	if o.Price != 750 {
		t.Errorf("合計金額 = %d, want 750", o.Price)
	}
	if o.Quantity != 3 {
		t.Errorf("合計個数 = %d, want 3", o.Quantity)
	}
	if got := o.FlavorText(); got != "ゆずカステラ 2カップ / チョコカステラ 1カップ" {
		t.Errorf("表示名 = %q", got)
	}
}

// 商品は作り置きなので、用意した数を超える注文は受け付けないこと。
func TestBuildOrderRespectsRemainingStock(t *testing.T) {
	prices := map[string]int{"plain": 250, "flavor_b": 250}
	base := func(qty int, remaining map[string]int) BuildResult {
		return BuildOrder(NewOrderRequest{
			Seq: 3, Items: []ItemRequest{{Flavor: "plain", Quantity: qty}},
			Prices: prices, NowMs: 1790654327731, MaxPerOrder: 10, Remaining: remaining,
		})
	}
	if res := base(3, map[string]int{"plain": 5, "flavor_b": 5}); !res.OK {
		t.Fatalf("在庫内の注文が拒否された: %s", res.Error)
	}
	if res := base(6, map[string]int{"plain": 5, "flavor_b": 5}); res.OK {
		t.Error("在庫を超える注文が受理された")
	} else if !strings.Contains(res.Error, "残り") {
		t.Errorf("残数を伝えていない: %q", res.Error)
	}
	if res := base(1, map[string]int{"plain": 0, "flavor_b": 5}); res.OK {
		t.Error("売り切れの商品が受理された")
	} else if !strings.Contains(res.Error, "売り切れ") {
		t.Errorf("売り切れを伝えていない: %q", res.Error)
	}
	// Remaining を渡さないときは在庫チェックをしない（旧呼び出し互換）
	if res := BuildOrder(NewOrderRequest{
		Seq: 4, Items: []ItemRequest{{Flavor: "plain", Quantity: 9}},
		Prices: prices, NowMs: 1790654327731, MaxPerOrder: 10,
	}); !res.OK {
		t.Errorf("在庫指定なしで拒否された: %s", res.Error)
	}
}

// 1 注文あたりの上限は合計で効くこと（買い占め防止）。
func TestBuildOrderRespectsMaxPerOrder(t *testing.T) {
	prices := map[string]int{"plain": 250, "flavor_b": 250}
	req := func(a, b, max int) NewOrderRequest {
		return NewOrderRequest{
			Seq: 5, Items: []ItemRequest{{Flavor: "plain", Quantity: a}, {Flavor: "flavor_b", Quantity: b}},
			Prices: prices, NowMs: 1790654327731, MaxPerOrder: max,
		}
	}
	if res := BuildOrder(req(2, 2, 4)); !res.OK {
		t.Fatalf("上限ちょうどが拒否された: %s", res.Error)
	}
	if res := BuildOrder(req(3, 2, 4)); res.OK {
		t.Error("合計が上限を超える注文が受理された")
	}
	// 0 や範囲外は既定値 (MaxQuantity) にフォールバックする
	if res := BuildOrder(req(5, 5, 0)); !res.OK {
		t.Errorf("既定上限にフォールバックしなかった: %s", res.Error)
	}
	if res := BuildOrder(req(6, 5, 0)); res.OK {
		t.Error("既定上限を超える注文が受理された")
	}
}

func TestValidateLimits(t *testing.T) {
	ok := ValidateLimits(8, map[string]float64{"plain": 120, "flavor_b": 80}, 50)
	if !ok.OK || ok.Limits.MaxPerOrder != 8 || ok.Limits.Stock["plain"] != 120 {
		t.Fatalf("正常な設定が拒否された: %+v", ok)
	}
	if res := ValidateLimits(8, map[string]float64{"plain": 0, "flavor_b": 0}, 50); !res.OK {
		t.Errorf("在庫 0（売り切れ）は設定できるべき: %+v", res)
	}
	bad := []struct {
		name  string
		max   float64
		stock map[string]float64
	}{
		{"上限 0", 0, map[string]float64{"plain": 10, "flavor_b": 10}},
		{"上限が上限超え", MaxPerOrderCap + 1, map[string]float64{"plain": 10, "flavor_b": 10}},
		{"上限が小数", 2.5, map[string]float64{"plain": 10, "flavor_b": 10}},
		{"在庫が欠落", 5, map[string]float64{"plain": 10}},
		{"在庫がマイナス", 5, map[string]float64{"plain": -1, "flavor_b": 10}},
		{"在庫が小数", 5, map[string]float64{"plain": 1.5, "flavor_b": 10}},
	}
	for _, c := range bad {
		if res := ValidateLimits(c.max, c.stock, 50); res.OK {
			t.Errorf("%s: 受理されてしまった", c.name)
		} else if res.Error == "" {
			t.Errorf("%s: エラーメッセージが空", c.name)
		}
	}
}

// 番号札を出さない注文は、厨房だけを飛ばして受渡待ちから始まること。
// 受渡と支払いは通常の注文と同じ経路を通らせる（勝手に完了・支払い済みにしない）。
func TestBuildOrderImmediate(t *testing.T) {
	res := BuildOrder(NewOrderRequest{
		Seq: 21, Items: []ItemRequest{{Flavor: "plain", Quantity: 1}},
		Prices: DefaultPrices(), NowMs: 1790654327731, MaxPerOrder: 10, Immediate: true,
	})
	if !res.OK {
		t.Fatalf("札なしの注文が拒否された: %s", res.Error)
	}
	if res.Order.Status != StatusReady {
		t.Errorf("Status = %q, want ready", res.Order.Status)
	}
	// 受付で勝手に支払い済みにしない。代金は受渡口で受け取り、誰かが一度押す。
	if res.Order.Paid {
		t.Error("札なしの注文が受付の時点で支払い済みになっている")
	}
	if res.Order.PaidMs != 0 {
		t.Errorf("PaidMs = %d, want 0", res.Order.PaidMs)
	}
	// 札を使わないので番号は空。通し番号だけが記録に残る。
	if res.Order.Number != "" || res.Order.Tag != 0 {
		t.Errorf("札なしの注文が札を消費した: number=%q tag=%d", res.Order.Number, res.Order.Tag)
	}
	if res.Order.Seq != 21 {
		t.Errorf("Seq = %d, want 21", res.Order.Seq)
	}
	// 在庫は通常どおり消費する
	if sold := BuildOrder(NewOrderRequest{
		Seq: 22, Items: []ItemRequest{{Flavor: "plain", Quantity: 3}},
		Prices: DefaultPrices(), NowMs: 1790654327731, MaxPerOrder: 10,
		Immediate: true, Remaining: map[string]int{"plain": 2, "flavor_b": 5},
	}); sold.OK {
		t.Error("札なしでも在庫を超えてはいけない")
	}
}

// 番号札は使い回すので、枚数の範囲で循環し、出ている札は飛ばすこと。
func TestNextTagCycles(t *testing.T) {
	none := map[int]bool{}
	if got := NextTag(0, 5, none); got != 1 {
		t.Errorf("最初の札 = %d, want 1", got)
	}
	if got := NextTag(3, 5, none); got != 4 {
		t.Errorf("次の札 = %d, want 4", got)
	}
	// 端まで行ったら 1 に戻る
	if got := NextTag(5, 5, none); got != 1 {
		t.Errorf("折り返し = %d, want 1", got)
	}
	// 出ている札は飛ばす
	inUse := map[int]bool{1: true, 2: true, 4: true}
	if got := NextTag(5, 5, inUse); got != 3 {
		t.Errorf("使用中を飛ばせていない = %d, want 3", got)
	}
	// 全部出ていたら 0（札切れ）
	all := map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}
	if got := NextTag(2, 5, all); got != 0 {
		t.Errorf("札切れ = %d, want 0", got)
	}
}

func TestBuildOrderTag(t *testing.T) {
	base := func(f func(*NewOrderRequest)) BuildResult {
		r := NewOrderRequest{
			Seq: 31, Items: []ItemRequest{{Flavor: "plain", Quantity: 1}},
			Prices: DefaultPrices(), NowMs: 1790654327731, MaxPerOrder: 10,
			Tag: 7, TagCount: 50,
		}
		f(&r)
		return BuildOrder(r)
	}
	res := base(func(r *NewOrderRequest) {})
	if !res.OK {
		t.Fatalf("札つき注文が拒否された: %s", res.Error)
	}
	if res.Order.Tag != 7 || res.Order.Number != "#007" {
		t.Errorf("札が反映されていない: tag=%d number=%q", res.Order.Tag, res.Order.Number)
	}
	// 通し番号は札と別に残る（記録の並べ替えに使う）
	if res.Order.Seq != 31 {
		t.Errorf("Seq = %d, want 31", res.Order.Seq)
	}
	if r := base(func(r *NewOrderRequest) { r.Tag = 51 }); r.OK {
		t.Error("枚数を超える札が受理された")
	}
	if r := base(func(r *NewOrderRequest) { r.InUseTags = []int{7} }); r.OK {
		t.Error("まだ出ている札が二重発行された")
	}
	// 札なしの注文は札を使わない
	im := base(func(r *NewOrderRequest) { r.Immediate = true })
	if !im.OK {
		t.Fatalf("札なしの注文が拒否された: %s", im.Error)
	}
	if im.Order.Tag != 0 || im.Order.Number != "" {
		t.Errorf("札なしの注文が札を消費した: tag=%d number=%q", im.Order.Tag, im.Order.Number)
	}
}
