/**
 * Точка входа CLI: маршрутизирует argv по реестру, исполняет команду,
 * печатает её результат и переводит классы ошибок в exit-коды. Печать
 * живёт только здесь — исполнение команды не печатает (инвариант 1
 * `platform/command-contract.md`).
 */

import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import {
  childrenOf,
  type CommandGroup,
  commands,
  findCommand,
  findGroup,
  findSurface,
  surfaces,
} from "../registry/mod.ts";
import { flagged } from "../messages/mod.ts";
import { helpEntries, runHelpCommand } from "./help_command.ts";
import { VERSION } from "../version.ts";
import { renderCommandHelp, renderIndex, renderSurfaceHelp } from "./help.ts";
import type { InvokeLog, OutputPolicy } from "../invokelog/mod.ts";

/** Приёмник вывода процесса. */
export interface Output {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Журнал вызовов глазами точки входа (`platform/invoke-log.md`).
 * Обвязка сообщает ему две вещи: что вызов пошёл маршрутом `native` —
 * только такие она журналирует, — и сам журнал, который нужен
 * долгоживущему MCP-серверу: тот пишет свою запись на каждый вызов
 * тула. Справка, `version`, completion и ошибки маршрутизации записей
 * не оставляют, поэтому на их ветках отметки нет.
 */
export interface InvokeJournal {
  readonly nativeCall: (command: OutputPolicy) => void;
  /** Заметка о ходе вызова в запись журнала, не на экран. */
  readonly note: (text: string) => void;
  readonly log: InvokeLog;
}

/** Строка использования корня. */
export const ROOT_USAGE = "mpu <команда> [аргументы]";
/**
 * Граница состояния и конфигурации в справке верхнего уровня: какая
 * переменная какие файлы уводит. Названа явно, потому что переменных
 * две и они уводят разное — оператор, подменивший одну
 * `XDG_CONFIG_HOME`, получает чужой env-файл при своей кэш-БД
 * (`platform/store.md`). Единственный полный приём изоляции — подмена
 * `HOME`, поэтому он назван последней строкой.
 */
const ENV_NOTE = `
Окружение:
  HOME             каталог состояния ~/.config/mpu: кэш-БД mpu.db, журнал
                   вызовов mpu.log, токен MCP-сервера token. XDG_CONFIG_HOME
                   их не уводит: файлы общие с прежней реализацией.
  XDG_CONFIG_HOME  каталог конфигурации $XDG_CONFIG_HOME/mpu: env-файл .env и
                   выведенный из его кред токен-кэш sl-back .api-token.json
                   (не задана — те же ~/.config/mpu).
Изолировать разом и состояние, и конфигурацию можно только подменой HOME.
`;
/** Однострока корня. */
export const ROOT_SUMMARY =
  "mpu — тонкий клиент сервера строк: команды исполняет mpu-back.";

/**
 * Общий параметр формы вывода: принимается с любой командой на любом
 * уровне вложенности и в схему аргументов команды не входит
 * (`platform/registry.md`).
 */
export const JSON_FLAG = "--json";

/** Имя справочной поверхности: `mpu help [<полное имя>]`. */
const HELP_COMMAND = "help";

/** Имя поверхности версии: `mpu version`. */
const VERSION_COMMAND = "version";

/** Исполняет вызов CLI и возвращает код завершения процесса. */
export async function runCli(
  argv: readonly string[],
  baseIo: CommandIo,
  output: Output,
  journal?: InvokeJournal,
): Promise<number> {
  return await runLine(argv, baseIo, output, journal);
}

/** Куда уходит результат исполненной команды. */
export interface Delivery {
  /**
   * Результат `result` команды `command`, вызванной с аргументами `args`;
   * `json` — снят общий параметр формы вывода. Итог — код завершения.
   */
  deliver(
    command: Command,
    result: unknown,
    args: readonly string[],
    json: boolean,
    output: Output,
  ): number;
}

/**
 * Результат команды в формате `json`, как его печатает `… end json`:
 * команда со своим `--json` (`sql-ro`) рисует его сама, прочим — JSON
 * результата.
 *
 * @param argv аргументы команды без `--json`
 */
export function jsonOf(
  command: Command,
  result: unknown,
  argv: readonly string[],
): string {
  if (!keepsJson(command)) return JSON.stringify(result, null, 2);
  return command.renderResult(result, flagged(argv, [JSON_FLAG]));
}

/** Печать результата: JSON или текст команды, код — от результата. */
export const PRINT: Delivery = {
  deliver(command, result, args, json, output) {
    // Код завершения отдаёт результат, а не форма его печати: строка с
    // `--json` и без него — один код (`platform/line-grammar.md` [D.6]).
    output.stdout(
      json
        ? JSON.stringify(result, null, 2)
        : command.renderResult(result, args),
    );
    return command.textExitCode(result);
  },
};

/**
 * Исполняет строку вызова без режима дополнения shell: общий параметр
 * `--json`, поверхности точки входа, поиск пути по реестру,
 * диспетчеризация и перевод ошибок в коды. Это же исполнение получает
 * строку целиком (`platform/registry-objects.md`).
 *
 * @param delivery куда уходит результат команды; по умолчанию — печать
 */
export async function runLine(
  argv: readonly string[],
  baseIo: CommandIo,
  output: Output,
  journal?: InvokeJournal,
  delivery: Delivery = PRINT,
): Promise<number> {
  const io = withProgressIo(baseIo, output, journal);
  const { args: rest, json } = takeJsonFlag(argv);

  const surfaceExit = runEntrypointSurface(rest, output);
  if (surfaceExit !== undefined) return surfaceExit;

  const { path, rest: args } = matchPath(rest);
  if (path.length === 0) {
    output.stderr(noSuchCommand(rest[0]));
    return 2;
  }

  try {
    return await dispatchPath(
      path,
      args,
      argv,
      { json, beforePath: jsonBeforePath(argv, path) },
      io,
      output,
      journal,
      delivery,
    );
  } catch (err) {
    return errorToExitCode(err, path, output);
  }
}

/**
 * Результат строки — поток (`logs --follow`): спрашивается до исполнения,
 * отбору он не подлежит. Строка, которую не разобрать, — не поток:
 * ошибку разбора покажет само исполнение.
 */
export function streams(argv: readonly string[]): boolean {
  const { args: rest } = takeJsonFlag(argv);
  const { path, rest: args } = matchPath(rest);
  const command = findCommand(path);
  if (command === undefined) return false;
  try {
    return command.streams(args);
  } catch (err) {
    if (err instanceof UsageError) return false;
    throw err;
  }
}

/**
 * Оборачивает переданный io печатью строк хода в stderr. Служебные строки
 * хода исполнения печатает точка входа, а не команда
 * (`platform/command-contract.md`, инвариант 1): команда отдаёт их
 * портом `progress`, а куда они попадут — решается здесь, рядом с
 * печатью результата и ошибок. Этот же приёмник достаётся и вызову
 * тула: строки хода идут туда же, а копию в запись вызова дописывает
 * тот, кто вызвал (`platform/invoke-log.md`).
 */
function withProgressIo(
  baseIo: CommandIo,
  output: Output,
  journal: InvokeJournal | undefined,
): CommandIo {
  return {
    ...baseIo,
    progress: (line) => output.stderr(`${line}\n`),
    // Заметка уходит в запись журнала и никуда больше: у неё другой
    // читатель — тот, кто разбирает вызов постфактум
    // (`platform/invoke-log.md`).
    note: (line) => journal?.note(line),
  };
}

/**
 * Поверхности точки входа, для которых поиск пути в реестре не нужен:
 * пустой вызов, справка верхнего уровня, неизвестная опция, `version`,
 * `help`. `undefined` — это не такая
 * поверхность, маршрутизация идёт дальше к поиску пути команды.
 */
function runEntrypointSurface(
  rest: readonly string[],
  output: Output,
): number | undefined {
  if (rest.length === 0) {
    // Вызов без команды: справка печатается, но это ошибка (спека).
    output.stdout(rootIndex());
    return 2;
  }
  if (isHelpRequest(rest[0])) {
    output.stdout(rootIndex());
    return 0;
  }
  if (rest[0].startsWith("-")) {
    output.stderr(`No such option "${rest[0]}"\n`);
    return 2;
  }

  const versionExit = runVersionSurface(rest, output);
  if (versionExit !== undefined) return versionExit;

  if (rest[0] === HELP_COMMAND) {
    // Поверхность точки входа, а не запись маршрута: список берётся из
    // единого реестра, поэтому не дрейфует от `--help` (отклонение-fix
    // спеки `platform/registry.md`).
    return runHelpCommand(
      rest.slice(1),
      helpEntries(commands, surfaces),
      output,
    );
  }

  return undefined;
}

/**
 * Поверхность `version`: `--help` на этом уровне и печать версии как
 * константы сборки, а не вопроса к Python-реализации
 * (`platform/registry.md`) — одна строка, без префиксов. `undefined` —
 * первый аргумент не `version`.
 */
function runVersionSurface(
  rest: readonly string[],
  output: Output,
): number | undefined {
  if (rest[0] !== VERSION_COMMAND) return undefined;
  if (rest.length > 1 && isHelpRequest(rest[1])) {
    const surface = findSurface([VERSION_COMMAND]);
    output.stdout(
      renderSurfaceHelp(surface?.usage ?? "", surface?.summary ?? ""),
    );
    return 0;
  }
  output.stdout(`${VERSION}\n`);
  return 0;
}

/**
 * Диспетчеризация уже найденного пути команды: группа и — через
 * `runLeafCommand` — листовая команда. Ошибки не перехватываются — их
 * в коды выхода переводит вызывающая сторона (`errorToExitCode`).
 */
async function dispatchPath(
  path: readonly string[],
  args: readonly string[],
  argv: readonly string[],
  json: JsonFlag,
  io: CommandIo,
  output: Output,
  journal: InvokeJournal | undefined,
  delivery: Delivery,
): Promise<number> {
  const command = findCommand(path);
  if (command === undefined) {
    return runGroup(path, args, output);
  }
  // Аргументы из исходного argv: их получает и подпроцесс моста, и
  // команда со своим `--json` — обоим он нужен на своём месте.
  return await runLeafCommand(
    command,
    path,
    args,
    dropPath(argv, path),
    json,
    io,
    output,
    journal,
    delivery,
  );
}

/**
 * Диспетчеризация листовой команды, уже найденной по пути: `--help`
 * команды и нативное исполнение.
 */
async function runLeafCommand(
  command: Command,
  path: readonly string[],
  args: readonly string[],
  own: readonly string[],
  json: JsonFlag,
  io: CommandIo,
  output: Output,
  journal: InvokeJournal | undefined,
  delivery: Delivery,
): Promise<number> {
  if (args.length > 0 && isHelpRequest(args[0])) {
    output.stdout(renderCommandHelp(command));
    return 0;
  }
  // Голый вызов команды, объявившей это своим контрактом, — просьба
  // показать, как её звать: печатается справка, а не сообщение схемы
  // (`specs/portainer-wrappers.md`, «CLI-контракт»; та же форма, что у
  // голого вызова группы). Признак объявляет команда: у соседей текст
  // отказа свой и закреплён их спеками (`specs/sql-ro.md`).
  if (args.length === 0 && command.helpWhenBare) {
    output.stdout(renderCommandHelp(command));
    return 2;
  }
  // Вызов пошёл маршрутом `native`: его журналирует обвязка, и отметка
  // стоит до исполнения — запись остаётся и у падения
  // (`platform/invoke-log.md`).
  journal?.nativeCall(command);
  if (!keepsJson(command)) {
    return await runCommand(command, args, json.json, io, output, delivery);
  }
  // Оба исключения действуют только ПОСЛЕ имени команды: до него чужой
  // командной строки ещё нет, и параметр снят обычным порядком
  // (`platform/registry.md`). У команды без структурной формы вывода
  // применить его не к чему: промолчать нельзя — пользователь ждёт
  // JSON, напечатать тоже — stdout занят байтами удалённой команды.
  // Команда со своим `--json` (`sql-ro`) в этом положении обычная:
  // параметр снят до её имени и применяется генерически.
  if (json.beforePath) {
    if (!takesUnknown(command)) {
      // Параметр снят обычным порядком и применяется генерически:
      // собственная форма вывода команды начинается с её имени.
      return await runCommand(command, args, json.json, io, output, delivery);
    }
    output.stderr(
      `mpu: --json не применяется к команде '${path.join(" ")}'\n`,
    );
    return 2;
  }
  // Команда, объявившая собственный `--json` (`specs/sql-ro.md`),
  // разбирает его сама; команда с хвостовым входом уносит его удалённой
  // стороне. И той и другой argv нужен как есть.
  return await runCommand(command, own, false, io, output, delivery);
}

/** Общий параметр формы вывода: снят ли он и где стоял. */
interface JsonFlag {
  readonly json: boolean;
  /** До имени команды — там исключений нет ни у кого. */
  readonly beforePath: boolean;
}

/**
 * Стоял ли `--json` до имени команды. Сравниваются позиции в исходном
 * argv: имя команды ищется по первому её сегменту, он же первый
 * непустой токен пути.
 */
function jsonBeforePath(
  argv: readonly string[],
  path: readonly string[],
): boolean {
  const flagAt = argv.indexOf(JSON_FLAG);
  const nameAt = argv.indexOf(path[0]);
  return flagAt >= 0 && nameAt >= 0 && flagAt < nameAt;
}

/**
 * Переводит ошибку исполнения найденного пути в код завершения
 * процесса: `UsageError` — неправильный вызов; `DomainError` — отказ
 * домена. Прочие ошибки перебрасываются дальше — это не их граница
 * обработки.
 */
function errorToExitCode(
  err: unknown,
  path: readonly string[],
  output: Output,
): number {
  if (err instanceof UsageError) {
    output.stderr(`${formatCommandError(errorNameOf(path), err)}\n`);
    return 2;
  }
  if (err instanceof DomainError) {
    output.stderr(`${formatCommandError(errorNameOf(path), err)}\n`);
    return 1;
  }
  throw err;
}

/**
 * Имя команды в префиксе её ошибок: объявленное самой командой либо
 * первый сегмент пути — им называются и отказы, случившиеся до того, как
 * команда нашлась (неизвестная опция уровня).
 */
function errorNameOf(path: readonly string[]): string {
  return findCommand(path)?.errorName ?? path[0];
}

/** Есть ли у команды собственный вход с именем общего параметра. */
function declaresJson(command: Command): boolean {
  const name = JSON_FLAG.slice(2);
  return command.inputs.some((input) => input.name === name);
}

/**
 * Общий параметр формы вывода к команде не применяется, если её
 * хвостовой вход забирает неопознанные токены (`platform/registry.md`):
 * `mpu ssh sl-1 mycli --json` — флаг чужой командной строки, и съесть
 * его значило бы менять чужой вызов. Структурной формы вывода у такой
 * команды нет и быть не может: её stdout — байты удалённой команды.
 */
function takesUnknown(command: Command): boolean {
  return command.inputs.some((input) => input.form.keepsUnknown === true);
}

/**
 * Оставлять ли `--json` команде. Два случая: она объявила такой вход
 * сама (`sql-ro` — форма результата с собственной проверкой) либо
 * забирает неопознанные токены хвостовым входом (`ssh` — флаг чужой
 * командной строки). Разбирает его при этом только первая; вторая
 * уносит токен дальше как есть.
 */
function keepsJson(command: Command): boolean {
  return declaresJson(command) || takesUnknown(command);
}

async function runCommand(
  command: Command,
  args: readonly string[],
  json: boolean,
  io: CommandIo,
  output: Output,
  delivery: Delivery,
): Promise<number> {
  const result = await command.invoke(args, io);
  return delivery.deliver(command, result, args, json, output);
}

/**
 * Промежуточный уровень: обычно только индекс, но уровень может нести
 * собственную поверхность голого вызова. Своего такого уровня сейчас
 * нет — узел `mcp` ушёл вместе со старым сервером
 * (`platform/cutover.md`).
 */
function runGroup(
  path: readonly string[],
  args: readonly string[],
  output: Output,
): number {
  const group = findGroup(path);
  if (group === undefined) {
    // Путь опознан по реестру, значит группа обязана быть описана.
    throw new UsageError(`группа "${path.join(" ")}" не описана в реестре`);
  }
  if (args.length > 0 && isHelpRequest(args[0])) {
    output.stdout(groupIndex(group));
    return 0;
  }
  if (args.length === 0) {
    output.stdout(groupIndex(group));
    return 2;
  }
  // Селектор после имени подкоманды — не «нет такой команды», а
  // перепутанный порядок: имя подкоманды реестру известно, стоит оно
  // не там (`specs/portainer-wrappers.md`, раскладка селектора).
  if (subPlace(group, args).kind === "misplaced") {
    throw new UsageError("селектор ставится перед именем подкоманды");
  }
  // У раскладки «селектор впереди» отличить забытую подкоманду от
  // опечатки в ней нельзя: оба выглядят как лишний позиционный токен.
  // Поэтому печатается индекс уровня — он называет доступные
  // подкоманды, а «No such command» назвало бы селектор командой.
  if (group.layout === "selector-first") {
    output.stdout(groupIndex(group));
    return 2;
  }
  // Имя вне реестра называется одинаково на любом уровне: ключевые
  // фразы ошибок — фиксируемая часть контракта (`platform/registry.md`).
  output.stderr(noSuchCommand([...path, args[0]].join(" ")));
  return 2;
}

function noSuchCommand(name: string): string {
  return `No such command '${name}'.\nTry 'mpu -h' for help.\n`;
}

/**
 * Снимает общий параметр формы вывода из argv. Всё после `--` —
 * позиционные аргументы команды и не разбирается.
 */
function takeJsonFlag(
  argv: readonly string[],
): { args: readonly string[]; json: boolean } {
  const args: string[] = [];
  let json = false;
  let index = 0;
  for (; index < argv.length; index++) {
    if (argv[index] === "--") break;
    if (argv[index] === JSON_FLAG) {
      json = true;
      continue;
    }
    args.push(argv[index]);
  }
  args.push(...argv.slice(index));
  return { args, json };
}

/**
 * Аргументы без сегментов имени команды. Вырезаются именно они, а не
 * первые N слов: снятый ранее общий параметр мог стоять между ними, и
 * подпроцессу он обязан достаться нетронутым.
 */
function dropPath(
  argv: readonly string[],
  path: readonly string[],
): readonly string[] {
  const rest: string[] = [];
  let matched = 0;
  for (const arg of argv) {
    if (matched < path.length && arg === path[matched]) {
      matched++;
      continue;
    }
    rest.push(arg);
  }
  return rest;
}

/** Самое длинное начало argv, опознанное реестром как путь команды. */
function matchPath(
  argv: readonly string[],
): { path: readonly string[]; rest: readonly string[] } {
  const path: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index].startsWith("-")) {
    // У группы с раскладкой «селектор впереди» жадный проход
    // останавливается на её имени: следующий токен там — селектор, а
    // имя подкоманды ищется ниже, с пропуском. Без остановки
    // перепутанный порядок (`ozon-jobs show sl-2`) опознался бы как
    // правильный путь с лишним позиционным аргументом.
    if (findGroup(path)?.layout === "selector-first") break;
    const candidate = [...path, argv[index]];
    if (
      findCommand(candidate) === undefined &&
      findGroup(candidate) === undefined
    ) {
      break;
    }
    path.push(argv[index]);
    index++;
  }
  const rest = argv.slice(index);
  const group = findGroup(path);
  if (group === undefined) return { path, rest };
  const place = subPlace(group, rest);
  // Имя подкоманды у группы с раскладкой «селектор впереди» стоит не
  // сразу за именем группы, а после селектора и режимов печати. Оно
  // вырезается из аргументов и достраивает путь — дальше по цепочке
  // раскладка никого не касается: листу достаётся ровно тот argv, что
  // и у соседей семейства (`specs/portainer-wrappers.md`).
  if (place.kind !== "named") return { path, rest };
  return {
    path: [...path, rest[place.at]],
    rest: [...rest.slice(0, place.at), ...rest.slice(place.at + 1)],
  };
}

/** Где в аргументах уровня стоит имя подкоманды. */
type SubPlace =
  | { readonly kind: "named"; readonly at: number }
  | { readonly kind: "misplaced" }
  | { readonly kind: "absent" };

/**
 * Разбор раскладки `selector-first`: у групп с умолчательной
 * раскладкой имя подкоманды разбирать нечего — оно и так первое.
 *
 * Имя подкоманды ищется только среди позиционных токенов. Значение
 * флага позиционным не считается: `--pattern prune show` — это образец
 * `prune` у подкоманды `show`, а не вызов `prune`. Ошибись здесь — и
 * человек получил бы чистку очереди вместо её показа, молча и в проде.
 *
 * Исключение одно: имя стоит первым позиционным, а за ним есть ещё
 * позиционный токен — это перепутанный порядок
 * (`mpu ozon-jobs show sl-2`). Голый `mpu ozon-jobs show` и
 * `mpu ozon-jobs show --help` перепутанными не считаются: второго
 * позиционного там нет, и лист сам ответит справкой.
 */
function subPlace(
  group: CommandGroup,
  args: readonly string[],
): SubPlace {
  if (group.layout !== "selector-first") return { kind: "absent" };
  const names = new Set(childrenOf(group.path).map((child) => child.name));
  const positions = positionalIndexes(group, args);
  const at = positions.find((index) => names.has(args[index]));
  if (at === undefined) return { kind: "absent" };
  if (at === positions[0] && positions.length > 1) {
    return { kind: "misplaced" };
  }
  return { kind: "named", at };
}

/**
 * Индексы позиционных токенов уровня: всё, что не флаг и не съедено
 * флагом со значением.
 *
 * Какие флаги берут значение, известно из схем подкоманд группы —
 * своей схемы у группы при этом не заводится и второго разборщика argv
 * не появляется: чужие объявления читаются, разбирает по-прежнему лист
 * (`specs/portainer-wrappers.md`, раскладка селектора).
 */
function positionalIndexes(
  group: CommandGroup,
  args: readonly string[],
): readonly number[] {
  const valued = valueFlags(group);
  const found: number[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!isFlag(arg)) {
      found.push(index);
      continue;
    }
    // `--флаг=значение` следующий токен не съедает: значение при нём.
    if (valued.has(arg)) index++;
  }
  return found;
}

/** Флаги подкоманд группы, забирающие следующий токен значением. */
function valueFlags(group: CommandGroup): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const child of childrenOf(group.path)) {
    const command = findCommand([...group.path, child.name]);
    if (command === undefined) continue;
    for (const input of command.inputs) {
      if (input.form.positional !== undefined) continue;
      if (input.kind === "boolean") continue;
      flags.add(`--${input.name}`);
      if (input.form.short !== undefined) flags.add(`-${input.form.short}`);
    }
  }
  return flags;
}

function rootIndex(): string {
  return renderIndex(ROOT_USAGE, ROOT_SUMMARY, [...childrenOf([])], ENV_NOTE);
}

function groupIndex(group: CommandGroup): string {
  return renderIndex(group.usage, group.summary, [...childrenOf(group.path)]);
}

function isHelpRequest(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

function isFlag(arg: string): boolean {
  return arg.startsWith("-");
}
