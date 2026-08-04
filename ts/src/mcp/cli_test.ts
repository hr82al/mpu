/**
 * Поверхность `mpu mcp` и токен доступа: контракт из раздела
 * «CLI-контракт» спеки — коды завершения, права файла токена и то, что
 * токен не печатается нигде, кроме `mpu mcp token`.
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeDenoIo } from "../runtime/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CommandIo, NotFoundIoError } from "../command/mod.ts";
import { commands } from "../registry/mod.ts";
import { runMcpServer } from "./cli.ts";
import { LOOPBACK, type RunningServer, serveMcp } from "./server.ts";
import { ensureAccessToken } from "./token.ts";
import { VERSION } from "../version.ts";

/** Реализация той же версии: сервер спрашивает её при старте. */
const sameVersion = () =>
  Promise.resolve({ code: 0, stdout: `${VERSION}\n`, stderr: "" });

/** Буфер вывода: коды завершения проверяются вместе с текстом. */
function makeOutput() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    sink: {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/** Временный конфиг-каталог с настоящим io поверх файловой системы. */
async function withStore(
  fn: (io: CommandIo, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const real = makeDenoIo(`${dir}/config.json`);
    await fn({ ...real, runLegacy: sameVersion }, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("токен создаётся при первой надобности и переиспользуется", async () => {
  await withStore(async (io, dir) => {
    const first = await ensureAccessToken(io);
    assertMatch(first, /^[A-Za-z0-9_-]{20,}$/);
    assertEquals(await ensureAccessToken(io), first);
    assertStringIncludes(await Deno.readTextFile(`${dir}/token`), first);
  });
});

Deno.test("файл токена создаётся с правами 0600", async () => {
  await withStore(async (io, dir) => {
    await ensureAccessToken(io);
    const mode = (await Deno.stat(`${dir}/token`)).mode;
    // Права — не украшение: файл даёт исполнение мутирующих команд.
    assertEquals(mode === null ? null : mode & 0o777, 0o600);
  });
});

Deno.test("mpu mcp token печатает заголовки одной строкой", async () => {
  await withStore(async (io, dir) => {
    const output = makeOutput();
    assertEquals(await runCli(["mcp", "token"], io, output.sink), 0);
    const token = (await Deno.readTextFile(`${dir}/token`)).trim();
    assertEquals(
      output.stdout(),
      `{"Authorization":"Bearer ${token}"}\n`,
    );
    assertEquals(output.stderr(), "");
  });
});

Deno.test("токен не печатается прочими поверхностями", async (t) => {
  await withStore(async (io, dir) => {
    const token = await ensureAccessToken(io);
    const surfaces: readonly (readonly string[])[] = [
      [],
      ["--help"],
      ["mcp", "--help"],
      ["mcp", "token", "--help"],
      ["xlsx", "alias", "ls"],
      ["xlsx", "resolve"],
    ];
    for (const argv of surfaces) {
      await t.step(`mpu ${argv.join(" ")}`, async () => {
        const output = makeOutput();
        await runCli(argv, io, output.sink);
        assertEquals(output.stdout().includes(token), false, "токен в stdout");
        assertEquals(output.stderr().includes(token), false, "токен в stderr");
      });
    }
    // Сам файл при этом на месте: проверяли поверхности, а не удаление.
    assertStringIncludes(await Deno.readTextFile(`${dir}/token`), token);
  });
});

Deno.test("значение --profile вне ro/rw — exit 2", async (t) => {
  for (const value of ["all", "ro,wr", ""]) {
    await t.step(`--profile ${value || "(пусто)"}`, async () => {
      const output = makeOutput();
      const code = await runMcpServer(["--profile", value], {
        io: makeFakeIo({ runLegacy: sameVersion }),
        output: output.sink,
        commands,
      });
      assertEquals(code, 2);
      assertStringIncludes(output.stderr(), "--profile");
    });
  }
});

Deno.test("неизвестный флаг запуска — exit 2", async () => {
  const output = makeOutput();
  const code = await runMcpServer(["--host", "0.0.0.0"], {
    io: makeFakeIo({ runLegacy: sameVersion }),
    output: output.sink,
    commands,
  });
  assertEquals(code, 2);
  assertStringIncludes(output.stderr(), "--host");
});

Deno.test("занятый порт — exit 1 и текст спеки", async () => {
  const busy = await serveMcp({
    port: 0,
    profiles: ["ro"],
    token: "zanyato",
    deps: { io: makeFakeIo(), commands, version: VERSION },
  });
  try {
    await withStore(async (io) => {
      const output = makeOutput();
      const code = await runMcpServer(["--port", String(busy.port)], {
        io,
        output: output.sink,
        commands,
      });
      assertEquals(code, 1);
      assertEquals(output.stderr(), `mpu mcp: порт ${busy.port} занят\n`);
    });
  } finally {
    await busy.shutdown();
  }
});

Deno.test("голый «mpu mcp» уходит в поверхность запуска", async (t) => {
  await t.step("флаги разбирает она, а не индекс уровня", async () => {
    const output = makeOutput();
    // Ошибка ввода возвращается из самой поверхности: если бы вызов
    // остался индексом группы, был бы напечатан список подкоманд.
    assertEquals(
      await runCli(["mcp", "--profile", "all"], makeFakeIo(), output.sink),
      2,
    );
    assertStringIncludes(output.stderr(), "mpu mcp: значение --profile");
    assertEquals(output.stdout(), "");
  });

  await t.step("--help остаётся индексом уровня", async () => {
    const output = makeOutput();
    assertEquals(
      await runCli(["mcp", "--help"], makeFakeIo(), output.sink),
      0,
    );
    assertStringIncludes(output.stdout(), "token");
    assertEquals(output.stderr(), "");
  });

  await t.step("имя подкоманды по-прежнему маршрутизируется", async () => {
    const output = makeOutput();
    assertEquals(
      await runCli(["mcp", "wat"], makeFakeIo(), output.sink),
      2,
    );
    assertStringIncludes(output.stderr(), "No such command 'mcp wat'");
  });
});

Deno.test("значение --port не порт — exit 2", async (t) => {
  for (const value of ["восемь", "-1", "70000"]) {
    await t.step(`--port ${value}`, async () => {
      const output = makeOutput();
      const code = await runMcpServer([`--port=${value}`], {
        io: makeFakeIo({ runLegacy: sameVersion }),
        output: output.sink,
        commands,
      });
      assertEquals(code, 2);
      assertStringIncludes(output.stderr(), "--port");
    });
  }
});

Deno.test("порт берётся из конфига, когда флага нет", async () => {
  await withStore(async (io) => {
    // Свободный порт занимаем и сразу отпускаем: так он заведомо
    // существует и почти наверняка свободен к моменту запуска.
    const probe = await serveMcp({
      port: 0,
      profiles: ["ro"],
      token: "proba",
      deps: {
        io: makeFakeIo({ runLegacy: sameVersion }),
        commands,
        version: VERSION,
      },
    });
    const wanted = probe.port;
    await probe.shutdown();
    await io.writeConfigStore(
      JSON.stringify({ values: { "mcp.port": String(wanted) }, aliases: {} }),
    );

    const stop = new AbortController();
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer([], {
      io,
      output: makeOutput().sink,
      commands,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    const server = await listening.promise;
    assertEquals(server.port, wanted);
    stop.abort();
    await running;
  });
});

Deno.test("--profile поднимает только названные пути", async () => {
  await withStore(async (io) => {
    const stop = new AbortController();
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer(["--profile", "ro", "--port", "0"], {
      io,
      output: makeOutput().sink,
      commands,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    const server = await listening.promise;
    const token = await ensureAccessToken(io);
    const response = await fetch(`http://${LOOPBACK}:${server.port}/rw`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assertEquals(response.status, 404);
    assertEquals(await response.text(), "");
    stop.abort();
    await running;
  });
});

Deno.test("расхождение версии реализации — предупреждение при старте", async (t) => {
  await t.step("другая версия — сказано в stderr, сервер поднят", async () => {
    await withStore(async (io) => {
      const output = makeOutput();
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer(["--port", "0"], {
        io: {
          ...io,
          runLegacy: () =>
            Promise.resolve({ code: 0, stdout: "0.9.9\n", stderr: "" }),
        },
        output: output.sink,
        commands,
        signal: stop.signal,
        onListen: listening.resolve,
      });
      await listening.promise;
      assertStringIncludes(output.stderr(), "0.9.9");
      assertStringIncludes(output.stderr(), VERSION);
      stop.abort();
      assertEquals(await running, 0);
    });
  });

  await t.step("реализация не ответила версией — молчание", async () => {
    await withStore(async (io) => {
      const output = makeOutput();
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer(["--port", "0"], {
        io: {
          ...io,
          // Ненулевой код: у старой реализации команды `version` могло
          // не быть вовсе — сравнивать не с чем.
          runLegacy: () =>
            Promise.resolve({ code: 2, stdout: "", stderr: "no such command" }),
        },
        output: output.sink,
        commands,
        signal: stop.signal,
        onListen: listening.resolve,
      });
      await listening.promise;
      assertEquals(output.stderr().includes("расходится"), false);
      stop.abort();
      assertEquals(await running, 0);
    });
  });

  await t.step("реализации нет — сервер поднимается молча", async () => {
    await withStore(async (io) => {
      const output = makeOutput();
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer(["--port", "0"], {
        io: {
          ...io,
          runLegacy: () => Promise.reject(new NotFoundIoError("нет бинаря")),
        },
        output: output.sink,
        commands,
        signal: stop.signal,
        onListen: listening.resolve,
      });
      await listening.promise;
      // Про версию ничего: тулы маршрута `legacy` откажут при вызове,
      // а сервер полезен и без них.
      assertEquals(output.stderr().includes("расходится"), false);
      stop.abort();
      assertEquals(await running, 0);
    });
  });
});

Deno.test("mpu mcp поднимает сервер на петле и гаснет по сигналу", async () => {
  await withStore(async (io) => {
    const output = makeOutput();
    const stop = new AbortController();
    // Готовность сообщает сам сервер: опрос буфера здесь голодал бы
    // очередь микрозадач и не давал event loop продвинуться.
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer(["--port", "0"], {
      io,
      output: output.sink,
      commands,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    const server = await listening.promise;
    assertEquals(server.hostname, LOOPBACK);
    assertStringIncludes(output.stderr(), `http://${LOOPBACK}:${server.port}`);
    stop.abort();
    assertEquals(await running, 0);
  });
});
