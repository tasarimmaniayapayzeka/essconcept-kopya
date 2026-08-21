// Static mirror of https://essconcept.com.tr/ — frontend-only copy (no login/admin/backend).
'use strict';
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://essconcept.com.tr';
const HOST = 'essconcept.com.tr';
const OUT = path.join(__dirname, 'site');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIRROR_EXTERNAL_HOSTS = new Set([
  'fonts.googleapis.com', 'fonts.gstatic.com', 'use.fontawesome.com',
  'cdnjs.cloudflare.com', 'ajax.googleapis.com', 'unpkg.com', 'cdn.jsdelivr.net',
  'demo.archiwp.com',
]);

const EXCLUDE_RE = [
  /^\/wp-admin\//, /^\/wp-login\.php/, /^\/my-account\//, /^\/cart\//, /^\/checkout\//,
  /^\/wp-json\b/, /^\/xmlrpc\.php/, /^\/feed\/?$/, /\/feed\/$/, /^\/wp-cron\.php/,
  /replytocom=/, /wc-ajax=/, /^\/\?add-to-cart=/, /^\/wp-content\/plugins\/.*\/readme/i,
];

const ASSET_EXT = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp4', '.webm', '.ogv', '.mp3', '.pdf', '.json', '.xml', '.txt',
]);

const TEXT_EXT = new Set(['.css', '.js', '.svg', '.json', '.xml', '.txt', '.html', '.htm']);

const stats = { pages: 0, assets: 0, external: 0, failed: [] };
const visitedPages = new Set();
const pageQueue = ['/'];
const assetQueue = new Map(); // url -> {isCss}
const externalQueue = new Map(); // url -> {isCss}
const savedFiles = new Set();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isExcluded(pathname, search) {
  const full = pathname + (search || '');
  return EXCLUDE_RE.some((re) => re.test(full));
}

function safeUrl(raw, base) {
  try {
    if (!raw) return null;
    if (raw.startsWith('data:') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:') || raw.startsWith('#')) return null;
    return new URL(raw, base);
  } catch {
    return null;
  }
}

function localPathForPage(u) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) return path.join(OUT, p, 'index.html');
  const ext = path.extname(p);
  if (ext === '') return path.join(OUT, p + '/', 'index.html');
  return path.join(OUT, p);
}

function localPathForAsset(u) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  return path.join(OUT, p);
}

function localPathForExternal(u) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/') || p === '') p += 'index';
  if (u.search) {
    // Encode query into filename so cache-busted / dynamic (Google Fonts) URLs don't collide.
    const q = Buffer.from(u.search).toString('base64url').slice(0, 24);
    const ext = path.extname(p) || '.css';
    p = p.replace(new RegExp(ext.replace('.', '\\.') + '$'), `.${q}${ext}`);
  }
  return path.join(OUT, '_external', u.hostname, p);
}

async function fetchRaw(urlStr, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(urlStr, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
      return res;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function replaceAllPrefixes(content, host, localPrefix) {
  let out = content;
  const forms = [
    `https://${host}`, `http://${host}`, `//${host}`,
    `https:\\/\\/${host}`, `http:\\/\\/${host}`, `\\/\\/${host}`,
  ];
  for (const f of forms) {
    if (out.includes(f)) out = out.split(f).join(localPrefix);
  }
  return out;
}

function extractTagRefs(html) {
  const linkHrefs = [];
  const scriptSrcs = [];
  const imgRefs = [];
  const cssUrls = [];
  const aHrefs = [];

  let m;
  const KEEP_RELS = new Set(['stylesheet', 'icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'preload', 'manifest', 'mask-icon']);
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    // Skip metadata-only links (shortlink/canonical/oembed/pingback/RSD/api.w.org/...) — these
    // are WP `?p=ID`-style query URLs that 30x-redirect back to the *current* page; if followed,
    // every page's own shortlink collapses to the same bare "/" local path and clobbers index.html.
    const relM = /\brel=["']([^"']+)["']/i.exec(tag);
    const rel = relM ? relM[1].toLowerCase() : '';
    if (!KEEP_RELS.has(rel)) continue;
    const hrefM = /href=["']([^"']+)["']/i.exec(tag);
    if (hrefM) linkHrefs.push(hrefM[1]);
  }

  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = scriptRe.exec(html))) scriptSrcs.push(m[1]);

  const imgRe = /<(?:img|source|video|audio)\b[^>]*>/gi;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const attrRe = /\b(?:src|poster|data-src|data-lazyload|data-thumb|data-bg-image|data-bg|data-background|data-full-url)=["']([^"']+)["']/gi;
    let am;
    while ((am = attrRe.exec(tag))) imgRefs.push(am[1]);
    const srcsetRe = /\bsrcset=["']([^"']+)["']/i.exec(tag);
    if (srcsetRe) {
      srcsetRe[1].split(',').forEach((part) => {
        const u = part.trim().split(/\s+/)[0];
        if (u) imgRefs.push(u);
      });
    }
  }
  // Any other stray data-bg / data-lazyload / srcset attrs outside img/source (divs etc.)
  const strayRe = /\b(?:data-bg|data-lazyload|data-thumb|data-bg-image|data-background)=["']([^"']+)["']/gi;
  while ((m = strayRe.exec(html))) imgRefs.push(m[1]);
  const strayStyleRe = /style=["'][^"']*url\(\s*['"]?([^'")]+)['"]?\s*\)[^"']*["']/gi;
  while ((m = strayStyleRe.exec(html))) cssUrls.push(m[1]);

  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleBlockRe.exec(html))) {
    const cssUrlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    let cm;
    while ((cm = cssUrlRe.exec(m[1]))) cssUrls.push(cm[1]);
  }

  const aRe = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
  while ((m = aRe.exec(html))) aHrefs.push(m[1]);

  return { linkHrefs, scriptSrcs, imgRefs, cssUrls, aHrefs };
}

function extractCssRefs(css) {
  const urls = [];
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let m;
  while ((m = urlRe.exec(css))) urls.push(m[1]);
  const importRe = /@import\s+["']([^"']+)["']/gi;
  while ((m = importRe.exec(css))) urls.push(m[1]);
  return urls;
}

function queueAsset(u, isCss) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  // A bare "/" is always a page (the homepage), never a real CSS/JS/image/font asset — treating
  // it as one (e.g. via a stray shortlink/oembed query URL) would clobber index.html on fetch.
  if (u.pathname === '/') return;
  if (u.hostname === HOST) {
    if (isExcluded(u.pathname, u.search)) return;
    const key = u.origin + u.pathname + u.search;
    if (!assetQueue.has(key)) assetQueue.set(key, { url: u, isCss });
  } else if (MIRROR_EXTERNAL_HOSTS.has(u.hostname)) {
    const key = u.origin + u.pathname + u.search;
    if (!externalQueue.has(key)) externalQueue.set(key, { url: u, isCss });
  }
}

function queuePageLink(u) {
  if (u.hostname !== HOST) return;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  if (isExcluded(u.pathname, u.search)) return;
  const norm = u.pathname + (u.search || '');
  if (visitedPages.has(norm)) return;
  const ext = path.extname(u.pathname);
  if (ext && ext !== '.html' && ext !== '.htm') {
    queueAsset(u, ext === '.css');
    return;
  }
  visitedPages.add(norm);
  pageQueue.push(norm);
}

async function processPage(pagePath) {
  const u = new URL(pagePath, ORIGIN);
  const res = await fetchRaw(u.href).catch((e) => { stats.failed.push([u.href, String(e)]); return null; });
  if (!res) return;
  if (!res.ok) { stats.failed.push([u.href, 'HTTP ' + res.status]); return; }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return;
  let html = await res.text();

  const { linkHrefs, scriptSrcs, imgRefs, cssUrls, aHrefs } = extractTagRefs(html);
  for (const raw of linkHrefs) { const ru = safeUrl(raw, u.href); if (ru) queueAsset(ru, path.extname(ru.pathname) === '.css'); }
  for (const raw of scriptSrcs) { const ru = safeUrl(raw, u.href); if (ru) queueAsset(ru, false); }
  for (const raw of imgRefs) { const ru = safeUrl(raw, u.href); if (ru) queueAsset(ru, false); }
  for (const raw of cssUrls) { const ru = safeUrl(raw, u.href); if (ru) queueAsset(ru, false); }
  for (const raw of aHrefs) { const ru = safeUrl(raw, u.href); if (ru) queuePageLink(ru); }

  const filePath = localPathForPage(u);
  ensureDir(filePath);
  fs.writeFileSync(filePath, html, 'utf8');
  savedFiles.add(filePath);
  stats.pages++;
  process.stdout.write(`PAGE  ${u.pathname}\n`);
}

async function processAsset(entry, isExternal) {
  const { url: u, isCss } = entry;
  const res = await fetchRaw(u.href).catch((e) => { stats.failed.push([u.href, String(e)]); return null; });
  if (!res) return;
  if (!res.ok) { stats.failed.push([u.href, 'HTTP ' + res.status]); return; }
  const ct = res.headers.get('content-type') || '';
  const ext = path.extname(u.pathname).toLowerCase();
  const treatAsCss = isCss || ct.includes('text/css') || ext === '.css';
  const isText = treatAsCss || TEXT_EXT.has(ext) || ct.includes('text/') || ct.includes('javascript') || ct.includes('json') || ct.includes('svg');

  const filePath = isExternal ? localPathForExternal(u) : localPathForAsset(u);
  ensureDir(filePath);

  if (isText) {
    const text = await res.text();
    fs.writeFileSync(filePath, text, 'utf8');
    if (treatAsCss) {
      const refs = extractCssRefs(text);
      for (const raw of refs) {
        const ru = safeUrl(raw, u.href);
        if (ru) queueAsset(ru, false);
      }
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
  }
  savedFiles.add(filePath);
  if (isExternal) stats.external++; else stats.assets++;
  process.stdout.write(`${isExternal ? 'EXT  ' : 'ASSET'} ${u.hostname}${u.pathname}\n`);
}

async function runPool(items, worker, concurrency) {
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const my = items[idx++];
      await worker(my);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // BFS pages (sequential queue growth, small concurrency per wave)
  visitedPages.add('/');
  while (pageQueue.length) {
    const wave = pageQueue.splice(0, pageQueue.length);
    await runPool(wave, processPage, 5);
  }
  console.log(`\n-- pages done: ${stats.pages} --\n`);

  // Assets (may enqueue more nested asset refs from CSS, so loop until drained)
  let round = 0;
  while (assetQueue.size || externalQueue.size) {
    round++;
    const localBatch = Array.from(assetQueue.values());
    assetQueue.clear();
    const extBatch = Array.from(externalQueue.values());
    externalQueue.clear();
    console.log(`-- asset round ${round}: ${localBatch.length} local, ${extBatch.length} external --`);
    await runPool(localBatch, (e) => processAsset(e, false), 8);
    await runPool(extBatch, (e) => processAsset(e, true), 8);
  }

  // Rewrite pass: make all references root-relative / local so the mirror is self-contained.
  const allFiles = Array.from(savedFiles);
  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let content = fs.readFileSync(f, 'utf8');
    const original = content;
    content = replaceAllPrefixes(content, HOST, '');
    for (const host of MIRROR_EXTERNAL_HOSTS) {
      content = replaceAllPrefixes(content, host, `/_external/${host}`);
    }
    if (content !== original) fs.writeFileSync(f, content, 'utf8');
  }

  console.log(`\nDONE. pages=${stats.pages} assets=${stats.assets} external=${stats.external} failed=${stats.failed.length}`);
  if (stats.failed.length) {
    fs.writeFileSync(path.join(__dirname, 'mirror-failed.json'), JSON.stringify(stats.failed, null, 2));
    console.log('See mirror-failed.json for failed URLs.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
