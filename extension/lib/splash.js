// Silo 로고와 시작 모션.
// 로고: Libre Caslon Text Bold, 흰 글자에 i의 점만 파란색.
// 시작 모션(하루 처음 열 때만): 파란 물방울이 떨어져 i의 점이 되고, 물결 한 줄이 화면을 출렁이며 퍼짐.
// 물결이 지나가는 글자는 Gemini 빛깔로 물들었다가 흰색으로 돌아옴. 그다음 Silo가 왼쪽 위 자리로 올라가며 앱이 보임.
// 화면을 누르면 바로 건너뜀. 움직임 줄이기 설정이면 재생하지 않음.

const FAMILY = '"Libre Caslon Text"';
const FONT = (px) => `700 ${px}px ${FAMILY}`;
const LH = 1.15;
const INK = '#f4f4f2';
const DOT = '#4f9dff';
const RGB = [[79, 140, 255], [155, 108, 255], [255, 95, 162], [255, 154, 60], [61, 220, 132]];
const T_IMP = 600; const T_DOCK = 2300; const T_DOCKEND = 3000; const BIG = 64;
const V = 210; const BAND = 55; // 물결 속도(px/s), 색 띠 반폭(px)
const DAY_KEY = 'silo-splash-day';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

let em = null;

async function metrics() {
  if (em) return em;
  try { await document.fonts.load(FONT(64), 'Silo'); } catch {}
  const c = document.createElement('canvas').getContext('2d');
  c.font = FONT(100);
  c.fontKerning = 'none';
  const mi = c.measureText('i'); const md = c.measureText('ı');
  em = {
    fa: mi.fontBoundingBoxAscent / 100, fd: mi.fontBoundingBoxDescent / 100,
    stem: md.actualBoundingBoxAscent / 100, dotTop: mi.actualBoundingBoxAscent / 100,
    word: c.measureText('Sılo').width / 100, S: c.measureText('S').width / 100, i: md.width / 100,
  };
  return em;
}
const baseOff = (size) => ((LH - (em.fa + em.fd)) / 2 + em.fa) * size; // 줄 상자 위 → 글자 바닥선

/** 머리의 Silo 로고: 파란 점이 i 줄기 위쪽만 덮도록 자를 높이를 맞춤. */
export async function setupBrand(brand) {
  await metrics();
  const size = parseFloat(getComputedStyle(brand).fontSize) || 23;
  brand.style.setProperty('--dot-clip', `${baseOff(size) - em.stem * size - 0.6}px`);
}

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
  await setupBrand(brand);
  if (!force && playedToday()) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const bg = getComputedStyle(document.body).backgroundColor || '#121212';
  const cv = document.createElement('canvas');
  cv.className = 'splash';
  cv.title = '누르면 건너뛰기';
  document.body.appendChild(cv);
  document.body.classList.add('splashing');
  const ctx = cv.getContext('2d');
  const scene = document.createElement('canvas');
  const sctx = scene.getContext('2d', { willReadFrequently: true });

  const FW = window.innerWidth; const FH = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const W = cv.width = scene.width = Math.round(FW * dpr);
  const H = cv.height = scene.height = Math.round(FH * dpr);
  const out = ctx.createImageData(W, H);

  const big = Math.min(BIG, (FW * 0.6) / em.word);
  const cx = (FW - em.word * big) / 2; const cy = FH * 0.45;
  const ix = cx + em.S * big + (em.i * big) / 2;
  const iy = cy - ((em.dotTop + em.stem) / 2) * big;

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
  function drawWord(c, x, base, size, dotOn, R) {
    c.font = FONT(size); c.fontKerning = 'none'; c.textBaseline = 'alphabetic';
    if (R != null) {
      if (R <= 0) return;
      c.save(); c.beginPath(); c.arc(ix, iy, Math.max(0, R - BAND * 0.35), 0, Math.PI * 2); c.clip();
      c.fillStyle = INK; c.fillText('Sılo', x, base); c.restore();
      c.fillStyle = bandGrad(c, R); c.fillText('Sılo', x, base);
    } else {
      c.fillStyle = INK; c.fillText('Sılo', x, base);
    }
    if (dotOn) {
      const dx = x + em.S * size;
      c.save(); c.beginPath(); c.rect(dx - 2, base - size * 1.2, em.i * size + 4, size * 1.2 - em.stem * size - 0.6); c.clip();
      c.fillStyle = DOT; c.fillText('i', dx, base); c.restore();
    }
  }
  function drop(c, x, y, r) {
    c.beginPath(); c.moveTo(x, y - r * 2.1);
    c.bezierCurveTo(x + r * 0.4, y - r * 1.2, x + r, y - r * 0.6, x + r, y);
    c.arc(x, y, r, 0, Math.PI);
    c.bezierCurveTo(x - r, y - r * 0.6, x - r * 0.4, y - r * 1.2, x, y - r * 2.1);
    c.fill();
  }
  function ripple(age) {
    const src = sctx.getImageData(0, 0, W, H).data; const d = out.data;
    d.set(src);
    const ox = ix * dpr; const oy = iy * dpr;
    const R = V * dpr * age; const Wp = 26 * dpr; const k = (2 * Math.PI) / (48 * dpr);
    const A = 10 * dpr * Math.exp(-age / 1.1); const band = 2.6 * Wp;
    const Ro = R + band; const Ri = Math.max(0, R - band);
    const y0 = Math.max(0, Math.floor(oy - Ro)); const y1 = Math.min(H - 1, Math.ceil(oy + Ro));
    for (let y = y0; y <= y1; y++) {
      const dy = y - oy; const dy2 = dy * dy;
      const xo = Math.sqrt(Math.max(0, Ro * Ro - dy2));
      const xi = dy2 < Ri * Ri ? Math.sqrt(Ri * Ri - dy2) : 0;
      const spans = xi > 0 ? [[ox - xo, ox - xi], [ox + xi, ox + xo]] : [[ox - xo, ox + xo]];
      for (const [a, b] of spans) {
        const xa = Math.max(0, Math.floor(a)); const xb = Math.min(W - 1, Math.ceil(b));
        for (let x = xa; x <= xb; x++) {
          const dx = x - ox; const dist = Math.sqrt(dx * dx + dy2);
          if (dist < 1) continue;
          const u = dist - R;
          const amp = A * Math.exp(-(u / Wp) * (u / Wp)) * Math.sin(k * u);
          let sx = Math.round(x - (dx / dist) * amp); let sy = Math.round(y - (dy / dist) * amp);
          sx = sx < 0 ? 0 : sx >= W ? W - 1 : sx; sy = sy < 0 ? 0 : sy >= H ? H - 1 : sy;
          const i = (y * W + x) * 4; const j = (sy * W + sx) * 4; const sh = (amp / dpr) * 2.2;
          d[i] = src[j] + sh * 0.35; d[i + 1] = src[j + 1] + sh * 0.6; d[i + 2] = src[j + 2] + sh;
        }
      }
    }
    ctx.putImageData(out, 0, 0);
  }

  return new Promise((resolve) => {
    let raf = 0; let ended = false;
    const finish = () => {
      if (ended) return; ended = true;
      cancelAnimationFrame(raf);
      document.body.classList.remove('splashing');
      cv.classList.add('out');
      setTimeout(() => cv.remove(), 350);
      resolve();
    };
    cv.addEventListener('click', finish);
    const start = performance.now();
    const frame = (now) => {
      const t = now - start;
      // 설정 창이 열려 있으면 로고가 가려지므로 올라가지 않고 그 자리에서 사라짐
      const docking = t >= T_DOCK && !document.body.classList.contains('settings-open');
      if (t >= T_DOCK && !docking) { finish(); return; }
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.fillStyle = bg; sctx.fillRect(0, 0, FW, FH);

      let x = cx; let base = cy; let size = big; let R = null;
      if (docking) {
        const r = brand.getBoundingClientRect();
        const small = parseFloat(getComputedStyle(brand).fontSize) || 23;
        const p = ease(clamp((t - T_DOCK) / (T_DOCKEND - T_DOCK)));
        x = lerp(cx, r.left, p); base = lerp(cy, r.top + baseOff(small), p); size = lerp(big, small, p);
      } else {
        R = (V * (t - T_IMP)) / 1000;
      }
      drawWord(sctx, x, base, size, t >= T_IMP, R);
      if (t < T_IMP) {
        const p = clamp(t / T_IMP);
        sctx.fillStyle = DOT; drop(sctx, ix, lerp(-30, iy, p * p), em.i * big * 0.22);
      } else if (t < T_IMP + 120) {
        const q = (t - T_IMP) / 120;
        sctx.fillStyle = DOT; sctx.globalAlpha = 1 - q;
        sctx.beginPath(); sctx.ellipse(ix, iy, em.i * big * 0.3 * (1 + q), em.i * big * 0.12 * (1 - q * 0.5), 0, 0, Math.PI * 2); sctx.fill();
        sctx.globalAlpha = 1;
      }
      const age = (t - T_IMP) / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (age > 0 && age < 2.2) ripple(age); else ctx.drawImage(scene, 0, 0);
      if (t >= T_DOCKEND) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  });
}
