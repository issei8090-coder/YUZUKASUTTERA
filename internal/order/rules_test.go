package order

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// database.rules.json を読み、Go の型とフィールド名がずれていないか照合する。
//
// この不一致は実際に 3 回起きている（items 追加時・limits 追加時・支払い追加時）。
// 症状は「画面では確定できるのに DB だけが拒否する」で、原因が見えにくい。
// ルールは $other を false にしているため、Go が新しいフィールドを足した瞬間に
// 全注文の書き込みが落ちる。ここで落としておけば本番前に気づける。
func loadRules(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile("../../database.rules.json")
	if err != nil {
		t.Fatalf("database.rules.json を読めない: %v", err)
	}
	var root map[string]any
	if err := json.Unmarshal(b, &root); err != nil {
		t.Fatalf("database.rules.json が JSON として不正: %v", err)
	}
	return root
}

// jsonFields は構造体の json タグ名を集める。
func jsonFields(v any) map[string]bool {
	out := map[string]bool{}
	rt := reflect.TypeOf(v)
	for i := 0; i < rt.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		name := strings.Split(tag, ",")[0]
		if name != "" {
			out[name] = true
		}
	}
	return out
}

// allowedChildren は $other:false で閉じたノードが明示的に許可する子の名前。
func allowedChildren(t *testing.T, node map[string]any) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for k := range node {
		if strings.HasPrefix(k, ".") || k == "$other" {
			continue
		}
		out[k] = true
	}
	return out
}

func child(t *testing.T, m map[string]any, path ...string) map[string]any {
	t.Helper()
	cur := m
	for _, p := range path {
		next, ok := cur[p].(map[string]any)
		if !ok {
			t.Fatalf("ルールに %s が無い", strings.Join(path, "/"))
		}
		cur = next
	}
	return cur
}

func TestRulesCoverOrderFields(t *testing.T) {
	rules := loadRules(t)
	orderNode := child(t, rules, "rules", "orders", "$orderId")
	allowed := allowedChildren(t, orderNode)

	for f := range jsonFields(Order{}) {
		if !allowed[f] {
			t.Errorf("Order.%s をルールが許可していない（$other:false のため書き込みが全て拒否される）", f)
		}
	}
}

func TestRulesCoverItemFields(t *testing.T) {
	rules := loadRules(t)
	itemNode := child(t, rules, "rules", "orders", "$orderId", "items", "$index")
	allowed := allowedChildren(t, itemNode)

	for f := range jsonFields(Item{}) {
		if !allowed[f] {
			t.Errorf("Item.%s をルールが許可していない", f)
		}
	}
}

// 個数の上限はルールと Go で二重定義になっている。
// ルール側が config/limits/maxPerOrder を参照していないと、
// 管理画面で上限を上げた瞬間に DB が注文を拒否し始める（実際に起きた）。
func TestRulesQuantityFollowsConfiguredLimit(t *testing.T) {
	rules := loadRules(t)
	q := child(t, rules, "rules", "orders", "$orderId", "items", "$index", "quantity")
	expr, _ := q[".validate"].(string)

	if !strings.Contains(expr, "config/limits/maxPerOrder") {
		t.Error("明細の個数上限が config/limits/maxPerOrder を参照していない。" +
			"固定値だと管理画面で上限を変えたときに DB だけが拒否する")
	}
	if !strings.Contains(expr, "99") {
		t.Errorf("最終防壁 (MaxPerOrderCap=%d) がルールに無い", MaxPerOrderCap)
	}
}

// 商品マスタに追加した商品を、価格表を介してルールが受け付けられること。
func TestRulesFlavorIsBootstrappable(t *testing.T) {
	rules := loadRules(t)
	f := child(t, rules, "rules", "orders", "$orderId", "items", "$index", "flavor")
	expr, _ := f[".validate"].(string)

	// 価格表が空のまっさらな DB でも 1 件目の注文が通ること。
	if !strings.Contains(expr, "!root.child('config/prices').exists()") {
		t.Error("価格表が未作成のとき注文が 1 件も通らない（鶏と卵になる）")
	}
}

// 金額表示の配信もルールと突き合わせる。
//
// この形は長らく画面側にしか無く、ルールの $other:false と食い違った瞬間に
// 「配信だけが黙って拒否される」状態になっていた。items[] 追加・limits 追加・
// 支払い追加の 3 回とも同じ食い違いで起きているので、4 回目を防ぐ。
func TestRulesCoverPaymentDisplayFields(t *testing.T) {
	rules := loadRules(t)
	node := child(t, rules, "rules", "display", "payment", "$station")
	allowed := allowedChildren(t, node)

	for f := range jsonFields(PaymentDisplay{}) {
		if !allowed[f] {
			t.Errorf("PaymentDisplay.%s をルールが許可していない（金額がお客様の画面に出ない）", f)
		}
	}
}

// 支払い口を増やしても互いに上書きしないこと。
// 単一ノードのままだと、2 口目を開いた瞬間に 1 口目の金額が消える。
func TestRulesPaymentDisplayIsPerStation(t *testing.T) {
	rules := loadRules(t)
	payment := child(t, rules, "rules", "display", "payment")
	if _, ok := payment["$station"]; !ok {
		t.Error("display/payment が支払い口ごとに分かれていない。2 口目が 1 口目を上書きする")
	}
}

// 確定後に動かしてはいけない項目が、本当に固定されていること。
//
// number だけ不変で tag が可変、のような非対称があると、
// 表示している番号と実際に渡した札がずれても DB は受け入れてしまう。
func TestRulesFreezeConfirmedFields(t *testing.T) {
	rules := loadRules(t)
	node := child(t, rules, "rules", "orders", "$orderId")

	frozen := []string{"number", "seq", "tag", "quantity", "price", "session", "createdAt", "createdMs"}
	for _, f := range frozen {
		f := f
		t.Run(f, func(t *testing.T) {
			child, ok := node[f].(map[string]any)
			if !ok {
				t.Fatalf("%s のルールが無い", f)
			}
			expr, _ := child[".validate"].(string)
			if !strings.Contains(expr, "newData.val() === data.val()") {
				t.Errorf("%s が確定後も書き換えられる。確定した注文の内容が後から変わる", f)
			}
		})
	}
}

// 使わなくなったノードを開けたままにしない。
// presence は受付機の在席検知に使っていたが、番号札を手で選ぶ方式に変わって
// 役目を失った。書き込めるノードが残っていると、攻撃面だけが残る。
func TestRulesHaveNoUnusedNodes(t *testing.T) {
	rules := loadRules(t)
	root := child(t, rules, "rules")
	for _, gone := range []string{"presence"} {
		if _, ok := root[gone]; ok {
			t.Errorf("使われていないノード %q がルールに残っている", gone)
		}
	}
}

// 設定ノードが開きっぱなしになっていないこと。
//
// config/prices のキーは注文の flavor 検証に使われる。ここに任意のキーを
// 足せると、でたらめな商品キーの注文を通せてしまう。
func TestRulesConfigIsClosed(t *testing.T) {
	rules := loadRules(t)
	cfg := child(t, rules, "rules", "config")
	if _, ok := cfg["$other"]; !ok {
		t.Error("config の直下が閉じていない（任意のノードを作れる）")
	}
	price := child(t, rules, "rules", "config", "prices", "$flavor")
	expr, _ := price[".validate"].(string)
	if !strings.Contains(expr, "$flavor.matches") {
		t.Error("config/prices のキー名が検証されていない。" +
			"でたらめな商品キーを足すと、その商品の注文が通ってしまう")
	}
}

// 注文を作るときに立てられる状態が、Go の BuildOrder と一致していること。
//
// BuildOrder は厨房を通す注文を pending、番号札を出さない注文（厨房を飛ばす）を
// ready で立てる。ルール側の作成時パターンがこれとずれると、
// 「画面では確定できるのに DB だけが拒否する」が起きる。実際に完了扱いを
// やめたときここがずれた。
func TestRulesCreatableStatuses(t *testing.T) {
	rules := loadRules(t)
	st := child(t, rules, "rules", "orders", "$orderId", "status")
	expr, _ := st[".validate"].(string)

	// 作成時の枝は三項演算子の前半。ここだけを見る。
	head, _, found := strings.Cut(expr, ":")
	if !found {
		t.Fatalf("status の .validate に作成時の枝が無い: %s", expr)
	}
	for _, want := range []string{string(StatusPending), string(StatusReady)} {
		if !strings.Contains(head, want) {
			t.Errorf("%q で注文を作れない。BuildOrder はこの状態で立てる", want)
		}
	}
	// completed で作れてはいけない。受渡と支払いを飛ばした注文が生まれる。
	if strings.Contains(head, string(StatusCompleted)) {
		t.Error("completed で注文を作れてしまう。受渡も支払いも通らない注文が入る")
	}
}
