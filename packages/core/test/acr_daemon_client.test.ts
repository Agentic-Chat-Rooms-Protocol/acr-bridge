import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcrDaemonClient, resolveAcrApiToken } from '../src/acr-daemon-client.js';
import { verifyPlatformSenderTrust } from '../src/ans-trust.js';

describe('acr-bridge/core: AcrDaemonClient & Bearer Auth', () => {
  const servers: http.Server[] = [];
  const tempDirs: string[] = [];
  const originalEnvToken = process.env.ACR_API_TOKEN;

  afterEach(async () => {
    if (originalEnvToken === undefined) {
      delete process.env.ACR_API_TOKEN;
    } else {
      process.env.ACR_API_TOKEN = originalEnvToken;
    }

    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startMockServer(): Promise<{
    url: string;
    capturedAuth: Array<string | undefined>;
    capturedPaths: string[];
  }> {
    const capturedAuth: Array<string | undefined> = [];
    const capturedPaths: string[] = [];

    const server = http.createServer((req, res) => {
      capturedAuth.push(req.headers['authorization']);
      capturedPaths.push(req.url || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/healthz') {
        res.end(JSON.stringify({ status: 'ok', active_rooms: 1 }));
        return;
      }
      if (req.url === '/api/v1/audit/chain') {
        res.end(
          JSON.stringify([
            {
              index: 0,
              state_hash: 'hash_0',
              prev_hash: 'genesis',
              actor_did: 'did:key:z6Mkconsensus-lead.acr',
              payload: { handle: 'consensus-lead.acr' },
            },
          ])
        );
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    return {
      url: `http://127.0.0.1:${addr.port}`,
      capturedAuth,
      capturedPaths,
    };
  }

  it('defaults baseUrl to http://127.0.0.1:20443', () => {
    const client = new AcrDaemonClient();
    assert.equal((client as unknown as { baseUrl: string }).baseUrl, 'http://127.0.0.1:20443');
  });

  it('sends Authorization: Bearer <token> from explicit apiToken option', async () => {
    const mock = await startMockServer();
    const client = new AcrDaemonClient(mock.url, { apiToken: 'explicit-secret-token' });
    const health = await client.getHealth();
    assert.equal(health.status, 'ok');
    assert.equal(mock.capturedAuth[0], 'Bearer explicit-secret-token');
  });

  it('sends Authorization: Bearer <token> from ACR_API_TOKEN env var', async () => {
    process.env.ACR_API_TOKEN = 'env-secret-token';
    const mock = await startMockServer();
    const client = new AcrDaemonClient(mock.url);
    await client.getHealth();
    assert.equal(mock.capturedAuth[0], 'Bearer env-secret-token');

    const trust = await verifyPlatformSenderTrust(
      'slack',
      'U123',
      '@consensus-lead.acr ping',
      mock.url
    );
    assert.equal(trust.trusted, true);
    assert.equal(mock.capturedAuth[1], 'Bearer env-secret-token');
  });

  it('reads token from ~/.acr/api-token (tokenPath fallback) when ACR_API_TOKEN is unset', async () => {
    delete process.env.ACR_API_TOKEN;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-bridge-token-'));
    tempDirs.push(tmpDir);
    const tokenFile = path.join(tmpDir, 'api-token');
    fs.writeFileSync(tokenFile, '  file-secret-token\n', 'utf-8');

    assert.equal(resolveAcrApiToken({ tokenPath: tokenFile }), 'file-secret-token');

    const mock = await startMockServer();
    const client = new AcrDaemonClient(mock.url, { tokenPath: tokenFile });
    await client.getHealth();
    assert.equal(mock.capturedAuth[0], 'Bearer file-secret-token');
  });
});
