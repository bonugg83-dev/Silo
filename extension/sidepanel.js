import { applyRules } from './lib/rules.js';
import { diffWords, disagreements } from './lib/diff.js';
import {
  buildWriteMessage, buildVerifyMessage, buildBookBlock, buildTocMessage, TOC_SYSTEM_PROMPT, TOC_SCHEMA, VERIFY_SCHEMA,
} from './lib/prompt.js';
import { callClaude, estimateCostUsd, MODELS } from './lib/claude.js';
import {
  pageRead, pageFetchImage, pageFetchToc, pageFetchOriginal, pageUploadCrop, pageApply, pageSave, pageGoto,
  pageFetchMyFeedback,
} from './lib/page.js';
import { findLinks, putNoteAtMarker, removeNoteLine, markUnlinked } from './lib/footnotes.js';
import { editorHtmlToText, downscaleImage, imageSize, displayText } from './lib/convert.js';
import { alignHeadings } from './lib/headings.js';
import { fixPageKind, tableFlags, hasSubscriptNote } from './lib/special.js';
import { parseBookList, parseFeedPopup, mergeFeedback, feedbackDigest } from './lib/feedback.js';
import { findOmissions, tooShort, suspiciousSpecial, repeatsPrevEnd } from './lib/omission.js';
import { tidyMessage, sortReview, reviewCounts } from './lib/issues.js';
import { applyFixes } from './lib/fixes.js';
import {
  parseVisualBlocks, buildEditorData, existingFigures, cropImage, IMAGE_KINDS,
} from './lib/visuals.js';
import { staleBookKeys } from './lib/cleanup.js';
import { playSplash, setupBrand } from './lib/splash.js';
import {
  AVATAR_COLORS, LOCK_OPTIONS, makeProfile, encryptKey, decryptKey, isApiKey, maskKey, checkPassword,
  bookKey, costKey, costPagesKey, costMonthKey, runLockKey, today, thisMonth, legacyMigration, profileDataKeys, lockExpired, overLimit, runLockedByOther,
} from './lib/profiles.js';
import { createCloud, OfflineError, CloudError } from './lib/cloud.js';

const $ = (id) => document.getElementById(id);
const TOC_VERSION = 2;

const DEFAULT_SETTINGS = {
  keys: [], // 예전 버전(계정 없던 때)의 평문 키. 회원가입 때 골라 쓰면 지움
  model: 'claude-opus-5-5',
  effort: 'high',
  verify: true,
  verifyFull: false, // 2차 검증 때 원본 전체를 다시 훑어 누락·형식까지
  zoom: true, // 불확실한 글자·누락 의심·작은 글씨가 있는 쪽만 위·아래 반쪽 확대본으로 다시 확인
  settingsRev: 2,
  useToc: true,
  imageMax: 2000,
  dashSpacing: 'attach',
  unitSymbols: true,
  autoVisuals: true,
  stopOnVisuals: true,
  stopOnSpecial: true,
  stopOnPageGuess: true,
  stopOnWarnings: false,
  timeWarnMin: 20,
  showCost: true,
  runThrough: true,
  pacing: true,
  paceMinSec: 60,
  paceMaxSec: 90,
};

let settings = { ...DEFAULT_SETTINGS };
let current = null;
let autoRunning = false;
let running = false; // 교정하기가 도는 중 (한 쪽 또는 자동모드)
let appMoving = false; // 앱이 직접 쪽을 옮기는 중 (검수 열기 등) → 쪽 따라가기 안 함
let stopReq = false; // 교정 중에 교정하기를 한 번 더 눌러 멈추기를 요청함
let abort = null;
// ---------- 교정자 프로필 (lib/profiles.js) ----------
let profiles = []; // chrome.storage.local "profiles"
let unlocked = null; // {pid, key, lastUsed} (chrome.storage.session "unlock")
let runPid = ''; // 교정이 도는 동안 고정한 프로필과 키
let runKey = '';
const PANEL_ID = crypto.randomUUID();

const pid = () => runPid || unlocked?.pid || '';
const me = () => profiles.find((p) => p.id === pid());
// 온라인 계정 (lib/cloud.js). 로그인 세션은 chrome.storage.session "cloud" 에 (브라우저를 닫으면 사라짐)
const cloud = createCloud();
let cloudSes = null; // {pid, uid, idToken, refreshToken, exp}
const online = () => (cloudSes && cloudSes.pid === pid() ? cloudSes : null);
async function keepSession() { if (cloudSes) await chrome.storage.session.set({ cloud: cloudSes }); }
/** 온라인 저장: 인터넷이 안 되면 조용히 넘어감 (다음에 다시 올림) */
async function quietly(f) {
  const s = online();
  if (!s) return false;
  try { await f(s); await keepSession(); return true; } catch (e) { console.warn('온라인 저장 실패', e); return false; }
}
async function saveProfiles() {
  await chrome.storage.local.set({ profiles });
  const p = me();
  if (p?.uid) quietly((s) => cloud.saveProfile(s, p));
}
function paintAvatar(el, p) {
  if (!el) return;
  const [bg, fg] = AVATAR_COLORS[(p?.color || 0) % AVATAR_COLORS.length];
  el.style.background = bg;
  el.style.color = fg;
  el.textContent = (p?.name || '?').trim().slice(0, 1);
}
async function setLockState(on) {
  const st = on ? { activeProfileId: unlocked.pid, lockState: { pid: unlocked.pid, unlocked: true, at: Date.now() } }
    : { lockState: { pid: (await chrome.storage.local.get('activeProfileId')).activeProfileId || '', unlocked: false, at: Date.now() } };
  await chrome.storage.local.set(st);
}
async function openProfile(p, apiKey, ses = null) {
  unlocked = { pid: p.id, key: apiKey, lastUsed: Date.now() };
  cloudSes = ses ? { ...ses, pid: p.id } : null;
  await chrome.storage.session.set({ unlock: unlocked, cloud: cloudSes });
  await setLockState(true);
  await chrome.storage.local.set({ lastLoginId: p.name });
  showGate(false);
  fillForms();
  showTodayCost();
  refreshStatus();
  if (cloudSes) syncCost();
}
async function lock() {
  if (running) { msg('settingsMsg', '교정이 끝난 뒤 로그아웃할 수 있어요.'); return; }
  unlocked = null;
  cloudSes = null;
  await chrome.storage.session.remove(['unlock', 'cloud']);
  await setLockState(false);
  setSettingsOpen(false);
  resetBox();
  showGate(true);
}
let lastTouch = 0;
function touch() {
  if (!unlocked || Date.now() - lastTouch < 20000) return;
  lastTouch = unlocked.lastUsed = Date.now();
  chrome.storage.session.set({ unlock: unlocked });
}
async function restoreUnlock() {
  const r = await chrome.storage.session.get(['unlock', 'cloud']);
  const u = r.unlock;
  const p = profiles.find((x) => x.id === u?.pid);
  if (u && p && !lockExpired(u, p)) { unlocked = u; cloudSes = r.cloud?.pid === u.pid ? r.cloud : null; }
  else if (u) await chrome.storage.session.remove(['unlock', 'cloud']);
}

// 로그인 · 회원가입 화면 (로그인해야 앱을 쓸 수 있음)
const findAccount = (id) => profiles.find((p) => p.name.toLowerCase() === (id || '').trim().toLowerCase());
function gateStep(step) {
  $('gateLogin').classList.toggle('hidden', step !== 'login');
  $('gateSignup').classList.toggle('hidden', step !== 'signup');
  $('gateMsg').textContent = '';
  if (step === 'signup') prepSignup();
  setTimeout(() => (step === 'login' ? ($('loginId').value ? $('loginPw') : $('loginId')) : $('newName')).focus(), 50);
}
function showGate(on) {
  document.body.classList.toggle('auth-open', on);
  $('gate').inert = !on;
  $('gate').setAttribute('aria-hidden', String(!on));
  $('work').inert = on || document.body.classList.contains('settings-open');
  if (!on) return;
  $('loginPw').value = '';
  $('forgotBox').classList.remove('open');
  chrome.storage.local.get('lastLoginId').then((r) => { if (!$('loginId').value) $('loginId').value = r.lastLoginId || ''; });
  $('loginTitle').textContent = profiles.length ? '다시 오셨네요' : 'Silo에 로그인';
  gateStep('login');
}
function prepSignup() {
  // 예전 버전에 그냥 저장해 둔 키가 있으면 골라 쓸 수 있게
  const sel = $('legacyKey');
  sel.innerHTML = '';
  for (const k of settings.keys) sel.add(new Option(`예전에 저장한 키: ${k.name} (${maskKey(k.key)})`, k.id));
  if (settings.keys.length) sel.add(new Option('새 키 넣기', ''));
  $('legacyFld').classList.toggle('hidden', !settings.keys.length);
  $('newKeyFld').classList.toggle('hidden', !!settings.keys.length && !!sel.value);
}
const NEED_NET = '인터넷 연결이 필요해요. 연결한 뒤 다시 해 주세요.';
/** 처음 계정일 때: 계정이 없던 때의 책·비용 기록을 이 계정 것으로 */
async function adoptLegacy(p) {
  const plan = legacyMigration(await chrome.storage.local.get(null), p.id);
  if (Object.keys(plan.set).length) await chrome.storage.local.set(plan.set);
  if (plan.remove.length) await chrome.storage.local.remove(plan.remove);
}
async function signup() {
  const name = $('newName').value.trim();
  const code = $('newCode').value.trim();
  const legacy = settings.keys.find((k) => k.id === $('legacyKey').value);
  const apiKey = legacy ? legacy.key : $('newKey').value.trim();
  const pw = $('newPw1').value;
  const bad = !/^[A-Za-z0-9가-힣_.-]{2,20}$/.test(name) ? '아이디는 영문, 숫자, 한글로 2~20자예요.'
    : findAccount(name) ? '이 컴퓨터에 이미 있는 아이디예요. 로그인해 주세요.'
      : checkPassword(pw, $('newPw1b').value)
        || (!code ? '가입 코드를 넣어 주세요.' : '')
        || (!isApiKey(apiKey) ? 'API 키 형식이 아니에요. sk-ant- 로 시작하는 키를 붙여 넣어 주세요.' : '');
  if (bad) { $('gateMsg').textContent = bad; return; }
  $('gateMsg').textContent = '계정을 만드는 중…';
  const first = !profiles.length;
  const p = await makeProfile({ name, apiKey, password: pw, index: profiles.length });
  let ses;
  try {
    ses = await cloud.signUp({ id: name, password: pw, code, profile: p, settings });
  } catch (e) {
    $('gateMsg').textContent = e instanceof OfflineError ? NEED_NET : e.message;
    return;
  }
  p.id = p.uid = ses.uid;
  profiles.push(p);
  await chrome.storage.local.set({ profiles });
  if (first) { await adoptLegacy(p); await uploadLocalCosts(p, ses); }
  if (legacy) {
    settings.keys = settings.keys.filter((k) => k.id !== legacy.id);
    await chrome.storage.local.set({ settings });
  }
  for (const id of ['newName', 'newPw1', 'newPw1b', 'newKey', 'newCode']) $(id).value = '';
  await openProfile(p, apiKey, ses);
}
/** 서버의 계정 기록을 이 컴퓨터에 반영 (없으면 새로 둠) */
function mergeCloudProfile(local, remote, uid) {
  if (local) { Object.assign(local, remote, { uid }); return local; }
  const p = { ...remote, id: uid, uid };
  profiles.push(p);
  return p;
}
async function login() {
  const id = $('loginId').value.trim();
  const pw = $('loginPw').value;
  if (!id) { $('gateMsg').textContent = '아이디를 넣어 주세요.'; return; }
  const local = findAccount(id);
  $('gateMsg').textContent = '로그인하는 중…';
  let r;
  try {
    r = await cloud.signIn({ id, password: pw });
  } catch (e) {
    if (e instanceof OfflineError) {
      // 인터넷이 안 되면 이 컴퓨터에 남은 계정으로
      if (!local) { $('gateMsg').textContent = `${NEED_NET} (이 컴퓨터에서 처음 로그인하는 아이디예요)`; return; }
      const k = await decryptKey(local.enc, pw);
      if (!k) { $('gateMsg').textContent = '비밀번호가 맞지 않아요.'; $('loginPw').select(); return; }
      await openProfile(local, k);
      msg('settingsMsg', '인터넷이 안 돼서 이 컴퓨터에 남은 기록으로 들어왔어요.');
      return;
    }
    if (e instanceof CloudError && /LOGIN|PASSWORD|NOT_FOUND/.test(e.code) && local && !local.uid) return moveOnline(local, pw);
    $('gateMsg').textContent = e.message;
    return;
  }
  if (!r.profile) { $('gateMsg').textContent = '계정 기록이 없어요. 관리자에게 계정 삭제를 부탁한 뒤 다시 가입해 주세요.'; return; }
  const k = await decryptKey(r.profile.enc, pw);
  if (!k) { $('gateMsg').textContent = 'API 키를 풀지 못했어요. 다시 가입해 주세요.'; return; }
  const first = !profiles.length;
  const p = mergeCloudProfile(local, r.profile, r.session.uid);
  await chrome.storage.local.set({ profiles });
  if (first) await adoptLegacy(p);
  if (r.settings) {
    settings = { ...settings, ...r.settings, keys: settings.keys };
    await chrome.storage.local.set({ settings });
  }
  await openProfile(p, k, r.session);
}
/** 예전에 이 컴퓨터에만 만든 계정: 비밀번호가 맞으면 가입 코드를 받아 온라인으로 옮김 */
async function moveOnline(p, pw) {
  const k = await decryptKey(p.enc, pw);
  if (!k) { $('gateMsg').textContent = '비밀번호가 맞지 않아요.'; $('loginPw').select(); return; }
  const code = $('loginCode').value.trim();
  if (!code) {
    $('loginCodeFld').classList.remove('hidden');
    $('gateMsg').textContent = '이 계정은 아직 이 컴퓨터에만 있어요. 가입 코드를 넣고 로그인하면 온라인으로 옮겨요.';
    $('loginCode').focus();
    return;
  }
  $('gateMsg').textContent = '계정을 온라인으로 옮기는 중…';
  let ses;
  try {
    ses = await cloud.signUp({ id: p.name, password: pw, code, profile: p, settings });
  } catch (e) {
    $('gateMsg').textContent = e instanceof OfflineError ? NEED_NET : e.message;
    return;
  }
  p.uid = ses.uid; // 책·비용 기록 키는 예전 id 그대로
  await chrome.storage.local.set({ profiles });
  $('loginCode').value = '';
  $('loginCodeFld').classList.add('hidden');
  await uploadLocalCosts(p, ses);
  await openProfile(p, k, ses);
}
/** 이 컴퓨터에만 쌓인 비용 기록을 서버로 (온라인으로 옮길 때 한 번) */
async function uploadLocalCosts(p, ses) {
  const all = await chrome.storage.local.get(null);
  const re = new RegExp(`^(cost|costpages):${p.id}:(\\d{4}-\\d{2}-\\d{2})$`);
  const days = {};
  for (const [key, v] of Object.entries(all)) {
    const m = re.exec(key);
    if (m) (days[m[2]] ||= { usd: 0, pages: 0 })[m[1] === 'cost' ? 'usd' : 'pages'] = Number(v) || 0;
  }
  try {
    for (const [day, c] of Object.entries(days)) await cloud.addCost(ses, { ...c, day });
  } catch (e) {
    // 못 올린 건 다음에 다시
    const list = Object.entries(days).map(([day, c]) => ({ ...c, day }));
    await chrome.storage.local.set({ [pendKey(p.id)]: list });
  }
}

// ---------- 비용 (프로필별) ----------
async function monthUsd(id = pid()) {
  const k = costMonthKey(id);
  return (await chrome.storage.local.get(k))[k] || 0;
}
async function addCost(usd) {
  if (!usd || !pid()) return;
  const k = costKey(pid());
  const mk = costMonthKey(pid());
  const r = await chrome.storage.local.get([k, mk]);
  await chrome.storage.local.set({ [k]: (r[k] || 0) + usd, [mk]: (r[mk] || 0) + usd });
  pushCost({ usd });
  // 월 한도에 닿으면 자동모드는 이 쪽까지만
  if (autoRunning && overLimit(me(), (r[mk] || 0) + usd)) {
    autoRunning = false;
    setProgress(`이번 달 한도($${me().monthlyLimit})에 닿아서 이 쪽까지만 하고 멈춰요.`);
  }
  showTodayCost();
}
/** 쪽 하나 교정이 끝날 때: 쪽당 평균과 토큰 기록 (비용 비교용, 최근 300쪽) */
async function logPage(entry) {
  const day = costPagesKey(pid());
  const r = await chrome.storage.local.get([day, 'usageLog']);
  const log = [...(r.usageLog || []), { at: Date.now(), pid: pid(), ...entry }].slice(-300);
  await chrome.storage.local.set({ [day]: (r[day] || 0) + 1, usageLog: log });
  pushCost({ pages: 1 });
  showTodayCost();
}
// 비용 합계는 온라인에도 (여러 컴퓨터 합계). 올리지 못한 건 모아 두었다가 다음에 올림
const pendKey = (id) => `cloudpending:${id}`;
async function pushCost(c) {
  const id = pid();
  if (!me()?.uid) return;
  const k = pendKey(id);
  const list = [...((await chrome.storage.local.get(k))[k] || []), { ...c, day: today() }];
  await chrome.storage.local.set({ [k]: list });
  await flushCost();
}
let flushing = false;
async function flushCost() {
  const k = pendKey(pid());
  if (flushing || !online()) return;
  flushing = true;
  try {
    const list = (await chrome.storage.local.get(k))[k] || [];
    let done = 0;
    for (const c of list) {
      if (!(await quietly((s) => cloud.addCost(s, c)))) break;
      done++;
    }
    if (done) {
      const now = (await chrome.storage.local.get(k))[k] || [];
      await chrome.storage.local.set({ [k]: now.slice(done) });
    }
  } finally { flushing = false; }
}
/** 로그인할 때: 다른 컴퓨터에서 쓴 비용까지 합친 이번 달·오늘 합계를 받아 옴 */
async function syncCost() {
  const id = pid();
  await flushCost();
  if ((((await chrome.storage.local.get(pendKey(id)))[pendKey(id)]) || []).length) return; // 못 올린 게 남으면 덮어쓰지 않음
  let m;
  if (!(await quietly(async (s) => { m = await cloud.monthCost(s, thisMonth()); }))) return;
  if (!m.usd) return; // 이번 달에 아직 쓴 게 없음
  const dd = today().slice(8, 10);
  await chrome.storage.local.set({ [costMonthKey(id)]: m.usd, [costKey(id)]: m.days[dd]?.usd || 0, [costPagesKey(id)]: m.days[dd]?.pages || 0 });
  showTodayCost();
}
const won = (usd) => `약 ${Math.round(usd * 1450).toLocaleString()}원`;
async function showTodayCost() {
  if (!pid()) return;
  const r = await chrome.storage.local.get([costKey(pid()), costPagesKey(pid()), costMonthKey(pid())]);
  const usd = r[costKey(pid())] || 0;
  const pages = r[costPagesKey(pid())] || 0;
  const month = r[costMonthKey(pid())] || 0;
  $('costToday').textContent = `$${usd.toFixed(2)}`;
  $('costTodayWon').textContent = won(usd);
  $('costMonth').textContent = `$${month.toFixed(2)}`;
  $('costMonthWon').textContent = won(month);
  $('todayCost').textContent = pages ? `오늘 ${pages}쪽, 쪽당 ${won(usd / pages)}` : '';
  const lim = Number(me()?.monthlyLimit) || 0;
  $('limitBar').classList.toggle('hidden', !lim);
  $('limitBar').classList.toggle('over', overLimit(me(), month));
  $('limitFill').style.width = lim ? `${Math.min(100, (month / lim) * 100)}%` : '0';
}
let editing = false;

// ---------- 설정 ----------
async function loadSettings() {
  const s = await chrome.storage.local.get(['settings', 'profiles']);
  const raw = s.settings || {};
  profiles = s.profiles || [];
  settings = { ...DEFAULT_SETTINGS, ...raw };
  // 예전 버전: 키 하나(apiKey) → 이름 붙은 키 목록 (프로필로 옮기기 전까지만 둠)
  if (raw.apiKey && !(raw.keys && raw.keys.length)) {
    settings.keys = [{ id: crypto.randomUUID(), name: '내 키', key: raw.apiKey }];
  }
  delete settings.apiKey;
  delete settings.activeKeyId;
  // 화면에서 뺀 설정은 기본값으로 고정
  // 줄표 앞뒤는 원칙대로 항상 붙여 씀 (설정 없앰)
  Object.assign(settings, { effort: 'high', useToc: true, imageMax: 2000, unitSymbols: true, runThrough: true, timeWarnMin: 0, dashSpacing: 'attach' });
  // 2026-11-26: 2차 검증 때 원본 전체 다시 보기는 기본 꺼짐으로 (예전에 저장된 켜짐도 한 번 끔)
  if ((raw.settingsRev || 0) < 2) { settings.verifyFull = false; settings.zoom = true; settings.settingsRev = 2; }
  await chrome.storage.local.set({ settings });
}
async function persist() {
  await chrome.storage.local.set({ settings });
  if (me()?.uid) quietly((s) => cloud.saveSettings(s, settings));
}
function activeKey() {
  return runKey || unlocked?.key || '';
}

function renderMe() {
  const p = me();
  if (!p) return;
  paintAvatar($('meAvatar'), p);
  $('meName').textContent = p.name;
  $('meSub').textContent = '로그인 중';
  $('meKey').textContent = p.mask;
  $('monthlyLimit').value = p.monthlyLimit || '';
  const sel = $('lockAfter');
  if (!sel.options.length) for (const o of LOCK_OPTIONS) sel.add(new Option(o.label, String(o.min)));
  sel.value = String(p.lockAfterMin ?? 30);
}
function toggleBox(box, btn, on = !$(box).classList.contains('open')) {
  $(box).classList.toggle('open', on);
  if (btn) $(btn).classList.toggle('white', on);
  if (on) setTimeout(() => $(box).querySelector('input')?.focus(), 50);
}
async function changeKey() {
  const p = me();
  const apiKey = $('newKeyValue').value.trim();
  if (!isApiKey(apiKey)) { msg('settingsMsg', 'API 키 형식이 아니에요. sk-ant- 로 시작하는 키를 붙여 넣어 주세요.'); return; }
  const pw = $('changeKeyPw').value;
  if (!(await decryptKey(p.enc, pw))) { msg('settingsMsg', '비밀번호가 맞지 않아요.'); return; }
  p.enc = await encryptKey(apiKey, pw);
  p.mask = maskKey(apiKey);
  await saveProfiles();
  unlocked.key = apiKey;
  await chrome.storage.session.set({ unlock: unlocked });
  $('newKeyValue').value = '';
  $('changeKeyPw').value = '';
  toggleBox('changeKeyBox', 'btnChangeKey', false);
  renderMe();
  msg('settingsMsg', '키를 바꿨어요.');
}
async function changePassword() {
  const p = me();
  const k = await decryptKey(p.enc, $('oldPw').value);
  if (!k) { msg('settingsMsg', '지금 비밀번호가 맞지 않아요.'); return; }
  const bad = checkPassword($('newPw').value, $('newPw2').value);
  if (bad) { msg('settingsMsg', bad); return; }
  const encNew = await encryptKey(k, $('newPw').value);
  if (p.uid) {
    // 온라인 계정은 서버 비밀번호도 같이 바꿔야 함 (인터넷 필요)
    if (!online()) { msg('settingsMsg', '비밀번호를 바꾸려면 인터넷이 될 때 다시 로그인해 주세요.'); return; }
    try {
      await cloud.changePassword(online(), { id: p.name, password: $('newPw').value, enc: encNew });
      await keepSession();
    } catch (e) {
      msg('settingsMsg', e instanceof OfflineError ? NEED_NET : e.message);
      return;
    }
  }
  p.enc = encNew;
  await saveProfiles();
  for (const id of ['oldPw', 'newPw', 'newPw2']) $(id).value = '';
  toggleBox('changePwBox', 'btnChangePw', false);
  msg('settingsMsg', '비밀번호를 바꿨어요.');
}
async function deleteProfile() {
  const p = me();
  if (!p || running) return;
  if (p.uid && !online()) { msg('settingsMsg', '계정을 지우려면 인터넷이 될 때 다시 로그인해 주세요.'); return; }
  if (!confirm(`“${p.name}” 계정을 지울까요? 온라인 계정과 이 컴퓨터의 키·책 진행 기록이 모두 지워져요.`)) return;
  if (p.uid) {
    try { await cloud.deleteAccount(online()); } catch (e) { msg('settingsMsg', e instanceof OfflineError ? NEED_NET : e.message); return; }
  }
  await chrome.storage.local.remove(pendKey(p.id));
  await chrome.storage.local.remove(profileDataKeys(await chrome.storage.local.get(null), p.id));
  profiles = profiles.filter((x) => x.id !== p.id);
  await saveProfiles();
  await lock();
}

const ADV_FIELDS = {
  verify: 'checked', verifyFull: 'checked', zoom: 'checked', autoVisuals: 'checked', pacing: 'checked', paceMinSec: 'value', paceMaxSec: 'value',
};
function fillForms() {
  const sel = $('model');
  sel.innerHTML = '';
  for (const m of MODELS) sel.add(new Option(m.label, m.id));
  sel.value = settings.model;
  for (const [id, prop] of Object.entries(ADV_FIELDS)) $(id)[prop] = settings[id];
  $('paceBox').classList.toggle('open', !!settings.pacing);
  renderMe();
}
async function saveAdvanced() {
  for (const [id, prop] of Object.entries(ADV_FIELDS)) {
    let v = $(id)[prop];
    if (['imageMax', 'timeWarnMin', 'paceMinSec', 'paceMaxSec'].includes(id)) v = Math.max(0, Number(v) || 0);
    settings[id] = v;
  }
  if (settings.paceMaxSec < settings.paceMinSec) settings.paceMaxSec = settings.paceMinSec;
  fillForms();
  await persist();
  msg('advancedMsg', '저장했어요.');
}
function msg(id, text) {
  $(id).textContent = text;
  clearTimeout(msg[id]);
  msg[id] = setTimeout(() => { $(id).textContent = ''; }, 3000);
}

// ---------- 공통 ----------
function setProgress(text) {
  $('progress').classList.toggle('hidden', !text);
  $('progress').textContent = text || '';
}
function setError(text) {
  $('error').classList.toggle('hidden', !text);
  $('error').textContent = text || '';
}
/** 교정 중이면 결과 칸 한 줄로, 아니면 작은 알림 줄로 */
function status(text) {
  if (stepper.active) stepper.note(text);
  else setProgress(text);
}
function setBusy(busy) {
  for (const id of ['btnAnalyze', 'btnApply', 'btnReviewed', 'btnToggleEdit']) $(id).disabled = busy || (running && id !== 'btnAnalyze');
  $('btnAuto').disabled = busy || running;
}

// ---------- 교정 중 한 줄 표시 ----------
// 실제로 그 일을 시작하면 바뀌는 단계와, AI 답을 기다리는 동안 5초마다 넘어가는 단계가 섞여 있다.
const STEPS = [
  ['read', '편집 화면 읽는 중'],
  ['pageno', 'Page No 확인하는 중'],
  ['image', '원본 이미지 가져오는 중'],
  ['enhance', '원본 이미지 개선 중'],
  ['watermark', '워터마크 걸러내는 중'],
  ['send', 'AI에게 원본 보내는 중'],
  ['answer', '답변 받는 중'],
  ['letters', '글자 하나하나 읽는 중'],
  ['egg', '구본욱 최고면 개추ㅋ'],
  ['header', '머리말·쪽 번호 지우는 중'],
  ['join', '끊긴 단어 붙이는 중'],
  ['para', '문단 나누는 중'],
  ['punct', '문장부호 맞추는 중'],
  ['spell', '맞춤법·띄어쓰기 확인하는 중'],
  ['foot', '각주 찾는 중'],
  ['verify', 'OCR과 다른 곳 다시 확인하는 중'],
  ['check', '오류 검증 중'],
  ['visual', '시각자료 자르는 중'],
  ['format', '서식 맞추는 중'],
  ['insert', '편집기에 넣는 중'],
];
const STEP_AT = Object.fromEntries(STEPS.map(([k], i) => [k, i]));
const TIMED_MS = 5000; // AI 기다리는 동안 한 단계
const EGG_MS = 800; // 이스터에그는 짧게
const MIN_MS = 250; // 따라잡을 때 한 단계 최소 표시

function showStepLine(text) {
  const line = $('stepLine');
  const span = document.createElement('span');
  span.textContent = text.endsWith('ㅋ') ? text : `${text}…`;
  line.replaceChildren(span);
  $('result').dataset.state = 'busy';
}
const stepper = {
  active: false,
  start() {
    Object.assign(this, { active: true, shown: -1, target: -1, at: 0, timed: false, skip: new Set(), text: {}, waiters: [], pending: '' });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 50);
  },
  reach(k, text) {
    if (!this.active) return;
    if (text) this.text[k] = text;
    this.skip.delete(k);
    this.target = Math.max(this.target, STEP_AT[k]);
    this.tick();
  },
  skipStep(k) { if (this.active) this.skip.add(k); },
  /** 단계 목록에 없는 한 줄 (목차 읽기 등). 표시가 지금 하는 일까지 따라잡은 뒤에 보여 준다 */
  note(text) { this.pending = text; this.tick(); },
  tick() {
    if (!this.active) return;
    const now = Date.now();
    if (this.timed && this.shown >= STEP_AT.send && this.shown < STEP_AT.foot && this.target <= this.shown) {
      const wait = STEPS[this.shown][0] === 'egg' ? EGG_MS : TIMED_MS;
      if (now - this.at >= wait) this.target = this.shown + 1;
    }
    if (this.shown < this.target && (this.shown < 0 || now - this.at >= MIN_MS)) {
      this.pending = '';
      let i = this.shown + 1;
      while (i < this.target && this.skip.has(STEPS[i][0])) i++;
      this.shown = i;
      this.at = now;
      const [k, t] = STEPS[i];
      showStepLine(this.text[k] || t);
    } else if (this.pending && this.shown >= this.target && now - this.at >= MIN_MS) {
      showStepLine(this.pending);
      this.pending = '';
      this.at = now;
    }
    this.waiters = this.waiters.filter((w) => !w());
  },
  /** k 단계까지 보여 준 뒤에 끝난다 */
  until(k) {
    this.reach(k);
    return new Promise((res) => {
      const chk = () => {
        if (this.active && !(this.shown >= STEP_AT[k] && Date.now() - this.at >= MIN_MS)) return false;
        res();
        return true;
      };
      if (!chk()) this.waiters.push(chk);
    });
  },
  stop() {
    this.active = false;
    clearInterval(this.timer);
    for (const w of this.waiters || []) w();
    this.waiters = [];
  },
};

/** 결과 칸 비우기 (교정 전 상태) */
function resetBox() {
  current = null;
  if (editing) setEditMode(false);
  $('result').dataset.state = 'empty';
  $('tgOcr').disabled = true;
}
/** 교정이 실패하면 전에 보이던 대로 */
function restoreBox() {
  $('result').dataset.state = current ? 'done' : 'empty';
}

const PRACTICE_URL = chrome.runtime.getURL('practice/practice.html');
const isPracticeUrl = (u) => String(u || '').startsWith(PRACTICE_URL);

async function getEditorTab() {
  const isEditor = (t) => /mypickebook\.org\/making\/make_book\.html/.test(t?.url || '') || isPracticeUrl(t?.url);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isEditor(tab)) return tab;
  const all = (await chrome.tabs.query({})).filter(isEditor);
  if (all.length === 1) return all[0];
  throw new Error(all.length > 1
    ? '편집 화면이 여러 개 열려 있어요. 작업할 편집 화면 탭을 선택한 상태에서 눌러 주세요.'
    : '마이픽 편집 화면(make_book.html)을 열고 눌러 주세요. 연습하려면 “연습 페이지 열기”를 누르세요.');
}
// ---------- 관리자 피드백 ----------
// chrome.storage.local "feedback:<계정 id>" (Silo 계정마다 따로): {list: [{idx,title,page,type,text,date}], counts: {idx: 건수}, at, pushed: [키], shared: [{text,type,count}], sharedAt}
const FEEDBACK_EVERY_MS = 12 * 60 * 60 * 1000;
const feedbackKey = () => `feedback:${pid()}`;
async function loadFeedback() {
  const { [feedbackKey()]: feedback } = await chrome.storage.local.get(feedbackKey());
  return { list: [], counts: {}, at: 0, pushed: [], shared: [], sharedAt: 0, ...(feedback || {}) };
}
let feedbackBusy = null;
/** 마이픽 마이페이지에서 피드백을 읽어 와 저장하고, 새 것은 모두의 목록에 올리고, 모두의 목록을 받아 둔다 */
function syncFeedback({ manual = false } = {}) {
  if (feedbackBusy) return feedbackBusy;
  feedbackBusy = (async () => {
    const fb = await loadFeedback();
    if (!manual && Date.now() - fb.at < FEEDBACK_EVERY_MS) return { fb, added: 0, skipped: true };
    const tabs = (await chrome.tabs.query({})).filter((x) => /^https:\/\/(www\.)?mypickebook\.org\//.test(x.url || ''));
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find((x) => x.id === active?.id) || tabs[0];
    if (!tab) throw new Error('마이픽 사이트 창이 열려 있어야 피드백을 가져올 수 있어요.');
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageFetchMyFeedback, args: [fb.counts] });
    const got = r?.result;
    if (!got) throw new Error('피드백 화면을 읽지 못했어요.');
    const titles = Object.fromEntries(got.lists.flatMap(parseBookList).map((b) => [b.idx, b]));
    const items = Object.entries(got.pops).flatMap(([idx, htmls]) => htmls.flatMap(parseFeedPopup)
      .map((f) => ({ ...f, idx, title: titles[idx]?.title || '' })));
    const { list, added } = mergeFeedback(fb.list, items);
    const next = { ...fb, list, counts: { ...fb.counts, ...got.counts }, at: Date.now() };
    // 모두의 목록: 새로 받은 피드백 올리기(내용·유형만), 모두의 것 받기
    // "이미 올린 것"은 계정 서버에도 두어, 다른 컴퓨터에서 가져와도 두 번 올리지 않는다
    const key = (f) => `${f.idx}:${f.page}:${f.text}`;
    await quietly(async (s) => { next.pushed = [...new Set([...next.pushed, ...await cloud.getFeedbackPushed(s)])]; });
    const toPush = list.filter((f) => !next.pushed.includes(key(f)));
    if (toPush.length && await quietly(async (s) => {
      await cloud.pushFeedback(s, toPush);
      await cloud.saveFeedbackPushed(s, [...next.pushed, ...toPush.map(key)]);
    })) next.pushed = [...next.pushed, ...toPush.map(key)];
    await quietly(async (s) => { next.shared = await cloud.listFeedback(s); next.sharedAt = Date.now(); });
    await chrome.storage.local.set({ [feedbackKey()]: next });
    paintFeedback(next);
    return { fb: next, added: added.length };
  })().finally(() => { feedbackBusy = null; });
  return feedbackBusy;
}
function paintFeedback(fb) {
  const el = $('feedbackInfo');
  if (!el || !fb) return;
  const when = fb.at ? new Date(fb.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  el.textContent = fb.at
    ? `내 피드백 ${fb.list.length}건${fb.shared.length ? ` · 모두의 피드백 ${fb.shared.length}가지` : ''} · ${when}에 가져옴`
    : '아직 가져오지 않았어요.';
}

async function runInPage(tabId, func, args = []) {
  const tab = await chrome.tabs.get(tabId);
  if (isPracticeUrl(tab.url)) {
    // 연습 페이지는 확장 프로그램 안의 페이지라 같은 함수를 그 페이지가 직접 실행한다
    const r = await chrome.runtime.sendMessage({ practiceCall: true, tabId, fn: func.name, args });
    if (!r) throw new Error('연습 페이지가 아직 준비되지 않았어요.');
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return r?.result;
}
function fmtTime(sec) {
  if (sec == null) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

// ---------- 책별 기록 ----------
async function getBook(bookIdx) {
  const key = bookKey(pid(), bookIdx);
  const s = await chrome.storage.local.get(key);
  const book = s[key] || { pages: {}, toc: null };
  // 첫 버전이 저장한 엉뚱한 목차(단계 표시 없음)는 버린다
  if (book.toc && (book.tocVersion !== TOC_VERSION || !/@@/.test(book.toc))) {
    book.toc = null;
    book.tocNotes = '';
  }
  return book;
}
async function putBook(bookIdx, book) {
  book.lastOpened = Date.now();
  await chrome.storage.local.set({ [bookKey(pid(), bookIdx)]: book });
}
/** 2일 동안 열지 않은 책의 기록을 지운다 */
async function cleanupBooks() {
  const stale = staleBookKeys(await chrome.storage.local.get(null));
  if (stale.length) await chrome.storage.local.remove(stale);
}
function headingsSoFar(book, currPage) {
  const lines = [];
  for (const p of Object.keys(book.pages).map(Number).filter((p) => p < currPage).sort((a, b) => a - b)) {
    for (const line of book.pages[p].text.split('\n')) {
      if (/^@@(\[|\{|\(|H4\(|H5\()/.test(line)) lines.push(`${p}쪽: ${line}`);
    }
  }
  return lines.slice(-30).join('\n');
}
/** 앞쪽들에서 쓴 주석 이름(각주/미주/주석…)과 시각자료 제목 줄 (같은 책 안에서 같은 형식을 쓰게) */
function earlierPages(book, currPage) {
  return Object.keys(book.pages).map(Number).filter((p) => p < currPage).sort((a, b) => a - b).map((p) => [p, book.pages[p].text || '']);
}
function noteLabelsSoFar(book, currPage) {
  const names = new Set();
  for (const [, t] of earlierPages(book, currPage)) for (const m of t.matchAll(/\[(각주|미주|주석|후주|주)(\d+|\*+)/g)) names.add(m[1]);
  return [...names].join(', ');
}
/** 배정 범위 안 앞쪽에서 첨자 제작자 주를 이미 썼는지 (배정 15쪽에 한 번만) */
function subscriptNoteUsed(book, info) {
  const from = isNaN(info.minPage) ? -Infinity : info.minPage;
  return earlierPages(book, info.currPage).some(([p, t]) => p >= from && hasSubscriptNote(t));
}
function visualTitlesSoFar(book, currPage) {
  const out = [];
  for (const [p, t] of earlierPages(book, currPage)) {
    for (const line of t.split('\n')) if (/^\[(그림|사진|그래프|도표|지도|표|글상자)\]/.test(line)) out.push(`${p}쪽: ${line}`);
  }
  return out.slice(-6).join('\n');
}

// ---------- 화면 상태 ----------
let lastStatusError = '';
async function refreshStatus() {
  try {
    const tab = await getEditorTab();
    const info = await runInPage(tab.id, pageRead);
    const book = await getBook(info.bookIdx);
    // 연 책은 기록이 지워지지 않게 표시 (한 시간에 한 번만 쓴다)
    if (!running && Date.now() - (book.lastOpened || 0) > 3600 * 1000) await putBook(info.bookIdx, book);
    showTocState(book);
    updateReviewBadge(book);
    lastStatusError = '';
    await followEditorPage(tab, info).catch(() => {});
    return { tab, info };
  } catch (e) {
    lastStatusError = e.message;
    return null;
  }
}

function showTocState(book) {
  const failed = settings.useToc && !book.toc && book.tocError;
  $('tocAlert').classList.toggle('hidden', !failed);
  $('tocStatus').textContent = book.toc ? '' : (book.tocError ? `목차 읽기 실패: ${book.tocError}` : '');
  if (!$('tocText').matches(':focus')) $('tocText').value = book.toc || '';
  $('tocNotes').textContent = book.tocNotes || '';
}

// ---------- 목차 ----------
async function ensureToc(tab, info, book, signal) {
  // 실패하면 한 번 더 시도하고, 그래도 안 되면 “다시 읽기” 전까지 두지 않음
  if (!settings.useToc || book.toc || (book.tocError && (book.tocTries || 0) >= 2)) return;
  status('목차 이미지를 가져오는 중 (책마다 처음 한 번)');
  try {
    const toc = await runInPage(tab.id, pageFetchToc, [info.bookIdx]);
    if (!toc?.ok) throw new Error(toc?.error || '목차 페이지를 열지 못함');
    if (!toc.images?.length) throw new Error('목차 이미지가 없음');
    status(`목차 ${toc.images.length}쪽을 읽고 단계를 정리하는 중`);
    const imgs = [];
    for (const u of toc.images) imgs.push((await downscaleImage(u, 1800)).dataUrl);
    const rt = await callClaude({
      apiKey: activeKey(), model: settings.model, effort: settings.effort,
      images: imgs, userText: buildTocMessage(info.bookInfo, toc.text), signal,
      system: TOC_SYSTEM_PROMPT, schema: TOC_SCHEMA,
    });
    addCost(estimateCostUsd(settings.model, rt.usage));
    if (!/@@/.test(rt.result.toc || '')) throw new Error('정리 결과에 단계 표시가 없음');
    book.toc = rt.result.toc.trim();
    book.tocNotes = rt.result.notes || '';
    book.tocVersion = TOC_VERSION;
    book.tocError = '';
    book.tocTries = 0;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    book.tocError = e.message || String(e);
    book.tocTries = (book.tocTries || 0) + 1;
  }
  await putBook(info.bookIdx, book);
  showTocState(book);
}

// ---------- 교정 ----------
async function analyze() {
  setError('');
  if (reviewOpen()) await showReview(false);
  const tab = await getEditorTab();
  if (!activeKey()) throw new Error('로그인해 주세요.');
  abort = new AbortController();
  if (editing) setEditMode(false);
  setProgress('');
  stepper.start();
  stepper.reach('read');
  const info = await runInPage(tab.id, pageRead);
  if (!info.editorFound) throw new Error('편집기를 찾지 못했어요. 페이지가 다 열렸는지 확인해 주세요.');
  if (!info.imgSrc) throw new Error('원본 이미지(#book_img)를 찾지 못했어요.');
  const ocrText = editorHtmlToText(info.ocrHtml);

  stepper.reach('image');
  const img = await runInPage(tab.id, pageFetchImage, [info.imgSrc]);
  if (!img?.ok) throw new Error('원본 이미지를 가져오지 못했어요: ' + (img?.error || ''));
  stepper.reach('enhance');
  // 첫 교정은 확대본 없이. 확대본은 필요한 쪽에서만 2차 확인 때 보낸다
  const sent = await downscaleImage(img.dataUrl, 2000);
  let zoomImgs = [];

  const book = await getBook(info.bookIdx);
  await ensureToc(tab, info, book, abort.signal);

  const prev = book.pages[info.currPage - 1];
  const linked = new Set((book.links || []).map((l) => `${l.from}:${l.label}`));
  const pendingFootnotes = [info.currPage - 2, info.currPage - 1]
    .flatMap((p) => (book.pages[p]?.footMissing || []).filter((l) => !linked.has(`${p}:${l}`)).map((l) => `${p}쪽 [${l}]`))
    .join(', ');
  syncFeedback().catch(() => {}); // 12시간에 한 번, 기다리지 않음 (이번 쪽에는 저장된 피드백을 씀)
  const ctx = {
    bookInfo: info.bookInfo,
    tip: info.tipText + (info.tipImages?.length ? '\n(제작 Tip에 이미지가 있어요. 이미지 내용은 볼 수 없으니 관련 판단이 필요하면 flags에 적으세요.)' : ''),
    toc: settings.useToc ? book.toc : '',
    headingsSoFar: headingsSoFar(book, info.currPage),
    noteLabels: noteLabelsSoFar(book, info.currPage),
    visualTitles: visualTitlesSoFar(book, info.currPage),
    prevTail: prev ? prev.text.slice(-600) : '',
    currPage: info.currPage,
    pageField: info.nonePage ? '페이지번호 없음' : info.pageField,
    pageTotal: isNaN(info.minPage) ? '' : `${info.minPage}~${info.maxPage}쪽`,
    ocrText,
    dashSpacing: settings.dashSpacing,
    pendingFootnotes,
    subscriptNoteUsed: subscriptNoteUsed(book, info),
    adminFeedback: await (async () => { const fb = await loadFeedback(); return feedbackDigest(fb.list, fb.shared); })(),
    imageWidth: sent.width,
    imageHeight: sent.height,
    zoomed: false,
  };
  const bookBlock = buildBookBlock(ctx);
  const call = (extra) => callClaude({
    apiKey: activeKey(), model: settings.model, effort: settings.effort, signal: abort.signal, bookBlock, ...extra,
  });

  let cost = 0;
  stepper.reach('send');
  stepper.timed = true;
  // 2차 검증을 같은 대화에 이어 보내므로 1차 질문(이미지 포함)을 캐시해 둔다
  const r1 = await call({ images: [sent.dataUrl], userText: buildWriteMessage(ctx), cacheUser: !!(settings.verify || settings.zoom) });
  stepper.timed = false;
  stepper.reach('foot');
  cost += estimateCostUsd(settings.model, r1.usage);
  const result = r1.result;
  const ruleOpts = { dashSpacing: settings.dashSpacing, unitSymbols: settings.unitSymbols, allowBlankLines: !!result.has_poem_or_quote };
  let checked = applyRules(result.text, ruleOpts);
  const extraFlags = [];
  const noteLines = [];
  const skipOmission = ['toc', 'index_ad'].includes(result.page_kind);
  let r2usage = null;
  // 2차 검증이 다시 보고 판단한 것 (1차의 불확실 표시, OCR에만 있는 구절)
  const checkedByVerify = new Set();
  const omissionsSeen = new Set();

  stepper.skipStep('verify');
  const omitted0 = skipOmission ? [] : findOmissions(ocrText, checked.text);
  // 확대본이 필요한 쪽: 불확실한 글자·각주 표시가 있거나, 누락 의심이 있거나, 작은 글씨(각주·미주)가 있음
  const unsure = (result.flags || []).filter((f) => ['uncertain_text', 'footnote'].includes(f.kind));
  const needZoom = !!settings.zoom && (unsure.length > 0 || omitted0.length > 0 || /\[(각주|미주|주석|후주|주)\d/.test(checked.text));
  if (settings.verify || needZoom) {
    const diffs = settings.verify ? disagreements(ocrText, checked.text) : [];
    const omitted = omitted0;
    if (settings.verifyFull || diffs.length || omitted.length || needZoom) {
      if (needZoom) zoomImgs = await zoomHalves(img.dataUrl).catch(() => []);
      stepper.reach('verify', zoomImgs.length ? '확대 이미지로 작은 글씨·불확실한 곳 다시 확인하는 중'
        : settings.verifyFull ? '원본과 한 줄씩 다시 대조하는 중' : `OCR과 다른 ${diffs.length + omitted.length}곳 다시 확인하는 중`);
      const r2 = await call({
        prior: r1.turn, images: zoomImgs, schema: VERIFY_SCHEMA,
        userText: buildVerifyMessage(ctx, checked.text, diffs, omitted, {
          full: !!settings.verifyFull, zoomed: zoomImgs.length > 0, unsure: unsure.map((f) => f.quote || f.message).filter(Boolean),
        }),
      });
      cost += estimateCostUsd(settings.model, r2.usage);
      r2usage = r2.usage;
      // 2차가 원본(확대본)으로 다시 본 곳은 1차 표시를 떼고, 2차가 여전히 모르겠다고 한 것만 남긴다
      for (const f of unsure) checkedByVerify.add(f);
      for (const o of omitted) omissionsSeen.add(o);
      const fx = applyFixes(checked.text, r2.result.fixes, (x) => applyRules(x, { ...ruleOpts, allowBlankLines: true }).text);
      for (const f of fx.failed) {
        extraFlags.push({ kind: 'uncertain_text', needs_review: true, quote: '',
          message: `2차 검증 수정 못 함: “${f.fix.find}” → “${f.fix.replace}”` });
      }
      for (const f of r2.result.flags || []) extraFlags.push(f);
      noteLines.push(fx.applied.length
        ? `2차 검증에서 ${fx.applied.length}곳 고침:\n${fx.applied.map((f) => `· ${f.find} → ${f.replace} (${f.reason})`).join('\n')}`
        : '2차 검증: 고칠 곳 없음');
      checked = applyRules(fx.text, ruleOpts);
    } else {
      noteLines.push('2차 검증: OCR과 다른 곳이 없어 건너뜀');
    }
  }

  // 제목 단계는 목차에 있는 제목이면 목차대로
  if (book.toc && !['toc', 'book_cover'].includes(result.page_kind)) {
    const al = alignHeadings(checked.text, book.toc);
    if (al.changes.length) {
      checked = { ...checked, text: al.text };
      noteLines.push(`목차에 맞춰 제목 단계 ${al.changes.length}곳 고침: ${al.changes.map((c) => `${c.from || '(없음)'}→${c.to} ${c.line}`).join(', ')}`);
    }
  }

  // 책 표지·차례 쪽 손질 (표지 제목엔 단계 표시 없음, 차례 제목엔 @@[, 쪽 번호 앞 0 삭제)
  {
    const pk = fixPageKind(checked.text, result.page_kind);
    if (pk.changes.length) {
      checked = { ...checked, text: pk.text };
      noteLines.push(pk.changes.slice(0, 3).join(', ') + (pk.changes.length > 3 ? ` 외 ${pk.changes.length - 3}곳` : ''));
    }
  }
  // 표는 봉사자가 직접 그린다: 표마다 빨간 표시
  extraFlags.push(...tableFlags(checked.text));

  // 누락 경보 (프로그램 검사)
  if (!skipOmission) {
    // 한 쪽의 누락 의심은 한 줄로 묶는다. 한 문장 이상(20자 이상) 빠졌을 때만 빨강, 짧으면 노랑
    // 2차가 이미 보고 "본문이 아님"으로 둔 구절은 빼고, 2차 뒤에 새로 생긴 누락만 본다
    const om = findOmissions(ocrText, checked.text).filter((o) => !omissionsSeen.has(o));
    if (om.length) {
      const cut = (o) => (o.length > 30 ? `${o.slice(0, 30)}…` : o);
      const big = om.some((o) => o.replace(/\s/g, '').length >= 20);
      extraFlags.push({ kind: 'omission', needs_review: big, quote: '',
        message: `${om.length > 1 ? `${om.length}곳 ` : ''}OCR에 있는데 결과에 없음: ${om.slice(0, 2).map((o) => `“${cut(o)}”`).join(', ')}${om.length > 2 ? ' 등' : ''}` });
    }
    if (tooShort(ocrText, checked.text)) extraFlags.push({ kind: 'other', needs_review: true, quote: '', message: 'OCR보다 글이 많이 짧음' });
  }
  if (prev?.text && repeatsPrevEnd(prev.text, checked.text)) {
    extraFlags.push({ kind: 'other', needs_review: true, quote: '', message: '앞쪽 끝 문장이 이 쪽 처음에 다시 나옴' });
  }
  if (suspiciousSpecial(ocrText, result.page_kind)) {
    extraFlags.push({ kind: 'other', needs_review: true, quote: '', message: `${PAGE_KIND[result.page_kind]}로 처리했는데 OCR 글자가 많음` });
  }
  stepper.reach('check');
  addCost(cost);
  const sumUsage = (...us) => us.filter(Boolean).reduce((a, u) => ({
    in: a.in + (u.input_tokens || 0), cw: a.cw + (u.cache_creation_input_tokens || 0),
    cr: a.cr + (u.cache_read_input_tokens || 0), out: a.out + (u.output_tokens || 0),
  }), { in: 0, cw: 0, cr: 0, out: 0 });
  logPage({ model: settings.model, usd: cost, calls: r2usage ? 2 : 1, zoom: zoomImgs.length > 0, verifyFull: !!settings.verifyFull,
    ...sumUsage(r1.usage, r2usage) });

  // 다른 쪽에 걸친 각주
  const footMissing = (result.footnotes_without_note || []).map((f) => f.label).filter(Boolean);
  const footOrphans = (result.notes_without_marker || []).filter((f) => f.label);
  for (const l of footMissing) {
    extraFlags.push({ kind: 'footnote', needs_review: true, quote: `[${l}]`,
      message: `${l} 설명이 다음 쪽에 있음 (자동 모드 끝에 이어 붙임)` });
  }
  for (const o of footOrphans) {
    extraFlags.push({ kind: 'footnote', needs_review: true, quote: `[${o.label}:`,
      message: `앞쪽 ${o.label}의 설명 (자동 모드 끝에 앞쪽으로 옮김)` });
  }

  // 시각자료
  stepper.skipStep('visual');
  const visuals = await prepareVisuals(tab, info, checked.text, result.visuals || [], sent);

  current = {
    tabId: tab.id, info, ocrText, result, cost, sentImage: sent,
    text: checked.text, ruleChanges: checked.changes, ruleWarnings: checked.warnings,
    flags: [...(result.flags || []).filter((f) => !checkedByVerify.has(f)), ...extraFlags].map(sortFlag).filter(Boolean),
    notes: [result.notes, ...noteLines].filter(Boolean).join('\n'),
    visuals, book, footMissing, footOrphans,
  };
  current.page = decidePageNumber(info, result, book);
  await stepper.until('format');
  stepper.stop();
  render();
  return current;
}

async function prepareVisuals(tab, info, text, aiVisuals, sent) {
  const blocks = parseVisualBlocks(text);
  if (!blocks.length) return [];
  const existing = existingFigures(info.ocrHtml);
  let original = null;
  const list = [];
  for (let i = 0; i < blocks.length; i++) {
    const v = aiVisuals[i];
    const ex = existing.length === blocks.length ? existing[i] : null;
    const item = { kind: blocks[i].kind, include: settings.autoVisuals || !!ex, crop: null, src: ex?.src || '', width: ex?.width || 0, reused: !!ex, box: null, error: '' };
    if (v?.box && sent.width) {
      item.box = {
        x: clamp01(v.box.x / sent.width), y: clamp01(v.box.y / sent.height),
        w: clamp01(v.box.width / sent.width), h: clamp01(v.box.height / sent.height),
      };
    }
    list.push(item);
  }
  if (!settings.autoVisuals) return list;
  stepper.reach('visual');
  try {
    const o = await runInPage(tab.id, pageFetchOriginal, [info.bookIdx, info.currPage]);
    original = o?.ok ? o.dataUrl : sent.dataUrl;
  } catch {
    original = sent.dataUrl;
  }
  for (const item of list) {
    item.original = original;
    if (item.reused) continue;
    if (!item.box) { item.error = '영역 정보 없음 (그림을 눌러 지정)'; continue; }
    try {
      item.crop = await cropImage(original, item.box);
    } catch (e) {
      item.error = e.message;
    }
  }
  return list;
}
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/** 원본이 크면 위·아래 반쪽(조금 겹침) 확대본을 만든다. 작은 글씨·각주 번호·낫표 획 확인용 */
async function zoomHalves(dataUrl) {
  const { width, height } = await imageSize(dataUrl);
  if (Math.max(width, height) < 1800) return [];
  const out = [];
  for (const box of [{ x: 0, y: 0, w: 1, h: 0.55 }, { x: 0, y: 0.45, w: 1, h: 0.55 }]) {
    const c = await cropImage(dataUrl, box, { pad: 0, trim: false });
    out.push((await downscaleImage(c.dataUrl, 2576)).dataUrl);
  }
  return out;
}

/**
 * 검수에 올릴 표시만 남긴다.
 * 제목 단계·시각자료(표 제외) 판단은 검수하지 않고, 추측성 [기타]는 노랑으로.
 */
function sortFlag(f) {
  if (!f || !f.message) return null;
  if (f.kind === 'heading') return null;
  if (f.kind === 'visual' && !/표/.test(f.message)) return null;
  const out = { ...f, message: tidyMessage(f.message) };
  if (f.kind === 'other' && !/짧음|OCR 글자가 많음|다시 나옴/.test(f.message)) out.needs_review = false;
  return out;
}

function decidePageNumber(info, result, book) {
  const printed = String(result.page_number || '').trim();
  const prevNum = Number(book.pages[info.currPage - 1]?.pageNumber);
  if (printed && /^\d{1,4}$/.test(printed)) {
    const note = info.pageField && info.pageField !== printed ? `쪽 번호: 칸은 ${info.pageField}, 원본은 ${printed}` : '';
    return { value: printed, none: false, note, guessed: !!note };
  }
  if (printed) return { value: info.pageField || '', none: false, note: `쪽 번호가 숫자가 아님(“${printed}”)`, guessed: true };
  // 인쇄된 번호가 없으면 앞쪽 번호로 추정 (페이지번호 없음은 체크하지 않음)
  const guess = Number.isFinite(prevNum) && prevNum > 0 ? String(prevNum + 1) : (info.pageField || String(info.currPage));
  // 앞쪽 번호+1과 사이트 쪽 번호 칸이 같으면 맞는 것으로 본다 (장 표지 등 번호 없는 쪽)
  if (info.pageField && guess === info.pageField) return { value: guess, none: false, note: '', guessed: false };
  return { value: guess, none: false, note: `쪽 번호 추정 (${guess})`, guessed: true, soft: true };
}

// ---------- 화면 그리기 ----------
const KIND_LABEL = { omission: '[누락 의심]', visual: '[시각자료]', footnote: '[주석]', heading: '[제목 단계]', uncertain_text: '[불확실한 글자]', layout: '[배치]', other: '[기타]' };
const PAGE_KIND = { book_cover: '책 표지', chapter_cover: '장 표지', visual_only: '사진·그림만 있는 쪽', blank: '빈 면', toc: '차례', endnotes: '미주 설명', index_ad: '색인·광고' };

function allIssues() {
  const items = [];
  const c = current;
  if (c.storedIssues) {
    items.push(...c.storedIssues);
    c.visuals.forEach((v, i) => { if (v.include && v.error) items.push({ cls: 'review', text: `[그림 ${i + 1}] ${v.error}`, quote: '' }); });
    return items;
  }
  if (c.page.note) items.push({ cls: c.page.soft ? 'warn' : 'review', text: c.page.note, quote: '' });
  for (const f of c.flags) items.push({ cls: f.needs_review ? 'review' : 'warn', text: `${KIND_LABEL[f.kind] || '[확인]'} ${f.message}`, quote: f.quote || '' });
  for (const w of c.ruleWarnings) items.push({ cls: 'warn', text: `[규칙] ${tidyMessage(w.message)}`, quote: w.quote || '' });
  c.visuals.forEach((v, i) => { if (v.include && v.error) items.push({ cls: 'review', text: `[그림 ${i + 1}] ${v.error}`, quote: '' }); });
  return items;
}

function render() {
  const c = current;
  $('result').dataset.state = 'done';
  $('pageNum').value = c.page.value;
  $('nonePage').checked = c.page.none;
  $('output').value = c.text;
  renderOutputView();
  setEditMode(editing);
  $('btnReviewed').classList.toggle('hidden', !c.reviewing);

  $('notes').textContent = c.notes || '';
  const ch = $('changes');
  ch.innerHTML = '';
  for (const r of c.ruleChanges) {
    const li = document.createElement('li');
    li.textContent = `[규칙] ${r.rule} ${r.count}곳${r.examples.length ? ` (예: ${r.examples.slice(0, 2).join(', ')})` : ''}`;
    ch.appendChild(li);
  }
  renderDiff(c.ocrText, c.text);
  $('tgOcr').disabled = false;
  updateLiveWarn();
}

/**
 * 작성 결과에 확인할 곳을 칠한다. 빨강(꼭 확인)과 노랑(참고)이 겹치면 빨강 하나로.
 * 본문에 위치가 없는 항목은 쪽 번호 옆 빨간 점으로. 그림은 @@i 자리에 작게 보여 준다.
 */
function renderOutputView() {
  const text = current.text;
  const raw = [];
  const unplaced = [];
  for (const it of allIssues()) {
    const at = it.quote ? text.indexOf(it.quote) : -1;
    if (at === -1) { unplaced.push(it); continue; }
    raw.push({ start: at, end: at + it.quote.length, titles: [it.text], red: it.cls === 'review' });
  }
  raw.sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const r of raw) {
    const last = ranges.at(-1);
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
      last.titles.push(...r.titles);
      last.red = last.red || r.red;
    } else ranges.push({ ...r, titles: [...r.titles] });
  }
  // 쪽 번호 옆 빨간 점
  const dot = $('pageDot');
  dot.classList.toggle('hidden', !unplaced.length);
  dot.classList.toggle('warn', unplaced.length > 0 && !unplaced.some((u) => u.cls === 'review'));
  dot.title = unplaced.map((u) => u.text).join('\n');

  // 그림 자리: 각 시각자료 블록의 "@@i" 줄 끝
  const blocks = parseVisualBlocks(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const imgAt = new Map();
  blocks.forEach((b, i) => {
    const rel = text.split('\n').slice(b.start + 1, b.end).findIndex((l) => l.trim() === '@@i');
    if (rel === -1) return;
    const ln = b.start + 1 + rel;
    const end = (lineStarts[ln + 1] ?? text.length + 1) - 1;
    imgAt.set(end, i);
  });
  const view = $('outputView');
  view.innerHTML = '';
  const emit = (from, to, parent) => {
    let pos = from;
    for (const [at, i] of [...imgAt].filter(([at]) => at >= from && at < to).sort((a, b) => a[0] - b[0])) {
      parent.append(document.createTextNode(displayText(text.slice(pos, at))));
      parent.append(visualThumb(i));
      pos = at;
    }
    parent.append(document.createTextNode(displayText(text.slice(pos, to))));
  };
  let pos = 0;
  for (const r of ranges) {
    emit(pos, r.start, view);
    const m = document.createElement('mark');
    if (!r.red) m.className = 'warn';
    m.title = r.titles.join('\n');
    emit(r.start, r.end, m);
    view.append(m);
    pos = r.end;
  }
  emit(pos, text.length, view);
  // 본문 끝에 있는 그림 자리
  if (imgAt.has(text.length)) view.append(visualThumb(imgAt.get(text.length)));
}

function visualThumb(i) {
  const v = current.visuals[i];
  const span = document.createElement('span');
  span.className = 'vthumb';
  if (!v) return span;
  const src = v.crop ? v.crop.dataUrl : (v.src ? new URL(v.src, 'https://www.mypickebook.org/').href : '');
  if (src && v.include) {
    const im = document.createElement('img');
    im.src = src;
    im.alt = `그림 ${i + 1}`;
    im.title = v.reused ? '이미 들어 있는 그림' : (current.sentImage ? '눌러서 영역 고치기' : '');
    span.append(im);
  } else {
    span.textContent = '[그림 없음]';
    span.classList.add('missing');
    span.title = v.error || '';
  }
  if (!v.reused && current.sentImage) span.addEventListener('click', () => openCropEditor(i));
  return span;
}

/** 버튼 글자를 바꾸며 폭도 부드럽게 (0.15초) */
function setLabel(btn, text) {
  if (btn.textContent === text) return;
  const from = btn.getBoundingClientRect().width;
  btn.textContent = text;
  if (!from) return;
  btn.style.width = 'auto';
  const to = btn.getBoundingClientRect().width;
  btn.style.width = `${from}px`;
  void btn.offsetWidth;
  btn.style.width = `${to}px`;
  clearTimeout(btn.labelTimer);
  btn.labelTimer = setTimeout(() => { btn.style.width = ''; }, 200);
}
function setEditMode(on) {
  editing = on;
  $('output').classList.toggle('hidden', !on);
  $('outputView').classList.toggle('hidden', on);
  $('result').classList.toggle('editing', on);
  $('btnToggleEdit').classList.toggle('white', on);
  setLabel($('btnToggleEdit'), on ? '저장' : '수정하기');
}

function renderDiff(a, b) {
  const box = $('diff');
  box.innerHTML = '';
  for (const part of diffWords(a, b)) {
    const el = part.type === 'same' ? document.createElement('span') : document.createElement(part.type === 'add' ? 'ins' : 'del');
    el.textContent = displayText(part.text) + (part.text.endsWith('\n') ? '' : ' ');
    box.appendChild(el);
  }
}

function updateLiveWarn() {
  const text = current ? current.text : '';
  const msgs = [];
  if (/[<>]/.test(text)) msgs.push('자판 < > 가 있어요. 사이트가 저장을 막아요(〈 〉 또는 ＜ ＞ 사용).');
  if (/chrome-extension|<script/i.test(text)) msgs.push('사이트가 막는 문자열이 있어요.');
  if (/^\s*\n|\n\s*$/.test(text)) msgs.push('첫 줄이나 마지막 줄이 빈 줄이에요.');
  $('liveWarn').textContent = msgs.join(' ');
  return msgs;
}

// ---------- 영역 고치기 ----------
let cropIndex = -1;
let cropBoxFrac = null;
function openCropEditor(i) {
  const v = current.visuals[i];
  cropIndex = i;
  cropBoxFrac = { ...(v.box || { x: 0.1, y: 0.1, w: 0.8, h: 0.3 }) };
  const img = $('cropPage');
  img.onload = () => requestAnimationFrame(placeCropBox);
  $('cropModal').classList.remove('hidden');
  if (img.src === current.sentImage.dataUrl && img.complete) requestAnimationFrame(placeCropBox);
  else img.src = current.sentImage.dataUrl;
}
function placeCropBox() {
  const st = $('cropStage');
  const W = st.clientWidth;
  const H = st.clientHeight;
  const b = $('cropBox');
  b.style.left = `${cropBoxFrac.x * W}px`;
  b.style.top = `${cropBoxFrac.y * H}px`;
  b.style.width = `${cropBoxFrac.w * W}px`;
  b.style.height = `${cropBoxFrac.h * H}px`;
}
(function setupCropDrag() {
  let drag = null;
  const stage = () => $('cropStage');
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#cropBox')) return;
    const handle = e.target.classList.contains('h') ? [...e.target.classList].find((c) => c !== 'h') : 'move';
    drag = { handle, x: e.clientX, y: e.clientY, start: { ...cropBoxFrac } };
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const W = stage().clientWidth;
    const H = stage().clientHeight;
    const dx = (e.clientX - drag.x) / W;
    const dy = (e.clientY - drag.y) / H;
    const s = drag.start;
    let { x, y, w, h } = s;
    if (drag.handle === 'move') { x = s.x + dx; y = s.y + dy; }
    if (drag.handle.includes('w')) { x = s.x + dx; w = s.w - dx; }
    if (drag.handle.includes('e')) { w = s.w + dx; }
    if (drag.handle.includes('n')) { y = s.y + dy; h = s.h - dy; }
    if (drag.handle.includes('s') && drag.handle !== 'move') { h = s.h + dy; }
    w = Math.max(0.02, Math.min(1, w));
    h = Math.max(0.02, Math.min(1, h));
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    cropBoxFrac = { x, y, w, h };
    placeCropBox();
  });
  document.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('resize', () => { if (cropBoxFrac && !$('cropModal').classList.contains('hidden')) placeCropBox(); });
}());
$('btnCropClose').addEventListener('click', () => $('cropModal').classList.add('hidden'));
$('btnCropApply').addEventListener('click', async () => {
  const v = current.visuals[cropIndex];
  try {
    v.box = { ...cropBoxFrac };
    v.crop = await cropImage(v.original || current.sentImage.dataUrl, v.box, { pad: 0, trim: true });
    v.uploadedSrc = '';
    v.error = '';
    v.include = true;
  } catch (e) {
    v.error = e.message;
  }
  $('cropModal').classList.add('hidden');
  render();
});

// ---------- 넣기 / 저장 ----------
async function applyToEditor({ reviewed = true } = {}) {
  if (!current) throw new Error('먼저 “이 쪽 교정하기”를 눌러 주세요.');
  if (editing) current.text = $('output').value;
  const text = current.text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (updateLiveWarn().some((m) => m.includes('< >') || m.includes('막는'))) {
    throw new Error('사이트가 막는 문자가 있어 넣지 않았어요. 결과를 고친 뒤 다시 눌러 주세요.');
  }
  const tab = await getEditorTab();
  if (tab.id !== current.tabId) throw new Error('교정한 탭과 지금 탭이 달라요.');
  const info = await runInPage(tab.id, pageRead);
  if (info.currPage !== current.info.currPage) throw new Error(`교정한 쪽(${current.info.currPage})과 지금 쪽(${info.currPage})이 달라요. 다시 교정해 주세요.`);
  const nonePage = $('nonePage').checked;
  const pageNum = $('pageNum').value.trim();
  if (!nonePage && !/^\d{1,4}$/.test(pageNum)) throw new Error('쪽 번호는 숫자 1~4자리로 넣어 주세요(로마숫자 쪽은 직접 입력).');

  // 시각자료: 넣을 그림을 올린다 (이미 올렸거나 편집기에 있던 그림은 다시 올리지 않음)
  const blocks = parseVisualBlocks(text);
  const figures = [];
  for (let i = 0; i < blocks.length; i++) {
    const v = current.visuals[i];
    if (!v || !v.include) { figures.push(null); continue; }
    if (v.reused && v.src) { figures.push({ src: v.src, width: v.width || 0 }); continue; }
    if (!v.crop) { figures.push(null); continue; }
    if (!v.uploadedSrc) {
      setProgress(`시각자료 ${i + 1}을 올리는 중…`);
      const up = await runInPage(tab.id, pageUploadCrop, [v.crop.dataUrl, info.bookIdx, info.currPage]);
      if (!up?.ok) throw new Error(`시각자료 ${i + 1} 올리기 실패: ${up?.error || ''}`);
      v.uploadedSrc = up.src;
    }
    figures.push({ src: v.uploadedSrc, width: v.crop.width });
  }
  const data = buildEditorData(text, figures);
  const expectFig = figures.filter(Boolean).length;
  const r = await runInPage(tab.id, pageApply, [data, pageNum, nonePage]);
  if (!r?.ok) throw new Error('편집기에 넣지 못했어요: ' + (r?.error || ''));
  const gotFig = (String(r.data).match(/<figure/gi) || []).length;
  if (gotFig < expectFig) throw new Error(`그림 ${expectFig}개 중 ${gotFig}개만 편집기에 들어갔어요. 편집기를 확인해 주세요.`);
  renderOutputView();

  const book = await getBook(info.bookIdx);
  const old = book.pages[info.currPage] || {};
  const issues = allIssues().map((x) => ({ cls: x.cls, text: x.text, quote: x.quote || '' }));
  book.pages[info.currPage] = {
    text, pageNumber: nonePage ? '' : pageNum, at: Date.now(), issues,
    reviewed: reviewed || !issues.length,
    footMissing: current.footMissing ?? old.footMissing ?? [],
    footOrphans: current.footOrphans ?? old.footOrphans ?? [],
  };
  if (current.footOrphans?.length) findLinks(book, info.currPage, current.footOrphans);
  await putBook(info.bookIdx, book);
  updateReviewBadge(book);
  setProgress('');
  return { tab, info };
}

function waitForPageLoad(tabId, expectedPage, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('다음 쪽이 열리지 않았어요.')); }, timeoutMs);
    function listener(id, change, tab) {
      if (id !== tabId || change.status !== 'complete') return;
      if (expectedPage && !new RegExp(`book_page=${expectedPage}(\\D|$)`).test(tab.url || '')) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function waitForEditor(tabId, expectedPage) {
  for (let i = 0; i < 40; i++) {
    try {
      const info = await runInPage(tabId, pageRead);
      if (info.editorFound && info.currPage === expectedPage && info.imgSrc) return info;
    } catch { /* 로딩 중 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('다음 쪽 편집기가 준비되지 않았어요.');
}

async function save(mode, { reviewed = true } = {}) {
  const { tab, info } = await applyToEditor({ reviewed });
  if (mode === 'next' && info.currPage >= info.maxPage) mode = 'temp';
  if (mode === 'temp') {
    const r = await runInPage(tab.id, pageSave, ['temp']);
    if (!r?.ok) throw new Error('임시저장 실패: ' + (r?.error || ''));
    return { moved: false, info, last: info.currPage >= info.maxPage };
  }
  const expected = info.currPage + 1;
  const loaded = waitForPageLoad(tab.id, expected);
  let r;
  try {
    r = await runInPage(tab.id, pageSave, ['next']);
  } catch {
    r = { ok: true, navigating: true };
  }
  if (r && r.ok === false) throw new Error('저장 실패: ' + (r.error || ''));
  await loaded;
  await waitForEditor(tab.id, expected);
  current = null;
  return { moved: true, info };
}

// ---------- 자동 모드 ----------
function needsStop() {
  const c = current;
  const reasons = [];
  if (settings.runThrough) return ''; // 끝까지 진행하고 검수 탭에서 한 번에 확인
  if (c.flags.some((f) => f.needs_review)) reasons.push('확인할 항목이 있어요');
  if (c.visuals.some((v) => v.include && v.error)) reasons.push('잘라내지 못한 시각자료가 있어요');
  if (settings.stopOnPageGuess && c.page.guessed) reasons.push('쪽 번호를 추정했어요');
  if (settings.stopOnSpecial && PAGE_KIND[c.result.page_kind]) reasons.push(`특수한 쪽(${PAGE_KIND[c.result.page_kind]})이에요`);
  if (settings.stopOnVisuals && c.visuals.length) reasons.push('시각자료가 있어요');
  if (settings.stopOnWarnings && c.ruleWarnings.length) reasons.push('규칙 경고가 있어요');
  return reasons.join(', ');
}

/** 이번 쪽에 머물 시간(초): 켜짐이면 최소~최대 사이 무작위, 꺼짐이면 2~5초 안팎 무작위 */
function pickPaceSec() {
  if (!settings.pacing) return 2 + Math.random() * 3;
  const lo = Number(settings.paceMinSec) || 0;
  const hi = Math.max(lo, Number(settings.paceMaxSec) || 0);
  return lo + Math.random() * (hi - lo);
}
/** 쪽을 연 때부터 targetSec가 지날 때까지 기다린다. 자동 모드를 멈추면 false */
async function waitPace(openedAt, targetSec) {
  const w = $('wait');
  try {
    while (autoRunning) {
      const left = Math.ceil(targetSec - (Date.now() - openedAt) / 1000);
      if (left <= 0) return true;
      w.textContent = `${left}s`;
      w.hidden = false;
      await new Promise((r) => setTimeout(r, Math.min(1000, left * 1000)));
    }
    return false;
  } finally {
    w.hidden = true;
  }
}
async function autoLoop() {
  autoRunning = true;
  await showReview(false);
  // 시작 전에 목차부터 (없으면 제목 단계가 틀리기 쉬움)
  const st0 = await refreshStatus();
  if (!st0) throw new Error(lastStatusError || '편집 화면을 찾지 못했어요.');
  if (!activeKey()) throw new Error('로그인해 주세요.');
  if (settings.useToc) {
    abort = new AbortController();
    const book0 = await getBook(st0.info.bookIdx);
    if (!book0.toc) {
      setProgress('목차를 읽는 중…');
      await ensureToc(st0.tab, st0.info, book0, abort.signal);
      if (!book0.toc) await ensureToc(st0.tab, st0.info, book0, abort.signal); // 한 번 더
      setProgress('');
      if (!book0.toc && !confirm(`목차를 읽지 못했어요(${book0.tocError || '이유 모름'}).\n목차 없이 계속할까요? 제목 단계가 틀릴 수 있어요.`)) return;
    }
  }
  while (autoRunning) {
    const openedAt = Date.now();
    const paceSec = pickPaceSec();
    const st = await refreshStatus();
    if (!st) throw new Error(lastStatusError || '편집 화면을 찾지 못했어요.');
    await analyze();
    if (!autoRunning) break; // 멈추기를 눌렀으면 이 쪽 결과를 보여 주고 끝
    const stop = needsStop();
    if (stop) {
      setProgress(`${current.info.currPage}쪽에서 멈췄어요: ${stop}`);
      break;
    }
    if (!(await waitPace(openedAt, paceSec))) break;
    showStepLine(STEPS[STEP_AT.insert][1]);
    const r = await save('next', { reviewed: false });
    resetBox();
    if (!r.moved) {
      const linked = await linkFootnotes(r.info.bookIdx);
      setProgress(`마지막 쪽(${r.info.currPage}쪽)까지 저장했어요.${linked}`);
      break;
    }
  }
}

// ---------- 이벤트 ----------
function guard(fn) {
  return async () => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || String(e));
      setProgress('');
    } finally {
      setBusy(false);
      refreshStatus();
    }
  };
}

const autoOn = () => $('btnAuto').getAttribute('aria-checked') === 'true';
/** 교정하기: 자동모드가 켜져 있으면 쪽을 넘기며 계속, 꺼져 있으면 이 쪽만 */
async function startRun() {
  if (!unlocked) { showGate(true); return; }
  // 교정이 도는 동안은 계정과 키를 고정 (중간에 다른 계정으로 바뀌어도 이 책은 이 키로)
  const lockKey = runLockKey(unlocked.pid);
  const other = (await chrome.storage.session.get(lockKey))[lockKey];
  if (runLockedByOther(other, PANEL_ID)) { setError('다른 창에서 이 계정으로 교정하고 있어요. 그 창의 교정이 끝난 뒤 눌러 주세요.'); return; }
  if (overLimit(me(), await monthUsd())) { setError(`이번 달 한도($${me().monthlyLimit})를 다 썼어요. 설정에서 한도를 바꿀 수 있어요.`); return; }
  runPid = unlocked.pid;
  runKey = unlocked.key;
  const beat = () => chrome.storage.session.set({ [lockKey]: { owner: PANEL_ID, at: Date.now() } });
  await beat();
  const beatTimer = setInterval(() => { beat(); touch(); }, 20000);
  running = true;
  stopReq = false;
  setError('');
  setProgress('');
  $('btnAnalyze').classList.add('on');
  $('btnReview').classList.add('hidden');
  setBusy(false);
  try {
    if (autoOn()) await autoLoop();
    else await analyze();
  } catch (e) {
    stepper.stop();
    restoreBox();
    if (e.name !== 'AbortError') setError(e.message || String(e));
  } finally {
    clearInterval(beatTimer);
    chrome.storage.session.remove(lockKey);
    if (unlocked) { unlocked.lastUsed = Date.now(); chrome.storage.session.set({ unlock: unlocked }); }
    runPid = '';
    runKey = '';
    running = false;
    autoRunning = false;
    stopReq = false;
    $('wait').hidden = true;
    $('btnAnalyze').classList.remove('on', 'stopping');
    setBusy(false);
    refreshStatus();
  }
}
$('btnAnalyze').addEventListener('click', () => {
  if (stopReq) return; // 멈추는 중에는 더 눌러도 그대로
  pop($('btnAnalyze'));
  if (!running) { startRun(); return; }
  // 교정 중에 한 번 더 누르면: 하던 쪽까지만 하고 멈춤
  stopReq = true;
  autoRunning = false;
  $('btnAnalyze').classList.add('stopping');
});
$('btnAuto').addEventListener('click', () => {
  if (running || $('btnAuto').disabled) return;
  $('btnAuto').setAttribute('aria-checked', String(!autoOn()));
});

// 누르는 느낌 (0.15초)
function pop(b) {
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.pill');
  if (b && b.id !== 'btnAnalyze' && !b.disabled) pop(b);
});
document.addEventListener('animationend', (e) => { if (e.animationName === 'press') e.target.classList.remove('pop'); });

// 붙여넣기: 흰 물이 차오르며 '성공', 잠깐 뒤 가라앉음
let copyTimer;
$('btnApply').addEventListener('click', guard(async () => {
  await applyToEditor();
  const b = $('btnApply');
  clearTimeout(copyTimer);
  b.classList.add('full');
  copyTimer = setTimeout(() => b.classList.remove('full'), 350 + 400);
}));
$('btnReviewed').addEventListener('click', guard(markReviewed));
// 쪽 넘김 간격을 끄면 기다리는 시간 칸이 위로 접힘
$('pacing').addEventListener('change', () => $('paceBox').classList.toggle('open', $('pacing').checked));

// 수정하기 ↔ 저장
$('btnToggleEdit').addEventListener('click', () => {
  if (!current) return;
  if (editing) {
    current.text = $('output').value;
    renderOutputView();
  }
  setEditMode(!editing);
  if (editing) $('output').focus();
});
$('output').addEventListener('input', () => { if (current) { current.text = $('output').value; updateLiveWarn(); } });

// 보기 칩: 하나만 켜지고, 아래로 늘어나며 펼쳐짐
function showDrawer(panelId) {
  const dw = $('dw');
  const from = dw.getBoundingClientRect().height;
  clearTimeout(showDrawer.timer);
  if (panelId) {
    for (const id of ['tocPanel', 'diffPanel']) $(id).classList.toggle('hidden', id !== panelId);
    dw.classList.add('open');
  }
  const to = panelId ? $(panelId).getBoundingClientRect().height : 0;
  dw.style.height = `${from}px`;
  void dw.offsetWidth;
  dw.style.height = `${to}px`;
  showDrawer.timer = setTimeout(() => {
    if (panelId) { dw.style.height = 'auto'; return; }
    dw.classList.remove('open');
    for (const id of ['tocPanel', 'diffPanel']) $(id).classList.add('hidden');
  }, 360);
}
document.querySelectorAll('.chips .chip').forEach((c) => c.addEventListener('click', () => {
  const on = c.getAttribute('aria-pressed') !== 'true';
  document.querySelectorAll('.chips .chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
  c.setAttribute('aria-pressed', String(on));
  showDrawer(on ? c.dataset.panel : null);
}));
$('pageNum').addEventListener('input', () => {
  const v = $('pageNum').value.replace(/\D/g, '').slice(0, 4);
  if (v !== $('pageNum').value) $('pageNum').value = v;
});

// 설정: 오른쪽에서 밀려 들어옴
function setSettingsOpen(on) {
  document.body.classList.toggle('settings-open', on);
  $('settings').setAttribute('aria-hidden', String(!on));
  $('settings').inert = !on;
  $('work').inert = on || document.body.classList.contains('auth-open');
}
$('btnOpenSettings').addEventListener('click', () => { setSettingsOpen(true); loadFeedback().then(paintFeedback); });
$('btnCloseSettings').addEventListener('click', () => setSettingsOpen(false));
$('btnAdvanced').addEventListener('click', () => {
  const on = $('advancedBox').classList.toggle('open');
  $('btnAdvanced').setAttribute('aria-expanded', String(on));
});
$('btnChangeKey').addEventListener('click', () => toggleBox('changeKeyBox', 'btnChangeKey'));
$('btnSaveKey').addEventListener('click', changeKey);
$('changeKeyPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') changeKey(); });
$('btnChangePw').addEventListener('click', () => toggleBox('changePwBox', 'btnChangePw'));
$('btnSavePw').addEventListener('click', changePassword);
$('btnLogout').addEventListener('click', lock);
$('btnDeleteProfile').addEventListener('click', deleteProfile);
$('monthlyLimit').addEventListener('change', async () => {
  me().monthlyLimit = Math.max(0, Number($('monthlyLimit').value) || 0);
  await saveProfiles();
  showTodayCost();
  msg('settingsMsg', me().monthlyLimit ? `이번 달 한도를 $${me().monthlyLimit}로 정했어요.` : '한도를 없앴어요.');
});
$('lockAfter').addEventListener('change', async () => {
  me().lockAfterMin = Number($('lockAfter').value);
  await saveProfiles();
  msg('settingsMsg', '자동 로그아웃 시간을 바꿨어요.');
});
// 로그인 · 회원가입
$('gateLogin').addEventListener('submit', (e) => { e.preventDefault(); login(); });
$('gateSignup').addEventListener('submit', (e) => { e.preventDefault(); signup(); });
$('toSignup').addEventListener('click', () => gateStep('signup'));
$('toLogin').addEventListener('click', () => gateStep('login'));
$('btnForgot').addEventListener('click', () => toggleBox('forgotBox'));
$('legacyKey').addEventListener('change', () => $('newKeyFld').classList.toggle('hidden', !!$('legacyKey').value));
// 쓰는 동안은 자동 로그아웃 시계를 늦춤
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, touch, { capture: true, passive: true });
setInterval(() => {
  if (unlocked && !running && lockExpired(unlocked, me())) lock();
}, 30000);
// 다른 창에서 로그아웃·로그인하면 이 창도 따라감 (교정 중인 창은 끝날 때까지 그대로)
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.profiles) profiles = ch.profiles.newValue || [];
  if (area === 'session' && ch.cloud) cloudSes = ch.cloud.newValue || null;
  if (area !== 'session' || !ch.unlock) return;
  const u = ch.unlock.newValue;
  if (u?.pid === unlocked?.pid && u?.key === unlocked?.key) { unlocked = u; return; }
  unlocked = u && profiles.some((p) => p.id === u.pid) ? u : null;
  if (unlocked) { showGate(false); fillForms(); showTodayCost(); } else if (!running) { setSettingsOpen(false); showGate(true); }
});
$('model').addEventListener('change', async () => { settings.model = $('model').value; await persist(); msg('settingsMsg', '모델을 바꿨어요.'); });
$('btnSaveAdvanced').addEventListener('click', saveAdvanced);

async function editorBook() {
  const tab = await getEditorTab();
  const info = await runInPage(tab.id, pageRead);
  return { info, book: await getBook(info.bookIdx) };
}
$('btnSaveToc').addEventListener('click', guard(async () => {
  const { info, book } = await editorBook();
  book.toc = $('tocText').value.trim() || null;
  book.tocVersion = TOC_VERSION;
  book.tocError = '';
  await putBook(info.bookIdx, book);
  setProgress('목차를 저장했어요.');
}));
async function rebuildToc() {
  const { info, book } = await editorBook();
  book.toc = null;
  book.tocNotes = '';
  book.tocError = '';
  book.tocTries = 0;
  await putBook(info.bookIdx, book);
  $('tocText').value = '';
  showTocState(book);
  if (!activeKey()) throw new Error('로그인해 주세요.');
  abort = new AbortController();
  const tab = await getEditorTab();
  await ensureToc(tab, info, book, abort.signal);
  setProgress(book.toc ? '목차를 다시 읽었어요. “이 책 목차”에서 확인하세요.' : '');
  if (!book.toc && book.tocError) throw new Error(`목차를 읽지 못했어요: ${book.tocError}`);
}
$('btnRebuildToc').addEventListener('click', guard(rebuildToc));
$('btnTocRetry').addEventListener('click', guard(rebuildToc));

// ---------- 검수 (아래에서 올라오는 창) ----------
let reviewShowAll = false;
let reviewDesc = false;
const reviewOpen = () => document.body.classList.contains('review-open');
function updateReviewBadge(book) {
  const left = sortReview(book.pages).length + (book.links || []).filter((l) => !l.done).length;
  $('reviewBadge').textContent = String(left);
  $('reviewBadge').classList.toggle('hidden', !left);
  // 교정이 끝난 뒤, 이 책에 처리한 쪽이 있으면 긴 검수 버튼을 보여 준다
  $('btnReview').classList.toggle('hidden', running || !Object.keys(book.pages || {}).length);
}

/** 검수 창 맨 위: 남은 빨강·노랑 쪽 수와 진행 막대 */
function reviewSummary(c) {
  const sum = document.createElement('div');
  sum.className = 'rv-sum';
  const nums = document.createElement('div');
  nums.className = 'rv-nums';
  const num = (cls, n, label) => {
    const sp = Object.assign(document.createElement('span'), { className: cls });
    sp.append(Object.assign(document.createElement('b'), { textContent: n }), label);
    return sp;
  };
  nums.append(num('nr', c.red, '꼭 볼 쪽'), num('ny', c.yellow, '참고'), num('', c.done, `/ ${c.total} 끝`));
  const bar = document.createElement('div');
  bar.className = 'rv-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `전체 ${c.total}쪽 중 ${c.done}쪽 끝, 꼭 볼 쪽 ${c.red}, 참고 ${c.yellow}`);
  for (const [n, cls] of [[c.done, 'bd'], [c.yellow, 'by'], [c.red, 'br']]) {
    const sp = document.createElement('span');
    sp.className = cls;
    sp.style.width = `${c.total ? (n / c.total) * 100 : 0}%`;
    bar.append(sp);
  }
  sum.append(nums, bar);
  return sum;
}

async function renderReview() {
  let info;
  try {
    const tab = await getEditorTab();
    info = await runInPage(tab.id, pageRead);
  } catch (e) {
    $('reviewPages').innerHTML = '';
    $('reviewPages').append(Object.assign(document.createElement('div'), { className: 'note', textContent: e.message }));
    return;
  }
  const book = await getBook(info.bookIdx);
  updateReviewBadge(book);
  const links = (book.links || []).filter((l) => !l.done);

  $('reviewLinksBox').classList.toggle('hidden', !links.length);
  const lb = $('reviewLinks');
  lb.innerHTML = '';
  for (const link of links) {
    const row = document.createElement('div');
    row.className = 'rv-link';
    const t = document.createElement('div');
    t.textContent = `${link.from}쪽 [${link.label}] ← ${link.to}쪽 맨 위 설명`;
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = link.note.length > 120 ? `${link.note.slice(0, 120)}…` : link.note;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill sm';
    btn.textContent = '반영';
    btn.addEventListener('click', guard(async () => { await applyLink(link); await renderReview(); }));
    row.append(t, note, btn);
    if (link.error) {
      const er = document.createElement('div');
      er.className = 'err';
      er.textContent = link.error;
      row.append(er);
    }
    lb.appendChild(row);
  }

  const box = $('reviewPages');
  box.innerHTML = '';
  box.append(reviewSummary(reviewCounts(book.pages)));
  const list = sortReview(book.pages, { desc: reviewDesc, showAll: reviewShowAll });
  if (!list.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'rv-empty', textContent: '확인할 쪽이 없어요' }));
  }
  for (const { n, rec, tier } of list) {
    const row = document.createElement('div');
    row.className = `rv-row t${tier}${rec.reviewed ? ' done' : ''}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const main = document.createElement('div');
    main.className = 'rv-main';
    const top = document.createElement('div');
    top.className = 'rv-top';
    top.append(Object.assign(document.createElement('span'), { className: 'rv-pg', textContent: `${n}쪽` }));
    if (rec.pageNumber) top.append(Object.assign(document.createElement('span'), { className: 'note', textContent: `쪽 번호 ${rec.pageNumber}` }));
    main.append(top);
    // 가장 중요한 문제(빨강 먼저) 한 줄만, 나머지는 "+N" (전체 문장은 마우스를 올리면 보임)
    const iss = [...(rec.issues || [])].sort((x, y) => (x.cls === 'review' ? 0 : 1) - (y.cls === 'review' ? 0 : 1));
    const msgs = iss.map((it) => tidyMessage(it.text));
    if (iss.length) {
      const f = Object.assign(document.createElement('div'), { className: 'rv-first', textContent: msgs[0] });
      if (iss.length > 1) f.append(Object.assign(document.createElement('span'), { className: 'rv-more', textContent: `+${iss.length - 1}` }));
      f.title = msgs.join('\n');
      main.append(f);
    }
    row.setAttribute('aria-label', `${n}쪽 열기${msgs.length ? `. ${msgs.join(', ')}` : ''}`);
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = `pill sm rv-ok${rec.reviewed ? ' white' : ''}`;
    ok.textContent = rec.reviewed ? '확인됨' : '확인함';
    ok.setAttribute('aria-pressed', String(!!rec.reviewed));
    ok.addEventListener('click', async (e) => {
      e.stopPropagation();
      const b = await getBook(info.bookIdx);
      if (!b.pages[n]) return;
      b.pages[n].reviewed = !b.pages[n].reviewed;
      await putBook(info.bookIdx, b);
      renderReview();
    });
    const open = guard(() => openPageForReview(n));
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) open(); });
    row.append(main, ok);
    box.appendChild(row);
  }
}

/** 편집 화면을 n쪽으로 옮긴다 (이미 그 쪽이면 그대로) */
async function gotoPage(tab, n) {
  const info = await runInPage(tab.id, pageRead);
  if (info.currPage === n) return info;
  if (!isNaN(info.maxPage) && (n > info.maxPage || (!isNaN(info.minPage) && n < info.minPage))) throw new Error(`${n}쪽은 배정 범위 밖이에요.`);
  const loaded = waitForPageLoad(tab.id, n);
  try { await runInPage(tab.id, pageGoto, [n]); } catch { /* 이동 중 */ }
  await loaded;
  return waitForEditor(tab.id, n);
}

/** 저장해 둔 쪽을 다시 열어 패널에 보여 준다 (편집기 내용 기준) */
async function openPageForReview(n) {
  if (running) throw new Error('교정이 끝난 뒤에 열어 주세요.');
  const tab = await getEditorTab();
  setProgress(`${n}쪽으로 가는 중…`);
  appMoving = true;
  let info;
  try { info = await gotoPage(tab, n); } finally { appMoving = false; }
  followEditorPage.seen = `${info.bookIdx}:${info.currPage}`;
  showStoredPage(tab, info, await getBook(info.bookIdx));
  setSettingsOpen(false);
  await showReview(false);
  setProgress(`${n}쪽을 열었어요.`);
}

/** 편집기에 열린 쪽의 교정 결과를 패널에 보여 준다 (편집기 내용 기준) */
function showStoredPage(tab, info, book) {
  const n = info.currPage;
  const rec = book.pages[n] || {};
  const text = editorHtmlToText(info.ocrHtml);
  const figs = existingFigures(info.ocrHtml);
  const blocks = parseVisualBlocks(text);
  const aligned = figs.length === blocks.length;
  const visuals = blocks.map((b, i) => {
    const f = aligned ? figs[i] : null;
    return { kind: b.kind, include: !!f, crop: null, src: f?.src || '', width: f?.width || 0, reused: !!f, box: null,
      error: f ? '' : '그림이 편집기에 없음' };
  });
  editing = false;
  current = {
    tabId: tab.id, info, ocrText: text, result: { page_kind: 'body', notes: '' }, cost: 0, sentImage: null,
    text, ruleChanges: [], ruleWarnings: [], flags: [], storedIssues: rec.issues || [], notes: '',
    visuals, book, reviewing: true, footMissing: rec.footMissing, footOrphans: rec.footOrphans,
    page: { value: info.nonePage ? '' : info.pageField, none: info.nonePage, note: '', guessed: false },
  };
  render();
}

/**
 * 교정이 끝난 뒤 사용자가 왼쪽 사이트에서 쪽을 옮기면 패널도 그 쪽 결과로 따라간다.
 * 교정한 적 없는 쪽이면 결과 칸을 비운다. 고치는 중(수정하기)이면 그대로 둔다.
 */
async function followEditorPage(tab, info) {
  if (!info?.bookIdx || !Number.isFinite(info.currPage)) return;
  // 쪽이 바뀌었을 때만 (교정·자동 모드·검수 열기처럼 앱이 옮긴 쪽은 따라가지 않고 기억만)
  const key = `${info.bookIdx}:${info.currPage}`;
  const moved = followEditorPage.seen && followEditorPage.seen !== key;
  followEditorPage.seen = key;
  if (!moved || running || autoRunning || editing || appMoving) return;
  if (current?.info?.currPage === info.currPage && current?.info?.bookIdx === info.bookIdx) return;
  const book = await getBook(info.bookIdx);
  if (book.pages[info.currPage]) {
    showStoredPage(tab, info, book);
    setProgress(`${info.currPage}쪽 교정 결과예요.`);
  } else if (current) {
    current = null;
    $('result').dataset.state = 'empty';
    setProgress(`${info.currPage}쪽은 아직 교정하지 않았어요.`);
  }
}

/** 편집기의 지금 내용을 text로 바꿔 넣고 임시저장 (그림은 그대로 둔다) */
async function rewritePage(tab, n, change) {
  const info = await gotoPage(tab, n);
  const text = editorHtmlToText(info.ocrHtml);
  const r = change(text);
  if (!r.ok) throw new Error(`${n}쪽: ${r.why}`);
  const figs = existingFigures(info.ocrHtml);
  const blocks = parseVisualBlocks(r.text);
  if (figs.length !== blocks.length) throw new Error(`${n}쪽: 그림 개수가 맞지 않아 자동으로 고치지 않았어요. 직접 고쳐 주세요.`);
  const data = buildEditorData(r.text, figs);
  const a = await runInPage(tab.id, pageApply, [data, info.pageField, info.nonePage]);
  if (!a?.ok) throw new Error(`${n}쪽 넣기 실패: ${a?.error || ''}`);
  const sv = await runInPage(tab.id, pageSave, ['temp']);
  if (!sv?.ok) throw new Error(`${n}쪽 임시저장 실패: ${sv?.error || ''}`);
  return { info, text: r.text };
}

/** 자동 모드 끝: 쪽을 넘는 각주를 모두 이어 붙인다 */
async function linkFootnotes(bookIdx) {
  const pending = ((await getBook(bookIdx)).links || []).filter((l) => !l.done);
  // 짝이 없는 각주(배정 범위 끝 등)는 "이어 붙임" 대신 사실대로 표시
  {
    const b = await getBook(bookIdx);
    if (markUnlinked(b)) await putBook(bookIdx, b);
  }
  if (!pending.length) return '';
  let ok = 0;
  for (const [i, link] of pending.entries()) {
    showStepLine(`쪽을 넘는 각주 잇는 중 (${i + 1}/${pending.length})`);
    try { await applyLink(link, { inRun: true }); ok++; } catch { /* 검수 창에 남김 */ }
  }
  $('result').dataset.state = 'empty';
  return ok === pending.length ? ` 쪽을 넘는 각주 ${ok}개도 이었어요.` : ` 각주 ${pending.length - ok}개는 잇지 못했어요(검수에서 반영).`;
}

async function applyLink(link, { inRun = false } = {}) {
  if (running && !inRun) throw new Error('교정이 끝난 뒤에 반영해 주세요.');
  const tab = await getEditorTab();
  const info0 = await runInPage(tab.id, pageRead);
  const bookIdx = info0.bookIdx;
  const mark = async (patch) => {
    const b = await getBook(bookIdx);
    const l = (b.links || []).find((x) => x.from === link.from && x.label === link.label);
    if (l) Object.assign(l, patch);
    await putBook(bookIdx, b);
    return b;
  };
  try {
    setProgress(`${link.from}쪽 [${link.label}] 자리에 설명을 넣는 중…`);
    const a = await rewritePage(tab, link.from, (t) => putNoteAtMarker(t, link.label, link.note));
    setProgress(`${link.to}쪽 맨 위의 설명을 지우는 중…`);
    const b2 = await rewritePage(tab, link.to, (t) => removeNoteLine(t, link.label));
    const b = await mark({ done: true, error: '' });
    const drop = (rec) => { if (rec) rec.issues = (rec.issues || []).filter((x) => !x.quote || !x.quote.includes(link.label)); };
    if (b.pages[link.from]) {
      b.pages[link.from].text = a.text;
      b.pages[link.from].footMissing = (b.pages[link.from].footMissing || []).filter((l) => l !== link.label);
      drop(b.pages[link.from]);
    }
    if (b.pages[link.to]) {
      b.pages[link.to].text = b2.text;
      b.pages[link.to].footOrphans = (b.pages[link.to].footOrphans || []).filter((o) => o.label !== link.label);
      drop(b.pages[link.to]);
    }
    await putBook(bookIdx, b);
    setProgress(`${link.from}쪽 [${link.label}]에 설명을 옮기고 두 쪽을 임시저장했어요.`);
  } catch (e) {
    await mark({ error: e.message });
    throw e;
  }
}

$('btnApplyAllLinks').addEventListener('click', guard(async () => {
  const tab = await getEditorTab();
  const info = await runInPage(tab.id, pageRead);
  const book = await getBook(info.bookIdx);
  let fail = 0;
  for (const link of (book.links || []).filter((l) => !l.done)) {
    try { await applyLink(link); } catch { fail++; }
  }
  await renderReview();
  if (fail) throw new Error(`${fail}개는 반영하지 못했어요. 목록의 빨간 글씨를 보고 직접 고쳐 주세요.`);
}));
$('btnReview').addEventListener('click', () => showReview(true));
$('btnSheetBack').addEventListener('click', () => showReview(false));
async function showReview(on) {
  if (on === reviewOpen()) { if (on) await renderReview(); return; }
  document.body.classList.toggle('review-open', on);
  $('sheet').setAttribute('aria-hidden', String(!on));
  $('sheet').inert = !on;
  $('work').inert = on;
  if (!on) setSortMenu(false);
  if (on) await renderReview();
}
function setSortMenu(on) {
  $('sortMenu').classList.toggle('open', on);
  $('btnSort').setAttribute('aria-expanded', String(on));
}
$('btnSort').addEventListener('click', () => setSortMenu(!$('sortMenu').classList.contains('open')));
document.querySelectorAll('#sortMenu [data-order]').forEach((b) => b.addEventListener('click', () => {
  reviewDesc = b.dataset.order === 'desc';
  document.querySelectorAll('#sortMenu [data-order]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderReview();
}));
$('btnShowAll').addEventListener('click', () => {
  reviewShowAll = !reviewShowAll;
  $('btnShowAll').setAttribute('aria-checked', String(reviewShowAll));
  renderReview();
});

/** 검수로 연 쪽을 확인함으로. 고친 게 있으면 넣고 임시저장까지 한다. */
async function markReviewed() {
  if (!current?.reviewing) return;
  if (editing) current.text = $('output').value;
  const n = current.info.currPage;
  const changed = current.text !== current.ocrText || $('pageNum').value.trim() !== String(current.page.value);
  if (changed) {
    await save('temp');
  } else {
    const book = await getBook(current.info.bookIdx);
    if (book.pages[n]) book.pages[n].reviewed = true;
    await putBook(current.info.bookIdx, book);
    updateReviewBadge(book);
  }
  current.reviewing = false;
  $('btnReviewed').classList.add('hidden');
  resetBox();
  setProgress(changed ? `${n}쪽 고친 내용을 넣고 임시저장했어요.` : `${n}쪽 확인함.`);
  await showReview(true);
}

async function openPractice() {
  const existing = (await chrome.tabs.query({})).find((t) => isPracticeUrl(t.url));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${PRACTICE_URL}?idx=0&book_page=1` });
  }
}
$('btnPractice2').addEventListener('click', () => openPractice().catch((e) => setError(e.message)));
$('btnFeedback').addEventListener('click', async () => {
  const b = $('btnFeedback');
  b.disabled = true;
  $('feedbackInfo').textContent = '마이픽에서 피드백을 읽는 중…';
  try {
    const r = await syncFeedback({ manual: true });
    paintFeedback(r.fb);
    msg('settingsMsg', r.added ? `새 피드백 ${r.added}건을 가져왔어요. 다음 쪽부터 반영해요.` : '새 피드백이 없어요.');
  } catch (e) {
    paintFeedback(await loadFeedback());
    msg('settingsMsg', e.message);
  } finally { b.disabled = false; }
});

chrome.tabs.onActivated.addListener(() => { if (!running) refreshStatus(); });
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'complete' && !running) refreshStatus(); });
setInterval(() => { if (!running) refreshStatus(); }, 15000);
setInterval(() => { if (!running) cleanupBooks(); }, 3600 * 1000);

playSplash($('brand')).catch(() => {});

(async () => {
  await loadSettings();
  await restoreUnlock();
  setupBrand(document.querySelector('.auth-brand')).catch(() => {});
  fillForms();
  await cleanupBooks();
  if (unlocked) { showTodayCost(); refreshStatus(); } else showGate(true);
})();
