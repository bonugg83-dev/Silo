// 새 버전 안내 창: 앱 본체가 뒤 화면 사진과 버전을 보내 주면 띄움
const $ = (id) => document.getElementById(id);
silo.onUpdatePrompt((p) => {
  const shots = $('shots');
  shots.replaceChildren();
  for (const s of p.shots || []) {
    const img = document.createElement('img');
    img.src = s.url;
    Object.assign(img.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.width}px`, height: `${s.height}px` });
    shots.append(img);
  }
  $('from').textContent = p.from || '';
  $('to').textContent = p.version || '새 버전';
  document.body.classList.remove('on');
  requestAnimationFrame(() => requestAnimationFrame(() => { document.body.classList.add('on'); $('now').focus(); }));
});
$('now').addEventListener('click', () => silo.cmd('updateNow'));
$('later').addEventListener('click', () => silo.cmd('updateLater'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') silo.cmd('updateLater'); });
