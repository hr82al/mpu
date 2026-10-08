/**
 * Строка простым HTTP (`platform/back-http-line.md`): те же кадры, что у
 * WebSocket; собранный ответ — их склейка; вопрос — номером, одноразовым,
 * своей двери и своего токена; поток — по мере появления.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { fakeTimers } from "../vitest/scope.ts";
import type { CommandIo } from "@mpu/command";
import { rulesOf } from "../line/mod.ts";
import {
  ASK,
  NOBODY_TO_ASK,
  NOT_CONFIRMED,
  RuleBook,
  RulePath,
} from "@mpu/command/policy";
import { formFor } from "./http.ts";
import { WHOLE } from "./outlet.ts";
import { ANSWER_TIMEOUT_MS } from "./mod.ts";
import {
  collected,
  type Frame,
  httpLine,
  line,
  ndjson,
  post,
  refusalFrame,
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
    expect(TICKET.test(String(frame.ticket)), String(frame.ticket)).toBe(true);
    return { ...frame, ticket: "<ticket>" };
  });
}

/** Кадры WebSocket в виде потока: у `ask` — номер. */
function asStream(frames: readonly Frame[]): Frame[] {
  return frames.map((frame) =>
    "ask" in frame ? { ...frame, ticket: "<ticket>" } : frame,
  );
}

function body(one: Case) {
  return { words: one.words, cwd: process.cwd(), human: one.human };
}

describe("поток NDJSON равен кадрам WebSocket, ответ кончается вопросом", () => {
  for (const one of CASES) {
    it(one.name, async () => {
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
          expect("ticket" in (response.at(-1) ?? {})).toBe(true);
        }
        const frames = placeheld(responses.flat());
        expect(frames).toStrictEqual(asStream(socket));
        const golden = new URL(
          `testdata/back-http-line/${one.name}.ndjson`,
          import.meta.url,
        );
        expect(
          frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
        ).toStrictEqual(await readFile(golden, "utf8"));
      });
    });
  }
});

describe("собранный ответ — склейка кадров потока", () => {
  for (const one of CASES) {
    it(one.name, async () => {
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
          streamed
            .filter((frame) => key in frame)
            .map((frame) => frame[key])
            .join("");
        const { out: _o, err: _e, ...tail } = streamed.at(-1) ?? {};
        const refused = streamed.find((frame) => "refusal" in frame) ?? {};
        expect({
          ...whole,
          ticket: "ticket" in whole ? "<ticket>" : undefined,
        }).toStrictEqual({
          stdout: fold("out"),
          stderr: fold("err"),
          ...refused,
          ...tail,
          ticket: "ticket" in tail ? "<ticket>" : undefined,
        });
      });
    });
  }
});

it("вопрос номером: да — правило записано, нет — не подтверждено", () =>
  withBack(async (back) => {
    const allow = {
      words: ["allow:", "kiten ls"],
      cwd: process.cwd(),
      human: true,
    };
    const [asked, done] = await httpLine(back, "/line", allow, ["y"]);
    expect(asked.at(-1)?.ask).toBe(
      "изменить правило: kiten ls → allow? [y/N] ",
    );
    expect(TICKET.test(String(asked.at(-1)?.ticket))).toBe(true);
    expect(done.at(-1)).toStrictEqual({ exit: 0 });
    expect(
      rulesOf(back.policyFile).find((rule) => rule.path === "kiten ls"),
    ).toStrictEqual({ path: "kiten ls", verdict: "allow" });
    const [, refused] = await httpLine(
      back,
      "/line",
      { ...allow, words: ["deny:", "kiten ls"] },
      ["n"],
    );
    expect(refused).toStrictEqual([
      refusalFrame(NOT_CONFIRMED, `mpu deny: kiten ls: ${NOT_CONFIRMED}`),
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
    await post(back, path, { words, cwd: process.cwd(), human: true }),
  );
  const ticket = String(frames.at(-1)?.ticket);
  expect(TICKET.test(ticket), JSON.stringify(frames)).toBe(true);
  return ticket;
}

async function answer(
  back: TestBack,
  path: string,
  ticket: string,
  agent = false,
) {
  const response = await post(
    back,
    `${path}/answer`,
    { ticket, answer: "y" },
    {
      agent,
    },
  );
  // Ответ, не закончивший поток, — отказ теста, а не зависание.
  const text = await within(response.text(), 5000, "тело ответа по номеру");
  back.seen.push(text);
  return { status: response.status, body: text };
}

it("номер: второй раз, чужая дверь, чужой токен — 404", () =>
  withBack(async (back) => {
    const ticket = await asked(back, "/line");
    expect(await answer(back, "/agent/line", ticket)).toStrictEqual({
      status: 404,
      body: JSON.stringify(INVALID),
    });
    expect((await answer(back, "/line", ticket)).status).toBe(200);
    expect((await answer(back, "/line", ticket)).status).toBe(404);
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
    expect((await answer(back, "/agent/line", owners, true)).status).toBe(404);
    expect((await answer(back, "/agent/line", owners)).status).toBe(200);
    expect((await answer(back, "/line", "не номер")).status).toBe(404);
  }));

it("номер: 120 секунд без ответа — «нет», номер недействителен", async () => {
  fakeTimers();
  await withBack(async (back) => {
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const frames = await ndjson(
      back,
      await post(back, "/line", {
        words: ["ask", "xlsx", "alias", "ls"],
        cwd: process.cwd(),
        human: true,
      }),
    );
    const ticket = String(frames.at(-1)?.ticket);
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS);
    expect((await answer(back, "/line", ticket)).status).toBe(404);
    expect(back.called).toStrictEqual([]);
  });
});

it("агентский токен: вопроса нет, спросить некого", () =>
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
        cwd: process.cwd(),
        human: true,
      },
      ["y"],
      { agent: true },
    );
    expect(frames).toStrictEqual([
      refusalFrame(NOBODY_TO_ASK, `mpu xlsx alias ls: ${NOBODY_TO_ASK}`),
      { err: "mpu xlsx alias ls: нужно подтверждение, а спросить некого\n" },
      { exit: 1 },
    ]);
    expect(back.called).toStrictEqual([]);
  }));

it("строка, ждущая номера, не держит другую", () =>
  withBack(async (back) => {
    const ticket = await asked(back, "/line");
    const other = await within(
      httpLine(back, "/line", { words: ["version"], cwd: process.cwd() }),
      5000,
      "exit строки B",
    );
    expect(other).toStrictEqual([[{ out: "0.1.0\n" }, { exit: 0 }]]);
    expect((await answer(back, "/line", ticket)).status).toBe(200);
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

it("клиент оборвал поток: исполнение до конца, очередь отпущена", async () => {
  const { gate, reading, io } = gated();
  await withBack(
    async (back) => {
      const abort = new AbortController();
      const response = await post(
        back,
        "/line",
        {
          words: ["xlsx", "ls", "file:", "/a.xlsx"],
          cwd: process.cwd(),
        },
        { signal: abort.signal },
      );
      await reading.promise;
      await response.body?.cancel();
      abort.abort();
      gate.resolve();
      const next = await within(
        httpLine(back, "/line", { words: ["version"], cwd: process.cwd() }),
        5000,
        "строка после оборванной",
      );
      expect(next).toStrictEqual([[{ out: "0.1.0\n" }, { exit: 0 }]]);
      expect(back.called).toStrictEqual(["xlsx ls"]);
    },
    { io },
  );
});

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

it("вывод больше мегабайта идёт потоком: первый кадр — до exit", async () => {
  const finish = Promise.withResolvers<void>();
  const sql = `SELECT '${"x".repeat(1024 * 1024)}'`;
  await withBack(
    async (back) => {
      const response = await post(back, "/line", {
        words: ["sql-ro", "dry", "target:", "sl-1", "sql:", sql],
        cwd: process.cwd(),
      });
      const reader = response.body
        ?.pipeThrough(new TextDecoderStream())
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
      expect(text.includes('"exit"')).toBe(false);
      finish.resolve();
      while (true) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        text += chunk.value;
      }
      back.seen.push(text);
      const frames = text
        .split("\n")
        .filter((row) => row !== "")
        .map((row) => JSON.parse(row) as Frame);
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      expect(
        frames
          .filter((frame) => "err" in frame)
          .map((frame) => frame.err)
          .join("")
          .includes(`${sql}\n`),
      ).toBe(true);
    },
    {
      io: {
        envFile: {
          get: (name) => SQL_ENV[name],
          values: () => ({ ...SQL_ENV }),
          require: (name) => SQL_ENV[name] ?? "",
          set: () => Promise.reject(new Error("запись env-файла не ожидается")),
        },
      },
      finished: () => finish.promise,
    },
  );
});

describe("Accept: умолчания, веса, 406; тело не JSON — плохой кадр", () => {
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
    it(String(accept), () =>
      withBack(async (back) => {
        const response = await post(
          back,
          "/line",
          {
            words: ["version"],
            ...CWD,
          },
          { accept },
        );
        const text = await response.text();
        back.seen.push(text);
        if (typeof expected === "number") {
          expect([response.status, text]).toStrictEqual([expected, ""]);
          return;
        }
        expect(response.headers.get("Content-Type")).toStrictEqual(expected);
      }),
    );
  }
  it("тело не JSON", () =>
    withBack(async (back) => {
      expect(await ndjson(back, await post(back, "/line", "{"))).toStrictEqual([
        { err: "mpu-back: плохой кадр строки\n" },
        { exit: 2 },
      ]);
    }));
});

it("GET и POST на одном пути, прочие методы — 405 с Allow", () =>
  withBack(async (back) => {
    const auth = { Authorization: `Bearer ${back.token}` };
    const put = await request(back, "/line", { method: "PUT", headers: auth });
    expect(put.status).toBe(405);
    const head = await fetch(`${back.url}/agent/line`, {
      method: "DELETE",
      headers: auth,
    });
    await head.body?.cancel();
    expect(head.headers.get("Allow")).toBe("GET, POST");
    expect((await line(back, "/line", ["version"])).at(-1)).toStrictEqual({
      exit: 0,
    });
    expect(
      (await httpLine(back, "/line", { words: ["version"], ...CWD }))[0].at(-1),
    ).toStrictEqual({ exit: 0 });
  }));

it("остановка: поток в работе получает err и exit 1", async () => {
  const { gate, reading, io } = gated();
  await withBack(
    async (back) => {
      const response = await post(back, "/line", {
        words: ["xlsx", "ls", "file:", "/a.xlsx"],
        cwd: process.cwd(),
      });
      await reading.promise;
      const stopping = back.running.stop();
      gate.resolve();
      await stopping;
      expect(await ndjson(back, response)).toStrictEqual([
        { err: "mpu-back: остановлен\n" },
        { exit: 1 },
      ]);
    },
    { io },
  );
});

it("поток NDJSON: очередь набита — печатающий ждёт читателя", async () => {
  const form = formFor("application/x-ndjson");
  if (form === undefined) throw new Error("формы NDJSON нет");
  let lost = 0;
  const opened = form.open({ lost: () => lost++, outlet: () => WHOLE });
  const { delivery } = opened;
  // До первого кадра очередь пуста: печатающему ждать нечего.
  await within(delivery.ready(), 5000, "готовность до первого кадра");
  // Отданный кадр набивает очередь потока, и готовность становится
  // обещанием, которое разрешит только сам читатель
  // (`platform/line-cancel.md`).
  delivery.frame({ out: "первый\n" });
  const waiting = delivery.ready();
  expect(await raced(waiting)).toBe("ждёт");
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
  expect(lost).toBe(1);
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
