import { describe, it, expect, jest } from '@jest/globals';
import { WebappClient, WebappError, classifyWebappError } from '../src/lib/webapp.js';

type FetchLike = (url: string, init: { body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

function fakeFetch(
  responses: Array<{ status: number; body: string } | Error>,
): jest.Mock<FetchLike> {
  let i = 0;
  return jest.fn(async () => {
    const r = responses[i++];
    if (!r) throw new Error('fakeFetch: out of scripted responses');
    if (r instanceof Error) throw r;
    return {
      ok: r.status < 400,
      status: r.status,
      text: async () => r.body,
    };
  }) as jest.Mock<FetchLike>;
}

const okResp = (result: unknown) =>
  JSON.stringify({ success: true, result, action: 'spreadsheets/values/batchGet' });

function makeClient(fetchImpl: FetchLike) {
  return new WebappClient({
    url: 'https://example/exec',
    fetch: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
    policy: {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      jitter: 0,
      quotaDelayMs: 5,
    },
  });
}

describe('WebappClient', () => {
  it('Проверяет: успешный запрос возвращает result', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: okResp({ values: [[1]] }) }]);
    const c = makeClient(fetchImpl);
    const r = await c.do('spreadsheets/values/batchGet', { ssId: 'X', ranges: ['A1'] });
    expect(r).toEqual({ values: [[1]] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Проверяет: 5xx ретраится и затем успех', async () => {
    const fetchImpl = fakeFetch([
      { status: 500, body: 'oops' },
      { status: 200, body: okResp({ ok: 1 }) },
    ]);
    const c = makeClient(fetchImpl);
    const r = await c.do('spreadsheets/values/batchGet', { ssId: 'X' });
    expect(r).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('Проверяет: 4xx — fatal, не ретраится', async () => {
    const fetchImpl = fakeFetch([{ status: 401, body: 'unauth' }]);
    const c = makeClient(fetchImpl);
    await expect(c.do('x', {})).rejects.toBeInstanceOf(WebappError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Проверяет: WebappError содержит action, ssId, attempts, status, body', async () => {
    const fetchImpl = fakeFetch([
      { status: 500, body: 'a' },
      { status: 500, body: 'b' },
      { status: 500, body: 'c' },
    ]);
    const c = makeClient(fetchImpl);
    let caught: WebappError | undefined;
    try {
      await c.do('spreadsheets/values/batchGet', { ssId: 'SHEET_X' });
    } catch (e) {
      caught = e as WebappError;
    }
    expect(caught).toBeInstanceOf(WebappError);
    expect(caught!.action).toBe('spreadsheets/values/batchGet');
    expect(caught!.ssId).toBe('SHEET_X');
    expect(caught!.attempts).toBe(3);
    expect(caught!.lastStatus).toBe(500);
    expect(caught!.lastBody).toContain('c');
    const msg = caught!.message;
    expect(msg).toMatch(/spreadsheets\/values\/batchGet/);
    expect(msg).toMatch(/SHEET_X/);
    expect(msg).toMatch(/attempts=3/);
    expect(msg).toMatch(/HTTP 500/);
  });

  it('Проверяет: success=false с error="Quota exceeded" -> retry-after-quota', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: JSON.stringify({ success: false, error: 'Quota exceeded' }) },
      { status: 200, body: okResp({ ok: true }) },
    ]);
    const sleepCalls: number[] = [];
    const c = new WebappClient({
      url: 'https://example/exec',
      fetch: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      policy: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: 0,
        quotaDelayMs: 60_000,
      },
    });
    const r = await c.do('x', {});
    expect(r).toEqual({ ok: true });
    expect(sleepCalls).toEqual([60_000]);
  });

  it('Проверяет: success=false с обычной ошибкой — fatal с понятным текстом', async () => {
    const fetchImpl = fakeFetch([
      {
        status: 200,
        body: JSON.stringify({ success: false, error: 'Sheet "WAT" not found' }),
      },
    ]);
    const c = makeClient(fetchImpl);
    let caught: WebappError | undefined;
    try {
      await c.do('spreadsheets/values/batchGet', { ssId: 'X' });
    } catch (e) {
      caught = e as WebappError;
    }
    expect(caught).toBeInstanceOf(WebappError);
    expect(caught!.message).toMatch(/Sheet "WAT" not found/);
    expect(caught!.attempts).toBe(1);
  });

  it('Проверяет: network error ретраится', async () => {
    const fetchImpl = fakeFetch([new Error('ECONNRESET'), { status: 200, body: okResp(1) }]);
    const c = makeClient(fetchImpl);
    expect(await c.do('x', {})).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('classifyWebappError', () => {
  it('Проверяет: классификация HTTP-кодов и app-errors', () => {
    expect(classifyWebappError({ kind: 'network', err: new Error('x') })).toBe('retry');
    expect(classifyWebappError({ kind: 'http', status: 500, body: '' })).toBe('retry');
    expect(classifyWebappError({ kind: 'http', status: 429, body: '' })).toBe('retry');
    expect(classifyWebappError({ kind: 'http', status: 401, body: '' })).toBe('fatal');
    expect(classifyWebappError({ kind: 'app', error: 'Quota exceeded' })).toBe('retry-after-quota');
    expect(classifyWebappError({ kind: 'app', error: 'whatever' })).toBe('fatal');
  });
});
