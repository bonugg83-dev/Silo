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
  // 문단·그림 경계는 줄 하나로 (여러 겹이어도 빈 줄을 만들지 않음)
  s = s.replace(/<\/?(p|div|li|h[1-6]|tr|figcaption|figure)\b[^>]*>/gi, '\u0001');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/^\n?\u0001+\n?/, '').replace(/\n?\u0001+\n?/g, '\n');
  s = decodeEntities(s).replace(/\uFEFF/g, '');
  return s.replace(/\n+$/, '');
}

/** 이미지 크기 */
export async function imageSize(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  return { width: bmp.width, height: bmp.height };
}

/** 긴 변이 maxSide보다 크면 줄인다. {dataUrl, width, height} */
export async function downscaleImage(dataUrl, maxSide = 2000) {
  const blob = await (await fetch(dataUrl)).blob();
  const okType = /^image\/(jpeg|png|webp|gif)$/.test(blob.type);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && okType && blob.size < 4.5 * 1024 * 1024) {
    return { dataUrl: dataUrl.replace(/^data:[^;]+/, `data:${blob.type}`), width: bmp.width, height: bmp.height };
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(out);
  });
  return { dataUrl: url, width: w, height: h };
}
