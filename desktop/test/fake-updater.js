// 테스트용 가짜 업데이터 (electron-updater의 autoUpdater와 같은 모양)
// 확인하면 새 버전 9.9.9를 찾아 받는 척하고, quitAndInstall은 불렸는지만 기록한다.
const { EventEmitter } = require('node:events');

const fake = new EventEmitter();
fake.checks = 0;
fake.installs = [];
fake.checkForUpdates = async () => {
  fake.checks++;
  fake.emit('update-available', { version: '9.9.9' });
  fake.emit('download-progress', { percent: 50 });
  setTimeout(() => fake.emit('update-downloaded', { version: '9.9.9' }), 200);
};
fake.quitAndInstall = (silent, runAfter) => { fake.installs.push({ silent, runAfter }); };
globalThis.__fakeUpdater = fake;
module.exports = fake;
