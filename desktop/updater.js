// 자동 업데이트 (윈도 설치판만)
//
// 앱을 켜면 GitHub Releases에 새 버전이 있는지 조용히 확인하고, 있으면 뒤에서 받아 둔다.
// 다 받으면 위쪽 막대에 "다시 시작해서 업데이트" 버튼이 뜬다. 누르면 바로 설치하고 다시 켜고,
// 누르지 않아도 앱을 닫을 때 설치된다 (다음에 켜면 새 버전). 교정이 도는 중에는 다시 시작하지 않는다.
//
// 테스트에서는 SILO_FAKE_UPDATE 로 가짜 업데이터를 넣는다 (test/fake-updater.js).

const CHECK_EVERY_MS = 4 * 3600 * 1000; // 켜 둔 채로 오래 써도 4시간마다 확인
const FIRST_CHECK_MS = 8000;            // 켜자마자는 시작 모션·로그인에 방해되지 않게 조금 뒤에

/**
 * @param {object} o
 * @param {() => boolean} o.isBusy      교정이 도는 중이면 true (그때는 다시 시작하지 않음)
 * @param {(state: object) => void} o.onState  상태가 바뀔 때 (위쪽 막대에 보냄)
 * @param {(line: string) => void} o.log
 * @param {object} [o.updater]          테스트용 가짜
 * @param {number} [o.firstCheckMs]     켠 뒤 처음 확인까지
 */
function setupUpdater({ isBusy, onState, log, updater, firstCheckMs = FIRST_CHECK_MS }) {
  let au = updater;
  if (!au) {
    try {
      ({ autoUpdater: au } = require('electron-updater'));
    } catch (e) {
      log(`업데이트 기능을 불러오지 못함: ${e.message}`);
      return { install: () => ({ ok: false, reason: 'unavailable' }), check: () => {} };
    }
    au.autoDownload = true;          // 새 버전이 있으면 바로 뒤에서 받기
    au.autoInstallOnAppQuit = true;  // 버튼을 안 눌러도 앱을 닫을 때 설치
    au.logger = { info() {}, warn: (m) => log(`업데이트: ${m}`), error: (m) => log(`업데이트 오류: ${m}`), debug() {} };
  }

  let state = { status: 'idle', version: '', percent: 0 };
  const set = (s) => { state = { ...state, ...s }; onState(state); };

  au.on('update-available', (info) => set({ status: 'downloading', version: info?.version || '', percent: 0 }));
  au.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p?.percent || 0) }));
  au.on('update-downloaded', (info) => set({ status: 'ready', version: info?.version || state.version }));
  au.on('update-not-available', () => { if (state.status !== 'ready') set({ status: 'idle' }); });
  au.on('error', (e) => {
    log(`업데이트 확인 실패: ${e?.message || e}`);
    if (state.status !== 'ready') set({ status: 'idle' });
  });

  const check = () => {
    if (state.status === 'ready' || state.status === 'downloading') return;
    Promise.resolve().then(() => au.checkForUpdates()).catch((e) => log(`업데이트 확인 실패: ${e?.message || e}`));
  };
  setTimeout(check, firstCheckMs);
  const timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref?.();

  return {
    check,
    get state() { return state; },
    /** 다시 시작해서 설치. 교정 중이면 하지 않음 */
    install() {
      if (state.status !== 'ready') return { ok: false, reason: 'not-ready' };
      if (isBusy()) return { ok: false, reason: 'busy' };
      // 조용히 설치하고(isSilent) 설치 뒤 앱을 다시 켬(isForceRunAfter)
      setImmediate(() => au.quitAndInstall(true, true));
      return { ok: true };
    },
  };
}

module.exports = { setupUpdater, FIRST_CHECK_MS };
