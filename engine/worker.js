// 解析は時間がかかるので、画面を止めないよう別の場所（Worker）で行う
import { analyze } from './analyze.js';

self.onmessage = (e) => {
  const { L, R, sr, listen, opts } = e.data;
  try {
    let lastPost = 0;
    const res = analyze({ L, R, sr }, {
      ...(opts || {}),
      listen,
      progress: (stage, p) => {
        const now = Date.now();
        if (now - lastPost < 80 && p > 0 && p < 1) return;
        lastPost = now;
        self.postMessage({ type: 'progress', stage, p });
      },
    });
    self.postMessage({ type: 'done', res });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
