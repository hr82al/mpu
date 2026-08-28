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
  processCommand,
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
import { backupCommands } from "../backup/mod.ts";
import { makeSchemaCommand } from "../makeschema/mod.ts";
import {
  sheetAliasAddCommand,
  sheetAliasLsCommand,
  sheetAliasRmCommand,
  sheetBatchGetCommand,
  sheetBatchUpdateCommand,
  sheetCacheClearCommand,
  sheetCacheInfoCommand,
  sheetGetCommand,
  sheetLsCommand,
  sheetOpenCommand,
  sheetResolveCommand,
  sheetSetCommand,
} from "../sheet/mod.ts";
import { cleanLocalClientsCommand } from "../cleanlocal/mod.ts";
import {
  copyClientCommand,
  copyDevCommand,
  copySharedCommand,
} from "../copy/mod.ts";
import { configCommand } from "../config/cmd_config.ts";
import { glabStatusCommand } from "../glab/mod.ts";
import { apiCommands } from "../api/mod.ts";
import { moveClientBackCommand, moveClientCommand } from "../move/mod.ts";
import { mpInitCommand } from "../mpinit/mod.ts";
import {
  mrCommentCommand,
  mrCommentsCommand,
  mrCreateCommand,
  mrDeleteCommand,
  mrDescribeCommand,
  mrDiffCommand,
  mrEditCommand,
  mrFilesCommand,
  mrNoteCommand,
  mrReplyCommand,
  mrResolveCommand,
  mrShowCommand,
  mrUnresolveCommand,
  mrViewCommand,
} from "../mr/mod.ts";
import { confirmCommand } from "../confirm/mod.ts";
import { sunCommand } from "../sun/mod.ts";
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
  ...backupCommands,
  sunCommand,
  // Пересчёт витрин и создание схемы: первая — обёртка семейства,
  // вторая единственная ходит в локальный стенд, а не в прод.
  processCommand,
  makeSchemaCommand,
  // Чтение Google-таблиц: три подкоманды из семейства `sheet`
  // (`docs/specs/sheet.md`); остальные пока идут маршрутом `legacy`.
  sheetGetCommand,
  sheetLsCommand,
  sheetResolveCommand,
  // Пакетные операции мини-языком (`docs/specs/sheet-batch.md`): пара
  // неразделима — грамматика и разбор диапазонов у них общие.
  sheetBatchUpdateCommand,
  sheetBatchGetCommand,
  // Хозяева кэша вкладок (`docs/specs/sheet-cache.md`); прочие команды
  // семейства его только потребляют.
  sheetCacheInfoCommand,
  sheetCacheClearCommand,
  // Реестр таблиц (`docs/specs/sheet-registry.md`): короткие имена и
  // открытие в браузере. `sync` из той же спеки пока идёт `legacy`.
  sheetAliasAddCommand,
  sheetAliasLsCommand,
  sheetAliasRmCommand,
  sheetOpenCommand,
  // Последний лист семейства: с ним `sheet` уходит с маршрута
  // `legacy` целиком (`docs/specs/sheet-set.md`).
  sheetSetCommand,
  // Семейство `mr` целиком: чтение (`docs/specs/mr-read.md`) и запись
  // (`docs/specs/mr-write.md`). В легаси его подкоманд не осталось,
  // поэтому имя `mr` внесено в `NOT_LEGACY`.
  mrViewCommand,
  mrFilesCommand,
  mrDiffCommand,
  mrCommentsCommand,
  mrShowCommand,
  mrCreateCommand,
  mrDescribeCommand,
  mrCommentCommand,
  mrNoteCommand,
  mrReplyCommand,
  mrEditCommand,
  mrDeleteCommand,
  mrResolveCommand,
  mrUnresolveCommand,
  // Локальные предпочтения (`platform/config.md`): хранилищем уже
  // пользуются пять команд, а задать ключ до сих пор можно было только
  // подпроцессом прежней реализации.
  configCommand,
  // Локальный стенд: поднять его целиком и убрать данные клиентов.
  // Обе не ходят ни в прод, ни в сеть — только docker и локальные PG.
  mpInitCommand,
  cleanLocalClientsCommand,
  // Копирования: единственный санкционированный мост прод → локаль и
  // два его соседа (`copy-client.md`, `copy-shared.md`, `copy-dev.md`).
  copyClientCommand,
  copySharedCommand,
  copyDevCommand,
  // Переносы: команда ставит задачу в очередь и пишет ход в журнал;
  // сам перенос исполняют воркеры (`move-client.md`).
  moveClientCommand,
  moveClientBackCommand,
  // Прохождение MR по веткам пайплайна: читающая команда поверх того
  // же атома GitLab, что и семейство `mr` (`glab-status.md`).
  glabStatusCommand,
  // Читающая половина неймспейса `mpu api` (`docs/specs/api.md`):
  // двадцать две обёртки админских эндпоинтов sl-back. Имя группы
  // остаётся в слепке маршрута `legacy` до переезда пишущей половины —
  // неизвестная подкоманда уходит прежней реализации, как это было у
  // `kiten` и `telegram`.
  ...apiCommands,
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
    // Как и `kiten`: семейство переехало целиком, и промежуточный
    // уровень больше не приходит из слепка — без этой записи
    // `mpu mr --help` собирал бы пустой индекс.
    path: ["mr"],
    summary: "merge request'ы GitLab: чтение, комментарии ревью, резолв",
    usage: "mpu mr <подкоманда> [аргументы]",
  },
  {
    // Семейство переехало целиком — последним ушёл `set`, — и его
    // промежуточный уровень больше не приходит из слепка. Без этой
    // записи `mpu sheet --help` собирал бы пустой индекс, как было бы
    // у `kiten` и `mr` (`platform/registry.md`).
    path: ["sheet"],
    summary: "Google-таблицы: чтение, запись, алиасы, кэш",
    usage: "mpu sheet <подкоманда> [аргументы]",
  },
  {
    // Семейство переехало целиком — последними ушли шесть
    // `wb-loader-*`, — и его промежуточный уровень больше не приходит
    // из слепка (`platform/registry.md`, как у `sheet` и `kiten`).
    path: ["api"],
    summary: "админские эндпоинты sl-back: чтение, правка, загрузчики",
    usage: "mpu api <подкоманда> [аргументы]",
  },
  {
    // Подкоманды `ss-access` есть только здесь: в слепке их нет.
    path: ["api", "ss-access"],
    summary: "доступ к таблице клиента: request | status | revoke | reset",
    usage: "mpu api ss-access <подкоманда> [аргументы]",
  },
  {
    // Подкоманды `alias` есть только здесь: в слепке их нет.
    path: ["sheet", "alias"],
    summary: "короткие имена таблиц: add | ls | rm",
    usage: "mpu sheet alias <подкоманда> [аргументы]",
  },
  {
    // Промежуточный уровень `sheet cache`: подкоманды есть только
    // здесь, в слепке их нет.
    path: ["sheet", "cache"],
    summary: "локальный кэш вкладок: info | clear",
    usage: "mpu sheet cache <подкоманда> [аргументы]",
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
