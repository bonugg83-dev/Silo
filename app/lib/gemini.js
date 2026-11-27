// 구글 Gemini API 호출. lib/claude.js 의 callClaude 와 같은 모양으로 받고 같은 모양으로 돌려준다
// (result, usage 는 Claude 이름으로 바꿔서, turn 은 다음 이어 묻기에 그대로 넘김).
// Gemini는 앞부분이 같으면 알아서 캐시해 싸게 읽는다(암묵적 캐시).

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const isGemini = (model) => /^gemini-/.test(model || '');
export const isGeminiKey = (k) => /^AIza[0-9A-Za-z_-]{30,}$/.test(k || '');

function parseDataUrl(dataUrl, ErrorClass) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new ErrorClass('이미지 형식을 읽을 수 없어요.');
  return { mimeType: m[1], data: m[2] };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Gemini 사용량 → Claude 사용량 이름 (비용 계산·기록을 같이 쓰려고). 생각 토큰은 출력 값으로 받음 */
export function usageFromGemini(u = {}) {
  const cached = u.cachedContentTokenCount || 0;
  return {
    input_tokens: Math.max(0, (u.promptTokenCount || 0) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
  };
}

/**
 * @param {object} params  callClaude 와 같음: apiKey, model, effort, images|imageDataUrl, userText, signal, schema, system, bookBlock, prior
 * @param {typeof Error} ErrorClass  ClaudeError (status, retryable 를 받는 오류)
 */
export async function callGemini(params, ErrorClass) {
  const { apiKey, model, effort, imageDataUrl, userText, signal, schema, system, bookBlock = '', prior = null } = params;
  const images = params.images || (imageDataUrl ? [imageDataUrl] : []);
  if (!apiKey) throw new ErrorClass('설정에서 Gemini 키를 넣어 주세요.');
  const userParts = [
    ...images.map((u) => ({ inlineData: parseDataUrl(u, ErrorClass) })),
    { text: userText },
  ];
  const contents = [];
  if (prior) contents.push({ role: 'user', parts: prior.user }, { role: 'model', parts: prior.assistant });
  contents.push({ role: 'user', parts: userParts });
  const body = {
    // 지침 + 책 정보는 늘 앞에 같은 글자로 → 다음 쪽부터 캐시로 싸게
    systemInstruction: { parts: [{ text: bookBlock ? `${system}\n\n${bookBlock}` : system }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      maxOutputTokens: 32000,
      thinkingConfig: { thinkingLevel: ['high', 'xhigh', 'max'].includes(effort) ? 'high' : 'low' },
    },
  };
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

  let res;
  const TRIES = 4;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (attempt === TRIES - 1) throw new ErrorClass(`Gemini에 연결하지 못했어요: ${e?.message || e}`, { retryable: true });
      await sleep(2000 * 2 ** attempt, signal);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < TRIES - 1) {
      await sleep(Math.min(2000 * 2 ** attempt, 30000), signal);
      continue;
    }
    break;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) throw new ErrorClass('Gemini 키가 올바르지 않아요. 설정을 확인해 주세요.', { status: 401 });
    if (res.status === 403) throw new ErrorClass(`Gemini 키로 이 모델을 쓸 수 없어요: ${msg}`, { status: 403 });
    if (res.status === 429 && /quota|billing/i.test(msg)) throw new ErrorClass(`Gemini 사용 한도(결제)를 확인해 주세요: ${msg}`, { status: 429 });
    throw new ErrorClass(`Gemini 오류(${res.status}): ${msg}`, { status: res.status, retryable: res.status >= 500 || res.status === 429 });
  }
  const cand = json.candidates?.[0];
  const reason = cand?.finishReason || json.promptFeedback?.blockReason;
  if (reason === 'MAX_TOKENS') throw new ErrorClass('응답이 너무 길어 잘렸어요. 다시 시도해 주세요.', { retryable: true });
  if (reason === 'RECITATION') throw new ErrorClass('구글이 책 글을 그대로 옮기는 답을 막았어요. 다시 시도하거나 Claude 모델로 교정해 주세요.', { retryable: true });
  if (reason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(reason)) {
    throw new ErrorClass(`Gemini가 이 쪽 처리를 멈췄어요(${reason}). 이 쪽은 Claude 모델로 교정하거나 직접 교정해 주세요.`);
  }
  const parts = cand?.content?.parts || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new ErrorClass('응답 형식을 읽지 못했어요. 다시 시도해 주세요.', { retryable: true });
  }
  // 이어 묻기(2차 검증)에는 모델이 준 부분(생각 서명 포함)을 그대로 돌려줘야 함
  return { result, usage: usageFromGemini(json.usageMetadata), model: json.modelVersion || model, turn: { user: userParts, assistant: parts } };
}
