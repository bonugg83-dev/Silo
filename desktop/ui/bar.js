const $ = (id) => document.getElementById(id);
for (const id of ['back', 'forward', 'reload', 'home', 'practice', 'togglePanel', 'diagnostics']) $(id).addEventListener('click', () => silo.cmd(id));

function describe(url, title) {
  let u;
  try { u = new URL(url); } catch { return ['', title || '']; }
  if (!/mypickebook\.org$/.test(u.hostname)) return [u.hostname, title || ''];
  if (/make_book\.html$/.test(u.pathname)) {
    const p = u.searchParams.get('book_page');
    return ['마이픽 · 전자도서 제작', p ? `편집 화면 ${p}쪽` : '편집 화면'];
  }
  return ['마이픽', title && !/^https?:/.test(title) ? title : ''];
}
silo.onState((s) => {
  const [place, detail] = describe(s.url, s.title);
  const where = $('where');
  where.textContent = place;
  if (detail) { where.append(' › '); const b = document.createElement('b'); b.textContent = detail; where.append(b); }
  $('back').disabled = !s.canBack;
  $('forward').disabled = !s.canForward;
  $('togglePanel').setAttribute('aria-pressed', String(!!s.panelHidden));
  $('togglePanel').setAttribute('aria-label', s.panelHidden ? '패널 펴기' : '패널 접기');
  document.body.classList.toggle('locked', !!s.authOpen);
  $('practice').hidden = !!s.reviewOpen;
  const link = $('link');
  const eds = s.editors || [];
  link.classList.toggle('on', eds.length > 0);
  link.textContent = eds.length === 1 ? `편집 화면 연결됨${eds[0] ? ' · ' + eds[0] + '쪽' : ''}`
    : eds.length > 1 ? `편집 화면 ${eds.length}개` : '편집 화면 없음';
});
let toastTimer;
silo.onToast((text) => {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
});
