import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultEnvPath(): string {
  if (process.env['MPU_ENV']) return process.env['MPU_ENV'];
  const cfgHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(cfgHome, 'mpu', '.env');
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(path: string = defaultEnvPath()): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  return parseEnvFile(text);
}

export interface EnvLookup {
  get(key: string): string | undefined;
  source(key: string): 'process' | 'file' | undefined;
}

export function envLookup(fileEnv: Record<string, string> = loadEnv()): EnvLookup {
  return {
    get(key) {
      const fromProc = process.env[key];
      if (fromProc !== undefined && fromProc !== '') return fromProc;
      const fromFile = fileEnv[key];
      if (fromFile !== undefined && fromFile !== '') return fromFile;
      return undefined;
    },
    source(key) {
      if (process.env[key] !== undefined && process.env[key] !== '') return 'process';
      if (fileEnv[key] !== undefined && fileEnv[key] !== '') return 'file';
      return undefined;
    },
  };
}
