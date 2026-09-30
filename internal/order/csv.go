package order

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"strconv"
)

// utf8BOM は Excel が UTF-8 と判定するための先頭バイト列。
// これが無いと日本語列が文字化けする。
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// newWriter は BOM 付き・CRLF 改行（Excel 互換）の CSV ライタを返す。
func newWriter(buf *bytes.Buffer) *csv.Writer {
	buf.Write(utf8BOM)
	w := csv.NewWriter(buf)
	w.UseCRLF = true
	return w
}

var ordersHeader = []string{
	"注文番号", "注文ID", "受付日時", "商品", "カップ数", "単価", "小計", "注文合計", "ステータス", "支払い", "支払日時",
}

// OrdersCSV は注文明細の CSV を生成する。並びは受付順。
//
// 1 注文に複数商品が入るため、明細 1 行につき 1 レコードを書き出す。
// 注文番号が同じ行が複数並ぶので、表計算側でそのまま集計できる。
func OrdersCSV(res DecodeResult) ([]byte, error) {
	var buf bytes.Buffer
	w := newWriter(&buf)
	if err := w.Write(ordersHeader); err != nil {
		return nil, err
	}
	for _, o := range res.Orders {
		for _, it := range o.Items {
			row := []string{
				o.Number,
				o.ID,
				o.CreatedDisplay(),
				it.FlavorText(),
				strconv.Itoa(it.Quantity),
				strconv.Itoa(it.UnitPrice),
				strconv.Itoa(it.Price),
				strconv.Itoa(o.Price),
				o.StatusText(),
				o.PaymentText(),
				o.PaidDisplay(),
			}
			if err := w.Write(row); err != nil {
				return nil, err
			}
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// SummaryCSV は売上集計サマリの CSV を生成する。
// 明細 CSV と分けることで、そのまま表計算ソフトに取り込める形を保つ。
func SummaryCSV(res DecodeResult) ([]byte, error) {
	s := Calculate(res)

	var buf bytes.Buffer
	w := newWriter(&buf)

	write := func(row ...string) error { return w.Write(row) }

	rows := [][]string{
		{"項目", "値"},
		{"受注金額(円)", strconv.Itoa(s.TotalSales)},
		{"　うち受渡完了(円)", strconv.Itoa(s.CompletedSales)},
		{"　うち未受渡(円)", strconv.Itoa(s.OutstandingSales)},
		{"キャンセル金額(円)", strconv.Itoa(s.CancelledSales)},
		{"", ""},
		{"■ 現金の照合", ""},
		{"受取済み金額(円)", strconv.Itoa(s.PaidSales)},
		{"未収金額(円)", strconv.Itoa(s.UnpaidSales)},
		{"　うち渡したのに未払い(円)", strconv.Itoa(s.UnpaidDeliveredSales)},
		{"　うち渡したのに未払い(件)", strconv.Itoa(s.UnpaidDeliveredOrders)},
		{"　うち支払い済みのまま中止(円)", strconv.Itoa(s.CancelledPaidSales)},
		{"　うち支払い済みのまま中止(件)", strconv.Itoa(s.CancelledPaidOrders)},
		{"支払い済み(件)", strconv.Itoa(s.PaidOrders)},
		{"未払い(件)", strconv.Itoa(s.UnpaidOrders)},
		{"注文件数(件)", strconv.Itoa(s.TotalOrders)},
		{"平均客単価(円)", strconv.Itoa(s.AvgOrderYen)},
		{"総カップ数", strconv.Itoa(s.TotalPacks)},
		{"受渡完了(カップ)", strconv.Itoa(s.CompletedPacks)},
		{"未受渡(カップ)", strconv.Itoa(s.PendingPacks)},
		{"　うち未処理(カップ)", strconv.Itoa(s.QueuePacks)},
		{"キャンセル(カップ)", strconv.Itoa(s.CancelledPacks)},
	}
	for _, st := range StatusOrder {
		rows = append(rows, []string{fmt.Sprintf("注文件数：%s(件)", StatusLabel(st)), strconv.Itoa(s.OrderCounts[string(st)])})
	}
	if s.InvalidRecords > 0 {
		rows = append(rows, []string{"読み取れなかったレコード(件)", strconv.Itoa(s.InvalidRecords)})
	}
	for _, row := range rows {
		if err := write(row...); err != nil {
			return nil, err
		}
	}

	// フレーバー別内訳
	if err := write(); err != nil {
		return nil, err
	}
	if err := write("商品", "売上(円)", "注文カップ数", "受渡完了", "受渡待ち", "未処理", "キャンセル"); err != nil {
		return nil, err
	}
	for _, f := range s.Flavors {
		if err := write(
			f.Label,
			strconv.Itoa(f.Sales),
			strconv.Itoa(f.OrderedPacks),
			strconv.Itoa(f.CompletedPacks),
			strconv.Itoa(f.ReadyPacks),
			strconv.Itoa(f.QueuePacks),
			strconv.Itoa(f.CancelledPacks),
		); err != nil {
			return nil, err
		}
	}

	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
