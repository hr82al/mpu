import { Command } from 'commander';
import { describe } from '../lib/help.js';
import { setProvider } from '../lib/completion.js';

export function helpCommand(getRoot: () => Command): Command {
  const cmd = new Command('help')
    .argument('[command...]', 'path to command, e.g. `config` or `completion install`')
    .action((args: string[] = []) => {
      const target = navigate(getRoot(), args);
      if (!target) {
        console.error(`unknown command: ${args.join(' ')}`);
        process.exitCode = 1;
        return;
      }
      target.outputHelp();
    });

  describe(cmd, {
    summary: 'Show help for a command',
    examples: [
      { cmd: 'new-mpu help', note: 'list all commands' },
      { cmd: 'new-mpu help config' },
      { cmd: 'new-mpu help completion install' },
    ],
  });

  setProvider(cmd, ({ args }) => {
    const target = navigate(getRoot(), args);
    if (!target) return [];
    return target.commands
      .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
      .map((c) => c.name());
  });

  return cmd;
}

function navigate(root: Command, args: string[]): Command | null {
  let current = root;
  for (const name of args) {
    const sub = current.commands.find(
      (c) => c.name() === name || c.aliases().includes(name),
    );
    if (!sub) return null;
    current = sub;
  }
  return current;
}
