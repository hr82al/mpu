import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultDbPath(): string {
  if (process.env['MPU_DB']) return process.env['MPU_DB'];
  const cfgHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(cfgHome, 'mpu', 'mpu.db');
}
