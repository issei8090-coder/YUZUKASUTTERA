package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"time"
)

// テンプレートに渡すデータ構造
type PageData struct {
	Title     string
	Message   string
	CreatedAt string
}

// HTMLテンプレートの定義
const htmlTemplate = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{.Title}}</title>
    <style>
        body { font-family: sans-serif; margin: 2rem; line-height: 1.6; }
        .card { border: 1px solid #ccc; padding: 1.5rem; border-radius: 8px; }
        h1 { color: #007d9c; }
    </style>
</head>
<body>
    <div class="card">
        <h1>{{.Title}}</h1>
        <p>{{.Message}}</p>
        <hr>
        <small>生成日時: {{.CreatedAt}}</small>
    </div>
</body>
</html>`

// メインのハンドラー：HTMLと関連ファイルを動的にZIP化してダウンロード配信
func downloadHandler(w http.ResponseWriter, r *http.Request) {
	// 1. HTMLテンプレートのレンダリング
	tmpl, err := template.New("index").Parse(htmlTemplate)
	if err != nil {
		http.Error(w, "Template rendering error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	data := PageData{
		Title:     "Go & HTML バンドルパッケージ",
		Message:   "このファイルはGoサーバーによって動的に生成・アーカイブされたものです。",
		CreatedAt: time.Now().Format("2006-01-02 15:04:05"),
	}

	var htmlBuffer bytes.Buffer
	if err := tmpl.Execute(&htmlBuffer, data); err != nil {
		http.Error(w, "Template execution error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// 2. レスポンスヘッダーの設定（ZIP形式として直接ダウンロード）
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\"bundle.zip\"")

	// 3. インメモリZIPライターの作成
	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	// ZIP内に HTML ファイルを作成・書き込み
	htmlFileInZip, err := zipWriter.Create("index.html")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := htmlFileInZip.Write(htmlBuffer.Bytes()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// ZIP内に README.txt を作成・書き込み
	readmeFileInZip, err := zipWriter.Create("README.txt")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	readmeContent := "Goサーバーからダウンロードしたファイル一式です。\nindex.html をブラウザで開いてご確認ください。"
	if _, err := readmeFileInZip.Write([]byte(readmeContent)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
}

// ホーム画面（ダウンロードボタンを表示するWebページ）
func homeHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `
		<!DOCTYPE html>
		<html lang="ja">
		<head>
			<meta charset="UTF-8">
			<title>ダウンロードページ</title>
			<style>
				body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f4f4f9; }
				.box { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
				.btn { display: inline-block; padding: 10px 20px; background-color: #007d9c; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; }
				.btn:hover { background-color: #005a70; }
			</style>
		</head>
		<body>
			<div class="box">
				<h2>HTML & Go ファイルパッケージ</h2>
				<p>下のボタンを押すと、すべてのファイルが1つにまとまったZIPがダウンロードされます。</p>
				<a href="/download" class="btn">まとめファイルをダウンロード (.zip)</a>
			</div>
		</body>
		</html>
	`)
}

func main() {
	http.HandleFunc("/", homeHandler)
	http.HandleFunc("/download", downloadHandler)

	port := ":8080"
	fmt.Printf("サーバーを起動しました: http://localhost%s\n", port)
	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatalf("サーバー起動エラー: %v", err)
	}
}
