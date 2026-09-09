/**
 * Поверхность семейства службы: маршрутизация подкоманд рядом с голым
 * `mpu mcp` и правило «токен печатает только `mpu mcp token`».
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { Command } from "../command/mod.ts";
import {
  mcpDisableCommand,
  mcpEnableCommand,
  mcpServiceCommands,
  mcpStatusCommand,
  runDisable,
  runEnable,
  runStart,
  runStatus,
  runStop,
} from "./cmd_service.ts";
import {
  type RunProgram,
  SERVICE_NAME,
  type ServiceDeps,
  unitText,
} from "./service.ts";

const PROGRAM = "/h/.local/bin/mpu";

async function run(argv: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/**
 * Менеджер, отвечающий по подкоманде. Версию печатает сама программа:
 * так проверяется, что `status` спрашивает именно её.
 */
function fakeDeps(
  dir: string,
  replies: Readonly<Record<string, string>> = {},
): ServiceDeps {
  const answer = (bin: string, args: readonly string[]) => {
    if (bin === PROGRAM) return "0.1.0";
    if (bin === "id") return "1000";
    if (bin === "loginctl") return "no";
    return replies[args[1] ?? ""] ?? "";
  };
  const run: RunProgram = (bin, args) =>
    Promise.resolve({ code: 0, stdout: `${answer(bin, args)}\n`, stderr: "" });
  return { dir, program: PROGRAM, run };
}

/** Каталог служб на время одной проверки. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await body(`${root}/systemd/user`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function describe(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
}

/**
 * Результаты всех пяти подкоманд, снятые с настоящих вызовов. Литералы
 * тут были бы вторым источником истины: разойдясь со схемой, они
 * оставили бы проверку про токен зелёной на устаревшем образце.
 */
async function everyResult(): Promise<[Command, unknown][]> {
  const results: [Command, unknown][] = [];
  await withDir(async (dir) => {
    await describe(dir);
    const io = makeFakeIo();
    const deps = fakeDeps(dir, {
      "is-active": "active",
      "is-enabled": "enabled",
    });
    const by = new Map<string, unknown>([
      ["mcp status", await runStatus(io, { deps })],
      ["mcp enable", await runEnable(io, { deps })],
      ["mcp start", await runStart(io, { deps })],
      ["mcp stop", await runStop(io, { deps })],
      ["mcp disable", await runDisable(io, { deps })],
    ]);
    for (const command of mcpServiceCommands) {
      const result = by.get(command.path.join(" "));
      assert(result !== undefined, `${command.path.join(" ")}: нет вызова`);
      results.push([command, result]);
    }
  });
  return results;
}

Deno.test("токен не печатается ни одной подкомандой службы", async () => {
  for (const [command, result] of await everyResult()) {
    const name = command.path.join(" ");
    const text = command.renderResult(result, []);
    for (const secret of ["Bearer", "Authorization", "authorization"]) {
      assertEquals(
        text.includes(secret),
        false,
        `${name} напечатала заголовок авторизации:\n${text}`,
      );
    }
    // Схема результата секрета не несёт: печатать было бы нечего даже
    // при промахе рендера.
    const fields = Object.keys(command.resultJsonSchema.properties);
    assertEquals(
      fields.some((field) => /token|autho/i.test(field)),
      false,
      `${name}: в схеме результата поле похоже на секрет: ${fields.join(", ")}`,
    );
    command.assertResult(result);
  }
});

Deno.test("enable называет команду токена, а не сам токен", async () => {
  await withDir(async (dir) => {
    const result = await runEnable(makeFakeIo(), { deps: fakeDeps(dir) });
    assertStringIncludes(
      mcpEnableCommand.renderResult(result, []),
      "mpu mcp token",
    );
  });
});

Deno.test("голое `mpu mcp` с флагами не перехватывается подкомандой", async () => {
  // Значение заведомо негодное: разбор флагов сервера отвечает ошибкой
  // ввода до всякого сокета. Дойти до него можно только голым
  // исполнением уровня — подкоманда назвала бы `--port` командой.
  const { code, stderr } = await run(["mcp", "--port", "не-число"]);
  assertEquals(code, 2);
  assertStringIncludes(stderr, "mpu mcp: ");
  assertEquals(stderr.includes("No such command"), false);
});

Deno.test("подкоманда опознаётся первым словом и отвечает своим префиксом", async () => {
  // Окружения у фейка нет: команда обязана отказать своим именем, а не
  // именем уровня, — по этому и видно, что маршрут дошёл до листа.
  const { code, stderr } = await run(["mcp", "status"]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "mpu mcp status: ");
});

Deno.test("status без описания: «не установлена» и нулевой код", async () => {
  await withDir(async (dir) => {
    const result = await runStatus(makeFakeIo(), { deps: fakeDeps(dir) });
    assertEquals(result.installed, false);
    assertEquals(result.version, null);
    assertEquals(result.address, "http://127.0.0.1:7337");
    assertEquals(result.profiles, ["/ro", "/rw"]);
    assertStringIncludes(
      mcpStatusCommand.renderResult(result, []),
      "не установлена",
    );
  });
});

Deno.test("status с описанием: версия — у программы из ExecStart", async () => {
  await withDir(async (dir) => {
    await describe(dir);
    const deps = fakeDeps(dir, {
      "is-active": "active",
      "is-enabled": "enabled",
    });
    const result = await runStatus(makeFakeIo(), { deps });
    assertEquals(result.installed, true);
    assertEquals(result.active, true);
    assertEquals(result.enabled, true);
    assertEquals(result.program, PROGRAM);
    assertEquals(result.version, "0.1.0");
    assertEquals(result.linger, "off");
  });
});

Deno.test("enable → start/stop → disable: наблюдаемая картина по шагам", async () => {
  await withDir(async (dir) => {
    const deps = fakeDeps(dir, { "is-active": "inactive" });
    const io = makeFakeIo();
    const enabled = await runEnable(io, { deps });
    assertEquals(enabled.restarted, false);
    assertEquals(enabled.path, `${dir}/${SERVICE_NAME}`);
    assertStringIncludes(
      mcpEnableCommand.renderResult(enabled, []),
      "http://127.0.0.1:7337 (/ro, /rw)",
    );
    // Менеджер в фейке остаётся «inactive», поэтому start меняет
    // состояние, а stop — нет: обе ветки переключателя на одном месте.
    assertEquals((await runStart(io, { deps })).changed, true);
    assertEquals((await runStop(io, { deps })).changed, false);
    const off = await runDisable(io, { deps });
    assertEquals(off.removed, true);
    assertStringIncludes(
      mcpDisableCommand.renderResult(off, []),
      "описание удалено",
    );
    assertEquals((await runDisable(io, { deps })).removed, false);
  });
});

Deno.test("enable: не поднявшаяся служба даёт код 1 и адрес журнала", async () => {
  await withDir(async (dir) => {
    // Менеджер отвечает нулём на всё, но служба остаётся остановленной:
    // так ведёт себя `Type=simple` на занятом порту.
    const deps = fakeDeps(dir, { "is-active": "failed" });
    const result = await runEnable(makeFakeIo(), { deps });
    assertEquals(result.active, false);
    assertEquals(mcpEnableCommand.textExitCode(result), 1);
    assertStringIncludes(
      mcpEnableCommand.renderResult(result, []),
      "journalctl --user -u",
    );
  });
});

Deno.test("start: сказанное менеджеру и вышедшее расходятся — код 1", async () => {
  await withDir(async (dir) => {
    await describe(dir);
    // Менеджер отвечает нулём, но служба не поднялась: занятый порт при
    // `Type=simple` выглядит именно так.
    const deps = fakeDeps(dir, { "is-active": "failed" });
    const result = await runStart(makeFakeIo(), { deps });
    assertEquals(result.changed, true);
    assertEquals(result.active, false);
    const start = mcpServiceCommands.find((c) => c.path[1] === "start");
    assert(start !== undefined, "подкоманды start нет в семействе");
    assertEquals(start.textExitCode(result), 1);
    assertStringIncludes(
      start.renderResult(result, []),
      "journalctl --user -u",
    );
  });
});

Deno.test("start/stop без описания: отказ по-русски, с именем enable", async (t) => {
  const cases = [
    { name: "start", call: runStart, said: "запускать нечего" },
    { name: "stop", call: runStop, said: "останавливать нечего" },
  ];
  for (const { name, call, said } of cases) {
    await t.step(name, async () => {
      await withDir(async (dir) => {
        const err = await assertRejects(
          () => call(makeFakeIo(), { deps: fakeDeps(dir) }),
          DomainError,
        );
        assertStringIncludes(err.message, said);
        assertStringIncludes(err.message, "mpu mcp enable");
      });
    });
  }
});
