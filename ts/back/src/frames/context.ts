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

/** Ввод строки: значение, а не поток с позицией. */
export interface LineInput {
  /** Весь ввод байтами; повторный вызов даёт то же содержимое. */
  bytes(): Uint8Array;
}

/** Ввода нет: чтение `-` даёт пустое значение, конец сразу. */
export const NO_INPUT: LineInput = { bytes: () => new Uint8Array() };

/** Ввод, пришедший кадром: копия на каждое чтение — буфер общий. */
function givenInput(bytes: Uint8Array): LineInput {
  return { bytes: () => bytes.slice() };
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
export const CONTEXT_FIELDS: readonly string[] = ["stdin", "tty", "env"];

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
 * Ввод из поля кадра.
 *
 * @throws BadFrame — не строка либо больше предела
 */
function inputOf(value: unknown): LineInput {
  if (value === undefined) return NO_INPUT;
  if (typeof value !== "string") throw new BadFrame("stdin — не строка");
  const bytes = encoder.encode(value);
  // Замер по тому, что пришло: длина строки меньше числа байтов у
  // всего, кроме ASCII.
  if (bytes.length > MAX_STDIN_BYTES) {
    throw new BadFrame("ввод больше предела", tooLargeInput());
  }
  return givenInput(bytes);
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
 * @throws BadFrame — вид поля не тот, ввод больше предела, ширина без
 *   терминала или имя переменной вне списка
 */
export function callContextOf(frame: Record<string, unknown>): CallContext {
  return {
    input: inputOf(frame.stdin),
    terminals: terminalsOf(frame.tty),
    env: envRuleOf(frame.env),
  };
}

/** Чем клиент снимает свой контекст (`cli-client.md`, «Сторона клиента»). */
export interface CallerFacts {
  /** Весь stdin текстом; stdin — терминал — `undefined`. */
  stdin(): Promise<string | undefined>;
  stdinIsTerminal(): boolean;
  stdoutIsTerminal(): boolean;
  stderrIsTerminal(): boolean;
  /** Ширина консоли клиента; её нет — `undefined`. */
  columns(): number | undefined;
  /** Значение переменной у клиента. */
  value(name: string): string | undefined;
}

/**
 * Поля контекста, снятые у клиента: ввод (только из пайпа), три
 * признака терминала с шириной и имена закрытого списка.
 *
 * @throws BadFrame — ввод больше предела: клиент не шлёт ничего
 */
export async function contextFieldsOf(
  facts: CallerFacts,
): Promise<ContextFields> {
  const fields: {
    stdin?: string;
    tty: { stdin: boolean; stdout: boolean; stderr: boolean; columns?: number };
    env?: Record<string, string>;
  } = {
    tty: {
      stdin: facts.stdinIsTerminal(),
      stdout: facts.stdoutIsTerminal(),
      stderr: facts.stderrIsTerminal(),
    },
  };
  const text = await facts.stdin();
  if (text !== undefined) {
    // Тот же предел и тот же текст, что у сервера: отказ печатает
    // клиент своим префиксом, серверу при этом не уходит ничего.
    if (encoder.encode(text).length > MAX_STDIN_BYTES) {
      throw new BadFrame("ввод больше предела", tooLargeInput());
    }
    fields.stdin = text;
  }
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
