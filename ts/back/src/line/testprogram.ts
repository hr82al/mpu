/**
 * Стенд программы для тестов и пересборки эталона
 * `fixtures/evaluator/cases.json` (`platform/evaluator.md`,
 * «Golden-примеры»): точка входа строки, подменённый Kaiten с тремя
 * карточками (списком и каждая целиком), кэш-БД во временном каталоге,
 * программа — здесь же.
 */

import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import type { RefusalData } from "../frames/mod.ts";
import type { InvokeCommand, InvokeLog } from "../invokelog/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { Memory } from "./it.ts";
import { type ImagePorts, lineEntry } from "./mod.ts";
import { consentOf } from "./testconsent.ts";

const CARDS_PATH = "/api/latest/cards";

/** Три карточки: две в колонке 9101. */
const CARDS: readonly Record<string, unknown>[] = [
  { id: 11, title: "один", state: 1, column_id: 9101, updated: "2026-08-20" },
  { id: 12, title: "два", state: 2, column_id: 9102, updated: "2026-09-05" },
  { id: 13, title: "три", state: 3, column_id: 9101, updated: "2026-08-01" },
];

/** Одна карточка и её комментарии: `/cards/{id}` и `…/comments`. */
const CARD_PATH = /^\/api\/latest\/cards\/(\d+)(\/comments)?$/;

/** Справочник кастомных полей: на стенде пуст. */
const PROPERTIES_PATH = "/api/latest/company/custom-properties";

/**
 * Карточка и комментарии, снятые с живого Kaiten (голдены `kiten card`):
 * у карточки стенда — её `id`, `title` и `state` из списка.
 */
const LIVE = new URL("../kiten/testdata/kiten-card/", import.meta.url);

async function liveJson(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(new URL(name, LIVE)));
}

/**
 * Ответ на `/cards/{id}[/comments]`; карточки нет в списке — 404.
 * Созданный комментарий — первый из снятых, с новым id.
 */
async function cardReply(
  id: number,
  comments: boolean,
  method: string,
  posted: number,
): Promise<Response> {
  const listed = CARDS.find((card) => card.id === id);
  if (listed === undefined) return new Response(null, { status: 404 });
  const live = await liveJson("live-raw-comments.json");
  if (comments && method === "POST") {
    // Снятый список — массив комментариев: так его отдаёт GET.
    const [first] = live as readonly Record<string, unknown>[];
    return Response.json({ ...first, id: 900000 + posted });
  }
  if (comments) return Response.json(live);
  const card = await liveJson("live-raw-card.json");
  const { title, state } = listed;
  return Response.json(Object.assign({}, card, { id, title, state }));
}

/** Созданные комментарии в запросах `seen`: `карточка текст`. */
function postedOf(seen: readonly CapturedRequest[]): string[] {
  return seen
    .filter((one) => one.method === "POST" && CARD_PATH.test(one.pathname))
    .map((one) => {
      const id = CARD_PATH.exec(one.pathname)?.[1];
      return `${id} ${JSON.parse(one.body).text}`;
    });
}

/** Подменённый Kaiten и порт исполнения к нему. */
export interface Stand {
  readonly io: Partial<CommandIo>;
  /** Адрес подменённого Kaiten: в выводе он меняется от прогона к прогону. */
  readonly baseUrl: string;
  /** Сколько раз команда спросила карточки. */
  readonly asked: () => number;
  /** Созданные комментарии: `карточка текст` по порядку. */
  readonly posted: () => readonly string[];
}

/**
 * Стенд на время `fn`: Kaiten на петле, кэш-БД во временном каталоге.
 * `listed` зовётся на каждом запросе списка карточек — так тест делает
 * что-то посреди исполнения строки (правило из другого процесса).
 */
export async function withStand(
  fn: (stand: Stand) => Promise<void>,
  listed: () => void = () => {},
) {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === "/api/latest/users/current") {
      return Response.json({ id: 9001, full_name: "Тест", username: "t" });
    }
    if (last.pathname === PROPERTIES_PATH) return Response.json([]);
    if (last.pathname === CARDS_PATH) {
      listed();
      const offset = new URLSearchParams(last.search).get("offset");
      return Response.json(offset === "0" || offset === null ? CARDS : []);
    }
    const card = CARD_PATH.exec(last.pathname);
    if (card === null) {
      return new Response("путь, которого тест не ждал", { status: 500 });
    }
    return cardReply(
      Number(card[1]),
      card[2] !== undefined,
      last.method,
      postedOf(seen).length,
    );
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
      posted: () => postedOf(fake.seen),
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
  /** stdout и stderr по порядку. */
  readonly frames: readonly Frame[];
  /** Отказ-объекты строки (`platform/refusal-object.md`). */
  readonly refusals: readonly RefusalData[];
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

/** Кадр вывода строки по порядку: stdout или stderr. */
export type Frame = { readonly out: string } | { readonly err: string };

/** Что строке на стенде задают сверх слов. */
export interface StandLine {
  /** Ответы человека по очереди. */
  readonly answers?: readonly string[];
  /** Память вызывающего (`it`). */
  readonly memory?: Memory;
  /** Подмены окружения поверх стенда: без терминала — человека нет. */
  readonly io?: Partial<CommandIo>;
  /** Образ строки (`platform/image.md`); нет — пуст. */
  readonly image?: ImagePorts;
}

/**
 * Строка `words` на стенде с файлом правил `file`: stdin и stderr —
 * терминалы, если `line.io` не сказал иного.
 */
export async function runOnStand(
  file: string,
  words: readonly string[],
  stand: Stand,
  line: StandLine = {},
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const frames: Frame[] = [];
  const refusals: RefusalData[] = [];
  const native: string[] = [];
  const records: JournalRecord[] = [];
  const journal: InvokeJournal = {
    nativeCall: (policy) => void native.push(policy.path.join(" ")),
    note: () => {},
    executedBy: () => {},
    log: recordingLog(records),
  };
  const ports = consentOf(file, line.answers, line.memory);
  const exit = await lineEntry({
    ...ports,
    refusal: (data) => void refusals.push(data),
    image: line.image,
  })(
    words,
    makeFakeIo({
      ...stand.io,
      stdinIsTerminal: () => true,
      stderrIsTerminal: () => true,
      ...line.io,
    }),
    {
      stdout: (text: string) => {
        stdout += text;
        frames.push({ out: text });
      },
      stderr: (text: string) => {
        stderr += text;
        frames.push({ err: text });
      },
    },
    journal,
  );
  return { exit, stdout, stderr, frames, refusals, native, records };
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
