/**
 * Значения-выражения строки (`platform/value-expression.md`): результат
 * группы `do … end` и `stdin` на месте значения ключа. Группа — та же
 * строка со своим путём правил; её stdout не печатается, а становится
 * данными, stderr хода — как есть.
 */

import type { CommandIo } from "../command/mod.ts";
import { UsageError } from "../command/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import {
  GroupExit,
  type Outcome,
  Refusal,
  Rejection,
  type ValueEvaluation,
} from "../objects/mod.ts";

/** Итог группы: как кончилась строка и что она напечатала в stdout. */
export interface GroupRun {
  (words: readonly string[]): Promise<{
    readonly outcome: Outcome;
    readonly printed: string;
  }>;
}

/**
 * stdin строки: читается ровно один раз — ключом `stdin` или прежней
 * подстановкой команды; второе чтение — отказ.
 */
export class StdinOnce {
  readonly #io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">;
  /** Кто прочитал; ещё никто — `undefined`. */
  #reader: string | undefined;
  /** Ключ оставлен команде: при терминале она читает его сама. */
  #left = false;

  constructor(io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">) {
    this.#io = io;
  }

  /**
   * stdin — значением ключа `key`: весь ввод, хвостовой перевод строки
   * снят. При терминале ключ, который команда читает сама, остаётся без
   * значения; прочие — отказ.
   */
  async take(key: string, prompts: boolean): Promise<string | undefined> {
    this.#once(key);
    if (this.#io.stdinIsTerminal()) {
      if (!prompts) throw new Refusal("stdin — терминал");
      this.#left = true;
      return undefined;
    }
    const text = new TextDecoder().decode(await this.#io.readStdin());
    return text.replace(/\r?\n$/, "");
  }

  /** Чтение самой командой (прежние подстановки): тот же один раз. */
  forCommand(): Promise<Uint8Array> {
    if (this.#reader !== undefined && !this.#left) {
      throw new UsageError(this.#taken());
    }
    return this.#io.readStdin();
  }

  #once(key: string) {
    if (this.#reader !== undefined) throw new Refusal(this.#taken());
    this.#reader = key;
  }

  #taken(): string {
    return `stdin уже прочитан ключом ${this.#reader}`;
  }
}

/** Вид данных для отказа «не скаляр»: список или запись (спека). */
function kindName(data: unknown): string {
  return Array.isArray(data) ? "список" : "запись";
}

/**
 * Данные группы значением ключа (граница JSON): скаляр — текстом; запись
 * ровно с одним полем-скаляром — это поле; прочее — отказ «не скаляр».
 * Список записей с `id` — с готовым значением через `first id`.
 */
function valueOf(
  data: unknown,
  key: string,
  ready: (field: string) => string,
): string {
  if (["string", "number", "boolean"].includes(typeof data)) {
    return String(data);
  }
  const fields = typeof data === "object" && data !== null &&
      !Array.isArray(data)
    ? Object.values(data)
    : [];
  if (
    fields.length === 1 &&
    ["string", "number", "boolean"].includes(typeof fields[0])
  ) {
    return String(fields[0]);
  }
  throw new Refusal(
    `значение ключа ${key} — не скаляр (${kindName(data)})` +
      identified(data, key, ready),
  );
}

/** Поле-идентификатор записей, которым из списка берут скаляр. */
const ID = "id";

/** Подсказка к списку записей с `id`: готовое значение; иначе — пусто. */
function identified(
  data: unknown,
  key: string,
  ready: (field: string) => string,
): string {
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  const records = typeof first === "object" && first !== null && ID in first;
  return records ? `; скаляром: ${key}: ${ready(ID)}` : "";
}

/**
 * Текст JSON группы данными. Не JSON печатает поверхность вне контрактов
 * команд (`version`): формат `json` ей не указ.
 */
function parsed(text: string, key: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Refusal(`значение ключа ${key} — не данные`, { cause: err });
  }
}

/**
 * Данные итога группы (граница итога): отказ группы — отказ строки тем же
 * текстом; код ≠ 0 — тем же кодом. Прочее — JSON её печати: у итога-
 * значения это его текст (формат `json`), у исполненной команды — stdout.
 * Итога без печати (вершина дерева) у группы нет: `json` она не понимает.
 */
function dataOf(outcome: Outcome, printed: string, key: string): unknown {
  if ("refused" in outcome) throw new Rejection(outcome.refused);
  if ("exit" in outcome && outcome.exit !== 0) {
    throw new GroupExit(outcome.exit);
  }
  return parsed("value" in outcome ? String(outcome.value) : printed, key);
}

/** Значения строки: группы исполняет `run`, stdin — один на строку. */
export class LineValues implements ValueEvaluation {
  readonly #run: GroupRun;
  readonly #stdin: StdinOnce;

  constructor(run: GroupRun, stdin: StdinOnce) {
    this.#run = run;
    this.#stdin = stdin;
  }

  async group(
    words: readonly string[],
    key: string,
    ready: (field: string) => string,
  ): Promise<string> {
    // Формат группы — json: значение — данные результата, не их текст.
    const { outcome, printed } = await this.#run([
      ...words,
      GRAMMAR.close,
      "json",
    ]);
    return valueOf(dataOf(outcome, printed, key), key, ready);
  }

  stdin(key: string, prompts: boolean): Promise<string | undefined> {
    return this.#stdin.take(key, prompts);
  }
}
