import { describe, it, expect, jest } from '@jest/globals';
import { SlApi, type SlApiDeps } from '../src/lib/slapi.js';

type FetchLike = typeof fetch;

function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
): jest.Mock<FetchLike> {
  let i = 0;
  return jest.fn(async () => {
    const r = responses[i++];
    if (!r) throw new Error('out of scripted responses');
    return {
      ok: r.status < 400,
      status: r.status,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as jest.Mock<FetchLike>;
}

function makeApi(over: Partial<SlApiDeps> = {}): SlApi {
  return new SlApi({
    baseUrl: 'https://example/api',
    email: 'me@x',
    password: 'pw',
    fetch: fakeFetch([]) as unknown as typeof fetch,
    getCachedToken: () => undefined,
    setCachedToken: () => {},
    ...over,
  });
}

describe('SlApi.login', () => {
  it('Проверяет: POST /auth/login с email+password, возвращает accessToken', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { accessToken: 'TOK' } }]);
    const api = makeApi({ fetch: fetchImpl as unknown as typeof fetch });
    const tok = await api.login();
    expect(tok).toBe('TOK');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example/api/auth/login');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: 'me@x',
      password: 'pw',
    });
  });

  it('Проверяет: 401 → ошибка с понятным текстом', async () => {
    const fetchImpl = fakeFetch([{ status: 401, body: { message: 'bad creds' } }]);
    const api = makeApi({ fetch: fetchImpl as unknown as typeof fetch });
    await expect(api.login()).rejects.toThrow(/login.*401/i);
  });

  it('Проверяет: пустой accessToken → ошибка', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
    const api = makeApi({ fetch: fetchImpl as unknown as typeof fetch });
    await expect(api.login()).rejects.toThrow(/empty token/i);
  });
});

describe('SlApi.getToken', () => {
  it('Проверяет: cache hit → не идёт в сеть', async () => {
    const fetchImpl = fakeFetch([]);
    const api = makeApi({
      fetch: fetchImpl as unknown as typeof fetch,
      getCachedToken: () => 'CACHED',
    });
    expect(await api.getToken()).toBe('CACHED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Проверяет: miss → login + setCachedToken', async () => {
    const fetchImpl = fakeFetch([{ status: 200, body: { accessToken: 'NEW' } }]);
    const set = jest.fn();
    const api = makeApi({
      fetch: fetchImpl as unknown as typeof fetch,
      getCachedToken: () => undefined,
      setCachedToken: set,
    });
    expect(await api.getToken()).toBe('NEW');
    expect(set).toHaveBeenCalledWith('NEW');
  });
});

describe('SlApi.getSpreadsheets', () => {
  it('Проверяет: GET /admin/ss с Bearer, преобразование в SlSpreadsheetRow[]', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { accessToken: 'T' } },
      {
        status: 200,
        body: [
          {
            spreadsheet_id: '1abc',
            client_id: 42,
            title: 'Hello',
            template_name: 'unit',
            is_active: true,
            server: 'sl-1',
          },
          { spreadsheet_id: '2xyz', client_id: 54, title: 'World', is_active: false },
        ],
      },
    ]);
    const api = makeApi({ fetch: fetchImpl as unknown as typeof fetch });
    const r = await api.getSpreadsheets();
    expect(r).toEqual([
      {
        ssId: '1abc',
        clientId: 42,
        title: 'Hello',
        templateName: 'unit',
        isActive: true,
        server: 'sl-1',
      },
      {
        ssId: '2xyz',
        clientId: 54,
        title: 'World',
        templateName: null,
        isActive: false,
        server: null,
      },
    ]);
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe('https://example/api/admin/ss');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer T');
  });
});

describe('SlApi.getClients', () => {
  it('Проверяет: GET /admin/client с Bearer, преобразование в SlClientRow[]', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { accessToken: 'T' } },
      {
        status: 200,
        body: [
          {
            id: 42,
            server: 'sl-1',
            is_active: true,
            is_locked: false,
            is_deleted: false,
          },
          { id: 54, server: null, is_active: false, is_locked: false, is_deleted: false },
          { id: '99', server: 'sl-2', is_active: true },
        ],
      },
    ]);
    const api = makeApi({ fetch: fetchImpl as unknown as typeof fetch });
    const r = await api.getClients();
    expect(r).toEqual([
      { clientId: 42, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
      { clientId: 54, server: null, isActive: false, isLocked: false, isDeleted: false },
      { clientId: 99, server: 'sl-2', isActive: true, isLocked: false, isDeleted: false },
    ]);
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe('https://example/api/admin/client');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer T');
  });

  it('Проверяет: пропускает строки без id', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, body: { accessToken: 'T' } },
      {
        status: 200,
        body: [
          { id: 42, server: 'sl-1', is_active: true },
          { server: 'sl-2', is_active: true },
        ],
      },
    ]);
    const api = makeApi({ fetch: fetchImpl as unknown as typeof fetch });
    const r = await api.getClients();
    expect(r.map((x) => x.clientId)).toEqual([42]);
  });
});
