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
