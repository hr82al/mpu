import type { SlSpreadsheetRow } from './sl-spreadsheets.js';
import type { SlClientRow } from './sl-clients.js';

export interface SlApiDeps {
  baseUrl: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
  /** Token cache hooks (10 min TTL, owned by caller). */
  getCachedToken: () => string | undefined;
  setCachedToken: (token: string) => void;
}

export class SlApiError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, opts: { status?: number; body?: string } = {}) {
    super(message);
    this.name = 'SlApiError';
    this.status = opts.status;
    this.body = opts.body;
  }
}

export class SlApi {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getCachedToken: () => string | undefined;
  private readonly setCachedToken: (token: string) => void;

  constructor(deps: SlApiDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.email = deps.email;
    this.password = deps.password;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.getCachedToken = deps.getCachedToken;
    this.setCachedToken = deps.setCachedToken;
  }

  async login(): Promise<string> {
    const url = `${this.baseUrl}/auth/login`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new SlApiError(`sl-back login failed: HTTP ${resp.status}`, {
        status: resp.status,
        body: truncate(text, 500),
      });
    }
    let parsed: { accessToken?: string };
    try {
      parsed = JSON.parse(text) as { accessToken?: string };
    } catch {
      throw new SlApiError(`sl-back login: non-JSON response: ${truncate(text, 200)}`);
    }
    if (!parsed.accessToken) {
      throw new SlApiError(`sl-back login: empty token in response: ${truncate(text, 200)}`);
    }
    return parsed.accessToken;
  }

  async getToken(): Promise<string> {
    const cached = this.getCachedToken();
    if (cached) return cached;
    const fresh = await this.login();
    this.setCachedToken(fresh);
    return fresh;
  }

  async getSpreadsheets(): Promise<SlSpreadsheetRow[]> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/admin/ss`;
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new SlApiError(`GET /admin/ss failed: HTTP ${resp.status}`, {
        status: resp.status,
        body: truncate(text, 500),
      });
    }
    const data = JSON.parse(text) as Array<Record<string, unknown>>;
    return data.map(toRow).filter((r): r is SlSpreadsheetRow => r !== null);
  }

  async getClients(): Promise<SlClientRow[]> {
    const token = await this.getToken();
    const url = `${this.baseUrl}/admin/client`;
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new SlApiError(`GET /admin/client failed: HTTP ${resp.status}`, {
        status: resp.status,
        body: truncate(text, 500),
      });
    }
    const data = JSON.parse(text) as Array<Record<string, unknown>>;
    return data.map(toClientRow).filter((r): r is SlClientRow => r !== null);
  }
}

function toRow(item: Record<string, unknown>): SlSpreadsheetRow | null {
  const ssId = typeof item['spreadsheet_id'] === 'string' ? item['spreadsheet_id'] : null;
  const clientId =
    typeof item['client_id'] === 'number'
      ? item['client_id']
      : typeof item['client_id'] === 'string'
        ? Number.parseInt(item['client_id'], 10)
        : null;
  if (!ssId || clientId === null || Number.isNaN(clientId)) return null;
  return {
    ssId,
    clientId,
    title: typeof item['title'] === 'string' ? item['title'] : '',
    templateName:
      typeof item['template_name'] === 'string' ? item['template_name'] : null,
    isActive: item['is_active'] !== false,
    server: typeof item['server'] === 'string' ? item['server'] : null,
  };
}

function toClientRow(item: Record<string, unknown>): SlClientRow | null {
  const idRaw = item['id'];
  const clientId =
    typeof idRaw === 'number'
      ? idRaw
      : typeof idRaw === 'string'
        ? Number.parseInt(idRaw, 10)
        : null;
  if (clientId === null || Number.isNaN(clientId)) return null;
  return {
    clientId,
    server: typeof item['server'] === 'string' ? item['server'] : null,
    isActive: item['is_active'] !== false,
    isLocked: item['is_locked'] === true,
    isDeleted: item['is_deleted'] === true,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `…(+${s.length - n} bytes)`;
}
