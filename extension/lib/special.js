// 쪽 종류에 따른 결정적 손질과, 사람이 해야 할 일 표시 (안내서·자료실 규칙)

const HEADING_RE = /^(@@H4\(|@@H5\(|@@\[|@@\{|@@\()/;

/**
 * 쪽 종류별로 고친다.
 * - 책 표지(book_cover): 제목에 목차 단계 표시를 붙이지 않는다. ([예시] 표지)
 * - 차례(toc): 맨 위 "차례" 제목만 @@[ , 항목에는 표시 없음, 쪽 번호 앞 장식용 0 삭제. ([예시] 차례)
 * @returns {{text: string, changes: string[]}}
 */
export function fixPageKind(text, pageKind) {
  const changes = [];
  let lines = String(text ?? '').split('\n');
  if (pageKind === 'book_cover') {
    lines = lines.map((l) => {
      const m = HEADING_RE.exec(l);
      if (!m) return l;
      changes.push(`표지 제목의 단계 표시 삭제: ${l}`);
      return l.slice(m[1].length);
    });
  }
  if (pageKind === 'toc') {
    let titled = false;
    lines = lines.map((l, i) => {
      const bare = l.replace(HEADING_RE, '');
      if (!titled && /^\s*(차\s*례|목\s*차|contents|CONTENTS|Contents)\s*$/.test(bare)) {
        titled = true;
        const out = `@@[${bare.trim().replace(/^차\s+례$/, '차례').replace(/^목\s+차$/, '목차')}`;
        if (out !== l) changes.push(`차례 제목에 @@[ 붙임`);
        return out;
      }
      let out = bare;
      if (out !== l) changes.push(`차례 항목의 단계 표시 삭제: ${bare}`);
      const z = out.replace(/(\s)0+(\d+)\s*$/, '$1$2');
      if (z !== out) { changes.push(`쪽 번호 앞 0 삭제: ${out.trim()} → ${z.trim()}`); out = z; }
      return out;
    });
  }
  return { text: lines.join('\n'), changes };
}

/**
 * 표는 봉사자가 편집 화면 표 버튼으로 직접 그린다.
 * 표가 있는 곳마다 빨간 표시(밑줄)를 남길 표시 목록.
 */
export function tableFlags(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  const seen = new Set();
  lines.forEach((l, i) => {
    if (l.trim() !== '@@t') return;
    // @@t 바로 위의 [표 ...] 제목 줄이 있으면 그 줄을, 없으면(앞쪽에서 이어진 표) 다음 줄을 가리킨다
    const title = i > 0 && /^\[표[^\]]*\]/.test(lines[i - 1]) && !/끝\]/.test(lines[i - 1]) ? lines[i - 1] : '';
    let quote = title || (lines[i + 1] && lines[i + 1].trim() !== 't@@' ? lines[i + 1] : '@@t');
    if (seen.has(quote)) quote = '';
    seen.add(quote);
    out.push({ kind: 'visual', needs_review: true, quote, message: '표 그리기 필요 (표 버튼으로 직접)' });
  });
  return out;
}

export const SUBSCRIPT_NOTE = '* 제작자 주: 위 첨자는 “^” 사용하고 아래 첨자는 “_”를 사용함.';

/** 첨자 제작자 주를 이미 쓴 쪽인지 */
export function hasSubscriptNote(text) {
  return /제작자 주:\s*위 첨자는/.test(String(text ?? ''));
}
