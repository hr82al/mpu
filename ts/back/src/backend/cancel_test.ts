/**
 * Отмена строки и бесконечный вывод (`platform/line-cancel.md`):
 * отменяет тот, кто перестал слушать. Эталон — прогон настоящей
 * долгой команды: `mpu logs --follow` против Loki на петле печатает по
 * мере появления и останавливается, когда клиент закрыл канал.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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
const FOLLOW = ["logs", "--follow"];

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
      result: [{
        stream: { host: "sl-1" },
        values: [[
          `${1_754_380_800_000_000_000n + BigInt(index)}`,
          `строка ${index}`,
        ]],
      }],
    },
  });
}

/** Loki на петле: каждый опрос отдаёт новую запись. */
function fakeLoki() {
  let asked = 0;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(entry(asked++), { status: 200 }),
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    asked: () => asked,
    stop: () => server.shutdown(),
  };
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
  const loki = fakeLoki();
  const dir = await Deno.makeTempDir();
  try {
    const io: Partial<CommandIo> = {
      envFile: {
        get: (name: string) => name === "LOKI_URL" ? loki.baseUrl : undefined,
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
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("слежение: кадры идут до конца строки, обрыв её останавливает", async () => {
  const log = journal();
  await withLoki(async (back, loki) => {
    const line = await open(back, FOLLOW);
    // Первый кадр приходит, пока строка жива: она не кончается сама.
    const first = await within(
      line.frame((frame) => "out" in frame),
      5000,
      "первый кадр слежения",
    );
    assertStringIncludes(String(first.out), "строка 0");
    assertEquals(line.frames.some((frame) => "exit" in frame), false);
    const asked = loki.asked();
    line.close();
    await line.closed();
    // Строка остановлена: после обрыва к Loki больше не ходят.
    await within(log.written(1), 5000, "запись журнала");
    assertEquals(loki.asked(), asked);
  }, { finishedWith: log.finishedWith });
  assertEquals(log.codes, [CANCELLED_CODE]);
});

Deno.test("слежение простым HTTP: поток кадров и обрыв чтения", async () => {
  const log = journal();
  await withLoki(async (back) => {
    const abort = new AbortController();
    const response = await post(back, "/line", {
      words: FOLLOW,
      cwd: Deno.cwd(),
      human: false,
    }, { signal: abort.signal });
    const body = response.body;
    if (body === null) throw new Error("у ответа NDJSON нет тела");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // Первый кадр — до конца строки: собранного ответа ждать нечего.
    const chunk = await within(reader.read(), 5000, "первый кадр NDJSON");
    assertStringIncludes(decoder.decode(chunk.value), '"out"');
    abort.abort();
    await reader.cancel().catch(() => {});
    await within(log.written(1), 5000, "запись журнала");
  }, { finishedWith: log.finishedWith });
  assertEquals(log.codes, [CANCELLED_CODE]);
});

Deno.test("обрыв отпускает место в пределе сразу", async () => {
  await withLoki(async (back) => {
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
    const frames = await within(next.finished(), 5000, "exit соседней строки");
    assertEquals(frames.at(-1), { exit: 0 });
  }, { lines: 1 });
});

Deno.test("отмена после конца строки: итог прежний, второй записи нет", async () => {
  const log = journal();
  await withBack(async (back) => {
    const line = await open(back, ["xlsx", "alias", "ls", "--json"]);
    const frames = await within(line.finished(), 5000, "exit строки");
    // Строка кончилась сама; обрыв канала приходит уже после — итог
    // прежний, и 130 не появляется (`platform/line-cancel.md`).
    assertEquals(frames.at(-1), { exit: 0 });
    line.close();
    await line.closed();
  }, { finishedWith: log.finishedWith });
  assertEquals(log.codes, [0]);
});

Deno.test("голдены: кадры слежения и кадры отменённой строки", async () => {
  const log = journal();
  await withLoki(async (back) => {
    const line = await open(back, FOLLOW);
    // Три кадра слежения — до того, как строка кончилась: она и не
    // кончается, пока её слушают.
    while (line.frames.filter((frame) => "out" in frame).length < 3) {
      await within(
        line.frame((frame) =>
          line.frames.filter((one) => "out" in one).length >= 3 &&
          "out" in frame
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
      "описание": "строка со слежением: кадры идут до конца строки",
      "слова": FOLLOW,
      "кадры": follow.slice(0, 3),
    });
    await golden("frames-cancel.json", {
      "описание": "отменённая строка: клиент закрыл канал",
      "слова": FOLLOW,
      "кадры после обрыва": line.frames.slice(follow.length),
      "код записи журнала": log.codes,
    });
  }, { finishedWith: log.finishedWith });
});

/** Копия снятого прогоном голдена совпадает с ним. */
async function golden(name: string, body: unknown) {
  const url = new URL(`testdata/line-cancel/${name}`, import.meta.url);
  assertEquals(body, JSON.parse(await Deno.readTextFile(url)));
}

Deno.test("отмена в ожидании ответа: вопрос снят, команда не вызвана", async () => {
  const log = journal();
  await withBack(async (back) => {
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const line = await open(back, ["xlsx", "alias", "ls"]);
    await line.frame((frame) => "ask" in frame);
    line.close();
    await line.closed();
    assertEquals(back.called, []);
  }, { finishedWith: log.finishedWith });
  // Записи журнала у отказа правил нет вовсе: отметка вызова ставится
  // после их решения, и код 130 тут не при чём.
  assertEquals(log.codes, []);
});

Deno.test("отмена в ожидании места: строка не исполнялась", async () => {
  const log = journal();
  const second = awaited("--follow", 2);
  await withLoki(async (back, loki) => {
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
    assertEquals(loki.asked(), asked);
    busy.close();
    await busy.closed();
  }, { lines: 1, finishedWith: log.finishedWith, begun: second.begun });
  // Записана только та строка, которая исполнялась.
  assertEquals(log.codes, [CANCELLED_CODE]);
});

Deno.test("просьба остановиться: код 130 только у той, кого просили", () => {
  const asked = new Stopping();
  const quiet = new Stopping();
  assertEquals(quiet.outcome(0), 0);
  assertEquals(quiet.outcome(2), 2);
  assertEquals(asked.signal().aborted, false);
  asked.ask();
  assertEquals(asked.signal().aborted, true);
  assertEquals(asked.outcome(0), CANCELLED_CODE);
  asked.ask();
  assertEquals(asked.outcome(2), CANCELLED_CODE);
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

Deno.test("собранный ответ: клиент дочитал — запись своим кодом, не 130", async () => {
  // Ложное срабатывание опаснее пропущенного: Deno взводит
  // `request.signal` и после успешно отданного ответа (замер
  // 2026-09-22), и строка, объявленная отменённой, испортила бы журнал
  // обычных вызовов (`platform/mcp-cancel.md`).
  const log = journal();
  await withBack(async (back) => {
    const answer = await collected(
      back,
      await post(back, "/line", {
        words: ["xlsx", "alias", "ls"],
        cwd: Deno.cwd(),
        human: false,
      }, { accept: "application/json" }),
    );
    assertEquals(answer, { stdout: "", stderr: "", exit: 0 });
    await within(log.written(1), 5000, "запись журнала");
    assertEquals(log.codes, [0]);
  }, { finishedWith: log.finishedWith });
});

Deno.test("собранный ответ: клиент оборвал чтение — строка остановлена", async () => {
  // Без всякого MCP: обрыв запроса к `POST`-двери и есть отмена
  // строки, какой бы формой ответа клиент ни ходил.
  const log = journal();
  const start = Promise.withResolvers<void>();
  await withLoki(async (back) => {
    const stop = new AbortController();
    const asked = post(back, "/line", {
      words: FOLLOW,
      cwd: Deno.cwd(),
      human: false,
    }, { accept: "application/json", signal: stop.signal });
    await within(start.promise, 10_000, "строка началась");
    stop.abort();
    await asked.catch(() => undefined);
    await within(log.written(1), 10_000, "запись журнала");
    assertEquals(log.codes, [CANCELLED_CODE]);
  }, { finishedWith: log.finishedWith, begun: () => start.resolve() });
});

Deno.test("собранный ответ с номером: сигнал после ответа строку не гасит", () =>
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
      await post(back, "/line", {
        words: ["xlsx", "alias", "ls"],
        cwd: Deno.cwd(),
        human: true,
      }, { accept: "application/json" }),
    );
    const ticket = String(asked.ticket);
    assertEquals(ticket.length > 0, true, JSON.stringify(asked));
    // Сигнал доставленного ответа взводится, пока клиент дочитывает
    // тело: `collected` возвращается уже после него (замер 2026-09-22 —
    // сигнал приходит раньше `completed`). Ждать сном нечего.
    const answered = await collected(
      back,
      await post(back, "/line/answer", { ticket, answer: "y" }, {
        accept: "application/json",
      }),
    );
    assertEquals(answered, { stdout: "", stderr: "", exit: 0 });
    assertEquals(back.called, ["xlsx alias ls"]);
  }));
