// OCR 텍스트와 작성 결과를 단어(어절) 단위로 비교한다.

function tokenize(text) {
  // 공백은 비교에서 빼고, 줄바꿈은 하나의 토큰으로 남긴다
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/([ ]+|\n)/).filter((t) => t && !/^[ ]+$/.test(t));
}

/** @returns {{type: 'same'|'del'|'add', text: string}[]} */
export function diffWords(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length;
  const m = B.length;
  // LCS 표 (쪽 하나는 많아야 수백 어절이라 O(n*m)로 충분)
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += (text === '\n' || last.text.endsWith('\n') ? '' : ' ') + text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', A[i]); i++; }
    else { push('add', B[j]); j++; }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}

/** 서로 다른 곳만 뽑아 "OCR → 결과" 목록으로 만든다 (AI 재확인용). */
export function disagreements(ocr, result, limit = 80) {
  const parts = diffWords(ocr, result);
  const list = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.type === 'same') continue;
    if (p.type === 'del' && parts[k + 1]?.type === 'add') {
      list.push({ ocr: p.text, result: parts[k + 1].text });
      k++;
    } else if (p.type === 'del') list.push({ ocr: p.text, result: '' });
    else list.push({ ocr: '', result: p.text });
  }
  // 줄바꿈만 다른 경우(줄 합치기)는 확인할 필요가 없다
  return list.filter((d) => d.ocr.replace(/\s/g, '') !== d.result.replace(/\s/g, '')).slice(0, limit);
}
