/* ============================================================
   動き。受付の操作に手応えを返すためのものだけを置く。

   動かす目的は装飾ではなく「押したことが伝わる」こと。したがって
   prefers-reduced-motion のときは動かさず、結果だけを即座に反映する。
   ============================================================ */

export const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOut = t => 1 - Math.pow(1 - t, 3);

/* 数字を走らせる。合計金額が跳ねると「変わった」ことが目で追える。
   桁が動く途中も読める値であってほしいので、補間するのは値そのもの。 */
export function countUp(el, from, to, render, ms = 420){
  if(!el) return;
  if(reduced() || from === to){ el.innerHTML = render(to); return; }
  const prev = el._countTimer;
  if(prev) cancelAnimationFrame(prev);
  const t0 = performance.now();
  const tick = now => {
    const p = Math.min(1, (now - t0) / ms);
    const v = Math.round(from + (to - from) * easeOut(p));
    el.innerHTML = render(v);
    if(p < 1) el._countTimer = requestAnimationFrame(tick);
    else { el._countTimer = null; el.innerHTML = render(to); }
  };
  el._countTimer = requestAnimationFrame(tick);
}

/* 押した手応え。数量やボタンを一瞬だけ張らせる。 */
export function pop(el, scale = 1.18){
  if(!el || reduced() || !el.animate) return;
  el.animate(
    [{ transform: 'scale(1)' }, { transform: `scale(${scale})` }, { transform: 'scale(1)' }],
    { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' }
  );
}

/* 効かない操作を返す。音と揃えて、無反応にしない。 */
export function nudge(el){
  if(!el || reduced() || !el.animate) return;
  el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' },
     { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }],
    { duration: 220, easing: 'ease-out' }
  );
}

/* 受付が済んだ合図。ゆずの色の粒を短く散らす。
   派手に動かすと祭りの喧騒で酔うので、数を絞って上へ抜けるだけにする。 */
export function bloom(host, count = 14){
  if(!host || reduced() || !host.animate) return;
  const layer = document.createElement('div');
  layer.className = 'bloom-layer';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);

  for(let i = 0; i < count; i++){
    const dot = document.createElement('span');
    dot.className = 'bloom-dot';
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const dist  = 90 + Math.random() * 120;
    const size  = 6 + Math.random() * 10;
    dot.style.width = dot.style.height = size + 'px';
    layer.appendChild(dot);
    dot.animate(
      [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.3)' },
       { opacity: .95, offset: .25 },
       { opacity: 0, transform:
          `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist - 40}px)) scale(1)` }],
      { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.16,.8,.32,1)', fill: 'forwards' }
    );
  }
  setTimeout(() => layer.remove(), 1800);
}

/* 金色の帯を一度だけ走らせる。確定した瞬間に線が光る。 */
export function shimmer(el){
  if(!el || reduced() || !el.animate) return;
  el.animate(
    [{ backgroundPosition: '-160% 0' }, { backgroundPosition: '260% 0' }],
    { duration: 900, easing: 'ease-in-out' }
  );
}
