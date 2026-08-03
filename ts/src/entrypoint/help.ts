/**
 * Рендер справки: индекс уровня собирается из реестра автоматически (не
 * дублируется руками и потому не устаревает), листовая справка — из
 * объявления команды. Структура — по CLAUDE.md: промежуточный уровень
 * краток, листовой полон.
 */

import type { Command } from "../command/mod.ts";

/** Строка индекса: имя сегмента и его однострока. */
export interface IndexEntry {
  readonly name: string;
  readonly summary: string;
}

/** Индекс уровня: однострока и список того, что доступно ниже. */
export function renderIndex(
  usage: string,
  summary: string,
  entries: readonly IndexEntry[],
): string {
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  const lines = entries.map(
    (entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}\n`,
  );
  return `Использование: ${usage}\n\n${summary}\n\nПодкоманды:\n` +
    lines.join("") +
    "\nПодробнее: --help у каждой подкоманды.\n";
}

/** Листовая справка: usage, однострока и полное тело объявления. */
export function renderCommandHelp(command: Command): string {
  return `Использование: ${command.usage}\n\n${command.summary}\n\n` +
    `${command.help}\n`;
}
