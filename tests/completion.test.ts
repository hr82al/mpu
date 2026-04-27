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
  it('Проверяет: bash-скрипт регистрирует complete -F', () => {
    const s = emit('bash');
    expect(s).toContain('complete -F _new_mpu new-mpu');
    expect(s).toContain('new-mpu __complete bash');
  });

  it('Проверяет: fish-скрипт использует commandline и __complete', () => {
    const s = emit('fish');
    expect(s).toContain('new-mpu __complete fish');
    expect(s).toContain("complete -c new-mpu -f -a '(__new_mpu_complete)'");
  });

  it('Проверяет: zsh-скрипт компдеф', () => {
    const s = emit('zsh');
    expect(s).toContain('#compdef new-mpu');
    expect(s).toContain('new-mpu __complete zsh');
  });
});

describe('installPath()', () => {
  it('Проверяет: bash → ~/.local/share/bash-completion/...', () => {
    expect(installPath('bash')).toMatch(/bash-completion\/completions\/new-mpu$/);
  });
  it('Проверяет: fish → ~/.config/fish/completions/new-mpu.fish', () => {
    expect(installPath('fish')).toMatch(/fish\/completions\/new-mpu\.fish$/);
  });
  it('Проверяет: zsh → ~/.zfunc/_new-mpu', () => {
    expect(installPath('zsh')).toMatch(/\.zfunc\/_new-mpu$/);
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

  it('Проверяет: install(bash) создаёт файл с корректным содержимым', () => {
    const path = install('bash');
    expect(path).toBe(join(dataHome, 'bash-completion/completions/new-mpu'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(emit('bash'));
  });

  it('Проверяет: install(fish) в $XDG_CONFIG_HOME/fish/completions/new-mpu.fish', () => {
    const path = install('fish');
    expect(path).toBe(join(configHome, 'fish/completions/new-mpu.fish'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(emit('fish'));
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
