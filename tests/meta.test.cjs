const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { parseHTML } = require('linkedom');

test('parseHeadMeta prefers og:title and apple-touch-icon', async () => {
  globalThis.DOMParser = class {
    parseFromString(html) {
      return parseHTML(html).document;
    }
  };
  const { parseHeadMeta } = await import(pathToFileURL(path.join(__dirname, '../meta.js')).href);
  const meta = parseHeadMeta(
    '<!doctype html><html><head><title>Page | Site</title>'
    + '<meta property="og:title" content="OG Title">'
    + '<link rel="icon" href="/f.ico" sizes="32x32">'
    + '<link rel="apple-touch-icon" href="/apple.png"></head></html>',
    'https://example.com/app/',
  );
  assert.equal(meta.title, 'OG Title');
  assert.equal(meta.icons[0], 'https://example.com/apple.png');
});
