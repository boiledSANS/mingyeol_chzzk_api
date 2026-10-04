import { readFileSync } from 'node:fs';

const SITE_ROOT = new URL('./site/', import.meta.url);

const documents = Object.freeze({
  home: load('home.html'),
  terms: load('terms.html'),
  privacy: load('privacy.html'),
  complete: load('link-complete.html'),
  failed: load('link-failed.html'),
  health: load('health.html'),
  error: load('error.html'),
  css: load('site.css')
});

export function staticSitePage(name) {
  const page = documents[name];
  if (!page || name === 'css' || name === 'failed') {
    throw new Error('Unknown static site page: ' + name);
  }
  return page;
}

export function siteStyles() {
  return documents.css;
}

export function renderLinkFailed({ message, errorCode }) {
  return render(documents.failed, {
    MESSAGE: message,
    ERROR_CODE: errorCode
  });
}

function render(template, values) {
  const expected = new Set(Object.keys(values));
  const used = new Set();
  const output = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, key) => {
    if (!expected.has(key)) throw new Error('Unknown site template value: ' + placeholder);
    used.add(key);
    return escapeHtml(String(values[key] ?? ''));
  });
  for (const key of expected) {
    if (!used.has(key)) throw new Error('Missing site template placeholder: {{' + key + '}}');
  }
  return output;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function load(fileName) {
  return readFileSync(new URL(fileName, SITE_ROOT), 'utf8');
}
