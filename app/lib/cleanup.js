// 책별 작업 기록 정리: 2일 동안 열지 않은 책의 기록은 지운다.
// (봉사하는 책은 대부분 하루면 끝나서 오래 둘 필요가 없다)
export const BOOK_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** 책 기록이 마지막으로 쓰인 때 (열었거나 쪽을 넣은 때 중 가장 늦은 때) */
export function lastUsed(book) {
  let t = Number(book?.lastOpened) || 0;
  for (const p of Object.values(book?.pages || {})) t = Math.max(t, Number(p?.at) || 0);
  return t;
}

/** storage 전체에서 지울 책 기록 키 목록 */
export function staleBookKeys(all, now = Date.now(), maxAge = BOOK_MAX_AGE_MS) {
  return Object.keys(all || {}).filter((k) => k.startsWith('book:') && now - lastUsed(all[k]) > maxAge);
}
