import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { getLogger, setupLogger } from '../src/index.ts';
import { makeCaptureLogger } from './helpers/captureLogger.ts';

describe('setupLogger + getLogger', () => {
  it('inside a request scope, getLogger() returns the per-request child logger with a requestId binding', async () => {
    const { logger, captured } = await makeCaptureLogger();

    const app = express();
    app.use(setupLogger(logger));
    app.get('/ping', (_req, res) => {
      getLogger().debug({ event: 'ping' }, 'handled');
      res.json({ ok: true });
    });

    await request(app).get('/ping').expect(200);
    const entry = captured.find((c) => c.message === 'handled');
    expect(entry).property('level', 'debug');
    expect(entry).property('event', 'ping');
    // requestId flows from the child() binding set by setupLogger.
    expect(entry).property('requestId').a('string');
  });

  it('concurrent requests each get their own child logger', async () => {
    const { logger, captured } = await makeCaptureLogger();

    const app = express();
    app.use(setupLogger(logger));
    app.get('/slow', (_req, res) => {
      // Defer inside the request scope so the two requests' ALS windows overlap.
      setTimeout(() => {
        getLogger().debug({}, 'fire');
        res.json({ ok: true });
      }, 15);
    });

    await Promise.all([
      request(app).get('/slow').expect(200),
      request(app).get('/slow').expect(200)
    ]);

    const fireEntries = captured.filter((c) => c.message === 'fire');
    expect(fireEntries).property('length', 2);
    const requestIds = fireEntries.map((e) => e.requestId);
    expect(new Set(requestIds).size).equal(2);
    expect(requestIds.every((id) => typeof id === 'string' && id.length > 0)).equal(true);
  });

  it('outside any request scope, getLogger() returns the root logger passed to setupLogger', async () => {
    const { logger, captured } = await makeCaptureLogger();
    // Priming call — simply invoking the factory captures the fallback; we
    // don't have to actually mount the returned middleware on an app.
    setupLogger(logger);

    getLogger().info({ where: 'startup' }, 'startup msg');
    const entry = captured.find((c) => c.message === 'startup msg');
    expect(entry).property('level', 'info');
    expect(entry).property('where', 'startup');
    // Fallback logger has no requestId binding — it's the root.
    expect(entry).not.property('requestId');
  });
});

describe('getLogger without setupLogger', () => {
  it('throws a helpful error when setupLogger() has never been called', async () => {
    // Fresh module graph so the fallback is back to null.
    vi.resetModules();
    const fresh = await import('../src/context.ts');
    expect(() => fresh.getLogger()).throws(/setupLogger/);
  });
});
