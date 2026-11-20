// セリフ集（app/data/dialogue.json）から選ぶ。util.js の後、各画面の前に読み込む。

let dialogue = null;
const dialogueReady = fetch('data/dialogue.json').then((r) => r.json()).then((d) => { dialogue = d; }).catch(() => {});
const lastLineIndex = {}; // キーごとに直前に出した候補の番号（C1-02）

// 話し方（D-082）：依頼人版 client（既定）・友人版 friend・甘やかし版 sweet。設定で選び、この端末に覚える（db.prefs.tone）
const TONES = ['client', 'friend', 'sweet'];
function currentTone() {
  const t = typeof Prefs !== 'undefined' ? Prefs.get('tone') : 'client';
  return TONES.includes(t) ? t : 'client';
}
// その場面の候補。今の話し方の文（lines_friend・lines_sweet）があればそれ、なければ依頼人版の文（lines）
function candidates(key, tone = currentTone()) {
  if (!dialogue || !key) return null;
  const [trigger, condId] = key.split('.');
  const cond = dialogue[trigger] && (dialogue[trigger].conditions || []).find((c) => c.id === condId);
  if (!cond) return null;
  const own = tone !== 'client' ? cond['lines_' + tone] : null;
  const lines = Array.isArray(own) && own.length ? own : cond.lines;
  return Array.isArray(lines) && lines.length ? lines : null;
}

// "morning_wake.on_time" のようなキーからセリフを1つ選び、{ text, index } を返す
// index が範囲内の整数ならその候補（通知の line 指定。C5-05）。それ以外は直前と違うものをランダムに（C1-02）
// セリフの中の {title} などを差し込む（カレンダーの予定の名前など。D-054）
function fillLine(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

// セリフの文の短い印。通知の URL に番号と一緒に添える（h=）。セリフ集の並びが変わっても、通知と同じ文を探せるように（D-081）
function lineHash(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h.toString(36);
}

// hash があれば（通知から開いたとき）：番号の文の印が合えばそれ、合わなければ同じ印の文を探す。見つからなければ選び直す
function pickLine(key, { index, hash } = {}) {
  const lines = candidates(key);
  if (!lines) return null;
  let i;
  if (hash) {
    if (Number.isInteger(index) && index >= 0 && index < lines.length && lineHash(lines[index]) === hash) i = index;
    else { const k = lines.findIndex((t) => lineHash(t) === hash); if (k >= 0) i = k; }
  } else if (Number.isInteger(index) && index >= 0 && index < lines.length) {
    i = index;
  }
  if (i === undefined) {
    const pool = lines.map((_, k) => k).filter((k) => lines.length < 2 || k !== lastLineIndex[key]);
    i = pool[Math.floor(Math.random() * pool.length)];
  }
  lastLineIndex[key] = i;
  return { text: lines[i], index: i };
}
