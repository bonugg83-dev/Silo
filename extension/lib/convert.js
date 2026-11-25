// 편집기 데이터(“줄<br>\n줄”)와 일반 텍스트 사이 변환, 이미지 크기 줄이기.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** CKEditor getData() 결과 → 줄 단위 텍스트 */
export function editorHtmlToText(html) {
  let s = String(html ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/\n/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/﻿/g, '');
  return s.replace(/\n+$/, '');
}

/** 텍스트 → CKEditor setData()에 넣을 데이터 (사이트 형식: 줄마다 <br>) */
export function textToEditorData(text) {
  const esc = (line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text ?? '').split('\n').map(esc).join('<br>\n');
}

/** 긴 변이 maxSide보다 크면 줄여서 JPEG data URL로 돌려준다. */
export async function downscaleImage(dataUrl, maxSide = 2400) {
  const blob = await (await fetch(dataUrl)).blob();
  const okType = /^image\/(jpeg|png|webp|gif)$/.test(blob.type);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && okType && blob.size < 4.5 * 1024 * 1024) return dataUrl.replace(/^data:[^;]+/, `data:${blob.type}`);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(out);
  });
}
