/**
 * Стенд программы для тестов и пересборки эталона
 * `fixtures/evaluator/cases.json` (`platform/evaluator.md`,
 * «Golden-примеры»): точка входа строки, подменённый Kaiten с тремя
 * карточками, кэш-БД во временном каталоге, программа — здесь же.
 */

import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import type { InvokeCommand, InvokeLog } from "../invokelog/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { consentOf } from "./testconsent.ts";

const CARDS_PATH = "/api/latest/cards";

/** Три карточки: две в колонке 9101. */
const CARDS: readonly Record<string, unknown>[] = [
  { id: 11, title: "один", state: 1, column_id: 9101, updated: "2026-08-20" },
  { id: 12, title: "два", state: 2, column_id: 9102, updated: "2026-09-05" },
  { id: 13, title: "три", state: 3, column_id: 9101, updated: "2026-08-01" },
];

/** Подменённый Kaiten и порт исполнения к нему. */
export interface Stand {
  readonly io: Partial<CommandIo>;
  /** Адрес подменённого Kaiten: в выводе он меняется от прогона к прогону. */
  readonly baseUrl: string;
  /** Сколько раз команда спросила карточки. */
  readonly asked: () => number;
}

/** Стенд на время `fn`: Kaiten на петле, кэш-БД во временном каталоге. */
export async function withStand(fn: (stand: Stand) => Promise<void>) {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === "/api/latest/users/current") {
      return Response.json({ id: 9001, full_name: "Тест", username: "t" });
    }
    if (last.pathname !== CARDS_PATH) {
      return new Response("путь, которого тест не ждал", { status: 500 });
    }
    const offset = new URLSearchParams(last.search).get("offset");
    return Response.json(offset === "0" || offset === null ? CARDS : []);
  });
  const dir = await Deno.makeTempDir();
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  };
  try {
    await fn({
      baseUrl: fake.baseUrl,
      io: {
        envFile: {
          get: (name) => values[name],
          values: () => values,
          require: (name) => values[name] ?? "",
          set: () => Promise.resolve(),
        },
        openCacheDb: () => openCacheDb(`${dir}/cache.db`),
      },
      asked: () =>
        fake.seen.filter((one) => one.pathname === CARDS_PATH).length,
    });
  } finally {
    await fake.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

/** Запись журнала вызовов: чья строка и какие команды она отметила. */
export interface JournalRecord {
  readonly argv: readonly string[];
  readonly native: string[];
}

/** Итог строки на стенде. */
export interface Ran {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Отметки `native` записи самой строки. */
  readonly native: readonly string[];
  /** Записи, начатые строкой в журнале (подстроки программы). */
  readonly records: readonly JournalRecord[];
}

/** Журнал подстрок: записи копятся в `records`. */
function recordingLog(records: JournalRecord[]): InvokeLog {
  return {
    begin: (command: InvokeCommand) => {
      const record: JournalRecord = {
        argv: "argv" in command ? command.argv : [],
        native: [],
      };
      records.push(record);
      return {
        runId: () => "",
        executedBy: () => {},
        nativeCall: (policy) => void record.native.push(policy.path.join(" ")),
        capture: (output) => output,
        out: () => {},
        err: () => {},
        note: () => {},
        finish: () => Promise.resolve(),
      };
    },
  };
}

/**
 * Строка `words` на стенде с файлом правил `file`: stdin и stderr —
 * терминалы, ответы человека — `answers`.
 */
export async function runOnStand(
  file: string,
  words: readonly string[],
  stand: Stand,
  answers: readonly string[] = [],
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const native: string[] = [];
  const records: JournalRecord[] = [];
  const journal: InvokeJournal = {
    nativeCall: (policy) => void native.push(policy.path.join(" ")),
    note: () => {},
    executedBy: () => {},
    log: recordingLog(records),
  };
  const exit = await lineEntry(consentOf(file, answers))(
    words,
    makeFakeIo({
      ...stand.io,
      stdinIsTerminal: () => true,
      stderrIsTerminal: () => true,
    }),
    {
      stdout: (text: string) => void (stdout += text),
      stderr: (text: string) => void (stderr += text),
    },
    journal,
  );
  return { exit, stdout, stderr, native, records };
}

/** Метка адреса подменённого Kaiten в эталоне. */
export const KAITEN_MARK = "{kaiten}";

/** Метки слов грамматики в эталоне: `{do}`, `{done}`, `{^}` и прочие. */
const MARKS: ReadonlyMap<string, string> = new Map([
  ["{do}", GRAMMAR.open],
  ["{end}", GRAMMAR.close],
  ["{--}", GRAMMAR.literal],
  ["{done}", GRAMMAR.blockEnd],
  ["{rem}", GRAMMAR.comment],
  ["{.}", GRAMMAR.separator],
  ["{:=}", GRAMMAR.assign],
  ["{^}", GRAMMAR.quote],
  ["{@}", GRAMMAR.variable],
  ["{:}", GRAMMAR.parameter],
]);

/**
 * Текст эталона со словами грамматики вместо меток: эталон не зависит
 * от того, как они пишутся (`platform/line-grammar.md` [D.1]).
 */
export function unmarked(text: string): string {
  let out = text;
  for (const [mark, word] of MARKS) out = out.replaceAll(mark, word);
  return out;
}

/** Случай эталона: строка с метками и её итог. */
export interface EvaluatorCase {
  readonly name: string;
  readonly line: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}
