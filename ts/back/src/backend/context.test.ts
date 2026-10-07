/**
 * Контекст вызова (`platform/call-context.md`): ввод, терминальность и
 * переменные приходят первым кадром и действуют ровно на свою строку.
 *
 * Эталон — прогон настоящих команд через сервер, а не разбор объектов:
 * `mpu confirm` печатает полученный ввод и диагностику трёх std-fd,
 * `mpu glab-status` верстает таблицу по ширине консоли. Копии кадров —
 * `testdata/call-context/`.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIo } from "../command/mod.ts";
import { MAX_STDIN_BYTES } from "../frames/mod.ts";
import { startFakeGitlab } from "../gitlab/testing.ts";
import {
  Client,
  collected,
  type Frame,
  httpLine,
  line,
  ndjson,
  post,
  request,
  type TestBack,
  withBack,
} from "./testback.ts";
import SCHEMA from "./schema.json" with { type: "json" };

/** Первый кадр со словами и контекстом; кадры — до `exit`. */
async function lineWith(
  back: TestBack,
  words: readonly string[],
  context: Record<string, unknown>,
  path = "/line",
): Promise<Frame[]> {
  const client = new Client(back, path);
  await client.opened();
  client.send({ words, cwd: process.cwd(), human: true, ...context });
  return await client.finished();
}

/** Каталог клиента в голдене: у прогона он свой на каждой машине. */
const CWD_IN_GOLDEN = "<cwd клиента>";

/** Копия кадров в голдене канала совпадает с прогоном. */
async function golden(name: string, body: unknown) {
  const url = new URL(`testdata/call-context/${name}`, import.meta.url);
  expect(body).toStrictEqual(JSON.parse(await readFile(url, "utf8")));
}

it("ввод по запросу: доходит до команды, без поля — пусто", () =>
  withBack(async (back) => {
    const first = {
      words: ["confirm", "yes"],
      cwd: process.cwd(),
      human: true,
      stdinOnRequest: true,
    };
    const reply = { stdin: "текст\n" };
    const client = new Client(back, "/line", { stdin: reply.stdin });
    await client.opened();
    client.send(first);
    const frames = await client.finished();
    expect(frames).toStrictEqual([
      { stdinRequest: true },
      { err: "текст\n" },
      { out: "текст\n" },
      { exit: 0 },
    ]);
    // Разговор по порядку: ответ клиента уходит сразу за запросом.
    await golden("frames-stdin.json", {
      first: { ...first, cwd: CWD_IN_GOLDEN },
      frames: [frames[0], reply, ...frames.slice(1)],
    });
    // Поля нет — ввод пуст, как до порции 11.
    expect(await line(back, "/line", ["confirm", "yes"])).toStrictEqual([
      { err: "\n" },
      { out: "" },
      { exit: 0 },
    ]);
  }));

it("ввод полем кадра: доходит до команды, как до порции 165c", () =>
  withBack(async (back) => {
    const frames = await lineWith(back, ["confirm", "yes"], {
      stdin: "текст\n",
    });
    expect(frames).toStrictEqual([
      { err: "текст\n" },
      { out: "текст\n" },
      { exit: 0 },
    ]);
  }));

it("ввод: пустая строка — это ввод", () =>
  withBack(async (back) => {
    expect(await lineWith(back, ["confirm", "yes"], { stdin: "" }))
      .toStrictEqual([
        { err: "\n" },
        { out: "" },
        { exit: 0 },
      ]);
  }));

describe("ввод больше предела: отказ до исполнения, по обеим дверям", () => {
  const big = "a".repeat(MAX_STDIN_BYTES + 1);
  const refusal: readonly Frame[] = [
    { err: "mpu-back: ввод больше 8 МиБ\n" },
    { exit: 2 },
  ];
  it("WebSocket", () =>
    withBack(async (back) => {
      expect(await lineWith(back, ["confirm", "yes"], { stdin: big }))
        .toStrictEqual([
          ...refusal,
        ]);
      // Строка не исполнялась: команда не вызвана.
      expect(back.called).toStrictEqual([]);
    }));
  it("простой HTTP", () =>
    withBack(async (back) => {
      const frames = await ndjson(
        back,
        await post(back, "/line", {
          words: ["confirm", "yes"],
          cwd: process.cwd(),
          stdin: big,
        }),
      );
      expect(frames).toStrictEqual([...refusal]);
      expect(back.called).toStrictEqual([]);
    }));
});

it("терминальность: из кадра, а не из дескрипторов сервера", () =>
  withBack(async (back) => {
    // `human: false` — спросить некого, и `confirm` печатает свою
    // диагностику трёх потоков; она и описывает терминальность
    // клиента, пришедшую кадром (`platform/line-prompt.md`).
    const asked = await lineWith(back, ["confirm"], {
      human: false,
      tty: { stdin: false, stdout: true, stderr: true },
    });
    const diagnostics = asked.map((frame) => frame.err ?? "").join("");
    expect(diagnostics).toContain("fd 0 (stdin): isatty=false\n");
    expect(diagnostics).toContain("fd 1 (stdout): isatty=true\n");
    expect(diagnostics).toContain("fd 2 (stderr): isatty=true\n");
    expect(asked.at(-1)).toStrictEqual({ exit: 2 });
    // Поля нет — все три в канале, как до порции 11.
    const silent = await line(back, "/line", ["confirm"], [], false);
    expect(silent.map((frame) => frame.err ?? "").join("")).toContain(
      "fd 1 (stdout): isatty=false\n",
    );
  }));

it("ширина консоли: из кадра клиента, а не из консоли сервера", () =>
  withGitlab(async (back) => {
    const wide = await lineWith(back, MR_WORDS, {});
    const narrow = await lineWith(back, MR_WORDS, {
      tty: { stdin: false, stdout: true, stderr: true, columns: 60 },
    });
    expect(String(wide[0].out)).toContain(`${LONG_TITLE}\n`);
    expect(String(narrow[0].out)).toContain("feat(scope…\n");
    expect(wide.at(-1)).toStrictEqual({ exit: 0 });
    expect(narrow.at(-1)).toStrictEqual({ exit: 0 });
  }));

describe("ширина без терминала и вне границ — отказ кадром", () => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    [
      "stdout не терминал",
      { stdout: false, columns: 120 },
      "ширина без терминала",
    ],
    ["ноль", { stdout: true, columns: 0 }, "плохой кадр строки"],
    ["больше предела", { stdout: true, columns: 10001 }, "плохой кадр строки"],
    ["не целое", { stdout: true, columns: 99.5 }, "плохой кадр строки"],
  ];
  for (const [name, tty, report] of cases) {
    it(name, () =>
      withBack(async (back) => {
        expect(await lineWith(back, ["version"], { tty })).toStrictEqual([
          { err: `mpu-back: ${report}\n` },
          { exit: 2 },
        ]);
        expect(back.called).toStrictEqual([]);
      }));
  }
});

it("переменные: имя вне списка — отказ по имени, без значения", () =>
  withBack(async (back) => {
    const first = {
      words: ["version"],
      cwd: process.cwd(),
      human: true,
      env: { HOME: "/дом-клиента" },
    };
    const frames = await lineWith(back, first.words, { env: first.env });
    expect(frames).toStrictEqual([
      { err: "mpu-back: переменная вне списка: HOME\n" },
      { exit: 2 },
    ]);
    expect(back.called).toStrictEqual([]);
    await golden("frames-env-reject.json", {
      first: { ...first, cwd: CWD_IN_GOLDEN },
      frames,
    });
    expect(back.seen.some((text) => text.includes("/дом-клиента"))).toBe(false);
    // Цель подключения к базе не принимается тем же правилом.
    expect(await lineWith(back, ["version"], { env: { PGHOST: "прод" } }))
      .toStrictEqual([
        { err: "mpu-back: переменная вне списка: PGHOST\n" },
        { exit: 2 },
      ]);
  }));

it("переменные действуют на свою строку и не трогают сервер", async () => {
  const before = process.env.COLUMNS;
  process.env.COLUMNS = "60";
  try {
    await withGitlab(async (back) => {
      // Строка А со своей шириной: 200 знакомест — заголовок целиком.
      const own = await lineWith(back, MR_WORDS, { env: { COLUMNS: "200" } });
      expect(String(own[0].out)).toContain(`${LONG_TITLE}\n`);
      // Строка Б без поля: окружение сервера, то есть 60.
      const next = await lineWith(back, MR_WORDS, {});
      expect(String(next[0].out)).toContain("feat(scope…\n");
      // Окружение процесса сервера не изменилось.
      expect(process.env.COLUMNS).toBe("60");
    }, { env: (name: string) => process.env[name] });
  } finally {
    if (before === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = before;
  }
});

it("вопрос по номеру: исполнение видит тот же контекст", () =>
  withBack(async (back) => {
    expect((await line(back, "/line", ["ask:", "confirm"], ["y"])).at(-1))
      .toStrictEqual({ exit: 0 });
    const responses = await httpLine(back, "/line", {
      words: ["ask", "confirm", "yes"],
      cwd: process.cwd(),
      human: true,
      stdin: "через номер\n",
    }, ["y"]);
    const [asked, resumed] = responses;
    expect(asked.length).toBe(1);
    expect(asked[0].ask).toBe("выполнить mpu confirm yes? [y/N] ");
    expect(resumed).toStrictEqual([
      { err: "через номер\n" },
      { out: "через номер\n" },
      { exit: 0 },
    ]);
  }));

it("контекст в теле ответа по номеру — 400, номер цел", () =>
  withBack(async (back) => {
    await line(back, "/line", ["ask:", "confirm"], ["y"]);
    const asked = await ndjson(
      back,
      await post(back, "/line", {
        words: ["ask", "confirm", "yes"],
        cwd: process.cwd(),
        human: true,
        stdin: "первый\n",
      }),
    );
    const ticket = String(asked[0].ticket);
    for (const extra of [{ stdin: "второй\n" }, { tty: {} }, { env: {} }]) {
      const response = await post(back, "/line/answer", {
        ticket,
        answer: "y",
        ...extra,
      });
      expect(response.status).toBe(400);
      expect(await collected(back, response)).toStrictEqual({
        error: "контекст вызова в ответе не принимается",
      });
    }
    // Номер цел: строка продолжается тем же вводом, что пришёл первым
    // запросом.
    const resumed = await ndjson(
      back,
      await post(back, "/line/answer", { ticket, answer: "y" }),
    );
    expect(resumed).toStrictEqual([
      { err: "первый\n" },
      { out: "первый\n" },
      { exit: 0 },
    ]);
  }));

it("ни ввод, ни значения переменных не доходят до журнала", () =>
  withBack(async (back) => {
    const frames = await lineWith(back, ["version"], {
      stdin: "вв0д-м4ркер\n",
      env: { TERM: "терм-м4ркер", NO_COLOR: "цвет-м4ркер" },
      tty: { stdin: false, stdout: true, stderr: true, columns: 80 },
    });
    expect(frames.at(-1)).toStrictEqual({ exit: 0 });
    // Строка исполнилась, а не отказала: иначе журналу и нечего было бы
    // показать.
    expect(typeof frames[0].out).toBe("string");
    const markers = ["вв0д-м4ркер", "терм-м4ркер", "цвет-м4ркер"];
    for (const text of [...back.logged, ...back.seen, ...back.diagnosed]) {
      for (const marker of markers) {
        expect(text.includes(marker), `${marker} в «${text}»`).toBe(false);
      }
    }
    expect((await request(back, "/health")).status).toBe(200);
  }));

it("схема кадров называет те же пределы, что код", () => {
  const first = SCHEMA.$defs["line.client.first"].properties;
  expect(first.tty.properties.columns.minimum).toBe(1);
  expect(first.tty.properties.columns.maximum).toBe(10_000);
  expect(first.stdin.description).toContain("8 МиБ");
  expect(first.env.propertyNames.enum).toStrictEqual([
    "COLUMNS",
    "NO_COLOR",
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "TMUX",
    "WT_SESSION",
    "OS",
  ]);
});

/** Заголовок MR, который усекается ровно на узкой консоли. */
const LONG_TITLE =
  "feat(scope): очень длинный заголовок, который обязан усечься по ширине";

const MR_WORDS = ["glab-status", "mr:", "group/repo!456"];

const MR = {
  iid: 456,
  title: LONG_TITLE,
  state: "opened",
  source_branch: "feat/scope/change",
  target_branch: "main",
  web_url: "https://gitlab.example.test/group/repo/-/merge_requests/456",
  author: { name: "Имя", username: "user" },
  project_id: 1001,
  sha: "9ed053dea34858fe964ab55d8607eb4b1d0b62ac",
};

/**
 * Сервер, у которого команда `glab-status` ходит к стенду GitLab на
 * петле: живого GitLab у теста нет, а ширина видна только у команды,
 * которая верстает таблицу.
 */
async function withGitlab(
  body: (back: TestBack) => Promise<void>,
  io: Partial<CommandIo> = {},
): Promise<void> {
  const stand = await startFakeGitlab(() => Response.json(MR));
  try {
    await withBack(body, {
      io: {
        envFile: {
          get: (name: string) =>
            name === "GITLAB_BASE_URL" ? stand.baseUrl : undefined,
          require: (name: string) => {
            if (name === "GLAB_TOKEN") return "glpat-proba";
            throw new Error(`нет ключа ${name}`);
          },
          set: () => Promise.reject(new Error("не ожидается")),
          values: () => ({}),
        },
        ...io,
      },
    });
  } finally {
    await stand.stop();
  }
}
