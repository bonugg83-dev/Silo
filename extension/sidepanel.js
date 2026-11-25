import { applyRules } from './lib/rules.js';
import { diffWords, disagreements } from './lib/diff.js';
import {
  buildWriteMessage, buildVerifyMessage, buildTocMessage, TOC_SYSTEM_PROMPT, TOC_SCHEMA, VERIFY_SCHEMA,
} from './lib/prompt.js';
import { callClaude, estimateCostUsd, MODELS } from './lib/claude.js';
import {
  pageRead, pageFetchImage, pageFetchToc, pageFetchOriginal, pageUploadCrop, pageApply, pageSave, pageGoto,
} from './lib/page.js';
import { findLinks, putNoteAtMarker, removeNoteLine } from './lib/footnotes.js';
import { editorHtmlToText, downscaleImage } from './lib/convert.js';
import { applyFixes } from './lib/fixes.js';
import {
  parseVisualBlocks, buildEditorData, existingFigures, cropImage, IMAGE_KINDS,
} from './lib/visuals.js';

const $ = (id) => document.getElementById(id);
const TOC_VERSION = 2;

const DEFAULT_SETTINGS = {
  keys: [], // [{id, name, key}]
  activeKeyId: '',
  model: 'claude-opus-5-5',
  effort: 'high',
  verify: true,
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
let abort = null;
// 오늘 쓴 비용 (설정 탭에 합계)
async function addCost(usd) {
  if (!usd) return;
  const key = `cost:${new Date().toLocaleDateString('sv')}`;
  const r = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: (r[key] || 0) + usd });
  showTodayCost();
}
async function showTodayCost() {
  const key = `cost:${new Date().toLocaleDateString('sv')}`;
  const usd = (await chrome.storage.local.get(key))[key] || 0;
  $('todayCost').textContent = `오늘 쓴 비용 약 $${usd.toFixed(2)} (약 ${Math.round(usd * 1450).toLocaleString()}원)`;
}
let editing = false;

// ---------- 설정 ----------
async function loadSettings() {
  const s = await chrome.storage.local.get('settings');
  const raw = s.settings || {};
  settings = { ...DEFAULT_SETTINGS, ...raw };
  // 예전 버전: 키 하나(apiKey) → 이름 붙은 키 목록
  if (raw.apiKey && !(raw.keys && raw.keys.length)) {
    const id = crypto.randomUUID();
    settings.keys = [{ id, name: '내 키', key: raw.apiKey }];
    settings.activeKeyId = id;
  }
  delete settings.apiKey;
  // 화면에서 뺀 설정은 기본값으로 고정
  Object.assign(settings, { effort: 'high', useToc: true, imageMax: 2000, unitSymbols: true, runThrough: true, timeWarnMin: 0 });
  if (!settings.keys.find((k) => k.id === settings.activeKeyId)) settings.activeKeyId = settings.keys[0]?.id || '';
  await chrome.storage.local.set({ settings });
}
async function persist() {
  await chrome.storage.local.set({ settings });
}
function activeKey() {
  return settings.keys.find((k) => k.id === settings.activeKeyId)?.key || '';
}
const maskKey = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');

function renderKeys() {
  const box = $('keyList');
  box.innerHTML = '';
  if (!settings.keys.length) {
    box.innerHTML = '<p class="small muted">저장된 키가 없어요. 아래에서 추가하세요.</p>';
  }
  for (const k of settings.keys) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activeKey';
    radio.checked = k.id === settings.activeKeyId;
    radio.title = '이 키 사용';
    radio.addEventListener('change', async () => { settings.activeKeyId = k.id; await persist(); msg('settingsMsg', `“${k.name}”을 사용해요.`); });
    const name = document.createElement('input');
    name.type = 'text';
    name.value = k.name;
    name.title = '이름을 바꾸려면 고치고 다른 곳을 누르세요';
    name.addEventListener('change', async () => { k.name = name.value.trim() || '이름 없음'; await persist(); msg('settingsMsg', '이름을 바꿨어요.'); });
    const code = document.createElement('code');
    code.textContent = maskKey(k.key);
    const del = document.createElement('button');
    del.className = 'small-btn';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      if (!confirm(`“${k.name}” 키를 삭제할까요?`)) return;
      settings.keys = settings.keys.filter((x) => x.id !== k.id);
      if (settings.activeKeyId === k.id) settings.activeKeyId = settings.keys[0]?.id || '';
      await persist();
      renderKeys();
      msg('settingsMsg', '키를 삭제했어요.');
    });
    row.append(radio, name, code, del);
    box.appendChild(row);
  }
}

async function addKey() {
  const name = $('newKeyName').value.trim() || `키 ${settings.keys.length + 1}`;
  const key = $('newKeyValue').value.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) { msg('settingsMsg', 'API 키 형식이 아니에요. sk-ant- 로 시작하는 키를 붙여 넣어 주세요.'); return; }
  const id = crypto.randomUUID();
  settings.keys.push({ id, name, key });
  settings.activeKeyId = id;
  await persist();
  $('newKeyName').value = '';
  $('newKeyValue').value = '';
  renderKeys();
  msg('settingsMsg', `“${name}”을 저장하고 사용 키로 골랐어요.`);
}

const ADV_FIELDS = {
  verify: 'checked', dashSpacing: 'value', autoVisuals: 'checked', pacing: 'checked', paceMinSec: 'value', paceMaxSec: 'value',
};
function fillForms() {
  const sel = $('model');
  sel.innerHTML = '';
  for (const m of MODELS) sel.add(new Option(m.label, m.id));
  sel.value = settings.model;
  for (const [id, prop] of Object.entries(ADV_FIELDS)) $(id)[prop] = settings[id];
  renderKeys();
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
function setBusy(busy) {
  for (const id of ['btnAnalyze', 'btnApply', 'btnReviewed']) $(id).disabled = busy;
  $('btnAuto').disabled = busy && !autoRunning;
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
  const key = `book:${bookIdx}`;
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
let lastStatusError = '';
async function refreshStatus() {
  try {
    const tab = await getEditorTab();
    const info = await runInPage(tab.id, pageRead);
    const book = await getBook(info.bookIdx);
    showTocState(book);
    updateReviewBadge(book);
    lastStatusError = '';
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
  if (!settings.useToc || book.toc || book.tocError) return; // 실패했으면 “다시 읽기” 전까지 다시 시도하지 않음
  setProgress('목차 이미지를 가져오는 중… (책마다 처음 한 번)');
  try {
    const toc = await runInPage(tab.id, pageFetchToc, [info.bookIdx]);
    if (!toc?.ok) throw new Error(toc?.error || '목차 페이지를 열지 못함');
    if (!toc.images?.length) throw new Error('목차 이미지가 없음');
    setProgress(`Claude가 목차 ${toc.images.length}쪽을 읽고 단계를 정리하는 중…`);
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
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    book.tocError = e.message || String(e);
  }
  await putBook(info.bookIdx, book);
  showTocState(book);
}

// ---------- 교정 ----------
async function analyze() {
  setError('');
  if (!$('reviewBox').classList.contains('hidden')) await showReview(false);
  const tab = await getEditorTab();
  if (!activeKey()) throw new Error('API 키가 없어요. 설정 탭에서 Claude API 키를 추가해 주세요.');
  abort = new AbortController();
  editing = false;

  setProgress('편집 화면을 읽는 중…');
  const info = await runInPage(tab.id, pageRead);
  if (!info.editorFound) throw new Error('편집기를 찾지 못했어요. 페이지가 다 열렸는지 확인해 주세요.');
  if (!info.imgSrc) throw new Error('원본 이미지(#book_img)를 찾지 못했어요.');
  const ocrText = editorHtmlToText(info.ocrHtml);

  setProgress('원본 이미지를 가져오는 중…');
  const img = await runInPage(tab.id, pageFetchImage, [info.imgSrc]);
  if (!img?.ok) throw new Error('원본 이미지를 가져오지 못했어요: ' + (img?.error || ''));
  const sent = await downscaleImage(img.dataUrl, settings.imageMax);

  const book = await getBook(info.bookIdx);
  await ensureToc(tab, info, book, abort.signal);

  const prev = book.pages[info.currPage - 1];
  const linked = new Set((book.links || []).map((l) => `${l.from}:${l.label}`));
  const pendingFootnotes = [info.currPage - 2, info.currPage - 1]
    .flatMap((p) => (book.pages[p]?.footMissing || []).filter((l) => !linked.has(`${p}:${l}`)).map((l) => `${p}쪽 [${l}]`))
    .join(', ');
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
    pendingFootnotes,
    imageWidth: sent.width,
    imageHeight: sent.height,
  };
  const call = (extra) => callClaude({
    apiKey: activeKey(), model: settings.model, effort: settings.effort,
    imageDataUrl: sent.dataUrl, signal: abort.signal, ...extra,
  });

  let cost = 0;
  setProgress('Claude가 원본을 보고 작성하는 중… (30초~2분)');
  const r1 = await call({ userText: buildWriteMessage(ctx) });
  cost += estimateCostUsd(settings.model, r1.usage);
  const result = r1.result;
  const ruleOpts = { dashSpacing: settings.dashSpacing, unitSymbols: settings.unitSymbols, allowBlankLines: !!result.has_poem_or_quote };
  let checked = applyRules(result.text, ruleOpts);
  const extraFlags = [];
  let verifyNote = '';

  if (settings.verify) {
    const diffs = disagreements(ocrText, checked.text);
    if (diffs.length) {
      setProgress(`OCR과 다른 ${diffs.length}곳을 원본으로 다시 확인하는 중…`);
      const r2 = await call({ userText: buildVerifyMessage(ctx, checked.text, diffs), schema: VERIFY_SCHEMA });
      cost += estimateCostUsd(settings.model, r2.usage);
      const fx = applyFixes(checked.text, r2.result.fixes);
      for (const f of fx.failed) {
        extraFlags.push({ kind: 'uncertain_text', needs_review: true, quote: f.fix.find,
          message: `2차 검증 수정 못 함: “${f.fix.find}” → “${f.fix.replace}”` });
      }
      for (const f of r2.result.flags || []) extraFlags.push(f);
      verifyNote = fx.applied.length
        ? `2차 검증에서 ${fx.applied.length}곳 고침:\n${fx.applied.map((f) => `· ${f.find} → ${f.replace} (${f.reason})`).join('\n')}`
        : '2차 검증: 고칠 곳 없음';
      checked = applyRules(fx.text, ruleOpts);
    } else {
      verifyNote = '2차 검증: OCR과 다른 곳이 없어 건너뜀';
    }
  }
  addCost(cost);

  // 다른 쪽에 걸친 각주
  const footMissing = (result.footnotes_without_note || []).map((f) => f.label).filter(Boolean);
  const footOrphans = (result.notes_without_marker || []).filter((f) => f.label);
  for (const l of footMissing) {
    extraFlags.push({ kind: 'footnote', needs_review: true, quote: `[${l}]`,
      message: `${l} 설명이 이 쪽에 없음 (다음 쪽에 있으면 검수에서 연결)` });
  }
  for (const o of footOrphans) {
    extraFlags.push({ kind: 'footnote', needs_review: true, quote: `[${o.label}:`,
      message: `앞쪽 ${o.label}의 설명 (검수에서 앞쪽으로 옮김)` });
  }

  // 시각자료
  const visuals = await prepareVisuals(tab, info, checked.text, result.visuals || [], sent);

  current = {
    tabId: tab.id, info, ocrText, result, cost, sentImage: sent,
    text: checked.text, ruleChanges: checked.changes, ruleWarnings: checked.warnings,
    flags: [...(result.flags || []), ...extraFlags], notes: [result.notes, verifyNote].filter(Boolean).join('\n'),
    visuals, book, footMissing, footOrphans,
  };
  current.page = decidePageNumber(info, result, book);
  render();
  setProgress('');
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
  setProgress('시각자료를 자르는 중…');
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
  return { value: guess, none: false, note: `쪽 번호 추정 (${guess})`, guessed: true };
}

// ---------- 화면 그리기 ----------
const KIND_LABEL = { visual: '[시각자료]', footnote: '[주석]', heading: '[제목 단계]', uncertain_text: '[불확실한 글자]', layout: '[배치]', other: '[기타]' };
const PAGE_KIND = { chapter_cover: '장 표지', visual_only: '사진·그림만 있는 쪽', blank: '빈 면', toc: '차례', endnotes: '미주 설명', index_ad: '색인·광고' };

function allIssues() {
  const items = [];
  const c = current;
  if (c.storedIssues) {
    items.push(...c.storedIssues);
    c.visuals.forEach((v, i) => { if (v.include && v.error) items.push({ cls: 'review', text: `[그림 ${i + 1}] ${v.error}`, quote: '' }); });
    return items;
  }
  if (c.page.note) items.push({ cls: 'review', text: c.page.note, quote: '' });
  if (PAGE_KIND[c.result.page_kind]) {
    items.push({ cls: 'review', text: `[특수한 쪽] ${PAGE_KIND[c.result.page_kind]}`, quote: '' });
  }
  for (const f of c.flags) items.push({ cls: f.needs_review ? 'review' : 'warn', text: `${KIND_LABEL[f.kind] || '[확인]'} ${f.message}`, quote: f.quote || '' });
  for (const w of c.ruleWarnings) items.push({ cls: 'warn', text: `[규칙] ${w.message}`, quote: w.quote || '' });
  c.visuals.forEach((v, i) => { if (v.include && v.error) items.push({ cls: 'review', text: `[그림 ${i + 1}] ${v.error}`, quote: '' }); });
  return items;
}

function render() {
  const c = current;
  $('result').classList.remove('hidden');
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
  $('tgChanges').disabled = false;
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
      parent.append(document.createTextNode(text.slice(pos, at)));
      parent.append(visualThumb(i));
      pos = at;
    }
    parent.append(document.createTextNode(text.slice(pos, to)));
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

function setEditMode(on) {
  editing = on;
  $('output').classList.toggle('hidden', !on);
  $('outputView').classList.toggle('hidden', on);
  $('btnToggleEdit').textContent = on ? '표시 보기' : '직접 고치기';
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

/** 이번 쪽에 머물 시간(초): 최소~최대 사이 무작위 */
function pickPaceSec() {
  if (!settings.pacing) return 0;
  const lo = Number(settings.paceMinSec) || 0;
  const hi = Math.max(lo, Number(settings.paceMaxSec) || 0);
  return lo + Math.random() * (hi - lo);
}
/** 쪽을 연 때부터 targetSec가 지날 때까지 기다린다. 자동 모드를 멈추면 false */
async function waitPace(openedAt, targetSec, page) {
  while (autoRunning) {
    const left = Math.ceil(targetSec - (Date.now() - openedAt) / 1000);
    if (left <= 0) return true;
    setProgress(`${page}쪽 끝. 다음 쪽까지 ${left}초`);
    await new Promise((r) => setTimeout(r, Math.min(1000, left * 1000)));
  }
  return false;
}
async function autoLoop() {
  autoRunning = true;
  $('btnAuto').textContent = '멈추기';
  $('btnAuto').classList.add('danger');
  try {
    $('reviewBox').classList.add('hidden');
    while (autoRunning) {
      const openedAt = Date.now();
      const paceSec = pickPaceSec();
      const st = await refreshStatus();
      if (!st) throw new Error(lastStatusError || '편집 화면을 찾지 못했어요.');
      await analyze();
      if (!autoRunning) break;
      const stop = needsStop();
      if (stop) {
        setProgress(`${current.info.currPage}쪽에서 멈췄어요: ${stop}`);
        break;
      }
      if (!(await waitPace(openedAt, paceSec, current.info.currPage))) break;
      setProgress(`${current.info.currPage}쪽 저장 후 다음 쪽으로…`);
      const r = await save('next', { reviewed: false });
      if (!r.moved) {
        setProgress(`마지막 쪽(${r.info.currPage}쪽)까지 저장했어요.`);
        $('result').classList.add('hidden');
        await showReview(true);
        break;
      }
      $('result').classList.add('hidden');
    }
  } finally {
    autoRunning = false;
    $('btnAuto').textContent = '자동 모드';
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
$('btnApply').addEventListener('click', guard(async () => { await applyToEditor(); setProgress('편집기에 넣었어요.'); }));
$('btnReviewed').addEventListener('click', guard(markReviewed));
document.querySelectorAll('.toggle').forEach((b) => b.addEventListener('click', () => {
  const panel = $(b.dataset.panel);
  const on = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !on);
  b.classList.toggle('on', on);
}));
$('btnAdvanced').addEventListener('click', () => $('advancedBox').classList.toggle('hidden'));
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
$('btnToggleEdit').addEventListener('click', () => {
  if (!current) return;
  if (editing) {
    current.text = $('output').value;
    renderOutputView();
  }
  setEditMode(!editing);
});
$('output').addEventListener('input', () => { if (current) { current.text = $('output').value; updateLiveWarn(); } });

$('btnAddKey').addEventListener('click', addKey);
$('newKeyValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKey(); });
$('model').addEventListener('change', async () => { settings.model = $('model').value; await persist(); msg('settingsMsg', '모델을 바꿨어요.'); });
$('btnSaveAdvanced').addEventListener('click', saveAdvanced);
$('btnClearBook').addEventListener('click', guard(async () => {
  const tab = await getEditorTab();
  const info = await runInPage(tab.id, pageRead);
  await chrome.storage.local.remove(`book:${info.bookIdx}`);
  msg('advancedMsg', '이 책의 작업 기록(이전 쪽 내용, 목차)을 지웠어요.');
}));

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
  await putBook(info.bookIdx, book);
  $('tocText').value = '';
  showTocState(book);
  if (!activeKey()) throw new Error('API 키가 없어요. 설정 탭에서 추가해 주세요.');
  abort = new AbortController();
  const tab = await getEditorTab();
  await ensureToc(tab, info, book, abort.signal);
  setProgress(book.toc ? '목차를 다시 읽었어요. “이 책 목차”에서 확인하세요.' : '');
  if (!book.toc && book.tocError) throw new Error(`목차를 읽지 못했어요: ${book.tocError}`);
}
$('btnRebuildToc').addEventListener('click', guard(rebuildToc));
$('btnTocRetry').addEventListener('click', guard(rebuildToc));

// ---------- 검수 (끝까지 한 뒤 한 번에 확인) ----------
let reviewShowAll = false;
function reviewItems(book) {
  return Object.keys(book.pages).map(Number).sort((a, b) => a - b)
    .map((n) => ({ n, rec: book.pages[n] }))
    .filter(({ rec }) => (rec.issues || []).length);
}
function updateReviewBadge(book) {
  const left = reviewItems(book).filter(({ rec }) => !rec.reviewed).length
    + (book.links || []).filter((l) => !l.done).length;
  $('reviewBadge').textContent = String(left);
  $('btnReview').classList.toggle('hidden', !left && $('reviewBox').classList.contains('hidden'));
}

async function renderReview() {
  let tab;
  let info;
  try {
    tab = await getEditorTab();
    info = await runInPage(tab.id, pageRead);
  } catch (e) {
    $('reviewSummary').textContent = e.message;
    return;
  }
  const book = await getBook(info.bookIdx);
  updateReviewBadge(book);
  const items = reviewItems(book);
  const todo = items.filter(({ rec }) => !rec.reviewed);
  const links = (book.links || []).filter((l) => !l.done);
  const doneCount = Object.keys(book.pages).length;
  $('reviewSummary').textContent = todo.length || links.length
    ? `${doneCount}쪽 중 확인할 쪽 ${todo.length}개${links.length ? `, 옮길 각주 ${links.length}개` : ''}`
    : `${doneCount}쪽 모두 확인했어요. 제출하기는 직접 눌러 주세요.`;

  $('reviewLinksBox').classList.toggle('hidden', !links.length);
  const lb = $('reviewLinks');
  lb.innerHTML = '';
  for (const link of links) {
    const row = document.createElement('div');
    row.className = 'rv-link';
    const t = document.createElement('div');
    t.className = 'small';
    t.textContent = `${link.from}쪽 [${link.label}] ← ${link.to}쪽 맨 위 설명`;
    const note = document.createElement('div');
    note.className = 'small note';
    note.textContent = link.note.length > 120 ? `${link.note.slice(0, 120)}…` : link.note;
    const btn = document.createElement('button');
    btn.className = 'small-btn';
    btn.textContent = '반영';
    btn.addEventListener('click', guard(async () => { await applyLink(link); await renderReview(); }));
    row.append(t, note, btn);
    if (link.error) {
      const er = document.createElement('div');
      er.className = 'small';
      er.style.color = 'var(--err)';
      er.textContent = link.error;
      row.append(er);
    }
    lb.appendChild(row);
  }

  const box = $('reviewPages');
  box.innerHTML = '';
  for (const { n, rec } of (reviewShowAll ? items : todo)) {
    const card = document.createElement('div');
    card.className = `rv-page${rec.reviewed ? ' done' : ''}`;
    const h = document.createElement('h3');
    h.textContent = `${n}쪽${rec.pageNumber ? ` (쪽 번호 ${rec.pageNumber})` : ''}${rec.reviewed ? ' · 확인함' : ''}`;
    const ul = document.createElement('ul');
    ul.className = 'small';
    for (const it of rec.issues) {
      const li = document.createElement('li');
      li.className = it.cls;
      li.textContent = it.text;
      ul.appendChild(li);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const open = document.createElement('button');
    open.className = 'small-btn primary';
    open.textContent = '이 쪽 열기';
    open.addEventListener('click', guard(() => openPageForReview(n)));
    const ok = document.createElement('button');
    ok.className = 'small-btn';
    ok.textContent = rec.reviewed ? '다시 확인할 것으로' : '확인함';
    ok.addEventListener('click', async () => {
      const b = await getBook(info.bookIdx);
      b.pages[n].reviewed = !b.pages[n].reviewed;
      await putBook(info.bookIdx, b);
      renderReview();
    });
    row.append(open, ok);
    card.append(h, ul, row);
    box.appendChild(card);
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
  if (autoRunning) throw new Error('자동 모드를 멈춘 뒤에 열어 주세요.');
  const tab = await getEditorTab();
  setProgress(`${n}쪽으로 가는 중…`);
  const info = await gotoPage(tab, n);
  const book = await getBook(info.bookIdx);
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
  document.querySelector('.tab[data-tab="work"]').click();
  await showReview(false);
  render();
  setProgress(`${n}쪽을 열었어요.`);
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

async function applyLink(link) {
  if (autoRunning) throw new Error('자동 모드를 멈춘 뒤에 반영해 주세요.');
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

$('btnReviewShowAll').addEventListener('click', () => {
  reviewShowAll = !reviewShowAll;
  $('btnReviewShowAll').textContent = reviewShowAll ? '확인할 쪽만 보기' : '확인한 쪽도 보기';
  renderReview();
});
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
$('btnReview').addEventListener('click', () => showReview($('reviewBox').classList.contains('hidden')));
async function showReview(on) {
  $('reviewBox').classList.toggle('hidden', !on);
  $('btnReview').classList.toggle('on', on);
  if (on) await renderReview();
}

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
  $('result').classList.add('hidden');
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

chrome.tabs.onActivated.addListener(() => refreshStatus());
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'complete' && !autoRunning) refreshStatus(); });
setInterval(() => { if (!autoRunning) refreshStatus(); }, 15000);

(async () => {
  await loadSettings();
  fillForms();
  showTodayCost();
  if (!activeKey()) {
    document.querySelector('.tab[data-tab="settings"]').click();
    msg('settingsMsg', '처음이시면 API 키를 추가해 주세요.');
  }
  refreshStatus();
})();
