// 편집기 데이터(“줄<br>\n줄”)와 일반 텍스트 사이 변환, 이미지 크기 줄이기.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  // 편집기가 따옴표·문장부호를 이름으로 저장하는 경우 (&rdquo; 등)
  ldquo: '\u201C', rdquo: '\u201D', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201A', bdquo: '\u201E',
  middot: '\u00B7', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014', bull: '\u2022',
  laquo: '\u00AB', raquo: '\u00BB', lsaquo: '\u2039', rsaquo: '\u203A', prime: '\u2032', Prime: '\u2033',
  times: '\u00D7', divide: '\u00F7', plusmn: '\u00B1', deg: '\u00B0', micro: '\u00B5', para: '\u00B6', sect: '\u00A7',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  le: '\u2264', ge: '\u2265', ne: '\u2260', infin: '\u221E', sim: '\u223C', minus: '\u2212',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE', sup1: '\u00B9', sup2: '\u00B2', sup3: '\u00B3',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D', shy: '\u00AD', iexcl: '\u00A1', iquest: '\u00BF',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * 화면에 보여 줄 때만: 글 속에 남은 문자 코드(&#39; &amp;#39; &quot; 등)를 사람이 읽는 글자로.
 * 편집기에 넣는 글은 바꾸지 않는다.
 */
export function displayText(s) {
  let t = String(s ?? '');
  for (let i = 0; i < 3 && /&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/i.test(t); i++) t = decodeEntities(t);
  return t;
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
  const size = { width: bmp.width, height: bmp.height };
  bmp.close?.();
  return size;
}

/** 긴 변이 maxSide보다 크면 줄인다. {dataUrl, width, height} */
export async function downscaleImage(dataUrl, maxSide = 2000) {
  const blob = await (await fetch(dataUrl)).blob();
  const okType = /^image\/(jpeg|png|webp|gif)$/.test(blob.type);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && okType && blob.size < 4.5 * 1024 * 1024) {
    const same = { dataUrl: dataUrl.replace(/^data:[^;]+/, `data:${blob.type}`), width: bmp.width, height: bmp.height };
    bmp.close?.();
    return same;
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.(); // 풀어 둔 원본 이미지를 바로 메모리에서 내림
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(out);
  });
  return { dataUrl: url, width: w, height: h };
}
