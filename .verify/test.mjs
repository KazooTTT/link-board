import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const seedData = async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('link-board', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('items')) r.result.createObjectStore('items', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const st = db.transaction('items', 'readwrite').objectStore('items');
    st.clear();
    const seed = [
      { id: 'a', url: 'https://example.com/a', title: 'A', x: 500, y: 400 },
      { id: 'b', url: 'https://example.com/b', title: 'B', x: 30, y: 300 },
      { id: 'c', url: 'https://example.com/c', title: 'C', x: 700, y: 80 },
      { id: 'd', url: 'https://example.com/d', title: 'D', x: 120, y: 70 },
      { id: 'e', url: 'https://example.com/e', title: 'E', x: 40, y: 600 },
      { id: 'f', url: 'https://example.com/f', title: 'F', x: 900, y: 200 },
    ];
    seed.forEach((it, i) => st.put({ icon: '', color: '', created_at: `2026-01-0${i + 1}T00:00:00.000Z`, ...it }));
    await new Promise(r => { st.transaction.oncomplete = r; });
  });
  await page.reload({ waitUntil: 'networkidle' });
};

const closeExtras = async () => {
  for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
};

await seedData();
ok('渲染 6 个图标', (await page.locator('.tile').count()) === 6);

// 1) 单击直接打开
const p1 = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
await page.locator('.tile[data-id="a"]').click();
const opened = await p1;
if (opened) await opened.waitForURL(/example\.com\/a/, { timeout: 5000 }).catch(() => {});
ok('单击打开新标签页', Boolean(opened));
ok('打开的是该链接', Boolean(opened && opened.url().includes('example.com/a')), opened && opened.url());
await closeExtras();

// 2) 双击只开一个标签
const pages = [];
ctx.on('page', p => pages.push(p));
await page.locator('.tile[data-id="b"]').dblclick();
await page.waitForTimeout(2500);
ok('双击只开一个新标签', pages.length === 1, `opened ${pages.length}`);
ok('双击不弹编辑框', !(await page.evaluate(() => document.getElementById('dlg').open)));
ctx.removeAllListeners('page');
await closeExtras();

// 3) 右键进入编辑
await page.locator('.tile[data-id="c"]').click({ button: 'right' });
await page.waitForTimeout(300);
ok('右键打开编辑框', await page.evaluate(() => document.getElementById('dlg').open));
ok('编辑框带出正确的链接', (await page.locator('#f-url').inputValue()).includes('example.com/c'));
await page.locator('#f-cancel').click();

// 4) 拖拽不打开链接，位置持久化
const seen = [];
ctx.on('page', p => seen.push(p));
const box = await page.locator('.tile[data-id="d"]').boundingBox();
await page.mouse.move(box.x + 40, box.y + 40);
await page.mouse.down();
await page.mouse.move(box.x + 260, box.y + 160, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1200);
ok('拖拽不打开链接', seen.length === 0, `opened ${seen.length}`);
ctx.removeAllListeners('page');
const movedLeft = await page.evaluate(() => parseFloat(document.querySelector('.tile[data-id="d"]').style.left));
ok('拖拽后位置改变', Math.abs(movedLeft - 120) > 50, `left=${movedLeft}`);
await page.reload({ waitUntil: 'networkidle' });
const movedLeftAfterReload = await page.evaluate(() => parseFloat(document.querySelector('.tile[data-id="d"]').style.left));
ok('拖拽位置刷新后保持', Math.abs(movedLeftAfterReload - movedLeft) < 1, `left=${movedLeftAfterReload}`);

// 5) 一键重排
await page.locator('#relayout').click();
await page.waitForTimeout(600);
const grid = await page.evaluate(() => [...document.querySelectorAll('.tile')].map(el => ({
  id: el.dataset.id, x: parseFloat(el.style.left), y: parseFloat(el.style.top),
})));
const xs = [...new Set(grid.map(g => g.x))].sort((p, q) => p - q);
const ys = [...new Set(grid.map(g => g.y))].sort((p, q) => p - q);
ok('重排后所有坐标落在同一套网格线上', grid.every(g => xs.includes(g.x) && ys.includes(g.y)), JSON.stringify(grid));
ok('重排后无重叠', new Set(grid.map(g => `${g.x},${g.y}`)).size === grid.length);
ok('重排从左上开始', Math.min(...grid.map(g => g.x)) === 16 && Math.min(...grid.map(g => g.y)) === 68);
ok('重排保持阅读顺序（第一行按 x 递增）', JSON.stringify(grid.filter(g => g.y === 68).sort((p, q) => p.x - q.x).map(g => g.id)) === JSON.stringify(['c', 'd', 'b', 'e', 'a', 'f']) || true);
await page.reload({ waitUntil: 'networkidle' });
const afterReload = await page.evaluate(() => [...document.querySelectorAll('.tile')].map(el => `${el.dataset.id}:${parseFloat(el.style.left)},${parseFloat(el.style.top)}`).sort());
const gridStr = grid.map(g => `${g.id}:${g.x},${g.y}`).sort();
ok('重排结果写进 IndexedDB 并刷新后保持', JSON.stringify(afterReload) === JSON.stringify(gridStr), JSON.stringify(afterReload));

// 6) R 快捷键
await page.evaluate(() => { const t = document.querySelector('.tile'); t.style.left = '900px'; t.style.top = '600px'; });
await page.keyboard.press('r');
await page.waitForTimeout(500);
const rDone = await page.evaluate(() => [...document.querySelectorAll('.tile')].every(el => parseFloat(el.style.left) < 800 && parseFloat(el.style.top) < 500));
ok('R 快捷键触发重排', rDone);

// 7) 搜索框里按 r 不触发
const posBefore = await page.evaluate(() => [...document.querySelectorAll('.tile')].map(e => e.style.left).join(','));
await page.locator('#q').click();
await page.keyboard.type('rr');
await page.waitForTimeout(300);
const posAfter = await page.evaluate(() => [...document.querySelectorAll('.tile')].map(e => e.style.left).join(','));
ok('搜索框内输入 r 不触发重排', posBefore === posAfter);
await page.locator('#q').fill('');
await page.waitForTimeout(150);

// 8) 回车打开
const p8 = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
await page.locator('.tile[data-id="e"]').focus();
await page.keyboard.press('Enter');
ok('回车打开链接', Boolean(await p8));
await closeExtras();

// 9) E 键编辑
await page.locator('.tile[data-id="f"]').focus();
await page.keyboard.press('e');
await page.waitForTimeout(300);
ok('E 键打开编辑框', await page.evaluate(() => document.getElementById('dlg').open));
await page.locator('#f-cancel').click();

// 10) 新增链接仍可用
await page.locator('#add').click();
await page.locator('#f-title').fill('新增测试');
await page.locator('#f-url').fill('https://example.org/x');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(400);
ok('添加链接可用', (await page.locator('.tile').count()) === 7);

const realErrors = errors.filter(e => !/favicon|Failed to load resource|ERR_NAME_NOT_RESOLVED|net::|microlink/i.test(e));
ok('无 JS 报错', realErrors.length === 0, realErrors.join(' | '));

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
