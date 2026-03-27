import type { DestinationStream, Logger } from 'pino';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VError, WError } from '@polygonlabs/verror';

import { createLogger } from '../src/index.ts';

type LogRecord = Record<string, unknown>;

/** Creates a pino-compatible destination that captures output as parsed JSON. */
function makeCapture(): { destination: DestinationStream; records: () => LogRecord[] } {
  const raw: string[] = [];
  const destination: DestinationStream = {
    write(msg: string) {
      const line = msg.trimEnd();
      if (line) raw.push(line);
    }
  };
  return {
    destination,
    records: () => raw.map((l) => JSON.parse(l) as LogRecord)
  };
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

describe('createLogger — output format', () => {
  it('emits "message" key (not "msg") for Datadog ingestion', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info('hello');
    expect(records()[0]).toHaveProperty('message', 'hello');
    expect(records()[0]).not.toHaveProperty('msg');
  });

  it('emits string level labels (not numeric values)', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info('test');
    expect(records()[0]).toHaveProperty('level', 'info');
  });

  it('emits ISO 8601 "timestamp" (not Unix epoch "time")', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info('test');
    const record = records()[0];
    expect(record).toHaveProperty('timestamp');
    expect(record).not.toHaveProperty('time');
    expect(typeof record['timestamp']).toBe('string');
    expect(record['timestamp'] as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('suppresses pid and hostname fields', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info('test');
    expect(records()[0]).not.toHaveProperty('pid');
    expect(records()[0]).not.toHaveProperty('hostname');
  });

  it('renames a "timestamp" key in the merge object to "callerTimestamp"', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info({ timestamp: 'caller-supplied' }, 'test');
    const [warn, log] = records();
    expect(warn).toHaveProperty('level', 'warn');
    expect(log).toHaveProperty('callerTimestamp', 'caller-supplied');
    expect(log).not.toHaveProperty('timestamp', 'caller-supplied');
  });
});

// ---------------------------------------------------------------------------
// Reserved key guard — error_info
// ---------------------------------------------------------------------------

describe('reserved key guard — error_info', () => {
  it('emits a warn-level warning when error_info is supplied in the merge object', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info({ error_info: { bad: true } }, 'test');
    expect(records()[0]).toHaveProperty('level', 'warn');
    expect(records()).toHaveLength(2);
  });

  it('preserves the conflicting value in the warning as callerErrorInfo', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info({ error_info: { bad: true } }, 'test');
    expect(records()[0]).toHaveProperty('callerErrorInfo', { bad: true });
  });

  it('strips error_info from the log record when no err is present', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    logger.info({ error_info: { bad: true } }, 'test');
    expect(records()[1]).not.toHaveProperty('error_info');
  });

  it('strips error_info and warns when err is a plain Error (no VError info to replace it)', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    const err = new Error('plain');
    logger.error({ err, error_info: { bad: true } }, err.message);
    const [warn, log] = records();
    expect(warn).toHaveProperty('callerErrorInfo', { bad: true });
    expect(log).not.toHaveProperty('error_info');
  });

  it('strips error_info and warns when err is a VError with no info', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    const err = new VError('no info');
    logger.error({ err, error_info: { bad: true } }, err.message);
    const [warn, log] = records();
    expect(warn).toHaveProperty('callerErrorInfo', { bad: true });
    expect(log).not.toHaveProperty('error_info');
  });

  it('strips caller error_info and replaces it with the real VError info', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    const err = new VError('fail', { info: { requestId: 'abc' } });
    logger.error({ err, error_info: { bad: true } }, err.message);
    const [warn, log] = records();
    expect(warn).toHaveProperty('callerErrorInfo', { bad: true });
    expect((log['error_info'] as Record<string, unknown>)['requestId']).toBe('abc');
    expect(log['error_info']).not.toHaveProperty('bad');
  });

  it('strips caller error_info, warns, and emits cause VError info when err is a WError', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    const cause = new VError('root', { info: { fromRoot: true } });
    const wrapped = new WError('wrapper', { cause });
    logger.error({ err: wrapped, error_info: { bad: true } }, wrapped.message);
    const [warn, log] = records();
    expect(warn).toHaveProperty('callerErrorInfo', { bad: true });
    expect((log['error_info'] as Record<string, unknown>)['fromRoot']).toBe(true);
    expect(log['error_info']).not.toHaveProperty('bad');
  });

  it('does not emit a warning when error_info is absent from the merge object', async () => {
    const { destination, records } = makeCapture();
    const logger = await createLogger({ destination });
    const err = new VError('fail', { info: { requestId: 'abc' } });
    logger.error({ err }, err.message);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toHaveProperty('level', 'error');
  });
});

// ---------------------------------------------------------------------------
// pino API integrity — root logger
// ---------------------------------------------------------------------------

describe('pino API integrity — root logger', () => {
  let logger!: Logger;
  let records!: () => LogRecord[];

  beforeEach(async () => {
    const capture = makeCapture();
    logger = await createLogger({ destination: capture.destination });
    records = capture.records;
  });

  it('fatal() emits a record at fatal level', () => {
    logger.fatal('fatal message');
    expect(records()[0]).toHaveProperty('level', 'fatal');
    expect(records()[0]).toHaveProperty('message', 'fatal message');
  });

  it('error() emits a record at error level', () => {
    logger.error('error message');
    expect(records()[0]).toHaveProperty('level', 'error');
    expect(records()[0]).toHaveProperty('message', 'error message');
  });

  it('warn() emits a record at warn level', () => {
    logger.warn('warn message');
    expect(records()[0]).toHaveProperty('level', 'warn');
    expect(records()[0]).toHaveProperty('message', 'warn message');
  });

  it('info() emits a record at info level', () => {
    logger.info('info message');
    expect(records()[0]).toHaveProperty('level', 'info');
    expect(records()[0]).toHaveProperty('message', 'info message');
  });

  it('debug() emits a record at debug level', () => {
    logger.debug('debug message');
    expect(records()[0]).toHaveProperty('level', 'debug');
    expect(records()[0]).toHaveProperty('message', 'debug message');
  });

  it('trace() emits a record at trace level', () => {
    logger.level = 'trace';
    logger.trace('trace message');
    expect(records()[0]).toHaveProperty('level', 'trace');
    expect(records()[0]).toHaveProperty('message', 'trace message');
  });

  it('merge object fields appear in log output', () => {
    logger.info({ requestId: 'abc', userId: 42 }, 'with merge');
    expect(records()[0]).toHaveProperty('requestId', 'abc');
    expect(records()[0]).toHaveProperty('userId', 42);
  });

  it('level getter returns current level', () => {
    expect(logger.level).toBe('debug');
  });

  it('level setter suppresses records below the new level', () => {
    logger.level = 'warn';
    logger.info('should be suppressed');
    logger.warn('should appear');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toHaveProperty('level', 'warn');
  });

  it('level setter change is reflected by getter', () => {
    logger.level = 'error';
    expect(logger.level).toBe('error');
  });

  it('isLevelEnabled() returns true for levels at or above current', () => {
    logger.level = 'warn';
    expect(logger.isLevelEnabled('fatal')).toBe(true);
    expect(logger.isLevelEnabled('error')).toBe(true);
    expect(logger.isLevelEnabled('warn')).toBe(true);
  });

  it('isLevelEnabled() returns false for levels below current', () => {
    logger.level = 'warn';
    expect(logger.isLevelEnabled('info')).toBe(false);
    expect(logger.isLevelEnabled('debug')).toBe(false);
    expect(logger.isLevelEnabled('trace')).toBe(false);
  });

  it('child() returns an Logger (has child)', () => {
    const child = logger.child({ component: 'test' });
    expect(typeof child.child).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// pino API integrity — child logger
// ---------------------------------------------------------------------------

describe('pino API integrity — child logger', () => {
  let child!: Logger;
  let records!: () => LogRecord[];

  beforeEach(async () => {
    const capture = makeCapture();
    const logger = await createLogger({ destination: capture.destination });
    child = logger.child({ component: 'worker' });
    records = capture.records;
  });

  it('fatal() works and includes parent bindings', () => {
    child.fatal('fatal');
    expect(records()[0]).toHaveProperty('level', 'fatal');
    expect(records()[0]).toHaveProperty('component', 'worker');
  });

  it('error() works and includes parent bindings', () => {
    child.error('error');
    expect(records()[0]).toHaveProperty('level', 'error');
    expect(records()[0]).toHaveProperty('component', 'worker');
  });

  it('warn() works and includes parent bindings', () => {
    child.warn('warn');
    expect(records()[0]).toHaveProperty('level', 'warn');
    expect(records()[0]).toHaveProperty('component', 'worker');
  });

  it('info() works and includes parent bindings', () => {
    child.info('info');
    expect(records()[0]).toHaveProperty('level', 'info');
    expect(records()[0]).toHaveProperty('component', 'worker');
  });

  it('debug() works and includes parent bindings', () => {
    child.debug('debug');
    expect(records()[0]).toHaveProperty('level', 'debug');
    expect(records()[0]).toHaveProperty('component', 'worker');
  });

  it('trace() works and includes parent bindings', () => {
    child.level = 'trace';
    child.trace('trace');
    expect(records()[0]).toHaveProperty('level', 'trace');
    expect(records()[0]).toHaveProperty('component', 'worker');
  });

  it('merge object fields appear alongside child bindings', () => {
    child.info({ requestId: 'xyz' }, 'with merge');
    expect(records()[0]).toHaveProperty('component', 'worker');
    expect(records()[0]).toHaveProperty('requestId', 'xyz');
  });

  it('level getter works', () => {
    expect(child.level).toBe('debug');
  });

  it('level setter suppresses records below the new level', () => {
    child.level = 'warn';
    child.info('suppressed');
    child.warn('visible');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toHaveProperty('level', 'warn');
  });

  it('isLevelEnabled() works', () => {
    child.level = 'warn';
    expect(child.isLevelEnabled('error')).toBe(true);
    expect(child.isLevelEnabled('debug')).toBe(false);
  });

  it('child.child() returns an Logger', () => {
    const grandchild = child.child({ subcomponent: 'task' });
    expect(typeof grandchild.child).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// pino API integrity — grandchild logger
// ---------------------------------------------------------------------------

describe('pino API integrity — grandchild logger', () => {
  let grandchild!: Logger;
  let records!: () => LogRecord[];

  beforeEach(async () => {
    const capture = makeCapture();
    const logger = await createLogger({ destination: capture.destination });
    grandchild = logger.child({ a: 1 }).child({ b: 2 });
    records = capture.records;
  });

  it('has child', () => {
    expect(typeof grandchild.child).toBe('function');
  });

  it('info() emits with both ancestor bindings merged', () => {
    grandchild.info('deep');
    expect(records()[0]).toHaveProperty('a', 1);
    expect(records()[0]).toHaveProperty('b', 2);
    expect(records()[0]).toHaveProperty('message', 'deep');
  });

  it('all log levels work', () => {
    grandchild.level = 'trace';
    grandchild.fatal('f');
    grandchild.error('e');
    grandchild.warn('w');
    grandchild.info('i');
    grandchild.debug('d');
    grandchild.trace('t');
    const levels = records().map((r) => r['level']);
    expect(levels).toEqual(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
  });

  it('error() with { err } emits with both ancestor bindings merged', () => {
    grandchild.error({ err: new Error('deep error') }, 'deep error');
    expect(records()[0]).toHaveProperty('a', 1);
    expect(records()[0]).toHaveProperty('b', 2);
    expect(records()[0]).toHaveProperty('message', 'deep error');
  });

  it('level getter and setter work', () => {
    grandchild.level = 'error';
    expect(grandchild.level).toBe('error');
    grandchild.info('suppressed');
    expect(records()).toHaveLength(0);
  });

  it('isLevelEnabled() works', () => {
    grandchild.level = 'warn';
    expect(grandchild.isLevelEnabled('error')).toBe(true);
    expect(grandchild.isLevelEnabled('debug')).toBe(false);
  });

  it('great-grandchild inherits all three levels of bindings', () => {
    const great = grandchild.child({ c: 3 });
    great.info('very deep');
    expect(records()[0]).toHaveProperty('a', 1);
    expect(records()[0]).toHaveProperty('b', 2);
    expect(records()[0]).toHaveProperty('c', 3);
  });
});

// ---------------------------------------------------------------------------
// VError / WError handling
// ---------------------------------------------------------------------------

describe('VError/WError handling', () => {
  let logger!: Logger;
  let records!: () => LogRecord[];

  beforeEach(async () => {
    const capture = makeCapture();
    logger = await createLogger({ destination: capture.destination });
    records = capture.records;
  });

  it('logger.error({ err }) logs a plain Error with err field', () => {
    const err = new Error('something went wrong');
    logger.error({ err }, err.message);
    expect(records()[0]).toHaveProperty('level', 'error');
    expect(records()[0]).toHaveProperty('message', 'something went wrong');
    expect(records()[0]).toHaveProperty('err');
  });

  it('logger.error({ err }) emits error_info for a VError with info', () => {
    const err = new VError('upstream failed', { info: { requestId: 'abc123', statusCode: 500 } });
    logger.error({ err }, err.message);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toHaveProperty('error_info');
    expect((records()[0]['error_info'] as Record<string, unknown>)['requestId']).toBe('abc123');
    expect((records()[0]['error_info'] as Record<string, unknown>)['statusCode']).toBe(500);
  });

  it('logger.warn({ err }) also emits error_info for a VError', () => {
    const err = new VError('upstream failed', { info: { requestId: 'abc123' } });
    logger.warn({ err }, err.message);
    expect(records()[0]).toHaveProperty('level', 'warn');
    expect(records()[0]).toHaveProperty('error_info');
    expect((records()[0]['error_info'] as Record<string, unknown>)['requestId']).toBe('abc123');
  });

  it('omits error_info for a VError with no info', () => {
    logger.error({ err: new VError('no info here') }, 'no info here');
    expect(records()).toHaveLength(1);
    expect(records()[0]).not.toHaveProperty('error_info');
  });

  it('omits error_info for a plain Error', () => {
    logger.error({ err: new Error('plain') }, 'plain');
    expect(records()[0]).not.toHaveProperty('error_info');
  });

  it('logger.error({ err: wErr }) logs the cause, not the WError wrapper', () => {
    const root = new Error('root cause');
    const wrapped = new WError('wrapped error', { cause: root });
    logger.error({ err: wrapped }, wrapped.message);
    expect(records()).toHaveLength(1);
    expect((records()[0]['err'] as Record<string, unknown>)['message']).toBe('root cause');
  });

  it('logger.warn({ err: wErr }) also unwraps WError to the cause', () => {
    const root = new Error('root cause');
    const wrapped = new WError('wrapped error', { cause: root });
    logger.warn({ err: wrapped }, wrapped.message);
    expect(records()).toHaveLength(1);
    expect((records()[0]['err'] as Record<string, unknown>)['message']).toBe('root cause');
  });

  it('merges call-site context into the log entry alongside err', () => {
    const err = new Error('db failed');
    logger.error({ err, requestId: 'xyz', userId: 42 }, err.message);
    expect(records()[0]).toHaveProperty('requestId', 'xyz');
    expect(records()[0]).toHaveProperty('userId', 42);
  });

  it('call-site context and VError info occupy separate namespaces', () => {
    const err = new VError('failed', { info: { fromError: 'yes' } });
    logger.error({ err, fromCallsite: 'yes' }, err.message);
    expect(records()[0]).toHaveProperty('fromCallsite', 'yes');
    expect((records()[0]['error_info'] as Record<string, unknown>)['fromError']).toBe('yes');
  });

  it('carries call-site context through WError unwrapping', () => {
    const root = new Error('root cause');
    const wrapped = new WError('wrapper', { cause: root });
    logger.error({ err: wrapped, requestId: 'abc' }, wrapped.message);
    expect(records()[0]).toHaveProperty('requestId', 'abc');
    expect((records()[0]['err'] as Record<string, unknown>)['message']).toBe('root cause');
  });

  it('error_info reflects the cause chain info after WError unwrapping', () => {
    const root = new VError('root', { info: { fromRoot: true } });
    const wrapped = new WError('wrapper', { cause: root });
    logger.error({ err: wrapped }, wrapped.message);
    expect((records()[0]['error_info'] as Record<string, unknown>)['fromRoot']).toBe(true);
  });

  it('does not infinite-loop when a WError has no valid cause', () => {
    // WError without a cause: VError.cause() returns null, loop must break rather
    // than falling back to the same WError instance indefinitely.
    // Simulate a JS caller passing a non-Error cause, bypassing TypeScript.
    // VError.cause() returns null, loop must break rather than falling back to
    // the same WError instance indefinitely.
    const causeless = new WError('no cause', { cause: null as unknown as Error });
    expect(() => logger.error({ err: causeless }, causeless.message)).not.toThrow();
    expect(records()[0]).toHaveProperty('level', 'error');
  });
});

// ---------------------------------------------------------------------------
// Sentry integration
// ---------------------------------------------------------------------------

describe('Sentry integration', () => {
  it('calls captureException on logger.error({ err })', async () => {
    const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
    const { destination } = makeCapture();
    const logger = await createLogger({ destination, sentry });
    const err = new Error('oops');
    logger.error({ err }, err.message);
    expect(sentry.captureException).toHaveBeenCalledWith(err);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('calls captureException on logger.fatal({ err })', async () => {
    const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
    const { destination } = makeCapture();
    const logger = await createLogger({ destination, sentry });
    const err = new Error('fatal oops');
    logger.fatal({ err }, err.message);
    expect(sentry.captureException).toHaveBeenCalledWith(err);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does NOT call captureException on logger.warn({ err })', async () => {
    const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
    const { destination } = makeCapture();
    const logger = await createLogger({ destination, sentry });
    logger.warn({ err: new Error('just a warning') }, 'just a warning');
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures the cause of a WError, not the wrapper', async () => {
    const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
    const { destination } = makeCapture();
    const logger = await createLogger({ destination, sentry });
    const root = new Error('root');
    const wrapped = new WError('wrapped', { cause: root });
    logger.error({ err: wrapped }, wrapped.message);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(root);
    expect(sentry.captureException).not.toHaveBeenCalledWith(wrapped);
  });

  it('propagates to child loggers', async () => {
    const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
    const { destination } = makeCapture();
    const logger = await createLogger({ destination, sentry });
    const err = new Error('child error');
    logger.child({ component: 'worker' }).error({ err }, err.message);
    expect(sentry.captureException).toHaveBeenCalledWith(err);
  });

  it('propagates to grandchild loggers', async () => {
    const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
    const { destination } = makeCapture();
    const logger = await createLogger({ destination, sentry });
    const err = new Error('deep');
    logger.child({ a: 1 }).child({ b: 2 }).error({ err }, err.message);
    expect(sentry.captureException).toHaveBeenCalledWith(err);
  });
});
