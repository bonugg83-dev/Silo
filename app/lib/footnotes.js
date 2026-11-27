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
  const leftover = [];
  for (const o of orphans || []) {
    let found = false;
    for (let p = page - 1; p >= page - 2; p--) {
      const prev = book.pages[p];
      if (!prev || !(prev.footMissing || []).some((l) => norm(l) === norm(o.label))) continue;
      found = true;
      const exists = book.links.some((l) => l.from === p && norm(l.label) === norm(o.label));
      if (exists) break;
      const link = { label: o.label, note: o.note, from: p, to: page, done: false };
      book.links.push(link);
      made.push(link);
      break;
    }
    if (!found) leftover.push(o);
  }
  // 번호가 달라도(모델에 따라 다음 쪽 설명에 [각주*]처럼 새 번호를 붙임): 앞쪽에 짝 없는 번호가 남아 있고
  // 이 쪽 맨 위 설명도 남았으면 앞쪽부터 차례대로 짝지음. 앞쪽에는 앞쪽 번호로 넣고, 이 쪽에서는 이 쪽 번호의 줄을 지움
  const waiting = [];
  for (let p = page - 2; p <= page - 1; p++) {
    for (const l of book.pages[p]?.footMissing || []) {
      if (!book.links.some((x) => x.from === p && norm(x.label) === norm(l))) waiting.push({ p, l });
    }
  }
  for (const o of leftover) {
    const w = waiting.shift();
    if (!w) break;
    const link = { label: w.l, toLabel: o.label, note: o.note, from: w.p, to: page, done: false };
    book.links.push(link);
    made.push(link);
  }
  return made;
}

// 각주 이름 + 번호나 기호만 (예: 각주3, 각주12, 각주*, 각주***, 미주5, 주석#, 주2). "[주의]", "[주요 …]" 같은 글은 아님
const NOTE_NAME = '(?:각주|미주|주석|후주|주)[0-9*＊#†‡§※]*';
/**
 * 결과 글에서 다른 쪽에 걸친 각주를 직접 찾는다 (모델이 footnotes_without_note·notes_without_marker 에 안 적어도).
 *  - 설명 없는 번호 "[각주3]" → 설명이 다음 쪽에 있는 각주
 *  - 글 맨 위에 한 줄로 따로 있는 "[각주3: 설명]" → 앞쪽 번호의 설명
 * 모델이 알려 준 것에 더해서 돌려준다.
 */
export function deriveFootnotes(text, missing = [], orphans = []) {
  const t = String(text ?? '');
  const miss = [...missing];
  for (const m of t.matchAll(new RegExp(`\\[(${NOTE_NAME})\\]`, 'g'))) {
    if (!miss.some((l) => norm(l) === norm(m[1]))) miss.push(m[1]);
  }
  const orph = [...orphans];
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(new RegExp(`^\\s*\\[(${NOTE_NAME})\\s*:\\s*([\\s\\S]*)\\]\\s*$`));
    if (!m) break; // 맨 위 설명 줄들만 (본문이 나오면 멈춤)
    if (!orph.some((o) => norm(o.label) === norm(m[1]))) orph.push({ label: m[1], note: m[2].trim() });
  }
  return { missing: miss, orphans: orph };
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
      if (m && !links.some((l) => l.to === p && norm(l.toLabel || l.label) === norm(m[1]))) {
        it.text = text.replace(m[0], has(p - 1) || has(p - 2)
          ? `앞쪽에서 ${m[1]} 번호를 찾지 못함 (설명은 이 쪽 맨 위에 둠)`
          : `${m[1]} 번호가 배정 범위 밖(앞쪽)에 있어 옮기지 못함 (설명은 이 쪽 맨 위에 둠)`);
        n++;
      }
    }
  }
  return n;
}
