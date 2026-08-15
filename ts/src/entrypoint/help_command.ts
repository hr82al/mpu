/**
 * Подкоманда `mpu help` (`platform/registry.md`): список всех команд и
 * справка по имени. Отдельная поверхность точки входа, а не команда
 * контракта: она печатает справочные тексты чужих команд, результата у
 * неё нет, и тулом она не публикуется — как и `mpu mcp`.
 *
 * Источник состава — единый реестр, поэтому список не дрейфует от
 * `--help`, как было в оригинале (отклонение-fix спеки).
 */

import type { Command } from "../command/mod.ts";
import {
  type LegacyCommand,
  type LegacyIo,
  runLegacyCommand,
} from "../legacy/mod.ts";
import type { SurfaceCommand } from "../registry/mod.ts";
import { renderCommandHelp, renderSurfaceHelp } from "./help.ts";

/** Приёмник вывода: столько от потоков процесса нужно этой поверхности. */
export interface HelpSink {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Что показывает `mpu help`: полное имя, однострока и то, откуда взять
 * подробную справку. Вид записи — размеченное объединение: у каждой
 * ровно один источник справки, и «четвёртого вида» не бывает по типам,
 * а не по проверке в рантайме.
 */
export type HelpEntry =
  & {
    /** Полное имя команды: `mpu <путь>` — в той же форме её спрашивают. */
    readonly name: string;
    readonly summary: string;
  }
  & (
    /** Команда контракта: справка рендерится из объявления. */
    | { readonly kind: "command"; readonly command: Command }
    /**
     * Запись маршрута `legacy`: подробную справку печатает сама
     * Python-реализация, реестр хранит только однострокў (спека).
     */
    | { readonly kind: "legacy"; readonly legacy: LegacyCommand }
    /** Поверхность точки входа: справка складывается из полей реестра. */
    | { readonly kind: "surface"; readonly surface: SurfaceCommand }
  );

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
    ...commands.map((command): HelpEntry => ({
      kind: "command",
      name: `mpu ${command.path.join(" ")}`,
      summary: command.summary,
      command,
    })),
    ...legacyCommands.map((command): HelpEntry => ({
      kind: "legacy",
      name: `mpu ${command.path.join(" ")}`,
      summary: command.summary,
      legacy: command,
    })),
    ...surfaces.map((surface): HelpEntry => ({
      kind: "surface",
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
  io: LegacyIo,
  output: HelpSink,
): Promise<number> {
  const wanted = args[0];
  if (wanted === "-h" || wanted === "--help") {
    // Своя справка: и строка использования, и однострока — из той же
    // записи реестра, что и в списке; второй копии текста не заводится.
    const self = entries.find(isOwnSurface);
    output.stdout(self === undefined ? "" : surfaceHelp(self));
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
  switch (entry.kind) {
    case "legacy":
      // Тот же текст, что у `mpu <cmd> --help`: у маршрута `legacy` его
      // печатает сама реализация, а не реестр (спека).
      return await runLegacyCommand(entry.legacy, ["--help"], io, output);
    case "surface":
      // Поверхность точки входа: тот же текст, что у `<имя> --help`, —
      // именованный рендер от прямого вызова не отличается (спека).
      output.stdout(surfaceHelp(entry));
      return 0;
    case "command":
      output.stdout(renderCommandHelp(entry.command));
      return 0;
    default: {
      // Исчерпывающая проверка: новый вид записи не соберётся, пока его
      // не обработают здесь (правило модуля про `never` в `default`).
      const impossible: never = entry;
      throw new TypeError(
        `неизвестный вид записи справки: ${JSON.stringify(impossible)}`,
      );
    }
  }
}

/** Запись самой справочной поверхности среди прочих. */
type SurfaceEntry = Extract<HelpEntry, { readonly kind: "surface" }>;

/** Она же — по имени: `mpu help` описывает сама себя из реестра. */
function isOwnSurface(entry: HelpEntry): entry is SurfaceEntry {
  return entry.kind === "surface" && entry.surface.path[0] === "help";
}

/** Справка поверхности: строка использования и однострока из реестра. */
function surfaceHelp(entry: SurfaceEntry): string {
  return renderSurfaceHelp(entry.surface.usage, entry.summary);
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
