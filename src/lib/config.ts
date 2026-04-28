import type { DB } from './db.js';
import { getDefaultDb } from './db.js';

type ConfigType = 'bool' | 'int' | 'string';

export type ConfigValue = boolean | number | string;

interface ConfigEntry {
  type: ConfigType;
  default: ConfigValue;
  description: string;
  validate?: (v: ConfigValue) => true | string;
}

export const CONFIG_REGISTRY: Record<string, ConfigEntry> = {
  'cache.ttl': {
    type: 'int',
    default: 3600,
    description: 'Default TTL for cached values, in seconds (0 = caching disabled)',
    validate: (v) => (typeof v === 'number' && v >= 0 ? true : 'must be an integer >= 0'),
  },
  'sheet.default': {
    type: 'string',
    default: '',
    description: 'Default Google Spreadsheet ID (or URL) used when --spreadsheet/-s is omitted',
  },
  'sheet.url': {
    type: 'string',
    default: '',
    description:
      'Google Apps Script webapp URL (overrides env WB_PLUS_WEB_APP_URL). Required for sheet operations.',
  },
  'http.retries': {
    type: 'int',
    default: 5,
    description: 'Max attempts for retryable HTTP errors (network, 5xx, 429)',
    validate: (v) => (typeof v === 'number' && v >= 1 ? true : 'must be an integer >= 1'),
  },
  'http.timeout': {
    type: 'int',
    default: 120,
    description: 'HTTP request timeout in seconds',
    validate: (v) => (typeof v === 'number' && v >= 1 ? true : 'must be an integer >= 1'),
  },
  'sheet.protected': {
    type: 'bool',
    default: true,
    description:
      'When true, write operations (sheet set) require explicit --force/-f. Set to false to disable the guard globally.',
  },
  'sheet.cache.ttl': {
    type: 'int',
    default: 3600,
    description:
      'Per-cell sheet cache TTL in seconds (0 = covering cache disabled, network always)',
    validate: (v) => (typeof v === 'number' && v >= 0 ? true : 'must be an integer >= 0'),
  },
};

export interface ConfigListEntry {
  key: string;
  value: ConfigValue;
  default: ConfigValue;
  description: string;
  overridden: boolean;
}

export class Config {
  private getStmt;
  private setStmt;
  private delStmt;
  private listStmt;

  constructor(db: DB) {
    this.getStmt = db.prepare<[string], { value: string }>(
      'SELECT value FROM config WHERE key = ?',
    );
    this.setStmt = db.prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.delStmt = db.prepare('DELETE FROM config WHERE key = ?');
    this.listStmt = db.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM config',
    );
  }

  get(key: 'cache.ttl'): number;
  get(key: string): ConfigValue;
  get(key: string): ConfigValue {
    const entry = requireEntry(key);
    const row = this.getStmt.get(key);
    if (!row) return entry.default;
    return parseValue(entry.type, row.value);
  }

  set(key: string, value: unknown): void {
    const entry = requireEntry(key);
    const parsed = coerceValue(entry.type, value);
    if (entry.validate) {
      const result = entry.validate(parsed);
      if (result !== true) throw new Error(`Invalid value for ${key}: ${result}`);
    }
    this.setStmt.run(key, serializeValue(entry.type, parsed));
  }

  unset(key: string): void {
    requireEntry(key);
    this.delStmt.run(key);
  }

  list(): ConfigListEntry[] {
    const overridden = new Map(this.listStmt.all().map((r) => [r.key, r.value]));
    return Object.entries(CONFIG_REGISTRY).map(([key, entry]) => {
      const raw = overridden.get(key);
      return {
        key,
        value: raw === undefined ? entry.default : parseValue(entry.type, raw),
        default: entry.default,
        description: entry.description,
        overridden: raw !== undefined,
      };
    });
  }
}

function requireEntry(key: string): ConfigEntry {
  const entry = CONFIG_REGISTRY[key];
  if (!entry) {
    const valid = Object.keys(CONFIG_REGISTRY).join(', ');
    throw new Error(`Unknown config key: "${key}". Valid keys: ${valid}`);
  }
  return entry;
}

function parseValue(type: ConfigType, raw: string): ConfigValue {
  switch (type) {
    case 'bool':
      return raw === 'true';
    case 'int':
      return Number.parseInt(raw, 10);
    case 'string':
      return raw;
  }
}

function serializeValue(type: ConfigType, value: ConfigValue): string {
  switch (type) {
    case 'bool':
      return value ? 'true' : 'false';
    case 'int':
      return String(value);
    case 'string':
      return String(value);
  }
}

function coerceValue(type: ConfigType, input: unknown): ConfigValue {
  if (type === 'bool') {
    if (typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      const s = input.toLowerCase();
      if (['true', 'on', 'yes', '1'].includes(s)) return true;
      if (['false', 'off', 'no', '0'].includes(s)) return false;
      throw new Error(`cannot parse bool from "${input}" (expected on/off/true/false/yes/no/1/0)`);
    }
    throw new Error(`expected bool, got ${typeof input}`);
  }
  if (type === 'int') {
    const n = typeof input === 'number' ? input : Number(input);
    if (!Number.isInteger(n)) throw new Error(`expected integer, got "${input}"`);
    return n;
  }
  return String(input);
}

let defaultInstance: Config | null = null;
export function getDefaultConfig(): Config {
  if (!defaultInstance) defaultInstance = new Config(getDefaultDb());
  return defaultInstance;
}
