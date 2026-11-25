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
 * @returns {{text: string, applied: object[], failed: {fix: object, why: string}[]}}
 */
export function applyFixes(text, fixes) {
  let out = text;
  const applied = [];
  const failed = [];
  for (const fix of fixes || []) {
    if (!fix || typeof fix.find !== 'string' || fix.find === '' || fix.find === fix.replace) continue;
    const n = countOccurrences(out, fix.find);
    if (n === 1) {
      out = out.replace(fix.find, () => fix.replace);
      applied.push(fix);
    } else {
      failed.push({ fix, why: n === 0 ? '고칠 구절을 찾지 못함' : `같은 구절이 ${n}곳에 있음` });
    }
  }
  return { text: out, applied, failed };
}
