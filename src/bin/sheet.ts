#!/usr/bin/env node
import { Command } from 'commander';
import { sheetCommand } from '../commands/sheet.js';

const root = new Command();
root.name('sheet').description('Read and write Google Spreadsheets via Apps Script (alias of `new-mpu sheet`)');

const sheet = sheetCommand();
for (const sub of sheet.commands) {
  root.addCommand(sub);
}
root.showHelpAfterError('(run `sheet --help` for usage)');

root.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
