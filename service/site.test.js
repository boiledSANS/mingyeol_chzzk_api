import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderLinkFailed, staticSitePage } from './site.js';

test('the supplied UI templates are served for every public page', () => {
  for (const name of ['home', 'terms', 'privacy', 'complete']) {
    const html = staticSitePage(name);
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /fonts\.googleapis\.com/);
    assert.match(html, /<style>/i);
  }
  const home = staticSitePage('home');
  assert.match(home, /\[mingyeol API\]/);
  assert.match(home, /onclick="location\.href='\/terms'">이용약관/);
  assert.match(home, /onclick="location\.href='\/privacy'">개인정보 처리방침/);
  assert.match(staticSitePage('complete'), /연동이<br>완료되었습니다!/);
});

test('legal page close buttons return to the home page', () => {
  for (const name of ['terms', 'privacy']) {
    const html = staticSitePage(name);
    assert.match(html, /onclick="location\.href='\/'">닫기<\/button>/);
    assert.doesNotMatch(html, /window\.close\(\)/);
  }
});

test('health and not-found pages use the supplied templates', () => {
  const health = staticSitePage('health');
  const error = staticSitePage('error');

  assert.match(health, /<h1>Running!<\/h1>/);
  assert.match(health, /https:\/\/media4\.giphy\.com\/media\//);
  assert.match(error, /길을 잃었구나 무례한것/);
  assert.match(error, /https:\/\/media2\.giphy\.com\/media\//);
  assert.match(error, /<button[^>]+>돌아가기<\/button>/);
  assert.match(error, /onclick="location\.href='\/'"/);
});

test('the failure page shows escaped callback error data', () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const html = renderLinkFailed({ message: malicious, errorCode: malicious });

  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /\{\{[A-Z0-9_]+\}\}/);
});

test('OAuth callbacks redirect to the fixed result paths', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /new URL\('\/link-completed'/);
  assert.match(source, /new URL\('\/link-failed'/);
  assert.match(source, /response\.writeHead\(303/);
});

test('health is HTML and unknown browser routes keep API 404s as JSON', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /url\.pathname === '\/health'\) return sendHtml\(response, 200, staticSitePage\('health'\)\)/);
  assert.match(source, /request\.method === 'GET' && url\.pathname !== '\/v1' && !url\.pathname\.startsWith\('\/v1\/'\)\) return sendHtml\(response, 404, staticSitePage\('error'\)\)/);
  assert.match(source, /return sendJson\(response, 404, \{ error: 'Not found\.' \}\)/);
  assert.match(source, /img-src 'self' data: https:\/\/media2\.giphy\.com https:\/\/media4\.giphy\.com/);
});
