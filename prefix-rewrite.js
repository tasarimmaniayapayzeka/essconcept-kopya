// Builds docs/ from site/ with a "/essconcept-kopya" path prefix on every root-relative
// reference, so the mirror works correctly when served from a GitHub Pages project subpath
// (https://<user>.github.io/essconcept-kopya/) instead of a domain root. site/ itself is left
// untouched (still correct for the local root-served preview via server.js).
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'site');
const DST = path.join(__dirname, 'docs');
const PREFIX = '/essconcept-kopya';
const TEXT_EXT = new Set(['.css', '.js', '.svg', '.json', '.xml', '.txt', '.html', '.htm']);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

const ATTR_NAMES = ['href', 'src', 'poster', 'action', 'data-src', 'data-lazyload', 'data-thumb', 'data-bg-image', 'data-bg', 'data-background', 'data-full-url'];
const attrRe = new RegExp(`\\b(${ATTR_NAMES.join('|')})=(["'])(\\/(?!\\/)[^"']*)\\2`, 'gi');

function prefixIfRootRelative(u) {
  return (u.startsWith('/') && !u.startsWith('//')) ? PREFIX + u : u;
}

function rewrite(content) {
  let out = content.replace(attrRe, (whole, attr, q, val) => `${attr}=${q}${PREFIX}${val}${q}`);
  out = out.replace(/\bsrcset=(["'])([^"']+)\1/gi, (whole, q, val) => {
    const rewritten = val.split(',').map((part) => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const urlPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
      return prefixIfRootRelative(urlPart) + rest;
    }).join(', ');
    return `srcset=${q}${rewritten}${q}`;
  });
  out = out.replace(/url\(\s*(['"]?)(\/(?!\/)[^'")]*)\1\s*\)/gi, (whole, q, val) => `url(${q}${PREFIX}${val}${q})`);
  out = out.replace(/@import\s+(["'])(\/(?!\/)[^"']*)\1/gi, (whole, q, val) => `@import ${q}${PREFIX}${val}${q}`);
  return out;
}

if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);

let changed = 0;
for (const f of walk(DST)) {
  const ext = path.extname(f).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  const original = fs.readFileSync(f, 'utf8');
  const out = rewrite(original);
  if (out !== original) { fs.writeFileSync(f, out, 'utf8'); changed++; }
}
console.log(`docs/ ready. Rewrote ${changed} files with prefix "${PREFIX}".`);
