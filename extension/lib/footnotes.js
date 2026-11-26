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

/**
 * 자동 모드가 끝난 뒤 짝을 못 찾은 각주 표시 문장을 사실대로 바꾼다.
 * 다음(앞) 쪽을 처리하지 않았으면 "배정 범위 밖", 처리했는데 짝이 없으면 "짝을 찾지 못함".
 * @returns {number} 바꾼 표시 수
 */
export function markUnlinked(book) {
  const links = book.links || [];
  const has = (p) => !!book.pages?.[p];
  let n = 0;
  for (const [key, rec] of Object.entries(book.pages || {})) {
    const p = Number(key);
    if (!Number.isFinite(p) || !rec?.issues) continue;
    for (const it of rec.issues) {
      const text = String(it.text || '');
      let m = text.match(/(\S+) 설명이 다음 쪽에 있음 \(자동 모드 끝에 이어 붙임\)/);
      if (m && !links.some((l) => l.from === p && norm(l.label) === norm(m[1]))) {
        it.text = text.replace(m[0], has(p + 1) || has(p + 2)
          ? `${m[1]} 설명을 다음 쪽에서 찾지 못함`
          : `${m[1]} 설명이 배정 범위 밖(다음 쪽)에 있어 잇지 못함`);
        n++;
        continue;
      }
      m = text.match(/앞쪽 (\S+)의 설명 \(자동 모드 끝에 앞쪽으로 옮김\)/);
      if (m && !links.some((l) => l.to === p && norm(l.label) === norm(m[1]))) {
        it.text = text.replace(m[0], has(p - 1) || has(p - 2)
          ? `앞쪽에서 ${m[1]} 번호를 찾지 못함 (설명은 이 쪽 맨 위에 둠)`
          : `${m[1]} 번호가 배정 범위 밖(앞쪽)에 있어 옮기지 못함 (설명은 이 쪽 맨 위에 둠)`);
        n++;
      }
    }
  }
  return n;
}
