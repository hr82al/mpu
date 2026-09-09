import { assert, assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import {
  disableService,
  enableService,
  programVersion,
  readServiceState,
  restartIfRunning,
  restartService,
  type RunProgram,
  SERVICE_NAME,
  serviceDir,
  sessionLinger,
  startService,
  stopService,
  unitText,
} from "./service.ts";

const PROGRAM = "/home/u/.local/bin/mpu";

/** Ответы менеджера по подкоманде; запись всех вызовов — для сверки. */
interface Manager {
  readonly run: RunProgram;
  readonly calls: string[][];
}

function manager(
  replies: Readonly<Record<string, ProgramReply>> = {},
): Manager {
  const calls: string[][] = [];
  const run: RunProgram = (bin, args) => {
    calls.push([bin, ...args]);
    const reply = replies[args[1] ?? ""] ?? { code: 0, stdout: "" };
    return Promise.resolve({
      code: reply.code,
      stdout: reply.stdout,
      stderr: reply.stderr ?? "",
    });
  };
  return { run, calls };
}

interface ProgramReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

/** Каталог служб на время одной проверки. */
async function withDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body(`${dir}/systemd/user`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("описание: ExecStart — путь установки, аргумент один", () => {
  const text = unitText(PROGRAM);
  assertEquals(
    text.includes(`ExecStart=${PROGRAM} mcp`),
    true,
    `описание без ExecStart по пути установки:\n${text}`,
  );
  // Порт и профили берутся из конфигурации, а не из описания: иначе их
  // меняли бы переписыванием файла, а не перезапуском.
  assertEquals(text.includes("--port"), false);
  assertEquals(text.includes("--profile"), false);
});

Deno.test("каталог служб — systemd/user каталога конфигурации", () => {
  assertEquals(serviceDir("/h/.config"), "/h/.config/systemd/user");
});

Deno.test("enable: описание записано, автозапуск включён, служба поднята", async () => {
  await withDir(async (dir) => {
    const m = manager({ "is-active": { code: 3, stdout: "inactive\n" } });
    const deps = { dir, program: PROGRAM, run: m.run };
    await enableService(deps);
    const text = await Deno.readTextFile(`${dir}/${SERVICE_NAME}`);
    assertEquals(text, unitText(PROGRAM));
    const said = m.calls.map((call) => call.slice(1).join(" "));
    assert(said.includes("--user daemon-reload"), said.join("; "));
    assert(said.includes(`--user enable ${SERVICE_NAME}`), said.join("; "));
    assert(said.includes(`--user start ${SERVICE_NAME}`), said.join("; "));
  });
});

Deno.test("enable на работающей: перезапуск, а не второй старт", async () => {
  await withDir(async (dir) => {
    const m = manager({ "is-active": { code: 0, stdout: "active\n" } });
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
    await enableService({ dir, program: PROGRAM, run: m.run });
    const said = m.calls.map((call) => call.slice(1).join(" "));
    assert(said.includes(`--user restart ${SERVICE_NAME}`), said.join("; "));
    assertEquals(said.includes(`--user start ${SERVICE_NAME}`), false);
  });
});

Deno.test("после disable описания нет, и start отказывает", async () => {
  await withDir(async (dir) => {
    const m = manager({ "is-active": { code: 3, stdout: "inactive\n" } });
    const deps = { dir, program: PROGRAM, run: m.run };
    await enableService(deps);
    assertEquals(await disableService(deps), true);
    await assertRejects(
      () => startService(deps),
      DomainError,
      "mpu mcp enable",
    );
    assertEquals((await readServiceState(deps)).program, null);
  });
});

Deno.test("disable без описания ничего не меняет", async () => {
  await withDir(async (dir) => {
    const m = manager();
    assertEquals(
      await disableService({ dir, program: PROGRAM, run: m.run }),
      false,
    );
    assertEquals(m.calls, []);
  });
});

Deno.test("stop без описания — отказ", async () => {
  await withDir(async (dir) => {
    const m = manager();
    await assertRejects(
      () => stopService({ dir, program: PROGRAM, run: m.run }),
      DomainError,
      "mpu mcp enable",
    );
  });
});

Deno.test("повторный вызов оставляет ту же картину", async (t) => {
  await t.step("start на работающей", async () => {
    await withDir(async (dir) => {
      const m = manager({ "is-active": { code: 0, stdout: "active\n" } });
      const deps = { dir, program: PROGRAM, run: m.run };
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
      assertEquals((await startService(deps)).changed, false);
      const said = m.calls.map((call) => call.slice(1).join(" "));
      assertEquals(said.includes(`--user start ${SERVICE_NAME}`), false);
    });
  });
  await t.step("stop на остановленной", async () => {
    await withDir(async (dir) => {
      const m = manager({ "is-active": { code: 3, stdout: "inactive\n" } });
      const deps = { dir, program: PROGRAM, run: m.run };
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
      assertEquals((await stopService(deps)).changed, false);
      const said = m.calls.map((call) => call.slice(1).join(" "));
      assertEquals(said.includes(`--user stop ${SERVICE_NAME}`), false);
    });
  });
});

Deno.test("состояние: описание, активность и автозапуск — из двух источников", async () => {
  await withDir(async (dir) => {
    const m = manager({
      "is-active": { code: 0, stdout: "active\n" },
      "is-enabled": { code: 0, stdout: "enabled\n" },
    });
    const deps = { dir, program: PROGRAM, run: m.run };
    assertEquals(await readServiceState(deps), {
      program: null,
      activity: "inactive",
      enabled: false,
    });
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
    assertEquals(await readServiceState(deps), {
      program: PROGRAM,
      activity: "active",
      enabled: true,
    });
  });
});

Deno.test("перезапуск после сборки: только работающую", async (t) => {
  await t.step("работает — перезапущена", async () => {
    await withDir(async (dir) => {
      const m = manager({ "is-active": { code: 0, stdout: "active\n" } });
      const deps = { dir, program: PROGRAM, run: m.run };
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
      assertEquals(await restartIfRunning(deps), true);
    });
  });
  await t.step("описания нет — не тронута", async () => {
    await withDir(async (dir) => {
      const m = manager();
      assertEquals(
        await restartIfRunning({ dir, program: PROGRAM, run: m.run }),
        false,
      );
      assertEquals(m.calls, []);
    });
  });
});

Deno.test("задержка сеанса: по числовому идентификатору, отказ — «неизвестна»", async (t) => {
  const cases = [
    { name: "задержан", linger: { code: 0, stdout: "yes\n" }, want: "on" },
    { name: "не задержан", linger: { code: 0, stdout: "no\n" }, want: "off" },
    {
      name: "loginctl не ответил",
      linger: { code: 1, stdout: "" },
      want: "unknown",
    },
  ] as const;
  for (const { name, linger, want } of cases) {
    await t.step(name, async () => {
      const calls: string[][] = [];
      const run: RunProgram = (bin, args) => {
        calls.push([bin, ...args]);
        if (bin === "id") {
          return Promise.resolve({ code: 0, stdout: "1000\n", stderr: "" });
        }
        return Promise.resolve({ ...linger, stderr: "" });
      };
      assertEquals(await sessionLinger(run), want);
      // Имя пользователя берётся числовым идентификатором: `USER`
      // запрещена правом `--deny-env`.
      assertEquals(calls[0], ["id", "-u"]);
      assert(calls[1].includes("1000"), calls[1].join(" "));
    });
  }
});

Deno.test("версия — у программы из описания, а не у работающей копии", async () => {
  const run: RunProgram = (bin, args) => {
    assertEquals([bin, ...args], [PROGRAM, "version"]);
    return Promise.resolve({ code: 0, stdout: "0.1.0\n", stderr: "" });
  };
  assertEquals(await programVersion(PROGRAM, run), "0.1.0");
  const broken: RunProgram = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "нет" });
  assertEquals(await programVersion(PROGRAM, broken), null);
});

Deno.test("чужой ExecStart не порождается — «версии нет», а не трасса", async (t) => {
  // Описание может быть написано не нами: по пути окажется каталог или
  // неисполняемый файл. Для команды состояния это ответ, а не отказ.
  const cases = [
    new Deno.errors.NotFound("нет файла"),
    new Deno.errors.PermissionDenied("не исполняется"),
    new Deno.errors.NotCapable("нет права --allow-run"),
    new Deno.errors.IsADirectory("это каталог"),
  ];
  for (const failure of cases) {
    await t.step(failure.name, async () => {
      const run: RunProgram = () => Promise.reject(failure);
      assertEquals(await programVersion(PROGRAM, run), null);
      assertEquals(await sessionLinger(run), "unknown");
    });
  }
});

Deno.test("менеджера нет — описания не создано", async () => {
  await withDir(async (dir) => {
    const run: RunProgram = (bin) => {
      if (bin === "systemctl") {
        return Promise.reject(new Deno.errors.NotFound("systemctl"));
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await assertRejects(
      () => enableService({ dir, program: PROGRAM, run }),
      DomainError,
      "менеджера служб пользователя нет",
    );
    await assertRejects(
      () => Deno.stat(`${dir}/${SERVICE_NAME}`),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("перезапуск на занятом порту: activating — работает", async (t) => {
  const cases = [
    { answer: "activating", running: true },
    { answer: "active", running: true },
    { answer: "deactivating", running: false },
    { answer: "failed", running: false },
    { answer: "inactive", running: false },
    { answer: "какое-то-новое-слово", running: false },
  ] as const;
  for (const { answer, running } of cases) {
    await t.step(answer, async () => {
      await withDir(async (dir) => {
        const m = manager({ "is-active": { code: 0, stdout: `${answer}\n` } });
        const deps = { dir, program: PROGRAM, run: m.run };
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
        // Останавливать надо всё, что ещё живо; запускать — всё, что нет.
        assertEquals((await stopService(deps)).changed, running);
        assertEquals((await startService(deps)).changed, !running);
        assertEquals(await restartIfRunning(deps), running);
      });
    });
  }
});

Deno.test("ExecStart чужого описания не исполняется вслепую", async (t) => {
  const cases = [
    {
      name: "префикс systemd",
      line: "-/usr/bin/mpu mcp",
      want: "/usr/bin/mpu",
    },
    { name: "кавычки", line: '"/usr/bin/my mpu" mcp', want: "/usr/bin/my mpu" },
    { name: "непарная кавычка", line: '"/usr/bin/mpu', want: "" },
  ];
  for (const { name, line, want } of cases) {
    await t.step(name, async () => {
      await withDir(async (dir) => {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/${SERVICE_NAME}`,
          `[Service]\nExecStart=${line}\n`,
        );
        const m = manager();
        const state = await readServiceState({
          dir,
          program: PROGRAM,
          run: m.run,
        });
        assertEquals(state.program, want);
      });
    });
  }
});

Deno.test("restart — одно обращение к менеджеру, а не stop и start", async (t) => {
  /**
   * Менеджер, у которого `start` отказывает, а `restart` работает.
   * Такое расхождение и разделяет две реализации: собранная из пары
   * оставит службу лежать на втором шаге, одно обращение — нет.
   */
  function pickyManager(active: { now: boolean }) {
    const calls: string[] = [];
    const run: RunProgram = (_bin, args) => {
      const verb = args[1] ?? "";
      calls.push(verb);
      if (verb === "is-active") {
        return Promise.resolve({
          code: 0,
          stdout: active.now ? "active\n" : "inactive\n",
          stderr: "",
        });
      }
      if (verb === "stop") {
        active.now = false;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      if (verb === "start") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "порт занят\n" });
      }
      if (verb === "restart") {
        active.now = true;
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    return { run, calls };
  }

  await t.step(
    "отказ на втором шаге не оставляет службу остановленной",
    async () => {
      await withDir(async (dir) => {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
        const active = { now: true };
        const m = pickyManager(active);
        const deps = { dir, program: PROGRAM, run: m.run };
        const restarted = await restartService(deps);
        assertEquals(restarted.wasRunning, true);
        assertEquals(restarted.state.activity, "active");
        assertEquals(active.now, true, "служба осталась лежать");
        assertEquals(
          m.calls.includes("stop"),
          false,
          `перезапуск собран из пары: ${m.calls.join(", ")}`,
        );
        // И само обращение было, и ровно одно: «нет stop» в одиночку
        // зеленело бы и у реализации, не делающей вообще ничего.
        assertEquals(
          m.calls.filter((verb) => verb === "restart").length,
          1,
          m.calls.join(", "),
        );
      });
    },
  );

  await t.step(
    "остановленную поднимает и говорит, что она стояла",
    async () => {
      await withDir(async (dir) => {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText(PROGRAM));
        const active = { now: false };
        const m = pickyManager(active);
        const restarted = await restartService({
          dir,
          program: PROGRAM,
          run: m.run,
        });
        assertEquals(restarted.wasRunning, false);
        assertEquals(active.now, true);
      });
    },
  );

  await t.step("описания нет — тот же отказ, что у start и stop", async () => {
    await withDir(async (dir) => {
      const m = manager();
      await assertRejects(
        () => restartService({ dir, program: PROGRAM, run: m.run }),
        DomainError,
        "mpu mcp enable",
      );
      assertEquals(m.calls, []);
    });
  });
});
