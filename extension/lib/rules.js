// 마이픽 전자도서 제작 규칙 검사기/교정기 (결정적 규칙만 처리)
// 사이드 패널과 Node 테스트에서 함께 쓰는 순수 함수 모듈.

export const DEFAULT_RULE_OPTIONS = {
  // 줄표(―) 앞뒤 공백: 'attach' = PDF 규칙(붙여 씀), 'keep' = 원본 띄어쓰기 유지
  dashSpacing: 'attach',
  // 숫자 뒤 cm, kg 같은 단위를 유니코드 단위 기호(㎝, ㎏)로 바꿈
  unitSymbols: true,
  // 시/인용문이 있는 쪽인지 (true면 빈 줄 한 줄까지 허용)
  allowBlankLines: false,
};

const HANGUL = '\uAC00-\uD7A3';
const CJK = '\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF';

const FULLWIDTH_PUNCT = {
  '\uFF0C': ',', '\uFF0E': '.', '\uFF01': '!', '\uFF1F': '?',
  '\uFF08': '(', '\uFF09': ')', '\uFF1A': ':', '\uFF1B': ';',
  '\uFF5E': '~', '\u301C': '~', '\u223C': '~',
  '\uFF02': '"', '\uFF07': "'",
};

const ROMAN = {
  'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII',
  'Ⅸ': 'IX', 'Ⅹ': 'X', 'Ⅺ': 'XI', 'Ⅻ': 'XII', 'Ⅼ': 'L', 'Ⅽ': 'C', 'Ⅾ': 'D', 'Ⅿ': 'M',
  'ⅰ': 'i', 'ⅱ': 'ii', 'ⅲ': 'iii', 'ⅳ': 'iv', 'ⅴ': 'v', 'ⅵ': 'vi', 'ⅶ': 'vii', 'ⅷ': 'viii',
  'ⅸ': 'ix', 'ⅹ': 'x', 'ⅺ': 'xi', 'ⅻ': 'xii',
};

const UNITS = [
  ['km2', '\u33A2'], ['km²', '\u33A2'], ['m2', '\u33A1'], ['m²', '\u33A1'], ['m3', '\u33A5'], ['m³', '\u33A5'],
  ['cm2', '\u33A0'], ['cm²', '\u33A0'], ['cm3', '\u33A4'], ['cm³', '\u33A4'],
  ['mm', '\u339C'], ['cm', '\u339D'], ['km', '\u339E'],
  ['mg', '\u338E'], ['kg', '\u338F'], ['ml', '\u3396'], ['mL', '\u3396'], ['dl', '\u3397'], ['dL', '\u3397'], ['kl', '\u3398'],
];

const VALID_MARKERS = ['@@[', '@@{', '@@(', '@@H4(', '@@H5(', '@@i', '@@t', 't@@'];

// 짝 검사는 낫표·산괄호만 (소괄호·대괄호·따옴표는 쪽을 넘어 이어지는 일이 많아 오탐이 잦음)
const PAIRS = [
  ['『', '』', '겹낫표'], ['「', '」', '낫표'], ['〈', '〉', '산괄호'], ['《', '》', '이중산괄호'],
];

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

/**
 * 규칙에 맞게 텍스트를 고치고, 바꾼 내용과 사람이 확인할 경고를 돌려준다.
 * @returns {{text: string, changes: {rule: string, count: number, examples: string[]}[], warnings: {rule: string, message: string}[]}}
 */
export function applyRules(input, opts = {}) {
  const o = { ...DEFAULT_RULE_OPTIONS, ...opts };
  const changes = [];
  const warnings = [];
  let text = String(input ?? '').replace(/\r\n?/g, '\n');

  function step(rule, re, replacer) {
    let count = 0;
    const examples = [];
    text = text.replace(re, (...args) => {
      const match = args[0];
      const out = typeof replacer === 'function' ? replacer(...args) : match.replace(re, replacer);
      if (out !== match) {
        count++;
        if (examples.length < 4) examples.push(`${match} → ${out}`);
      }
      return out;
    });
    if (count) changes.push({ rule, count, examples });
  }

  // 1. 보이지 않는 문자, 탭, 특수 공백 정리
  step('보이지 않는 문자 삭제', /[\u200B-\u200D\uFEFF\u00AD]/g, () => '');
  step('특수 공백을 일반 공백으로', /[\u00A0\u2000-\u200A\u202F\u205F\u3000\t]/g, () => ' ');

  // 2. 전각 문장부호 → 자판 문장부호
  step('전각 문장부호를 자판 부호로', /[\uFF0C\uFF0E\uFF01\uFF1F\uFF08\uFF09\uFF1A\uFF1B\uFF5E\u301C\u223C\uFF02\uFF07]/g,
    (m) => FULLWIDTH_PUNCT[m]);
  step('전각 숫자·영문을 반각으로', /[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g,
    (m) => String.fromCharCode(m.charCodeAt(0) - 0xFEE0));

  // 3. 로마숫자 유니코드 → 자판 영문
  step('로마숫자는 자판 영문자로', /[\u2160-\u217F]/g, (m) => ROMAN[m] ?? m);

  // 4. 줄표: 대시류 및 OCR 오인식 → ―(2015)
  step('대시를 줄표(―, 2015)로', /[\u2014\u2500\u2501\u2E3A\u2E3B]/g, () => '\u2015');
  step('한글 사이 ㅡ(자모)를 줄표로', new RegExp(`(^|[${HANGUL}\\s!?.,])\u3161(?=[${HANGUL}\\s]|$)`, 'gm'),
    (m, pre) => pre + '\u2015');
  step('한자 一 오인식을 줄표로',
    new RegExp(`(^|[^${CJK}\\s])(\\s*)\u4E00(?=\\s*(?:[^${CJK}\\s]|$))`, 'gm'),
    (m, pre, sp) => pre + sp + '\u2015');
  // 숫자 사이 en dash는 자판 하이픈으로 두고 경고
  step('숫자 사이 반각 대시(–)를 하이픈으로', /(\d)\u2013(?=\d)/g, (m, d) => `${d}-`);
  step('대시(–)를 줄표로', /\u2013/g, () => '\u2015');
  if (o.dashSpacing === 'attach') {
    step('줄표 앞뒤 붙여 쓰기', /[ ]*\u2015[ ]*/g, () => '\u2015');
  }

  // 5. 가운뎃점 → 00B7, 앞뒤 붙임
  step('가운뎃점(·, 00B7)으로 통일', /[\u30FB\uFF65\u2027\u2219\u22C5]/g, () => '\u00B7');
  step('가운뎃점 앞뒤 붙여 쓰기', /[ ]*\u00B7[ ]*/g, () => '\u00B7');

  // 6. 말줄임표 모양(⋯ 등) → 2026
  step('말줄임표를 유니코드(…, 2026)로', /\u22EF/g, () => '\u2026');

  // 7. 곱하기/나누기
  step('숫자 사이 곱하기를 ×(00D7)로', /(\d)\s?[xX\*]\s?(?=\d)/g, (m, d) => {
    // 3x4 같은 모양만 (16진수, 해상도 등은 사람이 볼 수 있게 경고 대상)
    return m.includes('*') || /\s/.test(m) ? `${d}\u00D7` : m;
  });

  // 8. 자판 산괄호/부등호 → 유니코드 (사이트가 자판 < > 를 막음)
  step('자판 < > 묶음을 산괄호(〈 〉)로', /<([^<>\n]{1,80}?)>/g, (m, inner) => {
    if (/^\s*[\d.\s+\-−=xyXYa-z]*\s*$/.test(inner) && /[\d=]/.test(inner)) return m; // 수식 모양은 아래에서
    return `\u3008${inner.trim()}\u3009`;
  });
  step('자판 < > 를 부등호(＜ ＞)로', /[<>]/g, (m) => (m === '<' ? '\uFF1C' : '\uFF1E'));

  // 9. 숫자 사이 빼기 → −(2212): 등호가 있는 수식 줄에서만
  text = text.split('\n').map((line) => {
    if (!/[=＜＞]/.test(line) || !/\d\s?-\s?\d|[=(]\s?-\d/.test(line)) return line;
    const before = line;
    const after = line.replace(/(\d|\))(\s?)-(\s?)(?=[\d(a-zA-Z])/g, '$1$2\u2212$3').replace(/([=(]\s?)-(?=\d)/g, '$1\u2212');
    if (after !== before) changes.push({ rule: '수식의 빼기를 −(2212)로', count: 1, examples: [`${before} → ${after}`] });
    return after;
  }).join('\n');

  // 10. 단위 기호
  if (o.unitSymbols) {
    for (const [ascii, sym] of UNITS) {
      const esc = ascii.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      step(`단위 ${ascii} → ${sym}`, new RegExp(`(\\d)(\\s?)${esc}(?![A-Za-z²³0-9])`, 'g'), (m, d, sp) => `${d}${sp}${sym}`);
    }
  }

  // 11. 따옴표: 자판 " ' → 한글 따옴표 (아포스트로피는 유지)
  text = text.split('\n').map((line) => {
    let out = '';
    let openSingle = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const prev = i > 0 ? line[i - 1] : '';
      const next = i < line.length - 1 ? line[i + 1] : '';
      if (c === '"') {
        const opening = !prev || /[\s(\[{〈《「『‘“―\/]/.test(prev);
        out += opening ? '\u201C' : '\u201D';
        continue;
      }
      if (c === "'") {
        // 아포스트로피: I'm, don't / '88 / students' (열린 작은따옴표가 없을 때)
        const letterBefore = /[A-Za-z]/.test(prev);
        const letterAfter = /[A-Za-z]/.test(next);
        if (letterBefore && letterAfter) { out += "'"; continue; }
        if ((!prev || /\s/.test(prev)) && /\d/.test(next) && /\d/.test(line[i + 2] || '') && !/\d/.test(line[i + 3] || '')) { out += "'"; continue; }
        const opening = !prev || /[\s(\[{〈《「『“―\/]/.test(prev);
        if (opening) { openSingle++; out += '\u2018'; continue; }
        if (letterBefore && openSingle === 0) { out += "'"; continue; }
        if (openSingle > 0) openSingle--;
        out += '\u2019';
        continue;
      }
      if (c === '\u2018') openSingle++;
      if (c === '\u2019' && openSingle > 0) openSingle--;
      out += c;
    }
    return out;
  }).join('\n');
  {
    const n = countMatches(String(input ?? ''), /["']/g);
    const left = countMatches(text, /["']/g);
    if (n !== left) changes.push({ rule: '자판 따옴표를 한글 따옴표로', count: n - left, examples: [] });
  }
  // 한글 앞뒤의 영문 아포스트로피는 닫는 따옴표일 가능성이 큼 → 경고만
  if (new RegExp(`[${HANGUL}]'|'[${HANGUL}]`).test(text)) {
    warnings.push({ rule: '따옴표', message: "한글 옆에 자판 작은따옴표(')가 남아 있어요. 한글 따옴표(‘ ’)인지 확인하세요." });
  }

  // 12. 묶음 기호 안쪽 공백 삭제, 여는 기호 앞 한 칸
  step('묶음 기호 안쪽 공백 삭제', /([『「〈《])[ ]+|[ ]+([』」〉》])/g, (m, open, close) => open || close);
  step('여는 묶음 기호 앞 한 칸 띄우기', new RegExp(`([${HANGUL}A-Za-z0-9.,!?])([『「〈《])`, 'g'), (m, a, b) => `${a} ${b}`);

  // 13. 쌍점/쌍반점: 앞은 붙이고 뒤는 한 칸
  step('쌍점·쌍반점 앞 공백 삭제', /([^\s:;])[ ]+([:;])(?=\s|$|[^\d:/])/g, (m, a, p) => `${a}${p}`);
  step('쌍점·쌍반점 뒤 한 칸 띄우기', /([^\s\d:;\/]|[^\s:;\/](?=[;]))([:;])(?=[^\s\d\/:;)\]」』〉》”’])/g, (m, a, p) => `${a}${p} `);

  // 13-1. 주석 표시: "[각주 3 ]" → "[각주3]", "[각주3 : 설명" → "[각주3: 설명"
  step('주석 표시 붙여 쓰기', /\[[ ]*(각주|미주|주석|후주|주)[ ]+(\d+|\*+)[ ]*(?=[\]:])/g, (m, k, n) => `[${k}${n}`);
  step('주석 표시 쌍점 정리', /\[(각주|미주|주석|후주|주)(\d+|\*+)[ ]*:[ ]*/g, (m, k, n) => `[${k}${n}: `);
  // 13-2. 기호 각주(†, ‡, ※ 등)는 종류와 상관없이 * (안내서 50쪽). 나온 순서대로 *, **, ***
  {
    const SYM = '†‡§¶※#⁎∗✱✲＊⸸⸹';
    const symRe = new RegExp(`\\[[ ]*각주[ ]*([${SYM}]+|\\*+)[ ]*(?=[\\]:])`, 'g');
    const used = new Set([...text.matchAll(symRe)].map((m) => m[1]).filter((s) => /^\*+$/.test(s)).map((s) => s.length));
    const map = new Map();
    const starsFor = (s) => {
      if (/^\*+$/.test(s)) return s;
      if (!map.has(s)) { let n = 1; while (used.has(n)) n++; used.add(n); map.set(s, '*'.repeat(n)); }
      return map.get(s);
    };
    step('기호 각주를 *로', symRe, (m, s) => `[각주${starsFor(s)}`);
  }

  // 14. 장면 전환 기호 → ***
  step('장면 전환 기호를 ***로',
    /^[ ]*(?:[*＊✱✲✳❋❊✻✼✽✾✿❀◆◇■□●○◎※☆★♦♢◈∗·•\-―~＊]\s*){1,7}[ ]*$/gm,
    (m) => (/^[ ]*\*\*\*[ ]*$/.test(m) ? '***' : (/^\s*-{2,}\s*$/.test(m) ? m : '***')));

  // 15. 공백 정리: 줄 앞(들여쓰기)/줄 끝 공백, 연속 공백
  step('들여쓰기 삭제', /^[ ]+/gm, () => '');
  step('줄 끝 공백 삭제', /[ ]+$/gm, () => '');
  step('연속 공백을 한 칸으로', /([^ ])[ ]{2,}/g, (m, a) => `${a} `);

  // 16. 빈 줄
  step('처음과 끝의 빈 줄 삭제', /^\n+|\n+$/g, () => '');
  if (o.allowBlankLines) {
    step('연속된 빈 줄을 한 줄로', /\n{3,}/g, () => '\n\n');
  } else {
    step('빈 줄 삭제(시·인용문 없는 쪽)', /\n{2,}/g, () => '\n');
  }

  // ---- 경고(자동으로 고치지 않음) ----
  for (const [open, close, name] of PAIRS) {
    const a = text.split(open).length - 1;
    const b = text.split(close).length - 1;
    if (a !== b) {
      warnings.push({ rule: '괄호 짝', message: `${name} ${open}${close} 짝이 안 맞아요 (여는 것 ${a}개, 닫는 것 ${b}개). 쪽을 넘어 이어지는 경우가 아니면 확인하세요.` });
    }
  }
  // 서로 다른 기호로 닫힌 경우: 『...」, 「...』, 〈...》 등 (안쪽에 다른 여는 기호가 없을 때)
  const CLOSERS = { '『': '』', '「': '」', '〈': '〉', '《': '》' };
  const mixRe = /([『「〈《])([^『』「」〈〉《》\n]{0,80}?)([』」〉》])/g;
  for (const m of text.matchAll(mixRe)) {
    if (CLOSERS[m[1]] !== m[3]) {
      warnings.push({ rule: '괄호 짝', quote: m[0].slice(0, 40), message: `여는 기호(${m[1]})와 닫는 기호(${m[3]})가 달라요: “${m[0].slice(0, 40)}”. 원본에서 어느 쪽이 맞는지 확인하세요.` });
    }
  }

  if (new RegExp(`[${HANGUL}] - [${HANGUL}]`).test(text)) {
    warnings.push({ rule: '줄표/붙임표', message: '한글 사이에 띄어 쓴 하이픈( - )이 있어요. 줄표(―)인지 확인하세요.' });
  }
  if (/\d\s?-\s?\d/.test(text) && !/[=＜＞]/.test(text)) {
    // 연도 범위, 전화번호 등은 그대로 두지만 수식이면 −(2212)
    if (/\d\s-\s\d/.test(text)) warnings.push({ rule: '빼기', message: '숫자 사이에 띄어 쓴 하이픈이 있어요. 빼기 기호라면 −(2212)를 쓰세요.' });
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const markers = line.match(/@@H?[0-9]?[\[{(]|@@[it]|t@@/g) || [];
    for (const m of markers) {
      if (!VALID_MARKERS.includes(m)) warnings.push({ rule: '목차 스타일', message: `${i + 1}번째 줄에 알 수 없는 표시 “${m}”가 있어요.` });
    }
    if (/^@@(\[|\{|\(|H4\(|H5\()/.test(line) && /^@@(\[|\{|\(|H4\(|H5\()\s/.test(line)) {
      warnings.push({ rule: '목차 스타일', message: `${i + 1}번째 줄: 목차 표시 뒤에 공백이 있어요.` });
    }
    if (/^\d{1,4}$/.test(line.trim()) && lines.length > 1) {
      warnings.push({ rule: '쪽 번호', message: `${i + 1}번째 줄 “${line.trim()}”: 숫자만 있는 줄이에요. 인쇄된 쪽 번호라면 지우세요(시의 절 번호라면 그대로).` });
    }
  });
  for (const kind of ['그림', '사진', '지도', '그래프', '글상자', '표', '가계도']) {
    const open = countMatches(text, new RegExp(`\\[${kind}(?:[ \\d\\-.]*\\]|\\s[^\\]끝]*\\])`, 'g'));
    const close = countMatches(text, new RegExp(`\\[${kind} 끝\\]`, 'g'));
    if (open !== close) warnings.push({ rule: '시각자료', message: `[${kind}]와 [${kind} 끝]의 개수가 달라요(${open}/${close}). 다른 쪽으로 이어지는 경우가 아니면 확인하세요.` });
  }
  if (countMatches(text, /@@t/g) !== countMatches(text, /t@@/g)) {
    warnings.push({ rule: '표', message: '@@t 와 t@@ 의 개수가 달라요. 표는 쪽마다 @@t/t@@를 넣어야 해요.' });
  }
  if (/[\uFF0D]/.test(text)) warnings.push({ rule: '부호', message: '전각 하이픈(－)이 있어요. 빼기(−, 2212)나 자판 하이픈(-)으로 바꾸세요.' });
  if (/[ㄱ-ㅎㅏ-ㅣ]{1}[가-힣]|[가-힣][ㄱ-ㅎㅏ-ㅣ]/.test(text.replace(/\u3161/g, ''))) {
    warnings.push({ rule: 'OCR', message: '낱자(ㄱ, ㅏ 등)가 글자에 붙어 있어요. OCR 오류인지 확인하세요.' });
  }

  return { text, changes, warnings };
}

/** 쪽 끝/처음 줄바꿈 문제처럼 단어 사이가 끊긴 OCR 줄들을 문단으로 합치는 일은 AI가 하고, 여기서는 하지 않는다. */
export function textToEditorHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.split('\n').map((line) => (line === '' ? '<p>&nbsp;</p>' : `<p>${esc(line)}</p>`)).join('\n');
}
