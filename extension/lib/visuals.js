// 시각자료(그림/사진/그래프/도표/지도) 블록 처리와 이미지 자르기.

export const IMAGE_KINDS = ['그림', '사진', '그래프', '도표', '지도'];
const START_RE = /^\[(그림|사진|그래프|도표|지도)(?![ ]*끝\])[^\]\n]*\](.*)$/; // [그림] 제목, [그림 2-4], [그림 제목] 모두

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 텍스트에서 "@@i"가 있는 시각자료 블록을 순서대로 찾는다.
 * @returns {{start: number, end: number, kind: string, headLine: string, captionLines: string[]}[]}
 */
export function parseVisualBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(START_RE);
    if (!m) continue;
    const kind = m[1];
    const endIdx = lines.findIndex((l, j) => j > i && l.trim() === `[${kind} 끝]`);
    if (endIdx === -1) continue;
    const inner = lines.slice(i + 1, endIdx);
    const at = inner.findIndex((l) => l.trim() === '@@i');
    if (at === -1) continue;
    blocks.push({ start: i, end: endIdx, kind, headLine: lines[i], captionLines: inner.slice(at + 1) });
    i = endIdx;
  }
  return blocks;
}

/** 사이트의 이미지 자르기 창이 넣는 것과 같은 모양의 HTML */
export function figureHtml(block, fig) {
  let html = `<p>${esc(block.headLine)}</p><p>@@i</p><figure class="image">`;
  html += fig.width > 500 ? `<img src="${esc(fig.src)}" style="max-width:500px;">` : `<img src="${esc(fig.src)}">`;
  const cap = block.captionLines.filter((l) => l.trim() !== '');
  if (cap.length) html += `<figcaption>${cap.map(esc).join('<br>')}</figcaption>`;
  html += `</figure><p>[${block.kind} 끝]</p>`;
  return html;
}

/**
 * 텍스트 → 편집기 데이터. 일반 줄은 사이트 형식대로 <br>로 잇고,
 * 이미지가 준비된 시각자료 블록은 <figure> HTML로 바꾼다.
 * @param {(null|{src: string, width: number})[]} figures 블록 순서대로
 */
export function buildEditorData(text, figures = []) {
  const lines = String(text ?? '').split('\n');
  const blocks = parseVisualBlocks(text);
  const parts = [];
  let buf = [];
  const flush = () => {
    if (buf.length) parts.push(buf.map(esc).join('<br>\n'));
    buf = [];
  };
  let b = 0;
  for (let i = 0; i < lines.length; i++) {
    const block = blocks[b];
    if (block && i === block.start) {
      const fig = figures[b];
      if (fig && fig.src) {
        flush();
        parts.push(figureHtml(block, fig));
        i = block.end;
        b++;
        continue;
      }
      b++;
    }
    buf.push(lines[i]);
  }
  flush();
  return parts.join('\n');
}

/** 편집기에 이미 들어 있는 그림들: 주소와, 넓은 그림(max-width:500px)인지 */
export function existingFigures(html) {
  return Array.from(String(html ?? '').matchAll(/<figure[^>]*>[\s\S]*?(<img[^>]*>)[\s\S]*?<\/figure>/gi)).map((m) => {
    const src = (m[1].match(/\ssrc=["']([^"']+)["']/i) || [])[1] || '';
    return { src: src.replace(/&amp;/g, '&'), width: /max-width\s*:\s*500px/i.test(m[1]) ? 501 : 0 };
  });
}

/** 편집기에 이미 들어 있는 그림(<figure>)의 이미지 주소들 */
export function existingFigureSrcs(html) {
  return Array.from(String(html ?? '').matchAll(/<figure[^>]*>[\s\S]*?<img[^>]*\ssrc=["']([^"']+)["'][\s\S]*?<\/figure>/gi)).map((m) => m[1]);
}

/**
 * 원본 이미지에서 영역을 잘라 PNG data URL로 만든다.
 * @param {string} dataUrl 원본 이미지
 * @param {{x:number,y:number,w:number,h:number}} box 0~1 비율
 */
export async function cropImage(dataUrl, box, { pad = 0.01, trim = true } = {}) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const W = bmp.width;
  const H = bmp.height;
  let x0 = Math.max(0, Math.floor((box.x - pad) * W));
  let y0 = Math.max(0, Math.floor((box.y - pad) * H));
  let x1 = Math.min(W, Math.ceil((box.x + box.w + pad) * W));
  let y1 = Math.min(H, Math.ceil((box.y + box.h + pad) * H));
  if (x1 - x0 < 4 || y1 - y0 < 4) throw new Error('잘라낼 영역이 너무 작아요.');
  let canvas = new OffscreenCanvas(x1 - x0, y1 - y0);
  let ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  if (trim) {
    // 가장자리의 흰 여백을 다듬되 4px은 남긴다
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const isInk = (px, py) => {
      const k = (py * width + px) * 4;
      return data[k] < 225 || data[k + 1] < 225 || data[k + 2] < 225;
    };
    const rowInk = (py) => { let n = 0; for (let px = 0; px < width; px += 2) if (isInk(px, py)) n++; return n > 1; };
    const colInk = (px) => { let n = 0; for (let py = 0; py < height; py += 2) if (isInk(px, py)) n++; return n > 1; };
    let t = 0; while (t < height - 1 && !rowInk(t)) t++;
    let bt = height - 1; while (bt > t && !rowInk(bt)) bt--;
    let l = 0; while (l < width - 1 && !colInk(l)) l++;
    let r = width - 1; while (r > l && !colInk(r)) r--;
    const m = 4;
    t = Math.max(0, t - m); l = Math.max(0, l - m);
    bt = Math.min(height - 1, bt + m); r = Math.min(width - 1, r + m);
    if (r - l > 10 && bt - t > 10 && (r - l < width - 2 || bt - t < height - 2)) {
      const c2 = new OffscreenCanvas(r - l + 1, bt - t + 1);
      c2.getContext('2d').drawImage(canvas, l, t, r - l + 1, bt - t + 1, 0, 0, r - l + 1, bt - t + 1);
      canvas = c2;
      ctx = c2.getContext('2d');
    }
  }
  const out = await canvas.convertToBlob({ type: 'image/png' });
  const url = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(out);
  });
  return { dataUrl: url, width: canvas.width, height: canvas.height };
}
