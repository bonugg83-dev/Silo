// 본문 제목의 단계 표시(@@[ @@{ @@( @@H4( @@H5()를 책 목차에 맞춘다.
// 목차에 있는 제목이면 AI가 고른 단계 대신 목차의 단계를 쓴다 (대제목/중제목 혼동 방지).

export const HEADING_MARKERS = ['@@H4(', '@@H5(', '@@[', '@@{', '@@('];
const MARKER_RE = /^(@@H4\(|@@H5\(|@@\[|@@\{|@@\()/;
const LEVEL = { '@@[': 1, '@@{': 2, '@@(': 3, '@@H4(': 4, '@@H5(': 5 };

/** 비교용: 공백·문장부호·점선을 뺀다 */
export function normTitle(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\s·.…‥,:;!?'"“”‘’()[\]{}<>〈〉《》「」『』―\-–—~・*◆◇■□●○◈※]/g, '')
    .toLowerCase();
}

// 맨 앞 번호: 제1부, 제 2 장, 1장, 3., 1-2, Ⅲ, IV, Part 1, Chapter 2, 01 ...
const NUM_PREFIX = /^\s*(제\s*[0-9一二三四五六七八九十百]+\s*[부장절편강과]|[0-9]+\s*[부장절편강과]|part\s*[0-9ivx]+|chapter\s*[0-9ivx]+|[0-9]+(\s*[-.]\s*[0-9]+)*\s*[.)]?|[ⅰ-ⅻⅠ-Ⅻ]+\s*[.)]?|[ivx]+\s*[.)]\s*)\s*/i;
export function coreTitle(s) {
  return normTitle(String(s ?? '').replace(NUM_PREFIX, ''));
}

/** 목차 글 → [{marker, title, level}] (끝의 쪽 번호는 뗀다) */
export function parseToc(tocText) {
  const out = [];
  for (const raw of String(tocText ?? '').split('\n')) {
    const line = raw.trim();
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const title = line.slice(m[1].length).replace(/[\s.·…]*\d{1,4}\s*$/, '').trim();
    if (!title) continue;
    out.push({ marker: m[1], title, level: LEVEL[m[1]], full: normTitle(title), core: coreTitle(title) });
  }
  return out;
}

function findEntry(entries, line) {
  const full = normTitle(line);
  if (!full) return null;
  const exact = entries.filter((e) => e.full === full);
  if (exact.length) return sameMarker(exact);
  const core = coreTitle(line);
  if (core.length < 2) return null;
  const byCore = entries.filter((e) => e.core === core);
  if (byCore.length) return sameMarker(byCore);
  // 본문 제목에 영문 병기·부제가 붙어 길어진 경우: 목차 제목으로 시작하면 같은 제목
  const pre = entries.filter((e) => e.full.length >= 4 && full.startsWith(e.full) && full.length <= e.full.length * 2 + 10);
  return pre.length ? sameMarker(pre) : null;
}
// 같은 제목이 여러 번 나오면 단계가 모두 같을 때만 쓴다
function sameMarker(list) {
  return list.every((e) => e.marker === list[0].marker) ? list[0] : null;
}

/**
 * text의 제목 줄을 목차 단계로 맞춘다.
 * - 단계 표시가 있는 줄: 목차에 있으면 목차 단계로 바꿈
 * - 표시 없는 짧은 줄: 목차 제목과 글자가 완전히 같으면 표시를 붙임
 * @returns {{text: string, changes: {line: string, from: string, to: string}[]}}
 */
export function alignHeadings(text, tocText) {
  const entries = parseToc(tocText);
  const changes = [];
  if (!entries.length) return { text, changes };
  let inVisual = false;
  const lines = String(text ?? '').split('\n').map((line) => {
    if (/^\[(그림|사진|그래프|도표|지도|표|글상자)[^\]]*\]/.test(line) && !/끝\]\s*$/.test(line)) inVisual = true;
    if (/^\[[^\]]*끝\]\s*$/.test(line)) { inVisual = false; return line; }
    if (inVisual) return line;
    const m = MARKER_RE.exec(line);
    if (m) {
      const title = line.slice(m[1].length);
      const e = findEntry(entries, title);
      if (e && e.marker !== m[1]) {
        changes.push({ line: title, from: m[1], to: e.marker });
        return e.marker + title;
      }
      return line;
    }
    const t = line.trim();
    if (!t || t.length > 40 || /^\[/.test(t) || /^@@/.test(t)) return line;
    const full = normTitle(t);
    const exact = full.length >= 2 ? entries.filter((e) => e.full === full) : [];
    const e = exact.length ? sameMarker(exact) : null;
    if (e) {
      changes.push({ line: t, from: '', to: e.marker });
      return e.marker + t;
    }
    return line;
  });
  return { text: lines.join('\n'), changes };
}
