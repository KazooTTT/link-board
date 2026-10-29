export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function cleanAutoTitle(title) {
  return String(title || '')
    .replace(/\s*[|·\-–—]\s*[^|·\-–—]{0,40}$/, '')
    .trim()
    .slice(0, 200);
}

function resolveHref(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}

export function parseHeadMeta(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pick = (sel, attr = 'content') =>
    (doc.querySelector(sel)?.getAttribute(attr) || doc.querySelector(sel)?.textContent || '').trim();
  const title = pick('meta[property="og:title" i]')
    || pick('meta[name="twitter:title" i]')
    || pick('meta[name="title" i]')
    || (doc.querySelector('title')?.textContent || '').trim()
    || pick('meta[name="application-name" i]');

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

export function iconCandidates(url, custom, extras = []) {
  const host = hostOf(url);
  const list = [];
  const seen = new Set();
  const push = u => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    list.push(u);
  };
  if (custom) push(custom);
  for (const u of extras || []) push(u);
  if (host) {
    push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
    push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
    push(`https://${host}/favicon.ico`);
  }
  return list;
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

function applyParsed(link, parsed) {
  if (!parsed) return false;
  let changed = false;
  if (parsed.title && link.autoTitle) {
    const next = cleanAutoTitle(parsed.title);
    if (next && next !== link.title) {
      link.title = next;
      changed = true;
    }
  }
  if (parsed.icons?.length) {
    if (!link.icon) {
      link.icon = parsed.icons[0];
      changed = true;
    }
    const alts = parsed.icons.filter(u => u !== link.icon).slice(0, 4);
    const prev = JSON.stringify(link.iconAlts || []);
    if (alts.length && JSON.stringify(alts) !== prev) {
      link.iconAlts = alts;
      changed = true;
    }
  }
  return changed;
}

/** 后台补全标题与 favicon；onUpdate 在变更后调用（例如 save + render） */
export async function enrichLink(link, onUpdate) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let changed = false;
  try {
    try {
      const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(link.url)}`, { signal: ctrl.signal });
      if (res.ok) {
        const payload = await res.json();
        const data = payload?.data;
        if (data) {
          changed = applyParsed(link, {
            title: data.title,
            icons: data.logo?.url ? [data.logo.url] : [],
          }) || changed;
        }
      }
    } catch { /* microlink 不可用 */ }

    const needTitle = link.autoTitle;
    const needIcon = !link.icon;
    if (needTitle || needIcon) {
      const html = await fetchDocumentHtml(link.url, ctrl.signal);
      if (html) changed = applyParsed(link, parseHeadMeta(html, link.url)) || changed;
    }
    if (changed && onUpdate) onUpdate(link);
  } catch {
    /* 离线兜底：保持域名标题与字母图标 */
  } finally {
    clearTimeout(timer);
  }
}
