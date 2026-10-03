package order

import (
	"bytes"
	"encoding/csv"
	"io"
	"strings"
	"testing"
)

func decode(t *testing.T, s string) DecodeResult {
	t.Helper()
	res, err := DecodeOrders([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

const sample = `[
 {"id":"order_000001_1","number":"#001","seq":1,"flavor":"plain","quantity":2,"unitPrice":300,"price":600,"status":"completed","createdAt":"10:00:00","createdMs":1790654327731},
 {"id":"order_000002_2","number":"#002","seq":2,"flavor":"flavor_b","quantity":1,"unitPrice":350,"price":350,"status":"ready","createdAt":"10:01:00","createdMs":1790654328731},
 {"id":"order_000003_3","number":"#003","seq":3,"flavor":"plain","quantity":3,"unitPrice":300,"price":900,"status":"pending","createdAt":"10:02:00","createdMs":1790654329731},
 {"id":"order_000004_4","number":"#004","seq":4,"flavor":"flavor_b","quantity":2,"unitPrice":350,"price":700,"status":"cancelled","createdAt":"10:03:00","createdMs":1790654330731},
 {"id":"order_000005_5","number":"#005","seq":5,"flavor":"flavor_b","quantity":1,"unitPrice":350,"price":350,"status":"completed","createdAt":"10:04:00","createdMs":1790654331731}
]`

func TestCalculate(t *testing.T) {
	s := Calculate(decode(t, sample))

	// 売上はキャンセル以外: 600 + 350 + 900 + 350
	if s.TotalSales != 2200 {
		t.Errorf("TotalSales = %d, want 2200", s.TotalSales)
	}
	if s.CompletedSales != 950 {
		t.Errorf("CompletedSales = %d, want 950", s.CompletedSales)
	}
	if s.OutstandingSales != 1250 {
		t.Errorf("OutstandingSales = %d, want 1250", s.OutstandingSales)
	}
	if s.CancelledSales != 700 {
		t.Errorf("CancelledSales = %d, want 700", s.CancelledSales)
	}
	// 内訳の合計が総額に一致すること
	if s.CompletedSales+s.OutstandingSales != s.TotalSales {
		t.Errorf("売上の内訳が総額と合わない: %d + %d != %d", s.CompletedSales, s.OutstandingSales, s.TotalSales)
	}

	if s.CompletedPacks != 3 {
		t.Errorf("CompletedPacks = %d, want 3", s.CompletedPacks)
	}
	// 未受渡 = pending(3) + ready(1)
	if s.PendingPacks != 4 {
		t.Errorf("PendingPacks = %d, want 4", s.PendingPacks)
	}
	// 焼き待ち = pending のみ
	if s.QueuePacks != 3 {
		t.Errorf("QueuePacks = %d, want 3", s.QueuePacks)
	}
	if s.QueueByFlavor["plain"] != 3 || s.QueueByFlavor["flavor_b"] != 0 {
		t.Errorf("QueueByFlavor = %v", s.QueueByFlavor)
	}
	if s.CancelledPacks != 2 {
		t.Errorf("CancelledPacks = %d, want 2", s.CancelledPacks)
	}
	if s.PlainCompleted != 2 || s.FlavorBCompleted != 1 {
		t.Errorf("完了比 = %d:%d, want 2:1", s.PlainCompleted, s.FlavorBCompleted)
	}
	if s.OrderCounts["completed"] != 2 || s.OrderCounts["cancelled"] != 1 {
		t.Errorf("OrderCounts = %v", s.OrderCounts)
	}
	// 平均客単価 = 2200 / 4件
	if s.AvgOrderYen != 550 {
		t.Errorf("AvgOrderYen = %d, want 550", s.AvgOrderYen)
	}
}

func TestCalculateEmpty(t *testing.T) {
	s := Calculate(decode(t, "[]"))
	if s.TotalSales != 0 || s.TotalOrders != 0 || s.AvgOrderYen != 0 {
		t.Errorf("空データの集計が 0 でない: %+v", s)
	}
	if len(s.Flavors) != len(Flavors) {
		t.Errorf("空データでも商品マスタ分の枠が必要: %d", len(s.Flavors))
	}
}

// マスタに無いフレーバーの注文も売上から落とさないこと。
func TestCalculateKeepsUnknownFlavor(t *testing.T) {
	in := `[{"id":"a","number":"#001","flavor":"matcha","quantity":1,"price":400,"status":"completed"}]`
	s := Calculate(decode(t, in))
	if s.TotalSales != 400 {
		t.Errorf("未知フレーバーの売上が落ちた: %d", s.TotalSales)
	}
	found := false
	for _, f := range s.Flavors {
		if f.Key == "matcha" && f.Sales == 400 {
			found = true
		}
	}
	if !found {
		t.Errorf("未知フレーバーの内訳が無い: %+v", s.Flavors)
	}
}

func TestOrdersCSV(t *testing.T) {
	b, err := OrdersCSV(decode(t, sample))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(b, utf8BOM) {
		t.Fatal("UTF-8 BOM が付いていない (Excel で文字化けする)")
	}
	body := bytes.TrimPrefix(b, utf8BOM)
	if !bytes.Contains(body, []byte("\r\n")) {
		t.Error("CRLF 改行になっていない")
	}

	r := csv.NewReader(bytes.NewReader(body))
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatalf("生成した CSV が読み戻せない: %v", err)
	}
	if len(rows) != 6 {
		t.Fatalf("行数 = %d, want 6 (ヘッダー + 5件)", len(rows))
	}
	if rows[0][0] != "注文番号" {
		t.Errorf("ヘッダー = %v", rows[0])
	}
	if rows[1][0] != "#001" {
		t.Errorf("受付順に並んでいない: %v", rows[1])
	}
	// createdMs から日付込みで復元されること
	if rows[1][2] != "2026-09-29 12:58:47" {
		t.Errorf("受付日時 = %q", rows[1][2])
	}
	if rows[1][3] != "ゆずカステラ" {
		t.Errorf("商品名 = %q", rows[1][3])
	}
	if rows[4][8] != "キャンセル" {
		t.Errorf("ステータス表記 = %q", rows[4][8])
	}
}

// カンマ・引用符・改行を含む値が CSV を壊さないこと。
func TestOrdersCSVEscaping(t *testing.T) {
	in := `[{"id":"a","number":"#001,\"x\"\ny","flavor":"plain","quantity":1,"price":300,"status":"pending"}]`
	b, err := OrdersCSV(decode(t, in))
	if err != nil {
		t.Fatal(err)
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(b, utf8BOM)))
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatalf("エスケープが壊れている: %v", err)
	}
	if len(rows) != 2 || !strings.Contains(rows[1][0], `"x"`) {
		t.Errorf("値が欠落した: %v", rows)
	}
}

func TestSummaryCSV(t *testing.T) {
	b, err := SummaryCSV(decode(t, sample))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(b, utf8BOM) {
		t.Fatal("UTF-8 BOM が付いていない")
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(b, utf8BOM)))
	r.FieldsPerRecord = -1 // 可変列数（サマリ＋内訳の2ブロック）
	var got []string
	for {
		row, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("サマリ CSV が読み戻せない: %v", err)
		}
		got = append(got, strings.Join(row, ","))
	}
	joined := strings.Join(got, "\n")
	// 「総売上金額」は受注額と受取額のどちらとも読めて紛らわしいため「受注金額」に改名した。
	for _, want := range []string{"受注金額(円),2200", "受渡完了(カップ),3", "ゆずカステラ", "チョコカステラ"} {
		if !strings.Contains(joined, want) {
			t.Errorf("サマリに %q が無い\n---\n%s", want, joined)
		}
	}
}

// 支払いは受渡とは独立した軸。受注額と実際の現金が食い違うことを確かめる。
const paymentSample = `[
 {"id":"a","seq":1,"number":"#001","items":[{"flavor":"plain","quantity":1,"unitPrice":250,"price":250}],"quantity":1,"price":250,"status":"completed","paid":true,"paidMs":1790654327731,"createdAt":"10:00:00","createdMs":1790654327731},
 {"id":"b","seq":2,"number":"#002","items":[{"flavor":"plain","quantity":2,"unitPrice":250,"price":500}],"quantity":2,"price":500,"status":"completed","paid":false,"createdAt":"10:01:00","createdMs":1790654328731},
 {"id":"c","seq":3,"number":"#003","items":[{"flavor":"flavor_b","quantity":1,"unitPrice":250,"price":250}],"quantity":1,"price":250,"status":"ready","paid":true,"paidMs":1790654329731,"createdAt":"10:02:00","createdMs":1790654329731},
 {"id":"d","seq":4,"number":"#004","items":[{"flavor":"plain","quantity":1,"unitPrice":250,"price":250}],"quantity":1,"price":250,"status":"pending","paid":false,"createdAt":"10:03:00","createdMs":1790654330731},
 {"id":"e","seq":5,"number":"#005","items":[{"flavor":"plain","quantity":4,"unitPrice":250,"price":1000}],"quantity":4,"price":1000,"status":"cancelled","paid":false,"createdAt":"10:04:00","createdMs":1790654331731}
]`

func TestCalculatePayment(t *testing.T) {
	s := Calculate(decode(t, paymentSample))

	// 受注額はキャンセル以外: 250 + 500 + 250 + 250
	if s.TotalSales != 1250 {
		t.Errorf("TotalSales = %d, want 1250", s.TotalSales)
	}
	// 実際に受け取った現金: #001 + #003
	if s.PaidSales != 500 {
		t.Errorf("PaidSales = %d, want 500", s.PaidSales)
	}
	// 未収: #002 + #004
	if s.UnpaidSales != 750 {
		t.Errorf("UnpaidSales = %d, want 750", s.UnpaidSales)
	}
	// 受注額は支払い済みと未収に過不足なく分かれること
	if s.PaidSales+s.UnpaidSales != s.TotalSales {
		t.Errorf("支払いの内訳が受注額と合わない: %d + %d != %d", s.PaidSales, s.UnpaidSales, s.TotalSales)
	}
	if s.PaidOrders != 2 || s.UnpaidOrders != 2 {
		t.Errorf("件数 = 支払済%d/未払%d, want 2/2", s.PaidOrders, s.UnpaidOrders)
	}
	// 取りはぐれ: 渡したのに未払いなのは #002 だけ
	if s.UnpaidDeliveredSales != 500 || s.UnpaidDeliveredOrders != 1 {
		t.Errorf("取りはぐれ = %d円/%d件, want 500/1", s.UnpaidDeliveredSales, s.UnpaidDeliveredOrders)
	}
}

// キャンセルは未収に数えない（回収すべき金額ではない）。
func TestCancelledIsNotUnpaid(t *testing.T) {
	in := `[{"id":"x","seq":1,"number":"#001","items":[{"flavor":"plain","quantity":1,"unitPrice":250,"price":250}],"quantity":1,"price":250,"status":"cancelled","paid":false}]`
	s := Calculate(decode(t, in))
	if s.UnpaidSales != 0 || s.UnpaidOrders != 0 {
		t.Errorf("キャンセルが未収に入った: %d円/%d件", s.UnpaidSales, s.UnpaidOrders)
	}
}

func TestCanSetPaid(t *testing.T) {
	if r := CanSetPaid(false, true, StatusReady); !r.Valid {
		t.Errorf("未払い→支払済 が拒否された: %s", r.Reason)
	}
	// 打ち間違いを直せること
	if r := CanSetPaid(true, false, StatusCompleted); !r.Valid {
		t.Errorf("支払済→未払い（打ち消し）が拒否された: %s", r.Reason)
	}
	if r := CanSetPaid(true, true, StatusReady); r.Valid || r.Reason == "" {
		t.Errorf("同じ状態への変更が受理された")
	}
	if r := CanSetPaid(false, true, StatusCancelled); r.Valid {
		t.Errorf("中止済みの注文に支払いが記録できてしまった")
	}
}

// 新しい注文は必ず未払いで始まること。
func TestBuildOrderStartsUnpaid(t *testing.T) {
	res := BuildOrder(NewOrderRequest{
		Seq: 1, Items: []ItemRequest{{Flavor: "plain", Quantity: 1}},
		Prices: DefaultPrices(), NowMs: 1790654327731,
	})
	if !res.OK {
		t.Fatalf("BuildOrder 失敗: %s", res.Error)
	}
	if res.Order.Paid {
		t.Error("新規注文が支払い済みで作られた")
	}
	if res.Order.PaidMs != 0 {
		t.Errorf("PaidMs = %d, want 0", res.Order.PaidMs)
	}
}

func TestPaymentInCSV(t *testing.T) {
	b, err := OrdersCSV(decode(t, paymentSample))
	if err != nil {
		t.Fatal(err)
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(b, utf8BOM)))
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatalf("CSV が読み戻せない: %v", err)
	}
	if rows[0][9] != "支払い" || rows[0][10] != "支払日時" {
		t.Fatalf("ヘッダーに支払い列が無い: %v", rows[0])
	}
	if rows[1][9] != "支払済" {
		t.Errorf("#001 の支払い = %q, want 支払済", rows[1][9])
	}
	if rows[1][10] == "" {
		t.Error("支払済なのに支払日時が空")
	}
	if rows[2][9] != "未払い" {
		t.Errorf("#002 の支払い = %q, want 未払い", rows[2][9])
	}
	if rows[2][10] != "" {
		t.Errorf("未払いなのに支払日時が入っている: %q", rows[2][10])
	}
}

// 代金を受け取ったあとに中止した注文は、受注額にも受取済みにも入らない。
// 現金だけが手元に残るので、サマリに返金すべき額と金庫の理論値が出ること。
// 当日（2026-10-03）はこれが 5 件 1,800 円あり、どの数字にも現れなかった。
func TestRefundDueInSummaryCSV(t *testing.T) {
	res := DecodeResult{Orders: []Order{
		{ID: "a", Number: "#001", Status: StatusCompleted, Paid: true, Price: 500, Quantity: 2,
			Items: []Item{{Flavor: "plain", Quantity: 2, UnitPrice: 250, Price: 500}}, CreatedAt: "12:00:00"},
		{ID: "b", Number: "#002", Status: StatusCancelled, Paid: true, Price: 300, Quantity: 1,
			Items: []Item{{Flavor: "plain", Quantity: 1, UnitPrice: 300, Price: 300}}, CreatedAt: "12:05:00"},
	}}
	b, err := SummaryCSV(res)
	if err != nil {
		t.Fatal(err)
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(b, utf8BOM)))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatalf("サマリ CSV が読み戻せない: %v", err)
	}
	got := map[string]string{}
	for _, row := range rows {
		if len(row) >= 2 {
			got[strings.TrimSpace(row[0])] = row[1]
		}
	}
	for k, v := range map[string]string{
		"受取済み金額(円)":       "500",
		"▲ 返金すべき金額(円)":    "300",
		"▲ 返金すべき件数(件)":    "1",
		"金庫にあるべき額(円・返金前)": "800",
	} {
		if got[k] != v {
			t.Errorf("サマリ %s = %q, want %q", k, got[k], v)
		}
	}
	// 件数だけでは現物を探せない。要対応の一覧に注文IDが出ること。
	if !bytes.Contains(b, []byte("■ 要対応の注文")) || !bytes.Contains(b, []byte("要返金")) {
		t.Error("要対応の注文の一覧がサマリに出ていない")
	}
}

func TestPaymentInSummaryCSV(t *testing.T) {
	b, err := SummaryCSV(decode(t, paymentSample))
	if err != nil {
		t.Fatal(err)
	}
	// 生の文字列比較はしない。全角スペース始まりの項目名は CSV ライタが
	// 引用符で囲むため（unicode.IsSpace(U+3000) が true）、素直にパースして照合する。
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(b, utf8BOM)))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatalf("サマリ CSV が読み戻せない: %v", err)
	}
	got := map[string]string{}
	for _, row := range rows {
		if len(row) >= 2 {
			got[strings.TrimSpace(row[0])] = row[1]
		}
	}
	want := map[string]string{
		"受取済み金額(円)":      "500",
		"未収金額(円)":        "750",
		"うち渡したのに未払い(円)":  "500",
		"うち渡したのに未払い(件)":  "1",
		"支払い済み(件・中止を除く)": "2",
		"未払い(件・中止を除く)":   "2",
		// この見本の中止は未払いなので、返金すべき額は無い。
		"▲ 返金すべき金額(円)":    "0",
		"▲ 返金すべき件数(件)":    "0",
		"金庫にあるべき額(円・返金前)": "500",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("サマリ %s = %q, want %q", k, got[k], v)
		}
	}
}
