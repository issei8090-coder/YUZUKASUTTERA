package order

import "sort"

// FlavorStat はフレーバー別の内訳。
type FlavorStat struct {
	Key   string `json:"key"`
	Label string `json:"label"`

	QueuePacks     int `json:"queuePacks"`     // 調理待ち (pending)
	ReadyPacks     int `json:"readyPacks"`     // 受渡待ち (ready)
	CompletedPacks int `json:"completedPacks"` // 受渡完了
	CancelledPacks int `json:"cancelledPacks"`
	OrderedPacks   int `json:"orderedPacks"` // キャンセル以外の合計
	Sales          int `json:"sales"`        // キャンセル以外の売上
}

// Stats はダッシュボードと CSV サマリの集計値。
//
// 会計は受付時（注文確定時）に済ませる運用のため、売上はキャンセル以外の
// 全注文を計上する。受渡が終わっていない分は OutstandingSales で別途追える。
type Stats struct {
	TotalSales       int `json:"totalSales"`       // 受注額。キャンセル以外の合計金額
	CompletedSales   int `json:"completedSales"`   // 受渡完了分
	OutstandingSales int `json:"outstandingSales"` // 未受渡分 (pending + ready)
	CancelledSales   int `json:"cancelledSales"`   // 中止により失われた金額

	// 支払いは受渡とは独立した軸。受注額 (TotalSales) と実際に手元にある現金
	// (PaidSales) は一致しないため、締めでは必ず分けて見る。
	//   TotalSales = PaidSales + UnpaidSales
	PaidSales    int `json:"paidSales"`    // 受け取り済みの金額（実際の現金）
	UnpaidSales  int `json:"unpaidSales"`  // 未収金額
	PaidOrders   int `json:"paidOrders"`   // 支払い済みの注文件数
	UnpaidOrders int `json:"unpaidOrders"` // 未払いの注文件数

	// 渡したのに支払われていない注文＝取りはぐれ。締めで真っ先に見る数字。
	UnpaidDeliveredSales  int `json:"unpaidDeliveredSales"`
	UnpaidDeliveredOrders int `json:"unpaidDeliveredOrders"`

	// 支払い済みのまま中止された注文＝要返金。
	// キャンセルは受注額・支払い軸の双方から外れるため、ここで拾わないと
	// 「受け取った現金がどの数字にも出てこない」状態になり、締めで必ず合わない。
	CancelledPaidSales  int `json:"cancelledPaidSales"`
	CancelledPaidOrders int `json:"cancelledPaidOrders"`

	TotalPacks     int `json:"totalPacks"`
	CompletedPacks int `json:"completedPacks"`
	PendingPacks   int `json:"pendingPacks"` // 未受渡 = pending + ready
	QueuePacks     int `json:"queuePacks"`   // 調理待ち (pending) のみ
	CancelledPacks int `json:"cancelledPacks"`

	OrderCounts map[string]int `json:"orderCounts"` // ステータス別の注文件数
	TotalOrders int            `json:"totalOrders"`
	AvgOrderYen int            `json:"avgOrderYen"` // キャンセル以外の平均単価

	Flavors       []FlavorStat   `json:"flavors"`
	QueueByFlavor map[string]int `json:"queueByFlavor"` // 厨房ヘッダーの「焼き待ち」

	// 既存 UI との互換フィールド。
	PlainCompleted   int `json:"plainCompleted"`
	FlavorBCompleted int `json:"flavorBCompleted"`

	InvalidRecords int      `json:"invalidRecords"`
	Warnings       []string `json:"warnings,omitempty"`
}

// Calculate は注文一覧を集計する。
func Calculate(res DecodeResult) Stats {
	s := Stats{
		OrderCounts:    map[string]int{},
		QueueByFlavor:  map[string]int{},
		InvalidRecords: res.Invalid,
		Warnings:       res.Errors,
	}
	for _, st := range StatusOrder {
		s.OrderCounts[string(st)] = 0
	}

	// 商品マスタ順に枠を用意し、マスタに無いフレーバーが混ざっていても
	// 売上から取りこぼさないよう後ろに追加する。
	index := map[string]int{}
	for _, f := range Flavors {
		index[f.Key] = len(s.Flavors)
		s.Flavors = append(s.Flavors, FlavorStat{Key: f.Key, Label: FlavorLabel(f.Key)})
		s.QueueByFlavor[f.Key] = 0
	}
	extra := []string{}
	for _, o := range res.Orders {
		for _, it := range o.Items {
			if _, ok := index[it.Flavor]; !ok {
				index[it.Flavor] = -1
				extra = append(extra, it.Flavor)
			}
		}
	}
	sort.Strings(extra)
	for _, key := range extra {
		index[key] = len(s.Flavors)
		s.Flavors = append(s.Flavors, FlavorStat{Key: key, Label: FlavorLabel(key)})
		s.QueueByFlavor[key] = 0
	}

	// 件数・金額は注文単位、個数は明細単位で数える。
	// 1 注文に複数商品が入るため、商品別の内訳は必ず Items を回す。
	for _, o := range res.Orders {
		s.TotalOrders++
		s.OrderCounts[string(o.Status)]++

		// 支払いの集計。キャンセルは受注額に含めないので、ここでも除外する。
		// ただし「支払い済みのまま中止」は現金が手元にあるので別に拾う。
		if o.Status == StatusCancelled && o.Paid {
			s.CancelledPaidSales += o.NetPrice()
			s.CancelledPaidOrders++
		}
		if o.Status != StatusCancelled {
			if o.Paid {
				s.PaidSales += o.NetPrice()
				s.PaidOrders++
			} else {
				s.UnpaidSales += o.NetPrice()
				s.UnpaidOrders++
				if o.Status == StatusCompleted {
					s.UnpaidDeliveredSales += o.NetPrice()
					s.UnpaidDeliveredOrders++
				}
			}
		}

		switch o.Status {
		case StatusCancelled:
			s.CancelledSales += o.NetPrice()
		case StatusPending, StatusReady:
			s.OutstandingSales += o.NetPrice()
		case StatusCompleted:
			s.CompletedSales += o.NetPrice()
		}
		if o.Status != StatusCancelled {
			s.TotalSales += o.NetPrice()
		}

		for _, it := range o.Items {
			fs := &s.Flavors[index[it.Flavor]]

			switch o.Status {
			case StatusCancelled:
				s.CancelledPacks += o.WantOf(it.Flavor)
				fs.CancelledPacks += o.WantOf(it.Flavor)
				continue
			case StatusPending:
				s.QueuePacks += o.WantOf(it.Flavor)
				s.PendingPacks += o.WantOf(it.Flavor)
				fs.QueuePacks += o.WantOf(it.Flavor)
				s.QueueByFlavor[it.Flavor] += o.WantOf(it.Flavor)
			case StatusReady:
				s.PendingPacks += o.WantOf(it.Flavor)
				fs.ReadyPacks += o.WantOf(it.Flavor)
			case StatusCompleted:
				s.CompletedPacks += o.WantOf(it.Flavor)
				fs.CompletedPacks += o.WantOf(it.Flavor)
			}

			s.TotalPacks += o.WantOf(it.Flavor)
			fs.OrderedPacks += o.WantOf(it.Flavor)
			fs.Sales += o.WantOf(it.Flavor) * it.UnitPrice
		}
	}

	countedOrders := s.TotalOrders - s.OrderCounts[string(StatusCancelled)]
	if countedOrders > 0 {
		s.AvgOrderYen = s.TotalSales / countedOrders
	}
	if i, ok := index["plain"]; ok && i >= 0 {
		s.PlainCompleted = s.Flavors[i].CompletedPacks
	}
	if i, ok := index["flavor_b"]; ok && i >= 0 {
		s.FlavorBCompleted = s.Flavors[i].CompletedPacks
	}
	return s
}
