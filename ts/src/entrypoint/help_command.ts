/**
 * Подкоманда `mpu help` (`platform/registry.md`): список всех команд и
 * справка по имени. Отдельная поверхность точки входа, а не команда
 * контракта: она печатает справочные тексты чужих команд, результата у
 * неё нет, и тулом она не публикуется — как и `mpu mcp`.
 *
 * Источник состава — единый реестр, поэтому список не дрейфует от
 * `--help`, как было в оригинале (отклонение-fix спеки).
 */

import type { Command, CommandIo } from "../command/mod.ts";
import { type LegacyCommand, runLegacyCommand } from "../legacy/mod.ts";
import { renderCommandHelp } from "./help.ts";

/** Приёмник вывода: столько от потоков процесса нужно этой поверхности. */
export interface HelpSink {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Что показывает `mpu help`: полное имя и однострока каждой записи. */
export interface HelpEntry {
  /** Полное имя команды: `mpu <путь>` — в этой же форме её и спрашивают. */
  readonly name: string;
  readonly summary: string;
  /** Команда контракта: её справка рендерится из объявления. */
  readonly command?: Command;
  /**
   * Запись маршрута `legacy`: подробную справку печатает сама
   * Python-реализация, реестр хранит только однострокў (спека).
   */
  readonly legacy?: LegacyCommand;
}

/**
 * Всё дерево команд в порядке реестра: команды контракта, записи
 * маршрута `legacy` и поверхности точки входа (включая саму
 * `mpu help`). Список один, поэтому дрейфовать ему не от чего.
 */
export function helpEntries(
  commands: readonly Command[],
  legacyCommands: readonly LegacyCommand[],
  surfaces: readonly LegacyCommand[],
): readonly HelpEntry[] {
  return [
    ...commands.map((command) => ({
      name: `mpu ${command.path.join(" ")}`,
      summary: command.summary,
      command,
    })),
    ...legacyCommands.map((command) => ({
      name: `mpu ${command.path.join(" ")}`,
      summary: command.summary,
      legacy: command,
    })),
    ...surfaces.map((surface) => ({
      name: `mpu ${surface.path.join(" ")}`,
      summary: surface.summary,
    })),
  ];
}

/**
 * Исполняет `mpu help [<полное имя>]` и возвращает код завершения:
 * 0 — список или справка напечатаны, 2 — имя неизвестно.
 */
export async function runHelpCommand(
  args: readonly string[],
  entries: readonly HelpEntry[],
  io: CommandIo,
  output: HelpSink,
): Promise<number> {
  const wanted = args[0];
  if (wanted === undefined) {
    output.stdout(renderList(entries));
    return 0;
  }
  const entry = entries.find((item) => item.name === wanted);
  if (entry === undefined) {
    // Пустая строка и голый kebab сюда же: обе — «нет такого имени», а
    // подсказка со списком показывает полную форму (спека).
    output.stderr(
      `mpu help: unknown command '${wanted}'\n` +
        `Known commands: ${entries.map((item) => item.name).join(", ")}\n`,
    );
    return 2;
  }
  if (entry.legacy !== undefined) {
    // Тот же текст, что у `mpu <cmd> --help`: у маршрута `legacy` его
    // печатает сама реализация, а не реестр (спека).
    return await runLegacyCommand(entry.legacy, ["--help"], io, output);
  }
  if (entry.command === undefined) {
    // Поверхность точки входа: подробной справки у неё нет — её
    // назначение исчерпывается однострокой.
    output.stdout(`${entry.name}\t${entry.summary}\n`);
    return 0;
  }
  output.stdout(renderCommandHelp(entry.command));
  return 0;
}

/** Список: заголовок, колонка имён с описаниями, футер (спека). */
function renderList(entries: readonly HelpEntry[]): string {
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  const lines = entries.map(
    (entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}\n`,
  );
  return `Available commands:\n\n${lines.join("")}\n` +
    "Run `<command> --help` for detailed usage.\n";
}
