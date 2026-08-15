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
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import {
  childrenOf,
  type CommandGroup,
  commands,
  findCommand,
  findGroup,
  findLegacy,
  findSurface,
  legacyCommands,
  surfaces,
} from "../registry/mod.ts";
import { helpEntries, runHelpCommand } from "./help_command.ts";
import { VERSION } from "../version.ts";
import { readManifest } from "../mcp/legacy_tools.ts";
import treeManifest from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};
import {
  LegacyBinMissingError,
  type LegacyIo,
  runLegacyCommand,
} from "../legacy/mod.ts";
import { renderCommandHelp, renderIndex, renderSurfaceHelp } from "./help.ts";
import {
  type InvokeLog,
  NO_INVOKE_LOG,
  type OutputPolicy,
} from "../invokelog/mod.ts";
import {
  COMPLETE_ENV,
  completionCandidates,
  completionInput,
  completionInstalled,
  type CompletionItem,
  completionMode,
  completionRcPath,
  completionReply,
  completionScript,
} from "./completion.ts";

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
  readonly log: InvokeLog;
}

const ROOT_USAGE = "mpu <команда> [аргументы]";
const ROOT_SUMMARY =
  "Monorepo Python utilities — multi-purpose CLI for ad-hoc operations.";

/**
 * Общий параметр формы вывода: принимается с любой командой на любом
 * уровне вложенности и в схему аргументов команды не входит
 * (`platform/registry.md`).
 */
const JSON_FLAG = "--json";

/** Общий флаг справки: он есть на каждом уровне дерева. */
const HELP_FLAG = "--help";

/** Описания общих флагов: у них нет объявления, откуда их взять. */
const HELP_FLAG_SUMMARY = "справка по этому уровню";
const JSON_FLAG_SUMMARY = "результат как JSON вместо текста";

/** Имя справочной поверхности: `mpu help [<полное имя>]`. */
const HELP_COMMAND = "help";

/** Имя поверхности версии: `mpu version`. */
const VERSION_COMMAND = "version";

/** Опции дополнения: печать скрипта и его установка в rc-файл shell. */
const SHOW_COMPLETION = "--show-completion";
const INSTALL_COMPLETION = "--install-completion";

/** Исполняет вызов CLI и возвращает код завершения процесса. */
export async function runCli(
  argv: readonly string[],
  baseIo: CommandIo,
  output: Output,
  journal?: InvokeJournal,
): Promise<number> {
  const io = withProgressIo(baseIo, output);

  const completionExit = runCompletionMode(io, output);
  if (completionExit !== undefined) return completionExit;

  const { args: rest, json } = takeJsonFlag(argv);

  const surfaceExit = await runEntrypointSurface(rest, io, output);
  if (surfaceExit !== undefined) return surfaceExit;

  const { path, rest: args } = matchPath(rest);
  if (path.length === 0) {
    output.stderr(noSuchCommand(rest[0]));
    return 2;
  }

  try {
    return await dispatchPath(path, args, argv, json, io, output, journal);
  } catch (err) {
    return errorToExitCode(err, path, output);
  }
}

/**
 * Оборачивает переданный io печатью строк хода в stderr. Служебные строки
 * хода исполнения печатает точка входа, а не команда
 * (`platform/command-contract.md`, инвариант 1): команда отдаёт их
 * портом `progress`, а куда они попадут — решается здесь, рядом с
 * печатью результата и ошибок. Этот же приёмник достаётся и
 * MCP-серверу — он поднимается голым вызовом `mpu mcp` и печатает
 * строки хода туда же; копию в запись своего вызова тула дописывает
 * уже он сам (`platform/invoke-log.md`).
 */
function withProgressIo(baseIo: CommandIo, output: Output): CommandIo {
  return {
    ...baseIo,
    progress: (line) => output.stderr(`${line}\n`),
  };
}

/** Срез порта для дополнения shell: слово и режим лежат в окружении. */
type CompletionEnvIo = Pick<CommandIo, "env">;

/**
 * Режим дополнения shell: печатаем варианты и молчим обо всём прочем —
 * сюда попадают из shell, а не из рук пользователя. `undefined` — вызов
 * пришёл не из shell-дополнения, маршрутизация идёт дальше как обычно.
 */
function runCompletionMode(
  io: CompletionEnvIo,
  output: Output,
): number | undefined {
  const mode = completionMode(io.env(COMPLETE_ENV));
  if (mode === undefined) return undefined;
  output.stdout(completionReply(mode, candidates(io)));
  return 0;
}

/**
 * Срез порта поверхностей точки входа: собственных полей у них нет —
 * это объединение того, что нужно опциям дополнения и справке, которая
 * отдаёт порт дальше маршруту `legacy`.
 */
type EntrypointSurfaceIo = CompletionOptionIo & LegacyIo;

/**
 * Поверхности точки входа, для которых поиск пути в реестре не нужен:
 * пустой вызов, справка верхнего уровня, опции дополнения shell,
 * неизвестная опция, `version`, `help`. `undefined` — это не такая
 * поверхность, маршрутизация идёт дальше к поиску пути команды.
 */
async function runEntrypointSurface(
  rest: readonly string[],
  io: EntrypointSurfaceIo,
  output: Output,
): Promise<number | undefined> {
  if (rest.length === 0) {
    // Вызов без команды: справка печатается, но это ошибка (спека).
    output.stdout(rootIndex());
    return 2;
  }
  if (isHelpRequest(rest[0])) {
    output.stdout(rootIndex());
    return 0;
  }
  if (rest[0] === SHOW_COMPLETION || rest[0] === INSTALL_COMPLETION) {
    return await runCompletionOption(rest[0], rest[1], io, output);
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
    return await runHelpCommand(
      rest.slice(1),
      helpEntries(commands, legacyCommands, surfaces),
      io,
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
 * Диспетчеризация уже найденного пути команды: подпроцесс маршрута
 * `legacy`, группа и — через `runLeafCommand` — листовая команда.
 * Ошибки не перехватываются — их в коды выхода переводит вызывающая
 * сторона (`errorToExitCode`).
 */
async function dispatchPath(
  path: readonly string[],
  args: readonly string[],
  argv: readonly string[],
  json: boolean,
  io: CommandIo,
  output: Output,
  journal: InvokeJournal | undefined,
): Promise<number> {
  const legacy = findLegacy(path);
  if (legacy !== undefined) {
    // Аргументы берутся из исходного argv: общий параметр точки
    // входа для этого маршрута не распознаётся и уходит подпроцессу
    // как обычный аргумент (`platform/registry.md`).
    return await runLegacyCommand(legacy, dropPath(argv, path), io, output);
  }
  const command = findCommand(path);
  if (command === undefined) {
    return await runGroup(
      path,
      args,
      io,
      output,
      journal?.log ?? NO_INVOKE_LOG,
    );
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
  );
}

/**
 * Диспетчеризация листовой команды, уже найденной по пути: `--help`
 * команды, мост в `legacy` для ещё не перенесённой поверхности и
 * нативное исполнение.
 */
async function runLeafCommand(
  command: Command,
  path: readonly string[],
  args: readonly string[],
  own: readonly string[],
  json: boolean,
  io: CommandIo,
  output: Output,
  journal: InvokeJournal | undefined,
): Promise<number> {
  if (args.length > 0 && isHelpRequest(args[0])) {
    output.stdout(renderCommandHelp(command));
    return 0;
  }
  if (command.bridge(own)) {
    // Часть поверхности команды может быть ещё не перенесена — такой
    // вызов уходит прежней реализации целиком, до разбора аргументов
    // и до отметки журналу: запись о нём делает сам подпроцесс
    // (`platform/invoke-log.md`, «Разделение моста»).
    return await runLegacyCommand(
      { path, summary: command.summary },
      own,
      io,
      output,
    );
  }
  // Вызов пошёл маршрутом `native`: его журналирует обвязка, и отметка
  // стоит до исполнения — запись остаётся и у падения
  // (`platform/invoke-log.md`).
  journal?.nativeCall(command);
  // Команда, объявившая собственный `--json` (`specs/sql-ro.md`: форма
  // результата с собственным текстом и проверкой конфликта с `--md`),
  // разбирает флаг сама — общий параметр точки входа её не
  // перехватывает, иначе объявленное поведение было бы недостижимо.
  return declaresJson(command)
    ? await runCommand(command, own, false, io, output)
    : await runCommand(command, args, json, io, output);
}

/**
 * Переводит ошибку исполнения найденного пути в код завершения процесса:
 * `LegacyBinMissingError` — до команды не дошло, ошибка реестра;
 * `UsageError` — неправильный вызов; `DomainError` — отказ домена.
 * Прочие ошибки перебрасываются дальше — это не их граница обработки.
 */
function errorToExitCode(
  err: unknown,
  path: readonly string[],
  output: Output,
): number {
  if (err instanceof LegacyBinMissingError) {
    // Сообщение реестра, а не команды: до неё дело не дошло.
    output.stderr(`mpu: ${err.message}\n`);
    return 1;
  }
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

async function runCommand(
  command: Command,
  args: readonly string[],
  json: boolean,
  io: CommandIo,
  output: Output,
): Promise<number> {
  const result = await command.invoke(args, io);
  if (json) {
    // Структурный результат отдаётся как есть: форма вывода класс
    // команды и её код завершения не меняет.
    output.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  output.stdout(command.renderResult(result, args));
  return command.textExitCode(result);
}

/**
 * Варианты дополнения: имена верхнего уровня, отфильтрованные по уже
 * набранному слову. Слово берётся из служебных переменных shell — сам
 * режим дополнения командную строку не разбирает.
 */
function candidates(io: CompletionEnvIo): readonly CompletionItem[] {
  const bash = io.env("COMP_WORDS");
  const line = bash ?? io.env("_TYPER_COMPLETE_ARGS") ?? "";
  const input = completionInput(
    line,
    bash === undefined ? undefined : io.env("COMP_CWORD"),
  );
  // Слово с дефиса — это флаг: предлагаются флаги уровня, а не имена
  // подкоманд (`platform/registry.md`).
  const items = input.word.startsWith("-")
    ? levelFlags(input.prefix)
    // Дополняется тот уровень дерева, до которого дошли: после
    // `mpu xlsx` — его подкоманды, а не имена верхнего уровня.
    : childrenOf(input.prefix).map((child) => ({
      name: child.name,
      summary: child.summary,
    }));
  return completionCandidates(items, input.word);
}

/**
 * Флаги уровня. У команды контракта они выводятся из схемы аргументов,
 * у записи маршрута `legacy` — из описания параметров в слепке; общий
 * параметр точки входа и `--help` доступны обеим.
 */
function levelFlags(path: readonly string[]): readonly CompletionItem[] {
  const flag = (name: string, summary = "") => ({ name, summary });
  const command = findCommand(path);
  if (command !== undefined) {
    // Описание флага — то же, что в справке: оно объявлено в схеме
    // аргументов и второго источника не заводится.
    const declared = command.inputs
      .filter((input) => input.form.positional === undefined)
      .map((input) =>
        flag(
          `--${input.name}`,
          command.argsJsonSchema.properties[input.name].description ?? "",
        )
      );
    return [
      ...declared,
      // Свой флаг с тем же именем уже в списке — второй раз его не
      // предлагаем (описание берётся из схемы команды).
      ...(declaresJson(command) ? [] : [flag(JSON_FLAG, JSON_FLAG_SUMMARY)]),
      flag(HELP_FLAG, HELP_FLAG_SUMMARY),
    ];
  }
  const leaf = legacyLeaf(path);
  if (leaf !== undefined) {
    const declared = leaf.params
      .filter((param) => param.kind === "option")
      .map((param) =>
        flag(
          param.opts?.find((opt) => opt.startsWith("--")) ?? `--${param.name}`,
          param.help ?? "",
        )
      );
    // Общий параметр формы вывода командам этого маршрута не
    // предлагается: он ими не распознаётся и уходит подпроцессу как
    // обычный аргумент (`platform/registry.md`).
    return [...declared, flag(HELP_FLAG, HELP_FLAG_SUMMARY)];
  }
  // Уровень без собственных флагов (группа) — только общие.
  return [flag(HELP_FLAG, HELP_FLAG_SUMMARY)];
}

/** Лист слепка по пути: у записи маршрута `legacy` флаги описаны там. */
function legacyLeaf(path: readonly string[]) {
  const name = path.join(" ");
  return readManifest(treeManifest).commands.find(
    (leaf) => leaf.path.join(" ") === name,
  );
}

/** Срез порта для опций дополнения: shell, HOME, чтение и запись rc-файла. */
type CompletionOptionIo =
  & Pick<CommandIo, "currentShell" | "env" | "appendFile">
  & RcFileIo;

/**
 * `--show-completion` печатает скрипт, `--install-completion` дописывает
 * его в rc-файл. Shell берётся из аргумента, если он задан, иначе от
 * окружения: определение по дереву процессов-предков — забота адаптера
 * рантайма, а не этой функции (`platform/registry.md`).
 */
async function runCompletionOption(
  option: string,
  argument: string | undefined,
  io: CompletionOptionIo,
  output: Output,
): Promise<number> {
  const shell = argument ?? io.currentShell();
  if (shell !== "bash" && shell !== "zsh") {
    output.stderr(
      `mpu: неизвестный shell для completion: ${shell ?? "(не определён)"}\n`,
    );
    return 2;
  }
  const script = completionScript(shell);
  if (option === SHOW_COMPLETION) {
    output.stdout(script);
    return 0;
  }
  const path = completionRcPath(shell, io.env("HOME"));
  if (path === undefined) {
    output.stderr("mpu: HOME не задан, некуда устанавливать completion\n");
    return 1;
  }
  if (completionInstalled(await readRcFile(io, path))) {
    // Повторный запуск не плодит копии: вторая ничего не меняет, но
    // засоряет rc-файл и путает при чтении.
    output.stdout(`completion для ${shell} уже установлен в ${path}\n`);
    return 0;
  }
  await io.appendFile(path, `\n${script}`);
  output.stdout(`completion для ${shell} дописан в ${path}\n`);
  return 0;
}

/** Срез порта для чтения rc-файла. */
type RcFileIo = Pick<CommandIo, "readTextFile">;

/** Содержимое rc-файла; файла ещё нет — пустая строка. */
async function readRcFile(io: RcFileIo, path: string): Promise<string> {
  try {
    return await io.readTextFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) return "";
    throw err;
  }
}

/**
 * Промежуточный уровень: обычно только индекс, но уровень может нести
 * собственную поверхность голого вызова (`mpu mcp` поднимает сервер).
 */
async function runGroup(
  path: readonly string[],
  args: readonly string[],
  io: CommandIo,
  output: Output,
  log: InvokeLog,
): Promise<number> {
  const group = findGroup(path);
  if (group === undefined) {
    // Путь опознан по реестру, значит группа обязана быть описана.
    throw new UsageError(`группа "${path.join(" ")}" не описана в реестре`);
  }
  if (args.length > 0 && isHelpRequest(args[0])) {
    output.stdout(groupIndex(group));
    return 0;
  }
  // Подкоманду называет только первый аргумент: дальше идут значения
  // флагов уровня, и они выглядят так же («--profile ro»).
  if (group.bare !== undefined && (args.length === 0 || isFlag(args[0]))) {
    return await group.bare(args, io, output, log);
  }
  if (args.length === 0) {
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
    const candidate = [...path, argv[index]];
    if (
      findCommand(candidate) === undefined &&
      findGroup(candidate) === undefined &&
      findLegacy(candidate) === undefined
    ) {
      break;
    }
    path.push(argv[index]);
    index++;
  }
  return { path, rest: argv.slice(index) };
}

function rootIndex(): string {
  return renderIndex(ROOT_USAGE, ROOT_SUMMARY, [...childrenOf([])]);
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
