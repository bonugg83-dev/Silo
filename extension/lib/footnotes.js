// 다른 쪽에 걸친 각주 잇기: 앞쪽의 "[각주3]"(번호만)과 다음 쪽 맨 위의 "[각주3: 설명]"을 짝지어
// 앞쪽 번호 위치로 설명을 옮긴다.

const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 새로 처리한 쪽의 "번호 없는 설명"을 앞쪽(최대 2쪽 전)의 "설명 없는 번호"와 짝짓는다.
 * @param {{pages: Object<string, {footMissing?: string[]}>, links?: object[]}} book
 * @returns {object[]} 새로 만든 연결
 */
export function findLinks(book, page, orphans) {
  const made = [];
  book.links = book.links || [];
  for (const o of orphans || []) {
    for (let p = page - 1; p >= page - 2; p--) {
      const prev = book.pages[p];
      if (!prev || !(prev.footMissing || []).some((l) => norm(l) === norm(o.label))) continue;
      const exists = book.links.some((l) => l.from === p && norm(l.label) === norm(o.label));
      if (exists) break;
      const link = { label: o.label, note: o.note, from: p, to: page, done: false };
      book.links.push(link);
      made.push(link);
      break;
    }
  }
  return made;
}

/** 앞쪽: "[각주3]"을 "[각주3: 설명]"으로. 정확히 한 곳일 때만. */
export function putNoteAtMarker(text, label, note) {
  const re = new RegExp(`\\[${escRe(label)}\\]`, 'g');
  const n = (text.match(re) || []).length;
  if (n !== 1) return { ok: false, why: n ? `“[${label}]”이 ${n}곳에 있어요` : `“[${label}]”을 찾지 못했어요`, text };
  return { ok: true, text: text.replace(re, () => `[${label}: ${note}]`) };
}

/** 다음 쪽: 맨 위 등에 따로 둔 "[각주3: 설명]" 줄을 지운다. */
export function removeNoteLine(text, label) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^\\s*\\[${escRe(label)}\\s*:`).test(l) && /\]\s*$/.test(l));
  if (idx === -1) return { ok: false, why: `“[${label}: …]” 줄을 찾지 못했어요`, text };
  lines.splice(idx, 1);
  return { ok: true, text: lines.join('\n') };
}
