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
  type ErrorDetails,
  formatCommandError,
  NotFoundIoError,
  UsageError,
  VerbatimError,
  VerbatimUsageError,
} from "./errors.ts";
export type { InputForm, InputSpec } from "./args.ts";
export type { ObjectSchema, SchemaField } from "./schema.ts";

/** Объявленный класс команды: читающая или мутирующая. */
export type Policy = "ro" | "rw";

/**
 * Значение, которое можно связать в SQL-запросе к кэш-БД. Байты —
 * ради BLOB-столбцов схемы: сжатый лист таблицы (`sheet_tabs.payload`,
 * `platform/webapp-http.md`) хранится как есть, а не текстом.
 */
export type SqlParam = string | number | null | Uint8Array;

/** Строка результата запроса к кэш-БД: имя столбца → значение. */
export type SqlRow = Readonly<
  Record<string, string | number | null | Uint8Array>
>;

/**
 * Локальная кэш-БД (`platform/store.md`): открытие, идемпотентный
 * bootstrap схемы, транзакции. Домен таблиц атому не известен — это дело
 * потребителя, поэтому интерфейс объявлен здесь, а не в `src/store/`.
 */
export interface CacheDb extends Disposable {
  /** Путь файла БД. */
  readonly path: string;
  /** Идемпотентно создаёт недостающие таблицы и индексы схемы. */
  readonly bootstrap: () => void;
  /** Исполняет запрос без результата; возвращает число изменённых строк. */
  readonly execute: (sql: string, ...params: SqlParam[]) => number;
  /** Исполняет запрос с результатом. */
  readonly query: (sql: string, ...params: SqlParam[]) => readonly SqlRow[];
  /** BEGIN/COMMIT вокруг тела; исключение — ROLLBACK и проброс дальше. */
  readonly transaction: (body: () => void) => void;
}

/**
 * Куда идут stdout и stderr удалённой команды. Проточный приёмник (CLI)
 * отдаёт байты в потоки процесса сразу и не копит ничего; копящий
 * (вызов тула, где потока к агенту нет) отвечает накопленным текстом —
 * его команда кладёт в результат. Один и тот же вывод не может уйти
 * обоими путями: что ушло в поток, в результате не повторяется.
 */
export interface RemoteOutput {
  readonly out: (chunk: Uint8Array) => void;
  readonly err: (chunk: Uint8Array) => void;
  /** Накопленное; у проточного приёмника — пустая строка. */
  readonly captured: () => string;
}

/**
 * Зависимости исполнения. Приёмников вывода здесь нет намеренно:
 * исполнение не печатает (инвариант 1), печать — дело точки входа.
 * Исключений два, и они разной силы.
 *
 * `progress` — в границах буквы инварианта: служебный канал хода
 * исполнения, не проекция результата; команда доставляет строку портом,
 * печатает её точка входа и именно в stderr
 * (`platform/command-contract.md`, инвариант 1).
 *
 * `openRemoteOutput` — сильнее: вывод команды, исполняемой в
 * контейнере, проходит насквозь и в CLI попадает в **stdout** процесса
 * (`platform/exec-transport.md`: «стримить stdout/stderr»). Для команд
 * транспорта stdout перестаёт быть исключительно проекцией результата —
 * рендером этот вывод не порождается и порождён быть не может: он
 * приходит байтами по ходу исполнения. Печатать его или копить, решает
 * точка входа, а не команда.
 */
export interface CommandIo {
  /**
   * Служебные переменные обвязки и режима дополнения (`HOME`,
   * `_MPU_COMPLETE` и соседи). Ключи env-файла (секреты, адреса внешних
   * систем) читаются не отсюда, а через `envFile` ниже.
   */
  readonly env: (name: string) => string | undefined;
  readonly cwd: () => string;
  /** Байты файла; отсутствие файла — `NotFoundIoError`. */
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /**
   * Байты файла, который обязан быть ОБЫЧНЫМ файлом: каталог и прочее
   * не-файловое отвергается тем же `NotFoundIoError`, что и отсутствие
   * пути. Нужно командам, для которых «путь есть, но читать нечего» —
   * ошибка ввода с одним текстом (`docs/specs/kiten-comment.md`,
   * `-f <каталог>`; `docs/specs/kiten-field.md`, `artefact set`).
   */
  readonly readRegularFile: (path: string) => Promise<Uint8Array>;
  /** Текст файла; отсутствие файла — `NotFoundIoError`. */
  readonly readTextFile: (path: string) => Promise<string>;
  /**
   * Весь stdin процесса байтами. Байты, а не текст: команда,
   * доставляющая stdin наружу (`specs/ssh.md`), обязана донести
   * двоичный вход без порчи, а декодирование в UTF-8 портит его молча и
   * необратимо. Текст поверх байтов даёт `readTextStdin`.
   */
  readonly readStdin: () => Promise<Uint8Array>;
  /**
   * Терминал ли stdin процесса. Команда, читающая stdin, различает по
   * нему пайп и человека за клавиатурой: приглашение ко вводу уместно
   * только второму (`docs/specs/sql-ro.md`, источники SQL).
   */
  readonly stdinIsTerminal: () => boolean;
  /**
   * Терминал ли stdout процесса. По нему команда с несколькими видами
   * вывода отличает человека от пайпа: в пайп уходит машиночитаемая форма
   * (`docs/specs/kiten-card.md`, выбор вида).
   */
  readonly stdoutIsTerminal: () => boolean;
  /**
   * Терминал ли stderr процесса. Нужен диагностике `mpu confirm`: она
   * перечисляет все три std-fd, и умолчать про один значило бы
   * оставить читателя без той строки, ради которой он её и читает
   * (`docs/specs/confirm.md`).
   */
  readonly stderrIsTerminal: () => boolean;
  /**
   * Заметка о ходе вызова в запись журнала: повтор запроса к webapp,
   * нечисловое значение ключа конфигурации. На экран не идёт — у
   * заметки другой читатель, разбирающий вызов постфактум
   * (`platform/invoke-log.md`).
   */
  readonly note: (line: string) => void;
  /**
   * Управляющий терминал процесса для вопроса человеку. `undefined` —
   * терминала нет: пайп без tty, cron, вызов тула.
   *
   * Отдельный порт, а не stdin: у команды-ворот stdin занят данными, и
   * спрашивать по нему нечего (`docs/specs/confirm.md`).
   */
  readonly openTerminal: () => Promise<TerminalIo | undefined>;
  /** Токен доступа MCP-сервера; файла нет — `undefined`. */
  readonly readAccessToken: () => Promise<string | undefined>;
  /** Запись токена: отдельный файл конфиг-каталога, права 0600. */
  readonly writeAccessToken: (token: string) => Promise<void>;
  /**
   * Файл токен-кэша sl-back (`platform/slback-http.md`): сосед кэш-БД в
   * конфиг-каталоге, общий с Python-реализацией — потому файл, а не
   * ключ предпочтений. Отдаётся текстом: формат записи и её срок
   * годности — дело клиента sl-back, не рантайма.
   *
   * Отдельная пара портов, а не общая «запись файла»: у обоих концов
   * путь один и известен рантайму, а право писать по произвольному
   * пути команде выдавать незачем (то же рассуждение, что у токена
   * доступа MCP-сервера выше).
   */
  readonly readTokenCache: () => Promise<string | undefined>;
  /** Атомарная запись того же файла, права 0600. */
  readonly writeTokenCache: (text: string) => Promise<void>;
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
  /** Слой env-файла (`platform/env-file.md`): секреты, адреса внешних систем. */
  readonly envFile: EnvFile;
  /** Открывает локальную кэш-БД (`platform/store.md`). */
  readonly openCacheDb: () => CacheDb;
  /** Служебная строка хода исполнения; точка входа печатает её в stderr. */
  readonly progress: (line: string) => void;
  /**
   * Приёмник вывода удалённой команды на один прогон
   * (`platform/exec-transport.md`). Проекцией результата этот вывод не
   * является и рендером не порождается: он приходит байтами по мере
   * исполнения, и что с ним делать — знает точка входа, а не команда.
   */
  readonly openRemoteOutput: () => RemoteOutput;
}

/**
 * Слой env-файла (`platform/env-file.md`): секреты и адреса внешних
 * систем. Читается только файл — окружение процесса на конфиг-ключи не
 * влияет (решение 2026-08-05, там же в отклонениях). Объявлен на
 * стороне потребителя — реализация в `src/env/mod.ts`.
 */
export interface EnvFile {
  /** Значение ключа из env-файла; ключа нет — `undefined`. */
  readonly get: (name: string) => string | undefined;
  /** То же; отсутствие или пустая строка — DomainError текстом спеки. */
  readonly require: (name: string) => string;
  /** Атомарная запись в файл; значение действует немедленно. */
  readonly set: (name: string, value: string) => Promise<void>;
  /**
   * Все пары «ключ → значение» файла копией. Нужно поиску сервера по
   * адресу (`platform/selector.md`): ключи `sl_<N>`/`pg_<N>` перебираются
   * по значению, а их номера заранее не известны — диапазон N не ограничен.
   */
  readonly values: () => Readonly<Record<string, string>>;
}

/**
 * Пометки журнала вызовов (`platform/invoke-log.md`, «Инварианты»).
 *
 * `logsOutput` — пишутся ли секции out/err записи. Умолчание — да;
 * `false` у команд, чей вывод в журнале неуместен: сам журнал (`log`),
 * поиск (`search`), `mcp token` с токеном доступа.
 *
 * `logsArguments` — пишутся ли аргументы. Умолчание — да; `false` там,
 * где ввод персонален сам по себе: заметка `telegram log`, пароль
 * `users add`.
 *
 * Скрыв ввод, команда обязана **решить** про вывод: тип требует
 * написать `logsOutput` явно, любым из двух значений. Настоящее
 * правило — «вывод, содержащий собственный ввод, скрывается вместе с
 * ним», а его тип выразить не может: у `telegram log` в выводе номер
 * сообщения и ввода в нём нет, у `users add` печать и есть ввод.
 * Пара в типе — механизм, заставляющий этот вопрос задать: у
 * `users add` пометка вывода была умолчанием, и пароль уезжал в
 * журнал секцией `out` мимо маски аргументов.
 */
export type JournalMarks =
  | {
    readonly logsOutput?: boolean;
    readonly logsArguments?: true;
  }
  | {
    /** Обязателен и осознан: см. `JournalMarks`. */
    readonly logsOutput: boolean;
    readonly logsArguments: false;
  };

/**
 * Открытый управляющий терминал: вопрос человеку и его ответ.
 *
 * Имя устройства необязательно: в Deno нет `ttyname`, и рантайм,
 * который его не знает, честно отдаёт `undefined` — диагностика назовёт
 * это вслух, а не укоротит вывод молча (`docs/specs/confirm.md`).
 */
export interface TerminalIo extends Disposable {
  readonly name: string | undefined;
  /** Пишет текст в терминал как есть, без добавленного перевода. */
  readonly write: (text: string) => Promise<void>;
  /** Одна строка ответа без перевода; конец ввода — `undefined`. */
  readonly readLine: () => Promise<string | undefined>;
  /**
   * То же, но набранное не показывается на экране: пароль второго
   * фактора Telegram (`docs/specs/telegram-login.md`, инвариант 1).
   * Отдельный метод, а не флаг у `readLine`: у скрытого чтения другой
   * режим терминала, и «видимо ли набранное» должно быть видно на
   * месте вызова, а не спрятано в аргументе.
   */
  readonly readSecret: () => Promise<string | undefined>;
}

/**
 * Объявление команды: семь вещей контракта, формы записи в argv и
 * пометки журнала (`JournalMarks` — пара, а не два независимых флага).
 */
export type CommandSpec<A, R> = CommandDeclaration<A, R> & JournalMarks;

/** Всё объявление, кроме пометок журнала: они — пара, а не поля. */
interface CommandDeclaration<A, R> {
  /** Сегменты имени после `mpu`. */
  readonly path: readonly string[];
  /** Назначение: одна строка для индекса родителя. */
  readonly summary: string;
  /** Строка использования листовой справки. */
  readonly usage: string;
  /** Подробная справка листовой команды. */
  readonly help: string;
  readonly policy: Policy;
  /**
   * Имя команды в префиксе её ошибок (`mpu <имя>: …`). Не объявлено —
   * первый сегмент пути: спека семейства `xlsx` требует общего префикса
   * `mpu xlsx` на все подкоманды (`specs/xlsx.md`), тогда как семейство
   * `kiten` называет себя полным путём с подкомандой
   * (`platform/kaiten-http.md`, «Конфигурация»).
   */
  readonly errorName?: string;
  /** Схема аргументов: имена, типы, обязательность, дефолты, описания. */
  readonly argsSchema: z.ZodType<A>;
  /** Как входы записываются в argv; без записи вход читается как флаг. */
  readonly forms?: Readonly<Record<string, InputForm>>;
  readonly resultSchema: z.ZodType<R>;
  /**
   * Исполнение: разобранные аргументы → результат. Не печатает.
   *
   * Порт здесь полный, и это граница сужения: дальше `io` не режется
   * ни в одном месте цепочки вызова — под этим полем лежит любая
   * команда реестра, её реализация заранее неизвестна, и срез значил бы
   * решение за неё, чем она пользуется. Тем же держатся полными все
   * места, которые порт только передают: `Command.invoke`,
   * `Command.invokeInput`, `BareHandler`, `dispatchPath`,
   * `runLeafCommand`, `runCommand`, `runGroup`. Сузить их можно только
   * вместе с этим полем, то есть никак.
   */
  readonly run: (args: A, io: CommandIo) => Promise<R>;
  /** Рендер результата в текст для человека. Чист. */
  readonly render: (result: R, args: A) => string;
  /**
   * Код завершения текстовой формы, когда результат сам сообщает о
   * неуспехе (`mpu xlsx resolve` без пути). Структурный результат
   * отдаётся всегда и с кодом 0 — форма вывода класс команды не меняет.
   */
  readonly textExitCode?: (result: R) => number;
  /**
   * Голый вызов (argv пуст) печатает справку и завершается кодом 2,
   * вместо сообщения схемы о недостающем аргументе. Объявляется
   * командой, а не выводится из схемы: у соседей с обязательным входом
   * текст отказа свой и закреплён их спеками
   * (`specs/portainer-wrappers.md` против `specs/sql-ro.md`).
   */
  readonly helpWhenBare?: boolean;
}

/** Команда в реестре: типы аргументов и результата скрыты внутри. */
export interface Command {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly help: string;
  readonly policy: Policy;
  /** Имя в префиксе ошибок команды (см. объявление). */
  readonly errorName: string;
  /** Пишутся ли секции out/err в журнал вызовов (см. объявление). */
  readonly logsOutput: boolean;
  /** Пишутся ли аргументы в журнал вызовов (см. объявление). */
  readonly logsArguments: boolean;
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
  /** Голый вызов печатает справку и завершается кодом 2. */
  readonly helpWhenBare: boolean;
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
  // Пометка «аргументы в журнал не пишутся» доезжает до разбора argv:
  // иначе сообщения разбора эхо-печатают ввод, и он всё равно попадает
  // в журнал секцией err (`platform/invoke-log.md`, «Инварианты»).
  const masked = spec.logsArguments === false;
  const parse = (argv: readonly string[]): A =>
    parseArgs(
      spec.argsSchema,
      numbersOf(parseArgv(argv, specs, helpHint, { masked }), specs),
      helpHint,
    );
  const parseInput = (input: unknown): A =>
    parseInputObject(spec.argsSchema, onlyKnownInputs(input, specs));

  return {
    path: spec.path,
    summary: spec.summary,
    usage: spec.usage,
    help: spec.help,
    policy: spec.policy,
    errorName: spec.errorName ?? spec.path[0],
    logsOutput: spec.logsOutput ?? true,
    logsArguments: spec.logsArguments ?? true,
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
    helpWhenBare: spec.helpWhenBare ?? false,
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
    kind: kindOf(field.type, field.items),
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

function kindOf(
  type: string | undefined,
  items: string | undefined,
): InputSpec["kind"] {
  if (type === "boolean") return "boolean";
  // Список различается по объявленному типу элемента: у числового
  // элементы приводятся к числу так же, как у одиночного входа. Иначе
  // список чисел объявить схемой нельзя вовсе — из argv он приходит
  // текстом и не проходит собственную же схему.
  if (type === "array") return numeric(items) ? "numbers" : "strings";
  if (numeric(type)) return "number";
  return "string";
}

function numeric(type: string | undefined): boolean {
  return type === "number" || type === "integer";
}

/**
 * Приводит значения числовых входов к числу: из argv всё приходит
 * текстом, а схема публикует объявленный тип
 * (`platform/command-contract.md`, «Ввод/вывод»). Текст, числом не
 * являющийся, остаётся как есть — тогда несоответствие типа назовёт
 * схема, а не команда.
 *
 * Приведению подлежит только десятичная запись: `0x10`, `1e3` и
 * значение в обрамляющих пробелах язык реализации числом считает, а
 * командная строка — не выражение языка, и `--tail 0x10` обязан
 * остаться ошибкой ввода, а не шестнадцатью строками (спека, там же).
 */
function numbersOf(
  raw: Readonly<Record<string, unknown>>,
  specs: readonly InputSpec[],
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...raw };
  for (const spec of specs) {
    const value = out[spec.name];
    if (spec.kind === "number") {
      out[spec.name] = decimal(value) ?? value;
      continue;
    }
    // Элементы числового списка приводятся по одному и тому же правилу:
    // негодный текст остаётся текстом, и тип назовёт схема, а не команда.
    if (spec.kind === "numbers" && Array.isArray(value)) {
      out[spec.name] = value.map((item) => decimal(item) ?? item);
    }
  }
  return out;
}

/** Число из десятичной записи; иное значение — `undefined`. */
function decimal(value: unknown): number | undefined {
  if (typeof value !== "string" || !DECIMAL.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Десятичная запись числа: цифры со знаком и необязательной дробной частью. */
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

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

/**
 * Текстовое чтение stdin поверх байтового порта: форма для команд,
 * которым нужен текст (`specs/xlsx.md`, `specs/kiten-comment.md`).
 * Отдельным портом не объявлено — два источника одного потока разошлись
 * бы (`platform/command-contract.md`, «Ввод/вывод»).
 */
export async function readTextStdin(
  io: Pick<CommandIo, "readStdin">,
): Promise<string> {
  return new TextDecoder().decode(await io.readStdin());
}
