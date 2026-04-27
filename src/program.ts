import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { completionCommand } from './commands/completion.js';
import { helpCommand } from './commands/help.js';
import { internalCompleteCommand } from './commands/internal-complete.js';
import { sheetCommand } from './commands/sheet.js';
import { MAIN_BIN } from './lib/branding.js';

export function buildProgram(): Command {
  const program = new Command();
  program.name(MAIN_BIN).description('Multi-purpose CLI utility').version('0.1.0');

  program.addCommand(configCommand());
  program.addCommand(completionCommand());
  program.addCommand(sheetCommand());
  program.addCommand(helpCommand(() => program));
  program.addCommand(internalCompleteCommand(() => program), { hidden: true });

  program.showHelpAfterError(`(run \`${MAIN_BIN} help\` for a list of commands)`);

  return program;
}
