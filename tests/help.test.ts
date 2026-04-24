import { describe, it, expect } from '@jest/globals';
import { Command } from 'commander';
import { describe as describeHelp } from '../src/lib/help.js';
import { buildProgram } from '../src/program.js';
import { complete } from '../src/lib/completion.js';

function renderHelp(cmd: Command): string {
  const chunks: string[] = [];
  cmd.configureOutput({
    writeOut: (s) => chunks.push(s),
    writeErr: (s) => chunks.push(s),
  });
  cmd.outputHelp();
  return chunks.join('');
}

describe('describe()', () => {
  it('Проверяет: summary появляется в списке subcommand у родителя', () => {
    const parent = new Command('parent');
    const child = new Command('child');
    describeHelp(child, { summary: 'Short child summary' });
    parent.addCommand(child);
    expect(renderHelp(parent)).toContain('Short child summary');
  });

  it('Проверяет: description появляется в --help самой команды', () => {
    const cmd = new Command('foo');
    describeHelp(cmd, {
      summary: 'short',
      description: 'Long description paragraph.',
    });
    expect(renderHelp(cmd)).toContain('Long description paragraph.');
  });

  it('Проверяет: description падает обратно на summary', () => {
    const cmd = new Command('foo');
    describeHelp(cmd, { summary: 'short summary' });
    expect(renderHelp(cmd)).toContain('short summary');
  });

  it('Проверяет: examples рендерятся блоком Examples:', () => {
    const cmd = new Command('foo');
    describeHelp(cmd, {
      summary: 's',
      examples: [
        { cmd: 'foo bar', note: 'does X' },
        { cmd: 'foo baz' },
      ],
    });
    const help = renderHelp(cmd);
    expect(help).toContain('Examples:');
    expect(help).toContain('foo bar');
    expect(help).toContain('# does X');
    expect(help).toContain('foo baz');
  });

  it('Проверяет: без examples блок Examples: не появляется', () => {
    const cmd = new Command('foo');
    describeHelp(cmd, { summary: 's' });
    expect(renderHelp(cmd)).not.toContain('Examples:');
  });

  it('Проверяет: `#` у примеров выровнены в одну колонку', () => {
    const cmd = new Command('foo');
    describeHelp(cmd, {
      summary: 's',
      examples: [
        { cmd: 'short', note: 'n1' },
        { cmd: 'much-longer-cmd', note: 'n2' },
      ],
    });
    const help = renderHelp(cmd);
    const lines = help.split('\n').filter((l) => l.includes('#') && !l.startsWith('#'));
    const hashCols = lines.map((l) => l.indexOf('#'));
    expect(hashCols.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hashCols).size).toBe(1);
  });
});

describe('buildProgram() — help integration', () => {
  it('Проверяет: root --help показывает summary у config/completion/help', () => {
    const help = renderHelp(buildProgram());
    expect(help).toContain('Show or change mpu configuration');
    expect(help).toContain('Generate or install shell completion scripts');
    expect(help).toContain('Show help for a command');
  });

  it('Проверяет: config --help содержит Examples', () => {
    const program = buildProgram();
    const config = program.commands.find((c) => c.name() === 'config')!;
    const help = renderHelp(config);
    expect(help).toContain('Examples:');
    expect(help).toContain('mpu config cache.enabled off');
    expect(help).toContain('mpu config cache.ttl 300');
  });

  it('Проверяет: completion install --help содержит Examples', () => {
    const program = buildProgram();
    const completion = program.commands.find((c) => c.name() === 'completion')!;
    const installSub = completion.commands.find((c) => c.name() === 'install')!;
    const help = renderHelp(installSub);
    expect(help).toContain('Examples:');
    expect(help).toContain('mpu completion install fish');
  });

  it('Проверяет: help subcommand зарегистрирован в program.commands и не hidden', () => {
    const program = buildProgram();
    const help = program.commands.find((c) => c.name() === 'help');
    expect(help).toBeDefined();
    expect((help as unknown as { _hidden?: boolean })._hidden).not.toBe(true);

    const internal = program.commands.find((c) => c.name() === '__complete');
    expect(internal).toBeDefined();
    expect((internal as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });

  it('Проверяет: `mpu help <TAB>` дополняется всеми верхнеуровневыми командами', async () => {
    const r = await complete(buildProgram(), ['help', '']);
    expect(r).toEqual(expect.arrayContaining(['config', 'completion', 'help']));
    expect(r).not.toContain('__complete');
  });

  it('Проверяет: `mpu help completion <TAB>` дополняется sub-subcommand', async () => {
    const r = await complete(buildProgram(), ['help', 'completion', '']);
    expect(r).toEqual(expect.arrayContaining(['install', 'path']));
  });
});
