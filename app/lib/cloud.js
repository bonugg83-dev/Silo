// 온라인 계정 (Firebase, 무료 요금제): 어느 컴퓨터에서나 같은 아이디·비밀번호로 로그인한다.
// - SDK 없이 REST로 부른다 (확장은 원격 코드를 못 싣고, 데스크톱 앱도 같은 코드를 쓴다).
// - 로그인 비밀번호는 그대로 보내지 않고 해시로 바꿔 보낸다. API 키는 원래 비밀번호로 잠가(profiles.js)
//   잠긴 채로만 올린다. 그래서 서버(구글)나 관리자는 키를 풀 수 없다.
// - 가입 코드는 서버 규칙(config/signup)이 확인한다. 코드 값은 앱에 들어 있지 않다.
// - 올리는 것: 계정(아이디, 잠긴 키, 키 앞뒤 일부, 색, 자동 로그아웃, 월 한도), 설정, 비용 합계.
//   책 진행은 컴퓨터마다 따로 (올리지 않음).
// 화면 없는 함수만 두어 node 테스트로 확인할 수 있게 한다. fetch는 바꿔 끼울 수 있다.

export const FIREBASE = {
  apiKey: 'AIzaSyAsWaQ_zM55ZwMA0GlodGXKR_eri3cJsSU',
  projectId: 'silo-42aa5',
};
const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts';
const TOKEN = 'https://securetoken.googleapis.com/v1/token';
const DOCS = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`;

/** 인터넷이 안 될 때 나는 오류 (오프라인 로그인으로 넘어감) */
export class OfflineError extends Error {}
/** 화면에 그대로 보여 줄 오류 */
export class CloudError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = (s) => crypto.subtle.digest('SHA-256', enc.encode(s));

export const normId = (id) => (id || '').trim().toLowerCase();
/** 아이디 → Firebase에 쓰는 내부 이메일 (한글 아이디도 되게 해시로) */
export async function idEmail(id) {
  return `u${hex(await sha256(`silo-id:${normId(id)}`)).slice(0, 40)}@silo-app.com`;
}
/** 로그인용 비밀번호: 원래 비밀번호를 해시로 바꿔 보낸다 (키를 잠근 비밀번호가 서버로 가지 않게) */
export async function authPassword(id, pw) {
  return `s1-${hex(await sha256(`silo-auth:${normId(id)}:${pw}`))}`;
}

const AUTH_MSG = {
  EMAIL_EXISTS: '이미 있는 아이디예요.',
  EMAIL_NOT_FOUND: '없는 아이디예요. 처음이면 회원가입을 눌러 주세요.',
  INVALID_PASSWORD: '아이디나 비밀번호가 맞지 않아요.',
  INVALID_LOGIN_CREDENTIALS: '아이디나 비밀번호가 맞지 않아요.',
  USER_DISABLED: '쓸 수 없게 된 계정이에요.',
  TOO_MANY_ATTEMPTS_TRY_LATER: '너무 여러 번 시도했어요. 잠시 뒤에 다시 해 주세요.',
  TOKEN_EXPIRED: '다시 로그인해 주세요.',
  INVALID_REFRESH_TOKEN: '다시 로그인해 주세요.',
  USER_NOT_FOUND: '계정이 지워졌어요. 다시 가입해 주세요.',
};

// ---------- Firestore 값 바꾸기 ----------
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}
export const toFields = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]));
export function fromValue(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}
export const fromFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromValue(v)]));

/** 계정 문서에 올리는 칸 (책 진행·풀린 키는 절대 넣지 않음) */
export const PROFILE_FIELDS = ['name', 'color', 'enc', 'mask', 'genc', 'gmask', 'lockAfterMin', 'monthlyLimit', 'createdAt']; // genc·gmask: Gemini 키(잠금)
export const pickProfile = (p) => Object.fromEntries(PROFILE_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
/** 설정 중 올리는 것 (예전 평문 키 목록은 절대 올리지 않음) */
export const pickSettings = (s) => { const { keys, apiKey, activeKeyId, ...rest } = s || {}; return rest; };

export function createCloud({ fetch: f = (...a) => globalThis.fetch(...a), now = () => Date.now() } = {}) {
  async function call(url, init) {
    let res;
    try {
      res = await f(url, init);
    } catch (e) {
      throw new OfflineError(e?.message || '인터넷 연결 없음');
    }
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* 빈 몸 */ }
    if (!res.ok) {
      const m = String(body?.error?.message || '');
      // 로그인 쪽은 message에 코드(EMAIL_EXISTS 등), 저장소 쪽은 status에 코드(PERMISSION_DENIED 등)
      const code = /^[A-Z_]+( |$)/.test(m) ? m.split(' ')[0] : String(body?.error?.status || res.status);
      if (res.status >= 500) throw new OfflineError(`서버 오류 ${res.status}`);
      throw new CloudError(AUTH_MSG[code] || (res.status === 403 ? '서버가 거절했어요.' : `서버 오류 (${code})`), code);
    }
    return body;
  }
  const json = (method, body, token) => ({
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const auth = (path, body) => call(`${AUTH}:${path}?key=${FIREBASE.apiKey}`, json('POST', body));
  const toSession = (r) => ({ uid: r.localId, idToken: r.idToken, refreshToken: r.refreshToken, exp: now() + (Number(r.expiresIn) || 3600) * 1000 });

  /** 토큰이 곧 끝나면 새로 받는다. session 객체를 고쳐서 돌려준다. */
  async function fresh(s) {
    if (s.idToken && s.exp - now() > 120000) return s;
    const r = await call(`${TOKEN}?key=${FIREBASE.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
    });
    Object.assign(s, { uid: r.user_id, idToken: r.id_token, refreshToken: r.refresh_token, exp: now() + (Number(r.expires_in) || 3600) * 1000 });
    return s;
  }
  const doc = (s, path = '') => `${DOCS}/users/${s.uid}${path}`;
  async function getDoc(s, path) {
    await fresh(s);
    try {
      return fromFields((await call(doc(s, path), json('GET', undefined, s.idToken))).fields);
    } catch (e) {
      if (e.code === 'NOT_FOUND' || e.code === '404') return null;
      throw e;
    }
  }
  async function patch(s, path, data) {
    await fresh(s);
    const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await call(`${doc(s, path)}?${mask}`, json('PATCH', { fields: toFields(data) }, s.idToken));
  }

  return {
    fresh,
    /** 회원가입: 가입 코드가 틀리면 만든 로그인 계정을 바로 지운다 */
    async signUp({ id, password, code, profile, settings }) {
      const r = await auth('signUp', { email: await idEmail(id), password: await authPassword(id, password), returnSecureToken: true });
      const s = toSession(r);
      try {
        await call(`${DOCS}/users?documentId=${s.uid}`, json('POST', {
          fields: toFields({ ...pickProfile(profile), signupCode: (code || '').trim(), settings: settings ? JSON.stringify(pickSettings(settings)) : '' }),
        }, s.idToken));
      } catch (e) {
        await auth('delete', { idToken: s.idToken }).catch(() => {});
        if (e instanceof CloudError && (e.code === 'PERMISSION_DENIED' || e.code === '403')) throw new CloudError('가입 코드가 맞지 않아요.', 'BAD_CODE');
        throw e;
      }
      return s;
    },
    /** 로그인: 세션과 계정 문서(없으면 null)를 돌려준다 */
    async signIn({ id, password }) {
      const s = toSession(await auth('signInWithPassword', { email: await idEmail(id), password: await authPassword(id, password), returnSecureToken: true }));
      const d = await getDoc(s, '');
      return { session: s, profile: d && pickProfile(d), settings: d?.settings ? safeParse(d.settings) : null };
    },
    async load(s) {
      const d = await getDoc(s, '');
      return d && { profile: pickProfile(d), settings: d.settings ? safeParse(d.settings) : null };
    },
    async saveProfile(s, p) {
      const { genc, gmask, ...base } = pickProfile(p);
      await patch(s, '', base);
      // Gemini 키는 따로 (서버가 이 칸을 받지 않아도 나머지 저장은 되게)
      if (genc !== undefined || gmask !== undefined) {
        await patch(s, '', { genc: genc || '', gmask: gmask || '' }).catch((e) => console.warn('Gemini 키 온라인 저장 실패', e));
      }
    },
    saveSettings: (s, settings) => patch(s, '', { settings: JSON.stringify(pickSettings(settings)) }),
    /** 비밀번호 바꾸기 (로그인 비밀번호와 키 잠금을 같이) */
    async changePassword(s, { id, password, enc, genc }) {
      await fresh(s);
      const r = await auth('update', { idToken: s.idToken, password: await authPassword(id, password), returnSecureToken: true });
      Object.assign(s, toSession({ ...r, localId: s.uid }));
      await patch(s, '', { enc });
      // Gemini 키는 따로 (서버가 이 칸을 받지 않아도 비밀번호 바꾸기는 끝나게)
      if (genc) await patch(s, '', { genc }).catch((e) => console.warn('Gemini 키 온라인 저장 실패', e));
    },
    /** 비용 더하기: 여러 컴퓨터에서 동시에 더해도 안 섞이게 서버에서 더한다 */
    async addCost(s, { usd = 0, pages = 0, day }) {
      await fresh(s);
      const month = day.slice(0, 7);
      const dd = day.slice(8, 10);
      const name = `projects/${FIREBASE.projectId}/databases/(default)/documents/users/${s.uid}/cost/${month}`;
      const inc = (fieldPath, n) => ({ fieldPath, increment: Number.isInteger(n) ? { integerValue: String(n) } : { doubleValue: n } });
      const t = [];
      if (usd) t.push(inc('usd', usd), inc(`u${dd}`, usd));
      if (pages) t.push(inc(`p${dd}`, pages));
      if (!t.length) return;
      await call(`${DOCS}:commit`, json('POST', { writes: [{ transform: { document: name, fieldTransforms: t } }] }, s.idToken));
    },
    /** 한 달 비용 {usd, days: {dd: {usd, pages}}} */
    async monthCost(s, month) {
      const d = await getDoc(s, `/cost/${month}`);
      return monthFromDoc(d);
    },
    /**
     * 관리자 피드백을 모두의 목록(feedback/{내용 해시})에 더한다. 사람·책 정보는 보내지 않고 내용과 유형만.
     * 같은 내용이면 count만 늘어난다.
     */
    async pushFeedback(s, items) {
      if (!items?.length) return 0;
      await fresh(s);
      const writes = [];
      for (const it of items) {
        const text = String(it.text || '').slice(0, 1500);
        const id = (await sha256Hex(feedbackKeyOf(text))).slice(0, 40);
        const name = `projects/${FIREBASE.projectId}/databases/(default)/documents/feedback/${id}`;
        writes.push({
          update: { name, fields: toFields({ text, type: String(it.type || '기타').slice(0, 40) }) },
          updateMask: { fieldPaths: ['text', 'type'] },
          updateTransforms: [{ fieldPath: 'count', increment: { integerValue: '1' } }],
        });
      }
      for (let i = 0; i < writes.length; i += 200) {
        await call(`${DOCS}:commit`, json('POST', { writes: writes.slice(i, i + 200) }, s.idToken));
      }
      return writes.length;
    },
    /** 내가 모두의 목록에 이미 올린 피드백 키 (users/{uid}/meta/feedback) */
    async getFeedbackPushed(s) {
      const d = await getDoc(s, '/meta/feedback');
      return d?.pushed ? safeParse(d.pushed) || [] : [];
    },
    saveFeedbackPushed: (s, keys) => patch(s, '/meta/feedback', { pushed: JSON.stringify(keys) }),
    /** 모두의 피드백 [{text, type, count}] (많이 받은 순) */
    async listFeedback(s) {
      await fresh(s);
      const out = [];
      let token = '';
      for (let i = 0; i < 5; i++) {
        const r = await call(`${DOCS}/feedback?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, json('GET', undefined, s.idToken));
        for (const d of r.documents || []) {
          const f = fromFields(d.fields);
          if (f.text) out.push({ text: String(f.text), type: String(f.type || '기타'), count: Number(f.count) || 1 });
        }
        token = r.nextPageToken;
        if (!token) break;
      }
      return out.sort((a, b) => b.count - a.count);
    },
    async deleteAccount(s) {
      await fresh(s);
      await call(doc(s, ''), json('DELETE', undefined, s.idToken)).catch(() => {});
      await auth('delete', { idToken: s.idToken });
    },
  };
}

const feedbackKeyOf = (text) => String(text ?? '').normalize('NFC').replace(/[\s.,!?·…'"“”‘’()\[\]]/g, '').toLowerCase();
async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }

export function monthFromDoc(d) {
  const out = { usd: Number(d?.usd) || 0, days: {} };
  for (const [k, v] of Object.entries(d || {})) {
    const m = /^([up])(\d\d)$/.exec(k);
    if (!m) continue;
    const day = (out.days[m[2]] ||= { usd: 0, pages: 0 });
    day[m[1] === 'u' ? 'usd' : 'pages'] = Number(v) || 0;
  }
  return out;
}
