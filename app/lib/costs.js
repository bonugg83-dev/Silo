// 상세 설정의 옵션마다 한 쪽에 더 드는 비용 (설정창에 보여 주기용)
// 처음에는 추정값(아래 토큰 수 × 모델 값), 교정한 쪽 기록(usageLog)이 쌓이면 실제 평균으로 바꾼다.
import { MODELS } from './claude.js';

// 한 쪽(1188×2000 스캔, 본문 약 800자, 꼼꼼함 높음) 기준 대략적인 토큰 수
//   in: 캐시 안 된 입력, cr: 캐시에서 다시 읽는 입력(지시문·책 정보·앞 질문), out: 출력(생각 포함)
export const TOKENS = {
  first: { in: 4800, cr: 9500, out: 4000 },   // 1차 교정: 쪽 이미지 약 3,200 + OCR·앞쪽 정보
  verify: { in: 5600, cr: 14300, out: 2500 }, // 2차 검증: 1차 답 + 다른 곳 목록, 1차 질문은 캐시
  full: { out: 2000 },                         // 원본 전체 다시 보기: 한 줄씩 대조하느라 더 생각함
  zoom: { in: 3500, out: 1000 },               // 확대본 두 장 (위·아래 반쪽)
};
const ZOOM_SHARE = 0.4; // 확대가 필요한 쪽의 비율 (각주·작은 글씨·불확실한 글자가 있는 쪽), 기록이 없을 때
const MIN_SAMPLES = 3;

export function priceOf(modelId, t) {
  const m = MODELS.find((x) => x.id === modelId) || MODELS[0];
  return ((t.in || 0) * m.inPrice + (t.cr || 0) * (m.cacheRead ?? m.inPrice * 0.1) + (t.out || 0) * m.outPrice) / 1e6;
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * @param {string} modelId
 * @param {{verify?: boolean, verifyFull?: boolean, zoom?: boolean}} opts 지금 설정
 * @param {Array<{model, usd, calls, zoom, verifyFull}>} log 쪽마다 남긴 기록
 * @returns {{first, verify, full, zoom, zoomShare, total, measured: {first, verify, full, zoom}, samples}}
 */
export function optionCosts(modelId, opts = {}, log = []) {
  const est = {
    first: priceOf(modelId, TOKENS.first),
    verify: priceOf(modelId, TOKENS.verify),
    full: priceOf(modelId, TOKENS.full),
    zoom: priceOf(modelId, TOKENS.zoom),
  };
  const mine = (log || []).filter((e) => e && e.model === modelId && Number.isFinite(e.usd) && e.usd > 0);
  const pick = (f) => mine.filter(f).map((e) => e.usd);
  const one = pick((e) => e.calls === 1);
  const two = pick((e) => e.calls === 2 && !e.zoom && !e.verifyFull);
  const twoFull = pick((e) => e.calls === 2 && !e.zoom && e.verifyFull);
  const twoZoom = pick((e) => e.calls === 2 && e.zoom && !e.verifyFull);
  const out = { ...est, measured: { first: false, verify: false, full: false, zoom: false }, samples: mine.length };
  if (one.length >= MIN_SAMPLES) { out.first = avg(one); out.measured.first = true; }
  if (two.length >= MIN_SAMPLES) { out.verify = Math.max(0, avg(two) - out.first); out.measured.verify = true; }
  const base2 = out.first + out.verify;
  if (twoFull.length >= MIN_SAMPLES) { out.full = Math.max(0, avg(twoFull) - base2); out.measured.full = true; }
  if (twoZoom.length >= MIN_SAMPLES) { out.zoom = Math.max(0, avg(twoZoom) - base2); out.measured.zoom = true; }
  // 확대가 실제로 쓰인 쪽의 비율 (확대 켠 기록이 충분하면)
  const withZoomOn = mine.filter((e) => 'zoom' in e);
  out.zoomShare = withZoomOn.length >= 10 ? withZoomOn.filter((e) => e.zoom).length / withZoomOn.length : ZOOM_SHARE;

  // 지금 설정의 쪽당 합계
  let total = out.first;
  if (opts.verify) total += out.verify + (opts.verifyFull ? out.full : 0);
  // 확대가 필요한 쪽은 확인 호출이 꼭 붙는다 (2차 검증을 꺼도)
  if (opts.zoom) total += out.zoomShare * (out.zoom + (opts.verify ? 0 : out.verify));
  out.total = total;
  return out;
}

/** $0.07 → "+$0.07 (약 100원)" */
export function costLabel(usd, { plus = true, wonPerUsd = 1450 } = {}) {
  const won = Math.round((usd * wonPerUsd) / 10) * 10;
  return `${plus ? '+' : ''}$${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)} (약 ${won.toLocaleString('ko-KR')}원)`;
}
