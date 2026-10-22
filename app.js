// 链接画板：粘贴链接 → 图标，拖拽排布，IndexedDB 本地持久化。
// 没有后端，没有同步。数据只在这台机器的这个浏览器里。

const DB_NAME = 'link-board';
const STORE = 'items';
const TILE_W = 96;
const PAD = 16;

let dbp = null;
let items = [];
let editing = null;
let drag = null;

// ---------------------------------------------------------------- 存储

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode) {
  const db = await openDB();
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function loadAll() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function put(item) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

async function remove(id) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- 解析

function parseURL(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = raw.match(/https?:\/\/[^\s<>"']+/i);
  const candidate = m ? m[0] : (/^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(raw) ? 'https://' + raw : '');
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function prettyName(url, title) {
  if (title && title.trim()) return title.trim();
  const host = hostOf(url);
  const first = host.split('.')[0] || host;
  return first.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function iconCandidates(url, custom) {
  const host = hostOf(url);
  const list = [];
  if (custom) list.push(custom);
  // 依次尝试，前一个 404/被墙就换下一个，全挂了退回首字母
  list.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
  list.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
  list.push(`https://${host}/favicon.ico`);
  return list;
}

function colorFor(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 52%)`;
}

// ---------------------------------------------------------------- 布局

function nextSlot() {
  const cols = Math.max(1, Math.floor((window.innerWidth - PAD * 2) / TILE_W));
  const n = items.length;
  return {
    x: PAD + (n % cols) * TILE_W,
    y: 68 + Math.floor(n / cols) * 104,
  };
}

function clampPos(x, y) {
  return {
    x: Math.max(0, Math.min(window.innerWidth - 72, x)),
    y: Math.max(48, Math.min(window.innerHeight - 72, y)),
  };
}

// ---------------------------------------------------------------- 渲染

const board = document.getElementById('board');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('on'), 1800);
}

function tileEl(item) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = String(item.id);
  el.dataset.url = item.url;
  el.dataset.search = `${item.title} ${hostOf(item.url)}`.toLowerCase();
  el.tabIndex = 0;
  el.style.left = `${item.x}px`;
  el.style.top = `${item.y}px`;
  el.title = `${item.title}\n${item.url}`;

  const icon = document.createElement('div');
  icon.className = 'icon';
  const letter = (item.title || hostOf(item.url) || '?').trim().charAt(0).toUpperCase();
  icon.style.background = item.color || colorFor(item.url);
  icon.textContent = letter;

  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  const candidates = iconCandidates(item.url, item.icon);
  let idx = 0;
  img.onload = () => {
    if (!img.naturalWidth) return;  // 有些站点会返回空图
    icon.textContent = '';
    icon.appendChild(img);
  };
  img.onerror = () => {
    idx += 1;
    if (idx < candidates.length) img.src = candidates[idx];
  };
  img.src = candidates[0];

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = item.title || hostOf(item.url);

  el.append(icon, label);
  return el;
}

function render() {
  board.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(tileEl(item));
  board.appendChild(frag);
  emptyEl.hidden = items.length > 0;
  countEl.textContent = items.length ? `${items.length} 个链接` : '';
  applyFilter(document.getElementById('q').value);
}

function applyFilter(q) {
  const needle = String(q || '').trim().toLowerCase();
  for (const el of board.children) {
    el.classList.toggle('hidden', Boolean(needle) && !el.dataset.search.includes(needle));
  }
}

// ---------------------------------------------------------------- 增删改

async function addLink(url, opts = {}) {
  const u = typeof url === 'string' ? parseURL(url) : url;
  if (!u) return null;
  // 同一个链接不重复添加，改成把它挪到最前面
  const dup = items.find(it => it.url === u.href);
  if (dup && !opts.force) {
    toast('这个链接已经在板上了');
    dup.x = PAD; dup.y = 68;
    await put(dup); render();
    return dup;
  }
  const slot = opts.pos ? clampPos(opts.pos.x, opts.pos.y) : nextSlot();
  const item = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    url: u.href,
    title: prettyName(u.href, opts.title),
    auto: !opts.title,          // 名字还是自动推的，后续可以被元数据覆盖
    icon: opts.icon || '',
    color: opts.color || '',
    x: slot.x,
    y: slot.y,
    created_at: new Date().toISOString(),
  };
  items.push(item);
  await put(item);
  render();
  if (!opts.title) enrichMeta(item);   // 后台补真实标题/图标，失败不影响
  return item;
}

// 页面标题跨域读不到，借 microlink 的公开接口补一次；拿不到就保持域名推出来的名字
async function enrichMeta(item) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(item.url)}`, { signal: ctrl.signal });
    if (!res.ok) return;
    const payload = await res.json();
    const data = payload && payload.data;
    if (!data) return;
    let changed = false;
    if (data.title && item.auto) {
      item.title = String(data.title).replace(/\s*[|·-]\s*[^|·-]{0,20}$/, '').trim().slice(0, 80) || item.title;
      changed = true;
    }
    if (data.logo && data.logo.url) { item.icon = data.logo.url; changed = true; }
    if (changed) { await put(item); render(); }
  } catch {
    /* 离线或被墙：用域名和字母兜底，不打扰用户 */
  } finally {
    clearTimeout(timer);
  }
}

function openDialog(item) {
  editing = item;
  const dlg = document.getElementById('dlg');
  document.getElementById('dlg-title').textContent = item ? '编辑链接' : '添加链接';
  document.getElementById('f-title').value = item ? item.title : '';
  document.getElementById('f-url').value = item ? item.url : '';
  document.getElementById('f-icon').value = item ? item.icon : '';
  document.getElementById('f-color').value = item ? item.color : '';
  const previewIcon = document.getElementById('dlg-icon');
  previewIcon.textContent = (item ? item.title : '?').charAt(0).toUpperCase();
  previewIcon.style.background = (item && item.color) || colorFor(item ? item.url : 'x');
  document.getElementById('dlg-host').textContent = item ? hostOf(item.url) : '';
  dlg.showModal();
  document.getElementById('f-title').focus();
}

document.getElementById('dlg-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const title = document.getElementById('f-title').value.trim();
  const urlRaw = document.getElementById('f-url').value.trim();
  const icon = document.getElementById('f-icon').value.trim();
  const color = document.getElementById('f-color').value;
  const u = parseURL(urlRaw);
  if (!u) { toast('链接格式不对'); return; }
  if (editing) {
    Object.assign(editing, { title: title || prettyName(u.href), url: u.href, icon, color, auto: false });
    await put(editing);
  } else {
    await addLink(u.href, { title, icon, color, force: true });
  }
  document.getElementById('dlg').close();
  render();
});

document.getElementById('f-cancel').onclick = () => document.getElementById('dlg').close();
document.getElementById('f-del').onclick = async () => {
  if (!editing) return;
  await remove(editing.id);
  items = items.filter(it => it.id !== editing.id);
  document.getElementById('dlg').close();
  render();
  toast('已删除');
};

document.getElementById('add').onclick = () => openDialog(null);

// ---------------------------------------------------------------- 拖拽

board.addEventListener('pointerdown', ev => {
  const el = ev.target.closest('.tile');
  if (!el) return;
  const item = items.find(it => it.id === el.dataset.id);
  if (!item) return;
  drag = { el, item, dx: ev.clientX - item.x, dy: ev.clientY - item.y, moved: false };
  el.setPointerCapture(ev.pointerId);
  el.classList.add('dragging');
});

board.addEventListener('pointermove', ev => {
  if (!drag) return;
  const pos = clampPos(ev.clientX - drag.dx, ev.clientY - drag.dy);
  drag.item.x = pos.x;
  drag.item.y = pos.y;
  drag.el.style.left = `${pos.x}px`;
  drag.el.style.top = `${pos.y}px`;
  drag.moved = true;
});

board.addEventListener('pointerup', async () => {
  if (!drag) return;
  const { el, item, moved } = drag;
  drag = null;
  el.classList.remove('dragging');
  if (moved) await put(item);
});

board.addEventListener('dblclick', ev => {
  const el = ev.target.closest('.tile');
  if (!el) return;
  const item = items.find(it => it.id === el.dataset.id);
  if (item) openDialog(item);
});

board.addEventListener('keydown', ev => {
  const el = ev.target.closest('.tile');
  if (!el) return;
  const item = items.find(it => it.id === el.dataset.id);
  if (!item) return;
  if (ev.key === 'Enter') { ev.preventDefault(); openDialog(item); }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    remove(item.id).then(() => {
      items = items.filter(it => it.id !== item.id);
      render();
      toast('已删除');
    });
  }
  if (ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    const step = ev.shiftKey ? 22 : 6;
    if (ev.key === 'ArrowLeft') item.x -= step;
    if (ev.key === 'ArrowRight') item.x += step;
    if (ev.key === 'ArrowUp') item.y -= step;
    if (ev.key === 'ArrowDown') item.y += step;
    const pos = clampPos(item.x, item.y);
    item.x = pos.x; item.y = pos.y;
    el.style.left = `${item.x}px`; el.style.top = `${item.y}px`;
    put(item);
  }
});

// 点空白处关掉焦点
board.addEventListener('click', ev => {
  if (!ev.target.closest('.tile')) document.activeElement?.blur?.();
});

// ---------------------------------------------------------------- 粘贴

function extractURL(text) {
  const u = parseURL(text);
  return u ? u.href : null;
}

window.addEventListener('paste', async ev => {
  const text = ev.clipboardData?.getData('text/plain') || '';
  if (!text.trim()) return;
  const href = extractURL(text);
  if (!href) return;
  ev.preventDefault();
  const before = items.length;
  await addLink(href);
  if (items.length > before) toast('已添加');
});

// 有些浏览器/输入法不派发 paste，退而求其次：拖入文本/链接
window.addEventListener('drop', async ev => {
  const text = ev.dataTransfer?.getData('text/uri-list') || ev.dataTransfer?.getData('text/plain') || '';
  if (!text.trim()) return;
  const href = extractURL(text);
  if (!href) return;
  ev.preventDefault();
  await addLink(href, { pos: { x: ev.clientX - 40, y: ev.clientY - 40 } });
});

document.getElementById('q').addEventListener('input', ev => applyFilter(ev.currentTarget.value));

// 窗口改大小时把跑出边界的图标拉回来
window.addEventListener('resize', async () => {
  let dirty = false;
  for (const item of items) {
    const pos = clampPos(item.x, item.y);
    if (pos.x !== item.x || pos.y !== item.y) {
      item.x = pos.x; item.y = pos.y; dirty = true;
      await put(item);
    }
  }
  if (dirty) render();
});

// ---------------------------------------------------------------- 启动

(async function init() {
  try {
    items = await loadAll();
    items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    // 老数据没有坐标的给个位置
    let changed = false;
    items.forEach((it, i) => {
      if (typeof it.x !== 'number' || typeof it.y !== 'number') {
        it.x = PAD + (i % 8) * TILE_W;
        it.y = 68 + Math.floor(i / 8) * 104;
        changed = true;
      }
    });
    if (changed) await Promise.all(items.map(put));
    render();
  } catch (err) {
    document.getElementById('empty').innerHTML =
      `<b>本地存储打不开</b><span>${String(err)}</span>`;
  }
})();
