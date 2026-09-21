/**
 * Клиент на проводе (`cli-client.md`): дверь и токен по доступному,
 * вопрос человеку, кадры в потоки, свои отказы. Сервер — записывающий.
 */

import { assertEquals } from "@std/assert";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer } from "./testkit.ts";

const MAIN = "main-" + "t0ken";
const AGENT = "agent-" + "t0ken";

Deno.test("канал и токен: три строки таблицы", async (t) => {
  const rows = [
    {
      main: MAIN,
      agent: AGENT,
      terminals: true,
      path: "/line",
      human: true,
      token: MAIN,
    },
    {
      main: MAIN,
      agent: AGENT,
      terminals: false,
      path: "/line",
      human: false,
      token: MAIN,
    },
    {
      main: undefined,
      agent: AGENT,
      terminals: true,
      path: "/agent/line",
      human: false,
      token: AGENT,
    },
    {
      main: undefined,
      agent: AGENT,
      terminals: false,
      path: "/agent/line",
      human: false,
      token: AGENT,
    },
  ];
  for (const row of rows) {
    await t.step(
      `${row.path} ${row.terminals} ${row.main !== undefined}`,
      () =>
        withFakeServer(async (base, visits) => {
          const run = testEnv({ base, ...row });
          assertEquals(await runClient(["version"], run.env), 0);
          assertEquals(visits.map((visit) => [visit.path, visit.token]), [
            [row.path, row.token],
          ]);
          // Первый кадр несёт и контекст вызова: терминальность —
          // всегда, ввод — только из пайпа (`platform/call-context.md`).
          assertEquals(visits[0].first, {
            words: ["version"],
            cwd: Deno.cwd(),
            human: row.human,
            tty: {
              stdin: row.terminals,
              stdout: false,
              stderr: row.terminals,
            },
            ...(row.terminals ? {} : { stdin: "" }),
          });
        }),
    );
  }
});

Deno.test("без основного токена /line не открывается ни при каком окружении", async () => {
  for (const terminals of [true, false]) {
    for (const agent of [AGENT, undefined]) {
      await withFakeServer(async (base, visits) => {
        await runClient(["version"], testEnv({ base, agent, terminals }).env);
        assertEquals(visits.some((visit) => visit.path === "/line"), false);
      });
    }
  }
});

Deno.test("токена нет ни одного — отказ с путём основного", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, terminals: true });
    assertEquals(await runClient(["version"], run.env), 1);
    assertEquals(run.stderr, [
      "mpu-next: нет токена доступа (/home/test/.config/mpu/token)\n",
    ]);
    assertEquals(visits, []);
  }));

/** Вопрос, ответ клиента — в `out`, затем выход. */
const ASKING: Script = async (socket, _first, answers) => {
  socket.send(JSON.stringify({ ask: "выполнить mpu x? [y/N] " }));
  for await (const answer of answers) {
    socket.send(JSON.stringify({ out: `ответ ${JSON.stringify(answer)}\n` }));
    socket.send(JSON.stringify({ exit: answer === "y" ? 0 : 1 }));
    socket.close(1000);
    return;
  }
};

Deno.test("кадр ask: вопрос в stderr без перевода строки, ответ — строка stdin", async (t) => {
  const cases: readonly (readonly [readonly string[], string, number])[] = [
    [["y"], "y", 0],
    [["n"], "n", 1],
    [[], "", 1],
  ];
  for (const [answers, sent, code] of cases) {
    await t.step(
      JSON.stringify(answers),
      () =>
        withFakeServer(async (base, visits) => {
          const run = testEnv({ base, main: MAIN, terminals: true, answers });
          assertEquals(await runClient(["x"], run.env), code);
          assertEquals(run.stderr, ["выполнить mpu x? [y/N] "]);
          assertEquals(run.stdout, [`ответ ${JSON.stringify(sent)}\n`]);
          assertEquals(visits[0].answers, [sent]);
        }, { script: ASKING }),
    );
  }
});

Deno.test("без человека вопрос не задаётся: ответ «нет» сразу", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, terminals: false, answers: ["y"] });
    assertEquals(await runClient(["x"], run.env), 1);
    assertEquals(run.stderr, []);
    assertEquals(visits[0].answers, [""]);
  }, { script: ASKING }));

Deno.test("код выхода — из кадра exit, потоки — как пришли", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    assertEquals(await runClient(["x"], run.env), 7);
    assertEquals(run.stdout, ["a", "c"]);
    assertEquals(run.stderr, ["b"]);
  }, {
    script: (socket) => {
      for (
        const frame of [{ out: "a" }, { err: "b" }, { out: "c" }, { exit: 7 }]
      ) {
        socket.send(JSON.stringify(frame));
      }
      socket.close(1000);
      return Promise.resolve();
    },
  }));

Deno.test("вывод больше мегабайта — целиком, порядок внутри потока", () => {
  const chunks = Array.from(
    { length: 40 },
    (_, i) => `${String(i).padStart(3, "0")}:${"x".repeat(32 * 1024)}\n`,
  );
  return withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    assertEquals(await runClient(["x"], run.env), 0);
    assertEquals(run.stdout.join(""), chunks.join(""));
    assertEquals(run.stdout.join("").length > 1024 * 1024, true);
  }, {
    script: (socket) => {
      for (const chunk of chunks) socket.send(JSON.stringify({ out: chunk }));
      socket.send(JSON.stringify({ exit: 0 }));
      socket.close(1000);
      return Promise.resolve();
    },
  });
});

Deno.test("сервер не отвечает — адрес и подсказка запуска", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(closed.addr as Deno.NetAddr).port}`;
  closed.close();
  const run = testEnv({ base, main: MAIN });
  assertEquals(await runClient(["version"], run.env), 1);
  assertEquals(run.stderr, [
    `mpu-next: сервер строк не отвечает на ${base} (запуск: deno task back)\n`,
  ]);
});

Deno.test("сервер отказал в доступе — код ответа", async (t) => {
  for (const status of [401, 403]) {
    await t.step(String(status), () =>
      withFakeServer(async (base, visits) => {
        const run = testEnv({ base, main: MAIN });
        assertEquals(await runClient(["version"], run.env), 1);
        assertEquals(run.stderr, [
          `mpu-next: сервер отказал в доступе (${status})\n`,
        ]);
        assertEquals(visits, []);
      }, { status }));
  }
});

Deno.test("сокет закрыт без exit — оборвал строку", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    assertEquals(await runClient(["x"], run.env), 1);
    assertEquals(run.stdout, ["частично"]);
    assertEquals(run.stderr, ["mpu-next: сервер оборвал строку\n"]);
  }, {
    script: (socket) => {
      socket.send(JSON.stringify({ out: "частично" }));
      socket.close(1000);
      return Promise.resolve();
    },
  }));

Deno.test("Ctrl+C во время строки — прервано, 130", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN, terminals: true });
    const code = runClient(["x"], run.env);
    run.interrupt();
    assertEquals(await code, 130);
    assertEquals(run.stderr.at(-1), "mpu-next: прервано\n");
  }, {
    // Строка висит: сервер ждёт закрытия от клиента.
    script: () => Promise.resolve(),
  }));

Deno.test("--version — версия сборки, к серверу не ходит", async () => {
  const run = testEnv({ base: "http://127.0.0.1:1" });
  assertEquals(await runClient(["--version"], run.env), 0);
  assertEquals(run.stdout, ["0.1.0\n"]);
  assertEquals(run.stderr, []);
});
