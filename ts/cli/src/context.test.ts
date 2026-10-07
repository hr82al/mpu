/**
 * Контекст вызова у клиента (`platform/call-context.md`, «Сторона
 * клиента»): что уходит первым кадром из пайпа и с терминала; ввод —
 * только по запросу строки (`platform/stdin-on-request.md`).
 */

import { expect, it } from "vitest";
import { MAX_STDIN_BYTES } from "../../back/src/frames/mod.ts";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer, within } from "./testkit.ts";

const MAIN = "main-" + "t0ken";

it("из пайпа: ввод по запросу, терминальность и имена — в кадре", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdin: "письмо\n",
      stdout: true,
      columns: 120,
      values: { NO_COLOR: "1", PGHOST: "прод", HOME: "/дом" },
    });
    expect(await runClient(["kiten", "comment", "1", "-F", "-"], run.env)).toBe(
      0,
    );
    expect(visits[0].first).toStrictEqual({
      words: ["kiten", "comment", "1", "-F", "-"],
      cwd: process.cwd(),
      human: false,
      stdinOnRequest: true,
      tty: { stdin: false, stdout: true, stderr: false, columns: 120 },
      // Имена вне закрытого списка клиент не берёт: сервер забраковал
      // бы кадр целиком.
      env: { NO_COLOR: "1" },
      caller: "ppid:1",
    });
    // Строка ввод не попросила — stdin не читался.
    expect(run.stdinReads()).toBe(0);
    expect(visits[0].inputs).toStrictEqual([]);
  }));

it("с терминала: ввода нет и ширина при своём терминале", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      terminals: true,
      stdout: true,
      columns: 80,
    });
    expect(await runClient(["version"], run.env)).toBe(0);
    expect(visits[0].first).toStrictEqual({
      words: ["version"],
      cwd: process.cwd(),
      human: true,
      tty: { stdin: true, stdout: true, stderr: true, columns: 80 },
      caller: "ppid:1",
    });
  }));

it("stdout не терминал: ширина не отправляется", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, columns: 120 });
    expect(await runClient(["version"], run.env)).toBe(0);
    expect(visits[0].first.tty).toStrictEqual({
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

/**
 * Запрос ввода, и первый же кадр ввода кончает строку: сценарий ничего не
 * ждёт, поэтому не висит и тогда, когда клиент ввода не шлёт.
 */
const REQUESTING_ONCE: Script = (socket) => {
  socket.addEventListener("message", () => {
    socket.send(JSON.stringify({ exit: 0 }));
    socket.close(1000);
  }, { once: true });
  socket.send(JSON.stringify({ stdinRequest: true }));
  return Promise.resolve();
};

it("открытый stdin без писателя: строка без ввода не ждёт его", () =>
  withFakeServer(async (base, visits) => {
    // Чтение, которое не кончается никогда: так выглядит открытый
    // канал, в который никто не пишет.
    const run = testEnv({
      base,
      main: MAIN,
      readStdin: () => new Promise<string>(() => {}),
    });
    const code = await within(runClient(["version"], run.env), 5_000, "итог");
    expect(code).toBe(0);
    expect(run.stdinReads()).toBe(0);
    expect(visits[0].first.stdinOnRequest).toBe(true);
  }));

it("запрос ввода: клиент читает stdin и шлёт его кадром", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, stdin: "ok" });
    expect(await runClient(["confirm", "yes"], run.env)).toBe(0);
    expect(visits[0].inputs).toStrictEqual(["ok"]);
    expect(run.stdout).toStrictEqual(["ok"]);
    expect(run.stdinReads()).toBe(1);
  }, { script: echoing(1) }));

it("второй запрос ввода: stdin не перечитывается", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, stdin: "ok" });
    expect(await runClient(["confirm", "yes"], run.env)).toBe(0);
    expect(visits[0].inputs).toStrictEqual(["ok", "ok"]);
    expect(run.stdinReads()).toBe(1);
  }, { script: echoing(2) }));

it("с терминала на запрос — пустой ввод, терминал не читается", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, terminals: true });
    expect(await runClient(["confirm", "yes"], run.env)).toBe(0);
    expect(visits[0].inputs).toStrictEqual([""]);
    expect(run.stdinReads()).toBe(0);
  }, { script: echoing(1) }));

it("ввод больше предела по запросу: код 2, ввод не уходит", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdin: "a".repeat(MAX_STDIN_BYTES + 1),
    });
    expect(await runClient(["confirm", "--yes"], run.env)).toBe(2);
    expect(run.stderr).toStrictEqual(["mpu: ввод больше 8 МиБ\n"]);
    expect(run.stdout).toStrictEqual([]);
    expect(visits[0].inputs).toStrictEqual([]);
  }, { script: REQUESTING }));

it("ввод больше предела без запроса: строка исполняется", () =>
  withFakeServer(async (base) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdin: "a".repeat(MAX_STDIN_BYTES + 1),
    });
    expect(await runClient(["version"], run.env)).toBe(0);
    expect(run.stderr).toStrictEqual([]);
    expect(run.stdinReads()).toBe(0);
  }));

it("stdin не прочитался: причина, код 1", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      readStdin: () => Promise.reject(new Error("EIO")),
    });
    expect(await runClient(["confirm", "yes"], run.env)).toBe(1);
    expect(run.stderr).toStrictEqual(["mpu: ввод не прочитан: EIO\n"]);
    expect(visits[0].inputs).toStrictEqual([]);
  }, { script: REQUESTING }));

/** Байты `^Готово^ print` в cp1251: 0xC3 на смещении 1 — не UTF-8. */
const CP1251 = new Uint8Array([
  0x5e,
  0xc3,
  0xee,
  0xf2,
  0xee,
  0xe2,
  0xee,
  0x5e,
  0x20,
  0x70,
  0x72,
  0x69,
  0x6e,
  0x74,
]);

it("строка без слов: ввод не в UTF-8 — отказ клиента, код 2", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, stdinBytes: CP1251 });
    // Сторож: клиент, отправивший неверный ввод, ждал бы конца строки
    // вечно — тест краснеет сообщением, а не висит.
    const code = within(runClient([], run.env), 5_000, "отказ клиента");
    expect(await code).toBe(2);
    expect(run.stderr).toStrictEqual([
      "mpu: ввод не в UTF-8: байт 0xC3 на смещении 1\n",
    ]);
    expect(visits[0].inputs).toStrictEqual([]);
  }, { script: REQUESTING_ONCE }));

it("строка без слов: BOM уходит серверу как есть", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({
      base,
      main: MAIN,
      stdinBytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
    });
    await runClient(["ask"], run.env);
    expect(visits[0].inputs).toStrictEqual(["\ufeffa"]);
  }, { script: echoing(1) }));

it("строка со словами: ввод не в UTF-8 не проверяется, как прежде", () =>
  withFakeServer(async (base, visits) => {
    const run = testEnv({ base, main: MAIN, stdinBytes: CP1251 });
    await runClient(["confirm", "yes"], run.env);
    expect(run.stderr).toStrictEqual([]);
    expect(visits[0].inputs.length).toBe(1);
  }, { script: echoing(1) }));

it("строка без слов: Ctrl+C, пока ввод открыт, — 130 и после конца канала", () =>
  withFakeServer(async (base, visits) => {
    const closed = Promise.withResolvers<string>();
    const requested = Promise.withResolvers<void>();
    const run = testEnv({
      base,
      main: MAIN,
      readStdin: () => {
        requested.resolve();
        return closed.promise;
      },
    });
    const code = runClient([], run.env);
    await within(requested.promise, 5_000, "запрос ввода");
    run.interrupt();
    // Канал закрывается вместе со `sleep`: чтение кончается пустым.
    closed.resolve("");
    expect(await within(code, 5_000, "итог")).toBe(130);
    expect(run.stderr).toStrictEqual(["mpu: прервано\n"]);
    expect(run.stdout).toStrictEqual([]);
    expect(visits[0].inputs).toStrictEqual([]);
  }, { script: REQUESTING }));
