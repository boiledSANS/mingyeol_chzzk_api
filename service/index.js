import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readFileSync, rename, writeFile } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { createDatabase } from './database.js';
import { renderLinkFailed, siteStyles, staticSitePage } from './site.js';
import { createYouTubeIntegration } from './youtube.js';

const mkdirAsync = promisify(mkdir);
const readFileAsync = promisify(readFile);
const renameAsync = promisify(rename);
const writeFileAsync = promisify(writeFile);
loadDotEnv();

const CLIENT_ID = required('CHZZK_CLIENT_ID');
const CLIENT_SECRET = required('CHZZK_CLIENT_SECRET');
const PLUGIN_SHARED_SECRET = required('PLUGIN_SHARED_SECRET');
const PORT = Number(process.env.PORT ?? '26540');
const PUBLIC_BASE_URL = required('PUBLIC_BASE_URL').replace(/\/+$/, '');
const CALLBACK_URL = PUBLIC_BASE_URL + '/chzzk/callback';
const DATA_FILE = resolve(process.env.DATA_FILE ?? './data/chzzk-links.json');
const OWNER_FILE = resolve(process.env.OWNER_FILE ?? './data/chzzk-owner.json');
const OWNER_SETUP_KEY = process.env.OWNER_SETUP_KEY?.trim() ?? '';
const OWNER_TOKEN_ENCRYPTION_KEY = process.env.OWNER_TOKEN_ENCRYPTION_KEY?.trim() ?? '';
const LINK_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = Math.max(30, Number(process.env.READ_CACHE_SECONDS ?? '120')) * 1000;
const OPEN_API = 'https://openapi.chzzk.naver.com';
const AUTHORIZE_URL = 'https://chzzk.naver.com/account-interlock';
const LINK_FAILURE_MESSAGES = Object.freeze({
  LINK_EXPIRED: '연동 링크가 없거나 5분의 유효 시간이 지났습니다. Minecraft에서 새 연동 링크를 만들어 다시 시도해 주세요.',
  AUTHORIZATION_CANCELLED: 'CHZZK 계정 인증이 취소되었거나 승인되지 않았습니다.',
  INVALID_CALLBACK: 'CHZZK에서 인증 코드를 전달받지 못했습니다.',
  ACCOUNT_ALREADY_LINKED: '이 CHZZK 계정은 이미 다른 Minecraft 계정에 연결되어 있습니다.',
  AUTHORIZATION_REJECTED: 'CHZZK 계정 인증이 거부되었습니다. 권한을 확인한 뒤 다시 시도해 주세요.',
  LINK_CONFLICT: '이미 연결된 계정 정보와 충돌했습니다.',
  CHZZK_SERVICE_UNAVAILABLE: 'CHZZK 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  YOUTUBE_LINK_EXPIRED: 'YouTube 연동 링크가 없거나 5분의 유효 시간이 지났습니다. Minecraft에서 새 링크를 만들어 주세요.',
  YOUTUBE_AUTHORIZATION_CANCELLED: 'YouTube 계정 인증이 취소되었거나 승인되지 않았습니다.',
  YOUTUBE_INVALID_CALLBACK: 'Google에서 인증 코드를 전달받지 못했습니다.',
  YOUTUBE_CHANNEL_REQUIRED: '선택한 Google 계정에 사용할 수 있는 YouTube 채널이 없습니다.',
  YOUTUBE_ACCOUNT_ALREADY_LINKED: '이 YouTube 채널은 이미 다른 Minecraft 계정에 연결되어 있습니다.',
  YOUTUBE_AUTHORIZATION_REJECTED: 'YouTube 계정 인증 또는 멤버 API 접근이 거부되었습니다.',
  YOUTUBE_OWNER_NOT_READY: '방송자 YouTube 채널의 멤버십 설정 또는 OAuth 연결을 확인해 주세요.',
  YOUTUBE_SERVICE_UNAVAILABLE: 'YouTube 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  LINK_PROCESSING_ERROR: '연동 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.'
});

const pendingLinks = new Map();
const database = await createDatabase({
  host: process.env.DB_HOST?.trim() || '127.0.0.1',
  port: boundedInteger(process.env.DB_PORT, 3306, 1, 65535),
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  database: process.env.DB_NAME?.trim() || 'mingyeol_api',
  connectionLimit: boundedInteger(process.env.DB_CONNECTION_LIMIT, 10, 1, 100)
});
await migrateLegacyLinks();
let owner = await loadOwner();
// Subscriber/follower status is fetched concurrently.  Keep owner refresh single-flight
// because CHZZK refresh tokens may rotate and must never be used twice at once.
let ownerRefreshPromise = null;
const listCache = new Map();
const youtube = await createYouTubeIntegration({
  clientId: process.env.YOUTUBE_CLIENT_ID,
  clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  publicBaseUrl: PUBLIC_BASE_URL,
  pluginSharedSecret: PLUGIN_SHARED_SECRET,
  ownerSetupKey: process.env.YOUTUBE_OWNER_SETUP_KEY || OWNER_SETUP_KEY,
  encryptionKey: OWNER_TOKEN_ENCRYPTION_KEY,
  ownerFile: resolve(process.env.YOUTUBE_OWNER_FILE ?? './data/youtube-owner.json'),
  cacheSeconds: process.env.YOUTUBE_READ_CACHE_SECONDS ?? process.env.READ_CACHE_SECONDS ?? '120',
  database,
  redirectComplete: redirectToLinkComplete,
  redirectFailed: redirectToLinkFailed
});

const requestHandler = async (request, response) => {
  let url;
  try {
    url = new URL(request.url, PUBLIC_BASE_URL);
    if (request.method === 'GET' && url.pathname === '/') return sendHtml(response, 200, staticSitePage('home'));
    if (request.method === 'GET' && url.pathname === '/assets/site.css') return sendCss(response, siteStyles());
    if (request.method === 'GET' && (url.pathname === '/terms' || url.pathname === '/terms.html')) return sendHtml(response, 200, staticSitePage('terms'));
    if (request.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/privacy.html')) return sendHtml(response, 200, staticSitePage('privacy'));
    if (request.method === 'GET' && url.pathname === '/link-completed') return sendHtml(response, 200, staticSitePage('complete'));
    if (request.method === 'GET' && url.pathname === '/link-failed') return sendLinkFailedPage(url, response);
    if (request.method === 'GET' && url.pathname === '/health') return sendHtml(response, 200, staticSitePage('health'));
    if (await youtube.handle(request, response, url)) return;
    if (request.method === 'GET' && url.pathname === '/admin/connect') return beginOwnerConnect(url, response);
    if (url.pathname.startsWith('/v1/accounts/')) return await handleAccountRequest(request, response, url);
    if (request.method === 'POST' && url.pathname === '/v1/links') return await createLink(request, response);
    if (request.method === 'PUT' && url.pathname.startsWith('/v1/links/')) return await migrateLegacyLink(request, response, url);
    if (request.method === 'GET' && url.pathname.startsWith('/v1/links/')) return await getLink(request, response, url);
    if (request.method === 'GET' && url.pathname.startsWith('/v1/viewers/')) return await getViewerReadData(request, response, url);
    if (request.method === 'GET' && url.pathname === '/v1/owner/status') return ownerStatus(request, response);
    if (request.method === 'GET' && url.pathname.startsWith('/v1/owner/read/')) return await getOwnerReadData(request, response, url);
    if (request.method === 'GET' && url.pathname === '/chzzk/callback') return await handleCallback(url, response);
    if (request.method === 'GET' && url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) return sendHtml(response, 404, staticSitePage('error'));
    return sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    if (url?.pathname === '/chzzk/callback' && !response.headersSent) {
      return redirectToLinkFailed(response, callbackFailureCode(error));
    }
    return sendJson(response, error.statusCode ?? 500, { error: error.expose ? error.message : 'Internal server error.' });
  }
};

const TLS_KEY_PATH = process.env.TLS_KEY_PATH?.trim();
const TLS_CERT_PATH = process.env.TLS_CERT_PATH?.trim();
if (Boolean(TLS_KEY_PATH) !== Boolean(TLS_CERT_PATH)) throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must be set together.');
const server = TLS_KEY_PATH
  ? createHttpsServer({ key: readFileSync(TLS_KEY_PATH), cert: readFileSync(TLS_CERT_PATH) }, requestHandler)
  : createHttpServer(requestHandler);
server.listen(PORT, () => console.log('Mingyeol OAuth service listening on ' + PUBLIC_BASE_URL));

async function createLink(request, response) {
  requirePlugin(request);
  const { minecraftUuid } = await readJson(request);
  if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });
  const state = randomToken(32);
  pendingLinks.set(state, { kind: 'viewer', minecraftUuid, expiresAt: Date.now() + LINK_TTL_MS });
  console.info('Created CHZZK link for ' + minecraftUuid + ' (state ' + state.substring(0, 8) + '...)');
  return sendJson(response, 201, { authorizationUrl: authorizationUrl(state) });
}

async function getLink(request, response, url) {
  requirePlugin(request);
  const minecraftUuid = decodeURIComponent(url.pathname.substring('/v1/links/'.length));
  if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });
  const link = await database.getChzzkLink(minecraftUuid);
  return sendJson(response, 200, link ? { linked: true, ...link } : { linked: false });
}

// Used only by the plugin to move an old local Skript variables.sk link into the shared DB.
async function migrateLegacyLink(request, response, url) {
  requirePlugin(request);
  const minecraftUuid = decodeURIComponent(url.pathname.substring('/v1/links/'.length));
  if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });

  const body = await readJson(request);
  const channelId = optionalText(body.channelId, 64);
  const channelName = optionalText(body.channelName, 100);
  if (!channelId) return sendJson(response, 400, { error: 'channelId is required.' });
  try {
    const link = await database.setChzzkLink(minecraftUuid, {
      channelId,
      channelName: channelName ?? '알 수 없음',
      linkedAt: new Date().toISOString()
    });
    return sendJson(response, 200, { linked: true, ...link });
  } catch (error) {
    if (error.code === 'CHZZK_ALREADY_LINKED') return sendJson(response, 409, { error: 'CHZZK_ALREADY_LINKED' });
    throw error;
  }
}

async function handleAccountRequest(request, response, url) {
  requirePlugin(request);
  const matched = url.pathname.match(/^\/v1\/accounts\/([^/]+)(\/discord)?$/);
  if (!matched) return sendJson(response, 404, { error: 'Not found.' });
  const minecraftUuid = decodeURIComponent(matched[1]);
  if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });

  if (!matched[2]) {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    const account = await database.getAccount(minecraftUuid);
    return sendJson(response, 200, account ?? { minecraftUuid: minecraftUuid.toLowerCase(), discord: null, chzzk: null, youtube: null });
  }

  if (request.method === 'GET') {
    return sendJson(response, 200, discordResponse(await database.getDiscordLink(minecraftUuid)));
  }
  if (request.method === 'DELETE') {
    await database.deleteDiscordLink(minecraftUuid);
    return sendJson(response, 200, { linked: false });
  }
  if (request.method !== 'PUT') return sendJson(response, 405, { error: 'Method not allowed.' });

  const body = await readJson(request);
  const discordUserId = optionalText(body.discordUserId, 32);
  const discordUsername = optionalText(body.discordUsername ?? body.username, 100);
  const discordNickname = optionalText(body.discordNickname ?? body.nickname, 100);
  if (!discordUserId || !/^\d{5,32}$/.test(discordUserId)) {
    return sendJson(response, 400, { error: 'discordUserId must be a Discord snowflake.' });
  }
  try {
    const link = await database.setDiscordLink(minecraftUuid, {
      discordUserId,
      discordUsername,
      discordNickname,
      linkedAt: new Date().toISOString()
    });
    return sendJson(response, 200, discordResponse(link));
  } catch (error) {
    if (error?.code === 'DISCORD_ALREADY_LINKED') {
      return sendJson(response, 409, { error: 'This Discord account is already linked to another Minecraft account.' });
    }
    throw error;
  }
}

function beginOwnerConnect(url, response) {
  if (!OWNER_SETUP_KEY) throw exposed(503, 'OWNER_SETUP_KEY environment variable is required.');
  if (!safeEqual(OWNER_SETUP_KEY, url.searchParams.get('key') ?? '')) throw exposed(401, 'Unauthorized.');
  requireOwnerEncryptionKey();
  const state = randomToken(32);
  pendingLinks.set(state, { kind: 'owner', expiresAt: Date.now() + LINK_TTL_MS });
  console.info('Created owner CHZZK authorization (state ' + state.substring(0, 8) + '...)');
  response.writeHead(302, {
    Location: authorizationUrl(state),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end();
}

function ownerStatus(request, response) {
  requirePlugin(request);
  return sendJson(response, 200, owner
    ? { connected: true, channelId: owner.channelId, channelName: owner.channelName }
    : { connected: false });
}

async function getViewerReadData(request, response, url) {
  requirePlugin(request);
  const matched = url.pathname.match(/^\/v1\/viewers\/([^/]+)\/(status|subscription|following)$/);
  if (!matched) return sendJson(response, 404, { error: 'Not found.' });
  const minecraftUuid = decodeURIComponent(matched[1]);
  if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });
  const link = await database.getChzzkLink(minecraftUuid);
  if (!link) return sendJson(response, 200, { linked: false });
  if (matched[2] === 'subscription') return sendJson(response, 200, { linked: true, ...await subscriberStatus(link.channelId) });
  if (matched[2] === 'following') return sendJson(response, 200, { linked: true, ...await followerStatus(link.channelId) });
  const [subscription, following] = await Promise.all([subscriberStatus(link.channelId), followerStatus(link.channelId)]);
  return sendJson(response, 200, { linked: true, channelId: link.channelId, channelName: link.channelName, ...subscription, ...following });
}

async function getOwnerReadData(request, response, url) {
  requirePlugin(request);
  const resource = decodeURIComponent(url.pathname.substring('/v1/owner/read/'.length));
  const page = boundedInteger(url.searchParams.get('page'), 0, 0, 100000);
  const size = boundedInteger(url.searchParams.get('size'), 50, 1, 50);
  return sendJson(response, 200, await ownerReadResource(resource, page, size));
}

async function handleCallback(url, response) {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const oauthError = url.searchParams.get('error') ?? '';
  const pending = pendingLinks.get(state);
  pendingLinks.delete(state);
  if (!pending || pending.expiresAt < Date.now()) {
    console.warn('Rejected CHZZK callback (state ' + state.substring(0, 8) + '..., code present: ' + Boolean(code) + ').');
    return redirectToLinkFailed(response, 'LINK_EXPIRED');
  }
  if (oauthError) {
    console.warn('CHZZK authorization was cancelled or rejected (state ' + state.substring(0, 8) + '...).');
    return redirectToLinkFailed(response, 'AUTHORIZATION_CANCELLED');
  }
  if (!code) {
    console.warn('Rejected CHZZK callback without an authorization code (state ' + state.substring(0, 8) + '...).');
    return redirectToLinkFailed(response, 'INVALID_CALLBACK');
  }
  const token = await chzzkToken({ grantType: 'authorization_code', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, state });
  const user = await chzzkGet('/open/v1/users/me', token.accessToken);
  const channelId = text(user, 'channelId');
  const channelName = text(user, 'channelName');
  if (!channelId || !channelName) throw exposed(502, '치지직 사용자 정보를 읽지 못했습니다. 유저 조회 권한을 확인하세요.');
  if (pending.kind === 'owner') {
    owner = { channelId, channelName, accessToken: token.accessToken, refreshToken: token.refreshToken, accessTokenExpiresAt: Date.now() + Math.max(60, Number(token.expiresIn ?? 86400)) * 1000 };
    await saveOwner();
    listCache.clear();
    console.info('CHZZK owner connected: ' + channelName + ' (' + channelId + ')');
    return redirectToLinkComplete(response);
  }
  try {
    await database.setChzzkLink(pending.minecraftUuid, { channelId, channelName, linkedAt: new Date().toISOString() });
  } catch (error) {
    if (error?.code === 'CHZZK_ALREADY_LINKED') {
      return redirectToLinkFailed(response, 'ACCOUNT_ALREADY_LINKED');
    }
    throw error;
  }
  return redirectToLinkComplete(response);
}

async function ownerReadResource(resource, page, size) {
  const ownerRecord = await ensureOwner();
  const pageQuery = '?page=' + page + '&size=' + size;
  const readPaths = {
    managers: '/open/v1/channels/streaming-roles',
    followers: '/open/v1/channels/followers' + pageQuery,
    subscribers: '/open/v1/channels/subscribers' + pageQuery,
    'live-settings': '/open/v1/lives/setting',
    'chat-settings': '/open/v1/chats/settings',
    restrictions: '/open/v1/restrict-channels' + pageQuery
  };
  if (resource === 'channel') {
    const data = await chzzkClientGet('/open/v1/channels?channelIds=' + encodeURIComponent(ownerRecord.channelId));
    return { channelId: ownerRecord.channelId, channelName: ownerRecord.channelName, data };
  }
  const apiPath = readPaths[resource];
  if (!apiPath) throw exposed(400, 'Unsupported read resource.');
  return { channelId: ownerRecord.channelId, channelName: ownerRecord.channelName, data: await chzzkOwnerGet(apiPath) };
}

async function subscriberStatus(channelId) {
  const item = (await cachedOwnerList('subscribers')).get(channelId);
  return { subscriber: Boolean(item), subscriberTier: firstText(item, ['tierName', 'tier', 'subscriptionTierName', 'subscriptionTier']) || null, subscriberMonths: firstNumber(item, ['month', 'months', 'subscriptionMonth', 'subscriptionMonths']) };
}

async function followerStatus(channelId) { return { following: Boolean((await cachedOwnerList('followers')).get(channelId)) }; }

async function cachedOwnerList(kind) {
  const cached = listCache.get(kind);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const ownerRecord = await ensureOwner();
  const path = kind === 'subscribers' ? '/open/v1/channels/subscribers' : '/open/v1/channels/followers';
  const byChannelId = new Map();
  for (let page = 0; page < 500; page++) {
    const payload = await chzzkOwnerGet(path + '?page=' + page + '&size=50', ownerRecord);
    const items = listItems(payload);
    for (const item of items) { const id = text(item, 'channelId'); if (id) byChannelId.set(id, item); }
    const totalCount = firstNumber(payload, ['totalCount', 'total']);
    if (items.length < 50 || (totalCount !== null && byChannelId.size >= totalCount)) break;
  }
  listCache.set(kind, { expiresAt: Date.now() + CACHE_TTL_MS, items: byChannelId });
  return byChannelId;
}

async function ensureOwner() {
  if (!owner) throw exposed(409, '방송자 조회 계정이 아직 연결되지 않았습니다. /admin/connect를 먼저 여세요.');
  if (owner.accessTokenExpiresAt > Date.now() + 60_000) return owner;
  if (!owner.refreshToken) throw exposed(409, '방송자 조회 토큰이 없습니다. /admin/connect로 다시 연동하세요.');

  // Both subscriberStatus() and followerStatus() call this at the same time.
  // They must share one refresh request and one file write.
  if (!ownerRefreshPromise) {
    ownerRefreshPromise = refreshOwnerToken().finally(() => { ownerRefreshPromise = null; });
  }
  return ownerRefreshPromise;
}

async function refreshOwnerToken() {
  try {
    const token = await chzzkToken({ grantType: 'refresh_token', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: owner.refreshToken });
    owner.accessToken = token.accessToken;
    owner.refreshToken = token.refreshToken || owner.refreshToken;
    owner.accessTokenExpiresAt = Date.now() + Math.max(60, Number(token.expiresIn ?? 86400)) * 1000;
    await saveOwner();
    return owner;
  } catch (error) {
    // A temporary CHZZK/network error must not erase the encrypted refresh token.
    // The old behaviour wrote JSON null here, which made a normally recoverable
    // one-day access-token refresh failure look like a permanently disconnected owner.
    console.error('방송자 토큰 갱신 실패. 기존 연동 정보는 유지하고 다음 요청에서 다시 시도합니다.', error);
    throw exposed(503, '방송자 조회 토큰 갱신에 실패했습니다. 잠시 후 다시 시도하세요.');
  }
}

function authorizationUrl(state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('clientId', CLIENT_ID);
  url.searchParams.set('redirectUri', CALLBACK_URL);
  url.searchParams.set('state', state);
  return url.toString();
}

async function chzzkToken(body) {
  const response = await fetch(OPEN_API + '/auth/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = unwrap(await jsonBody(response));
  if (!response.ok || !payload.accessToken) throw exposed(502, '치지직 토큰 발급에 실패했습니다.');
  return payload;
}

async function chzzkOwnerGet(path, knownOwner = null) { return chzzkGet(path, (knownOwner ?? await ensureOwner()).accessToken); }
async function chzzkClientGet(path) {
  const response = await fetch(OPEN_API + path, { headers: { 'Client-Id': CLIENT_ID, 'Client-Secret': CLIENT_SECRET, 'Content-Type': 'application/json' } });
  const payload = unwrap(await jsonBody(response));
  if (!response.ok) throw exposed(502, '치지직 공개 API 요청에 실패했습니다.');
  return payload;
}
async function chzzkGet(path, accessToken) {
  const response = await fetch(OPEN_API + path, { headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' } });
  const payload = unwrap(await jsonBody(response));
  if (!response.ok) throw exposed(502, '치지직 조회 API 요청에 실패했습니다. 권한을 확인하세요.');
  return payload;
}
async function jsonBody(response) { try { return await response.json(); } catch { return {}; } }
function unwrap(payload) { return payload?.content ?? payload; }
function text(object, key) { return typeof object?.[key] === 'string' ? object[key].trim() : ''; }
function firstText(object, keys) { for (const key of keys) { const value = text(object, key); if (value) return value; } return ''; }
function firstNumber(object, keys) { for (const key of keys) { const value = Number(object?.[key]); if (Number.isFinite(value)) return value; } return null; }
function listItems(payload) { if (Array.isArray(payload)) return payload; if (Array.isArray(payload?.data)) return payload.data; if (Array.isArray(payload?.items)) return payload.items; return []; }
function boundedInteger(value, fallback, min, max) { const number = Number.parseInt(value ?? '', 10); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function randomToken(bytes) { return randomBytes(bytes).toString('hex'); }
function optionalText(value, maxLength) { if (value === null || value === undefined) return null; if (typeof value !== 'string') throw exposed(400, 'Text fields must be strings.'); const result = value.trim(); if (result.length > maxLength) throw exposed(400, 'Text field is too long.'); return result || null; }
function discordResponse(link) { return link ? { linked: true, ...link } : { linked: false }; }

function requirePlugin(request) { if (!safeEqual(PLUGIN_SHARED_SECRET, request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '')) throw exposed(401, 'Unauthorized.'); }
function safeEqual(expected, supplied) { const a = Buffer.from(expected); const b = Buffer.from(supplied); return a.length === b.length && timingSafeEqual(a, b); }
async function readJson(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 8192) throw exposed(413, 'Request body is too large.'); }
  try { return JSON.parse(body); } catch { throw exposed(400, 'Invalid JSON.'); }
}
async function migrateLegacyLinks() {
  try {
    const parsed = JSON.parse(await readFileAsync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Legacy CHZZK link file is invalid.');
    const result = await database.migrateLegacyChzzkLinks(Object.entries(parsed));
    if (result.migrated) console.info('Migrated ' + result.count + ' legacy CHZZK link(s) from ' + DATA_FILE + '.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
async function loadOwner() {
  try {
    const stored = JSON.parse(await readFileAsync(OWNER_FILE, 'utf8'));
    // A previously cleared owner record is intentionally stored as JSON null.
    // Treat it as "not connected" instead of trying to decrypt it.
    return stored === null ? null : decryptOwner(stored);
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function saveOwner() { await writePrivateJson(OWNER_FILE, owner === null ? null : encryptOwner(owner)); }
async function writePrivateJson(file, value) {
  await mkdirAsync(dirname(file), { recursive: true });
  // A unique temporary path also keeps simultaneous writes from colliding.
  const temporary = file + '.' + process.pid + '.' + randomToken(8) + '.tmp';
  await writeFileAsync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await renameAsync(temporary, file);
}
function requireOwnerEncryptionKey() {
  const key = Buffer.from(OWNER_TOKEN_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw exposed(503, 'OWNER_TOKEN_ENCRYPTION_KEY must be a 32-byte base64 value.');
  return key;
}
function encryptOwner(value) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', requireOwnerEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decryptOwner(value) {
  if (!value || value.version !== 1) throw new Error('Owner token file is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', requireOwnerEncryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
function sendLinkFailedPage(url, response) {
  const errorCode = resultErrorCode(url.searchParams.get('code'));
  return sendHtml(response, 200, renderLinkFailed({
    message: LINK_FAILURE_MESSAGES[errorCode],
    errorCode
  }));
}
function redirectToLinkComplete(response) {
  return sendRedirect(response, new URL('/link-completed', PUBLIC_BASE_URL + '/'));
}
function redirectToLinkFailed(response, errorCode) {
  const location = new URL('/link-failed', PUBLIC_BASE_URL + '/');
  location.searchParams.set('code', resultErrorCode(errorCode));
  return sendRedirect(response, location);
}
function sendRedirect(response, location) {
  response.writeHead(303, {
    Location: location.toString(),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end();
}
function resultErrorCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return Object.hasOwn(LINK_FAILURE_MESSAGES, code) ? code : 'LINK_PROCESSING_ERROR';
}
function sendJson(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
function sendHtml(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://media2.giphy.com https://media4.giphy.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
  });
  response.end(body);
}
function sendCss(response, body) {
  response.writeHead(200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}
function callbackFailureCode(error) {
  const status = Number(error?.statusCode);
  if (status === 400) return 'INVALID_CALLBACK';
  if (status === 401 || status === 403) return 'AUTHORIZATION_REJECTED';
  if (status === 409) return 'LINK_CONFLICT';
  if (status === 502 || status === 503 || status === 504) return 'CHZZK_SERVICE_UNAVAILABLE';
  return 'LINK_PROCESSING_ERROR';
}
function required(name) { const value = process.env[name]?.trim(); if (!value || value.startsWith('PUT_') || value.startsWith('GENERATE_')) throw new Error(name + ' environment variable is required.'); return value; }
function exposed(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; error.expose = true; return error; }
function loadDotEnv() {
  try {
    const envText = readFileSync('.env', 'utf8');
    for (const line of envText.split(/\r?\n/)) { const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, ''); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
