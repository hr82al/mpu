/**
 * Стенд сценариев канала `mpu task`: строка целиком через разбор, правила
 * подтверждения, дверь и команду. Кэш-БД — в памяти, файл правил — во
 * временном каталоге; «агент» — канал без человека.
 */

import { deepStrictEqual } from "node:assert/strict";
import type { CacheDb, CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { NO_INVOKE_LOG } from "../invokelog/mod.ts";
import { lineEntry } from "../line/mod.ts";
import { consentOf, withPolicyFile } from "../line/testconsent.ts";
import { fakeConfigDb, makeFakeIo } from "../testing/mod.ts";
import { SETUP_TEXT } from "./texts.ts";

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Как строку зовут: человек с ответами или агент; ввод строки. */
export interface Caller {
  /** Ответы человека по очереди; нет — агент (спросить некого). */
  readonly answers?: readonly string[];
  readonly stdin?: string;
  readonly files?: Readonly<Record<string, string>>;
}

/** Стенд: одна кэш-БД и один файл правил на весь сценарий. */
export class Stand {
  readonly #file: string;
  readonly #db = fakeConfigDb();

  /**
   * @param history значение ключа `task.history`; нет — умолчание
   */
  constructor(file: string, history?: string) {
    this.#file = file;
    if (history !== undefined) {
      const db = this.#db();
      db.bootstrap();
      db.execute(
        "INSERT INTO config (key, value) VALUES ('task.history', ?)",
        history,
      );
    }
  }

  /** Кэш-БД стенда: её же открывает оркестратор. */
  openDb(): CacheDb {
    return this.#db();
  }

  /** Человек, отвечающий `y` на каждый вопрос. */
  human(...words: string[]): Promise<Run> {
    return this.run(words, { answers: ["y", "y", "y"] });
  }

  agent(...words: string[]): Promise<Run> {
    return this.run(words, {});
  }

  async run(argv: readonly string[], caller: Caller): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const journal: InvokeJournal = {
      nativeCall: () => {},
      note: () => {},
      executedBy: () => {},
      log: NO_INVOKE_LOG,
    };
    const human: Partial<CommandIo> = caller.answers === undefined ? {} : {
      stdinIsTerminal: () => caller.stdin === undefined,
      stderrIsTerminal: () => true,
    };
    const io = makeFakeIo({
      ...human,
      openCacheDb: this.#db,
      readStdin: () =>
        Promise.resolve(new TextEncoder().encode(caller.stdin ?? "")),
      readTextFile: (path) => {
        const text = caller.files?.[path];
        if (text === undefined) {
          return Promise.reject(new Error(`нет файла ${path}`));
        }
        return Promise.resolve(text);
      },
    });
    const code = await lineEntry(consentOf(this.#file, caller.answers))(
      argv,
      io,
      {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      },
      journal,
    );
    return { code, stdout: out.join(""), stderr: err.join("") };
  }
}

export function withStand(
  body: (stand: Stand) => Promise<void>,
  history?: string,
): Promise<void> {
  return withPolicyFile((file) => body(new Stand(file, history)));
}

export function expect(run: Run, code: number, stdout: string, stderr: string) {
  deepStrictEqual(
    { code: run.code, stdout: run.stdout, stderr: run.stderr },
    { code, stdout, stderr },
  );
}

const SETUP = [
  "ask",
  "task",
  "setup",
  "project:",
  "demo",
  "note:",
  "^игрушечный",
  "проект^",
];

/** Вопрос двери о строке `words` (без `ask`). */
export function asked(words: readonly string[]): string {
  return `выполнить mpu ${words.slice(1).join(" ")}? [y/N] `;
}

/**
 * Вопрос двери о строке T2: группа `^…^` в нём уже раскрыта — живая
 * форма вопроса, у спеки `^игрушечный проект^` (вынесено хосту).
 */
const SETUP_ASKED =
  "выполнить mpu task setup project: demo note: игрушечный проект? [y/N] ";

/** T2: проект заведён человеком. */
export async function setUp(stand: Stand) {
  expect(await stand.human(...SETUP), 0, SETUP_TEXT, SETUP_ASKED);
}
