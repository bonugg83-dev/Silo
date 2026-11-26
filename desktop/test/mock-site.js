// 테스트 전용: 마이픽 사이트와 Claude API를 가짜로 응답한다 (SILO_MOCK 일 때만 main.js 가 불러옴)
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const FIX = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const mockHtml = fs.readFileSync(path.join(FIX, 'mock_make_book.html'), 'utf8');
const pageImg = fs.readFileSync(path.join(FIX, 'page.jpg'));
const originalImg = fs.readFileSync(path.join(FIX, 'original.png'));
const S = (globalThis.__mock = { saves: [], uploads: [], apiCalls: [] });

function resultFor(page) {
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
  if (url.pathname === '/making/history.html') return res('<!doctype html><meta charset="utf-8"><title>기록</title><h1 id="h">작업 기록</h1>', 'text/html; charset=utf-8');
  if (url.pathname === '/making/make_book.html') {
    const page = Number(url.searchParams.get('book_page') || 151);
    const html = mockHtml.replaceAll('__PAGE__', String(page)).replaceAll('__END__', '153').replace('__OCR__', `${page}쪽 OCR 본문`);
    return res(html, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/making/file.php' || url.pathname === '/common/file.php') return res(pageImg, 'image/jpeg');
  if (url.pathname === '/upload/book/file.php') return res(originalImg, 'image/png');
  if (url.pathname === '/module/book/cropbox_upload_proc.php') {
    S.uploads.push(await req.text());
    return res(JSON.stringify({ result: 200, img_path: `/upload/crop/${S.uploads.length}.png` }), 'application/json');
  }
  if (/^\/upload\/crop\/\d+\.png$/.test(url.pathname)) return res(originalImg, 'image/png');
  if (url.pathname === '/module/book/table_of_content.php') return res('', 'text/html', 500);
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
    if (url.host !== 'api.anthropic.com') return res('', 'text/plain', 404);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const body = JSON.parse(await req.text());
    const reply = (obj, usage = { input_tokens: 3000, output_tokens: 1500 }) => res(JSON.stringify({
      model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage }), 'application/json', 200, cors);
    if (/차례\(목차\) 페이지 이미지/.test(body.system[0].text)) return reply({ toc: '', notes: '' });
    const userText = body.messages.at(-1).content.at(-1).text;
    const isVerify = /2차 검수/.test(userText);
    const page = isVerify ? lastPage : Number((userText.match(/작업 쪽: (\d+)/) || [])[1]);
    lastPage = page;
    S.apiCalls.push({ page, verify: isVerify, key: req.headers.get('x-api-key') });
    return reply(isVerify ? { fixes: [], flags: [] } : resultFor(page));
  });
};
