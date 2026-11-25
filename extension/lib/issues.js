// 검수 표시 문장 정리와 검수 목록 정렬.

// "확인이 필요합니다", "확인하세요" 같은 군더더기 꼬리를 뗀다
const TAIL = /\s*[,.]?\s*((이|그|이 부분|해당 부분|원본|원본에서)\s*)?(을|를)?\s*(확인|검토|점검)(이|가)?\s*(필요(합니다|해요|함|합니다\.)?|바랍니다|요망|해\s*주세요|하세요|해야\s*합니다|해야\s*함|할\s*것|필요)\s*[.!]?\s*$/;
const LEAD = /^(확인\s*필요|검토\s*필요)\s*[:：]\s*/;
export function tidyMessage(s) {
  let t = String(s ?? '').trim().replace(LEAD, '');
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(TAIL, '').trim();
    if (t === before) break;
    // "…경우가 아니면 확인하세요" 처럼 조건만 남은 꼬리도 뗀다
    t = t.replace(/\s*[.,]?\s*[^.。]*(경우가\s*아니면|아니라면|라면|이면)\s*$/, (m) => (m.length < 40 ? '' : m)).trim();
  }
  // "…인지/…는지"만 남은 마지막 문장은 앞 문장이 있으면 뺀다
  if (/(인지|는지|은지|ㄴ지|을지|할지)$/.test(t)) {
    const cut = t.search(/[.!?。]\s+[^.!?。]*$/);
    t = cut > 0 ? t.slice(0, cut) : `${t} 의심`;
  }
  t = t.replace(/[,\s]+$/, '');
  return t || String(s ?? '').trim();
}

/** 쪽의 색: 1 빨강, 2 노랑, 3 없음(또는 확인함) */
export function pageTier(rec) {
  if (rec.reviewed) return 3;
  const issues = rec.issues || [];
  if (issues.some((x) => x.cls === 'review')) return 1;
  if (issues.length) return 2;
  return 3;
}

/**
 * 검수 목록. 빨강 → 노랑 → 없음(오름차순), 내림차순은 그 반대. 같은 색은 쪽 순서.
 * showAll이 아니면 3순위(확인함·문제 없음)는 뺀다.
 */
export function sortReview(pages, { desc = false, showAll = false } = {}) {
  return Object.keys(pages || {}).map(Number).filter((n) => Number.isFinite(n))
    .map((n) => ({ n, rec: pages[n], tier: pageTier(pages[n]) }))
    .filter((x) => showAll || x.tier < 3)
    .sort((a, b) => (desc ? b.tier - a.tier : a.tier - b.tier) || a.n - b.n);
}
