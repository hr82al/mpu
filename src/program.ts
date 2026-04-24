import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { completionCommand } from './commands/completion.js';
import { helpCommand } from './commands/help.js';
import { internalCompleteCommand } from './commands/internal-complete.js';

export function buildProgram(): Command {
  const program = new Command();
  program.name('mpu').description('Multi-purpose CLI utility').version('0.1.0');

  program.addCommand(configCommand());
  program.addCommand(completionCommand());
  program.addCommand(helpCommand(() => program));
  program.addCommand(internalCompleteCommand(() => program), { hidden: true });

  program.showHelpAfterError('(run `mpu help` for a list of commands)');

  return program;
}
