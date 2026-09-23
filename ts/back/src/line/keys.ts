/**
 * Каталог ключей команды (`platform/keys-translation.md`): ключи
 * выводятся правилами из входов команды и её короткого объявления
 * (`keys`, `formats`, `retired`). Один источник для разбора, справки,
 * строки прежней диспетчеризации и теста полноты.
 */

import type {
  Command,
  CommandMode,
  InputSpec,
  KeyRename,
} from "../command/mod.ts";
import { GRAMMAR, type KeyKind, type KeyValue } from "../messages/mod.ts";
import {
  type Args,
  atAddress,
  type Call,
  type Help,
  keywordSent,
  type Named,
  Refusal,
  RENAMED,
  type ResultKind,
  type Trace,
  UNDERSTOOD_NOT,
  unknownKey,
} from "../objects/mod.ts";
import type { Order } from "./order.ts";
import { type Chosen, Variant } from "./variants.ts";

/**
 * Словарь ключей: ключ → как назвать его значение в отказе. Ключ вне
 * словаря несёт причину своего имени.
 */
const DICTIONARY: ReadonlyMap<string, string> = new Map([
  ["target", "цель"],
  ["id", "номер"],
  ["text", "текст"],
  ["query", "поиск"],
  ["since", "начало"],
  ["until", "конец"],
  ["limit", "сколько"],
]);

/** Причина имени ключа, оставшегося прежним именем входа. */
const KEPT = "прежнее имя входа";

/**
 * Вариант, названный не именем флага (`platform/variants.md`, таблица):
 * вход → имя варианта.
 */
const VARIANT_NAMES: ReadonlyMap<string, string> = new Map([[
  "dry-run",
  "dry",
]]);

/** Позиционный селектор без объявления — `target:`. */
const SELECTOR = "selector";

/**
 * Конец опций у прежнего разборщика argv: за ним слова — позиционные,
 * даже похожие на флаг. Это его слово, не знак литерала грамматики.
 */
const END_OF_OPTIONS = "--";

/** Строка прежней диспетчеризации, пока она собирается из ключей. */
export interface Argv {
  readonly options: string[];
  readonly positional: string[];
}

/** Значения ключа по порядку: у списка — все, у прочих — одно. */
function valuesOf(value: KeyValue): readonly string[] {
  return Array.isArray(value) ? value : [String(value)];
}

/** Как значение ключа ложится во вход прежней диспетчеризации. */
interface Placement {
  place(value: KeyValue, into: Argv): void;
}

/** Позиционный вход: значения — словами по порядку входов. */
const POSITIONAL: Placement = {
  place: (value, into) => void into.positional.push(...valuesOf(value)),
};

/** Вход-опция: `--вход значение`, у списка — на каждое значение. */
class OptionPlacement implements Placement {
  readonly #flag: string;

  constructor(input: string) {
    this.#flag = `--${input}`;
  }

  place(value: KeyValue, into: Argv) {
    for (const one of valuesOf(value)) into.options.push(this.#flag, one);
  }
}

/** Вход-флаг: ключ-флаг, выставленный в `true`, — слово флага. */
class FlagPlacement implements Placement {
  readonly #flag: string;

  constructor(flag: string) {
    this.#flag = flag;
  }

  place(value: KeyValue, into: Argv) {
    if (value === true) into.options.push(this.#flag);
  }
}

/** Ключ команды: имя, вход, вид, место во входах и причина имени. */
interface KeySpec {
  readonly name: string;
  /** Вход команды, на который ложится ключ. */
  readonly input: string;
  /** Как ключ пишется в строке: `id:` или `--no-comments`. */
  readonly address: string;
  readonly kind: KeyKind;
  readonly required: boolean;
  readonly purpose: string;
  /** Почему имя вне словаря; ключ из словаря — пусто. */
  readonly why: string;
  readonly placement: Placement;
}

/**
 * Прежнее написание входа, которого больше нет (переименованная опция,
 * snake_case): строка с ним — отказ с готовой строкой нового написания.
 */
interface Spelling {
  /** Прежнее имя, как ключ в строке. */
  readonly old: string;
  readonly kind: KeyKind;
  refusal(value: KeyValue, pairs: readonly string[]): Refusal;
}

/** Вход команды в новой записи: его адрес, ключи, варианты и написания. */
interface Entry {
  readonly input: string;
  /**
   * Как вход пишется теперь: ключ, вариант, формат результата или снятый
   * вход.
   */
  readonly address: string;
  readonly specs: readonly KeySpec[];
  readonly variants: readonly Variant[];
  readonly spellings: readonly Spelling[];
}

/**
 * Отказ с готовой строкой: `причина: <адрес> <слова>`.
 *
 * @param said причина в тексте
 * @param reason вид отказа; по умолчанию — сама причина, если она
 *   постоянна
 */
export function hinted(
  said: string,
  words: readonly string[],
  reason: string = said,
): Refusal {
  return new Refusal(said, {
    reason,
    remedy: atAddress(": ", () => words),
  });
}

/** Отказ: формат набран флагом — с готовой строкой через закрытие. */
export function formatAsFlag(
  format: string,
  pairs: readonly string[],
): Refusal {
  return hinted("формат — сообщение результату", [
    ...pairs,
    GRAMMAR.close,
    format,
  ]);
}

/** Как ключ набирают в строке: значение — `ключ: значение`, флаг — `--ключ`. */
function written(spec: KeySpec, value: KeyValue): string[] {
  if (spec.kind === "flag") return value === true ? [`--${spec.name}`] : [];
  return valuesOf(value).flatMap((one) => [`${spec.name}:`, one]);
}

/** Прежнее имя переименованной опции: значение — под новым ключом. */
class Renamed implements Spelling {
  readonly old: string;
  readonly kind: KeyKind;
  readonly #spec: KeySpec;

  constructor(old: string, spec: KeySpec) {
    this.old = old;
    this.kind = spec.kind;
    this.#spec = spec;
  }

  refusal(value: KeyValue, pairs: readonly string[]): Refusal {
    // Словарный ключ назван смыслом (`текст — ключом`), прочий — именем.
    const label = DICTIONARY.get(this.#spec.name);
    const said = label === undefined
      ? `--${this.old} — теперь ключ ${this.#spec.name}`
      : `${label} — ключом`;
    return hinted(said, [...pairs, ...written(this.#spec, value)], RENAMED);
  }
}

/**
 * Прежний флаг поведения (`--dry-run`): теперь вариант — словом до ключей.
 * Прежние ключи строки остаются за ним.
 */
class AsVariant implements Spelling {
  readonly old: string;
  readonly kind: KeyKind = "flag";
  readonly #name: string;

  constructor(old: string, name: string) {
    this.old = old;
    this.#name = name;
  }

  refusal(_value: KeyValue, pairs: readonly string[]): Refusal {
    return beforeKeys(this.#name, pairs);
  }
}

/**
 * Прежний выбор значением (`--via portainer`): значение — имя варианта.
 * Значения, которого нет среди вариантов, — отказ со списком.
 */
class AsChoice implements Spelling {
  readonly old: string;
  readonly kind: KeyKind = "value";
  readonly #names: readonly string[];

  constructor(old: string, names: readonly string[]) {
    this.old = old;
    this.#names = names;
  }

  refusal(value: KeyValue, pairs: readonly string[]): Refusal {
    const name = String(value);
    if (this.#names.includes(name)) return beforeKeys(name, pairs);
    return new Refusal(
      `варианта ${name} нет; есть: ${this.#names.join(", ")}`,
    );
  }
}

/** Отказ: вариант набран флагом — словом до ключей, ключи за ним. */
function beforeKeys(name: string, pairs: readonly string[]): Refusal {
  return hinted("вариант — словом до ключей", [name, ...pairs]);
}

/** Написание через подчёркивание: только через дефис. */
class Snake implements Spelling {
  readonly old: string;
  readonly kind: KeyKind;
  readonly #dashed: string;

  constructor(old: string, kind: KeyKind, dashed: string) {
    this.old = old;
    this.kind = kind;
    this.#dashed = dashed;
  }

  refusal(value: KeyValue, pairs: readonly string[]): Refusal {
    const flag = `--${this.#dashed}`;
    const words = this.kind === "flag"
      ? [flag]
      : valuesOf(value).flatMap((one) => [flag, one]);
    return hinted("ключ через дефис", [...pairs, ...words]);
  }
}

/**
 * Остаток склеенного ключевого сообщения, который получает результат.
 * Проверяется до исполнения: результат его не понимает — отказ.
 */
export interface Rest {
  check(formats: readonly string[]): void;
  /**
   * Вызов ключевого сообщения команды `call` с этим остатком: остаток,
   * понятый отбором, `forward` отдаёт результату.
   */
  after(call: Call, forward: (rest: Named) => Call): Call;
}

/** Остатка нет. */
export const NO_REST: Rest = { check() {}, after: (call) => call };

/** Что строке известно о результате команды и о своём вводе. */
export interface ResultSide {
  /** Понимает ли результат ключевое сообщение `selector` отбором. */
  selects(selector: string): boolean;
  /** stdin строки — терминал: ключ ввода команда спросит сама. */
  readonly terminal: boolean;
}

/**
 * Остаток, понятый отбором результата: ключевое сообщение команды, затем
 * — он же сообщением результату.
 */
class ToResult implements Rest {
  readonly #args: Args;

  constructor(args: Args) {
    this.#args = args;
  }

  check() {}

  after(call: Call, forward: (rest: Named) => Call): Call {
    return new SplitCall(call, () => forward(keywordSent(this.#args)));
  }
}

/** Ключевое сообщение команды и следом остаток результату — один шаг. */
class SplitCall implements Call {
  readonly #head: Call;
  readonly #rest: () => Call;
  #made: Call | undefined;

  constructor(head: Call, rest: () => Call) {
    this.#head = head;
    this.#rest = rest;
  }

  trace(trail: Trace) {
    this.#head.trace(trail);
    this.#tail().trace(trail);
  }

  result(): ResultKind {
    return this.#tail().result();
  }

  help(trail: Trace): Help {
    return this.#tail().help(trail);
  }

  perform() {
    return this.#tail().perform();
  }

  /** Остаток строится один раз: его источник — одно исполнение. */
  #tail(): Call {
    this.#made ??= this.#rest();
    return this.#made;
  }
}

/**
 * Остаток — ключевое сообщение: виды результата команд понимают только
 * форматы, поэтому он отказывает, называя понятую часть и форматы.
 */
class Leftover implements Rest {
  readonly #understood: string;
  readonly #selector: string;

  constructor(understood: string, selector: string) {
    this.#understood = understood;
    this.#selector = selector;
  }

  check(formats: readonly string[]): never {
    throw new Refusal(
      `понимаю ${this.#understood}; ${this.#selector} результат не ` +
        `понимает; есть: ${formats.join(", ")}`,
    );
  }

  after(call: Call): Call {
    return call;
  }
}

/** Ключевое сообщение, принятое командой: её ключи и остаток. */
export interface Accepted {
  readonly args: Args;
  /** Текст понятой части — звено адреса. */
  readonly text: string;
  /** Понятая часть словами, как её набрали. */
  readonly pairs: readonly string[];
  readonly rest: Rest;
}

/** Вход — формат результата: его пишет объявление `formats`. */
function formatInputs(
  command: Command,
  formats: readonly string[],
): ReadonlySet<string> {
  const flags = Object.values(command.formats)
    .flat()
    .filter((word) => word.startsWith("--"))
    .map((word) => word.slice(2));
  return new Set([...formats, ...flags]);
}

/** Ключ из объявления: вход и причина имени. */
function renameOf(declared: string | KeyRename): KeyRename {
  return typeof declared === "string" ? { input: declared, why: "" } : declared;
}

/** Ключи команды, выведенные из её объявления. */
export class Keys {
  readonly #path: readonly string[];
  readonly #specs: readonly KeySpec[];
  readonly #variants: readonly Variant[];
  readonly #entries: readonly Entry[];
  readonly #spellings: ReadonlyMap<string, Spelling>;
  /** Ключи, которые ложатся позиционно, — по порядку входов. */
  readonly #ordered: readonly string[];
  readonly #formats: ReadonlySet<string>;
  /** Имена форматов результата — без входов, которыми их выбирали. */
  readonly #formatNames: ReadonlySet<string>;
  readonly #retired: Readonly<Record<string, string>>;
  readonly #shorts: ReadonlyMap<string, KeySpec>;
  /** Короткие флаги вариантов (`-n` → `dry`). */
  readonly #variantShorts: ReadonlyMap<string, Variant>;
  /** Режимы команды: прежняя запись каждого — отказ с новой. */
  readonly #modes: ReadonlyMap<string, CommandMode>;
  /** Входы, значения которых задаёт режим; вне режима — нет. */
  readonly #fixed: Readonly<Record<string, string>>;
  readonly #inputs: readonly InputSpec[];
  /** Вход, который команда при терминале читает сама. */
  readonly #terminal: string | undefined;
  readonly #layout: Layout;

  /**
   * @param command команда реестра
   * @param formats имена форматов её результата, `json` в их числе
   * @param mode режим, чьи ключи берёт каталог; нет — вся команда
   * @param layout раскладка строки прежней диспетчеризации
   */
  constructor(
    command: Command,
    formats: readonly string[],
    mode: CommandMode = WHOLE_COMMAND,
    layout: Layout = BY_PATH,
  ) {
    this.#layout = layout;
    this.#path = command.path;
    this.#modes = new Map(Object.entries(command.modes));
    this.#fixed = mode.fixed;
    this.#terminal = command.terminalInput;
    this.#inputs = command.inputs;
    this.#formats = formatInputs(command, formats);
    this.#formatNames = new Set(formats);
    this.#retired = command.retired;
    // Режим объявляет свои ключи сам и берёт только их входы.
    const declared = new Map(
      Object.entries(mode === WHOLE_COMMAND ? command.keys ?? {} : mode.keys)
        .map(([key, value]) => {
          const rename = renameOf(value);
          return [rename.input, { key, why: rename.why }] as const;
        }),
    );
    const names = new Set(command.inputs.map((input) => input.name));
    const inputs = mode === WHOLE_COMMAND
      ? command.inputs
      : command.inputs.filter((input) => declared.has(input.name));
    this.#entries = inputs.map((input) =>
      this.#entryOf(command, input, declared.get(input.name), names)
    );
    this.#specs = this.#entries.flatMap((entry) => entry.specs);
    this.#variants = this.#entries.flatMap((entry) => entry.variants);
    // Прежнее имя, ставшее ключом другого входа (`move-client --target`
    // при `target:`), — ключ: написанием его не прочесть.
    const current = new Set(this.#specs.map((spec) => spec.name));
    this.#spellings = new Map(
      this.#entries.flatMap((entry) => entry.spellings)
        .filter((spelling) => !current.has(spelling.old))
        .map((spelling) => [spelling.old, spelling]),
    );
    this.#ordered = this.#specs
      .filter((spec) => spec.placement === POSITIONAL)
      .map((spec) => spec.name);
    this.#shorts = new Map(
      command.inputs.flatMap((input) => {
        const spec = this.#specs.find((one) => one.input === input.name);
        const short = input.form.short;
        return short === undefined || spec === undefined
          ? []
          : [[`-${short}`, spec] as const];
      }),
    );
    this.#variantShorts = new Map(
      command.inputs.flatMap((input) => {
        const variant = this.#variants.find((one) => one.input === input.name);
        const short = input.form.short;
        return short === undefined || variant === undefined
          ? []
          : [[`-${short}`, variant] as const];
      }),
    );
  }

  /** Где вход в новой записи — решается здесь, один раз на вход. */
  #entryOf(
    command: Command,
    input: InputSpec,
    declared: { readonly key: string; readonly why: string } | undefined,
    names: ReadonlySet<string>,
  ): Entry {
    const name = input.name;
    const none = { specs: [], variants: [], spellings: [] };
    if (this.#formats.has(name)) {
      return { input: name, address: `формат ${name}`, ...none };
    }
    const replacement = this.#retired[name];
    if (replacement !== undefined) {
      return { input: name, address: `снят: ${replacement}:`, ...none };
    }
    const dashed = name.replaceAll("_", "-");
    if (dashed !== name && names.has(dashed)) {
      const kind = kindOf(input);
      const spelling = new Snake(name, kind, dashed);
      return {
        input: name,
        address: `написание → --${dashed}`,
        specs: [],
        variants: [],
        spellings: [spelling],
      };
    }
    const choices = choicesOf(command, name);
    if (choices.length > 0) return choiceEntry(command, input, choices);
    if (switches(command, input)) return switchEntry(command, input, names);
    const owner = modeOwning(command, input, declared);
    if (owner !== undefined) {
      return { input: name, address: owner, ...none };
    }
    const spec = this.#specOf(command, input, declared, dashed);
    const spellings: Spelling[] = [];
    // Подчёркивание вместо дефиса — прежнее написание, даже если такого
    // входа не было (`process --spreadsheet_id`): отказ с готовой строкой.
    const snake = dashed.replaceAll("-", "_");
    const positional = input.form.positional !== undefined;
    if (!positional && snake !== dashed && !names.has(snake)) {
      spellings.push(new Snake(snake, spec.kind, dashed));
    }
    if (dashed !== name) spellings.push(new Snake(name, spec.kind, dashed));
    const renamed = input.form.positional === undefined &&
      spec.name !== dashed &&
      !spec.name.startsWith("no-");
    if (renamed) spellings.push(new Renamed(dashed, spec));
    return {
      input: name,
      address: spec.address,
      specs: [spec],
      variants: [],
      spellings,
    };
  }

  #specOf(
    command: Command,
    input: InputSpec,
    declared: { readonly key: string; readonly why: string } | undefined,
    dashed: string,
  ): KeySpec {
    const field = command.argsJsonSchema.properties[input.name];
    const required = command.requiredInputNames.includes(input.name);
    const purpose = field.description ?? "";
    const kind = kindOf(input);
    const positional = input.form.positional !== undefined;
    const name = keyName(command, input, declared, dashed, field.default);
    const why = reasonOf(command, name, dashed, declared);
    const address = kind === "flag" ? `--${name}` : `${name}:`;
    const placement = positional
      ? POSITIONAL
      : kind === "flag"
      ? new FlagPlacement(`--${name}`)
      : new OptionPlacement(input.name);
    return {
      name,
      input: input.name,
      address,
      kind,
      required,
      purpose,
      why,
      placement,
    };
  }

  /**
   * Адрес каждого входа команды в новой записи: ключ, формат результата
   * или снятый вход — для теста полноты (`platform/keys-translation.md`).
   */
  addresses(): ReadonlyMap<string, string> {
    return new Map(this.#entries.map((entry) => [entry.input, entry.address]));
  }

  /** Варианты команды по порядку входов. */
  variants(): readonly Variant[] {
    return [...this.#variants];
  }

  /** Ключи с причинами имён: ключ из словаря — с пустой причиной. */
  reasons(): ReadonlyMap<string, string> {
    return new Map(this.#specs.map((spec) => [spec.name, spec.why]));
  }

  /** Ключевой метод для разбора и справки. */
  describe() {
    return {
      keys: Object.fromEntries(
        this.#specs.map((spec) => [spec.name, spec.kind]),
      ),
      required: this.#specs.filter((spec) => spec.required).map((spec) =>
        spec.name
      ),
      purposes: Object.fromEntries(
        this.#specs.map((spec) => [spec.name, spec.purpose]),
      ),
      reasons: Object.fromEntries(
        this.#specs.map((spec) => [spec.name, spec.why]),
      ),
      prompts: this.#specs.filter((spec) => spec.input === this.#terminal)
        .map((spec) => spec.name),
    };
  }

  /**
   * Слова, которые разбор читает флагом без значения, хотя ключа у них
   * нет: форматы и прежние написания флагов — чтобы дойти до отказа.
   */
  flagWords(formats: readonly string[]): string[] {
    const spelled = [...this.#spellings.values()]
      .filter((spelling) => spelling.kind === "flag")
      .map((spelling) => spelling.old);
    return [...formats, ...spelled];
  }

  /**
   * Ключи строки, в которой ключевого сообщения нет: пусто, если
   * обязательных ключей у команды нет; иначе — отказ недостающему.
   */
  none(): Args {
    const absent = this.missing({});
    if (absent !== undefined) {
      throw new Refusal(`не хватает ключа ${absent}`);
    }
    return {};
  }

  /** Первый обязательный ключ, которого нет, по алфавиту — как у разбора. */
  missing(args: Args): string | undefined {
    return this.#specs
      .filter((spec) => spec.required && !(spec.name in args))
      .map((spec) => spec.name)
      .sort()[0];
  }

  /**
   * Ключевое, которого команда не понимает вовсе, уходит результату
   * (`platform/collection-protocol.md`): если обязательных ключей у
   * команды нет, а результат его понимает (`kiten ls where: … is: …`).
   *
   * @param result понимает ли результат селектор
   */
  toResult(named: Named, result: Pick<ResultSide, "selects">): boolean {
    const keys = Object.keys(named.args());
    return !keys.some((key) => this.#known(key)) &&
      this.missing({}) === undefined && result.selects(named.selector());
  }

  /**
   * Ключи сообщения проверены до исполнения: формат флагом, снятый вход,
   * прежнее написание — отказ с готовой строкой. Чужой ключ за целым
   * сообщением этой команды начинает остаток — его получает результат.
   */
  accept(named: Named, result: ResultSide): Accepted {
    const entries = Object.entries(named.args());
    const kept = entries.filter(([key]) => this.#known(key));
    const pairs = kept.flatMap(([key, value]) =>
      written(this.#spec(key), value)
    );
    for (const [at, [key, value]] of entries.entries()) {
      if (this.#formats.has(key)) {
        // `--out group` выбирал формат значением: формат — `group`.
        const format = this.#formatNames.has(key) ? key : String(value);
        throw formatAsFlag(format, pairs);
      }
      const replacement = this.#retired[key];
      if (replacement !== undefined) {
        throw new Refusal(
          `--${key} снят — цель одна: ${replacement}: ${value}`,
        );
      }
      const spelling = this.#spellings.get(key);
      if (spelling !== undefined) throw spelling.refusal(value, pairs);
      if (!this.#known(key)) return this.#split(named, entries, at, result);
    }
    // Недостающий обязательный ключ называет раньше разбор: этот набор
    // ключей ему известен целиком.
    return {
      args: named.args(),
      text: this.#text(entries),
      pairs: this.#words(entries),
      rest: NO_REST,
    };
  }

  /** Ключи строкой, как их пишут: флаг — `--имя`, список — ключ на значение. */
  #text(entries: readonly (readonly [string, KeyValue])[]): string {
    return this.#words(entries).join(" ");
  }

  #words(entries: readonly (readonly [string, KeyValue])[]): string[] {
    return entries.flatMap(([key, value]) => written(this.#spec(key), value));
  }

  #known(key: string): boolean {
    return this.#specs.some((spec) => spec.name === key);
  }

  #spec(key: string): KeySpec {
    const spec = this.#specs.find((one) => one.name === key);
    if (spec === undefined) throw new TypeError(`ключа ${key} нет`);
    return spec;
  }

  /** Понятая часть — команде, с ключа `at` — остаток результату. */
  #split(
    named: Named,
    entries: readonly (readonly [string, KeyValue])[],
    at: number,
    result: ResultSide,
  ): Accepted {
    const understood = entries.slice(0, at);
    const args = Object.fromEntries(understood);
    if (at === 0) {
      const names = this.#specs.map((spec) => spec.name);
      const said = `не понимает ${named.selector()}`;
      throw unknownKey(said, entries[0][0], names);
    }
    const rest = entries.slice(at);
    if (result.selects(keywordSent(Object.fromEntries(rest)).selector())) {
      const absent = this.missing(args) ?? this.#asked(args, result.terminal);
      if (absent !== undefined) {
        throw new Refusal(`не хватает ключа ${absent}`);
      }
      const text = this.#text(understood);
      const pairs = this.#words(understood);
      const tail = new ToResult(Object.fromEntries(rest));
      return { args, text, pairs, rest: tail };
    }
    if (this.missing(args) !== undefined) {
      throw new Refusal(`не понимает ${named.selector()}`, UNDERSTOOD_NOT);
    }
    return this.#leftover(args, understood, rest);
  }

  /**
   * Ключ, который команда при терминале спросила бы сама (`sql`): его нет
   * в `args`, а stdin — терминал. Из пайпа команда прочтёт его сама.
   */
  #asked(args: Args, terminal: boolean): string | undefined {
    if (!terminal) return undefined;
    const spec = this.#specs.find((one) => one.input === this.#terminal);
    if (spec === undefined || spec.name in args) return undefined;
    return spec.name;
  }

  /** Остаток, которого результат не понимает: отказ при исполнении. */
  #leftover(
    args: Args,
    understood: readonly (readonly [string, KeyValue])[],
    rest: readonly (readonly [string, KeyValue])[],
  ): Accepted {
    const text = this.#text(understood);
    const selector = (part: typeof rest) =>
      part.map(([key]) => `${key}:`).join("");
    return {
      args,
      text,
      pairs: this.#words(understood),
      rest: new Leftover(selector(understood), selector(rest)),
    };
  }

  /** Отказ голым значениям: слова — ключам по порядку входов. */
  bare(words: readonly string[]): Refusal {
    // Короткий флаг первым словом — не значение: хвост ловит его голым.
    const short = this.short(words[0], words.slice(1));
    if (short !== undefined) return hinted(short.reason, short.spelled([]));
    const positionals = this.#inputs
      .filter((input) => input.form.positional !== undefined)
      .map((input) => input.name);
    for (const [name, mode] of this.#modes) {
      const hint = modeHint(name, mode, positionals, words);
      if (hint !== undefined) return hint;
    }
    // Голые слова — позиционным ключам по порядку, затем тексту.
    const text = this.#specs
      .filter((spec) => spec.name === "text" && spec.placement !== POSITIONAL)
      .map((spec) => spec.name);
    const keys = [...this.#ordered, ...text];
    // `--` прежней записи (`ssh sl-1 -- ls`) конец опций, а не значение.
    const values = words.filter((word) => word !== END_OF_OPTIONS);
    // Ключа, который слово могло бы занять, нет, или слово — имя варианта:
    // «значение — ключом» подсказало бы строку, которой никто не хотел.
    const [first] = values;
    const noKey = keys.length === 0;
    const variant = this.#variants.some((one) => one.name === first);
    if (first !== undefined && (noKey || variant)) {
      return new Refusal(`лишнее слово ${first}`);
    }
    return hinted("значение — ключом", this.#pairs(keys, values));
  }

  /**
   * Голые слова по ключам: лишние слова достаются последнему ключу, если
   * он список, — повтором (`range: A1 range: B2`), а у чужого хвоста —
   * одним значением (`cmd: "ls -la"`).
   */
  #pairs(keys: readonly string[], words: readonly string[]): string[] {
    const head = words.slice(0, keys.length);
    const extra = words.slice(keys.length);
    const pairs = head.flatMap((word, i) => [`${keys[i]}:`, word]);
    const last = keys.at(-1);
    if (last === undefined || extra.length === 0) return pairs;
    const spec = this.#spec(last);
    if (spec.kind !== "list") return pairs;
    const input = this.#inputs.find((one) => one.name === spec.input);
    if (input?.form.keepsUnknown !== true) {
      return [...pairs, ...extra.flatMap((word) => [`${last}:`, word])];
    }
    const joined = [...head.slice(-1), ...extra].join(" ");
    return [...pairs.slice(0, -1), joined];
  }

  /**
   * Подсказка к короткому флагу за значением: переименованный вход —
   * «ключом», прочий — «полным именем»; флаг чужой — нет подсказки.
   */
  short(word: string, after: readonly string[]): ShortHint | undefined {
    const variant = this.#variantShorts.get(word);
    if (variant !== undefined) {
      return {
        reason: "вариант — словом до ключей",
        spelled: (taken) => [variant.name, ...taken],
      };
    }
    const spec = this.#shorts.get(word);
    if (spec === undefined) return undefined;
    const value = spec.kind === "flag" ? true : after[0] ?? "";
    if (DICTIONARY.has(spec.name) && spec.placement !== POSITIONAL) {
      const label = DICTIONARY.get(spec.name);
      const words = written(spec, value);
      return {
        reason: `${label} — ключом`,
        spelled: (taken) => [...taken, ...words],
      };
    }
    const flag = `--${spec.name}`;
    const words = spec.kind === "flag" ? [flag] : [flag, String(value)];
    return {
      reason: "флаг — полным именем",
      spelled: (taken) => [...taken, ...words],
    };
  }

  /**
   * Строка прежней диспетчеризации: опции — ключи и выбранные варианты,
   * затем `--` и позиционные.
   */
  order(args: Args, chosen: Chosen): Order {
    const into: Argv = { options: [], positional: [] };
    for (const input of this.#inputs) {
      const fixed = this.#fixed[input.name];
      if (fixed !== undefined) placementOf(input).place(fixed, into);
      const spec = this.#specs.find((one) => one.input === input.name);
      const value = spec === undefined ? undefined : args[spec.name];
      if (spec !== undefined && value !== undefined) {
        spec.placement.place(value, into);
      }
    }
    chosen.place(into.options);
    const argv = this.#layout.argv(this.#path, into);
    return { argv: () => argv };
  }
}

/**
 * Раскладка строки прежней диспетчеризации: где путь команды, опции и
 * позиционные. Её знает группа реестра (`layout`).
 */
export interface Layout {
  argv(path: readonly string[], into: Argv): string[];
}

/** Путь, опции, затем `--` и позиционные. */
export const BY_PATH: Layout = {
  argv: (path, into) => [
    ...path,
    ...into.options,
    END_OF_OPTIONS,
    ...into.positional,
  ],
};

/**
 * Селектор перед подкомандой (`ozon-jobs sl-2 show`): имя подкоманды —
 * за позиционными, прежний разбор находит его там с пропуском.
 */
export const SELECTOR_AHEAD: Layout = {
  argv: (path, into) => [
    ...path.slice(0, -1),
    ...into.options,
    END_OF_OPTIONS,
    ...into.positional,
    ...path.slice(-1),
  ],
};

/** Вся команда, а не режим: ключи — все, заданных входов нет. */
const WHOLE_COMMAND: CommandMode = {
  purpose: "",
  label: "",
  fixed: {},
  keys: {},
};

/**
 * Режим, набранный прежней записью (`logs ls`, `logs sl-1 ls`,
 * `move-client-back rm 1234`): голые слова ложатся на позиционные входы по
 * порядку, как у прежнего разбора; совпали заданные режимом — отказ с
 * готовой строкой нового. Не та запись — нет подсказки.
 */
function modeHint(
  name: string,
  mode: CommandMode,
  positionals: readonly string[],
  words: readonly string[],
): Refusal | undefined {
  if (words.length > positionals.length) return undefined;
  const given = new Map(words.map((word, i) => [positionals[i], word]));
  const inputs = new Map(
    Object.entries(mode.keys).map(([key, input]) => [input, key]),
  );
  const pairs: string[] = [];
  for (const [input, word] of given) {
    if (mode.fixed[input] === word) continue;
    const key = inputs.get(input);
    if (key === undefined) return undefined;
    pairs.push(`${key}:`, word);
  }
  const all = Object.keys(mode.fixed).every((input) => given.has(input));
  return all
    ? hinted(`${mode.label} — сообщением`, [name, ...pairs])
    : undefined;
}

/**
 * Позиционный вход, ключ которому даёт только режим (`move-client-back`
 * `rm target:`): у всей команды его адрес — сообщение режима.
 */
function modeOwning(
  command: Command,
  input: InputSpec,
  declared: { readonly key: string } | undefined,
): string | undefined {
  if (declared !== undefined || input.name === SELECTOR) return undefined;
  if (input.form.positional === undefined) return undefined;
  for (const [name, mode] of Object.entries(command.modes)) {
    for (const [key, owned] of Object.entries(mode.keys)) {
      if (owned === input.name) return `${name} ${key}:`;
    }
  }
  return undefined;
}

/** Куда ложится значение, заданное режимом: позиционно или опцией. */
function placementOf(input: InputSpec): Placement {
  return input.form.positional === undefined
    ? new OptionPlacement(input.name)
    : POSITIONAL;
}

/** Подсказка к короткому флагу: причина и слова нового написания. */
export interface ShortHint {
  readonly reason: string;
  /** Новое написание вокруг слов `taken`, набранных до флага. */
  spelled(taken: readonly string[]): readonly string[];
}

/** Выборы-варианты входа `input`: имена по порядку объявления. */
function choicesOf(command: Command, input: string): string[] {
  return Object.entries(command.choices)
    .filter(([, choice]) => choice.input === input)
    .map(([name]) => name);
}

/** Вход-выбор: вариант на каждое объявленное значение. */
function choiceEntry(
  command: Command,
  input: InputSpec,
  names: readonly string[],
): Entry {
  const variants = names.map((name) =>
    new Variant(name, command.choices[name].purpose, input.name, [
      `--${input.name}`,
      name,
    ])
  );
  return {
    input: input.name,
    address: `варианты ${names.join(", ")}`,
    specs: [],
    variants,
    spellings: [new AsChoice(input.name.replaceAll("_", "-"), names)],
  };
}

/**
 * Булев вход с умолчанием меняет поведение — это вариант
 * (`platform/variants.md`); без умолчания у него три состояния, и он
 * передаёт значение (`is-active`) — ключ.
 */
function switches(command: Command, input: InputSpec): boolean {
  if (input.kind !== "boolean" || input.form.positional !== undefined) {
    return false;
  }
  return command.argsJsonSchema.properties[input.name].default !== undefined;
}

/**
 * Вариант булева входа: имя — флаг без `--` (`--no-<вход>` у входа с
 * умолчанием `true`), кроме названных таблицей спеки (`dry-run` → `dry`).
 * Прежний флаг и его написание через подчёркивание — отказы.
 */
function switchEntry(
  command: Command,
  input: InputSpec,
  names: ReadonlySet<string>,
): Entry {
  const field = command.argsJsonSchema.properties[input.name];
  const dashed = input.name.replaceAll("_", "-");
  const flag = field.default === true ? `no-${dashed}` : dashed;
  const name = VARIANT_NAMES.get(flag) ?? flag;
  const variant = new Variant(name, field.description ?? "", input.name, [
    `--${flag}`,
  ]);
  const olds = new Set([flag, flag.replaceAll("-", "_"), input.name]);
  const spellings = [...olds]
    .filter((old) => old === flag || !names.has(old))
    .map((old) => new AsVariant(old, name));
  return {
    input: input.name,
    address: `вариант ${name}`,
    specs: [],
    variants: [variant],
    spellings,
  };
}

/** Вид ключа по виду входа. */
function kindOf(input: InputSpec): KeyKind {
  if (input.kind === "boolean") return "flag";
  if (input.kind === "strings" || input.kind === "numbers") return "list";
  if (input.form.positional === "rest") return "list";
  return "value";
}

/**
 * Имя ключа входа: объявленное; у позиционного селектора — `target`;
 * у булева с умолчанием `true` — `no-<имя>`; иначе имя входа через дефис.
 * Позиционный вход без объявления — дефект объявления.
 */
function keyName(
  command: Command,
  input: InputSpec,
  declared: { readonly key: string } | undefined,
  dashed: string,
  fallback: unknown,
): string {
  if (declared !== undefined) return declared.key;
  if (input.form.positional !== undefined) {
    if (input.name === SELECTOR) return "target";
    throw new TypeError(
      `${command.path.join(" ")}: позиционный вход ${input.name} без ключа`,
    );
  }
  if (input.kind === "boolean" && fallback === true) return `no-${dashed}`;
  return dashed;
}

/**
 * Причина имени ключа: из словаря — нет; прежнее имя входа — правилом;
 * переименованный вне словаря — объявленная, без неё — дефект объявления.
 */
function reasonOf(
  command: Command,
  name: string,
  dashed: string,
  declared: { readonly why: string } | undefined,
): string {
  if (DICTIONARY.has(name)) return "";
  if (name === dashed || name === `no-${dashed}`) return KEPT;
  const why = declared?.why ?? "";
  if (why !== "") return why;
  throw new TypeError(
    `${command.path.join(" ")}: ключ ${name} вне словаря без причины`,
  );
}
