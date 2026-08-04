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
import type { SurfaceCommand } from "../registry/mod.ts";
import { renderCommandHelp, renderSurfaceHelp } from "./help.ts";

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
  /** Поверхность точки входа: справка складывается из полей реестра. */
  readonly surface?: SurfaceCommand;
}

/**
 * Всё дерево команд в порядке реестра: команды контракта, записи
 * маршрута `legacy` и поверхности точки входа (включая саму
 * `mpu help`). Список один, поэтому дрейфовать ему не от чего.
 */
export function helpEntries(
  commands: readonly Command[],
  legacyCommands: readonly LegacyCommand[],
  surfaces: readonly SurfaceCommand[],
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
      surface,
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
  if (wanted === "-h" || wanted === "--help") {
    // Своя справка: и строка использования, и однострока — из той же
    // записи реестра, что и в списке; второй копии текста не заводится.
    const self = entries.find((entry) =>
      entry.surface !== undefined &&
      entry.surface.path[0] === "help"
    );
    output.stdout(surfaceHelp(self));
    return 0;
  }
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
  if (entry.surface !== undefined) {
    // Поверхность точки входа: тот же текст, что у `<имя> --help`, —
    // именованный рендер от прямого вызова не отличается (спека).
    output.stdout(surfaceHelp(entry));
    return 0;
  }
  if (entry.command === undefined) {
    throw new TypeError(`${entry.name}: запись без способа показать справку`);
  }
  output.stdout(renderCommandHelp(entry.command));
  return 0;
}

/** Справка поверхности: строка использования и однострока из реестра. */
function surfaceHelp(entry: HelpEntry | undefined): string {
  return renderSurfaceHelp(
    entry?.surface?.usage ?? "",
    entry?.summary ?? "",
  );
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
