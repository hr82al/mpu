import { Command } from 'commander';
import { CONFIG_REGISTRY, Config, getDefaultConfig } from '../lib/config.js';
import type { ConfigListEntry } from '../lib/config.js';
import { setProvider } from '../lib/completion.js';
import type { ProviderContext } from '../lib/completion.js';
import { describe } from '../lib/help.js';

export function configCommand(configFactory: () => Config = getDefaultConfig): Command {
  const cmd = new Command('config');
  setProvider(cmd, ({ args }: ProviderContext) => {
    // [key] [value]
    if (args.length === 0) return Object.keys(CONFIG_REGISTRY);
    if (args.length === 1) {
      const key = args[0]!;
      const entry = CONFIG_REGISTRY[key];
      if (!entry) return [];
      if (entry.type === 'bool') return ['on', 'off'];
      return [];
    }
    return [];
  });
  describe(cmd, {
    summary: 'Show or change mpu configuration',
    description: 'Show or change mpu configuration. Values are stored in SQLite.',
    examples: [
      { cmd: 'new-mpu config', note: 'list all settings' },
      { cmd: 'new-mpu config cache.enabled', note: 'show one value' },
      { cmd: 'new-mpu config cache.enabled off', note: 'disable caching' },
      { cmd: 'new-mpu config cache.ttl 300', note: 'set default TTL to 300 seconds' },
      { cmd: 'new-mpu config --unset cache.ttl', note: 'reset key to default' },
    ],
  });
  cmd
    .argument('[key]', 'config key (dotted, e.g. cache.enabled)')
    .argument('[value]', 'new value to set')
    .option('--unset', 'reset key to default')
    .action((key: string | undefined, value: string | undefined, opts: { unset?: boolean }) => {
      const config = configFactory();
      try {
        if (!key) {
          printList(config.list());
          return;
        }
        if (opts.unset) {
          config.unset(key);
          console.log(`${key} → default (${formatValue(CONFIG_REGISTRY[key]?.default)})`);
          return;
        }
        if (value === undefined) {
          console.log(formatValue(config.get(key)));
          return;
        }
        config.set(key, value);
        console.log(`${key} = ${formatValue(config.get(key))}`);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
  return cmd;
}

function printList(entries: ConfigListEntry[]): void {
  const keyWidth = Math.max(...entries.map((e) => e.key.length));
  const valWidth = Math.max(...entries.map((e) => formatValue(e.value).length));
  for (const e of entries) {
    const marker = e.overridden ? '*' : ' ';
    const k = e.key.padEnd(keyWidth);
    const v = formatValue(e.value).padEnd(valWidth);
    console.log(`${marker} ${k}  ${v}  # ${e.description}`);
  }
}

function formatValue(v: unknown): string {
  if (v === undefined) return '';
  return String(v);
}
