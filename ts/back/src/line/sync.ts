/**
 * Строки `image sync` (`image-sync.md`) и `image export`
 * (`image-export.md`): ведёт их ядро — у него образ, правила и снимок
 * дерева. Разбирает строку обычная цепочка (справка, `messages`, отказы
 * грамматики — деревом), исполнение листа подменено: проверки до вопроса,
 * вопрос двери, предохранитель, применение плана. Чем строки отличаются —
 * решает объект команды (`ImageCommand`).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Command,
  type CommandIo,
  formatCommandError,
  UsageError,
} from "@mpu/command";
import { configValue, IMAGE_DIR, readPreferences } from "@mpu/command/config";
import {
  type Applier,
  BaseMethod,
  conflictEntry,
  type Done,
  type Entry,
  EXPORT_PATH,
  exportArgsSchema,
  Failed,
  type FilesRead,
  type Image,
  ImageError,
  imageExportCommand,
  type ImageMethod,
  imageSyncCommand,
  keyOf,
  MethodAddress,
  type MethodFile,
  Misaddressed,
  type Overflow,
  Plan,
  type Preference,
  readFiles,
  type Receivers,
  SUCCEEDED,
  SYNC_PATH,
  syncArgsSchema,
  Unparsed,
  UnreadableDir,
  WAITING,
  waitingEntry,
} from "@mpu/cmd-image";
import {
  line as lineText,
  type Outcome,
  plainRefusal,
  RefusalNotice,
  type Report,
  ROOT_TEXT,
} from "@mpu/language/objects";
import {
  type Address,
  ASK,
  type Channel,
  EXECUTE,
  PolicyError,
  Rule,
  type RuleBook,
  RulePath,
} from "@mpu/command/policy";
import { atExecution } from "../claudehook/mod.ts";
import { UNNAMED_REFUSAL } from "@mpu/language/messages";
import { programCommands } from "./program.ts";
import {
  type Checking,
  definitionOf,
  drop,
  type ImageContext,
  type ImageLine,
  keep,
  Misdefined,
  NOT_IMAGE,
  type Reach,
  ruled,
} from "./define.ts";
import type { Line } from "./dispatch.ts";
import type { Order } from "./order.ts";
import { registryNodes } from "./tree.ts";
import { ASK_WORD, type View } from "./view.ts";

/** Код отказа до записи: строку набрали не так, каталог вне права. */
const MISWRITTEN = 2;
/** Код сбоя: файл образа, правил или каталог не читается. */
const FAILED = 1;

/** Применитель строки: после плана — снимок дерева, если база изменилась. */
interface Settling extends Applier {
  settled(): Promise<void>;
}

/** Что выбрала набранная строка команды образа. */
interface Chosen {
  /** Набранный `dir:`; не набран — `undefined`. */
  readonly dir: string | undefined;
  /** Адреса `base:`: в конфликте права база. */
  readonly base: readonly string[];
  /** Адреса `files:`: в конфликте права файл. */
  readonly files: readonly string[];
  /** Удаления сверх половины стороны, которые запуск не пропускает. */
  overflows(plan: Plan): readonly Overflow[];
  /**
   * Слова строки, снимающей предохранитель.
   *
   * @param said слова набранной строки без входа двери
   */
  hint(said: readonly string[]): readonly string[];
  /** Кто применяет план запуска — выбирается здесь один раз. */
  applier(dir: string, context: ImageContext): Settling;
}

/** Команда образа, строку которой исполняет ядро. */
interface ImageCommand {
  /** Путь строки и правила. */
  readonly path: readonly string[];
  /**
   * Выбор набранной строки разбором команды реестра.
   *
   * @throws Refused — значение вне схемы (`deletes: yes`)
   */
  chosen(argv: readonly string[]): Chosen;
}

/** Слова, дописываемые в совет: снять предохранитель. */
const DELETES_ALLOW = ["deletes:", "allow"];

/** `image sync`: обе стороны, `dry` — только печать. */
const SYNC: ImageCommand = {
  path: SYNC_PATH,
  chosen: (argv) => {
    const args = parsed(imageSyncCommand, syncArgsSchema, argv);
    return {
      dir: args.dir,
      base: args.base,
      files: args.files,
      overflows: (plan) => (args.deletes === undefined ? plan.overflows() : []),
      hint: (said) => [ASK_WORD, ...said, ...DELETES_ALLOW],
      applier: (dir, context) =>
        args["dry-run"] ? new Printing(context) : new Applying(dir, context),
    };
  },
};

/**
 * `image export`: только база → файлы; базу не удаляет, поэтому её
 * удаления предохранитель не считает. Ключа `deletes:` у неё нет — совет
 * ведёт в `image sync` с набранными ключами.
 */
const EXPORT: ImageCommand = {
  path: EXPORT_PATH,
  chosen: (argv) => {
    const args = parsed(imageExportCommand, exportArgsSchema, argv);
    return {
      dir: args.dir,
      base: [],
      files: [],
      overflows: (plan) => plan.fileOverflows(),
      hint: (said) => [
        ASK_WORD,
        ...SYNC_PATH,
        ...said.slice(EXPORT_PATH.length),
        ...DELETES_ALLOW,
      ],
      applier: (dir, context) => new Exporting(dir, context),
    };
  },
};

/** Строка команды образа по словам без входа двери; иначе — не образ. */
export function syncLineOf(said: readonly string[]): ImageLine {
  const command = [SYNC, EXPORT].find((one) =>
    one.path.every((word, i) => said[i] === word),
  );
  if (command === undefined) return NOT_IMAGE;
  return {
    settle: (context) =>
      context.walk(
        (session, words) => new SyncLine(command, session, words, context),
      ),
    consult: atExecution,
  };
}

/** Получатели метода — команды и группы дерева реестра. */
const RECEIVERS: Receivers = {
  known: (receiver) => {
    const path = receiver.join(" ");
    return registryNodes().some((node) => node.path.join(" ") === path);
  },
  refusal: (receiver) =>
    `${lineText(ROOT_TEXT, [...receiver, "define:"])} ` +
    "метод — только у команды или группы",
};

/** Отказ строки до записи: текст и код уже решены. */
class Refused extends Error {
  override name = "Refused";
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** Сессия строки, у которой исполнение листа — команда образа. */
class SyncLine implements Line {
  readonly #command: ImageCommand;
  readonly #session: Line;
  readonly #words: readonly string[];
  readonly #context: ImageContext;

  constructor(
    command: ImageCommand,
    session: Line,
    words: readonly string[],
    context: ImageContext,
  ) {
    this.#command = command;
    this.#session = session;
    this.#words = words;
    this.#context = context;
  }

  async dispatch(report: Report, view: View, order: Order): Promise<Outcome> {
    const argv = order.argv(view.executed(this.#words));
    const path = this.#command.path;
    return report.exit(await this.#sync(argv.slice(path.length)));
  }

  terminal(): boolean {
    return this.#session.terminal();
  }

  streams(view: View, order: Order): boolean {
    return this.#session.streams(view, order);
  }

  /** Результат — текст: отбора у него нет, строка исполняется как есть. */
  select(report: Report, view: View, order: Order): Promise<Outcome> {
    return this.dispatch(report, view, order);
  }

  listRules(report: Report): Promise<Outcome> {
    return this.#session.listRules(report);
  }

  change(
    report: Report,
    path: RulePath,
    change: Parameters<Line["change"]>[2],
  ): Promise<Outcome> {
    return this.#session.change(report, path, change);
  }

  consent(report: Report, view: View): Promise<Outcome> {
    return this.#session.consent(report, view);
  }

  /** Проверки до вопроса, вопрос, запуск; итог — код. */
  async #sync(argv: readonly string[]): Promise<number> {
    const context = this.#context;
    let run: Run;
    try {
      run = prepared(this.#command, argv, context);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      context.journaled();
      plainRefusal(UNNAMED_REFUSAL, err.message).tell(context.speech);
      return err.code;
    }
    return await ruled(context, this.#command.path, () =>
      executed(run, context),
    );
  }
}

/** Запуск, прошедший проверки до вопроса. */
interface Run {
  readonly chosen: Chosen;
  readonly dir: string;
  readonly plan: Plan;
}

/**
 * Аргументы, каталог и стороны; отказ — `Refused`.
 *
 * @throws Refused — строка набрана не так или каталог вне права
 */
function prepared(
  command: ImageCommand,
  argv: readonly string[],
  context: ImageContext,
): Run {
  const said = lineText(ROOT_TEXT, context.said);
  const chosen = command.chosen(argv);
  const dir = allowedDir(chosen, context.io, said);
  let files: FilesRead;
  let archive: Map<string, string>;
  try {
    files = readFiles(dir, RECEIVERS);
    archive = context.image.archive(dir);
  } catch (err) {
    if (!(err instanceof UnreadableDir || err instanceof ImageError)) {
      throw err;
    }
    throw new Refused(`${said}: ${err.message}`, FAILED);
  }
  const base = context.methods.map((method) => new BaseMethod(method));
  const prefer = preference(chosen, base, files, said);
  return { chosen, dir, plan: new Plan({ base, files, archive }, prefer) };
}

/**
 * Аргументы строки разбором команды реестра: значение вне схемы
 * (`deletes: yes`) — отказ его формой.
 */
function parsed<T>(
  command: Pick<Command, "parseArgs" | "errorName">,
  schema: { parse(input: unknown): T },
  argv: readonly string[],
): T {
  try {
    return schema.parse(command.parseArgs(argv));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    const text = formatCommandError(command.errorName, err);
    throw new Refused(text, MISWRITTEN);
  }
}

/**
 * Каталог образа: `dir:` от `cwd` строки или ключ `image.dir`; только
 * умолчание ключа или под ним (`image-sync.md`, «CLI-контракт»).
 */
function allowedDir(
  chosen: Pick<Chosen, "dir">,
  io: ImageContext["io"],
  said: string,
): string {
  const home = io.env("HOME");
  const root = IMAGE_DIR.fallback(home);
  const set = chosen.dir ?? configuredDir(io) ?? root;
  if (set === undefined || root === undefined) {
    throw new Refused(
      `${said}: каталог образа не задан — нет HOME`,
      MISWRITTEN,
    );
  }
  const dir = resolve(io.cwd(), set);
  if (dir !== root && !dir.startsWith(`${root}/`)) {
    throw new Refused(
      `${said}: нет права записи в ${dir} — каталог образа только под ${root}`,
      MISWRITTEN,
    );
  }
  return dir;
}

/** Значение ключа `image.dir` в кэш-БД строки; нет — `undefined`. */
function configuredDir(io: Pick<CommandIo, "openCacheDb">): string | undefined {
  return readPreferences(io, (db) => configValue(db, IMAGE_DIR.key), undefined);
}

/**
 * Адреса `base:`/`files:`: разбор, одно место, существование.
 *
 * @throws Refused — адрес не адрес, назван дважды или не называет метода
 */
function preference(
  chosen: Pick<Chosen, "base" | "files">,
  base: readonly BaseMethod[],
  files: FilesRead,
  said: string,
): Preference {
  let prefer: Preference;
  try {
    prefer = {
      base: chosen.base.map((word) => MethodAddress.parse(word)),
      files: chosen.files.map((word) => MethodAddress.parse(word)),
    };
  } catch (err) {
    if (!(err instanceof Misaddressed)) throw err;
    throw new Refused(`${said}: ${err.message}`, MISWRITTEN);
  }
  const both = prefer.base.find((one) =>
    prefer.files.some((other) => other.text() === one.text()),
  );
  if (both !== undefined) {
    throw new Refused(
      `${said}: ${both.text()} — и в base:, и в files:`,
      MISWRITTEN,
    );
  }
  const named = [...base.map((one) => one.method.record()), ...files.files];
  const missing = [...prefer.base, ...prefer.files].find(
    (address) => !named.some((one) => address.names(one)),
  );
  if (missing !== undefined) {
    throw new Refused(
      `${said}: нет метода ${missing.text()} ни в базе, ни в файлах`,
      MISWRITTEN,
    );
  }
  return prefer;
}

/** Вид отказа массового удаления (`platform/refusal-object.md`). */
const WOULD_DELETE = "удалилось бы";

/**
 * После «да»: предохранитель массового удаления, затем применение плана
 * применителем, которого выбрала строка.
 */
async function executed(run: Run, context: ImageContext): Promise<number> {
  const [overflow] = run.chosen.overflows(run.plan);
  if (overflow !== undefined) {
    const hint = run.chosen.hint(context.said);
    const said =
      `${lineText(ROOT_TEXT, context.said)}: ${WOULD_DELETE} ` +
      `${overflow.deleted} из ${overflow.of} методов (${overflow.side})`;
    new RefusalNotice({
      reason: WOULD_DELETE,
      said,
      hint: {
        said: () => ` — вызывай ${lineText(ROOT_TEXT, hint)}`,
        words: () => hint,
        reason: (own) => own,
      },
      candidates: [],
    }).tell(context.speech);
    return MISWRITTEN;
  }
  const applier = run.chosen.applier(run.dir, context);
  let report;
  try {
    report = await run.plan.apply(applier);
    await applier.settled();
  } catch (err) {
    // Архив и правила — те же файлы, что у `define:`: их сбой — отказ
    // строки, код 1.
    if (!(err instanceof ImageError || err instanceof PolicyError)) throw err;
    plainRefusal(UNNAMED_REFUSAL, err.message).tell(context.speech);
    return FAILED;
  }
  context.speech.stdout(report.text());
  return report.exit();
}

/**
 * Решение правила пути `links` без второго вопроса: согласие — ответ на
 * вопрос `image sync`; `deny` — сбой с текстом отказа правил.
 */
function consented(
  book: RuleBook,
  channel: Channel,
  links: readonly string[],
  run: () => Done,
): Promise<Done> {
  book.sow([new Rule(RulePath.parse(links.join(" ")), ASK)]);
  const text = lineText(ROOT_TEXT, links);
  return book.decide(links).settle<Done>(
    {
      text,
      run: () => Promise.resolve(run()),
      // Текст отказа правил — `<строка>: запрещено правилом «…»`; строке
      // `сбой` нужна причина без адреса строки.
      refuse: (_reason, said) =>
        Promise.resolve(new Failed(said.slice(`${text}: `.length))),
      redirect: () =>
        Promise.reject(new Error("решение без вопроса не переадресует")),
    },
    channel,
    CONSENTED,
  );
}

/** Адрес без вопроса: `allow` и `ask` исполняются, `deny` — отказ. */
const CONSENTED: Address = {
  onAllow: () => EXECUTE,
  onAsk: () => EXECUTE,
};

/** Метод из файла, прошедший проверки `define:`. */
interface Checked {
  readonly file: MethodFile;
  readonly method: ImageMethod;
  readonly reach: Reach;
}

/**
 * Общее у применителей: проверки `define:` методов из файлов, порядок
 * записи по вызовам и решения правил `<получатель> define:`/`forget:`.
 * Чем кончается прошедший метод — решает применитель (`pass`).
 */
async function defined(
  files: readonly MethodFile[],
  context: ImageContext,
  pass: (checked: Checked) => Done,
): Promise<ReadonlyMap<string, Done>> {
  const done = new Map<string, Done>();
  const checking = checkingFor(files, context);
  const checked = new Map<string, Checked>();
  for (const file of files) {
    try {
      const one = definitionOf(file.words).checked({
        ...checking,
        said: file.words,
      });
      checked.set(file.key, { file, ...one });
    } catch (err) {
      if (!(err instanceof Misdefined)) throw err;
      done.set(file.key, new Unparsed(file.path, err.refused.text()));
    }
  }
  for (const one of calledFirst(checked)) {
    const links = [...one.file.receiver, "define:"];
    done.set(
      one.file.key,
      await consented(context.book, context.channel, links, () => pass(one)),
    );
  }
  return done;
}

/**
 * Проверкам тел — дерево с методами базы и методами этого запуска: тело
 * может звать метод, который появляется тут же.
 */
function checkingFor(
  files: readonly MethodFile[],
  context: ImageContext,
): Checking {
  const sources = new Map(
    context.methods.map((method) => {
      const source = method.source();
      return [keyOf(source.receiver, source.name), source];
    }),
  );
  for (const file of files) {
    sources.set(file.key, {
      receiver: [...file.receiver],
      name: file.name,
      source: [...file.body],
    });
  }
  return { ...context, commands: programCommands([...sources.values()]) };
}

/**
 * Методы по порядку записи: вызываемый методом этого запуска — раньше
 * вызывающего, прочие — по ключу. Итог не зависит от порядка файлов
 * (`image-sync.md`, «Запись стороны базы»).
 */
function calledFirst(checked: ReadonlyMap<string, Checked>): Checked[] {
  const order: Checked[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    const one = checked.get(key);
    if (one === undefined || seen.has(key)) return;
    seen.add(key);
    for (const callee of callsOf(one, checked)) visit(callee);
    order.push(one);
  };
  for (const key of [...checked.keys()].sort()) visit(key);
  return order;
}

/** Ключи методов этого запуска, которые достигает тело метода. */
function callsOf(
  one: Checked,
  checked: ReadonlyMap<string, Checked>,
): string[] {
  const calls: string[] = [];
  one.reach({
    command: (_path, links) => {
      const key = links.join(" ");
      if (checked.has(key)) calls.push(key);
    },
  });
  return calls.sort();
}

/** Причина сбоя файла стороны — сообщение ОС как есть. */
function failed(err: unknown): Done {
  if (!(err instanceof Error)) throw err;
  return new Failed(err.message);
}

/** Сбой записи образа или правил по методу — строка `сбой`. */
function unkept(err: unknown): Done {
  if (!(err instanceof ImageError || err instanceof PolicyError)) throw err;
  return new Failed(err.message);
}

/** Путь файла метода: `<каталог>/<получатель через />/<имя>.mpu`. */
function filePath(dir: string, method: BaseMethod): string {
  const { receiver, name } = method.method.record();
  return `${dir}/${[...receiver, `${name}.mpu`].join("/")}`;
}

/** Применитель, который пишет базу, файлы и архив. */
class Applying implements Settling {
  readonly #dir: string;
  readonly #context: ImageContext;
  readonly #image: Image;
  #wroteBase = false;

  constructor(dir: string, context: ImageContext) {
    this.#dir = dir;
    this.#context = context;
    this.#image = context.image;
  }

  writeFile(method: BaseMethod): Promise<Done> {
    const path = filePath(this.#dir, method);
    try {
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      writeFileSync(path, `${method.method.definition()}\n`);
      return Promise.resolve(SUCCEEDED);
    } catch (err) {
      return Promise.resolve(failed(err));
    }
  }

  removeFile(file: MethodFile): Promise<Done> {
    try {
      rmSync(`${this.#dir}/${file.path}`);
      return Promise.resolve(SUCCEEDED);
    } catch (err) {
      return Promise.resolve(failed(err));
    }
  }

  define(files: readonly MethodFile[]): Promise<ReadonlyMap<string, Done>> {
    return defined(files, this.#context, (one) => {
      try {
        keep(this.#context, one.method, one.reach);
        this.#wroteBase = true;
        return SUCCEEDED;
      } catch (err) {
        return unkept(err);
      }
    });
  }

  forget(method: BaseMethod): Promise<Done> {
    const { receiver } = method.method.record();
    return consented(
      this.#context.book,
      this.#context.channel,
      [...receiver, "forget:"],
      () => {
        try {
          drop(this.#context, method.method);
          this.#wroteBase = true;
          return SUCCEEDED;
        } catch (err) {
          return unkept(err);
        }
      },
    );
  }

  conflict(key: string, address: string): Entry {
    return conflictEntry(key, address);
  }

  archive(key: string, hash: string) {
    this.#image.archived(this.#dir, key, hash);
  }

  unarchive(key: string) {
    this.#image.unarchived(this.#dir, key);
  }

  /** Образ изменился — снимок дерева переписывается один раз. */
  async settled() {
    if (this.#wroteBase) await this.#context.changed();
  }
}

/**
 * Применитель `dry`: те же проверки и решения правил, ничего не пишет —
 * отчёт тот же, что у запуска без `dry`.
 */
class Printing implements Settling {
  readonly #context: ImageContext;

  constructor(context: ImageContext) {
    this.#context = context;
  }

  writeFile(): Promise<Done> {
    return Promise.resolve(SUCCEEDED);
  }

  removeFile(): Promise<Done> {
    return Promise.resolve(SUCCEEDED);
  }

  define(files: readonly MethodFile[]): Promise<ReadonlyMap<string, Done>> {
    return defined(files, this.#context, () => SUCCEEDED);
  }

  forget(method: BaseMethod): Promise<Done> {
    const { receiver } = method.method.record();
    return consented(
      this.#context.book,
      this.#context.channel,
      [...receiver, "forget:"],
      () => SUCCEEDED,
    );
  }

  conflict(key: string, address: string): Entry {
    return conflictEntry(key, address);
  }

  archive() {}

  unarchive() {}

  settled(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Применитель `image export`: пишет файлы и архив по ним, как `Applying`;
 * всё, что меняет базу, — строка `ждёт человека`, без проверок `define:` и
 * без решения правил: ни база, ни правила не меняются.
 */
class Exporting implements Settling {
  readonly #files: Applying;

  constructor(dir: string, context: ImageContext) {
    this.#files = new Applying(dir, context);
  }

  writeFile(method: BaseMethod): Promise<Done> {
    return this.#files.writeFile(method);
  }

  removeFile(file: MethodFile): Promise<Done> {
    return this.#files.removeFile(file);
  }

  define(files: readonly MethodFile[]): Promise<ReadonlyMap<string, Done>> {
    return Promise.resolve(new Map(files.map((file) => [file.key, WAITING])));
  }

  forget(): Promise<Done> {
    return Promise.resolve(WAITING);
  }

  conflict(key: string, address: string): Entry {
    return waitingEntry("конфликт", key, address);
  }

  archive(key: string, hash: string) {
    this.#files.archive(key, hash);
  }

  unarchive(key: string) {
    this.#files.unarchive(key);
  }

  /** База не пишется — снимок дерева прежний. */
  settled(): Promise<void> {
    return Promise.resolve();
  }
}
