import { applyRules } from './lib/rules.js';
import { diffWords, disagreements } from './lib/diff.js';
import { buildWriteMessage, buildVerifyMessage } from './lib/prompt.js';
import { callClaude, estimateCostUsd, MODELS } from './lib/claude.js';
import { pageRead, pageFetchImage, pageFetchToc, pageApply, pageSave } from './lib/page.js';
import { editorHtmlToText, textToEditorData, downscaleImage } from './lib/convert.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'high',
  verify: true,
  useToc: true,
  dashSpacing: 'attach',
  unitSymbols: true,
  timeWarnMin: 20,
  stopOnWarnings: false,
};

let settings = { ...DEFAULT_SETTINGS };
let current = null; // { tabId, info, ocrText, final, warnings, ... }
let autoRunning = false;
let abort = null;
let sessionCost = 0;

// ---------- 공통 ----------
async function loadSettings() {
  const s = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
}

function fillSettingsForm() {
  const sel = $('model');
  sel.innerHTML = '';
  for (const m of MODELS) sel.add(new Option(m.label, m.id));
  renderKey();
  sel.value = settings.model;
  $('effort').value = settings.effort;
  $('verify').checked = settings.verify;
  $('useToc').checked = settings.useToc;
  $('dashSpacing').value = settings.dashSpacing;
  $('unitSymbols').checked = settings.unitSymbols;
  $('timeWarnMin').value = settings.timeWarnMin;
  $('stopOnWarnings').checked = settings.stopOnWarnings;
}

async function saveSettings() {
  settings = {
    apiKey: settings.apiKey,
    model: $('model').value,
    effort: $('effort').value,
    verify: $('verify').checked,
    useToc: $('useToc').checked,
    dashSpacing: $('dashSpacing').value,
    unitSymbols: $('unitSymbols').checked,
    timeWarnMin: Number($('timeWarnMin').value) || 0,
    stopOnWarnings: $('stopOnWarnings').checked,
  };
  await chrome.storage.local.set({ settings });
  $('settingsMsg').textContent = '저장했어요.';
  setTimeout(() => { $('settingsMsg').textContent = ''; }, 2000);
}

function maskKey(k) {
  return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '';
}

function renderKey() {
  const has = !!settings.apiKey;
  $('keySaved').classList.toggle('hidden', !has);
  $('keyInput').classList.toggle('hidden', has);
  $('keyMasked').textContent = maskKey(settings.apiKey);
  $('apiKey').value = '';
  $('btnAnalyze').title = has ? '' : '설정 탭에서 API 키를 넣어 주세요.';
}

async function saveKey() {
  const k = $('apiKey').value.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) {
    $('settingsMsg').textContent = 'API 키 형식이 아니에요. sk-ant- 로 시작하는 키를 붙여 넣어 주세요.';
    return;
  }
  settings.apiKey = k;
  await chrome.storage.local.set({ settings });
  renderKey();
  $('settingsMsg').textContent = '키를 저장했어요.';
}

async function logout() {
  settings.apiKey = '';
  await chrome.storage.local.set({ settings });
  renderKey();
  $('settingsMsg').textContent = '키를 지웠어요. AI 교정을 쓰려면 키를 다시 넣어 주세요.';
}

function setProgress(msg) {
  $('progress').classList.toggle('hidden', !msg);
  $('progress').textContent = msg || '';
}
function setError(msg) {
  $('error').classList.toggle('hidden', !msg);
  $('error').textContent = msg || '';
}
function setBusy(busy) {
  for (const id of ['btnAnalyze', 'btnApply', 'btnApplySave', 'btnApplyNext']) $(id).disabled = busy;
  $('btnAuto').disabled = busy && !autoRunning;
}

async function getEditorTab() {
  const isEditor = (t) => /mypickebook\.org\/making\/make_book\.html/.test(t?.url || '');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isEditor(tab)) return tab;
  // 편집 화면이 팝업 창으로 열려 있으면 그 탭을 쓴다 (하나뿐일 때만)
  const all = (await chrome.tabs.query({})).filter(isEditor);
  if (all.length === 1) return all[0];
  throw new Error(all.length > 1
    ? '편집 화면이 여러 개 열려 있어요. 작업할 편집 화면 탭을 선택한 상태에서 눌러 주세요.'
    : '마이픽 편집 화면(make_book.html)을 열고 눌러 주세요.');
}

async function runInPage(tabId, func, args = []) {
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
  const key = `book:${bookIdx}`;
  const s = await chrome.storage.local.get(key);
  return s[key] || { pages: {}, toc: null };
}
async function putBook(bookIdx, book) {
  await chrome.storage.local.set({ [`book:${bookIdx}`]: book });
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

// ---------- 화면 상태 ----------
async function refreshStatus() {
  try {
    const tab = await getEditorTab();
    const info = await runInPage(tab.id, pageRead);
    const range = isNaN(info.minPage) ? '' : ` (배정 ${info.minPage}~${info.maxPage}쪽)`;
    $('pageStatus').textContent = `작업 쪽 ${info.currPage}${range} · 쪽 번호 칸 ${info.nonePage ? '없음' : (info.pageField || '비어 있음')} · 남은 시간 ${info.timeText || '?'}`;
    $('pageStatus').classList.remove('muted');
    const warnMin = settings.timeWarnMin;
    const low = info.remainingSec != null && warnMin > 0 && info.remainingSec < warnMin * 60;
    $('timeWarn').classList.toggle('hidden', !low);
    if (low) $('timeWarn').textContent = `남은 시간이 ${fmtTime(info.remainingSec)}이에요. 시간 안에 모든 쪽을 저장하고 직접 “제출하기”를 눌러야 봉사가 인정돼요.`;
    return { tab, info };
  } catch (e) {
    $('pageStatus').textContent = e.message;
    $('pageStatus').classList.add('muted');
    return null;
  }
}

// ---------- 교정 ----------
async function analyze() {
  setError('');
  const tab = await getEditorTab();
  if (!settings.apiKey) throw new Error('API 키가 없어요. 설정 탭에서 Claude API 키를 넣어 주세요.');
  abort = new AbortController();

  setProgress('편집 화면을 읽는 중…');
  const info = await runInPage(tab.id, pageRead);
  if (!info.editorFound) throw new Error('편집기를 찾지 못했어요. 페이지가 다 열렸는지 확인해 주세요.');
  if (!info.imgSrc) throw new Error('원본 이미지(#book_img)를 찾지 못했어요.');
  const ocrText = editorHtmlToText(info.ocrHtml);

  setProgress('원본 이미지를 가져오는 중…');
  const img = await runInPage(tab.id, pageFetchImage, [info.imgSrc]);
  if (!img?.ok) throw new Error('원본 이미지를 가져오지 못했어요: ' + (img?.error || ''));
  const imageDataUrl = await downscaleImage(img.dataUrl, 2400);

  const book = await getBook(info.bookIdx);
  if (settings.useToc && !book.toc) {
    setProgress('목차를 가져오는 중…');
    const toc = await runInPage(tab.id, pageFetchToc, [info.bookIdx]);
    if (toc?.ok && toc.text) {
      book.toc = toc.text;
      await putBook(info.bookIdx, book);
    }
  }

  const prev = book.pages[info.currPage - 1];
  const ctx = {
    bookInfo: info.bookInfo,
    tip: info.tipText + (info.tipImages?.length ? '\n(제작 Tip에 이미지가 있어요. 이미지 내용은 볼 수 없으니 관련 판단이 필요하면 flags에 적으세요.)' : ''),
    toc: settings.useToc ? book.toc : '',
    headingsSoFar: headingsSoFar(book, info.currPage),
    prevTail: prev ? prev.text.slice(-600) : '',
    currPage: info.currPage,
    pageField: info.nonePage ? '페이지번호 없음' : info.pageField,
    pageTotal: isNaN(info.minPage) ? '' : `${info.minPage}~${info.maxPage}쪽`,
    ocrText,
    dashSpacing: settings.dashSpacing,
  };

  let cost = 0;
  setProgress('Claude가 원본을 보고 작성하는 중… (30초~2분)');
  const r1 = await callClaude({
    apiKey: settings.apiKey, model: settings.model, effort: settings.effort,
    imageDataUrl, userText: buildWriteMessage(ctx), signal: abort.signal,
  });
  cost += estimateCostUsd(settings.model, r1.usage);
  let result = r1.result;
  const ruleOpts = () => ({ dashSpacing: settings.dashSpacing, unitSymbols: settings.unitSymbols, allowBlankLines: !!result.has_poem_or_quote });
  let checked = applyRules(result.text, ruleOpts());

  if (settings.verify) {
    const diffs = disagreements(ocrText, checked.text);
    setProgress(`OCR과 다른 ${diffs.length}곳을 원본으로 다시 확인하는 중…`);
    const r2 = await callClaude({
      apiKey: settings.apiKey, model: settings.model, effort: settings.effort,
      imageDataUrl, userText: buildVerifyMessage(ctx, { text: checked.text }, diffs), signal: abort.signal,
    });
    cost += estimateCostUsd(settings.model, r2.usage);
    const firstFlags = result.flags || [];
    const firstNotes = result.notes || '';
    result = r2.result;
    // 1차에서 나온 확인 항목도 남긴다 (중복 제거)
    const seen = new Set((result.flags || []).map((f) => f.message));
    result.flags = [...(result.flags || []), ...firstFlags.filter((f) => !seen.has(f.message))];
    result.notes = [firstNotes, result.notes].filter(Boolean).join('\n');
    checked = applyRules(result.text, ruleOpts());
  }
  sessionCost += cost;

  current = { tabId: tab.id, info, ocrText, result, checked, cost };
  render();
  setProgress('');
  return current;
}

function decidePageNumber(info, result) {
  if (result.is_blank_page) {
    // 빈 면: 쪽 번호가 없어도 앞뒤로 유추해 넣는다
    return { value: info.pageField || '', none: false, note: '빈 면이에요. 쪽 번호는 앞뒤 쪽으로 유추해 넣어야 해요.' };
  }
  const printed = String(result.page_number || '').trim();
  if (!printed) {
    return { value: info.pageField || '', none: info.nonePage, note: '원본에 인쇄된 쪽 번호를 찾지 못했어요. 앞뒤 쪽을 보고 확인해 주세요.' };
  }
  if (info.pageField && info.pageField !== printed) {
    return { value: printed, none: false, note: `쪽 번호 칸은 ${info.pageField}이었는데 원본에는 ${printed}로 인쇄돼 있어요.` };
  }
  return { value: printed, none: false, note: '' };
}

function render() {
  const { info, result, checked, ocrText } = current;
  $('result').classList.remove('hidden');
  const pn = decidePageNumber(info, result);
  $('pageNum').value = pn.value;
  $('nonePage').checked = pn.none;
  $('pageNumNote').textContent = pn.note;
  $('output').value = checked.text;
  current.pageNote = pn.note;

  const flags = $('flags');
  flags.innerHTML = '';
  const items = [
    ...(result.flags || []).map((f) => ({ cls: f.needs_review ? 'review' : 'warn', text: `${kindLabel(f.kind)} ${f.message}` })),
    ...checked.warnings.map((w) => ({ cls: 'warn', text: `[규칙] ${w.message}` })),
  ];
  if (pn.note) items.unshift({ cls: 'review', text: `[쪽 번호] ${pn.note}` });
  if (!items.length) items.push({ cls: 'ok', text: '확인할 것이 없어요.' });
  for (const it of items) {
    const li = document.createElement('li');
    li.className = it.cls;
    li.textContent = it.text;
    flags.appendChild(li);
  }

  $('notes').textContent = result.notes || '';
  const ch = $('changes');
  ch.innerHTML = '';
  for (const c of checked.changes) {
    const li = document.createElement('li');
    li.textContent = `[규칙] ${c.rule} ${c.count}곳${c.examples.length ? ` (예: ${c.examples.slice(0, 2).join(', ')})` : ''}`;
    ch.appendChild(li);
  }

  renderDiff(ocrText, checked.text);
  updateLiveWarn();
  const krw = Math.round(current.cost * 1450);
  $('cost').textContent = `이 쪽 비용 약 $${current.cost.toFixed(3)} (약 ${krw}원) · 이번 세션 합계 약 $${sessionCost.toFixed(2)}`;
}

function kindLabel(kind) {
  return {
    visual: '[시각자료]', footnote: '[주석]', heading: '[제목 단계]', uncertain_text: '[불확실한 글자]', layout: '[배치]', other: '[기타]',
  }[kind] || '[확인]';
}

function renderDiff(a, b) {
  const box = $('diff');
  box.innerHTML = '';
  for (const part of diffWords(a, b)) {
    const el = part.type === 'same' ? document.createElement('span') : document.createElement(part.type === 'add' ? 'ins' : 'del');
    el.textContent = part.text + (part.text.endsWith('\n') ? '' : ' ');
    box.appendChild(el);
  }
}

function updateLiveWarn() {
  const text = $('output').value;
  const msgs = [];
  if (/[<>]/.test(text)) msgs.push('자판 < > 가 있어요. 사이트가 저장을 막아요(〈 〉 또는 ＜ ＞ 사용).');
  if (/chrome-extension|<script/i.test(text)) msgs.push('사이트가 막는 문자열이 있어요.');
  if (/^\s*\n|\n\s*$/.test(text)) msgs.push('첫 줄이나 마지막 줄이 빈 줄이에요.');
  $('liveWarn').textContent = msgs.join(' ');
  return msgs;
}

function needsStop() {
  if (!current) return '결과가 없어요.';
  const reasons = [];
  if ((current.result.flags || []).some((f) => f.needs_review)) reasons.push('확인할 항목이 있어요');
  if (current.pageNote) reasons.push('쪽 번호 확인이 필요해요');
  if (settings.stopOnWarnings && current.checked.warnings.length) reasons.push('규칙 경고가 있어요');
  return reasons.join(', ');
}

// ---------- 넣기 / 저장 ----------
async function applyToEditor() {
  const text = $('output').value.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (updateLiveWarn().some((m) => m.includes('< >') || m.includes('막는'))) {
    throw new Error('사이트가 막는 문자가 있어 넣지 않았어요. 결과를 고친 뒤 다시 눌러 주세요.');
  }
  const tab = await getEditorTab();
  if (current && tab.id !== current.tabId) throw new Error('교정한 탭과 지금 탭이 달라요.');
  const info = await runInPage(tab.id, pageRead);
  if (current && info.currPage !== current.info.currPage) throw new Error(`교정한 쪽(${current.info.currPage})과 지금 쪽(${info.currPage})이 달라요. 다시 교정해 주세요.`);
  const nonePage = $('nonePage').checked;
  const pageNum = $('pageNum').value.trim();
  if (!nonePage && !/^\d{1,4}$/.test(pageNum)) throw new Error('쪽 번호는 숫자 1~4자리로 넣어 주세요(로마숫자 쪽은 직접 입력).');
  const r = await runInPage(tab.id, pageApply, [textToEditorData(text), pageNum, nonePage]);
  if (!r?.ok) throw new Error('편집기에 넣지 못했어요: ' + (r?.error || ''));

  // 다음 쪽 작성에 참고하도록 기록
  const book = await getBook(info.bookIdx);
  book.pages[info.currPage] = { text, pageNumber: nonePage ? '' : pageNum, at: Date.now() };
  await putBook(info.bookIdx, book);
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

async function save(mode) {
  const { tab, info } = await applyToEditor();
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
    r = { ok: true, navigating: true }; // 이동하면서 스크립트가 끊긴 경우
  }
  if (r && r.ok === false) throw new Error('저장 실패: ' + (r.error || ''));
  await loaded;
  await waitForEditor(tab.id, expected);
  return { moved: true, info };
}

// ---------- 자동 모드 ----------
async function autoLoop() {
  autoRunning = true;
  $('btnAuto').textContent = '자동 모드 멈추기';
  $('btnAuto').classList.add('danger');
  try {
    while (autoRunning) {
      const st = await refreshStatus();
      if (!st) throw new Error('편집 화면을 찾지 못했어요.');
      if (st.info.remainingSec != null && settings.timeWarnMin > 0 && st.info.remainingSec < settings.timeWarnMin * 60) {
        throw new Error(`남은 시간이 ${fmtTime(st.info.remainingSec)}이라 자동 모드를 멈췄어요. 남은 쪽을 확인하고 직접 제출해 주세요.`);
      }
      await analyze();
      if (!autoRunning) break;
      const stop = needsStop();
      if (stop) {
        setProgress(`${current.info.currPage}쪽에서 멈췄어요: ${stop}. 확인 후 “넣고 저장 후 다음 쪽”을 누르고 자동 모드를 다시 시작하세요.`);
        break;
      }
      setProgress(`${current.info.currPage}쪽 저장 후 다음 쪽으로…`);
      const r = await save('next');
      if (!r.moved) {
        setProgress(`마지막 쪽(${r.info.currPage}쪽)까지 저장했어요. 모든 쪽을 확인한 뒤 “제출하기”를 직접 눌러 주세요.`);
        break;
      }
      $('result').classList.add('hidden');
    }
  } finally {
    autoRunning = false;
    $('btnAuto').textContent = '자동 모드 시작';
    $('btnAuto').classList.remove('danger');
    await refreshStatus();
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

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
}));

$('btnAnalyze').addEventListener('click', guard(analyze));
$('btnApply').addEventListener('click', guard(async () => { await applyToEditor(); setProgress('편집기에 넣었어요. 저장은 아직 안 했어요.'); }));
$('btnApplySave').addEventListener('click', guard(async () => {
  const r = await save('temp');
  setProgress(r.last ? '임시저장했어요. 마지막 쪽이에요. 모든 쪽 확인 후 “제출하기”를 직접 눌러 주세요.' : '임시저장했어요.');
}));
$('btnApplyNext').addEventListener('click', guard(async () => {
  const r = await save('next');
  $('result').classList.add('hidden');
  setProgress(r.moved ? `${r.info.currPage}쪽을 저장하고 다음 쪽으로 넘어갔어요.` : '마지막 쪽이라 임시저장만 했어요. 직접 “제출하기”를 눌러 주세요.');
}));
$('btnAuto').addEventListener('click', async () => {
  if (autoRunning) {
    autoRunning = false;
    abort?.abort();
    setProgress('자동 모드를 멈췄어요.');
    return;
  }
  setError('');
  setBusy(true);
  try {
    await autoLoop();
  } catch (e) {
    if (e.name !== 'AbortError') setError(e.message || String(e));
  } finally {
    setBusy(false);
  }
});
$('output').addEventListener('input', updateLiveWarn);
$('btnSaveSettings').addEventListener('click', saveSettings);
$('btnSaveKey').addEventListener('click', saveKey);
$('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
$('btnLogout').addEventListener('click', logout);
$('btnClearBook').addEventListener('click', guard(async () => {
  const tab = await getEditorTab();
  const info = await runInPage(tab.id, pageRead);
  await chrome.storage.local.remove(`book:${info.bookIdx}`);
  $('settingsMsg').textContent = '이 책의 작업 기록(이전 쪽 내용, 목차)을 지웠어요.';
}));

chrome.tabs.onActivated.addListener(() => refreshStatus());
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'complete' && !autoRunning) refreshStatus(); });
setInterval(() => { if (!autoRunning) refreshStatus(); }, 15000);

(async () => {
  await loadSettings();
  fillSettingsForm();
  if (!settings.apiKey) {
    document.querySelector('.tab[data-tab="settings"]').click();
    $('settingsMsg').textContent = '처음이시면 API 키를 넣고 저장해 주세요.';
  }
  refreshStatus();
})();
