/**
 * Вплетение журнала в обе точки входа (`platform/invoke-log.md`):
 * CLI-вызов и вызов тула MCP-сервером. Проверяется не формат записи (он
 * закреплён рядом, `record_test.ts`), а то, у каких вызовов запись
 * появляется и что в неё попадает.
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { z } from "@zod/zod";
import { runCli } from "../entrypoint/mod.ts";
import { handleMcp } from "../mcp/mod.ts";
import { nativeEntry } from "../mcp/native_tool.ts";
import { type Command, defineCommand } from "../command/mod.ts";
import { commands } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type InvokeLog, makeInvokeLog } from "./mod.ts";

/** Стенд: журнал поверх временного файла и вывод, который он копирует. */
interface Stand {
  readonly log: InvokeLog;
  readonly path: string;
  readonly text: () => Promise<string>;
  readonly records: () => Promise<readonly string[]>;
}

async function withStand(
  body: (stand: Stand) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mpu.log`;
  const text = async () => {
    try {
      return await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return "";
      throw err;
    }
  };
  try {
    await body({
      log: makeInvokeLog({
        env: { get: () => undefined },
        defaultFile: path,
        pid: 777,
        cwd: () => "/work",
        now,
      }),
      path,
      text,
      records: async () =>
        (await text()).split("\n").filter((line) => line.startsWith("### ")),
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Прогон CLI под журналом — та же склейка, что в `main.ts`. */
async function cli(
  stand: Stand,
  argv: readonly string[],
  io = makeFakeIo(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const record = stand.log.begin({ kind: "argv", argv });
  const output = record.capture({
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  const code = await runCli(argv, io, output, {
    nativeCall: (command) => record.nativeCall(command),
    log: stand.log,
  });
  await record.finish(code);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

Deno.test("native-вызов оставляет ровно одну запись", async () => {
  await withStand(async (stand) => {
    const outcome = await cli(stand, ["xlsx", "resolve"]);
    assertEquals((await stand.records()).length, 1);
    const text = await stand.text();
    assertMatch(text, /^\$ mpu xlsx resolve$/mu);
    assertMatch(text, new RegExp(`exit=${outcome.code} dur=`, "u"));
    // Вывод команды — в записи и на экране одновременно, дословно.
    assertStringIncludes(text, outcome.stdout.split("\n")[0]);
  });
});

Deno.test("реестровые поверхности записей не оставляют", async (t) => {
  const surfaces: readonly [name: string, argv: string[]][] = [
    ["version", ["version"]],
    ["общая справка", ["--help"]],
    ["вызов без команды", []],
    ["mpu help", ["help"]],
    ["mpu help <имя>", ["help", "mpu xlsx ls"]],
    ["неизвестное имя", ["нет-такой-команды"]],
    ["неизвестная опция", ["--version"]],
    ["справка группы", ["xlsx", "--help"]],
    ["справка листа", ["xlsx", "ls", "--help"]],
    ["печать скрипта дополнения", ["--show-completion", "bash"]],
  ];
  for (const [name, argv] of surfaces) {
    await t.step(name, async () => {
      await withStand(async (stand) => {
        await cli(stand, argv);
        assertEquals(await stand.text(), "");
      });
    });
  }
});

Deno.test("режим дополнения записей не оставляет", async () => {
  await withStand(async (stand) => {
    await cli(
      stand,
      [],
      makeFakeIo({
        env: (name) =>
          ({ _MPU_COMPLETE: "complete_bash", COMP_WORDS: "mpu ver" })[name],
      }),
    );
    assertEquals(await stand.text(), "");
  });
});

Deno.test("маршрут legacy: обвязка записи не создаёт", async () => {
  await withStand(async (stand) => {
    const outcome = await cli(
      stand,
      ["logs", "sl-1"],
      makeFakeIo({
        readConfigStore: () =>
          Promise.resolve('{"mcp.legacy_bin":"/bin/echo"}'),
        runLegacy: () =>
          Promise.resolve({ code: 0, stdout: "строки\n", stderr: "" }),
      }),
    );
    assertEquals(outcome.code, 0);
    assertEquals(outcome.stdout, "строки\n");
    // Запись этого вызова делает сам Python-подпроцесс; вторая отсюда
    // была бы дублем (спека, «Разделение моста»).
    assertEquals(await stand.text(), "");
  });
});

Deno.test("ошибка команды: запись остаётся, код и текст в ней", async () => {
  await withStand(async (stand) => {
    const outcome = await cli(stand, ["xlsx", "get", "--нет-такой-опции"]);
    assertEquals(outcome.code, 2);
    const text = await stand.text();
    assertEquals((await stand.records()).length, 1);
    assertMatch(text, /^--- err run=\S+ ---$/mu);
    assertStringIncludes(text, outcome.stderr.split("\n")[0]);
    assertMatch(text, /exit=2 dur=/u);
  });
});

Deno.test("mcp token: запись есть, токена в ней нет", async () => {
  await withStand(async (stand) => {
    const outcome = await cli(
      stand,
      ["mcp", "token"],
      makeFakeIo({ readAccessToken: () => Promise.resolve("s3cret-token") }),
    );
    assertEquals(outcome.code, 0);
    assertStringIncludes(outcome.stdout, "s3cret-token");
    const text = await stand.text();
    assertEquals((await stand.records()).length, 1);
    assertMatch(text, /^\$ mpu mcp token$/mu);
    assertEquals(text.includes("s3cret-token"), false);
    assertEquals(text.includes("--- out "), false);
  });
});

Deno.test("пометка «без записи вывода» — часть объявления команды", async (t) => {
  const declaration = {
    path: ["фейк"],
    summary: "фейковая команда для проверки механики пометки",
    usage: "mpu фейк",
    help: "Ничего не делает: нужна проверке пометки журнала.",
    policy: "ro" as const,
    argsSchema: z.object({}),
    resultSchema: z.object({}),
    run: () => Promise.resolve({}),
    render: () => "",
  };
  await t.step("умолчание — вывод пишется", () => {
    assertEquals(defineCommand(declaration).logsOutput, true);
  });
  await t.step("пометка выключает секции вывода", () => {
    assertEquals(
      defineCommand({ ...declaration, logsOutput: false }).logsOutput,
      false,
    );
  });
  await t.step("пометка доезжает до записи тула", () => {
    const marked = defineCommand({ ...declaration, logsOutput: false });
    assertEquals(nativeEntry(marked).journal, { logsOutput: false });
    assertEquals(nativeEntry(defineCommand(declaration)).journal, {
      logsOutput: true,
    });
  });
  await t.step("в реестре пометка стоит у mcp token", () => {
    const marked = commands
      .filter((command) => !command.logsOutput)
      .map((command) => command.path.join(" "));
    assertEquals(marked, ["mcp token"]);
  });
});

/** Вызов тула через ядро сервера: то же, что делает транспорт. */
function toolCall(
  log: InvokeLog,
  name: string,
  args: Readonly<Record<string, unknown>>,
  io = makeFakeIo(),
  published: readonly Command[] = commands,
) {
  return handleMcp({
    method: "POST",
    path: "/ro",
    headers: {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  }, { io, commands: published, version: "0.0.0-test", log });
}

Deno.test("вызов тула журналируется как вторая точка входа", async (t) => {
  await t.step(
    "строка команды — путь и JSON, маскирование внутри",
    async () => {
      await withStand(async (stand) => {
        await toolCall(stand.log, "xlsx_resolve", { file: "/tmp/книга.xlsx" });
        const text = await stand.text();
        assertEquals((await stand.records()).length, 1);
        assertMatch(text, /^### \S+ \S+ \S+ run=\S+ pid=777 cwd=\/work$/mu);
        assertMatch(
          text,
          /^\$ mpu xlsx resolve '\{"file":"\/tmp\/книга\.xlsx"\}'$/mu,
        );
        assertMatch(text, /exit=0 dur=/u);
      });
    },
  );
  await t.step("секретные ключи JSON маскируются", async () => {
    await withStand(async (stand) => {
      await toolCall(stand.log, "xlsx_resolve", { token: "s3cret" });
      const text = await stand.text();
      assertMatch(text, /^\$ mpu xlsx resolve '\{"token":"REDACTED"\}'$/mu);
      assertEquals(text.includes("s3cret"), false);
    });
  });
  await t.step("ошибка ввода — код 2 и текст в err", async () => {
    await withStand(async (stand) => {
      await toolCall(stand.log, "xlsx_resolve", { нет: 1 });
      const text = await stand.text();
      assertMatch(text, /exit=2 dur=/u);
      assertStringIncludes(text, 'unknown argument "нет"');
    });
  });
  await t.step("тул маршрута legacy записи обвязки не оставляет", async () => {
    await withStand(async (stand) => {
      const response = await toolCall(
        stand.log,
        "health",
        {},
        makeFakeIo({
          readConfigStore: () =>
            Promise.resolve('{"mcp.legacy_bin":"/bin/echo"}'),
          runLegacy: () =>
            Promise.resolve({ code: 0, stdout: "ok\n", stderr: "" }),
        }),
      );
      assertEquals(response.status, 200);
      assertEquals(await stand.text(), "");
    });
  });
  await t.step("строки хода исполнения попадают в запись", async () => {
    // Путь берётся из закрытого списка публикации: тул с чужим именем
    // не публикуется вовсе, и вызывать было бы нечего.
    const noisy = defineCommand({
      path: ["xlsx", "resolve"],
      summary: "команда, печатающая ход исполнения",
      usage: "mpu xlsx resolve",
      help: "Печатает две служебные строки и возвращает признак успеха.",
      policy: "ro",
      argsSchema: z.object({}),
      resultSchema: z.object({ ok: z.boolean() }),
      run: (_args, io) => {
        io.progress("шаг 1");
        io.progress("шаг 2");
        return Promise.resolve({ ok: true });
      },
      render: () => "",
    });
    await withStand(async (stand) => {
      const printed: string[] = [];
      await toolCall(
        stand.log,
        "xlsx_resolve",
        {},
        makeFakeIo({ progress: (line) => void printed.push(line) }),
        [noisy],
      );
      // Печать сервера остаётся на месте, а копия уходит в запись — как
      // у CLI, где те же строки печатает точка входа.
      assertEquals(printed, ["шаг 1", "шаг 2"]);
      assertMatch(
        await stand.text(),
        /^--- err run=\S+ ---\nшаг 1\nшаг 2\n/mu,
      );
    });
  });
  await t.step("два вызова в одну миллисекунду — разные run_id", async () => {
    await withStand(async (stand) => {
      await toolCall(stand.log, "xlsx_resolve", {});
      await toolCall(stand.log, "xlsx_resolve", {});
      const ids = (await stand.records()).map((line) =>
        line.split(" ").find((part) => part.startsWith("run="))
      );
      assertEquals(ids.length, 2);
      assertEquals(new Set(ids).size, 2, `run_id повторились: ${ids}`);
    }, () => new Date("2026-08-05T04:42:28.205Z"));
  });
});
