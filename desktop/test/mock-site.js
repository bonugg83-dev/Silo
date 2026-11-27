// 테스트 전용: 마이픽 사이트와 Claude API를 가짜로 응답한다 (SILO_MOCK 일 때만 main.js 가 불러옴)
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const FIX = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const mockHtml = fs.readFileSync(path.join(FIX, 'mock_make_book.html'), 'utf8');
const pageImg = fs.readFileSync(path.join(FIX, 'page.jpg'));
const originalImg = fs.readFileSync(path.join(FIX, 'original.png'));
const S = (globalThis.__mock = { saves: [], uploads: [], apiCalls: [] });

// SILO_MOCK_FOOTNOTES=1: Gemini처럼 쪽을 넘는 각주 — 152쪽엔 번호만 [각주***], 153쪽 맨 위엔 새 번호로 [각주*: 설명],
// 모델은 footnotes_without_note·notes_without_marker 를 비워 둠
const GEMINI_FOOTNOTES = !!process.env.SILO_MOCK_FOOTNOTES;
// 테스트 화면용: SILO_MOCK_FOOTNOTES=3,4 처럼 쪽을 주면 그 두 쪽에서 (번호가 같은 [각주***])
const [FN_A, FN_B] = /^\d+,\d+$/.test(process.env.SILO_MOCK_FOOTNOTES || '') ? process.env.SILO_MOCK_FOOTNOTES.split(',').map(Number) : [];
function resultFor(page) {
  const base = { page_number: String(page), page_kind: 'body', is_blank_page: false, has_poem_or_quote: false, visuals: [], flags: [], notes: '', footnotes_without_note: [], notes_without_marker: [] };
  if (FN_A && page === FN_A) return { ...base, text: `본문 ${page} ‘스메타나’[각주***]에 대한 대사`, footnotes_without_note: [{ label: '각주***' }] };
  if (FN_A && page === FN_B) return { ...base, text: `[각주***: 이러한 설정은 연출적 장치로 해석할 수 있다.]\n본문 ${page}`, notes_without_marker: [{ label: '각주***', note: '이러한 설정은 연출적 장치로 해석할 수 있다.' }] };
  if (FN_A) return { ...base, text: `본문 ${page}` };
  if (GEMINI_FOOTNOTES && page === 152) {
    return { text: '@@{152쪽 제목\n본문 152 ‘스메타나’[각주***]에 대한 대사', page_number: '152', page_kind: 'body', is_blank_page: false,
      has_poem_or_quote: false, visuals: [], flags: [], notes: '', footnotes_without_note: [], notes_without_marker: [] };
  }
  if (GEMINI_FOOTNOTES && page === 153) {
    return { text: '[각주*: 이러한 설정은 연출적 장치로 해석할 수 있다.]\n본문 153', page_number: '153', page_kind: 'body', is_blank_page: false,
      has_poem_or_quote: false, visuals: [], flags: [], notes: '', footnotes_without_note: [], notes_without_marker: [] };
  }
  if (page === 153) {
    return { text: '@@{153쪽 제목\n[그림] 꽃 그림(Flower)\n@@i\n설명 첫 줄\n[그림 끝]\n본문 153', page_number: '153', page_kind: 'body',
      is_blank_page: false, has_poem_or_quote: false,
      visuals: [{ kind: '그림', title: '꽃 그림(Flower)', box: { x: 90, y: 140, width: 420, height: 320 } }],
      flags: [{ kind: 'uncertain_text', message: '그림 설명 확인', quote: '설명 첫 줄', needs_review: true }], notes: '' };
  }
  return { text: `@@{${page}쪽 제목\n본문 ${page}`, page_number: String(page), page_kind: 'body', is_blank_page: false,
    has_poem_or_quote: false, visuals: [], flags: [], notes: '' };
}
const res = (body, type, status = 200, extra = {}) => new Response(body, { status, headers: { 'content-type': type, ...extra } });

async function site(req) {
  const url = new URL(req.url);
  if (!/mypickebook\.org$/.test(url.host)) return res('', 'text/plain', 404);
  if (url.pathname === '/' || url.pathname === '/mypage.html') {
    // 실제 사이트처럼: 내 작업에서 "편집하기"를 누르면 편집 화면이 새 창(팝업)으로 열림
    return res(`<!doctype html><meta charset="utf-8"><title>내 작업</title><h1>내 작업</h1>
      <button id="editPopup" onclick="window.open('/making/make_book.html?idx=23584&book_page=151','make_book','width=1400,height=900,scrollbars=yes')">편집하기 (팝업)</button>
      <a id="editBlank" href="/making/make_book.html?idx=23584&book_page=151" target="_blank">편집하기 (새 탭)</a>
      <form id="f" method="post" action="/making/make_book.html?idx=23584&book_page=151"><input type="hidden" name="idx" value="23584"></form>
      <button id="editForm" onclick="window.open('', 'make_book_f', 'width=1400,height=900'); var f=document.getElementById('f'); f.target='make_book_f'; f.submit();">편집하기 (빈 창 + 폼 전송)</button>
      <button id="editBlankThenGo" onclick="var w=window.open('about:blank', 'make_book_b', 'width=1400,height=900'); w.location.href='/making/make_book.html?idx=23584&book_page=151';">편집하기 (빈 창 → 주소 이동)</button>
      <button id="history" onclick="window.open('/making/history.html?idx=23584', 'hist', 'width=800,height=600')">기록 확인</button>`, 'text/html; charset=utf-8');
  }
  // 마이페이지 봉사실적(피드백 버튼) · 피드백 팝업: 저장소의 실제 화면 저장본
  if (url.pathname === '/mypage/book.html') return res(url.searchParams.get('page') > 1 ? '<table><tbody></tbody></table>' : fs.readFileSync(path.join(FIX, 'mypage_book.html'), 'utf8'), 'text/html; charset=utf-8');
  if (url.pathname === '/mypage/pop_feed.html') { S.feedPops = (S.feedPops || 0) + 1; return res(url.searchParams.get('page') > 1 ? '<table><tbody></tbody></table>' : fs.readFileSync(path.join(FIX, 'pop_feed.html'), 'utf8'), 'text/html; charset=utf-8'); }
  if (url.pathname === '/making/history.html') return res('<!doctype html><meta charset="utf-8"><title>기록</title><h1 id="h">작업 기록</h1>', 'text/html; charset=utf-8');
  if (url.pathname === '/making/make_book.html') {
    const page = Number(url.searchParams.get('book_page') || 151);
    // 실제 사이트처럼 저장한 내용을 다시 보여 줌 (각주 잇기 시험 때만: 다른 시험은 늘 OCR로 시작)
    const kept = GEMINI_FOOTNOTES ? [...S.saves].reverse().find((x) => x.page === page)?.content : null;
    const html = mockHtml.replaceAll('__PAGE__', String(page)).replaceAll('__END__', '153').replace('__OCR__', () => kept ?? `${page}쪽 OCR 본문`);
    return res(html, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/making/file.php' || url.pathname === '/common/file.php') return res(pageImg, 'image/jpeg');
  if (url.pathname === '/upload/book/file.php') return res(originalImg, 'image/png');
  if (url.pathname === '/module/book/cropbox_upload_proc.php') {
    S.uploads.push(await req.text());
    return res(JSON.stringify({ result: 200, img_path: `/upload/crop/${S.uploads.length}.png` }), 'application/json');
  }
  if (/^\/upload\/crop\/\d+\.png$/.test(url.pathname)) return res(originalImg, 'image/png');
  if (url.pathname === '/module/book/table_of_content.php') {
    S.tocFetches = (S.tocFetches || 0) + 1;
    if (process.env.SILO_MOCK_NO_TOC) return res('', 'text/html', 500);
    const n = Number(url.searchParams.get('page') || 1);
    return res(`<!doctype html><meta charset="utf-8"><div class="feed_wrap"><h1>목차</h1><div><img src="/upload/toc/${n}.jpg"></div>
      <div class="page"><a href="?book_idx=23584&page=1">1</a><a href="?book_idx=23584&page=2">2</a></div></div>`, 'text/html; charset=utf-8');
  }
  if (/^\/upload\/toc\/\d\.jpg$/.test(url.pathname)) return res(pageImg, 'image/jpeg');
  if (url.pathname === '/making/make_save_proc.php') {
    S.saves.push({ ...JSON.parse(await req.text()), at: Date.now() });
    return res('{"result":200}', 'application/json');
  }
  return res('', 'text/plain', 404);
}

module.exports = ({ appSes }) => {
  // 사이트 세션(프로필마다 하나)은 나중에 만들어지므로 만들어질 때마다 가로챈다
  app.on('session-created', (ses) => { if (ses !== appSes) ses.protocol.handle('https', site); });

  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  let lastPage = NaN;
  appSes.protocol.handle('https', async (req) => {
    const url = new URL(req.url);
    if (/googleapis\.com$/.test(url.host)) {
      // 온라인 계정 서버(Firebase)도 가짜로 (가입 코드 TESTCODE)
      const saved = path.join(app.getPath('userData'), 'fake-firebase.json');
      S.firebase ||= (await import(require('node:url').pathToFileURL(path.join(__dirname, '..', '..', 'tests', 'fake-firebase.mjs')).href))
        .fakeFirebase('TESTCODE', fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) : null);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const raw = await req.text();
      let body = raw;
      try { body = JSON.parse(raw); } catch { /* form */ }
      const r = S.firebase.handle(req.url, req.method, body, req.headers.get('authorization'));
      fs.writeFileSync(saved, JSON.stringify(S.firebase.dump()));
      return res(JSON.stringify(r.body), 'application/json', r.status);
    }
    if (url.host !== 'api.anthropic.com') return res('', 'text/plain', 404);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const body = JSON.parse(await req.text());
    const reply = (obj, usage = { input_tokens: 3000, output_tokens: 1500 }) => res(JSON.stringify({
      model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage }), 'application/json', 200);
    if (/차례\(목차\) 페이지 이미지/.test(body.system[0].text)) { S.tocCalls = (S.tocCalls || 0) + 1; S.tocImages = body.messages.at(-1).content.filter((c) => c.type === 'image').length; return reply({ toc: '@@[1부 시작 1\n@@{151쪽 제목 151', notes: '' }); }
    const userText = body.messages.at(-1).content.at(-1).text;
    const isVerify = /2차 검수/.test(userText);
    const page = isVerify ? lastPage : Number((userText.match(/작업 쪽: (\d+)/) || [])[1]);
    lastPage = page;
    S.apiCalls.push({ page, verify: isVerify, key: req.headers.get('x-api-key') });
    return reply(isVerify ? { fixes: [], flags: [] } : resultFor(page));
  });
};
