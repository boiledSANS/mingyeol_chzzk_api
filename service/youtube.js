import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const VIEWER_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const OWNER_SCOPE = 'https://www.googleapis.com/auth/youtube.channel-memberships.creator';
const LINK_TTL_MS = 5 * 60 * 1000;

/** Adds YouTube identity linking and creator-authorized membership checks to the shared service. */
export async function createYouTubeIntegration(options) {
  const config = {
    clientId: options.clientId?.trim() ?? '',
    clientSecret: options.clientSecret?.trim() ?? '',
    publicBaseUrl: options.publicBaseUrl.replace(/\/+$/, ''),
    pluginSharedSecret: options.pluginSharedSecret,
    ownerSetupKey: options.ownerSetupKey?.trim() ?? '',
    encryptionKey: options.encryptionKey?.trim() ?? '',
    ownerFile: options.ownerFile,
    cacheTtlMs: Math.max(30, Number(options.cacheSeconds ?? 120)) * 1000
  };
  config.callbackUrl = config.publicBaseUrl + '/youtube/callback';

  const pendingLinks = new Map();
  const memberCache = { expiresAt: 0, items: new Map() };
  let owner = await loadOwner(config);
  let ownerRefreshPromise = null;
  let memberListPromise = null;

  async function handle(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/admin/youtube/connect') {
      beginOwnerConnect(response, url);
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/v1/youtube/links') {
      await createLink(request, response);
      return true;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/youtube/links/')) {
      await getLink(request, response, url);
      return true;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/youtube/viewers/')) {
      await getViewerStatus(request, response, url);
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/v1/youtube/owner/status') {
      ownerStatus(request, response);
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/youtube/callback') {
      try {
        await handleCallback(response, url);
      } catch (error) {
        console.error('YouTube OAuth callback failed:', error);
        options.redirectFailed(response, callbackFailureCode(error));
      }
      return true;
    }
    return false;
  }

  async function createLink(request, response) {
    requireConfigured();
    requirePlugin(request, config.pluginSharedSecret);
    const { minecraftUuid } = await readJson(request);
    if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });
    const state = randomToken(32);
    pendingLinks.set(state, { kind: 'viewer', minecraftUuid, expiresAt: Date.now() + LINK_TTL_MS });
    console.info('Created YouTube link for ' + minecraftUuid + ' (state ' + state.substring(0, 8) + '...)');
    return sendJson(response, 201, { authorizationUrl: authorizationUrl(config, state, false) });
  }

  async function getLink(request, response, url) {
    requireConfigured();
    requirePlugin(request, config.pluginSharedSecret);
    const minecraftUuid = decodeURIComponent(url.pathname.substring('/v1/youtube/links/'.length));
    if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });
    const link = await options.database.getYoutubeLink(minecraftUuid);
    return sendJson(response, 200, link ? { linked: true, ...link } : { linked: false });
  }

  async function getViewerStatus(request, response, url) {
    requireConfigured();
    requirePlugin(request, config.pluginSharedSecret);
    const matched = url.pathname.match(/^\/v1\/youtube\/viewers\/([^/]+)\/status$/);
    if (!matched) return sendJson(response, 404, { error: 'Not found.' });
    const minecraftUuid = decodeURIComponent(matched[1]);
    if (!isUuid(minecraftUuid)) return sendJson(response, 400, { error: 'minecraftUuid must be a UUID.' });
    const link = await options.database.getYoutubeLink(minecraftUuid);
    if (!link) return sendJson(response, 200, { linked: false });
    const membership = await membershipStatus(link.channelId);
    return sendJson(response, 200, {
      linked: true,
      channelId: link.channelId,
      channelName: link.channelName,
      ...membership
    });
  }

  function ownerStatus(request, response) {
    requireConfigured();
    requirePlugin(request, config.pluginSharedSecret);
    return sendJson(response, 200, owner
      ? { connected: true, channelId: owner.channelId, channelName: owner.channelName }
      : { connected: false });
  }

  function beginOwnerConnect(response, url) {
    requireConfigured();
    if (!config.ownerSetupKey) throw exposed(503, 'YOUTUBE_OWNER_SETUP_KEY environment variable is required.');
    if (!safeEqual(config.ownerSetupKey, url.searchParams.get('key') ?? '')) throw exposed(401, 'Unauthorized.');
    requireEncryptionKey(config);
    const state = randomToken(32);
    pendingLinks.set(state, { kind: 'owner', expiresAt: Date.now() + LINK_TTL_MS });
    console.info('Created YouTube owner authorization (state ' + state.substring(0, 8) + '...)');
    redirect(response, authorizationUrl(config, state, true), 302);
  }

  async function handleCallback(response, url) {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const oauthError = url.searchParams.get('error') ?? '';
    const pending = pendingLinks.get(state);
    pendingLinks.delete(state);

    if (!pending || pending.expiresAt < Date.now()) return options.redirectFailed(response, 'YOUTUBE_LINK_EXPIRED');
    if (oauthError) return options.redirectFailed(response, 'YOUTUBE_AUTHORIZATION_CANCELLED');
    if (!code) return options.redirectFailed(response, 'YOUTUBE_INVALID_CALLBACK');

    const token = await exchangeAuthorizationCode(config, code);
    const channel = await authenticatedChannel(token.access_token);
    if (!channel) return options.redirectFailed(response, 'YOUTUBE_CHANNEL_REQUIRED');

    if (pending.kind === 'owner') {
      if (!token.refresh_token) {
        throw exposed(502, 'YouTube 방송자 refresh token을 받지 못했습니다. Google 권한을 취소한 뒤 다시 연결하세요.');
      }
      owner = {
        channelId: channel.id,
        channelName: channel.snippet?.title ?? channel.id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        accessTokenExpiresAt: Date.now() + Math.max(60, Number(token.expires_in ?? 3600)) * 1000
      };
      await saveOwner(config, owner);
      memberCache.expiresAt = 0;
      memberCache.items = new Map();
      console.info('YouTube owner connected: ' + owner.channelName + ' (' + owner.channelId + ')');
      return options.redirectComplete(response);
    }

    try {
      await options.database.setYoutubeLink(pending.minecraftUuid, {
        channelId: channel.id,
        channelName: channel.snippet?.title ?? channel.id,
        linkedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error?.code === 'YOUTUBE_ALREADY_LINKED') {
        return options.redirectFailed(response, 'YOUTUBE_ACCOUNT_ALREADY_LINKED');
      }
      throw error;
    }
    return options.redirectComplete(response);
  }

  async function membershipStatus(channelId) {
    const item = (await cachedMemberList()).get(channelId);
    const details = item?.snippet?.membershipsDetails;
    return {
      member: Boolean(item),
      memberLevelId: details?.highestAccessibleLevel ?? null,
      memberLevel: details?.highestAccessibleLevelDisplayName ?? null,
      memberMonths: numberOrNull(details?.membershipsDuration?.memberTotalDurationMonths),
      memberSince: details?.membershipsDuration?.memberSince ?? null
    };
  }

  async function cachedMemberList() {
    if (memberCache.expiresAt > Date.now()) return memberCache.items;
    if (!memberListPromise) {
      memberListPromise = refreshMemberList().finally(() => { memberListPromise = null; });
    }
    return memberListPromise;
  }

  async function refreshMemberList() {
    const ownerRecord = await ensureOwner();
    const byChannelId = new Map();
    let pageToken = '';
    for (let page = 0; page < 500; page++) {
      const params = new URLSearchParams({ part: 'snippet', mode: 'all_current', maxResults: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const payload = await youtubeGet('/members?' + params, ownerRecord.accessToken);
      for (const item of payload.items ?? []) {
        const memberChannelId = item?.snippet?.memberDetails?.channelId;
        if (memberChannelId) byChannelId.set(memberChannelId, item);
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : '';
      if (!pageToken) break;
    }
    memberCache.items = byChannelId;
    memberCache.expiresAt = Date.now() + config.cacheTtlMs;
    return byChannelId;
  }

  async function ensureOwner() {
    if (!owner) throw exposed(409, 'YouTube 방송자 계정이 연결되지 않았습니다. /admin/youtube/connect를 먼저 여세요.');
    if (owner.accessTokenExpiresAt > Date.now() + 60_000) return owner;
    if (!owner.refreshToken) throw exposed(409, 'YouTube 방송자 refresh token이 없습니다. 다시 연결하세요.');
    if (!ownerRefreshPromise) {
      ownerRefreshPromise = refreshOwnerToken().finally(() => { ownerRefreshPromise = null; });
    }
    return ownerRefreshPromise;
  }

  async function refreshOwnerToken() {
    const token = await tokenRequest(new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: owner.refreshToken,
      grant_type: 'refresh_token'
    }));
    owner.accessToken = token.access_token;
    owner.refreshToken = token.refresh_token ?? owner.refreshToken;
    owner.accessTokenExpiresAt = Date.now() + Math.max(60, Number(token.expires_in ?? 3600)) * 1000;
    await saveOwner(config, owner);
    return owner;
  }

  function requireConfigured() {
    if (!config.clientId || !config.clientSecret) {
      throw exposed(503, 'YOUTUBE_CLIENT_ID와 YOUTUBE_CLIENT_SECRET 환경 변수를 설정해야 합니다.');
    }
  }

  return { handle };
}

function authorizationUrl(config, state, owner) {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', owner ? VIEWER_SCOPE + ' ' + OWNER_SCOPE : VIEWER_SCOPE);
  url.searchParams.set('access_type', owner ? 'offline' : 'online');
  url.searchParams.set('prompt', owner ? 'consent' : 'select_account');
  return url.toString();
}

async function exchangeAuthorizationCode(config, code) {
  return tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.callbackUrl
  }));
}

async function tokenRequest(body) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await jsonBody(response);
  if (!response.ok || !payload.access_token) throw exposed(502, 'Google OAuth 토큰 발급에 실패했습니다.');
  return payload;
}

async function authenticatedChannel(accessToken) {
  const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '1' });
  const payload = await youtubeGet('/channels?' + params, accessToken);
  return Array.isArray(payload.items) ? payload.items[0] ?? null : null;
}

async function youtubeGet(path, accessToken) {
  const response = await fetch(YOUTUBE_API + path, { headers: { Authorization: 'Bearer ' + accessToken } });
  const payload = await jsonBody(response);
  if (!response.ok) {
    const reason = payload?.error?.errors?.[0]?.reason;
    if (reason === 'channelMembershipsNotEnabled') throw exposed(409, '연결한 YouTube 채널에 멤버십이 활성화되어 있지 않습니다.');
    if (response.status === 403) throw exposed(403, 'YouTube 멤버 API 접근이 허용되지 않았습니다. 채널 단위 allowlist 승인이 필요합니다.');
    throw exposed(502, 'YouTube Data API 요청에 실패했습니다.');
  }
  return payload;
}

async function loadOwner(config) {
  if (!config.clientId || !config.clientSecret) return null;
  try {
    const stored = JSON.parse(await readFile(config.ownerFile, 'utf8'));
    return stored === null ? null : decryptOwner(config, stored);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveOwner(config, owner) {
  await mkdir(dirname(config.ownerFile), { recursive: true });
  const temporary = config.ownerFile + '.' + process.pid + '.' + randomToken(8) + '.tmp';
  await writeFile(temporary, JSON.stringify(encryptOwner(config, owner), null, 2), { mode: 0o600 });
  await rename(temporary, config.ownerFile);
}

function encryptOwner(config, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', requireEncryptionKey(config), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decryptOwner(config, value) {
  if (!value || value.version !== 1) throw new Error('YouTube owner token file is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', requireEncryptionKey(config), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}

function requireEncryptionKey(config) {
  const key = Buffer.from(config.encryptionKey, 'base64');
  if (key.length !== 32) throw exposed(503, 'OWNER_TOKEN_ENCRYPTION_KEY must be a 32-byte base64 value.');
  return key;
}

function requirePlugin(request, expected) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!safeEqual(expected, supplied)) throw exposed(401, 'Unauthorized.');
}

function safeEqual(expected, supplied) {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw exposed(413, 'Request body is too large.');
  }
  try { return JSON.parse(body); } catch { throw exposed(400, 'Invalid JSON.'); }
}

function redirect(response, location, status = 303) {
  response.writeHead(status, {
    Location: location.toString(),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end();
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function callbackFailureCode(error) {
  const status = Number(error?.statusCode);
  if (status === 400) return 'YOUTUBE_INVALID_CALLBACK';
  if (status === 401 || status === 403) return 'YOUTUBE_AUTHORIZATION_REJECTED';
  if (status === 409) return 'YOUTUBE_OWNER_NOT_READY';
  return 'YOUTUBE_SERVICE_UNAVAILABLE';
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function jsonBody(response) {
  try { return await response.json(); } catch { return {}; }
}

function randomToken(bytes) { return randomBytes(bytes).toString('hex'); }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function exposed(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; error.expose = true; return error; }
