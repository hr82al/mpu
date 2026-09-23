/**
 * Контекст вызова у клиента (`platform/call-context.md`, «Сторона
 * клиента»): что уходит первым кадром из пайпа и с терминала и что
 * клиент отказывается отправлять вовсе.
 */

import { assertEquals } from "@std/assert";
import { MAX_STDIN_BYTES } from "../../back/src/frames/mod.ts";
import { runClient } from "./client.ts";
import { testEnv, withFakeServer } from "./testkit.ts";

const MAIN = "main-" + "t0ken";

Deno.test("из пайпа: ввод, терминальность и имена списка — в кадре", () =>
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
      stdin: "письмо\n",
      tty: { stdin: false, stdout: true, stderr: false, columns: 120 },
      // Имена вне закрытого списка клиент не берёт: сервер забраковал
      // бы кадр целиком.
      env: { NO_COLOR: "1" },
      caller: "ppid:1",
    });
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

Deno.test("ввод больше предела: код 2, серверу не уходит ничего", async () => {
  // Адрес заведомо мёртвый: дойди дело до сервера, клиент сказал бы
  // «не отвечает» и вышел с кодом 1.
  const run = testEnv({
    base: "http://127.0.0.1:1",
    main: MAIN,
    stdin: "a".repeat(MAX_STDIN_BYTES + 1),
  });
  assertEquals(await runClient(["confirm", "--yes"], run.env), 2);
  assertEquals(run.stderr, ["mpu: ввод больше 8 МиБ\n"]);
  assertEquals(run.stdout, []);
});
