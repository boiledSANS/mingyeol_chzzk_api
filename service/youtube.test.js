import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createYouTubeIntegration } from './youtube.js';

test('viewer and owner links request the intended YouTube OAuth scopes', async () => {
  const integration = await createYouTubeIntegration({
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
    publicBaseUrl: 'https://api.example.test',
    pluginSharedSecret: 'plugin-secret',
    ownerSetupKey: 'owner-key',
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    ownerFile: './data/does-not-exist-test-owner.json',
    cacheSeconds: 120,
    database: {},
    redirectComplete() {},
    redirectFailed() {}
  });

  const viewerResponse = responseRecorder();
  const viewerRequest = Readable.from([JSON.stringify({ minecraftUuid: '123e4567-e89b-42d3-a456-426614174000' })]);
  viewerRequest.method = 'POST';
  viewerRequest.headers = { authorization: 'Bearer plugin-secret' };
  const handledViewer = await integration.handle(
    viewerRequest,
    viewerResponse,
    new URL('https://api.example.test/v1/youtube/links')
  );

  assert.equal(handledViewer, true);
  assert.equal(viewerResponse.status, 201);
  const viewerUrl = new URL(JSON.parse(viewerResponse.body).authorizationUrl);
  assert.equal(viewerUrl.origin, 'https://accounts.google.com');
  assert.equal(viewerUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(viewerUrl.searchParams.get('access_type'), 'online');
  assert.equal(viewerUrl.searchParams.get('redirect_uri'), 'https://api.example.test/youtube/callback');

  const ownerResponse = responseRecorder();
  const ownerRequest = { method: 'GET', headers: {} };
  const handledOwner = await integration.handle(
    ownerRequest,
    ownerResponse,
    new URL('https://api.example.test/admin/youtube/connect?key=owner-key')
  );

  assert.equal(handledOwner, true);
  assert.equal(ownerResponse.status, 302);
  const ownerUrl = new URL(ownerResponse.headers.Location);
  assert.match(ownerUrl.searchParams.get('scope'), /youtube\.channel-memberships\.creator/);
  assert.match(ownerUrl.searchParams.get('scope'), /youtube\.readonly/);
  assert.equal(ownerUrl.searchParams.get('access_type'), 'offline');
  assert.equal(ownerUrl.searchParams.get('prompt'), 'consent');
});

function responseRecorder() {
  return {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    }
  };
}
