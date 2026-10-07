/**
 * Клиент на проводе (`cli-client.md`): дверь и токен по доступному,
 * вопрос человеку, кадры в потоки, свои отказы. Сервер — записывающий.
 */

import { describe, expect, it } from "vitest";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer } from "./testkit.ts";
import { closedPort } from "../../back/src/testing/http.ts";

const MAIN = "main-" + "t0ken";
const AGENT = "agent-" + "t0ken";

describe("канал и токен: три строки таблицы", () => {
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
    it(
      `${row.path} ${row.terminals} ${row.main !== undefined}`,
      () =>
        withFakeServer(async (base, visits) => {
          const run = testEnv({ base, ...row });
          expect(await runClient(["version"], run.env)).toBe(0);
          expect(visits.map((visit) => [visit.path, visit.token]))
            .toStrictEqual([
              [row.path, row.token],
            ]);
          // Первый кадр несёт и контекст вызова: терминальность —
          // всегда, ввод по запросу — только из пайпа
          // (`platform/stdin-on-request.md`).
          expect(visits[0].first).toStrictEqual({
            words: ["version"],
            cwd: process.cwd(),
            human: row.human,
            tty: {
              stdin: row.terminals,
              stdout: false,
              stderr: row.terminals,
            },
            ...(row.terminals ? {} : { stdinOnRequest: true }),
            // Клиент называет себя родителем (`platform/it.md`).
            caller: "ppid:1",
          });
        }),
    );
  }
});

it("без основного токена /line не открывается ни при каком окружении", async () => {
  for (const terminals of [true, false]) {
    for (const agent of [AGENT, undefined]) {
      await withFakeServer(async (base, visits) => {
        await runClient(["version"], testEnv({ base, agent, terminals }).env);
        expect(visits.some((visit) => visit.path === "/line")).toBe(false);
      });
    }
  }
});

it("токена нет ни одного — отказ с путём основного", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, terminals: true });
    expect(await runClient(["version"], run.env)).toBe(1);
    expect(run.stderr).toStrictEqual([
      "mpu: нет токена доступа (/home/test/.config/mpu/token)\n",
    ]);
    expect(visits).toStrictEqual([]);
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

describe("кадр ask: вопрос на терминале, ответ — строка оттуда же", () => {
  const cases: readonly (readonly [readonly string[], string, number])[] = [
    [["y"], "y", 0],
    [["n"], "n", 1],
    [[], "", 1],
  ];
  for (const [answers, sent, code] of cases) {
    it(JSON.stringify(answers), () =>
      withFakeServer(async (base, visits) => {
        const run = testEnv({ base, main: MAIN, terminals: true, answers });
        expect(await runClient(["x"], run.env)).toStrictEqual(code);
        // Вопрос показывается на управляющем терминале — там же, где
        // его видит человек (`cli-client.md`, «Канал и токен»).
        expect(run.asked).toStrictEqual([{
          kind: "line",
          question: "выполнить mpu x? [y/N] ",
        }]);
        expect(run.stderr).toStrictEqual([]);
        expect(run.stdout).toStrictEqual([`ответ ${JSON.stringify(sent)}\n`]);
        expect(visits[0].answers).toStrictEqual([sent]);
      }, { script: ASKING }));
  }
});

/** Скрытый вопрос: пароль спрашивают и больше нигде не показывают. */
const ASKING_SECRET: Script = async (socket, _first, answers) => {
  socket.send(JSON.stringify({ ask: "Пароль: ", kind: "secret" }));
  for await (const _answer of answers) {
    socket.send(JSON.stringify({ exit: 0 }));
    socket.close(1000);
    return;
  }
};

it("кадр ask вида secret: чтение без эха, ответ наружу не выходит", () =>
  withFakeServer(async (base, visits) => {
    const password = "п4роль-м4ркер";
    const run = testEnv({
      base,
      main: MAIN,
      terminals: true,
      answers: [password],
    });
    expect(await runClient(["x"], run.env)).toBe(0);
    // Вид вопроса выбрал чтение: `secret` читается без эха, и это
    // видно по тому, каким способом терминал отдал ответ.
    expect(run.asked).toStrictEqual([{ kind: "secret", question: "Пароль: " }]);
    expect(visits[0].answers).toStrictEqual([password]);
    // Сам пароль клиент никуда не печатает.
    expect([...run.stdout, ...run.stderr]).toStrictEqual([]);
  }, { script: ASKING_SECRET }));

/** Просьба положить текст в буфер и выход. */
const CLIPPING: Script = (socket) => {
  socket.send(JSON.stringify({ clip: "docker exec mp-sl-1-cli" }));
  socket.send(JSON.stringify({ exit: 0 }));
  socket.close(1000);
  return Promise.resolve();
};

describe("кадр clip: буфер у терминала, stderr у пайпа", () => {
  const cases: readonly (readonly [string, boolean, boolean])[] = [
    ["терминал: текст в буфере", true, true],
    ["терминал без буфера: текст в stderr", true, false],
    ["пайп: буфер не трогается", false, false],
  ];
  for (const [name, terminals, clipboard] of cases) {
    it(name, () =>
      withFakeServer(async (base) => {
        const run = testEnv({ base, main: MAIN, terminals, clipboard });
        expect(await runClient(["x"], run.env)).toBe(0);
        // Пайп в буфер не ходит вовсе: копировать там некуда, и
        // попытка запустила бы чужую программу (`line-prompt.md`).
        expect(run.copied).toStrictEqual(
          terminals ? ["docker exec mp-sl-1-cli"] : [],
        );
        expect(run.stderr).toStrictEqual(
          clipboard ? [] : ["docker exec mp-sl-1-cli\n"],
        );
      }, { script: CLIPPING }));
  }
});

/**
 * Вопрос решён в Telegram: кадр `settled`, затем исполнение и `exit`
 * (`platform/ask-telegram.md` [D.2]).
 */
const SETTLED_IN_CHAT: Script = (socket) => {
  for (
    const frame of [
      { ask: "выполнить mpu x? [y/N] " },
      { settled: "решено в Telegram — да" },
      { out: "исполнено\n" },
      { exit: 0 },
    ]
  ) {
    socket.send(JSON.stringify(frame));
  }
  socket.close(1000);
  return Promise.resolve();
};

it("кадр settled: ввод не ждётся, ответ не уходит, причина в stderr", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, terminals: true, untyped: 1 });
    expect(await runClient(["x"], run.env)).toBe(0);
    expect(run.stderr).toStrictEqual(["mpu: решено в Telegram — да\n"]);
    expect(run.stdout).toStrictEqual(["исполнено\n"]);
    expect(visits[0].answers).toStrictEqual([]);
    // Оба открытия терминала закрыты — проверка при старте и вопрос:
    // чтение, которое уже не нужно, не держит его.
    expect(run.disposed()).toBe(2);
  }, { script: SETTLED_IN_CHAT }));

/** Первый вопрос решён в Telegram, второй ждёт ответа клиента. */
const SETTLED_THEN_ASKED: Script = async (socket, _first, answers) => {
  socket.send(JSON.stringify({ ask: "выполнить mpu x? [y/N] " }));
  socket.send(JSON.stringify({ settled: "решено в Telegram — да" }));
  socket.send(JSON.stringify({ ask: "Ещё? [y/N] " }));
  for await (const answer of answers) {
    socket.send(JSON.stringify({ exit: answer === "y" ? 0 : 1 }));
    socket.close(1000);
    return;
  }
};

it("кадр settled: снятый вопрос не отвечает следующему", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      terminals: true,
      untyped: 1,
      answers: ["y"],
    });
    expect(await runClient(["x"], run.env)).toBe(0);
    expect(visits[0].answers).toStrictEqual(["y"]);
  }, { script: SETTLED_THEN_ASKED }));

it("без человека вопрос не задаётся: ответ «нет» сразу", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, terminals: false, answers: ["y"] });
    expect(await runClient(["x"], run.env)).toBe(1);
    expect(run.asked).toStrictEqual([]);
    expect(visits[0].answers).toStrictEqual([""]);
  }, { script: ASKING }));

it("код выхода — из кадра exit, потоки — как пришли", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    expect(await runClient(["x"], run.env)).toBe(7);
    expect(run.stdout).toStrictEqual(["a", "c"]);
    expect(run.stderr).toStrictEqual(["b"]);
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

it("вывод больше мегабайта — целиком, порядок внутри потока", () => {
  const chunks = Array.from(
    { length: 40 },
    (_, i) => `${String(i).padStart(3, "0")}:${"x".repeat(32 * 1024)}\n`,
  );
  return withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    expect(await runClient(["x"], run.env)).toBe(0);
    expect(run.stdout.join("")).toStrictEqual(chunks.join(""));
    expect(run.stdout.join("").length > 1024 * 1024).toBe(true);
  }, {
    script: (socket) => {
      for (const chunk of chunks) socket.send(JSON.stringify({ out: chunk }));
      socket.send(JSON.stringify({ exit: 0 }));
      socket.close(1000);
      return Promise.resolve();
    },
  });
});

it("сервер не отвечает — адрес и подсказка запуска", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const run = testEnv({ base, main: MAIN });
  expect(await runClient(["version"], run.env)).toBe(1);
  expect(run.stderr).toStrictEqual([
    `mpu: сервер строк не отвечает на ${base} ` +
    `(запуск: systemctl --user start mpu)\n`,
  ]);
});

describe("сервер отказал в доступе — код ответа", () => {
  for (const status of [401, 403]) {
    it(String(status), () =>
      withFakeServer(async (base, visits) => {
        const run = testEnv({ base, main: MAIN });
        expect(await runClient(["version"], run.env)).toBe(1);
        expect(run.stderr).toStrictEqual([
          `mpu: сервер отказал в доступе (${status})\n`,
        ]);
        expect(visits).toStrictEqual([]);
      }, { status }));
  }
});

it("сокет закрыт без exit — оборвал строку", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    expect(await runClient(["x"], run.env)).toBe(1);
    expect(run.stdout).toStrictEqual(["частично"]);
    expect(run.stderr).toStrictEqual(["mpu: сервер оборвал строку\n"]);
  }, {
    script: (socket) => {
      socket.send(JSON.stringify({ out: "частично" }));
      socket.close(1000);
      return Promise.resolve();
    },
  }));

it("Ctrl+C во время строки — прервано, 130", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN, terminals: true });
    const code = runClient(["x"], run.env);
    run.interrupt();
    expect(await code).toBe(130);
    expect(run.stderr.at(-1)).toBe("mpu: прервано\n");
  }, {
    // Строка висит: сервер ждёт закрытия от клиента.
    script: () => Promise.resolve(),
  }));

it("--version — версия сборки, к серверу не ходит", async () => {
  const run = testEnv({ base: "http://127.0.0.1:1" });
  expect(await runClient(["--version"], run.env)).toBe(0);
  expect(run.stdout).toStrictEqual(["0.1.0\n"]);
  expect(run.stderr).toStrictEqual([]);
});

it("копирование дожидается программы: клиент не выходит раньше", () => {
  // Копирование отпускается тем, что сокет уже закрыт со стороны
  // сервера, — а это заведомо позже, чем закрылся клиент. Дождался
  // клиент копирования или нет, видно по тому, что он успел положить
  // в буфер к моменту своего выхода.
  const closed = Promise.withResolvers<void>();
  const script: Script = (socket) => {
    socket.addEventListener("close", () => closed.resolve());
    socket.send(JSON.stringify({ clip: "docker exec mp-sl-1-cli" }));
    socket.send(JSON.stringify({ exit: 0 }));
    socket.close(1000);
    return Promise.resolve();
  };
  return withFakeServer(async (base) => {
    const run = testEnv({
      base,
      main: MAIN,
      terminals: true,
      copying: closed.promise,
    });
    const atExit = await runClient(["x"], run.env).then((code) => ({
      code,
      copied: [...run.copied],
    }));
    expect(atExit).toStrictEqual({
      code: 0,
      copied: ["docker exec mp-sl-1-cli"],
    });
  }, { script });
});

it("кадр picture: печать прежняя, побайтово; код из exit (P2)", () =>
  withFakeServer(async (base) => {
    const run = testEnv({ base, main: MAIN });
    expect(await runClient(["x"], run.env)).toBe(0);
    expect(run.stdout).toStrictEqual(["до\n", "после\n"]);
    expect(run.stderr).toStrictEqual([]);
  }, {
    // Кадр картинки посреди вывода: строку он не кончает, вывод после
    // него печатается.
    script: async (socket) => {
      socket.send(JSON.stringify({ out: "до\n" }));
      socket.send(JSON.stringify({
        picture: { mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
      }));
      await Promise.resolve();
      socket.send(JSON.stringify({ out: "после\n" }));
      socket.send(JSON.stringify({ exit: 0 }));
      socket.close(1000);
    },
  }));
