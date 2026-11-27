// 누락 경보: OCR에는 있는데 결과에서 빠진 구절을 찾는다 (AI 호출 없음).
import { diffWords } from './diff.js';

const squash = (s) => String(s ?? '').replace(/\s+/g, '');
// 비교에서 빼는 것: 단계 표시, 시각자료·각주 틀, 문장부호
const bare = (s) => squash(s)
  .replace(/@@(H4\(|H5\(|\[|\{|\(|i|t)|t@@/g, '')
  .replace(/\[(각주|미주|주석|주)[^:\]]*:?|\]/g, '')
  .replace(/[.,·…‥:;!?'"“”‘’()[\]{}〈〉《》「」『』―\-–—~*]/g, '');

/**
 * @param {string} ocr 사이트 OCR 텍스트
 * @param {string} result 교정 결과
 * @returns {string[]} 빠졌을 수 있는 구절
 */
export function findOmissions(ocr, result, { minChars = 10 } = {}) {
  const ocrLines = String(ocr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  // 머리말·꼬리말 후보: 첫 줄·마지막 줄이 짧으면 지워도 되는 줄.
  // 마침표로 끝나는 줄(쪽 아래 각주·출처·작은 글씨 문장)은 머리말이 아니므로 뺀다.
  const isEdge = (l) => l && squash(l).length <= 40 && !/[.。]["”’)]?$/.test(l);
  const edge = new Set([ocrLines[0], ocrLines[ocrLines.length - 1]].filter(isEdge).map(bare));
  const resBare = bare(result);
  // 각주 번호(위 첨자)가 OCR에서 글자에 붙어 나오므로 숫자를 뺀 비교도 한다
  const noNum = (x) => x.replace(/\d+/g, '');
  const resNoNum = noNum(resBare);
  // 본문 안에 끼워 넣은 각주 설명을 뺀 글 (번호 자리에 설명이 들어가 앞뒤 문장이 갈라진 경우)
  const resNoNote = noNum(bare(String(result ?? '').replace(/\[(각주|미주|주석|후주|주)[^\]]*\]/g, '')));
  const kept = (b) => {
    for (const [hay, x] of [[resBare, b], [resNoNum, noNum(b)], [resNoNote, noNum(b)]]) {
      if (hay.includes(x)) return true; // 다른 자리로 옮긴 것(각주 설명 등)
      // 반 이상이 결과에 그대로 있으면 줄바꿈·부호 차이로 본다
      const half = Math.ceil(x.length / 2);
      if (hay.includes(x.slice(0, half)) && hay.includes(x.slice(-half))) return true;
    }
    return false;
  };
  const parts = diffWords(ocr, result);
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.type !== 'del') continue;
    const next = parts[k + 1];
    // 바뀐 곳(del 뒤 add)은 고친 것으로 본다. 단, 바뀐 글이 훨씬 짧으면 일부가 빠진 것
    if (next?.type === 'add' && bare(next.text).length >= bare(p.text).length * 0.6) { k++; continue; }
    for (const chunk of p.text.split('\n')) {
      const b = bare(chunk);
      if (b.length < minChars) continue;
      if (/^\d+$/.test(b)) continue; // 쪽 번호
      if ([...edge].some((e) => e && (e.includes(b) || b.includes(e)))) continue;
      if (kept(b)) continue;
      out.push(chunk.trim());
    }
  }
  return out;
}

/** 결과 글자 수가 OCR보다 크게 적은지 (머리말·쪽 번호를 감안해 75% 미만) */
export function tooShort(ocr, result) {
  const a = bare(ocr).length;
  const b = bare(result).length;
  return a >= 200 && b < a * 0.75;
}

/** 빈 면·장 표지로 처리했는데 OCR 글자가 많은지 */
export function suspiciousSpecial(ocr, pageKind) {
  if (!['blank', 'chapter_cover', 'visual_only'].includes(pageKind)) return false;
  return (bare(ocr).match(/[가-힣]/g) || []).length >= 120;
}

/** 앞쪽 끝 글이 이 쪽 처음에 또 나오는지 (쪽 경계에서 같은 문장을 두 번 씀) */
export function repeatsPrevEnd(prevText, text) {
  const end = bare(prevText).slice(-20);
  if (end.length < 15) return false;
  return bare(text).slice(0, 120).includes(end);
}
