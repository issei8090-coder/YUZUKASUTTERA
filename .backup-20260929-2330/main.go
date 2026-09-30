//go:build js && wasm

// Command main は注文管理システムの WebAssembly ブリッジ。
//
// ドメインロジックは internal/order にあり、このファイルは JavaScript との
// 値の受け渡しだけを担う。どの関数も panic を握り潰して必ず値を返すため、
// Go 側のバグで UI が無反応になることはない。
//
// ビルド: GOOS=js GOARCH=wasm go build -o main.wasm .
package main

import (
	"encoding/json"
	"fmt"
	"runtime"
	"syscall/js"

	"babycastella/internal/order"
)

// version はデプロイ時に -ldflags で差し替える。
var version = "dev"

func main() {
	register()
	notifyReady()
	// main が返ると Go ランタイムが終了し、登録した関数が呼べなくなる。
	select {}
}

// notifyReady は登録完了を JS 側へ通知する。
// go.run() の戻りに依存すると、wasm_exec.js の実装変更で初期化順が崩れる余地が残るため。
//
// コールバックは Go の main ゴルーチン上で同期実行される。syscall/js は JS の例外を
// Go の panic に変換するので、ここで recover しないと「JS 側のうっかり例外」だけで
// Go ランタイムが終了し、登録済みの関数が以後すべて死ぬ。
// 画面の初期化コードに UI 側の都合を持ち込ませないため、必ずここで受け止める。
func notifyReady() {
	defer func() {
		if r := recover(); r != nil {
			consoleError(fmt.Sprintf("onGoWasmReady が例外を投げました（Go ランタイムは継続します）: %v", r))
		}
	}()
	if cb := js.Global().Get("onGoWasmReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
}

// consoleError は console.error を安全に呼ぶ（console が無い実行環境でも落ちない）。
func consoleError(msg string) {
	defer func() { _ = recover() }()
	if c := js.Global().Get("console"); c.Type() == js.TypeObject {
		c.Call("error", msg)
	}
}

func register() {
	exposeValue("goUpdateOrderStatus", goUpdateOrderStatus)
	exposeValue("goNextStatuses", goNextStatuses)
	exposeValue("goSetPaid", goSetPaid)
	exposeValue("goBuildOrder", goBuildOrder)
	exposeValue("goValidatePrices", goValidatePrices)
	exposeValue("goValidateLimits", goValidateLimits)
	exposeValue("goNextTag", goNextTag)
	exposeValue("goCalculateStats", goCalculateStats)
	exposeValue("goLabels", goLabels)
	exposeBytes("goGenerateOrdersCSV", goGenerateOrdersCSV)
	exposeBytes("goGenerateSummaryCSV", goGenerateSummaryCSV)
}

// --- JS との値変換ヘルパー ---

// toJS は Go の値を JSON 経由で JS オブジェクトに変換する。
func toJS(v any) js.Value {
	b, err := json.Marshal(v)
	if err != nil {
		return errValue("結果の変換に失敗しました: " + err.Error())
	}
	return js.Global().Get("JSON").Call("parse", string(b))
}

// errValue は呼び出し側が必ず検査できる共通のエラー形。
// valid/ok を false にしておくことで、既存の呼び出し側もそのまま失敗を検知できる。
func errValue(msg string) js.Value {
	return js.Global().Get("JSON").Call("parse", string(mustJSON(map[string]any{
		"ok":     false,
		"valid":  false,
		"error":  msg,
		"reason": msg,
	})))
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"ok":false,"valid":false,"error":"internal"}`)
	}
	return b
}

// argJSON は引数を JSON バイト列として取り出す。
// 文字列ならそのまま、オブジェクト・配列なら JSON.stringify して受け取る。
func argJSON(args []js.Value, i int) ([]byte, error) {
	if i >= len(args) {
		return nil, fmt.Errorf("引数が足りません")
	}
	v := args[i]
	switch v.Type() {
	case js.TypeString:
		return []byte(v.String()), nil
	case js.TypeNull, js.TypeUndefined:
		return []byte("null"), nil
	case js.TypeObject:
		s := js.Global().Get("JSON").Call("stringify", v)
		if s.Type() != js.TypeString {
			return nil, fmt.Errorf("引数を JSON に変換できません")
		}
		return []byte(s.String()), nil
	default:
		return nil, fmt.Errorf("引数の型が不正です: %s", v.Type())
	}
}

func argString(args []js.Value, i int) string {
	if i >= len(args) || args[i].Type() != js.TypeString {
		return ""
	}
	return args[i].String()
}

// exposeValue は JS オブジェクトを返す関数を公開する。panic はエラー値に変換する。
func exposeValue(name string, fn func(args []js.Value) js.Value) {
	js.Global().Set(name, js.FuncOf(func(_ js.Value, args []js.Value) (result any) {
		defer func() {
			if r := recover(); r != nil {
				result = errValue(fmt.Sprintf("内部エラー(%s): %v", name, r))
			}
		}()
		return fn(args)
	}))
}

// exposeBytes は Uint8Array を返す関数を公開する。失敗時は null を返す。
func exposeBytes(name string, fn func(args []js.Value) ([]byte, error)) {
	js.Global().Set(name, js.FuncOf(func(_ js.Value, args []js.Value) (result any) {
		defer func() {
			if r := recover(); r != nil {
				consoleError(fmt.Sprintf("%s panic: %v", name, r))
				result = js.Null()
			}
		}()
		b, err := fn(args)
		if err != nil {
			consoleError(name + ": " + err.Error())
			return js.Null()
		}
		buf := js.Global().Get("Uint8Array").New(len(b))
		js.CopyBytesToJS(buf, b)
		return buf
	}))
}

// decodeArg は引数 i の注文一覧をデコードする。
func decodeArg(args []js.Value, i int) (order.DecodeResult, error) {
	raw, err := argJSON(args, i)
	if err != nil {
		return order.DecodeResult{}, err
	}
	return order.DecodeOrders(raw)
}

// --- 公開関数 ---

// goUpdateOrderStatus(current, next) -> {valid, reason}
func goUpdateOrderStatus(args []js.Value) js.Value {
	res := order.CanTransition(order.Status(argString(args, 0)), order.Status(argString(args, 1)))
	return toJS(res)
}

// goNextStatuses(current) -> {statuses: [{value, label, action}]}
func goNextStatuses(args []js.Value) js.Value {
	return toJS(map[string]any{
		"ok":       true,
		"statuses": order.NextStatuses(order.Status(argString(args, 0))),
	})
}

// goSetPaid(current, next, status) -> {valid, reason}
// 支払い状態の変更可否。打ち間違いを直せるよう、打ち消しも認める。
func goSetPaid(args []js.Value) js.Value {
	current := len(args) > 0 && args[0].Truthy()
	next := len(args) > 1 && args[1].Truthy()
	status := order.Status(argString(args, 2))
	return toJS(order.CanSetPaid(current, next, status))
}

// goBuildOrder({seq, flavor, quantity, prices, nowMs}) -> {ok, error, path, order}
func goBuildOrder(args []js.Value) js.Value {
	raw, err := argJSON(args, 0)
	if err != nil {
		return errValue(err.Error())
	}
	var req order.NewOrderRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return errValue("注文内容の解析に失敗しました: " + err.Error())
	}
	return toJS(order.BuildOrder(req))
}

// goValidatePrices({plain, flavor_b}) -> {ok, error, prices}
func goValidatePrices(args []js.Value) js.Value {
	raw, err := argJSON(args, 0)
	if err != nil {
		return errValue(err.Error())
	}
	var in map[string]float64
	if err := json.Unmarshal(raw, &in); err != nil {
		return errValue("単価は数値で入力してください")
	}
	return toJS(order.ValidatePrices(in))
}

// goValidateLimits({maxPerOrder, stock}) -> {ok, error, limits}
func goValidateLimits(args []js.Value) js.Value {
	raw, err := argJSON(args, 0)
	if err != nil {
		return errValue(err.Error())
	}
	var in struct {
		MaxPerOrder float64            `json:"maxPerOrder"`
		Stock       map[string]float64 `json:"stock"`
		TagCount    float64            `json:"tagCount"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return errValue("上限は数値で入力してください")
	}
	return toJS(order.ValidateLimits(in.MaxPerOrder, in.Stock, in.TagCount))
}

// goNextTag({last, tagCount, inUse}) -> {ok, tag}
// 札は使い回すので、次の番号は「前回の次から昇順・出ている札は飛ばす・端で折り返す」。
func goNextTag(args []js.Value) js.Value {
	raw, err := argJSON(args, 0)
	if err != nil {
		return errValue(err.Error())
	}
	var in struct {
		Last     int   `json:"last"`
		TagCount int   `json:"tagCount"`
		InUse    []int `json:"inUse"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return errValue("番号札の指定が不正です")
	}
	set := make(map[int]bool, len(in.InUse))
	for _, t := range in.InUse {
		set[t] = true
	}
	tag := order.NextTag(in.Last, in.TagCount, set)
	if tag == 0 {
		return toJS(map[string]any{"ok": false, "tag": 0, "error": "番号札がすべて出ています。回収してから受け付けてください。"})
	}
	return toJS(map[string]any{"ok": true, "tag": tag})
}

// goCalculateStats(orders) -> Stats
func goCalculateStats(args []js.Value) js.Value {
	res, err := decodeArg(args, 0)
	if err != nil {
		return errValue(err.Error())
	}
	return toJS(order.Calculate(res))
}

// goLabels() -> UI が参照するマスタ（商品・ステータス・入力上限）
func goLabels(_ []js.Value) js.Value {
	statuses := map[string]string{}
	for _, s := range order.StatusOrder {
		statuses[string(s)] = order.StatusLabel(s)
	}
	return toJS(map[string]any{
		"ok":            true,
		"version":       version,
		"goVersion":     runtime.Version(),
		"flavors":       order.Flavors,
		"statuses":      statuses,
		"statusOrder":   order.StatusOrder,
		"defaultPrices": order.DefaultPrices(),
		"defaultLimits": order.DefaultLimits(),
		"limits": map[string]int{
			"minQuantity":    order.MinQuantity,
			"maxQuantity":    order.MaxQuantity,
			"minUnitPrice":   order.MinUnitPrice,
			"maxUnitPrice":   order.MaxUnitPrice,
			"maxPerOrderCap": order.MaxPerOrderCap,
			"maxStock":       order.MaxStock,
		},
	})
}

// goGenerateOrdersCSV(orders) -> Uint8Array (UTF-8 BOM 付き)
func goGenerateOrdersCSV(args []js.Value) ([]byte, error) {
	res, err := decodeArg(args, 0)
	if err != nil {
		return nil, err
	}
	return order.OrdersCSV(res)
}

// goGenerateSummaryCSV(orders) -> Uint8Array (UTF-8 BOM 付き)
func goGenerateSummaryCSV(args []js.Value) ([]byte, error) {
	res, err := decodeArg(args, 0)
	if err != nil {
		return nil, err
	}
	return order.SummaryCSV(res)
}
