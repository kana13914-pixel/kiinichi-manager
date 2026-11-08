// フェーズ0 検証用：ブラウザからntfyへ通知を送る（scripts/ntfy_send.py のブラウザ版）。
// トピック名はユーザーが入力し、この端末の localStorage にのみ保存する。コードには埋め込まない。
const NTFY_SERVER = 'https://ntfy.sh';
const KEY = 'phase0.ntfyTopic';

const $ = (id) => document.getElementById(id);
const appUrl = new URL('index.html', location.href).href; // 同じ場所にある index.html
$('click').value = appUrl + '?source=ntfy';

try { $('topic').value = localStorage.getItem(KEY) || ''; } catch (_) { /* 保存できない環境でも動かす */ }
$('topic').addEventListener('change', () => {
  try { localStorage.setItem(KEY, $('topic').value.trim()); } catch (_) {}
});

$('gen-topic').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  $('topic').value = 'kiinichi-' + rand;
  $('topic').dispatchEvent(new Event('change'));
  setStatus('新しいトピック名を作りました。ntfyアプリでこの名前を購読し直してください。', '');
});

function setStatus(text, cls) {
  $('send-status').textContent = text;
  $('send-status').className = cls || '';
}

function hhmmss(d) {
  return d.toLocaleTimeString('ja-JP', { hour12: false });
}

// 送信内容を組み立てる（テストしやすいよう分けておく）
function buildPayload(topic, minutes, click, now = new Date()) {
  const payload = {
    topic,
    title: 'キィニチくん（検証）',
    message: '通知テストだ。タップして開いてみろ。',
  };
  if (click) payload.click = click;
  if (minutes > 0) {
    const at = new Date(now.getTime() + minutes * 60_000);
    at.setMilliseconds(0);
    payload.delay = String(Math.floor(at.getTime() / 1000)); // ntfyのサーバー側予約
    payload.message += `（予定 ${hhmmss(at)}）`;
  }
  return payload;
}

$('send').addEventListener('click', async () => {
  const topic = $('topic').value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    setStatus('トピック名を入力してください（英数字・-・_ のみ）', 'ng');
    return;
  }
  const payload = buildPayload(topic, Number($('delay').value), $('click').value.trim());
  setStatus('送信中…', '');
  try {
    // Content-Type を付けない（text/plain 扱いの単純リクエスト）ことで、CORSの事前確認を避ける
    const res = await fetch(NTFY_SERVER + '/', { method: 'POST', body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const when = data.time ? hhmmss(new Date(data.time * 1000)) : '?';
    setStatus(`送信しました（配信予定 ${when}）`, 'ok');
  } catch (e) {
    setStatus('送信失敗: ' + e.message, 'ng');
  }
});

// ---- Web Push（送信サーバー経由） ----
Settings.bind('wp-worker-url', 'workerUrl');
Settings.bind('wp-token', 'appToken');

function setWp(text, cls) {
  $('wp-status').textContent = text;
  $('wp-status').className = cls || '';
}

// セリフ集（通知の本文をセリフそのものにするため。C5-04, C5-05）
const dialogueLoaded = fetch('data/dialogue.json').then((r) => r.json()).catch(() => null);

function linesOf(dialogue, trigger) {
  if (!dialogue || !trigger) return null;
  const [key, condId] = trigger.split('.');
  const cond = dialogue[key] && (dialogue[key].conditions || []).find((c) => c.id === condId);
  return cond && cond.lines && cond.lines.length ? cond.lines : null;
}

function buildWebPushRequest(minutes, now = new Date(), trigger = '', dialogue = null) {
  let url = appUrl + '?source=webpush' + (trigger ? '&trigger=' + encodeURIComponent(trigger) : '');
  const lines = linesOf(dialogue, trigger);
  let body;
  if (lines) {
    // 候補から1つ選び、本文をそのセリフに、URL にその番号（0始まり）を付ける。開いた画面で同じセリフが出る
    const index = Math.floor(Math.random() * lines.length);
    url += '&line=' + index;
    body = { title: 'キィニチ（テスト）', body: lines[index], url };
  } else {
    const label = trigger ? $('wp-trigger').selectedOptions[0].textContent : '';
    body = { title: 'キィニチくん（検証）', body: trigger ? `（テスト）${label}` : '通知テストだ。タップして開いてみろ。', url };
  }
  if (minutes > 0) {
    const at = new Date(now.getTime() + minutes * 60_000);
    body.delaySeconds = minutes * 60;
    body.body += `（予定 ${hhmmss(at)}）`;
  }
  return body;
}

$('wp-send').addEventListener('click', async () => {
  setWp('送信中…', '');
  try {
    const dialogue = await dialogueLoaded; // セリフ集の読み込みを待ってから送信内容を作る
    const r = await Settings.api('/api/send', { method: 'POST', body: buildWebPushRequest(Number($('delay').value), new Date(), $('wp-trigger').value, dialogue) });
    const note = r.queueStore === 'kv' ? '。保存先がKVのため最大1分ほど遅れることがあります（D1の設定を推奨）' : '';
    setWp(r.scheduled ? `予約しました（配信予定 ${hhmmss(new Date(r.at))}${note}）` : '送信しました', 'ok');
  } catch (e) {
    setWp('失敗: ' + e.message, 'ng');
  }
});

$('wp-status-btn').addEventListener('click', async () => {
  try {
    const r = await Settings.api('/api/status');
    setWp(`購読：${r.subscribed ? 'あり' : 'なし'}／予約：${r.queue.length}件／予約の保存先：${r.queueStore === 'd1' ? 'D1' : 'KV'}`, r.subscribed ? 'ok' : 'ng');
  } catch (e) {
    setWp('失敗: ' + e.message, 'ng');
  }
});
