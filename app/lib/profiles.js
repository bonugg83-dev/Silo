// 교정자 프로필: 한 컴퓨터에 여러 사람의 API 키를 두어도 섞이지 않게 한다.
// - 키는 프로필 비밀번호로 암호화해 chrome.storage.local에 둔다 (PBKDF2 → AES-GCM).
// - 풀린 키는 chrome.storage.session에만 둔다 (브라우저를 닫으면 사라짐).
// - 책 진행·비용은 프로필 id를 붙인 키로 따로 저장한다.
// 화면 없는 함수만 두어 node 테스트로 확인할 수 있게 한다.

export const PBKDF2_ITER = 210000;
export const MIN_PASSWORD = 4;
export const LOCK_OPTIONS = [
  { min: 30, label: '30분 뒤' },
  { min: 60, label: '1시간 뒤' },
  { min: 240, label: '4시간 뒤' },
  { min: 0, label: '브라우저를 닫을 때' },
];
export const AVATAR_COLORS = [
  ['#2a3b55', '#cfe2ff'], ['#3a2e12', '#f5c451'], ['#233a2c', '#8fe0a9'], ['#3b1b2f', '#ffb3d9'], ['#2e2440', '#cdb8ff'], ['#3a2420', '#ffb59e'],
];

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** API 키를 비밀번호로 암호화한다. */
export async function encryptKey(apiKey, password, iter = PBKDF2_ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await deriveKey(password, salt, iter);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(apiKey));
  return { salt: b64(salt), iv: b64(iv), data: b64(data), iter };
}

/** 비밀번호가 틀리면 null. */
export async function decryptKey(rec, password) {
  if (!rec?.data) return null;
  try {
    const k = await deriveKey(password, unb64(rec.salt), rec.iter || PBKDF2_ITER);
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, k, unb64(rec.data));
    return dec.decode(data);
  } catch {
    return null;
  }
}

export const isApiKey = (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k || '');
export const maskKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '');

export function checkPassword(pw, pw2) {
  if ((pw || '').length < MIN_PASSWORD) return `비밀번호는 ${MIN_PASSWORD}자 이상으로 정해 주세요.`;
  if (pw2 !== undefined && pw !== pw2) return '비밀번호 두 칸이 서로 달라요.';
  return '';
}

/** 새 프로필 기록 (키는 암호화해서). Claude 키(apiKey)와 Gemini 키(geminiKey) 중 하나만 있어도 됨 */
export async function makeProfile({ name, apiKey = '', geminiKey = '', password, index = 0, iter }) {
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    color: index % AVATAR_COLORS.length,
    ...(apiKey ? { enc: await encryptKey(apiKey, password, iter), mask: maskKey(apiKey) } : {}),
    ...(geminiKey ? { genc: await encryptKey(geminiKey, password, iter), gmask: maskKey(geminiKey) } : {}),
    lockAfterMin: 30,
    monthlyLimit: 0,
    createdAt: Date.now(),
  };
}

// ---------- 저장 키 ----------
export const today = (d = new Date()) => d.toLocaleDateString('sv');
export const thisMonth = (d = new Date()) => today(d).slice(0, 7);
export const bookKey = (pid, bookIdx) => `book:${pid}:${bookIdx}`;
export const costKey = (pid, day = today()) => `cost:${pid}:${day}`;
export const costPagesKey = (pid, day = today()) => `costpages:${pid}:${day}`;
export const costMonthKey = (pid, month = thisMonth()) => `costmonth:${pid}:${month}`;
export const runLockKey = (pid) => `runlock:${pid}`;

/** 프로필이 없던 때(v0.9 이하)의 책·비용 기록을 처음 만든 프로필로 옮길 계획 */
export function legacyMigration(all, pid) {
  const set = {};
  const remove = [];
  const months = {};
  for (const [k, v] of Object.entries(all || {})) {
    let m;
    if ((m = /^book:(\d+)$/.exec(k))) {
      set[bookKey(pid, m[1])] = v;
      remove.push(k);
    } else if ((m = /^cost:(\d{4}-\d{2}-\d{2})$/.exec(k))) {
      set[costKey(pid, m[1])] = v;
      months[m[1].slice(0, 7)] = (months[m[1].slice(0, 7)] || 0) + (Number(v) || 0);
      remove.push(k);
    } else if ((m = /^costpages:(\d{4}-\d{2}-\d{2})$/.exec(k))) {
      set[costPagesKey(pid, m[1])] = v;
      remove.push(k);
    }
  }
  for (const [mo, usd] of Object.entries(months)) set[costMonthKey(pid, mo)] = usd;
  return { set, remove };
}

/** 이 프로필의 기록 키 (프로필을 지울 때) */
export function profileDataKeys(all, pid) {
  const re = new RegExp(`^(book|cost|costpages|costmonth):${pid}:`);
  return Object.keys(all || {}).filter((k) => re.test(k));
}

/** 마지막 사용 뒤 잠글 시간이 지났나 (0 = 브라우저를 닫을 때만) */
export function lockExpired(unlock, profile, now = Date.now()) {
  if (!unlock || !profile) return true;
  const min = Number(profile.lockAfterMin) || 0;
  return min > 0 && now - (unlock.lastUsed || 0) > min * 60000;
}

/** 월 한도: 넘었으면 true (0 = 한도 없음) */
export const overLimit = (profile, monthUsd) => Number(profile?.monthlyLimit) > 0 && monthUsd >= Number(profile.monthlyLimit);

/** 다른 창이 같은 프로필로 교정 중인가 (60초 동안 소식 없으면 끝난 것으로) */
export const runLockedByOther = (lock, me, now = Date.now()) => !!lock && lock.owner !== me && now - (lock.at || 0) < 60000;
