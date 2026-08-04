/**
 * Контракт команды маршрута `native` (`platform/command-contract.md`):
 * из одного объявления обе точки входа — CLI для человека и MCP-сервер
 * для агента — получают разбор входа, исполнение, текст и структурный
 * результат со схемами.
 *
 * Объявление типизировано (`defineCommand`), а реестр хранит команды с
 * стёртыми типами аргументов и результата: снаружи доступны только
 * операции, которым конкретные типы не нужны. Приведений типов при этом
 * нет — сужение делает схема.
 */

import { z } from "@zod/zod";
import { type InputForm, type InputSpec, parseArgv } from "./args.ts";
import { type ObjectSchema, readObjectSchema } from "./schema.ts";
import { UsageError } from "./errors.ts";

export {
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "./errors.ts";
export type { InputForm, InputSpec } from "./args.ts";
export type { ObjectSchema, SchemaField } from "./schema.ts";

/** Объявленный класс команды: читающая или мутирующая. */
export type Policy = "ro" | "rw";

/**
 * Зависимости исполнения. Приёмников вывода здесь нет намеренно:
 * исполнение не печатает (инвариант 1), печать — дело точки входа.
 */
export interface CommandIo {
  readonly env: (name: string) => string | undefined;
  readonly cwd: () => string;
  /** Байты файла; отсутствие файла — `NotFoundIoError`. */
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /** Текст файла; отсутствие файла — `NotFoundIoError`. */
  readonly readTextFile: (path: string) => Promise<string>;
  readonly readTextStdin: () => Promise<string>;
  /** Содержимое файла хранилища; файла нет — `undefined`. */
  readonly readConfigStore: () => Promise<string | undefined>;
  /** Запись хранилища: каталог создаётся, права файла 0600. */
  readonly writeConfigStore: (text: string) => Promise<void>;
  /** Токен доступа MCP-сервера; файла нет — `undefined`. */
  readonly readAccessToken: () => Promise<string | undefined>;
  /** Запись токена: отдельный файл конфиг-каталога, права 0600. */
  readonly writeAccessToken: (token: string) => Promise<void>;
  /**
   * Shell, из которого запущен процесс: ближайший известный shell в
   * дереве предков (`platform/registry.md`). Переменная `SHELL` в этом
   * не участвует — при bash-родителе и `SHELL=/bin/zsh` нужен bash.
   */
  readonly currentShell: () => string | undefined;
  /** Дозапись в конец файла: установка completion в rc-файл shell. */
  readonly appendFile: (path: string, text: string) => Promise<void>;
  /** Запуск открывателя отвязанно; нет бинаря — `false`. */
  readonly launchOpener: (cmd: string, target: string) => boolean;
  /**
   * Запуск Python-реализации для маршрута `legacy`: вывод собирается
   * целиком, чтобы точка входа перенесла его дословно. Файла нет или
   * он не исполняем — `NotFoundIoError`.
   */
  readonly runLegacy: (
    bin: string,
    args: readonly string[],
  ) => Promise<LegacyOutcome>;
}

/** Итог подпроцесса маршрута `legacy`: потоки и код возврата. */
export interface LegacyOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Слой env-файла (`platform/env-file.md`): секреты и адреса внешних
 * систем с приоритетом «окружение процесса → env-файл». Объявлен на
 * стороне потребителя — реализация в `src/env/mod.ts`.
 */
export interface EnvFile {
  /** Значение по приоритету «окружение процесса → env-файл». */
  readonly get: (name: string) => string | undefined;
  /** То же; отсутствие или пустая строка — DomainError текстом спеки. */
  readonly require: (name: string) => string;
  /** Атомарная запись в файл; значение действует немедленно. */
  readonly set: (name: string, value: string) => Promise<void>;
}

/** Объявление команды: семь вещей контракта плюс формы записи в argv. */
export interface CommandSpec<A, R> {
  /** Сегменты имени после `mpu`. */
  readonly path: readonly string[];
  /** Назначение: одна строка для индекса родителя. */
  readonly summary: string;
  /** Строка использования листовой справки. */
  readonly usage: string;
  /** Подробная справка листовой команды. */
  readonly help: string;
  readonly policy: Policy;
  /** Схема аргументов: имена, типы, обязательность, дефолты, описания. */
  readonly argsSchema: z.ZodType<A>;
  /** Как входы записываются в argv; без записи вход читается как флаг. */
  readonly forms?: Readonly<Record<string, InputForm>>;
  readonly resultSchema: z.ZodType<R>;
  /** Исполнение: разобранные аргументы → результат. Не печатает. */
  readonly run: (args: A, io: CommandIo) => Promise<R>;
  /** Рендер результата в текст для человека. Чист. */
  readonly render: (result: R, args: A) => string;
  /**
   * Код завершения текстовой формы, когда результат сам сообщает о
   * неуспехе (`mpu xlsx resolve` без пути). Структурный результат
   * отдаётся всегда и с кодом 0 — форма вывода класс команды не меняет.
   */
  readonly textExitCode?: (result: R) => number;
}

/** Команда в реестре: типы аргументов и результата скрыты внутри. */
export interface Command {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly help: string;
  readonly policy: Policy;
  /** Схема входа как JSON Schema: разбор argv и схема входа тула. */
  readonly argsJsonSchema: ObjectSchema;
  /** Схема выхода как JSON Schema: схема результата тула. */
  readonly resultJsonSchema: ObjectSchema;
  /** Входы, принимаемые из argv: имя, тип и форма записи (инвариант 4). */
  readonly inputs: readonly InputSpec[];
  /** Обязательные имена argv (инвариант 5). */
  readonly requiredInputNames: readonly string[];
  /**
   * Разбирает argv в аргументы команды, не исполняя её: тем же путём,
   * что и `invoke`, поэтому по результату видно, какие имена argv
   * действительно принимает.
   */
  readonly parseArgs: (
    argv: readonly string[],
  ) => Readonly<Record<string, unknown>>;
  /** Разбирает argv и исполняет; возвращает результат, ничего не печатая. */
  readonly invoke: (
    argv: readonly string[],
    io: CommandIo,
  ) => Promise<unknown>;
  /**
   * Исполняет по объекту аргументов — форма входа MCP: агент присылает
   * не argv, а объект по опубликованной схеме входа тула
   * (`platform/command-contract.md`). Имя вне схемы — ошибка ввода:
   * схема тула объявлена закрытой.
   */
  readonly invokeInput: (
    input: unknown,
    io: CommandIo,
  ) => Promise<unknown>;
  /** Текст результата для человека; окружения не касается. */
  readonly renderResult: (
    result: unknown,
    argv: readonly string[],
  ) => string;
  /** Код завершения текстовой формы для этого результата. */
  readonly textExitCode: (result: unknown) => number;
  /** Проверяет образец результата объявленной схемой. */
  readonly assertResult: (value: unknown) => void;
}

/**
 * Собирает команду реестра из объявления: выводит из схемы аргументов
 * формы записи в argv и связывает разбор, исполнение и рендер.
 */
export function defineCommand<A, R>(spec: CommandSpec<A, R>): Command {
  const name = spec.path.join(" ");
  // Справочные тексты обязательны: команда без них собирает пустой
  // индекс родителя и пустое описание тула. Ловим при сборке реестра —
  // это паника инициализации, а не пустой вывод у пользователя.
  requireText(spec.summary, `${name}: назначение`);
  requireText(spec.usage, `${name}: строка использования`);
  requireText(spec.help, `${name}: справка`);
  const argsJsonSchema = readObjectSchema(
    z.toJSONSchema(spec.argsSchema, { io: "input" }),
    `${name}: схема аргументов`,
  );
  const resultJsonSchema = readObjectSchema(
    z.toJSONSchema(spec.resultSchema, { io: "output" }),
    `${name}: схема результата`,
  );
  const specs = inputSpecs(argsJsonSchema, spec.forms ?? {});
  const helpHint = `mpu ${name} --help`;
  const parse = (argv: readonly string[]): A =>
    parseArgs(spec.argsSchema, parseArgv(argv, specs, helpHint), helpHint);
  const parseInput = (input: unknown): A =>
    parseInputObject(spec.argsSchema, onlyKnownInputs(input, specs));

  return {
    path: spec.path,
    summary: spec.summary,
    usage: spec.usage,
    help: spec.help,
    policy: spec.policy,
    argsJsonSchema,
    resultJsonSchema,
    inputs: specs,
    requiredInputNames: argsJsonSchema.required ?? [],
    parseArgs: (argv) => asRecord(parse(argv), `${name}: аргументы`),
    // Оба исполнения асинхронны целиком: ошибка разбора приходит
    // отказом промиса, а не броском до его создания. Иначе вызывающий
    // обязан и `try`, и `.catch()` — на одну ветку больше на каждом
    // месте вызова.
    invoke: async (argv, io) => await spec.run(parse(argv), io),
    invokeInput: async (input, io) => await spec.run(parseInput(input), io),
    renderResult: (result, argv) =>
      spec.render(spec.resultSchema.parse(result), parse(argv)),
    textExitCode: (result) =>
      spec.textExitCode === undefined
        ? 0
        : spec.textExitCode(spec.resultSchema.parse(result)),
    assertResult: (value) => void spec.resultSchema.parse(value),
  };
}

/**
 * Проверяет сырые значения схемой. Сообщение первой проблемы уходит
 * пользователю дословно: тексты ошибок ввода — часть контракта команды,
 * поэтому объявляются там же, где схема.
 */
function parseArgs<A>(
  schema: z.ZodType<A>,
  raw: unknown,
  helpHint: string,
): A {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Имя входа в сообщение не подставляется: тексты ошибок ввода —
  // наблюдаемая поверхность команды, поэтому пишутся в схеме целиком.
  throw new UsageError(parsed.error.issues[0].message, {
    hint: helpHint,
    cause: parsed.error,
  });
}

/** Выводит описание входов из схемы: имена и типы берутся только оттуда. */
function inputSpecs(
  schema: ObjectSchema,
  forms: Readonly<Record<string, InputForm>>,
): readonly InputSpec[] {
  return Object.entries(schema.properties).map(([name, field]) => ({
    name,
    kind: kindOf(field.type),
    form: forms[name] ?? {},
  }));
}

/**
 * Проверяет объект аргументов схемой. От разбора argv отличается только
 * сообщением: у объекта имя поля не видно из формы записи, поэтому оно
 * ставится в начало — агенту иначе не понять, какой аргумент чинить.
 */
function parseInputObject<A>(schema: z.ZodType<A>, raw: unknown): A {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue.path.join(".");
  // Префикс дописывает генератор сообщений схемы, а имя поля мы ставим
  // сами — вместе получилось бы «long: Invalid input: expected …».
  // Смена префикса в апстриме видна по golden-паре invalid-args.
  const reason = issue.message.replace(/^Invalid input: /, "");
  throw new UsageError(where === "" ? issue.message : `${where}: ${reason}`, {
    cause: parsed.error,
  });
}

/**
 * Проверяет, что объект аргументов не несёт имён вне схемы. Схема
 * пропустила бы их молча, а опубликованная схема тула объявлена
 * закрытой — агент должен узнать об опечатке, а не потерять параметр.
 */
function onlyKnownInputs(
  input: unknown,
  specs: readonly InputSpec[],
): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new UsageError("arguments must be an object");
  }
  const known = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(input)) {
    if (!known.has(name)) {
      throw new UsageError(`unknown argument "${name}"`);
    }
  }
  return input;
}

/** Обязательный справочный текст команды; пустой — дефект объявления. */
function requireText(text: string, what: string): void {
  if (text.trim() === "") {
    throw new TypeError(`${what}: текст обязателен и не может быть пустым`);
  }
}

function kindOf(type: string | undefined): InputSpec["kind"] {
  if (type === "boolean") return "boolean";
  if (type === "array") return "strings";
  return "string";
}

/** Разобранные аргументы как словарь; корень схемы — объект (инвариант 7). */
function asRecord(
  value: unknown,
  what: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: разбор дал не объект`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}
