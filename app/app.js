// フェーズ0 技術検証用。起動状態を表示し、実機確認で何が起きたか目で見えるようにする。

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function describeSource() {
  const src = new URLSearchParams(location.search).get('source');
  if (src === 'ntfy') return '通知（ntfy）のタップ';
  if (src === 'homescreen') return 'ホーム画面のアイコン';
  return 'URLを直接開いた';
}

function setText(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  if (cls) el.className = cls;
}

setText('display-mode', isStandalone() ? 'ホーム画面アプリ（standalone）' : 'ブラウザ内', isStandalone() ? 'ok' : '');
setText('source', describeSource());
setText('opened-at', new Date().toLocaleString('ja-JP'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => setText('sw-status', '登録済み', 'ok'))
    .catch((e) => setText('sw-status', '登録失敗: ' + e.message, 'ng'));
} else {
  setText('sw-status', '非対応', 'ng');
}
