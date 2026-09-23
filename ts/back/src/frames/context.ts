/**
 * Контекст вызова (`platform/call-context.md`): что клиент подал на
 * вход, какой у него терминал и какие переменные он принёс. Три вещи
 * независимы, и каждая — объект: строка спрашивает их, а не разбирает
 * поля кадра заново у каждого потребителя.
 *
 * Поля первого кадра — данные границы, и разбираются здесь же; дальше
 * идёт только объект. Тем же модулем пользуется тонкий клиент
 * (`ts/cli/`): список принимаемых имён и предел ввода у обеих сторон
 * один.
 */

import { BadFrame } from "./bad.ts";
import { isRecord } from "./json.ts";

/**
 * Ввод строки: значение, а не поток с позицией. Откуда оно берётся —
 * пусто, пришло кадром или запрашивается у клиента
 * (`platform/stdin-on-request.md`), — дело реализации.
 */
export interface LineInput {
  /** Весь ввод байтами; повторный вызов даёт то же содержимое. */
  bytes(): Promise<Uint8Array>;
}

/** Ввода нет: чтение `-` даёт пустое значение, конец сразу. */
export const NO_INPUT: LineInput = {
  bytes: () => Promise.resolve(new Uint8Array()),
};

/** Ввод, пришедший кадром: копия на каждое чтение — буфер общий. */
function givenInput(bytes: Uint8Array): LineInput {
  return { bytes: () => Promise.resolve(bytes.slice()) };
}

/** Терминальность потоков клиента и ширина его консоли. */
export interface Terminals {
  stdin(): boolean;
  stdout(): boolean;
  stderr(): boolean;
  /** Ширина консоли; её нет — `undefined` (вывод без ограничения). */
  columns(): number | undefined;
}

/** Терминала у клиента нет: три потока в канале, ширины нет. */
export const NOT_TERMINALS: Terminals = {
  stdin: () => false,
  stdout: () => false,
  stderr: () => false,
  columns: () => undefined,
};

/** Терминальность, снятая клиентом. */
class ClientTerminals implements Terminals {
  readonly #stdin: boolean;
  readonly #stdout: boolean;
  readonly #stderr: boolean;
  readonly #columns: number | undefined;

  constructor(
    flags: { stdin: boolean; stdout: boolean; stderr: boolean },
    columns: number | undefined,
  ) {
    this.#stdin = flags.stdin;
    this.#stdout = flags.stdout;
    this.#stderr = flags.stderr;
    this.#columns = columns;
  }

  stdin(): boolean {
    return this.#stdin;
  }

  stdout(): boolean {
    return this.#stdout;
  }

  stderr(): boolean {
    return this.#stderr;
  }

  columns(): number | undefined {
    return this.#columns;
  }
}

/** Чтение переменной окружения строкой. */
export interface Environment {
  value(name: string): string | undefined;
}

/** Правило чтения переменных поверх окружения сервера. */
export interface EnvRule {
  /** @param server окружение процесса сервера */
  over(server: (name: string) => string | undefined): Environment;
}

/** Переменных клиент не принёс: строка видит окружение сервера. */
export const SERVER_RULE: EnvRule = {
  over: (server) => ({ value: server }),
};

/**
 * Переменные клиента поверх окружения сервера: принесённое имя берётся
 * у клиента (пустая строка — тоже значение), не принесённое — у сервера.
 * Иначе строка потеряла бы доступ к конфигурации службы.
 */
function clientRule(given: ReadonlyMap<string, string>): EnvRule {
  return {
    over: (server) => ({
      value: (name) => given.has(name) ? given.get(name) : server(name),
    }),
  };
}

/** Что принёс вызывающий: ввод, терминальность, переменные. */
export interface CallContext {
  readonly input: LineInput;
  readonly terminals: Terminals;
  readonly env: EnvRule;
}

/** Предел ввода строки в байтах UTF-8; потоковый ввод — следующая порция. */
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/** Границы ширины консоли, принимаемой от клиента. */
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 10_000;

/** Отказ по пределу ввода: текст выводится из самого предела. */
export function tooLargeInput(): string {
  return `ввод больше ${MAX_STDIN_BYTES / 1024 / 1024} МиБ`;
}

/** Закрытый список имён окружения, принимаемых от клиента.
 *
 * Только про вид вывода. Всё, что меняет, куда строка пойдёт и откуда
 * возьмёт состояние (`HOME`, `XDG_CONFIG_HOME`, `PG*`), не принимается:
 * принятая `PGHOST` увела бы разрешённую строку в другую базу, не изменив
 * ни одного её слова (`platform/call-context.md`).
 *
 * Список — единственный источник: на него ссылаются права задач `cli` и
 * `compile:cli` в `deno.jsonc`.
 */
export const CLIENT_ENV_NAMES: readonly string[] = [
  "COLUMNS",
  "NO_COLOR",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "TMUX",
  "WT_SESSION",
  "OS",
];

/** Поля контекста в первом кадре — то, что шлёт клиент. */
export interface ContextFields {
  readonly stdin?: string;
  /** Ввод есть и будет отдан по запросу строки; только `true`. */
  readonly stdinOnRequest?: true;
  readonly tty?: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
    readonly columns?: number;
  };
  readonly env?: Readonly<Record<string, string>>;
}

const encoder = new TextEncoder();

/** Поля первого кадра, которыми клиент приносит контекст вызова. */
export const CONTEXT_FIELDS: readonly string[] = [
  "stdin",
  "stdinOnRequest",
  "tty",
  "env",
];

/** Отказ на контекст вызова в теле ответа по номеру. */
export const CONTEXT_IN_ANSWER = "контекст вызова в ответе не принимается";

/**
 * Ширина в границах контракта; вне их или не целое — `undefined`. Одно
 * место на обе стороны: сервер по нему бракует кадр, клиент — не шлёт
 * несуразную ширину.
 */
function columnsWithin(value: number): number | undefined {
  if (!Number.isInteger(value)) return undefined;
  if (value < MIN_COLUMNS || value > MAX_COLUMNS) return undefined;
  return value;
}

/**
 * Ввод байтами в пределе: одно место на обе стороны — сервер бракует
 * им кадр, клиент — не шлёт лишнего.
 *
 * @param text весь ввод
 * @throws BadFrame — больше предела
 */
export function boundedInput(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  // Замер по тому, что пришло: длина строки меньше числа байтов у
  // всего, кроме ASCII.
  if (bytes.length > MAX_STDIN_BYTES) {
    throw new BadFrame("ввод больше предела", tooLargeInput());
  }
  return bytes;
}

/**
 * Ввод из поля кадра.
 *
 * @throws BadFrame — не строка либо больше предела
 */
function givenOf(value: unknown): LineInput {
  if (value === undefined) return NO_INPUT;
  if (typeof value !== "string") throw new BadFrame("stdin — не строка");
  return givenInput(boundedInput(value));
}

/**
 * Откуда транспорт берёт ввод строки: только из кадра или ещё и по
 * запросу (`platform/stdin-on-request.md`).
 */
export interface InputSource {
  /**
   * Ввод строки из полей первого кадра.
   *
   * @throws BadFrame — поля ввода непринимаемы
   */
  of(frame: Record<string, unknown>): LineInput;
}

/**
 * Спросить ввод нечем (простой HTTP): он приходит полем `stdin`, а
 * `stdinOnRequest` не читается вовсе — как незнакомое поле.
 */
export const FRAME_INPUT: InputSource = { of: (frame) => givenOf(frame.stdin) };

/**
 * Ввод по запросу строки у транспорта, который умеет спросить.
 *
 * @param requested ввод, который транспорт запросит у клиента
 */
export function inputOnRequest(requested: LineInput): InputSource {
  return {
    of(frame) {
      const { stdin, stdinOnRequest = false } = frame;
      if (typeof stdinOnRequest !== "boolean") {
        throw new BadFrame("stdinOnRequest — не булево");
      }
      if (!stdinOnRequest) return givenOf(stdin);
      // Два источника одного ввода — противоречие в кадре, а не выбор.
      if (stdin !== undefined) {
        throw new BadFrame("stdin вместе с stdinOnRequest");
      }
      return requested;
    },
  };
}

/**
 * Флаг терминальности потока; поля нет — не терминал.
 *
 * @throws BadFrame — поле не булево
 */
function flagOf(tty: Record<string, unknown>, name: string): boolean {
  const value = tty[name] ?? false;
  if (typeof value !== "boolean") throw new BadFrame(`tty.${name} — не булево`);
  return value;
}

/**
 * Терминальность из поля кадра.
 *
 * @throws BadFrame — не объект, поле не булево, ширина вне границ или
 *   ширина без терминала
 */
function terminalsOf(value: unknown): Terminals {
  if (value === undefined) return NOT_TERMINALS;
  if (!isRecord(value)) throw new BadFrame("tty — не объект");
  const flags = {
    stdin: flagOf(value, "stdin"),
    stdout: flagOf(value, "stdout"),
    stderr: flagOf(value, "stderr"),
  };
  const declared = value.columns;
  if (declared === undefined) return new ClientTerminals(flags, undefined);
  if (typeof declared !== "number" || columnsWithin(declared) === undefined) {
    throw new BadFrame("tty.columns вне границ");
  }
  // Ширина без терминала — не форма кадра, а противоречие в нём: свой
  // отказ, чтобы клиент видел, что именно не сошлось.
  if (!flags.stdout) {
    throw new BadFrame(
      "ширина при stdout не терминале",
      "ширина без терминала",
    );
  }
  return new ClientTerminals(flags, declared);
}

/**
 * Правило чтения переменных из поля кадра.
 *
 * @throws BadFrame — не объект, значение не строка или имя вне списка
 */
function envRuleOf(value: unknown): EnvRule {
  if (value === undefined) return SERVER_RULE;
  if (!isRecord(value)) throw new BadFrame("env — не объект");
  const given = new Map<string, string>();
  const outside: string[] = [];
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new BadFrame(`env.${name} — не строка`);
    if (!CLIENT_ENV_NAMES.includes(name)) {
      outside.push(name);
      continue;
    }
    given.set(name, item);
  }
  // В отказе — только имена: значения бывают секретами
  // (`platform/call-context.md`, инварианты).
  if (outside.length > 0) {
    throw new BadFrame(
      "имя вне списка",
      `переменная вне списка: ${outside.join(", ")}`,
    );
  }
  // Пустой объект — как отсутствие поля.
  return given.size === 0 ? SERVER_RULE : clientRule(given);
}

/**
 * Контекст вызова из первого кадра; полей нет — контекст сервера.
 *
 * @param frame первый кадр, уже разобранный в объект
 * @param input откуда транспорт берёт ввод строки
 * @throws BadFrame — вид поля не тот, ввод больше предела, два источника
 *   ввода, ширина без терминала или имя переменной вне списка
 */
export function callContextOf(
  frame: Record<string, unknown>,
  input: InputSource = FRAME_INPUT,
): CallContext {
  return {
    input: input.of(frame),
    terminals: terminalsOf(frame.tty),
    env: envRuleOf(frame.env),
  };
}

/** Чем клиент снимает свой контекст (`cli-client.md`, «Сторона клиента»). */
export interface CallerFacts {
  /**
   * Весь stdin текстом. Зовётся только по запросу строки и только когда
   * stdin не терминал (`platform/stdin-on-request.md`).
   */
  stdin(): Promise<string>;
  stdinIsTerminal(): boolean;
  stdoutIsTerminal(): boolean;
  stderrIsTerminal(): boolean;
  /** Ширина консоли клиента; её нет — `undefined`. */
  columns(): number | undefined;
  /** Значение переменной у клиента. */
  value(name: string): string | undefined;
}

/**
 * Поля контекста, снятые у клиента: есть ли ввод (только из пайпа; сам
 * ввод — по запросу строки), три признака терминала с шириной и имена
 * закрытого списка. stdin здесь не читается.
 */
export function contextFieldsOf(facts: CallerFacts): ContextFields {
  const fields: {
    stdinOnRequest?: true;
    tty: { stdin: boolean; stdout: boolean; stderr: boolean; columns?: number };
    env?: Record<string, string>;
  } = {
    tty: {
      stdin: facts.stdinIsTerminal(),
      stdout: facts.stdoutIsTerminal(),
      stderr: facts.stderrIsTerminal(),
    },
  };
  // Открытый stdin без писателя не кончается никогда: читать его до
  // первого кадра — повесить строку, которой ввод не нужен.
  if (!fields.tty.stdin) fields.stdinOnRequest = true;
  // Ширина — только при терминале на stdout и только в границах
  // контракта: иначе сервер забраковал бы кадр целиком.
  const declared = fields.tty.stdout ? facts.columns() : undefined;
  const columns = declared === undefined ? undefined : columnsWithin(declared);
  if (columns !== undefined) fields.tty.columns = columns;
  const env: Record<string, string> = {};
  for (const name of CLIENT_ENV_NAMES) {
    const value = facts.value(name);
    if (value !== undefined) env[name] = value;
  }
  if (Object.keys(env).length > 0) fields.env = env;
  return fields;
}
