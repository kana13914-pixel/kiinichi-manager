// 立ち絵（D-022 ④、D-066、D-067）。
// ①写真から選んだ画像（この端末の IndexedDB。置き方は db.portrait）②app/img/portrait.webp・.png ③紋章、の順に出す。
// 写真の画像はホームの画面いっぱいに、部品（時計・セリフの面・記録など）の後ろに敷く。
// 位置と大きさ・部品の透け具合は、ホームの画面そのものの上で合わせる（部品と重なる見えかたを確かめながら。D-067）。
// 写真の画像は送信サーバー・スプレッドシートには送らない。
const Portrait = (() => {
  const MAX_SIDE = 1200;      // 保存する画像の長いほうの辺
  const SCALE_MIN = 0.5, SCALE_MAX = 3;
  const SHIFT_MAX = 100;      // 位置のずれ（画面の幅・高さに対する %）
  const CLEAR_MAX = 90;       // 部品の地の透け具合（%）の上限。0 は今までどおり
  const BUNDLED = ['img/portrait.webp', 'img/portrait.png'];
  const $ = (id) => document.getElementById(id);

  // ---------- 保存（画像は IndexedDB、置き方は localStorage） ----------
  function idb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('この端末では画像を保存できません')); return; }
      const req = indexedDB.open('kiinichi', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('画像の保存先を開けませんでした'));
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      const req = fn(tx.objectStore('images'));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('画像を保存できませんでした')); };
    });
  }
  const getBlob = () => idbDo('readonly', (s) => s.get('portrait')).catch(() => null);
  // 保存する前に中身を写し取る。IndexedDB から読んだ画像をそのまま入れ直すと、iPhone（Safari）で
  // 中身が消えて表示できなくなることがある（2026-11-19 の実機報告。「位置と大きさ」→「保存」のあと）
  async function putBlob(blob) {
    const copy = new Blob([await blob.arrayBuffer()], { type: blob.type || 'image/png' });
    return idbDo('readwrite', (s) => s.put(copy, 'portrait'));
  }
  const deleteBlob = () => idbDo('readwrite', (s) => s.delete('portrait'));

  function conf() {
    const c = Store.read(DB.portrait, null);
    return c && typeof c === 'object' && c.w > 0 && c.h > 0 ? { ui: 0, ...c } : null;
  }

  // ---------- 画像を縮めて、透過があるかを調べる ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('この画像は読み込めませんでした'));
      img.src = src;
    });
  }
  async function prepare(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      // 透過している点があれば、背景のない絵として扱う（画面に収め、足元を下にそろえる）
      let alpha = false;
      if (file.type !== 'image/jpeg') {
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < data.length; i += 4 * 7) { if (data[i] < 250) { alpha = true; break; } }
      }
      const type = alpha ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
      if (!blob) throw new Error('この画像は読み込めませんでした');
      return { blob, w, h, alpha };
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- 画面いっぱいの枠の中の置き方 ----------
  function frameAspect() {
    const r = $('portrait-layer').getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.width / r.height : window.innerWidth / window.innerHeight;
  }
  // 枠いっぱいにしたときの大きさ（枠に対する %）。背景のある絵は画面を覆い、透過の絵は画面に収める
  function baseSize(c, fa = frameAspect()) {
    const ia = c.w / c.h;
    const wide = ia > fa;
    if (wide === !c.alpha) return { w: (100 * ia) / fa, h: 100 };
    return { w: 100, h: (100 * fa) / ia };
  }
  // 初めの位置：背景のある絵は真ん中、透過の絵は足元を画面の下にそろえる
  function defaults(c) {
    const b = baseSize(c);
    return { scale: 1, x: 0, y: c.alpha ? (100 - b.h) / 2 : 0 };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function place(img, c) {
    const b = baseSize(c);
    img.style.width = `${b.w}%`;
    img.style.height = `${b.h}%`;
    img.style.left = `${50 + c.x}%`;
    img.style.top = `${50 + c.y}%`;
    img.style.transform = `translate(-50%, -50%) scale(${c.scale})`;
  }
  // 部品の地の透け具合（0〜CLEAR_MAX %）。style.css の --ui-clear（0〜1）で使う
  function applyClear(ui) {
    document.body.style.setProperty('--ui-clear', String(clamp(Number(ui) || 0, 0, CLEAR_MAX) / 100));
  }

  // ---------- ホーム ----------
  let homeUrl = null;
  let shown = null; // ホームに出している置き方
  function showEmblem(el) {
    el.dataset.art = 'none';
    el.style.removeProperty('--portrait-art');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
    el.setAttribute('aria-hidden', 'true');
  }
  function labelArt(el, label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    el.removeAttribute('aria-hidden');
  }
  function loadBundled(el, sources = BUNDLED) {
    if (!sources.length) return;
    const img = new Image();
    img.onload = () => {
      if (el.dataset.art === 'photo') return; // 先に写真が出ていれば、そちらのまま
      el.style.setProperty('--portrait-art', `url("${sources[0]}")`);
      el.dataset.art = 'ready';
      labelArt(el, 'キィニチの立ち絵');
    };
    img.onerror = () => loadBundled(el, sources.slice(1));
    img.src = sources[0];
  }
  // 画面いっぱいの層に画像を出す（c が null なら消す）
  function showPhoto(url, c) {
    const layer = $('portrait-layer');
    const img = $('portrait-photo');
    shown = c;
    document.body.classList.toggle('has-photo', Boolean(c));
    layer.hidden = !c;
    if (!c) { img.removeAttribute('src'); applyClear(0); return; }
    $('portrait').dataset.art = 'photo'; // 紋章を消す（合わせている途中も）
    if (img.getAttribute('src') !== url) img.src = url;
    place(img, c);
    applyClear(c.ui);
  }
  async function renderHome() {
    const el = $('portrait');
    if (!el) return;
    const c = conf();
    const blob = c ? await getBlob() : null;
    if (homeUrl) { URL.revokeObjectURL(homeUrl); homeUrl = null; }
    if (!c || !blob) {
      showPhoto(null, null);
      showEmblem(el);
      loadBundled(el);
      return;
    }
    homeUrl = URL.createObjectURL(blob);
    el.style.removeProperty('--portrait-art');
    el.dataset.art = 'photo';
    labelArt(el, '立ち絵（写真から選んだ画像）');
    showPhoto(homeUrl, c);
  }
  // 画面の向き・大きさが変わったら置き直す（位置は画面に対する % なので、同じ見えかたになる）
  window.addEventListener('resize', () => { if (shown) place($('portrait-photo'), shown); });

  // ---------- 設定 ----------
  function renderSettings() {
    const has = Boolean(conf());
    $('portrait-state').textContent = has ? '写真から選んだ画像を出しています' : '紋章を出しています（画像を選ぶと、ホームの画面いっぱいに出ます）';
    $('portrait-adjust').hidden = !has;
    $('portrait-reset').hidden = !has;
  }

  // ---------- 触る場所の印（D-083 ②） ----------
  // { head: [ { x, y, r } ], hand: [ …2つまで ], … }。x・y は画像の上の位置（0〜1）、r は画像の幅に対する半径
  const SPOT_PARTS = [['head', '頭'], ['face', '顔'], ['neck', '首'], ['hand', '手'], ['body', '体'], ['foot', '足']];
  const SPOT_MAX = { hand: 2, foot: 2 }; // ほかは1つ
  const SPOT_R = { s: 0.05, m: 0.08, l: 0.13 };
  const SPOT_DEFAULT = { head: 'm', face: 's', neck: 's', hand: 's', body: 'l', foot: 's' };
  function normalizeSpots(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [part] of SPOT_PARTS) {
      const list = [].concat(raw[part] || []).filter((s) => s && [s.x, s.y, s.r].every(Number.isFinite) && s.r > 0)
        .map((s) => ({ x: clamp(s.x, 0, 1), y: clamp(s.y, 0, 1), r: clamp(s.r, 0.01, 0.5) }));
      if (list.length) out[part] = list.slice(0, SPOT_MAX[part] || 1);
    }
    return out;
  }
  function spots() { const c = conf(); return normalizeSpots(c && c.spots); }
  const sizeOf = (r) => Object.keys(SPOT_R).reduce((a, k) => (Math.abs(SPOT_R[k] - r) < Math.abs(SPOT_R[a] - r) ? k : a), 'm');

  // ---------- ホームの上で合わせる ----------
  let draft = null; // 合わせている途中 { blob, w, h, alpha, scale, x, y, ui, spots, url }
  let editMode = 'place'; // 'place'（位置と大きさ）／'spots'（触る場所）
  let spotPart = 'head';
  function renderSpots() {
    const layer = $('portrait-spot-layer');
    layer.hidden = !draft || editMode !== 'spots';
    if (layer.hidden) { layer.replaceChildren(); return; }
    const r = $('portrait-photo').getBoundingClientRect();
    const base = $('portrait-editor').getBoundingClientRect();
    const marks = [];
    for (const [part, label] of SPOT_PARTS) {
      for (const s of draft.spots[part] || []) {
        const el = document.createElement('span');
        el.className = 'portrait-spot' + (part === spotPart ? ' on' : '');
        el.dataset.part = part;
        const d = 2 * s.r * r.width;
        el.style.width = `${d}px`;
        el.style.height = `${d}px`;
        el.style.left = `${r.left - base.left + s.x * r.width}px`;
        el.style.top = `${r.top - base.top + s.y * r.height}px`;
        el.textContent = label;
        marks.push(el);
      }
    }
    layer.replaceChildren(...marks);
    for (const b of document.querySelectorAll('#portrait-spot-parts [data-part]')) b.setAttribute('aria-pressed', String(b.dataset.part === spotPart));
    const list = draft.spots[spotPart] || [];
    const size = list.length ? sizeOf(list[0].r) : SPOT_DEFAULT[spotPart];
    for (const b of document.querySelectorAll('#portrait-spot-sizes [data-size]')) b.setAttribute('aria-pressed', String(b.dataset.size === size));
    $('portrait-spot-clear').disabled = !list.length;
    renderSpotHint();
  }
  // 「全体を見る」で板を隠しているとき、どの部位の印を置くかを上に出す
  function renderSpotHint() {
    const hint = $('portrait-spot-hint');
    hint.hidden = !draft || editMode !== 'spots' || !$('portrait-editor-panel').hidden;
    if (!hint.hidden) hint.textContent = `「${SPOT_PARTS.find(([p]) => p === spotPart)[1]}」の印を置きます`;
  }
  function setEditMode(mode) {
    editMode = mode;
    document.body.classList.toggle('portrait-spots', mode === 'spots');
    $('portrait-mode-place').setAttribute('aria-pressed', String(mode === 'place'));
    $('portrait-mode-spots').setAttribute('aria-pressed', String(mode === 'spots'));
    $('portrait-place-panel').hidden = mode !== 'place';
    $('portrait-spots-panel').hidden = mode !== 'spots';
    $('portrait-editor-status').textContent = '';
    renderSpots();
    renderSpotHint();
  }
  // 押した所に、選んでいる部位の印を置く。1つまでの部位は置き直し、2つまでの部位は足すか近いほうを置き直す
  function placeSpot(clientX, clientY) {
    const r = $('portrait-photo').getBoundingClientRect();
    const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) { $('portrait-editor-status').textContent = '画像の上を押してください'; return; }
    $('portrait-editor-status').textContent = '';
    const list = draft.spots[spotPart] || [];
    const rr = list.length ? list[0].r : SPOT_R[SPOT_DEFAULT[spotPart]];
    const mark = { x, y, r: rr };
    const max = SPOT_MAX[spotPart] || 1;
    if (list.length < max) list.push(mark);
    else {
      const near = list.reduce((a, s, i) => (Math.hypot(s.x - x, s.y - y) < Math.hypot(list[a].x - x, list[a].y - y) ? i : a), 0);
      list[near] = mark;
    }
    draft.spots[spotPart] = list;
    renderSpots();
  }
  function renderDraft() {
    showPhoto(draft.url, draft);
    $('portrait-scale').value = String(Math.round(draft.scale * 100));
    $('portrait-scale-value').textContent = `${Math.round(draft.scale * 100)}%`;
    $('portrait-clear').value = String(Math.round(draft.ui));
    $('portrait-clear-value').textContent = `${Math.round(draft.ui)}%`;
    renderSpots(); // 印は画像に付いているので、位置と大きさを変えると一緒に動く
  }
  function startEdit(d) {
    if (draft && draft.url) URL.revokeObjectURL(draft.url);
    draft = { ui: 0, ...d, spots: d.fresh ? {} : normalizeSpots(d.spots), url: URL.createObjectURL(d.blob) }; // 画像を選び直したら印は消す（絵が違うため）
    if (location.hash !== '#home') location.hash = '#home';
    document.body.classList.add('portrait-edit'); // 部品を押せないようにして、画面全体で絵を動かせるようにする
    $('portrait-editor').hidden = false;
    $('portrait-editor-panel').hidden = false;
    $('portrait-editor-show').hidden = true;
    $('portrait-editor-status').textContent = '';
    setEditMode('place');
    renderDraft();
  }
  function endEdit() {
    document.body.classList.remove('portrait-edit', 'portrait-spots');
    $('portrait-editor').hidden = true;
    if (draft && draft.url) URL.revokeObjectURL(draft.url);
    draft = null;
  }
  const editing = () => Boolean(draft);

  function bind() {
    $('portrait-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      $('portrait-status').textContent = '';
      try {
        const p = await prepare(file);
        const keep = conf();
        startEdit({ ...p, ...defaults(p), ui: keep ? keep.ui : 0, fresh: true }); // 透け具合は前の画像のものを引き継ぐ
      } catch (err) { $('portrait-status').textContent = err.message; }
    });
    $('portrait-adjust').addEventListener('click', async () => {
      const c = conf();
      const blob = c && await getBlob();
      if (!blob) { $('portrait-status').textContent = '画像が見つかりませんでした。もう一度選んでください'; return; }
      startEdit({ ...c, blob });
    });
    $('portrait-reset').addEventListener('click', async () => {
      if (!(await confirmDialog('立ち絵の画像を外して、紋章に戻しますか？', '紋章に戻す'))) return;
      try { await deleteBlob(); } catch (_) {}
      Store.remove(DB.portrait);
      renderSettings();
      renderHome();
    });
    $('portrait-scale').addEventListener('input', (e) => {
      if (!draft) return;
      draft.scale = clamp(Number(e.target.value) / 100, SCALE_MIN, SCALE_MAX);
      renderDraft();
    });
    $('portrait-clear').addEventListener('input', (e) => {
      if (!draft) return;
      draft.ui = clamp(Number(e.target.value), 0, CLEAR_MAX);
      renderDraft();
    });
    $('portrait-center').addEventListener('click', () => {
      if (!draft) return;
      Object.assign(draft, defaults(draft));
      renderDraft();
    });
    // 位置と大きさ／触る場所（D-083 ②）
    $('portrait-mode-place').addEventListener('click', () => setEditMode('place'));
    $('portrait-mode-spots').addEventListener('click', () => setEditMode('spots'));
    $('portrait-spot-parts').replaceChildren(...SPOT_PARTS.map(([part, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cut-btn quiet chip';
      b.dataset.part = part;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(part === spotPart));
      b.addEventListener('click', () => { spotPart = part; renderSpots(); });
      return b;
    }));
    for (const b of document.querySelectorAll('#portrait-spot-sizes [data-size]')) {
      b.addEventListener('click', () => {
        if (!draft) return;
        const list = draft.spots[spotPart] || [];
        if (list.length) for (const s of list) s.r = SPOT_R[b.dataset.size];
        else SPOT_DEFAULT[spotPart] = b.dataset.size; // まだ印がなければ、次に置く印の大きさ
        renderSpots();
      });
    }
    $('portrait-spot-clear').addEventListener('click', () => {
      if (!draft) return;
      delete draft.spots[spotPart];
      renderSpots();
    });
    // 操作の板を隠して、画面全体の見えかたを確かめる
    $('portrait-editor-hide').addEventListener('click', () => {
      $('portrait-editor-panel').hidden = true;
      $('portrait-editor-show').hidden = false;
      renderSpotHint();
    });
    $('portrait-editor-show').addEventListener('click', () => {
      $('portrait-editor-panel').hidden = false;
      $('portrait-editor-show').hidden = true;
      renderSpotHint();
    });
    // 指で動かして位置を合わせる（画面のどこを触ってもよい）
    const pad = $('portrait-drag');
    let drag = null;
    pad.addEventListener('pointerdown', (e) => {
      if (!draft) return;
      if (editMode === 'spots') { placeSpot(e.clientX, e.clientY); e.preventDefault(); return; } // 触る場所：押した所に印
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: draft.x, y: draft.y };
      pad.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!drag || !draft || e.pointerId !== drag.id) return;
      const r = $('portrait-layer').getBoundingClientRect();
      draft.x = clamp(drag.x + ((e.clientX - drag.sx) / r.width) * 100, -SHIFT_MAX, SHIFT_MAX);
      draft.y = clamp(drag.y + ((e.clientY - drag.sy) / r.height) * 100, -SHIFT_MAX, SHIFT_MAX);
      renderDraft();
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);

    $('portrait-cancel').addEventListener('click', () => {
      endEdit();
      renderHome();
      location.hash = '#settings';
    });
    $('portrait-save').addEventListener('click', async () => {
      if (!draft) return;
      // 画像を選び直したときだけ画像を保存する（位置と大きさだけ変えたときは、保存済みの画像に触らない）
      if (draft.fresh) {
        try { await putBlob(draft.blob); } catch (err) { $('portrait-editor-status').textContent = SAVE_FAILED; return; }
      }
      const r = (v) => Math.round(v * 10) / 10;
      const ok = Store.write(DB.portrait, {
        w: draft.w, h: draft.h, alpha: draft.alpha, scale: r(draft.scale), x: r(draft.x), y: r(draft.y), ui: Math.round(draft.ui), at: Date.now(),
        spots: Object.fromEntries(Object.entries(draft.spots).map(([k, list]) => [k, list.map((s) => ({ x: Math.round(s.x * 1000) / 1000, y: Math.round(s.y * 1000) / 1000, r: s.r }))])),
      });
      if (!ok) { $('portrait-editor-status').textContent = SAVE_FAILED; return; }
      endEdit();
      renderSettings();
      renderHome();
    });
    // 保存した画像が読めなかったら、紋章に戻して選び直しを頼む（「？」の印のままにしない）
    $('portrait-photo').addEventListener('error', () => {
      if (editing() || !$('portrait-photo').getAttribute('src')) return;
      showPhoto(null, null);
      showEmblem($('portrait'));
      loadBundled($('portrait'));
      $('portrait-status').textContent = '保存した画像を読み込めませんでした。もう一度「写真から選ぶ」で選んでください';
    });
    // 合わせている途中でほかの画面へ移ったら（戻る操作など）、保存せずにやめる
    window.addEventListener('hashchange', () => {
      if (editing() && location.hash !== '#home') { endEdit(); renderHome(); }
    });
  }

  bind();
  renderSettings();
  renderHome();
  return { renderHome, baseSize, defaults, spots };
})();
