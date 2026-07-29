/**
 * Рендер справки команды xlsx: групповой индекс собирается из
 * зарегистрированных подкоманд автоматически (не дублируется руками),
 * листовая справка — из данных подкоманды. Структура — по CLAUDE.md:
 * промежуточный уровень краток, листовой — полон.
 */

/** Обязательные тексты подкоманды; без них подкоманда не типизируется. */
export interface SubcommandHelp {
  /** Строка Usage без слова «Использование». */
  readonly usage: string;
  /** Однострока для группового индекса. */
  readonly summary: string;
  /** Листовая справка: флаги, форматы, exit-коды, примеры. */
  readonly body: string;
}

/** Строка группового индекса: имя подкоманды и её однострока. */
export interface GroupIndexEntry {
  readonly name: string;
  readonly summary: string;
}

/** Групповой индекс: однострока и список подкоманд, ничего больше. */
export function renderGroupHelp(
  usage: string,
  summary: string,
  entries: readonly GroupIndexEntry[],
): string {
  const width = Math.max(...entries.map((e) => e.name.length));
  const lines = entries.map((e) =>
    `  ${e.name.padEnd(width)}  ${e.summary}\n`
  );
  return `Использование: ${usage}\n\n${summary}\n\nПодкоманды:\n` +
    lines.join("") +
    "\nПодробнее: --help у каждой подкоманды.\n";
}

/** Листовая справка: usage, однострока и полное тело. */
export function renderLeafHelp(help: SubcommandHelp): string {
  return `Использование: ${help.usage}\n\n${help.summary}\n\n${help.body}\n`;
}
