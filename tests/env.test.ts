import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, defaultEnvPath, parseEnvFile } from '../src/lib/env.js';

describe('env', () => {
  let tmp: string;
  const originalConfigHome = process.env['XDG_CONFIG_HOME'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mpu-env-'));
    process.env['XDG_CONFIG_HOME'] = tmp;
  });

  afterEach(() => {
    if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = originalConfigHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Проверяет: defaultEnvPath следует XDG_CONFIG_HOME', () => {
    expect(defaultEnvPath()).toBe(join(tmp, 'mpu', '.env'));
  });

  it('Проверяет: parseEnvFile разбирает KEY=VALUE, kомментарии, кавычки, пустые строки', () => {
    const text = [
      '# comment',
      '',
      'A=1',
      'B="two words"',
      "C='single quoted'",
      'D=plain value',
      '   E=trimmed',
      '#X=ignored',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      A: '1',
      B: 'two words',
      C: 'single quoted',
      D: 'plain value',
      E: 'trimmed',
    });
  });

  it('Проверяет: loadEnv возвращает пустой объект если файла нет', () => {
    expect(loadEnv()).toEqual({});
  });

  it('Проверяет: loadEnv читает реальный файл и не перетирает process.env', async () => {
    const fs = await import('node:fs');
    const dir = join(tmp, 'mpu');
    fs.mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.env'),
      'WB_PLUS_WEB_APP_URL=https://x\nMPU_SS=ABC\n',
    );
    process.env['MPU_SS'] = 'FROM_PROC';
    try {
      const loaded = loadEnv();
      expect(loaded['WB_PLUS_WEB_APP_URL']).toBe('https://x');
      expect(loaded['MPU_SS']).toBe('ABC');
      expect(process.env['MPU_SS']).toBe('FROM_PROC');
    } finally {
      delete process.env['MPU_SS'];
    }
  });
});
