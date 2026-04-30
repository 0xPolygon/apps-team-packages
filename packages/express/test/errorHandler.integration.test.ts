import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer as createHttpServer } from 'node:http';

import { JsonRpcProvider, Network } from 'ethers';
import express, { json } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Captured } from './helpers/captureLogger.ts';

import { createErrorHandler, notFoundHandler, setupLogger } from '../src/index.ts';
import { makeCaptureLogger } from './helpers/captureLogger.ts';

const SECRET = 'TEST_SECRET_DO_NOT_LEAK_12345';

/**
 * End-to-end assertion that the three shared middleware pieces cooperate to
 * keep an ethers RPC token out of both the HTTP response and the log buffer.
 * The RPC server deliberately returns 401 to coerce ethers into producing a
 * real fetch error, so the structural fingerprint the sanitiser detects
 * (`info.requestUrl`) is exactly what the test exercises — not a hand-built
 * stand-in.
 */
describe('createErrorHandler sanitises ethers fetch errors end-to-end', () => {
  let rpcServer: Server;
  let rpcPort: number;
  let appServer: Server;
  let baseUrl: string;
  let captured: Captured[];

  beforeAll(async () => {
    rpcServer = createHttpServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: -32000, message: 'unauthorized' } }));
    });
    await new Promise<void>((resolve) => rpcServer.listen(0, resolve));
    rpcPort = (rpcServer.address() as AddressInfo).port;

    const rpcUrl = `http://localhost:${rpcPort}/?token=${SECRET}`;
    const provider = new JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: Network.from(1)
    });

    const capture = await makeCaptureLogger();
    captured = capture.captured;

    const app = express();
    app.use(json());
    app.use(setupLogger(capture.logger));

    app.get('/block-number', async (_req, _res, next) => {
      try {
        await provider.getBlockNumber();
      } catch (err) {
        next(err);
      }
    });

    app.use(notFoundHandler);
    app.use(createErrorHandler());

    appServer = app.listen(0);
    const addr = appServer.address();
    if (!addr || typeof addr === 'string') throw new Error('No address');
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
  });

  it('response body does not contain the token', async () => {
    const res = await request(baseUrl).get('/block-number').expect(500);
    expect(JSON.stringify(res.body)).not.contain(SECRET);
  });

  it('response message is URL-stripped but otherwise preserves the error it was thrown as', async () => {
    // The route rethrows the raw ethers error. The response message is
    // therefore derived from that error's own (sanitised) text — URL
    // reduced to origin. Whether the client sees the compound form or a
    // terse hand-written summary is the service author's call, expressed
    // through `VError` vs `WError` vs `HTTPError`. This handler only
    // ensures whatever does bubble up is URL-free.
    const res = await request(baseUrl).get('/block-number').expect(500);
    expect(res.body).property('error', true);
    expect(res.body).property('message').a('string');
    expect(res.body.message).contain('401 Unauthorized');
    expect(res.body.message).not.contain(SECRET);
  });

  it('captured logs do not contain the token', () => {
    expect(JSON.stringify(captured)).not.contain(SECRET);
  });

  it('captured log err.info.requestUrl is reduced to origin, not full URL', () => {
    const errLogs = captured.filter((c) => c.level === 'debug' && c.message === 'unhandled error');
    expect(errLogs).property('length').greaterThan(0);
    const err = errLogs[0]?.err as { info?: { requestUrl?: string } } | undefined;
    expect(err?.info).property('requestUrl', `http://localhost:${rpcPort}`);
  });

  it('notFoundHandler produces a 404 with a uniform JSON body', async () => {
    const res = await request(baseUrl).get('/does-not-exist').expect(404);
    expect(res.body).property('error', true);
    expect(res.body).property('message', 'GET /does-not-exist');
  });
});
