// 立ち絵（D-022 ④、D-066）。
// ①写真から選んだ画像（この端末の IndexedDB。位置と大きさは db.portrait）②app/img/portrait.webp・.png ③紋章、の順に出す。
// 写真の画像は送信サーバー・スプレッドシートには送らない。
const Portrait = (() => {
  const FRAME = 3 / 4;        // 枠の縦横比（幅 / 高さ）。ホームと見本で同じにして、見えかたをそろえる
  const MAX_SIDE = 1200;      // 保存する画像の長いほうの辺
  const SCALE_MIN = 0.5, SCALE_MAX = 3;
  const SHIFT_MAX = 100;      // 位置のずれ（枠の幅・高さに対する %）
  const BUNDLED = ['img/portrait.webp', 'img/portrait.png'];
  const $ = (id) => document.getElementById(id);

  // ---------- 保存（画像は IndexedDB、位置と大きさは localStorage） ----------
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
  const putBlob = (blob) => idbDo('readwrite', (s) => s.put(blob, 'portrait'));
  const deleteBlob = () => idbDo('readwrite', (s) => s.delete('portrait'));

  function conf() {
    const c = Store.read(DB.portrait, null);
    return c && typeof c === 'object' && c.w > 0 && c.h > 0 ? c : null;
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
      // 透過している点があれば、背景のない絵として扱う（枠に入れない）
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

  // ---------- 枠の中の置き方 ----------
  // 枠いっぱいに収めたときの大きさ（枠に対する %）。背景のある絵は枠を覆い、透過の絵は枠に収める
  function baseSize(c) {
    const ia = c.w / c.h;
    const cover = !c.alpha;
    const wide = ia > FRAME;
    if (wide === cover) return { w: (100 * ia) / FRAME, h: 100 };
    return { w: 100, h: (100 * FRAME) / ia };
  }
  // 初めの位置：背景のある絵は真ん中、透過の絵は足元を枠の下にそろえる
  function defaults(c) {
    const b = baseSize(c);
    return { scale: 1, x: 0, y: c.alpha ? (100 - b.h) / 2 : 0 };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function place(frame, img, c) {
    const b = baseSize(c);
    frame.classList.toggle('framed', !c.alpha);
    img.style.width = `${b.w}%`;
    img.style.height = `${b.h}%`;
    img.style.left = `${50 + c.x}%`;
    img.style.top = `${50 + c.y}%`;
    img.style.transform = `translate(-50%, -50%) scale(${c.scale})`;
  }

  // ---------- ホーム ----------
  let homeUrl = null;
  function showEmblem(el) {
    el.dataset.art = 'none';
    el.style.removeProperty('--portrait-art');
    el.textContent = '';
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
  async function renderHome() {
    const el = $('portrait');
    if (!el) return;
    const c = conf();
    const blob = c ? await getBlob() : null;
    if (homeUrl) { URL.revokeObjectURL(homeUrl); homeUrl = null; }
    if (!c || !blob) {
      showEmblem(el);
      loadBundled(el);
      return;
    }
    homeUrl = URL.createObjectURL(blob);
    el.style.removeProperty('--portrait-art');
    el.dataset.art = 'photo';
    el.textContent = '';
    const frame = document.createElement('div');
    frame.className = 'portrait-frame';
    const inner = document.createElement('div');
    inner.className = 'portrait-inner';
    const img = document.createElement('img');
    img.className = 'portrait-img';
    img.alt = '';
    img.src = homeUrl;
    inner.append(img);
    frame.append(inner);
    el.append(frame);
    place(frame, img, c);
    labelArt(el, '立ち絵（写真から選んだ画像）');
  }

  // ---------- 設定：選ぶ・合わせる・紋章に戻す ----------
  let draft = null; // 合わせている途中 { blob, w, h, alpha, scale, x, y, url }
  function renderSettings() {
    const has = Boolean(conf());
    $('portrait-state').textContent = has ? '写真から選んだ画像を出しています' : '紋章を出しています（画像を選ぶと、ホームの紋章の代わりに出ます）';
    $('portrait-adjust').hidden = !has;
    $('portrait-reset').hidden = !has;
  }
  function renderDraft() {
    place($('portrait-preview'), $('portrait-preview-img'), draft);
    $('portrait-scale').value = String(Math.round(draft.scale * 100));
    $('portrait-scale-value').textContent = `${Math.round(draft.scale * 100)}%`;
  }
  function openSheet(d) {
    if (draft && draft.url) URL.revokeObjectURL(draft.url);
    draft = { ...d, url: URL.createObjectURL(d.blob) };
    $('portrait-preview-img').src = draft.url;
    $('portrait-sheet-status').textContent = '';
    renderDraft();
    $('portrait-sheet').showModal();
  }
  function closeSheet() {
    $('portrait-sheet').close();
  }

  function bind() {
    $('portrait-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      $('portrait-status').textContent = '';
      try {
        const p = await prepare(file);
        openSheet({ ...p, ...defaults(p) });
      } catch (err) { $('portrait-status').textContent = err.message; }
    });
    $('portrait-adjust').addEventListener('click', async () => {
      const c = conf();
      const blob = c && await getBlob();
      if (!blob) { $('portrait-status').textContent = '画像が見つかりませんでした。もう一度選んでください'; return; }
      openSheet({ ...c, blob });
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
    $('portrait-center').addEventListener('click', () => {
      if (!draft) return;
      Object.assign(draft, defaults(draft));
      renderDraft();
    });
    // 指で動かして位置を合わせる
    const pv = $('portrait-preview');
    let drag = null;
    pv.addEventListener('pointerdown', (e) => {
      if (!draft) return;
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: draft.x, y: draft.y };
      pv.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    pv.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = pv.getBoundingClientRect();
      draft.x = clamp(drag.x + ((e.clientX - drag.sx) / r.width) * 100, -SHIFT_MAX, SHIFT_MAX);
      draft.y = clamp(drag.y + ((e.clientY - drag.sy) / r.height) * 100, -SHIFT_MAX, SHIFT_MAX);
      renderDraft();
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    pv.addEventListener('pointerup', end);
    pv.addEventListener('pointercancel', end);

    $('portrait-cancel').addEventListener('click', closeSheet);
    $('portrait-sheet').addEventListener('close', () => {
      if (draft && draft.url) URL.revokeObjectURL(draft.url);
      draft = null;
    });
    $('portrait-save').addEventListener('click', async () => {
      if (!draft) return;
      try { await putBlob(draft.blob); } catch (err) { $('portrait-sheet-status').textContent = SAVE_FAILED; return; }
      const r = (v) => Math.round(v * 10) / 10;
      const ok = Store.write(DB.portrait, { w: draft.w, h: draft.h, alpha: draft.alpha, scale: r(draft.scale), x: r(draft.x), y: r(draft.y), at: Date.now() });
      if (!ok) { $('portrait-sheet-status').textContent = SAVE_FAILED; return; }
      closeSheet();
      renderSettings();
      renderHome();
    });
  }

  bind();
  renderSettings();
  renderHome();
  return { renderHome, baseSize, defaults };
})();
