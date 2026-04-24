import { Command } from 'commander';
import {
  SHELLS,
  assertShell,
  detectShell,
  emit,
  install,
  installPath,
  setProvider,
} from '../lib/completion.js';
import type { ProviderContext } from '../lib/completion.js';
import { describe } from '../lib/help.js';

export function completionCommand(): Command {
  const shellProvider = ({ args }: ProviderContext): string[] =>
    args.length === 0 ? [...SHELLS] : [];

  const cmd = new Command('completion')
    .argument('[shell]', `one of: ${SHELLS.join(', ')}`)
    .action((shell: string | undefined) => {
      if (!shell) {
        cmd.help();
        return;
      }
      process.stdout.write(emit(assertShell(shell)));
    });
  describe(cmd, {
    summary: 'Generate or install shell completion scripts',
    description: 'Generate or install shell completion scripts for bash, fish, or zsh.',
    examples: [
      { cmd: 'mpu completion bash', note: 'print bash script to stdout' },
      { cmd: 'mpu completion install', note: 'install for detected shell' },
      { cmd: 'mpu completion install fish', note: 'install for fish explicitly' },
      { cmd: 'mpu completion path zsh', note: 'show install path' },
    ],
  });
  setProvider(cmd, shellProvider);

  const installSub = new Command('install')
    .argument('[shell]', `one of: ${SHELLS.join(', ')}`)
    .action((shell: string | undefined) => {
      try {
        const s = shell ? assertShell(shell) : detectShell();
        if (!s) {
          throw new Error(
            `cannot detect shell from $SHELL; pass one of ${SHELLS.join(', ')} explicitly`,
          );
        }
        const path = install(s);
        console.log(`installed ${s} completion → ${path}`);
        printReloadHint(s);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  describe(installSub, {
    summary: 'Install completion script (auto-detect shell)',
    examples: [
      { cmd: 'mpu completion install', note: 'detect $SHELL and install' },
      { cmd: 'mpu completion install fish' },
    ],
  });
  setProvider(installSub, shellProvider);
  cmd.addCommand(installSub);

  const pathSub = new Command('path')
    .argument('[shell]', `one of: ${SHELLS.join(', ')}`)
    .action((shell: string | undefined) => {
      try {
        const s = shell ? assertShell(shell) : detectShell();
        if (!s) {
          throw new Error(
            `cannot detect shell from $SHELL; pass one of ${SHELLS.join(', ')} explicitly`,
          );
        }
        console.log(installPath(s));
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  describe(pathSub, {
    summary: 'Print install path for the given shell',
    examples: [
      { cmd: 'mpu completion path', note: 'detected shell' },
      { cmd: 'mpu completion path zsh' },
    ],
  });
  setProvider(pathSub, shellProvider);
  cmd.addCommand(pathSub);

  return cmd;
}

function printReloadHint(shell: 'bash' | 'fish' | 'zsh'): void {
  switch (shell) {
    case 'bash':
      console.log('reload: source the file or open a new shell');
      break;
    case 'fish':
      console.log('reload: fish autoloads completions on shell start (or run `exec fish`)');
      break;
    case 'zsh':
      console.log(
        'reload: ensure ~/.zfunc is in your fpath (add `fpath=(~/.zfunc $fpath)` and `autoload -U compinit; compinit` to .zshrc), then `exec zsh`',
      );
      break;
  }
}
