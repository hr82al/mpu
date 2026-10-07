/**
 * Отмена строки и бесконечный вывод (`platform/line-cancel.md`):
 * отменяет тот, кто перестал слушать. Эталон — прогон настоящей
 * долгой команды: `mpu logs --follow` против Loki на петле печатает по
 * мере появления и останавливается, когда клиент закрыл канал.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { serveFetch } from "../testing/http.ts";
import type { CommandIo } from "../command/mod.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { CANCELLED_CODE, Stopping } from "./stopping.ts";
import {
  Client,
  collected,
  post,
  type TestBack,
  withBack,
  within,
} from "./testback.ts";

/** Слежение за логами: команда, которая сама не кончается. */
const FOLLOW = ["logs", "follow"];

function open(back: TestBack, words: readonly string[]) {
  const client = new Client(back, "/line");
  return client.opened().then(() => {
    client.start(words);
    return client;
  });
}

/** Ответ Loki с одной записью, время которой двигается вперёд. */
function entry(index: number): string {
  return JSON.stringify({
    data: {
      result: [
        {
          stream: { host: "sl-1" },
          values: [
            [
              `${1_754_380_800_000_000_000n + BigInt(index)}`,
              `строка ${index}`,
            ],
          ],
        },
      ],
    },
  });
}

/** Loki на петле: каждый опрос отдаёт новую запись. */
async function fakeLoki() {
  let asked = 0;
  const server = await serveFetch(() => new Response(entry(asked++)));
  return { baseUrl: server.baseUrl, asked: () => asked, stop: server.stop };
}

/** Сервер, у которого `logs` ходит к Loki на петле. */
async function withLoki(
  body: (back: TestBack, loki: { asked: () => number }) => Promise<void>,
  setup: {
    readonly lines?: number;
    readonly finishedWith?: (code: number) => void;
    readonly begun?: (words: readonly string[]) => void;
  } = {},
): Promise<void> {
  const loki = await fakeLoki();
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io: Partial<CommandIo> = {
      envFile: {
        get: (name: string) => (name === "LOKI_URL" ? loki.baseUrl : undefined),
        values: () => ({ LOKI_URL: loki.baseUrl }),
        require: (name: string) => {
          if (name === "LOKI_URL") return loki.baseUrl;
          throw new Error(`нет ключа ${name}`);
        },
        set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      },
      openCacheDb: () => openCacheDb(`${dir}/mpu.db`),
    };
    await withBack((back) => body(back, loki), {
      io,
      lines: setup.lines,
      finishedWith: setup.finishedWith,
      begun: setup.begun,
    });
  } finally {
    await loki.stop();
    await rm(dir, { recursive: true });
  }
}

it("слежение: кадры идут до конца строки, обрыв её останавливает", async () => {
  const log = journal();
  await withLoki(
    async (back, loki) => {
      const line = await open(back, FOLLOW);
      // Первый кадр приходит, пока строка жива: она не кончается сама.
      const first = await within(
        line.frame((frame) => "out" in frame),
        5000,
        "первый кадр слежения",
      );
      expect(String(first.out)).toContain("строка 0");
      expect(line.frames.some((frame) => "exit" in frame)).toBe(false);
      const asked = loki.asked();
      line.close();
      await line.closed();
      // Строка остановлена: после обрыва к Loki больше не ходят.
      await within(log.written(1), 5000, "запись журнала");
      expect(loki.asked()).toStrictEqual(asked);
    },
    { finishedWith: log.finishedWith },
  );
  expect(log.codes).toStrictEqual([CANCELLED_CODE]);
});

it("слежение простым HTTP: поток кадров и обрыв чтения", async () => {
  const log = journal();
  await withLoki(
    async (back) => {
      const abort = new AbortController();
      const response = await post(
        back,
        "/line",
        {
          words: FOLLOW,
          cwd: process.cwd(),
          human: false,
        },
        { signal: abort.signal },
      );
      const body = response.body;
      if (body === null) throw new Error("у ответа NDJSON нет тела");
      const reader = body.getReader();
      const decoder = new TextDecoder();
      // Первый кадр — до конца строки: собранного ответа ждать нечего.
      const chunk = await within(reader.read(), 5000, "первый кадр NDJSON");
      expect(decoder.decode(chunk.value)).toContain('"out"');
      abort.abort();
      await reader.cancel().catch(() => {});
      await within(log.written(1), 5000, "запись журнала");
    },
    { finishedWith: log.finishedWith },
  );
  expect(log.codes).toStrictEqual([CANCELLED_CODE]);
});

it("обрыв отпускает место в пределе сразу", async () => {
  await withLoki(
    async (back) => {
      const line = await open(back, FOLLOW);
      await within(
        line.frame((frame) => "out" in frame),
        5000,
        "первый кадр слежения",
      );
      line.close();
      await line.closed();
      // Предел — одна строка: соседняя пройдёт, только если место
      // освободилось сразу, а не по конце команды (та не кончается).
      const next = await open(back, ["version"]);
      const frames = await within(
        next.finished(),
        5000,
        "exit соседней строки",
      );
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
    },
    { lines: 1 },
  );
});

it("отмена после конца строки: итог прежний, второй записи нет", async () => {
  const log = journal();
  await withBack(
    async (back) => {
      const line = await open(back, [
        "xlsx",
        "alias",
        "ls",
        GRAMMAR.close,
        "json",
      ]);
      const frames = await within(line.finished(), 5000, "exit строки");
      // Строка кончилась сама; обрыв канала приходит уже после — итог
      // прежний, и 130 не появляется (`platform/line-cancel.md`).
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      line.close();
      await line.closed();
    },
    { finishedWith: log.finishedWith },
  );
  expect(log.codes).toStrictEqual([0]);
});

it("голдены: кадры слежения и кадры отменённой строки", async () => {
  const log = journal();
  await withLoki(
    async (back) => {
      const line = await open(back, FOLLOW);
      // Три кадра слежения — до того, как строка кончилась: она и не
      // кончается, пока её слушают.
      while (line.frames.filter((frame) => "out" in frame).length < 3) {
        await within(
          line.frame(
            (frame) =>
              line.frames.filter((one) => "out" in one).length >= 3 &&
              "out" in frame,
          ),
          10_000,
          "три кадра слежения",
        );
      }
      const follow = [...line.frames];
      line.close();
      await line.closed();
      await within(log.written(1), 5000, "запись журнала");
      await golden("frames-follow.json", {
        описание: "строка со слежением: кадры идут до конца строки",
        слова: FOLLOW,
        кадры: follow.slice(0, 3),
      });
      await golden("frames-cancel.json", {
        описание: "отменённая строка: клиент закрыл канал",
        слова: FOLLOW,
        "кадры после обрыва": line.frames.slice(follow.length),
        "код записи журнала": log.codes,
      });
    },
    { finishedWith: log.finishedWith },
  );
});

/** Копия снятого прогоном голдена совпадает с ним. */
async function golden(name: string, body: unknown) {
  const url = new URL(`testdata/line-cancel/${name}`, import.meta.url);
  expect(body).toStrictEqual(JSON.parse(await readFile(url, "utf8")));
}

it("отмена в ожидании ответа: вопрос снят, команда не вызвана", async () => {
  const log = journal();
  await withBack(
    async (back) => {
      {
        using book = RuleBook.open(back.policyFile, []);
        book.set(RulePath.parse("xlsx alias ls"), ASK);
      }
      const line = await open(back, ["ask", "xlsx", "alias", "ls"]);
      await line.frame((frame) => "ask" in frame);
      line.close();
      await line.closed();
      expect(back.called).toStrictEqual([]);
    },
    { finishedWith: log.finishedWith },
  );
  // Записи журнала у отказа правил нет вовсе: отметка вызова ставится
  // после их решения, и код 130 тут не при чём.
  expect(log.codes).toStrictEqual([]);
});

it("отмена в ожидании места: строка не исполнялась", async () => {
  const log = journal();
  const second = awaited("follow", 2);
  await withLoki(
    async (back, loki) => {
      const busy = await open(back, FOLLOW);
      await within(
        busy.frame((frame) => "out" in frame),
        5000,
        "первый кадр слежения",
      );
      const waiting = await open(back, FOLLOW);
      await within(second.reached, 5000, "журнал ждущей строки");
      const asked = loki.asked();
      waiting.close();
      await waiting.closed();
      // Ждущая места строка к Loki не ходила вовсе.
      expect(loki.asked()).toStrictEqual(asked);
      busy.close();
      await busy.closed();
      // Запись — до выхода из стенда: иначе строку довела бы остановка
      // сервера, и уход клиента от неё было бы не отличить.
      await within(log.written(1), 10_000, "запись журнала");
    },
    { lines: 1, finishedWith: log.finishedWith, begun: second.begun },
  );
  // Записана только та строка, которая исполнялась.
  expect(log.codes).toStrictEqual([CANCELLED_CODE]);
});

it("просьба остановиться: код 130 только у той, кого просили", () => {
  const asked = new Stopping();
  const quiet = new Stopping();
  expect(quiet.outcome(0)).toBe(0);
  expect(quiet.outcome(2)).toBe(2);
  expect(asked.signal().aborted).toBe(false);
  asked.ask();
  expect(asked.signal().aborted).toBe(true);
  expect(asked.outcome(0)).toStrictEqual(CANCELLED_CODE);
  asked.ask();
  expect(asked.outcome(2)).toStrictEqual(CANCELLED_CODE);
});

it("сорвавшееся исполнение: у остановленной — 130, у прочей — сбой", () => {
  const cause = new Error("сбой");
  const quiet = new Stopping();
  let thrown: unknown;
  try {
    quiet.failed(cause);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toStrictEqual(cause);
  const asked = new Stopping();
  asked.ask();
  expect(asked.failed(cause)).toStrictEqual(CANCELLED_CODE);
});

/**
 * Наблюдатель за журналом: коды закрытых записей и ожидание нужного их
 * числа. Ожидание — на событии записи, а не на опросе.
 */
function journal() {
  const codes: number[] = [];
  const waiting: (() => void)[] = [];
  return {
    codes,
    /** Ждёт, пока записей станет `count`. */
    written: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (codes.length >= count) resolve();
        };
        waiting.push(check);
        check();
      }),
    finishedWith: (code: number) => {
      codes.push(code);
      for (const check of waiting) check();
    },
  };
}

/** Ожидание записи журнала со словом `word` в аргументах. */
function awaited(word: string, count: number) {
  const reached = Promise.withResolvers<void>();
  let seen = 0;
  return {
    reached: reached.promise,
    begun: (words: readonly string[]) => {
      if (words.includes(word) && ++seen >= count) reached.resolve();
    },
  };
}

it("собранный ответ: клиент дочитал — запись своим кодом, не 130", async () => {
  // Ложное срабатывание опаснее пропущенного: Deno взводит
  // `request.signal` и после успешно отданного ответа (замер
  // 2026-09-22), и строка, объявленная отменённой, испортила бы журнал
  // обычных вызовов (`platform/mcp-cancel.md`).
  const log = journal();
  await withBack(
    async (back) => {
      const answer = await collected(
        back,
        await post(
          back,
          "/line",
          {
            words: ["xlsx", "alias", "ls"],
            cwd: process.cwd(),
            human: false,
          },
          { accept: "application/json" },
        ),
      );
      expect(answer).toStrictEqual({ stdout: "", stderr: "", exit: 0 });
      await within(log.written(1), 5000, "запись журнала");
      expect(log.codes).toStrictEqual([0]);
    },
    { finishedWith: log.finishedWith },
  );
});

it("собранный ответ: клиент оборвал чтение — строка остановлена", async () => {
  // Без всякого MCP: обрыв запроса к `POST`-двери и есть отмена
  // строки, какой бы формой ответа клиент ни ходил.
  const log = journal();
  const start = Promise.withResolvers<void>();
  await withLoki(
    async (back) => {
      const stop = new AbortController();
      const asked = post(
        back,
        "/line",
        {
          words: FOLLOW,
          cwd: process.cwd(),
          human: false,
        },
        { accept: "application/json", signal: stop.signal },
      );
      await within(start.promise, 10_000, "строка началась");
      stop.abort();
      await asked.catch(() => undefined);
      await within(log.written(1), 10_000, "запись журнала");
      expect(log.codes).toStrictEqual([CANCELLED_CODE]);
    },
    { finishedWith: log.finishedWith, begun: () => start.resolve() },
  );
});

it("собранный ответ с номером: сигнал после ответа строку не гасит", () =>
  withBack(async (back) => {
    // Строка с вопросом отдаёт собранный ответ с номером и живёт
    // дальше, ожидая ответа человека. Сигнал запроса взводится сразу
    // после доставки этого ответа (легаси-поведение Deno), и принять
    // его за уход клиента значило бы убить живую строку — номер стал
    // бы недействителен (`platform/mcp-cancel.md`).
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const asked = await collected(
      back,
      await post(
        back,
        "/line",
        {
          words: ["ask", "xlsx", "alias", "ls"],
          cwd: process.cwd(),
          human: true,
        },
        { accept: "application/json" },
      ),
    );
    const ticket = String(asked.ticket);
    expect(ticket.length > 0, JSON.stringify(asked)).toBe(true);
    // Сигнал доставленного ответа взводится, пока клиент дочитывает
    // тело: `collected` возвращается уже после него (замер 2026-09-22 —
    // сигнал приходит раньше `completed`). Ждать сном нечего.
    const answered = await collected(
      back,
      await post(
        back,
        "/line/answer",
        { ticket, answer: "y" },
        {
          accept: "application/json",
        },
      ),
    );
    expect(answered).toStrictEqual({ stdout: "", stderr: "", exit: 0 });
    expect(back.called).toStrictEqual(["xlsx alias ls"]);
  }));
