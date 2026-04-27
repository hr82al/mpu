#!/usr/bin/env node
import { Command } from 'commander';
import { sheetCommand } from '../commands/sheet.js';
import { internalCompleteCommand } from '../commands/internal-complete.js';
import { MAIN_BIN, SHEET_BIN } from '../lib/branding.js';

const root = new Command();
root.name(SHEET_BIN).description(`Read and write Google Spreadsheets via Apps Script (alias of \`${MAIN_BIN} sheet\`)`);

const sheet = sheetCommand();
for (const sub of sheet.commands) {
  root.addCommand(sub);
}
root.addCommand(internalCompleteCommand(() => root), { hidden: true });
root.showHelpAfterError('(run `sheet --help` for usage)');

root.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
