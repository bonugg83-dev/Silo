// 2차 검증이 돌려준 "고칠 곳"을 초안에 적용한다.
// find가 초안에 정확히 한 번 나올 때만 바꾸고, 아니면 적용하지 않고 돌려준다.

function countOccurrences(text, find) {
  if (!find) return 0;
  let n = 0;
  let i = text.indexOf(find);
  while (i !== -1) {
    n++;
    i = text.indexOf(find, i + find.length);
  }
  return n;
}

/**
 * @param {string} text
 * @param {{find: string, replace: string, reason: string}[]} fixes
 * @param {(s: string) => string} [normalize] 못 찾으면 find·replace를 이것으로 다듬어 한 번 더 찾는다
 *   (예: 규칙 교정기. 2차 검증이 자판 따옴표·띄어쓰기를 다르게 적은 경우)
 * @returns {{text: string, applied: object[], failed: {fix: object, why: string}[]}}
 */
export function applyFixes(text, fixes, normalize = null) {
  let out = text;
  const applied = [];
  const failed = [];
  for (const fix of fixes || []) {
    if (!fix || typeof fix.find !== 'string' || fix.find === '' || fix.find === fix.replace) continue;
    let f = fix;
    let n = countOccurrences(out, f.find);
    if (n !== 1 && normalize) {
      const g = { ...fix, find: normalize(fix.find), replace: normalize(fix.replace) };
      const m = countOccurrences(out, g.find);
      if (m === 1 && g.find !== g.replace) { f = g; n = 1; }
    }
    if (n === 1) {
      out = out.replace(f.find, () => f.replace);
      applied.push(f);
    } else {
      failed.push({ fix, why: n === 0 ? '고칠 구절을 찾지 못함' : `같은 구절이 ${n}곳에 있음` });
    }
  }
  return { text: out, applied, failed };
}
