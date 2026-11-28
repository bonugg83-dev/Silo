// Claude Messages API 호출 (브라우저에서 직접 호출).
// 압축 해제 확장 프로그램은 빌드 단계가 없어 SDK 대신 fetch로 REST API를 호출한다.
import { SYSTEM_PROMPT, RESULT_SCHEMA } from './prompt.js';
import { callGemini, isGemini } from './gemini.js';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · 권장', inPrice: 4, outPrice: 20, cacheRead: 0.2 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · 저렴', inPrice: 2, outPrice: 10, cacheRead: 0.1 },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 · 가장 정확', inPrice: 8, outPrice: 40, cacheRead: 0.2 },
  // 구글 Gemini: 설정에서 Gemini 키를 따로 넣어야 씀 (lib/gemini.js)
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · 구글', inPrice: 2, outPrice: 12, cacheRead: 0.2, provider: 'gemini' },
];

export class ClaudeError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = !!retryable;
  }
}

/** 기다리기 (signal이 취소되면 바로 끝냄) */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new ClaudeError('이미지 형식을 읽을 수 없어요.');
  return { media_type: m[1], data: m[2] };
}

/**
 * 페이지 이미지 + 지시문으로 구조화된 결과를 받는다.
 * prior({user, assistant})를 주면 앞 대화에 이어서 묻는다 (앞 대화는 캐시로 싸게 다시 읽힘).
 * cacheUser면 이번 질문까지를 캐시해 다음 이어 묻기에 쓰게 한다.
 * 돌려주는 turn({user, assistant})을 다음 호출의 prior로 넘긴다.
 */
export async function callClaude(params) {
  if (isGemini(params.model)) {
    return callGemini({ schema: RESULT_SCHEMA, system: SYSTEM_PROMPT, ...params }, ClaudeError);
  }
  const { apiKey, model, effort, imageDataUrl, userText, signal, useFallbacks = true,
    schema = RESULT_SCHEMA, system = SYSTEM_PROMPT, bookBlock = '', prior = null, cacheUser = false } = params;
  const images = params.images || (imageDataUrl ? [imageDataUrl] : []);
  if (!apiKey) throw new ClaudeError('설정에서 Claude API 키를 넣어 주세요.');
  const body = {
    model,
    max_tokens: 20000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
    system: [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      // 책마다 같은 부분도 따로 캐시 (같은 책 다음 쪽부터 싸게)
      ...(bookBlock ? [{ type: 'text', text: bookBlock, cache_control: { type: 'ephemeral' } }] : []),
    ],
    messages: [],
  };
  const userContent = [
    ...images.map((u) => {
      const img = parseDataUrl(u);
      return { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } };
    }),
    { type: 'text', text: userText, ...(cacheUser ? { cache_control: { type: 'ephemeral' } } : {}) },
  ];
  if (prior) {
    body.messages.push({ role: 'user', content: prior.user }, { role: 'assistant', content: prior.assistant });
  }
  body.messages.push({ role: 'user', content: userContent });
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (useFallbacks) {
    // 안전 분류기가 드물게 거절하면 서버가 다른 모델로 이어서 처리한다
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let res;
  const payload = JSON.stringify(body);
  const TRIES = 4;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers, body: payload, signal,
      });
    } catch (e) {
      // 연결 자체가 잠깐 끊긴 것(Failed to fetch 등)도 기다렸다가 다시 시도
      if (e?.name === 'AbortError' || attempt === TRIES - 1) {
        if (e?.name === 'AbortError') throw e;
        throw new ClaudeError(`Claude에 연결하지 못했어요: ${e?.message || e}`, { retryable: true });
      }
      await sleep(2000 * 2 ** attempt, signal);
      continue;
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      if (res.headers.get('x-should-retry') === 'false' || attempt === TRIES - 1) break;
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      await sleep(Math.min(wait, 30000), signal);
      continue;
    }
    break;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && useFallbacks && /fallback/i.test(msg)) {
      return callClaude({ ...params, useFallbacks: false });
    }
    if (res.status === 401) throw new ClaudeError('API 키가 올바르지 않아요. 설정을 확인해 주세요.', { status: 401 });
    if (res.status === 402 || /credit|billing/i.test(msg)) throw new ClaudeError('API 크레딧이 부족해요: ' + msg, { status: res.status });
    throw new ClaudeError(`Claude 오류(${res.status}): ${msg}`, { status: res.status, retryable: res.status >= 500 || res.status === 429 });
  }
  if (json.stop_reason === 'refusal') {
    throw new ClaudeError('Claude가 이 쪽 처리를 거절했어요. 이 쪽은 직접 교정해 주세요.');
  }
  if (json.stop_reason === 'max_tokens') {
    throw new ClaudeError('응답이 너무 길어 잘렸어요. 다시 시도해 주세요.', { retryable: true });
  }
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new ClaudeError('응답 형식을 읽지 못했어요. 다시 시도해 주세요.', { retryable: true });
  }
  return { result, usage: json.usage || {}, model: json.model || model, turn: { user: userContent, assistant: json.content || [] } };
}

/** usage로 대략적인 비용(달러)을 계산한다. */
export function estimateCostUsd(modelId, usage) {
  const m = MODELS.find((x) => x.id === modelId) || MODELS[0];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25;
  return (inTok * m.inPrice + (usage.cache_read_input_tokens || 0) * (m.cacheRead ?? m.inPrice * 0.1)
    + (usage.output_tokens || 0) * m.outPrice) / 1e6;
}
