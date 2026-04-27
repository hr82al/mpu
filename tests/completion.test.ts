import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/program.js';
import {
  assertShell,
  complete,
  detectShell,
  emit,
  install,
  installPath,
  SHELLS,
} from '../src/lib/completion.js';
import { MAIN_BIN, SHEET_BIN } from '../src/lib/branding.js';

describe('complete()', () => {
  let program = buildProgram();

  beforeEach(() => {
    program = buildProgram();
  });

  it('Проверяет: пустой ввод → все верхнеуровневые subcommand', async () => {
    const r = await complete(program, ['']);
    expect(r).toEqual(expect.arrayContaining(['config', 'completion']));
    expect(r).not.toContain('__complete');
  });

  it('Проверяет: префиксная фильтрация subcommand', async () => {
    const r = await complete(program, ['co']);
    expect(r).toEqual(['completion', 'config']);
  });

  it('Проверяет: provider отдаёт ключи конфига на первом positional', async () => {
    const r = await complete(program, ['config', '']);
    expect(r).toEqual(expect.arrayContaining(['cache.ttl']));
  });

  it('Проверяет: префикс фильтрует ключи конфига', async () => {
    const r = await complete(program, ['config', 'cache.']);
    expect(r).toEqual(['cache.ttl']);
  });

  it('Проверяет: курсор с `-` → опции команды + --help', async () => {
    const r = await complete(program, ['config', '-']);
    expect(r).toEqual(expect.arrayContaining(['--help', '--unset', '-h']));
  });

  it('Проверяет: курсор с `--un` фильтрует до --unset', async () => {
    const r = await complete(program, ['config', '--un']);
    expect(r).toEqual(['--unset']);
  });

  it('Проверяет: `completion <TAB>` → имена shell', async () => {
    const r = await complete(program, ['completion', '']);
    expect(r).toEqual(expect.arrayContaining(['bash', 'fish', 'zsh']));
    expect(r).toEqual(expect.arrayContaining(['install', 'path']));
  });

  it('Проверяет: `completion install <TAB>` → только shell (первый positional)', async () => {
    const r = await complete(program, ['completion', 'install', '']);
    expect(r).toEqual(expect.arrayContaining(['bash', 'fish', 'zsh']));
  });

  it('Проверяет: hidden `__complete` не попадает в кандидатов', async () => {
    const r = await complete(program, ['__']);
    expect(r).not.toContain('__complete');
  });
});

describe('emit()', () => {
  const mainFn = `_${MAIN_BIN.replaceAll('-', '_')}`;
  const sheetFn = `_${SHEET_BIN.replaceAll('-', '_')}`;

  it(`Проверяет: bash для ${MAIN_BIN} — complete -F и вызов __complete`, () => {
    const s = emit('bash', MAIN_BIN);
    expect(s).toContain(`complete -F ${mainFn} ${MAIN_BIN}`);
    expect(s).toContain(`${MAIN_BIN} __complete bash`);
  });

  it(`Проверяет: bash для ${SHEET_BIN} — complete -F и вызов __complete`, () => {
    const s = emit('bash', SHEET_BIN);
    expect(s).toContain(`complete -F ${sheetFn} ${SHEET_BIN}`);
    expect(s).toContain(`${SHEET_BIN} __complete bash`);
  });

  it(`Проверяет: fish для ${SHEET_BIN} — completions для bin`, () => {
    const s = emit('fish', SHEET_BIN);
    expect(s).toContain(`${SHEET_BIN} __complete fish`);
    expect(s).toContain(`complete -c ${SHEET_BIN} -f -a '(__${SHEET_BIN.replaceAll('-', '_')}_complete)'`);
  });

  it(`Проверяет: zsh для ${SHEET_BIN} — compdef`, () => {
    const s = emit('zsh', SHEET_BIN);
    expect(s).toContain(`#compdef ${SHEET_BIN}`);
    expect(s).toContain(`${SHEET_BIN} __complete zsh`);
  });
});

describe('installPath()', () => {
  it(`bash + ${MAIN_BIN}`, () => {
    expect(installPath('bash', MAIN_BIN)).toMatch(
      new RegExp(`bash-completion/completions/${MAIN_BIN}$`),
    );
  });
  it(`bash + ${SHEET_BIN}`, () => {
    expect(installPath('bash', SHEET_BIN)).toMatch(
      new RegExp(`bash-completion/completions/${SHEET_BIN}$`),
    );
  });
  it(`fish + ${SHEET_BIN}`, () => {
    expect(installPath('fish', SHEET_BIN)).toMatch(
      new RegExp(`fish/completions/${SHEET_BIN}\\.fish$`),
    );
  });
  it(`zsh + ${SHEET_BIN}`, () => {
    expect(installPath('zsh', SHEET_BIN)).toMatch(new RegExp(`\\.zfunc/_${SHEET_BIN}$`));
  });
});

describe('install()', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mpu-compl-'));
  const dataHome = join(tmp, 'data');
  const configHome = join(tmp, 'config');
  const prevData = process.env['XDG_DATA_HOME'];
  const prevConf = process.env['XDG_CONFIG_HOME'];

  beforeEach(() => {
    process.env['XDG_DATA_HOME'] = dataHome;
    process.env['XDG_CONFIG_HOME'] = configHome;
  });

  afterAll(() => {
    if (prevData !== undefined) process.env['XDG_DATA_HOME'] = prevData;
    else delete process.env['XDG_DATA_HOME'];
    if (prevConf !== undefined) process.env['XDG_CONFIG_HOME'] = prevConf;
    else delete process.env['XDG_CONFIG_HOME'];
    rmSync(tmp, { recursive: true, force: true });
  });

  it(`Проверяет: install(bash) создаёт файлы для ${MAIN_BIN} и ${SHEET_BIN}`, () => {
    const paths = install('bash');
    expect(paths).toEqual([
      join(dataHome, `bash-completion/completions/${MAIN_BIN}`),
      join(dataHome, `bash-completion/completions/${SHEET_BIN}`),
    ]);
    expect(existsSync(paths[0]!)).toBe(true);
    expect(existsSync(paths[1]!)).toBe(true);
    expect(readFileSync(paths[0]!, 'utf8')).toBe(emit('bash', MAIN_BIN));
    expect(readFileSync(paths[1]!, 'utf8')).toBe(emit('bash', SHEET_BIN));
  });

  it('Проверяет: install(fish) — оба файла в $XDG_CONFIG_HOME/fish/completions', () => {
    const paths = install('fish');
    expect(paths).toEqual([
      join(configHome, `fish/completions/${MAIN_BIN}.fish`),
      join(configHome, `fish/completions/${SHEET_BIN}.fish`),
    ]);
    for (const p of paths) expect(existsSync(p)).toBe(true);
  });
});

describe('detectShell()', () => {
  const prev = process.env['SHELL'];
  afterAll(() => {
    if (prev !== undefined) process.env['SHELL'] = prev;
    else delete process.env['SHELL'];
  });

  const cases: Array<[string, string]> = [
    ['/usr/bin/fish', 'fish'],
    ['/bin/bash', 'bash'],
    ['/usr/bin/zsh', 'zsh'],
  ];
  it.each(cases)('Проверяет: $SHELL=%s → %s', (shellPath, expected) => {
    process.env['SHELL'] = shellPath;
    expect(detectShell()).toBe(expected);
  });

  it('Проверяет: неизвестный shell → null', () => {
    process.env['SHELL'] = '/bin/dash';
    expect(detectShell()).toBeNull();
  });
});

describe('assertShell()', () => {
  it('Проверяет: принимает bash/fish/zsh', () => {
    for (const s of SHELLS) expect(assertShell(s)).toBe(s);
  });
  it('Проверяет: отвергает unknown', () => {
    expect(() => assertShell('dash')).toThrow(/unsupported shell/);
  });
});
