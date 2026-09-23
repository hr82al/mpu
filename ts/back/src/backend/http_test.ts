/**
 * Строка простым HTTP (`platform/back-http-line.md`): те же кадры, что у
 * WebSocket; собранный ответ — их склейка; вопрос — номером, одноразовым,
 * своей двери и своего токена; поток — по мере появления.
 */

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import type { CommandIo } from "../command/mod.ts";
import { rulesOf } from "../line/mod.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { formFor } from "./http.ts";
import { ANSWER_TIMEOUT_MS } from "./mod.ts";
import {
  collected,
  type Frame,
  httpLine,
  line,
  ndjson,
  post,
  request,
  type TestBack,
  withBack,
  within,
} from "./testback.ts";

const TICKET = /^[0-9a-f]{32}$/;
const CWD = { cwd: "/" };

interface Case {
  readonly name: string;
  readonly path: "/line" | "/agent/line";
  readonly words: readonly string[];
  readonly answers: readonly string[];
  readonly human: boolean;
}

const CASES: readonly Case[] = [
  {
    name: "version",
    path: "/line",
    words: ["version"],
    answers: [],
    human: true,
  },
  { name: "kitn", path: "/line", words: ["kitn"], answers: [], human: true },
  {
    name: "allow-y",
    path: "/line",
    words: ["allow:", "kiten ls"],
    answers: ["y"],
    human: true,
  },
  {
    name: "allow-n",
    path: "/line",
    words: ["allow:", "kiten ls"],
    answers: ["n"],
    human: true,
  },
  {
    name: "allow-agent",
    path: "/agent/line",
    words: ["allow:", "kiten ls"],
    answers: ["y"],
    human: true,
  },
  {
    name: "ask-nobody",
    path: "/line",
    words: ["ask", "kiten", "comment", "id:", "1", "text:", "x"],
    answers: [],
    human: false,
  },
];

/** Номер в кадре — на место `<ticket>`, проверив его вид. */
function placeheld(frames: readonly Frame[]): Frame[] {
  return frames.map((frame) => {
    if (!("ticket" in frame)) return frame;
    assertEquals(TICKET.test(String(frame.ticket)), true, String(frame.ticket));
    return { ...frame, ticket: "<ticket>" };
  });
}

/** Кадры WebSocket в виде потока: у `ask` — номер. */
function asStream(frames: readonly Frame[]): Frame[] {
  return frames.map((frame) =>
    "ask" in frame ? { ...frame, ticket: "<ticket>" } : frame
  );
}

function body(one: Case) {
  return { words: one.words, cwd: Deno.cwd(), human: one.human };
}

Deno.test("поток NDJSON равен кадрам WebSocket, ответ кончается вопросом", async (t) => {
  for (const one of CASES) {
    await t.step(one.name, async () => {
      let socket: Frame[] = [];
      await withBack(async (back) => {
        socket = await line(back, one.path, one.words, one.answers, one.human);
      });
      await withBack(async (back) => {
        const responses = await httpLine(
          back,
          one.path,
          body(one),
          one.answers,
        );
        for (const response of responses.slice(0, -1)) {
          assertEquals("ticket" in (response.at(-1) ?? {}), true);
        }
        const frames = placeheld(responses.flat());
        assertEquals(frames, asStream(socket));
        const golden = new URL(
          `testdata/back-http-line/${one.name}.ndjson`,
          import.meta.url,
        );
        assertEquals(
          frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
          await Deno.readTextFile(golden),
        );
      });
    });
  }
});

Deno.test("собранный ответ — склейка кадров потока", async (t) => {
  for (const one of CASES) {
    await t.step(one.name, async () => {
      let streamed: Frame[] = [];
      await withBack(async (back) => {
        streamed = (await httpLine(back, one.path, body(one))).flat();
      });
      await withBack(async (back) => {
        const whole = await collected(
          back,
          await post(back, one.path, body(one), { accept: "application/json" }),
        );
        const fold = (key: "out" | "err") =>
          streamed.filter((frame) => key in frame).map((frame) => frame[key])
            .join("");
        const { out: _o, err: _e, ...tail } = streamed.at(-1) ?? {};
        assertEquals(
          { ...whole, ticket: "ticket" in whole ? "<ticket>" : undefined },
          {
            stdout: fold("out"),
            stderr: fold("err"),
            ...tail,
            ticket: "ticket" in tail ? "<ticket>" : undefined,
          },
        );
      });
    });
  }
});

Deno.test("вопрос номером: да — правило записано, нет — не подтверждено", () =>
  withBack(async (back) => {
    const allow = {
      words: ["allow:", "kiten ls"],
      cwd: Deno.cwd(),
      human: true,
    };
    const [asked, done] = await httpLine(back, "/line", allow, ["y"]);
    assertEquals(
      asked.at(-1)?.ask,
      "изменить правило: kiten ls → allow? [y/N] ",
    );
    assertEquals(TICKET.test(String(asked.at(-1)?.ticket)), true);
    assertEquals(done.at(-1), { exit: 0 });
    assertEquals(
      rulesOf(back.policyFile).find((rule) => rule.path === "kiten ls"),
      { path: "kiten ls", verdict: "allow" },
    );
    const [, refused] = await httpLine(
      back,
      "/line",
      { ...allow, words: ["deny:", "kiten ls"] },
      ["n"],
    );
    assertEquals(refused, [
      { err: "mpu deny: kiten ls: не подтверждено\n" },
      { exit: 1 },
    ]);
  }));

const INVALID = { error: "номер подтверждения недействителен" };

/** Номер вопроса строки `words` на двери `path` с основным токеном. */
async function asked(
  back: TestBack,
  path: string,
  words: readonly string[] = ["allow:", "kiten ls"],
) {
  const frames = await ndjson(
    back,
    await post(back, path, { words, cwd: Deno.cwd(), human: true }),
  );
  const ticket = String(frames.at(-1)?.ticket);
  assertEquals(TICKET.test(ticket), true, JSON.stringify(frames));
  return ticket;
}

async function answer(
  back: TestBack,
  path: string,
  ticket: string,
  agent = false,
) {
  const response = await post(back, `${path}/answer`, { ticket, answer: "y" }, {
    agent,
  });
  // Ответ, не закончивший поток, — отказ теста, а не зависание.
  const text = await within(response.text(), 5000, "тело ответа по номеру");
  back.seen.push(text);
  return { status: response.status, body: text };
}

Deno.test("номер: второй раз, чужая дверь, чужой токен — 404", () =>
  withBack(async (back) => {
    const ticket = await asked(back, "/line");
    assertEquals(await answer(back, "/agent/line", ticket), {
      status: 404,
      body: JSON.stringify(INVALID),
    });
    assertEquals((await answer(back, "/line", ticket)).status, 200);
    assertEquals((await answer(back, "/line", ticket)).status, 404);
    // На двери агента правило не меняется, а решение `ask` спрашивает
    // того, кто пришёл с основным токеном.
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const owners = await asked(back, "/agent/line", [
      "ask",
      "xlsx",
      "alias",
      "ls",
    ]);
    assertEquals((await answer(back, "/agent/line", owners, true)).status, 404);
    assertEquals((await answer(back, "/agent/line", owners)).status, 200);
    assertEquals((await answer(back, "/line", "не номер")).status, 404);
  }));

Deno.test("номер: 120 секунд без ответа — «нет», номер недействителен", async () => {
  using time = new FakeTime();
  await withBack(async (back) => {
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const frames = await ndjson(
      back,
      await post(back, "/line", {
        words: ["ask", "xlsx", "alias", "ls"],
        cwd: Deno.cwd(),
        human: true,
      }),
    );
    const ticket = String(frames.at(-1)?.ticket);
    await time.tickAsync(ANSWER_TIMEOUT_MS);
    assertEquals((await answer(back, "/line", ticket)).status, 404);
    assertEquals(back.called, []);
  });
});

Deno.test("агентский токен: вопроса нет, спросить некого", () =>
  withBack(async (back) => {
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const [frames] = await httpLine(
      back,
      "/agent/line",
      {
        words: ["ask", "xlsx", "alias", "ls"],
        cwd: Deno.cwd(),
        human: true,
      },
      ["y"],
      { agent: true },
    );
    assertEquals(frames, [
      { err: "mpu xlsx alias ls: нужно подтверждение, а спросить некого\n" },
      { exit: 1 },
    ]);
    assertEquals(back.called, []);
  }));

Deno.test("строка, ждущая номера, не держит другую", () =>
  withBack(async (back) => {
    const ticket = await asked(back, "/line");
    const other = await within(
      httpLine(back, "/line", { words: ["version"], cwd: Deno.cwd() }),
      5000,
      "exit строки B",
    );
    assertEquals(other, [[{ out: "0.1.0\n" }, { exit: 0 }]]);
    assertEquals((await answer(back, "/line", ticket)).status, 200);
  }));

/** Строка, чьё исполнение ждёт ворот теста. */
function gated() {
  const gate = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const io: Partial<CommandIo> = {
    readFile: async () => {
      reading.resolve();
      await gate.promise;
      return new Uint8Array();
    },
  };
  return { gate, reading, io };
}

Deno.test("клиент оборвал поток: исполнение до конца, очередь отпущена", async () => {
  const { gate, reading, io } = gated();
  await withBack(async (back) => {
    const abort = new AbortController();
    const response = await post(back, "/line", {
      words: ["xlsx", "ls", "file:", "/a.xlsx"],
      cwd: Deno.cwd(),
    }, { signal: abort.signal });
    await reading.promise;
    await response.body?.cancel();
    abort.abort();
    gate.resolve();
    const next = await within(
      httpLine(back, "/line", { words: ["version"], cwd: Deno.cwd() }),
      5000,
      "строка после оборванной",
    );
    assertEquals(next, [[{ out: "0.1.0\n" }, { exit: 0 }]]);
    assertEquals(back.called, ["xlsx ls"]);
  }, { io });
});

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

Deno.test("вывод больше мегабайта идёт потоком: первый кадр — до exit", async () => {
  const finish = Promise.withResolvers<void>();
  const sql = `SELECT '${"x".repeat(1024 * 1024)}'`;
  await withBack(async (back) => {
    const response = await post(back, "/line", {
      words: ["sql-ro", "dry", "target:", "sl-1", "sql:", sql],
      cwd: Deno.cwd(),
    });
    const reader = response.body?.pipeThrough(new TextDecoderStream())
      .getReader();
    let text = "";
    const firstFrames = async () => {
      while (!text.includes(sql)) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        text += chunk.value;
      }
    };
    // Запись журнала ещё не кончилась — кадра `exit` быть не может.
    await within(firstFrames(), 10_000, "кадр с запросом до конца строки");
    assertEquals(text.includes('"exit"'), false);
    finish.resolve();
    while (true) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      text += chunk.value;
    }
    back.seen.push(text);
    const frames = text.split("\n").filter((row) => row !== "").map((row) =>
      JSON.parse(row) as Frame
    );
    assertEquals(frames.at(-1), { exit: 0 });
    assertEquals(
      frames.filter((frame) => "err" in frame).map((frame) => frame.err).join(
        "",
      )
        .includes(`${sql}\n`),
      true,
    );
  }, {
    io: {
      envFile: {
        get: (name) => SQL_ENV[name],
        values: () => ({ ...SQL_ENV }),
        require: (name) => SQL_ENV[name] ?? "",
        set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      },
    },
    finished: () => finish.promise,
  });
});

Deno.test("Accept: умолчания, веса, 406; тело не JSON — плохой кадр", async (t) => {
  const cases: readonly (readonly [string | undefined, string | number])[] = [
    [undefined, "application/x-ndjson"],
    ["*/*", "application/x-ndjson"],
    ["application/*", "application/x-ndjson"],
    ["application/json", "application/json"],
    ["application/json, application/x-ndjson", "application/x-ndjson"],
    ["application/json;q=0.9, application/x-ndjson;q=0.5", "application/json"],
    ["application/*;q=0.2, application/json", "application/json"],
    ["text/html", 406],
    ["application/json;q=0", 406],
  ];
  for (const [accept, expected] of cases) {
    await t.step(String(accept), () =>
      withBack(async (back) => {
        const response = await post(back, "/line", {
          words: ["version"],
          ...CWD,
        }, { accept });
        const text = await response.text();
        back.seen.push(text);
        if (typeof expected === "number") {
          assertEquals([response.status, text], [expected, ""]);
          return;
        }
        assertEquals(response.headers.get("Content-Type"), expected);
      }));
  }
  await t.step("тело не JSON", () =>
    withBack(async (back) => {
      assertEquals(await ndjson(back, await post(back, "/line", "{")), [
        { err: "mpu-back: плохой кадр строки\n" },
        { exit: 2 },
      ]);
    }));
});

Deno.test("GET и POST на одном пути, прочие методы — 405 с Allow", () =>
  withBack(async (back) => {
    const auth = { Authorization: `Bearer ${back.token}` };
    const put = await request(back, "/line", { method: "PUT", headers: auth });
    assertEquals(put.status, 405);
    const head = await fetch(`${back.url}/agent/line`, {
      method: "DELETE",
      headers: auth,
    });
    await head.body?.cancel();
    assertEquals(head.headers.get("Allow"), "GET, POST");
    assertEquals((await line(back, "/line", ["version"])).at(-1), { exit: 0 });
    assertEquals(
      (await httpLine(back, "/line", { words: ["version"], ...CWD }))[0].at(-1),
      { exit: 0 },
    );
  }));

Deno.test("остановка: поток в работе получает err и exit 1", async () => {
  const { gate, reading, io } = gated();
  await withBack(async (back) => {
    const response = await post(back, "/line", {
      words: ["xlsx", "ls", "file:", "/a.xlsx"],
      cwd: Deno.cwd(),
    });
    await reading.promise;
    const stopping = back.running.stop();
    gate.resolve();
    await stopping;
    assertEquals(await ndjson(back, response), [
      { err: "mpu-back: остановлен\n" },
      { exit: 1 },
    ]);
  }, { io });
});

Deno.test("поток NDJSON: очередь набита — печатающий ждёт читателя", async () => {
  const form = formFor("application/x-ndjson");
  if (form === undefined) throw new Error("формы NDJSON нет");
  let lost = 0;
  const opened = form.open({ lost: () => lost++ });
  const { delivery } = opened;
  // До первого кадра очередь пуста: печатающему ждать нечего.
  await within(delivery.ready(), 5000, "готовность до первого кадра");
  // Отданный кадр набивает очередь потока, и готовность становится
  // обещанием, которое разрешит только сам читатель
  // (`platform/line-cancel.md`).
  delivery.frame({ out: "первый\n" });
  const waiting = delivery.ready();
  assertEquals(await raced(waiting), "ждёт");
  const body = (await opened.response).body;
  if (body === null) throw new Error("у ответа NDJSON нет тела");
  const reader = body.getReader();
  await within(reader.read(), 5000, "первый кадр читателю");
  await within(waiting, 5000, "готовность после чтения");
  // Читатель ушёл — ждущие отпускаются, иначе печатающий встал бы
  // навсегда и с ним остановка сервера.
  delivery.frame({ out: "второй\n" });
  const orphan = delivery.ready();
  await reader.cancel();
  await within(orphan, 5000, "готовность после ухода читателя");
  assertEquals(lost, 1);
});

/** Разрешилось обещание к этому моменту или ещё ждёт. */
function raced(promise: Promise<void>): Promise<string> {
  return Promise.race([
    promise.then(() => "разрешилось"),
    // Спуск очереди микрозадач: дальше продвинуться можно только от
    // внешнего события, которого в этот момент нет.
    new Promise<string>((resolve) => setTimeout(() => resolve("ждёт"), 0)),
  ]);
}
