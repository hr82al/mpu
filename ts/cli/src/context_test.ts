/**
 * Контекст вызова у клиента (`platform/call-context.md`, «Сторона
 * клиента»): что уходит первым кадром из пайпа и с терминала; ввод —
 * только по запросу строки (`platform/stdin-on-request.md`).
 */

import { assertEquals } from "@std/assert";
import { MAX_STDIN_BYTES } from "../../back/src/frames/mod.ts";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer, within } from "./testkit.ts";

const MAIN = "main-" + "t0ken";

Deno.test("из пайпа: ввод по запросу, терминальность и имена — в кадре", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdin: "письмо\n",
      stdout: true,
      columns: 120,
      values: { NO_COLOR: "1", PGHOST: "прод", HOME: "/дом" },
    });
    assertEquals(
      await runClient(["kiten", "comment", "1", "-F", "-"], run.env),
      0,
    );
    assertEquals(visits[0].first, {
      words: ["kiten", "comment", "1", "-F", "-"],
      cwd: Deno.cwd(),
      human: false,
      stdinOnRequest: true,
      tty: { stdin: false, stdout: true, stderr: false, columns: 120 },
      // Имена вне закрытого списка клиент не берёт: сервер забраковал
      // бы кадр целиком.
      env: { NO_COLOR: "1" },
      caller: "ppid:1",
    });
    // Строка ввод не попросила — stdin не читался.
    assertEquals(run.stdinReads(), 0);
    assertEquals(visits[0].inputs, []);
  }));

Deno.test("с терминала: ввода нет и ширина при своём терминале", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      terminals: true,
      stdout: true,
      columns: 80,
    });
    assertEquals(await runClient(["version"], run.env), 0);
    assertEquals(visits[0].first, {
      words: ["version"],
      cwd: Deno.cwd(),
      human: true,
      tty: { stdin: true, stdout: true, stderr: true, columns: 80 },
      caller: "ppid:1",
    });
  }));

Deno.test("stdout не терминал: ширина не отправляется", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, columns: 120 });
    assertEquals(await runClient(["version"], run.env), 0);
    assertEquals(visits[0].first.tty, {
      stdin: false,
      stdout: false,
      stderr: false,
    });
  }));

/** Сервер просит ввод `times` раз, печатает пришедшее, итог 0. */
function echoing(times: number): Script {
  return async (socket, _first, _answers, inputs) => {
    for (let i = 0; i < times; i++) {
      socket.send(JSON.stringify({ stdinRequest: true }));
    }
    let left = times;
    for await (const text of inputs) {
      socket.send(JSON.stringify({ out: text }));
      left -= 1;
      if (left === 0) break;
    }
    socket.send(JSON.stringify({ exit: 0 }));
    socket.close(1000);
  };
}

/** Сервер просит ввод и ждёт, пока клиент не закроет сокет. */
const REQUESTING: Script = (socket) => {
  socket.send(JSON.stringify({ stdinRequest: true }));
  return Promise.resolve();
};

Deno.test("открытый stdin без писателя: строка без ввода не ждёт его", () =>
  withFakeServer(async (base, visits) => {
    // Чтение, которое не кончается никогда: так выглядит открытый
    // канал, в который никто не пишет.
    const run = testEnv({
      base,
      main: MAIN,
      readStdin: () => new Promise<string>(() => {}),
    });
    const code = await within(runClient(["version"], run.env), 5_000, "итог");
    assertEquals(code, 0);
    assertEquals(run.stdinReads(), 0);
    assertEquals(visits[0].first.stdinOnRequest, true);
  }));

Deno.test("запрос ввода: клиент читает stdin и шлёт его кадром", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, stdin: "ok" });
    assertEquals(await runClient(["confirm", "yes"], run.env), 0);
    assertEquals(visits[0].inputs, ["ok"]);
    assertEquals(run.stdout, ["ok"]);
    assertEquals(run.stdinReads(), 1);
  }, { script: echoing(1) }));

Deno.test("второй запрос ввода: stdin не перечитывается", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, stdin: "ok" });
    assertEquals(await runClient(["confirm", "yes"], run.env), 0);
    assertEquals(visits[0].inputs, ["ok", "ok"]);
    assertEquals(run.stdinReads(), 1);
  }, { script: echoing(2) }));

Deno.test("с терминала на запрос — пустой ввод, терминал не читается", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, terminals: true });
    assertEquals(await runClient(["confirm", "yes"], run.env), 0);
    assertEquals(visits[0].inputs, [""]);
    assertEquals(run.stdinReads(), 0);
  }, { script: echoing(1) }));

Deno.test("ввод больше предела по запросу: код 2, ввод не уходит", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdin: "a".repeat(MAX_STDIN_BYTES + 1),
    });
    assertEquals(await runClient(["confirm", "--yes"], run.env), 2);
    assertEquals(run.stderr, ["mpu: ввод больше 8 МиБ\n"]);
    assertEquals(run.stdout, []);
    assertEquals(visits[0].inputs, []);
  }, { script: REQUESTING }));

Deno.test("ввод больше предела без запроса: строка исполняется", () =>
  withFakeServer(async (base) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdin: "a".repeat(MAX_STDIN_BYTES + 1),
    });
    assertEquals(await runClient(["version"], run.env), 0);
    assertEquals(run.stderr, []);
    assertEquals(run.stdinReads(), 0);
  }));

Deno.test("stdin не прочитался: причина, код 1", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      readStdin: () => Promise.reject(new Error("EIO")),
    });
    assertEquals(await runClient(["confirm", "yes"], run.env), 1);
    assertEquals(run.stderr, ["mpu: ввод не прочитан: EIO\n"]);
    assertEquals(visits[0].inputs, []);
  }, { script: REQUESTING }));
