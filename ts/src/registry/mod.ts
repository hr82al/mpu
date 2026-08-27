/**
 * Реестр команд: единственный список, который читают маршрутизация и
 * все справочные поверхности, — рассинхрон списков невозможен по
 * построению (`platform/registry.md`).
 *
 * Группа — промежуточный уровень дерева (`mpu xlsx`, `mpu xlsx alias`);
 * своей реализации у неё нет, но однострока обязательна: без неё
 * индекс родителя нечем собрать.
 *
 * Маршрут выражен не признаком записи, а тем, в каком списке она
 * лежит: `commands` исполняются кодом CLI и подчиняются контракту
 * команды, `legacyCommands` — подпроцессом Python-реализации, и ни
 * схем, ни рендера у них нет. Обход инвариантов контракта идёт по
 * `commands` и потому фильтрует записи по маршруту по построению
 * (`platform/command-contract.md`).
 */

import type { Command, CommandIo } from "../command/mod.ts";
import type { LegacyCommand } from "../legacy/mod.ts";
import { LEGACY_TREE } from "./legacy_tree.ts";
import { xlsxCommands } from "../xlsx/mod.ts";
import { initCommand } from "../init/mod.ts";
import { updateCommand } from "../update/mod.ts";
import { mcpTokenCommand } from "../mcp/cmd_token.ts";
import { sqlCommand, sqlRoCommand } from "../sql/mod.ts";
import { healthCommand } from "../health/mod.ts";
import {
  dataLoaderCommand,
  jobsCommands,
  migrationsCommands,
  ozonLoaderCommands,
  ozonRecalculateExpensesCommand,
  ozonSaveExpensesCommand,
  ssDatasetsCommand,
  ssLoadCommand,
  ssUpdateCommand,
  usersCommands,
  wbLoaderCommands,
  wbRecalculateExpensesCommand,
  wbSaveExpensesCommand,
  wbUnitCalcCommand,
  wbUnitProtoNewCommand,
} from "../nodecli/mod.ts";
import { logCommand } from "../log/mod.ts";
import { psCommand } from "../ps/mod.ts";
import { searchCommand } from "../search/mod.ts";
import { runJsCommand } from "../runjs/mod.ts";
import { jsdateCommand } from "../jsdate/mod.ts";
import { sshCommand } from "../ssh/mod.ts";
import { logsCommand } from "../logs/mod.ts";
import {
  kitenArtefactRmCommand,
  kitenArtefactSetCommand,
  kitenBoardsCommand,
  kitenCardCommand,
  kitenChecklistAddCommand,
  kitenChecklistCheckCommand,
  kitenChecklistLsCommand,
  kitenChecklistUncheckCommand,
  kitenCloseCommand,
  kitenColumnsCommand,
  kitenCommentCommand,
  kitenFieldSetCommand,
  kitenLanesCommand,
  kitenLsCommand,
  kitenMoveCommand,
  kitenReadyCommand,
  kitenReviewCommand,
  kitenRolesCommand,
  kitenSpacesCommand,
  kitenStatusCommand,
  kitenTimeAddCommand,
  kitenTimeDiscardCommand,
  kitenTimeEditCommand,
  kitenTimeLsCommand,
  kitenTimeRmCommand,
  kitenTimeStartCommand,
  kitenTimeStatusCommand,
  kitenTimeStopCommand,
  kitenWhoamiCommand,
} from "../kiten/mod.ts";
import {
  telegramLogCommand,
  telegramLsCommand,
  telegramSearchCommand,
  telegramSendCommand,
  telegramStatusCommand,
} from "../telegram/mod.ts";
import { claudeHookNotificationCommand } from "../claudehook/mod.ts";
import { confirmCommand } from "../confirm/mod.ts";
import { type ErrorSink, runMcpServer } from "../mcp/cli.ts";
import type { InvokeLog } from "../invokelog/mod.ts";

/**
 * Что делает голый вызов уровня (`mpu mcp`), если он делает не индекс.
 * Возвращает код завершения процесса.
 */
type BareHandler = (
  argv: readonly string[],
  io: CommandIo,
  output: ErrorSink,
  /** Журнал вызовов: сервер пишет запись на каждый вызов тула. */
  log: InvokeLog,
) => Promise<number>;

/**
 * Поверхность точки входа: запись реестра со строкой использования.
 * Подробной справки у неё нет — назначение исчерпывается однострокой,
 * поэтому `mpu help <имя>` и `<имя> --help` печатают одно и то же
 * (`platform/registry.md`, отклонение про именованный рендер).
 */
export interface SurfaceCommand {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
}

/** Промежуточный уровень дерева команд. */
export interface CommandGroup {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
  /**
   * Поверхность голого вызова уровня. Есть только у `mpu mcp`: сервер
   * не команда контракта — у него нет результата, который рендерится
   * (см. `mcp/cli.ts`).
   */
  readonly bare?: BareHandler;
  /**
   * Раскладка argv уровня. Умолчание — имя подкоманды идёт сразу за
   * именем группы. `selector-first` означает форму
   * `<группа> [флаги] <селектор> <подкоманда> [флаги]`: селектор и
   * режимы печати набираются до имени подкоманды
   * (`specs/portainer-wrappers.md`, семейство обёрток).
   *
   * Признак объявляется здесь, а не у команды: он про чтение argv
   * уровня, и второго места для него быть не должно. Схемы аргументов
   * у группы при этом не заводится — точка входа лишь опознаёт имя
   * подкоманды с пропуском, а разбирает всё та же схема листа.
   */
  readonly layout?: "selector-first";
}

/** Все команды CLI в порядке показа в справке. */
export const commands: readonly Command[] = [
  ...xlsxCommands,
  initCommand,
  updateCommand,
  sqlCommand,
  sqlRoCommand,
  healthCommand,
  ssUpdateCommand,
  ...wbLoaderCommands,
  dataLoaderCommand,
  wbRecalculateExpensesCommand,
  wbSaveExpensesCommand,
  ozonRecalculateExpensesCommand,
  ozonSaveExpensesCommand,
  searchCommand,
  psCommand,
  runJsCommand,
  jsdateCommand,
  sshCommand,
  logsCommand,
  logCommand,
  mcpTokenCommand,
  // Первый нативный лист внутри группы, оставшейся `legacy`: соседи
  // `kiten` уходят подпроцессом одной записью слепка, а этот путь
  // распознаётся реестром целиком и потому побеждает её длиной.
  kitenCardCommand,
  // Справочники и обзорные подкоманды: с ними на маршруте `legacy` не
  // остаётся ни одной подкоманды группы (`specs/kiten-refs.md`,
  // `kiten-ls.md`, `kiten-status.md`).
  kitenWhoamiCommand,
  kitenSpacesCommand,
  kitenBoardsCommand,
  kitenLanesCommand,
  kitenColumnsCommand,
  kitenRolesCommand,
  kitenLsCommand,
  kitenStatusCommand,
  kitenCommentCommand,
  kitenFieldSetCommand,
  kitenArtefactSetCommand,
  kitenArtefactRmCommand,
  kitenTimeLsCommand,
  kitenTimeAddCommand,
  kitenTimeEditCommand,
  kitenTimeRmCommand,
  kitenTimeStartCommand,
  kitenTimeStatusCommand,
  kitenTimeStopCommand,
  kitenTimeDiscardCommand,
  kitenChecklistLsCommand,
  kitenChecklistAddCommand,
  kitenChecklistCheckCommand,
  kitenChecklistUncheckCommand,
  kitenCloseCommand,
  kitenMoveCommand,
  kitenReadyCommand,
  kitenReviewCommand,
  // Семейство `telegram` переехало целиком; подпроцессом прежней
  // реализации остаётся только вход (`mpu init`).
  telegramSendCommand,
  telegramLogCommand,
  telegramLsCommand,
  telegramSearchCommand,
  telegramStatusCommand,
  claudeHookNotificationCommand,
  // Семейство обёрток доезжает: очереди задач, миграции и загрузчик
  // Ozon (`specs/portainer-wrappers.md`).
  ...jobsCommands,
  ...migrationsCommands,
  ...ozonLoaderCommands,
  // Штучные обёртки: три из них листовые — в рабочей версии это группы
  // с единственной подкомандой, схлопнутые typer'ом.
  ssLoadCommand,
  ssDatasetsCommand,
  wbUnitCalcCommand,
  wbUnitProtoNewCommand,
  ...usersCommands,
  confirmCommand,
];

/**
 * Команды, ещё не переехавшие: исполняются подпроцессом Python-версии.
 * Состав и однострокѝ порождены из машинного слепка дерева
 * (`legacy_tree.ts`); перевод команды на маршрут `native` — перенос
 * записи отсюда в `commands` (`platform/registry.md`).
 */
export const legacyCommands: readonly LegacyCommand[] = LEGACY_TREE;

/**
 * Поверхности точки входа: исполняются кодом CLI, но командами
 * контракта не являются — ни схем, ни результата у них нет. `mpu help`
 * печатает список из единого реестра (`platform/registry.md`), `mpu mcp`
 * поднимает долгоживущий процесс (`platform/command-contract.md`).
 *
 * Однострока `help` — из слепка дерева: поверхность своя, но имя и
 * описание унаследованы, и расхождение с оригиналом здесь ни к чему.
 */
export const surfaces: readonly SurfaceCommand[] = [
  {
    path: ["help"],
    summary: "Список всех mpu команд с опциональной справкой.",
    usage: "mpu help [<полное имя команды>]",
  },
  {
    path: ["version"],
    summary: "Show mpu version.",
    usage: "mpu version",
  },
];

/** Поверхность точки входа с ровно таким путём. */
export function findSurface(
  path: readonly string[],
): SurfaceCommand | undefined {
  return surfaces.find((surface) => samePath(surface.path, path));
}

/** Все промежуточные уровни; каждый префикс пути команды описан здесь. */
export const groups: readonly CommandGroup[] = [
  {
    path: ["xlsx"],
    summary: "чтение локальных .xlsx: листы, значения, алиасы",
    usage: "mpu xlsx <подкоманда> [аргументы]",
  },
  {
    path: ["xlsx", "alias"],
    summary: "алиасы путей: add | ls | rm",
    usage: "mpu xlsx alias <подкоманда> [аргументы]",
  },
  {
    // Группа переехала целиком, и её промежуточный уровень больше не
    // приходит из слепка: без этой записи `mpu kiten --help` собирал бы
    // пустой индекс (`platform/registry.md`).
    path: ["kiten"],
    summary: "карточки Kaiten: чтение, комментарии, время, справочники",
    usage: "mpu kiten <подкоманда> [аргументы]",
  },
  {
    path: ["wb-loader"],
    summary: "загрузка данных WB-кабинета в БД клиента: reports | cards | …",
    usage: "mpu wb-loader <подкоманда> [аргументы]",
  },
  {
    path: ["kiten", "field"],
    summary: "кастомные поля карточки: set | artefact",
    usage: "mpu kiten field <подкоманда> [аргументы]",
  },
  {
    path: ["kiten", "field", "artefact"],
    summary: "файловое поле «9. AI-артефакт»: set | rm",
    usage: "mpu kiten field artefact <подкоманда> [аргументы]",
  },
  {
    path: ["kiten", "time"],
    summary: "записи учёта времени карточки: ls | add | edit | rm",
    usage: "mpu kiten time <подкоманда> [аргументы]",
  },
  {
    path: ["kiten", "checklist"],
    summary: "чек-листы карточки: ls | add | check | uncheck",
    usage: "mpu kiten checklist <подкоманда> [аргументы]",
  },
  {
    // Раскладка `selector-first` у трёх групп очередей и у миграций
    // приложения: селектор и режимы печати набираются до имени
    // подкоманды (`specs/portainer-wrappers.md`).
    path: ["wb-jobs"],
    summary: "очередь задач WB-загрузчика на сервере: show",
    usage: "mpu wb-jobs [-p [--local]] SELECTOR <подкоманда>",
    layout: "selector-first",
  },
  {
    path: ["data-loader-jobs"],
    summary: "очередь задач загрузчика данных на сервере: show",
    usage: "mpu data-loader-jobs [-p [--local]] SELECTOR <подкоманда>",
    layout: "selector-first",
  },
  {
    path: ["ozon-jobs"],
    summary: "очередь задач Ozon-загрузчика на сервере: show | prune",
    usage: "mpu ozon-jobs [-p [--local]] SELECTOR <подкоманда>",
    layout: "selector-first",
  },
  {
    path: ["app-migrations"],
    summary: "миграции схемы приложения: latest | up",
    usage: "mpu app-migrations [-p [--local]] SELECTOR <подкоманда>",
    layout: "selector-first",
  },
  {
    path: ["users"],
    summary: "пользователи sl-back на сервере: add | add-role",
    usage: "mpu users [-p [--local]] SELECTOR <подкоманда>",
    layout: "selector-first",
  },
  {
    path: ["clients-migrations"],
    summary:
      "миграции клиентских схем: latest | up | rollback | latest-all | …",
    usage: "mpu clients-migrations <подкоманда> SELECTOR --type T",
  },
  {
    path: ["datasets-migrations"],
    summary: "миграции датасетов клиента: latest | up | rollback | down | list",
    usage: "mpu datasets-migrations <подкоманда> SELECTOR --dataset D",
  },
  {
    path: ["ozon-loader"],
    summary: "загрузка данных Ozon-кабинета в БД клиента: campaigns | …",
    usage: "mpu ozon-loader <подкоманда> SELECTOR --seller-client-id S",
  },
  {
    // Группа с единственным листом: следующий хук Claude Code
    // (`Stop`, `SessionEnd`) станет её соседом, а без записи здесь
    // `mpu claude-hook` не опознавался бы вовсе.
    path: ["claude-hook"],
    summary: "адаптеры хуков Claude Code: уведомление себе в бота",
    usage: "mpu claude-hook <подкоманда>",
  },
  {
    path: ["mcp"],
    summary: "MCP-сервер над реестром команд: запуск и токен доступа",
    usage: "mpu mcp [--profile ro|rw|ro,rw] [--port N]",
    bare: (argv, io, output, log) =>
      runMcpServer(argv, { io, output, commands, log }),
  },
];

/** Команда с ровно таким путём; для префикса группы — `undefined`. */
export function findCommand(path: readonly string[]): Command | undefined {
  return commands.find((command) => samePath(command.path, path));
}

/** Запись маршрута `legacy` с ровно таким путём. */
export function findLegacy(
  path: readonly string[],
): LegacyCommand | undefined {
  return legacyCommands.find((command) => samePath(command.path, path));
}

/** Группа с ровно таким путём. */
export function findGroup(path: readonly string[]): CommandGroup | undefined {
  return groups.find((group) => samePath(group.path, path));
}

/**
 * Что доступно непосредственно под этим путём: имя следующего сегмента
 * и его однострока. Порядок — порядок реестра, не алфавит.
 */
export function childrenOf(
  prefix: readonly string[],
): readonly { name: string; summary: string }[] {
  const seen = new Set<string>();
  const out: { name: string; summary: string }[] = [];
  // Ни маршрут, ни способ исполнения на состав справки не влияют:
  // индекс перечисляет всё дерево команд (`platform/registry.md`).
  for (const command of [...commands, ...legacyCommands, ...surfaces]) {
    if (!startsWith(command.path, prefix)) continue;
    const name = command.path[prefix.length];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const childPath = [...prefix, name];
    const group = findGroup(childPath);
    const summary = group?.summary ??
      findCommand(childPath)?.summary ??
      findLegacy(childPath)?.summary ??
      findSurface(childPath)?.summary ?? "";
    out.push({ name, summary });
  }
  return out;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((segment, i) => segment === right[i]);
}

function startsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, i) => segment === path[i]);
}
