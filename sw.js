/* アプリの殻をキャッシュして、回線が切れていてもリロードから復帰できるようにする。
 *
 * 会場で一番困るのは「うっかり再読み込みして、二度と戻ってこない」こと。
 * 注文データは Firebase が持つので、ここが持つのは画面そのものだけ。
 *
 * 方針は network-first。手元のキャッシュを先に返すと、会期中に修正を出しても
 * 端末が古いまま動き続ける。オンラインなら必ず新しいほうが勝ち、
 * 通信が落ちたときだけキャッシュに落ちる。 */

const VERSION = 'yuzuka-v1';
const SHELL = [
  './', './index.html', './app.js', './wasm_exec.js', './main.wasm',
  './lib/pure.js', './lib/audio.js', './lib/motion.js',
  './vendor/firebase/firebase-app.js',
  './vendor/firebase/firebase-auth.js',
  './vendor/firebase/firebase-database.js',
  './art/tl.png', './art/tr.png', './art/bl.png', './art/br.png',
  './art/divider-yuzu.png', './art/yuzu-sm.png',
  './art/mark-yuzu.png', './art/mark-cacao.png',
];

self.addEventListener('install', e => {
  // 1 つ欠けても残りは入れる。art の差し替えなどで全体が失敗すると、
  // 会期中にキャッシュが一切効かなくなる。
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for(const k of await caches.keys()) if(k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  // 同じ配信元のものだけ扱う。Firebase との通信には触らない。
  if(url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try{
      const fresh = await fetch(req);
      // 取れたものは次のオフラインに備えて控えておく。
      if(fresh && fresh.ok){
        const c = await caches.open(VERSION);
        c.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    }catch(err){
      const hit = await caches.match(req, { ignoreSearch: true });
      if(hit) return hit;
      // 画面そのものへの要求なら、せめて入口を返して真っ白を避ける。
      if(req.mode === 'navigate'){
        const shell = await caches.match('./index.html');
        if(shell) return shell;
      }
      throw err;
    }
  })());
});
