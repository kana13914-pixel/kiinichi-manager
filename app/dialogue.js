// セリフ集（app/data/dialogue.json）から選ぶ。util.js の後、各画面の前に読み込む。

let dialogue = null;
const dialogueReady = fetch('data/dialogue.json').then((r) => r.json()).then((d) => { dialogue = d; }).catch(() => {});
const lastLineIndex = {}; // キーごとに直前に出した候補の番号（C1-02）

function candidates(key) {
  if (!dialogue || !key) return null;
  const [trigger, condId] = key.split('.');
  const cond = dialogue[trigger] && (dialogue[trigger].conditions || []).find((c) => c.id === condId);
  return cond && cond.lines && cond.lines.length ? cond.lines : null;
}

// "morning_wake.on_time" のようなキーからセリフを1つ選び、{ text, index } を返す
// index が範囲内の整数ならその候補（通知の line 指定。C5-05）。それ以外は直前と違うものをランダムに（C1-02）
// セリフの中の {title} などを差し込む（カレンダーの予定の名前など。D-054）
function fillLine(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

function pickLine(key, { index } = {}) {
  const lines = candidates(key);
  if (!lines) return null;
  let i;
  if (Number.isInteger(index) && index >= 0 && index < lines.length) {
    i = index;
  } else {
    const pool = lines.map((_, k) => k).filter((k) => lines.length < 2 || k !== lastLineIndex[key]);
    i = pool[Math.floor(Math.random() * pool.length)];
  }
  lastLineIndex[key] = i;
  return { text: lines[i], index: i };
}
