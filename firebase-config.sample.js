// このファイルを firebase-config.js にコピーして、自分のプロジェクトの値を入れてください。
// firebase-config.js は .gitignore 済みです（CI では GitHub Actions が自動生成します）。
//
// ここに書く値は「秘密情報」ではありません。Firebase の Web API キーは公開前提で、
// データの保護は database.rules.json の側で行います。
window.FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
