import { describe, it, expect } from '@jest/globals';
import {
  resolveDbTarget,
  DbResolveError,
  type DbResolveDeps,
  type SsLookup,
  type ClientLookup,
} from '../src/lib/db-resolve.js';
import type { SlSpreadsheetRow } from '../src/lib/sl-spreadsheets.js';
import type { SlClientRow } from '../src/lib/sl-clients.js';

const SS: SlSpreadsheetRow[] = [
  { ssId: '1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs', clientId: 3377, title: 'PrintPortal | 10X WB', templateName: 'wb10xMain', isActive: true, server: null },
  { ssId: '1NkXPNDZs4HOH4lqUPBx2j0QD_9zEsc0G50P84skakqc', clientId: 2578, title: 'Blisteria | 10X WB', templateName: 'wb10xMain', isActive: true, server: null },
  { ssId: '1abcOTHER0000000000000000000000000000000000', clientId: 42, title: 'Cool Flaps', templateName: 'unit_v2', isActive: true, server: null },
];

const CLIENTS: SlClientRow[] = [
  { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
  { clientId: 2578, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
  { clientId: 42, server: 'sl-2', isActive: true, isLocked: false, isDeleted: false },
];

const ENV: Record<string, string> = { 'sl-1': '10.0.0.1', 'sl-2': '10.0.0.2' };

function makeDeps(): DbResolveDeps {
  const ss: SsLookup = {
    get: (id) => SS.find((r) => r.ssId === id),
    bySubstring: (p) => (p ? SS.filter((r) => r.ssId.includes(p)) : []),
    fuzzyByTitle: (q) => SS.filter((r) => r.title.toLowerCase().includes(q.toLowerCase())),
  };
  const clients: ClientLookup = {
    get: (id) => CLIENTS.find((r) => r.clientId === id),
    byServer: (s) => CLIENTS.filter((r) => r.server === s),
  };
  return { ss, clients, env: (k) => ENV[k] };
}

describe('resolveDbTarget — explicit flags', () => {
  it('Проверяет: --ss <full id> → client mode', () => {
    const r = resolveDbTarget({ ss: '1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs' }, makeDeps());
    expect(r).toEqual({ kind: 'client', clientId: 3377, server: 'sl-1', ip: '10.0.0.1' });
  });

  it('Проверяет: --client → client mode', () => {
    const r = resolveDbTarget({ client: 3377 }, makeDeps());
    expect(r.kind).toBe('client');
    if (r.kind === 'client') {
      expect(r.clientId).toBe(3377);
      expect(r.ip).toBe('10.0.0.1');
    }
  });

  it('Проверяет: --server + --schema → direct mode (schema нормализуется)', () => {
    const r = resolveDbTarget({ server: 'sl-2', schema: '42' }, makeDeps());
    expect(r).toEqual({ kind: 'direct', server: 'sl-2', ip: '10.0.0.2', schema: 'schema_42' });

    const r2 = resolveDbTarget({ server: 'sl-2', schema: 'schema_42' }, makeDeps());
    expect(r2).toEqual({ kind: 'direct', server: 'sl-2', ip: '10.0.0.2', schema: 'schema_42' });
  });

  it('Проверяет: --server без --schema → ошибка', () => {
    expect(() => resolveDbTarget({ server: 'sl-2' }, makeDeps())).toThrow(/schema/i);
  });

  it('Проверяет: пустой ввод → ошибка', () => {
    expect(() => resolveDbTarget({}, makeDeps())).toThrow(/specify/i);
  });
});

describe('resolveDbTarget — hint', () => {
  it('Проверяет: full ssId через позиционный hint', () => {
    const r = resolveDbTarget({ hint: '1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs' }, makeDeps());
    expect(r).toEqual({ kind: 'client', clientId: 3377, server: 'sl-1', ip: '10.0.0.1' });
  });

  it('Проверяет: prefix ssId если уникальный', () => {
    const r = resolveDbTarget({ hint: '1YCG33' }, makeDeps());
    expect(r.kind).toBe('client');
    if (r.kind === 'client') expect(r.clientId).toBe(3377);
  });

  it('Проверяет: middle-fragment ssId (не prefix) — substring match', () => {
    const r = resolveDbTarget({ hint: 'FWPditVaTNOdHUaWN' }, makeDeps());
    expect(r.kind).toBe('client');
    if (r.kind === 'client') expect(r.clientId).toBe(3377);
  });

  it('Проверяет: substring ssId если несколько → ambiguous', () => {
    const r = () => resolveDbTarget({ hint: '1' }, makeDeps());
    expect(r).toThrow(DbResolveError);
    expect(r).toThrow(/ambiguous|multiple/i);
  });

  it('Проверяет: numeric → client_id', () => {
    const r = resolveDbTarget({ hint: '3377' }, makeDeps());
    expect(r.kind).toBe('client');
    if (r.kind === 'client') expect(r.clientId).toBe(3377);
  });

  it('Проверяет: IP + --schema → direct', () => {
    const r = resolveDbTarget({ hint: '10.0.0.5', schema: '42' }, makeDeps());
    expect(r).toEqual({ kind: 'direct', server: '10.0.0.5', ip: '10.0.0.5', schema: 'schema_42' });
  });

  it('Проверяет: IP без --schema → ambiguous (нужен schema)', () => {
    expect(() => resolveDbTarget({ hint: '10.0.0.5' }, makeDeps())).toThrow(/schema/i);
  });

  it('Проверяет: server name → если один клиент на сервере, client mode', () => {
    // sl-2 имеет одного клиента (42) → unambiguous
    const r = resolveDbTarget({ hint: 'sl-2' }, makeDeps());
    expect(r.kind).toBe('client');
    if (r.kind === 'client') expect(r.clientId).toBe(42);
  });

  it('Проверяет: server name + --schema → direct', () => {
    const r = resolveDbTarget({ hint: 'sl-1', schema: '999' }, makeDeps());
    expect(r).toEqual({ kind: 'direct', server: 'sl-1', ip: '10.0.0.1', schema: 'schema_999' });
  });

  it('Проверяет: server name с несколькими клиентами без --schema → ambiguous', () => {
    expect(() => resolveDbTarget({ hint: 'sl-1' }, makeDeps())).toThrow(/ambiguous|multiple/i);
  });

  it('Проверяет: title fuzzy → если уникальный, client mode', () => {
    const r = resolveDbTarget({ hint: 'PrintPortal' }, makeDeps());
    expect(r.kind).toBe('client');
    if (r.kind === 'client') expect(r.clientId).toBe(3377);
  });

  it('Проверяет: exact-title fast-path — точный title выигрывает у fuzzy шума', () => {
    // Подкладываем дополнительные записи с title, которые fuzzy-захватит, но точно не равны искомому
    const SS_NOISY = [
      { ssId: '1AAA', clientId: 100, title: 'PrintPortal | 10X WB', templateName: null, isActive: true, server: null },
      { ssId: '1BBB', clientId: 200, title: 'PrintPortal Backup | 10X WB', templateName: null, isActive: true, server: null },
      { ssId: '1CCC', clientId: 300, title: 'Old PrintPortal | 10X WB', templateName: null, isActive: true, server: null },
    ];
    const CLIENTS_NOISY = [
      { clientId: 100, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
      { clientId: 200, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
      { clientId: 300, server: 'sl-2', isActive: true, isLocked: false, isDeleted: false },
    ];
    const deps = {
      ss: {
        get: (id: string) => SS_NOISY.find((r) => r.ssId === id),
        bySubstring: (p: string) => (p ? SS_NOISY.filter((r) => r.ssId.includes(p)) : []),
        // эмулируем щедрый fuzzy: возвращает все, что содержит подстроку
        fuzzyByTitle: (q: string) =>
          SS_NOISY.filter((r) => r.title.toLowerCase().includes(q.toLowerCase())),
      },
      clients: {
        get: (id: number) => CLIENTS_NOISY.find((r) => r.clientId === id),
        byServer: (s: string) => CLIENTS_NOISY.filter((r) => r.server === s),
      },
      env: (k: string) => ({ 'sl-1': '10.0.0.1', 'sl-2': '10.0.0.2' })[k],
    };
    const r = resolveDbTarget({ hint: 'PrintPortal | 10X WB' }, deps);
    expect(r.kind).toBe('client');
    if (r.kind === 'client') expect(r.clientId).toBe(100);
  });

  it('Проверяет: title fuzzy "10X WB" → много матчей → ambiguous', () => {
    expect(() => resolveDbTarget({ hint: '10X WB' }, makeDeps())).toThrow(/ambiguous|multiple/i);
  });

  it('Проверяет: title fuzzy не находит → понятная ошибка с подсказкой', () => {
    expect(() => resolveDbTarget({ hint: 'NonExistentTitle' }, makeDeps())).toThrow(
      /no match|not found/i,
    );
  });
});
