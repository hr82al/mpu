/**
 * Контекст вызова (`platform/call-context.md`): ввод, терминальность и
 * переменные приходят первым кадром и действуют ровно на свою строку.
 *
 * Эталон — прогон настоящих команд через сервер, а не разбор объектов:
 * `mpu confirm` печатает полученный ввод и диагностику трёх std-fd,
 * `mpu glab-status` верстает таблицу по ширине консоли. Копии кадров —
 * `testdata/call-context/`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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
  client.send({ words, cwd: Deno.cwd(), human: true, ...context });
  return await client.finished();
}

/** Каталог клиента в голдене: у прогона он свой на каждой машине. */
const CWD_IN_GOLDEN = "<cwd клиента>";

/** Копия кадров в голдене канала совпадает с прогоном. */
async function golden(name: string, body: unknown) {
  const url = new URL(`testdata/call-context/${name}`, import.meta.url);
  assertEquals(body, JSON.parse(await Deno.readTextFile(url)));
}

Deno.test("ввод по запросу: доходит до команды, без поля — пусто", () =>
  withBack(async (back) => {
    const first = {
      words: ["confirm", "yes"],
      cwd: Deno.cwd(),
      human: true,
      stdinOnRequest: true,
    };
    const reply = { stdin: "текст\n" };
    const client = new Client(back, "/line", { stdin: reply.stdin });
    await client.opened();
    client.send(first);
    const frames = await client.finished();
    assertEquals(frames, [
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
    assertEquals(await line(back, "/line", ["confirm", "yes"]), [
      { err: "\n" },
      { out: "" },
      { exit: 0 },
    ]);
  }));

Deno.test("ввод полем кадра: доходит до команды, как до порции 165c", () =>
  withBack(async (back) => {
    const frames = await lineWith(back, ["confirm", "yes"], {
      stdin: "текст\n",
    });
    assertEquals(frames, [
      { err: "текст\n" },
      { out: "текст\n" },
      { exit: 0 },
    ]);
  }));

Deno.test("ввод: пустая строка — это ввод", () =>
  withBack(async (back) => {
    assertEquals(await lineWith(back, ["confirm", "yes"], { stdin: "" }), [
      { err: "\n" },
      { out: "" },
      { exit: 0 },
    ]);
  }));

Deno.test("ввод больше предела: отказ до исполнения, по обеим дверям", async (t) => {
  const big = "a".repeat(MAX_STDIN_BYTES + 1);
  const refusal: readonly Frame[] = [
    { err: "mpu-back: ввод больше 8 МиБ\n" },
    { exit: 2 },
  ];
  await t.step("WebSocket", () =>
    withBack(async (back) => {
      assertEquals(await lineWith(back, ["confirm", "yes"], { stdin: big }), [
        ...refusal,
      ]);
      // Строка не исполнялась: команда не вызвана.
      assertEquals(back.called, []);
    }));
  await t.step("простой HTTP", () =>
    withBack(async (back) => {
      const frames = await ndjson(
        back,
        await post(back, "/line", {
          words: ["confirm", "yes"],
          cwd: Deno.cwd(),
          stdin: big,
        }),
      );
      assertEquals(frames, [...refusal]);
      assertEquals(back.called, []);
    }));
});

Deno.test("терминальность: из кадра, а не из дескрипторов сервера", () =>
  withBack(async (back) => {
    // `human: false` — спросить некого, и `confirm` печатает свою
    // диагностику трёх потоков; она и описывает терминальность
    // клиента, пришедшую кадром (`platform/line-prompt.md`).
    const asked = await lineWith(back, ["confirm"], {
      human: false,
      tty: { stdin: false, stdout: true, stderr: true },
    });
    const diagnostics = asked.map((frame) => frame.err ?? "").join("");
    assertStringIncludes(diagnostics, "fd 0 (stdin): isatty=false\n");
    assertStringIncludes(diagnostics, "fd 1 (stdout): isatty=true\n");
    assertStringIncludes(diagnostics, "fd 2 (stderr): isatty=true\n");
    assertEquals(asked.at(-1), { exit: 2 });
    // Поля нет — все три в канале, как до порции 11.
    const silent = await line(back, "/line", ["confirm"], [], false);
    assertStringIncludes(
      silent.map((frame) => frame.err ?? "").join(""),
      "fd 1 (stdout): isatty=false\n",
    );
  }));

Deno.test("ширина консоли: из кадра клиента, а не из консоли сервера", () =>
  withGitlab(async (back) => {
    const wide = await lineWith(back, MR_WORDS, {});
    const narrow = await lineWith(back, MR_WORDS, {
      tty: { stdin: false, stdout: true, stderr: true, columns: 60 },
    });
    assertStringIncludes(String(wide[0].out), `${LONG_TITLE}\n`);
    assertStringIncludes(String(narrow[0].out), "feat(scope…\n");
    assertEquals(wide.at(-1), { exit: 0 });
    assertEquals(narrow.at(-1), { exit: 0 });
  }));

Deno.test("ширина без терминала и вне границ — отказ кадром", async (t) => {
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
    await t.step(name, () =>
      withBack(async (back) => {
        assertEquals(await lineWith(back, ["version"], { tty }), [
          { err: `mpu-back: ${report}\n` },
          { exit: 2 },
        ]);
        assertEquals(back.called, []);
      }));
  }
});

Deno.test("переменные: имя вне списка — отказ по имени, без значения", () =>
  withBack(async (back) => {
    const first = {
      words: ["version"],
      cwd: Deno.cwd(),
      human: true,
      env: { HOME: "/дом-клиента" },
    };
    const frames = await lineWith(back, first.words, { env: first.env });
    assertEquals(frames, [
      { err: "mpu-back: переменная вне списка: HOME\n" },
      { exit: 2 },
    ]);
    assertEquals(back.called, []);
    await golden("frames-env-reject.json", {
      first: { ...first, cwd: CWD_IN_GOLDEN },
      frames,
    });
    assertEquals(
      back.seen.some((text) => text.includes("/дом-клиента")),
      false,
    );
    // Цель подключения к базе не принимается тем же правилом.
    assertEquals(
      await lineWith(back, ["version"], { env: { PGHOST: "прод" } }),
      [
        { err: "mpu-back: переменная вне списка: PGHOST\n" },
        { exit: 2 },
      ],
    );
  }));

Deno.test("переменные действуют на свою строку и не трогают сервер", async () => {
  const before = Deno.env.get("COLUMNS");
  Deno.env.set("COLUMNS", "60");
  try {
    await withGitlab(async (back) => {
      // Строка А со своей шириной: 200 знакомест — заголовок целиком.
      const own = await lineWith(back, MR_WORDS, { env: { COLUMNS: "200" } });
      assertStringIncludes(String(own[0].out), `${LONG_TITLE}\n`);
      // Строка Б без поля: окружение сервера, то есть 60.
      const next = await lineWith(back, MR_WORDS, {});
      assertStringIncludes(String(next[0].out), "feat(scope…\n");
      // Окружение процесса сервера не изменилось.
      assertEquals(Deno.env.get("COLUMNS"), "60");
    }, { env: (name: string) => Deno.env.get(name) });
  } finally {
    if (before === undefined) Deno.env.delete("COLUMNS");
    else Deno.env.set("COLUMNS", before);
  }
});

Deno.test("вопрос по номеру: исполнение видит тот же контекст", () =>
  withBack(async (back) => {
    assertEquals(
      (await line(back, "/line", ["ask:", "confirm"], ["y"])).at(-1),
      { exit: 0 },
    );
    const responses = await httpLine(back, "/line", {
      words: ["ask", "confirm", "yes"],
      cwd: Deno.cwd(),
      human: true,
      stdin: "через номер\n",
    }, ["y"]);
    const [asked, resumed] = responses;
    assertEquals(asked.length, 1);
    assertEquals(asked[0].ask, "выполнить mpu confirm yes? [y/N] ");
    assertEquals(resumed, [
      { err: "через номер\n" },
      { out: "через номер\n" },
      { exit: 0 },
    ]);
  }));

Deno.test("контекст в теле ответа по номеру — 400, номер цел", () =>
  withBack(async (back) => {
    await line(back, "/line", ["ask:", "confirm"], ["y"]);
    const asked = await ndjson(
      back,
      await post(back, "/line", {
        words: ["ask", "confirm", "yes"],
        cwd: Deno.cwd(),
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
      assertEquals(response.status, 400);
      assertEquals(await collected(back, response), {
        error: "контекст вызова в ответе не принимается",
      });
    }
    // Номер цел: строка продолжается тем же вводом, что пришёл первым
    // запросом.
    const resumed = await ndjson(
      back,
      await post(back, "/line/answer", { ticket, answer: "y" }),
    );
    assertEquals(resumed, [
      { err: "первый\n" },
      { out: "первый\n" },
      { exit: 0 },
    ]);
  }));

Deno.test("ни ввод, ни значения переменных не доходят до журнала", () =>
  withBack(async (back) => {
    const frames = await lineWith(back, ["version"], {
      stdin: "вв0д-м4ркер\n",
      env: { TERM: "терм-м4ркер", NO_COLOR: "цвет-м4ркер" },
      tty: { stdin: false, stdout: true, stderr: true, columns: 80 },
    });
    assertEquals(frames.at(-1), { exit: 0 });
    // Строка исполнилась, а не отказала: иначе журналу и нечего было бы
    // показать.
    assertEquals(typeof frames[0].out, "string");
    const markers = ["вв0д-м4ркер", "терм-м4ркер", "цвет-м4ркер"];
    for (const text of [...back.logged, ...back.seen, ...back.diagnosed]) {
      for (const marker of markers) {
        assertEquals(text.includes(marker), false, `${marker} в «${text}»`);
      }
    }
    assertEquals((await request(back, "/health")).status, 200);
  }));

Deno.test("схема кадров называет те же пределы, что код", () => {
  const first = SCHEMA.$defs["line.client.first"].properties;
  assertEquals(first.tty.properties.columns.minimum, 1);
  assertEquals(first.tty.properties.columns.maximum, 10_000);
  assertStringIncludes(first.stdin.description, "8 МиБ");
  assertEquals(
    first.env.propertyNames.enum,
    [
      "COLUMNS",
      "NO_COLOR",
      "TERM",
      "TERM_PROGRAM",
      "COLORTERM",
      "TMUX",
      "WT_SESSION",
      "OS",
    ],
  );
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
  const stand = startFakeGitlab(() => Response.json(MR));
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
