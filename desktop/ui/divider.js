// 가운데 막대: 누르면 앱이 이 화면을 창 전체로 잠깐 넓혀서 끄는 동안 마우스를 놓치지 않는다
const grip = document.getElementById('grip');
let on = false;
grip.addEventListener('pointerdown', (e) => {
  on = true;
  document.body.classList.add('drag');
  silo.drag('start', e.screenX);
});
window.addEventListener('pointermove', (e) => { if (on) silo.drag('move', e.clientX); });
const end = () => { if (!on) return; on = false; document.body.classList.remove('drag'); silo.drag('end'); };
window.addEventListener('pointerup', end);
window.addEventListener('blur', end);
