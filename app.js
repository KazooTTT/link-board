// 链接画板：粘贴链接 → 图标，拖拽排布，IndexedDB 本地持久化。
// 没有后端，没有同步。数据只在这台机器的这个浏览器里。

const DB_NAME = 'link-board';
const STORE = 'items';
const GROUPS = 'groups';
const DB_VERSION = 2;
const TILE_W = 96;
const TILE_H = 100;
const PAD = 16;

let dbp = null;
let items = [];
let groups = [];
let selected = new Set();
let editing = null;
let drag = null;
let clickTimer = null;
let suppressClick = false;

// ---------------------------------------------------------------- 存储

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GROUPS)) {
        db.createObjectStore(GROUPS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, name = STORE) {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
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

async function loadGroups() {
  const store = await tx('readonly', GROUPS);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putGroup(group) {
  const store = await tx('readwrite', GROUPS);
  return new Promise((resolve, reject) => {
    const req = store.put(group);
    req.onsuccess = () => resolve(group);
    req.onerror = () => reject(req.error);
  });
}

async function removeGroup(id) {
  const store = await tx('readwrite', GROUPS);
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

function iconCandidates(url, custom, extras = []) {
  const host = hostOf(url);
  const list = [];
  const seen = new Set();
  const push = u => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    list.push(u);
  };
  if (custom) push(custom);
  for (const u of extras) push(u);
  // 依次尝试，前一个 404/被墙就换下一个，全挂了退回首字母
  push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
  push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
  push(`https://${host}/favicon.ico`);
  return list;
}

function cleanAutoTitle(title) {
  return String(title || '')
    .replace(/\s*[|·\-–—]\s*[^|·\-–—]{0,40}$/, '')
    .trim()
    .slice(0, 80);
}

function resolveHref(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}

/** 从 HTML 片段解析 title / favicon（供 microlink 失败或信息不全时兜底） */
function parseHeadMeta(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const metaTitle = (sel, attr = 'content') =>
    (doc.querySelector(sel)?.getAttribute(attr) || doc.querySelector(sel)?.textContent || '').trim();
  const title = metaTitle('meta[property="og:title" i]')
    || metaTitle('meta[name="twitter:title" i]')
    || metaTitle('meta[name="title" i]')
    || (doc.querySelector('title')?.textContent || '').trim()
    || metaTitle('meta[name="application-name" i]');

  const icons = [];
  for (const link of doc.querySelectorAll('link[href][rel]')) {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon|shortcut icon|mask-icon)(\s|$)/.test(rel)) continue;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('data:')) continue;
    const url = resolveHref(href, pageUrl);
    if (!url) continue;
    let score = 0;
    if (rel.includes('apple-touch-icon')) score += 120;
    else if (rel.includes('icon')) score += 60;
    const sizes = link.getAttribute('sizes');
    if (sizes && sizes !== 'any') {
      for (const part of sizes.split(/\s+/)) {
        const m = part.match(/^(\d+)x(\d+)$/i);
        if (m) score += Math.min(parseInt(m[1], 10), 512);
      }
    }
    if (/\.(png|webp|svg|jpg|jpeg)(\?|$)/i.test(url)) score += 8;
    icons.push({ url, score });
  }
  icons.sort((a, b) => b.score - a.score);
  const uniq = [];
  const seen = new Set();
  for (const { url } of icons) {
    if (seen.has(url)) continue;
    seen.add(url);
    uniq.push(url);
  }
  return { title: cleanAutoTitle(title), icons: uniq };
}

async function fetchDocumentHtml(url, signal) {
  const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(proxy, { signal });
    if (!res.ok) return '';
    const html = await res.text();
    return html && html.length > 80 ? html.slice(0, 800_000) : '';
  } catch {
    return '';
  }
}

function colorFor(seed) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 52%)`;
}

// ---------------------------------------------------------------- 布局

function nextSlot() {
  const cols = gridCols();
  const n = items.filter(it => !it.group).length;
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

// 一键重排：按当前视觉顺序（先上后下、先左后右）排成规整网格
const ROW_H = 104;
const TOP_Y = 68;

function gridCols() {
  return Math.max(1, Math.floor((window.innerWidth - PAD * 2) / TILE_W));
}

function gridSlot(index) {
  const cols = gridCols();
  return {
    x: PAD + (index % cols) * TILE_W,
    y: TOP_Y + Math.floor(index / cols) * ROW_H,
  };
}

function readingOrder(a, b) {
  const rowA = Math.round((a.y - TOP_Y) / ROW_H);
  const rowB = Math.round((b.y - TOP_Y) / ROW_H);
  if (rowA !== rowB) return rowA - rowB;
  if (a.x !== b.x) return a.x - b.x;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

async function relayout() {
  if (!items.length) { toast('板上还没有链接'); return; }
  const ordered = [...items].sort(readingOrder);
  const boardEl = document.getElementById('board');
  boardEl.classList.add('animating');
  const hasGroups = groups.some(g => items.some(it => it.group === g.id));
  let needed;
  if (hasGroups) {
    needed = layoutUnits(ordered);
  } else {
    ordered.forEach((item, i) => Object.assign(item, gridSlot(i)));
    needed = TOP_Y + Math.ceil(ordered.length / gridCols()) * ROW_H + PAD;
  }
  // 一页装不下时让画板变高、页面可滚动，不把图标排到看不见的地方
  boardEl.style.height = needed > window.innerHeight ? `${needed}px` : '';
  document.body.classList.toggle('scrollable', needed > window.innerHeight);
  render();
  await Promise.all(ordered.map(put));
  setTimeout(() => boardEl.classList.remove('animating'), 260);
  toast(`已重排 ${ordered.length} 个链接`);
}

// 有分组时按「单元」排版：一个分组占一块地方，组员在块内排成小网格
function layoutUnits(ordered) {
  const units = [];
  const seen = new Set();
  for (const it of ordered) {
    if (it.group && groups.some(g => g.id === it.group)) {
      if (seen.has(it.group)) continue;
      seen.add(it.group);
      units.push(ordered.filter(x => x.group === it.group));
    } else {
      units.push([it]);
    }
  }
  const maxRight = window.innerWidth - PAD;
  let x = PAD, y = TOP_Y, rowH = 0;
  for (const unit of units) {
    const n = unit.length;
    const grouped = n > 1 || (n === 1 && unit[0].group);
    const cols = grouped ? Math.min(3, Math.ceil(Math.sqrt(n))) : 1;
    const w = cols * TILE_W + (grouped ? 20 : 0);
    const h = Math.ceil(n / cols) * ROW_H + (grouped ? 30 : 0);
    if (x > PAD && x + w > maxRight) { x = PAD; y += rowH + 20; rowH = 0; }
    unit.forEach((it, i) => {
      it.x = x + (grouped ? 10 : 0) + (i % cols) * TILE_W;
      it.y = y + (grouped ? 30 : 0) + Math.floor(i / cols) * ROW_H;
    });
    x += w + 20;
    rowH = Math.max(rowH, h);
  }
  return y + rowH + PAD;
}

function groupBounds(members) {
  const minX = Math.min(...members.map(m => m.x));
  const minY = Math.min(...members.map(m => m.y));
  const maxX = Math.max(...members.map(m => m.x + TILE_W));
  const maxY = Math.max(...members.map(m => m.y + TILE_H));
  return { x: minX - 10, y: minY - 30, w: maxX - minX + 20, h: maxY - minY + 40 };
}

// 双击保护：第一次点击已经用原生 <a> 打开了，第二次点击（detail>=2）在 click 里吞掉

// 键盘 Enter 用同一个原生打开路径
function openItem(item) {
  if (!item || !item.url) return;
  const el = document.querySelector(`.tile[data-id="${CSS.escape(String(item.id))}"]`);
  if (el) el.click();
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
  const el = document.createElement('a');
  el.className = 'tile';
  el.classList.toggle('selected', selected.has(item.id));
  el.classList.toggle('in-collapsed-group', groups.some(g => g.id === item.group && g.collapsed));
  el.setAttribute('aria-label', item.title || hostOf(item.url));
  el.href = item.url;
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  el.draggable = false;   // 否则原生拖链接会抢掉 pointer 事件
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
  const candidates = iconCandidates(item.url, item.icon, item.icon_alts);
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
  for (const group of groups) {
    const members = items.filter(it => it.group === group.id);
    if (members.length) frag.appendChild(groupEl(group, members));
  }
  for (const item of items) frag.appendChild(tileEl(item));
  board.appendChild(frag);
  emptyEl.hidden = items.length > 0;
  countEl.textContent = items.length ? `${items.length} 个链接` : '';
  applyFilter(document.getElementById('q').value);
}

function applyFilter(q) {
  const needle = String(q || '').trim().toLowerCase();
  for (const el of board.querySelectorAll('.tile')) {
    const item = items.find(it => it.id === el.dataset.id);
    const group = groups.find(g => g.id === item.group);
    const matches = !needle || `${el.dataset.search} ${group?.name || ''}`.toLowerCase().includes(needle);
    el.classList.toggle('hidden', !matches);
    el.classList.toggle('in-collapsed-group', Boolean(group?.collapsed) && !needle);
  }
  for (const el of board.querySelectorAll('.group-frame')) {
    const group = groups.find(g => g.id === el.dataset.group);
    el.classList.toggle('hidden', Boolean(needle) && !items.some(it => it.group === group.id && `${it.title} ${hostOf(it.url)} ${group.name}`.toLowerCase().includes(needle)));
  }
  document.getElementById('group').disabled = !items.some(it => selected.has(it.id));
}

let editingGroup = null;
function openGroupDialog(group = null) {
  if (!group && !items.some(it => selected.has(it.id))) return;
  editingGroup = group;
  document.getElementById('gdlg-title').textContent = group ? '重命名分组' : '新建分组';
  document.getElementById('g-name').value = group?.name || '';
  document.getElementById('gdlg').showModal();
  document.getElementById('g-name').focus();
}
function groupEl(group, members) {
  const el = document.createElement('div');
  el.className = 'group-frame' + (group.collapsed ? ' collapsed' : '');
  el.dataset.group = group.id;
  const box = groupBounds(members);
  Object.assign(el.style, {left: `${box.x}px`, top: `${box.y}px`, width: `${group.collapsed ? 180 : box.w}px`, height: `${group.collapsed ? 100 : box.h}px`});
  const label = document.createElement('button');
  label.className = 'g-label'; label.textContent = group.name;
  label.title = '重命名分组'; label.onclick = () => openGroupDialog(group);
  const count = document.createElement('span'); count.className = 'g-count'; count.textContent = members.length;
  const fold = document.createElement('button'); fold.className = 'g-fold'; fold.textContent = group.collapsed ? '＋' : '−';
  fold.setAttribute('aria-label', `${group.collapsed ? '展开' : '折叠'} ${group.name}`);
  fold.onclick = async () => { group.collapsed = !group.collapsed; await putGroup(group); render(); };
  const del = document.createElement('button'); del.className = 'g-del'; del.textContent = '×'; del.setAttribute('aria-label', `解散 ${group.name}`);
  del.onclick = async () => {
    if (!confirm(`解散“${group.name}”？链接会保留。`)) return;
    for (const it of members) { delete it.group; await put(it); }
    await removeGroup(group.id); groups = groups.filter(g => g.id !== group.id); render();
  };
  el.append(label, count, fold, del);
  return el;
}
document.getElementById('group').onclick = () => openGroupDialog();
document.getElementById('g-cancel').onclick = () => document.getElementById('gdlg').close();
document.getElementById('gdlg-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = document.getElementById('g-name').value.trim();
  if (!name) return;
  const group = editingGroup || { id: crypto.randomUUID(), collapsed: false };
  group.name = name;
  await putGroup(group);
  if (!editingGroup) {
    groups.push(group);
    for (const it of items.filter(it => selected.has(it.id))) { it.group = group.id; await put(it); }
  }
  selected.clear(); document.getElementById('gdlg').close();
  if (editingGroup) render(); else await relayout();
});

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

// 跨域读不到页面 HTML：先 microlink，再 CORS 代理抓 head 解析 title / link[rel*=icon]
async function enrichMeta(item) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let changed = false;
  const applyParsed = parsed => {
    if (!parsed) return;
    if (parsed.title && item.auto) {
      const next = cleanAutoTitle(parsed.title);
      if (next && next !== item.title) {
        item.title = next;
        changed = true;
      }
    }
    if (parsed.icons?.length) {
      if (!item.icon) {
        item.icon = parsed.icons[0];
        changed = true;
      }
      const alts = parsed.icons.filter(u => u !== item.icon).slice(0, 4);
      if (alts.length && JSON.stringify(alts) !== JSON.stringify(item.icon_alts || [])) {
        item.icon_alts = alts;
        changed = true;
      }
    }
  };
  try {
    try {
      const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(item.url)}`, { signal: ctrl.signal });
      if (res.ok) {
        const payload = await res.json();
        const data = payload && payload.data;
        if (data) {
          applyParsed({
            title: data.title,
            icons: data.logo?.url ? [data.logo.url] : [],
          });
        }
      }
    } catch { /* microlink 不可用则走 HTML 解析 */ }

    const needTitle = item.auto;
    const needIcon = !item.icon;
    if (needTitle || needIcon) {
      const html = await fetchDocumentHtml(item.url, ctrl.signal);
      if (html) applyParsed(parseHeadMeta(html, item.url));
    }
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
  if (!item || ev.shiftKey) return;
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

board.addEventListener('pointerup', async ev => {
  if (!drag) return;
  const { el, item, moved } = drag;
  drag = null;
  el.classList.remove('dragging');
  if (moved) {
    suppressClick = true;   // 拖完不要跳转
    await put(item);
  }
});

// 拖拽后不要触发链接跳转；双击的第二次点击（detail>=2）也吞掉
board.addEventListener('click', ev => {
  const el = ev.target.closest('.tile');
  if (!el) { document.activeElement?.blur?.(); return; }
  if (ev.shiftKey) {
    ev.preventDefault();
    if (selected.has(el.dataset.id)) selected.delete(el.dataset.id); else selected.add(el.dataset.id);
    render(); return;
  }
  if (suppressClick || ev.detail > 1) {
    ev.preventDefault();
    suppressClick = false;
  }
});

board.addEventListener('dblclick', ev => {
  const el = ev.target.closest('.tile');
  if (!el) return;
  ev.preventDefault();
  // 双击不编辑，避免和单击打开冲突；编辑走右键或 E
});

// 右键 = 编辑（替代原来的双击入口）
board.addEventListener('contextmenu', ev => {
  const el = ev.target.closest('.tile');
  if (!el) return;
  ev.preventDefault();
  clearTimeout(clickTimer);
  const item = items.find(it => it.id === el.dataset.id);
  if (item) openDialog(item);
});

board.addEventListener('keydown', ev => {
  const el = ev.target.closest('.tile');
  if (!el) return;
  const item = items.find(it => it.id === el.dataset.id);
  if (!item) return;
  if (ev.key === 'Enter') { ev.preventDefault(); suppressClick = false; el.click(); }
  if (ev.key === 'e' || ev.key === 'E') { ev.preventDefault(); openDialog(item); }
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

board.addEventListener('pointerdown', () => { suppressClick = false; });
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

document.getElementById('relayout').onclick = () => relayout();

// R 一键重排（输入框里打字时不触发）
window.addEventListener('keydown', ev => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (ev.key === 'g' || ev.key === 'G') { ev.preventDefault(); openGroupDialog(); }
  if (ev.key === 'Escape') { selected.clear(); render(); }
  if (ev.key === 'r' || ev.key === 'R') { ev.preventDefault(); relayout(); }
});

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

if (typeof window !== 'undefined') {
  window.__lb = { parseHeadMeta, cleanAutoTitle };
}

(async function init() {
  try {
    items = await loadAll();
    groups = await loadGroups();
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
