import { Command } from 'commander';
import { complete } from '../lib/completion.js';

export function internalCompleteCommand(getRoot: () => Command): Command {
  return new Command('__complete')
    .description('(internal) runtime completion handler')
    .argument('<shell>', 'shell name')
    .argument('[words...]', 'typed command line after `mpu`')
    .allowUnknownOption()
    .action(async (_shell: string, words: string[] = []) => {
      const candidates = await complete(getRoot(), words);
      for (const c of candidates) process.stdout.write(c + '\n');
    });
}
