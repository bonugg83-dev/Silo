// Silo 로고와 시작 모션.
// 로고: extension/brand/silo.svg (Libre Caslon Text Bold 윤곽선), 흰 글자에 i의 점만 파란색.
// 화면의 로고(SVG)와 시작 모션(canvas)이 같은 윤곽선(brand/logo.js)을 써서 크기와 점 위치가 똑같음.
// 시작 모션: 파란 물방울이 떨어져 i의 점이 되고, 물결 한 줄이 화면을 출렁이며 퍼짐.
// 물결이 지나가는 글자는 Gemini 빛깔로 물들었다가 흰색으로 돌아옴. 그다음 Silo가 실제 로고 자리로 올라가며 앱이 보임.
// 화면을 누르거나 Esc·Space·Enter를 누르면 바로 건너뜀. 움직임 줄이기 설정이면 재생하지 않음.
import { LOGO } from '../brand/logo.js';

const css = getComputedStyle(document.documentElement);
const INK = css.getPropertyValue('--brand-ink').trim() || '#f4f4f2';
const DOT = css.getPropertyValue('--brand-dot').trim() || '#4f9dff';
const RGB = [[79, 140, 255], [155, 108, 255], [255, 95, 162], [255, 154, 60], [61, 220, 132]]; // Gemini 빛깔 물결
const T_IMP = 600; const T_DOCK = 1800; const T_DOCKEND = 2600; const BIG = 120;
const V = 210; const BAND = 55; // 물결 속도(px/s), 색 띠 반폭(px)
const DAY_KEY = 'silo-splash-day';
const SKIP_KEYS = ['Escape', ' ', 'Spacebar', 'Enter'];

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

// 글자 크기 1 기준 수치 (윤곽선 단위 ÷ upm)
const U = LOGO.upm;
const em = { word: LOGO.width / U, asc: LOGO.ascent / U, box: (LOGO.ascent + LOGO.descent) / U, dx: LOGO.dotCx / U, dy: LOGO.dotCy / U };
let paths = null;
const P = () => (paths ||= { word: new Path2D(LOGO.word), dot: new Path2D(LOGO.dot) });

/** 로고 요소(SVG)의 화면 상자 → 글자 크기와 바닥선 */
const placeOf = (r) => { const size = r.height / em.box; return { x: r.left, base: r.top + em.asc * size, size }; };

function playedToday() {
  try {
    const today = new Date().toLocaleDateString('sv');
    if (localStorage.getItem(DAY_KEY) === today) return true;
    localStorage.setItem(DAY_KEY, today);
  } catch {}
  return false;
}

/** 시작 모션. 오늘 이미 봤거나 움직임 줄이기면 바로 끝남. */
export async function playSplash(brand, { force = false } = {}) {
  if (!force && playedToday()) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // 데스크톱 앱: 앱이 화면을 보여 줄 때까지 기다린 뒤 창 크기를 읽는다 (확장에는 없음)
  if (window.__siloSplashReady) await window.__siloSplashReady;

  const bg = getComputedStyle(document.body).backgroundColor || '#121212';
  const cv = document.createElement('canvas');
  cv.className = 'splash';
  cv.title = '누르거나 Esc를 누르면 건너뛰기';
  document.body.appendChild(cv);
  document.body.classList.add('splashing');
  const ctx = cv.getContext('2d');
  const scene = document.createElement('canvas');
  const sctx = scene.getContext('2d', { willReadFrequently: true });

  const FW = window.innerWidth; const FH = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const W = cv.width = scene.width = Math.round(FW * dpr);
  const H = cv.height = scene.height = Math.round(FH * dpr);

  // 로고는 창의 짧은 변 × 0.12 (최대 120px), 넓이의 60%를 넘지 않게
  const big = Math.min(BIG, Math.min(FW, FH) * 0.12, (FW * 0.6) / em.word);
  const cx = (FW - em.word * big) / 2; const cy = FH * 0.45;
  const ix = cx + em.dx * big; const iy = cy - em.dy * big;
  const dropR = big * 0.08;

  // 모션이 끝나는 자리: 로그인 화면이면 로그인 카드 로고, 앱이면 위쪽 막대 로고, 확장이면 패널 머리 로고
  function target() {
    if (document.body.classList.contains('auth-open')) {
      const a = document.querySelector('.auth-brand')?.getBoundingClientRect();
      if (a && a.height > 0) return placeOf(a);
    }
    const d = typeof window.__siloDockRect === 'function' ? window.__siloDockRect() : null;
    if (d && d.height > 0) return placeOf(d);
    return placeOf(brand.getBoundingClientRect());
  }

  function bandGrad(c, R) {
    const RM = Math.hypot(FW, FH) + BAND * 2;
    const g = c.createRadialGradient(ix, iy, 0, ix, iy, RM);
    const pos = (r) => clamp(r / RM);
    const col = (k, a) => `rgba(${RGB[k][0]},${RGB[k][1]},${RGB[k][2]},${a})`;
    const order = [4, 3, 2, 1, 0]; // 안쪽(지나간 쪽) 초록 → 바깥(물결 앞) 파랑
    g.addColorStop(pos(R - BAND), col(order[0], 0));
    order.forEach((k, n) => g.addColorStop(pos(R - BAND * 0.7 + n * (BAND * 1.4 / 4)), col(k, 1)));
    g.addColorStop(Math.min(1, pos(R + BAND) + 1e-4), col(order[4], 0));
    return g;
  }
  function logoPaths(x, base, size) {
    const k = size / U; const m = new DOMMatrix([k, 0, 0, k, x, base]);
    const w = new Path2D(); w.addPath(P().word, m);
    const d = new Path2D(); d.addPath(P().dot, m);
    return { w, d };
  }
  function drawWord(c, x, base, size, dotOn, R) {
    const { w, d } = logoPaths(x, base, size);
    if (R != null) {
      if (R <= 0) return;
      // 물결이 아직 닿지 않은 글자도 옅게 보여서 어느 순간에도 Silo가 읽힘
      c.save(); c.globalAlpha = 0.45; c.fillStyle = INK; c.fill(w); c.restore();
      c.save(); c.beginPath(); c.arc(ix, iy, Math.max(0, R - BAND * 0.35), 0, Math.PI * 2); c.clip();
      c.fillStyle = INK; c.fill(w); c.restore();
      c.fillStyle = bandGrad(c, R); c.fill(w);
    } else {
      c.fillStyle = INK; c.fill(w);
    }
    if (dotOn) { c.fillStyle = DOT; c.fill(d); }
  }
  function drop(c, x, y, r) {
    c.beginPath(); c.moveTo(x, y - r * 2.1);
    c.bezierCurveTo(x + r * 0.4, y - r * 1.2, x + r, y - r * 0.6, x + r, y);
    c.arc(x, y, r, 0, Math.PI);
    c.bezierCurveTo(x - r, y - r * 0.6, x - r * 0.4, y - r * 1.2, x, y - r * 2.1);
    c.fill();
  }
  // 물결: 고리의 밝은 띠는 그라데이션으로(빠름), 글자가 있는 작은 영역만 픽셀을 출렁이게 함.
  // 글자는 거의 일그러지지 않도록 출렁임 크기를 3px 이하로.
  const Wp = 26; const kk = (2 * Math.PI) / 48; const SPAN = 2.6 * Wp;
  function ringShade(age) {
    const R = V * age; const A = 3 * Math.exp(-age / 1.1) * 3.3; // 밝기 띠는 예전 세기(10px 기준)를 유지
    const Ro = R + SPAN; const Ri = Math.max(0, R - SPAN);
    if (Ro <= 0) return;
    const g = ctx.createRadialGradient(ix * dpr, iy * dpr, Ri * dpr, ix * dpr, iy * dpr, Ro * dpr);
    const N = 24;
    for (let n = 0; n <= N; n++) {
      const r = Ri + ((Ro - Ri) * n) / N; const u = r - R;
      const sh = Math.max(0, A * Math.exp(-(u / Wp) * (u / Wp)) * Math.sin(kk * u) * 2.2);
      g.addColorStop(n / N, `rgba(${Math.round(sh * 0.35)},${Math.round(sh * 0.6)},${Math.round(sh)},1)`);
    }
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ix * dpr, iy * dpr, Ro * dpr, 0, Math.PI * 2); ctx.arc(ix * dpr, iy * dpr, Ri * dpr, 0, Math.PI * 2, true); ctx.fill();
    ctx.restore();
  }
  function warp(age, box) {
    const R = V * dpr * age; const A = 3 * dpr * Math.exp(-age / 1.1); const wp = Wp * dpr; const k = kk / dpr; const band = SPAN * dpr;
    const ox = ix * dpr; const oy = iy * dpr;
    const x0 = Math.max(0, Math.floor(box.x * dpr)); const y0 = Math.max(0, Math.floor(box.y * dpr));
    const x1 = Math.min(W, Math.ceil((box.x + box.w) * dpr)); const y1 = Math.min(H, Math.ceil((box.y + box.h) * dpr));
    const bw = x1 - x0; const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;
    // 상자가 고리 띠와 겹치지 않으면 건너뜀
    const nx = clamp(ox, x0, x1); const ny = clamp(oy, y0, y1);
    const near = Math.hypot(nx - ox, ny - oy);
    const far = Math.max(Math.hypot(x0 - ox, y0 - oy), Math.hypot(x1 - ox, y0 - oy), Math.hypot(x0 - ox, y1 - oy), Math.hypot(x1 - ox, y1 - oy));
    if (far < R - band || near > R + band) return;
    const img = sctx.getImageData(x0, y0, bw, bh); const src = img.data; const out = new Uint8ClampedArray(src);
    for (let y = 0; y < bh; y++) {
      const dy = y + y0 - oy;
      for (let x = 0; x < bw; x++) {
        const dx = x + x0 - ox; const dist = Math.sqrt(dx * dx + dy * dy);
        const u = dist - R;
        if (dist < 1 || u > band || u < -band) continue;
        const amp = A * Math.exp(-(u / wp) * (u / wp)) * Math.sin(k * u);
        let sx = Math.round(x - (dx / dist) * amp); let sy = Math.round(y - (dy / dist) * amp);
        sx = sx < 0 ? 0 : sx >= bw ? bw - 1 : sx; sy = sy < 0 ? 0 : sy >= bh ? bh - 1 : sy;
        const i = (y * bw + x) * 4; const j = (sy * bw + sx) * 4;
        out[i] = src[j]; out[i + 1] = src[j + 1]; out[i + 2] = src[j + 2]; out[i + 3] = src[j + 3];
      }
    }
    ctx.putImageData(new ImageData(out, bw, bh), x0, y0);
  }

  return new Promise((resolve) => {
    let raf = 0; let ended = false;
    const onKey = (e) => { if (SKIP_KEYS.includes(e.key)) { e.preventDefault(); finish(); } };
    const finish = () => {
      if (ended) return; ended = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('splashing');
      cv.classList.add('out');
      setTimeout(() => cv.remove(), 350);
      resolve();
    };
    cv.addEventListener('click', finish);
    window.addEventListener('keydown', onKey, true);
    const start = performance.now();
    let dock = null;
    const frame = (now) => {
      const t = now - start;
      // 설정 창이 열려 있으면 로고가 가려지므로 올라가지 않고 그 자리에서 사라짐
      const docking = t >= T_DOCK && !document.body.classList.contains('settings-open');
      if (t >= T_DOCK && !docking) { finish(); return; }
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.fillStyle = bg; sctx.fillRect(0, 0, FW, FH);

      let x = cx; let base = cy; let size = big; let R = null;
      if (docking) {
        dock ||= target();
        const p = ease(clamp((t - T_DOCK) / (T_DOCKEND - T_DOCK)));
        x = lerp(cx, dock.x, p); base = lerp(cy, dock.base, p); size = lerp(big, dock.size, p);
      } else {
        R = (V * (t - T_IMP)) / 1000;
      }
      drawWord(sctx, x, base, size, t >= T_IMP, R);
      if (t < T_IMP) {
        const p = clamp(t / T_IMP);
        sctx.fillStyle = DOT; drop(sctx, ix, lerp(dropR * 2.1 + 6, iy, p * p), dropR); // 첫 프레임부터 화면 안에 보임
      } else if (t < T_IMP + 120) {
        const q = (t - T_IMP) / 120;
        sctx.fillStyle = DOT; sctx.globalAlpha = 1 - q;
        sctx.beginPath(); sctx.ellipse(ix, iy, dropR * 1.35 * (1 + q), dropR * 0.55 * (1 - q * 0.5), 0, 0, Math.PI * 2); sctx.fill();
        sctx.globalAlpha = 1;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(scene, 0, 0);
      const age = (t - T_IMP) / 1000;
      if (age > 0 && age < 2.2) {
        const m = 6; // 글자 상자 + 여유
        warp(age, { x: x - m, y: base - em.asc * size - m, w: em.word * size + m * 2, h: em.box * size + m * 2 });
        ringShade(age);
      }
      if (t >= T_DOCKEND) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  });
}
