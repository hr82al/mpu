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
import { type Command, defineCommand, DomainError } from "../command/mod.ts";
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
    note: (line: string) => record.note(line),
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

Deno.test("вход в Telegram: журнал не получает ни строки вывода", async () => {
  // Строка сессии — полноценный доступ к аккаунту
  // (`docs/specs/telegram-login.md`, инвариант 1). Команда её не
  // печатает, но одной дисциплины мало: журнал копирует ВЕСЬ вывод
  // помеченных команд, и достаточно одной случайной строки, чтобы
  // секрет лёг на диск вторым экземпляром. Поэтому у входа перехват
  // вывода снят, и проверяется это по содержимому записи, а не по
  // объявлению: мутация «вернуть logsOutput» краснеет здесь.
  const session = "СЕКРЕТ-СЕССИИ-9f2";
  await withStand(async (stand) => {
    const outcome = await cli(
      stand,
      ["telegram", "login"],
      makeFakeIo({
        envFile: {
          get: (name) => name === "TELEGRAM_SESSION" ? session : undefined,
          values: () => ({}),
          require: () => {
            throw new Error("require не ожидается");
          },
          set: () => Promise.reject(new Error("set не ожидается")),
        },
        // Терминала нет — вход и не начинается; на экран идёт строка
        // «уже авторизован», и она‑то в журнал попасть не должна.
        openTerminal: () => Promise.resolve(undefined),
        progress: () => {},
      }),
    );
    assertEquals(outcome.code, 0);
    const text = await stand.text();
    // Запись о вызове есть — иначе проверять было бы нечего.
    assertEquals((await stand.records()).length, 1);
    assertMatch(text, /^\$ mpu telegram login$/mu);
    // А вывода в ней нет вовсе.
    assertEquals(text.includes(session), false, text);
    assertEquals(text.includes("уже авторизован"), false, text);
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

Deno.test("выброшенный sw-маршрут: запись всё равно есть", async () => {
  await withStand(async (stand) => {
    // Прежде этот вызов уходил мостом в прежнюю реализацию, и обвязка
    // записи не делала: её писал подпроцесс. Маршрут снят (порция 97),
    // отказ печатает сама команда — и запись о вызове теперь наша.
    const outcome = await cli(stand, ["sql-ro", "sw", "SELECT 1"]);
    assertEquals(outcome.code, 2);
    assertEquals((await stand.records()).length, 1);
    assertStringIncludes(await stand.text(), "$ mpu sql-ro sw 'SELECT 1'");
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
    assertEquals(nativeEntry(marked).journal, {
      logsOutput: false,
      logsArguments: true,
      path: ["фейк"],
    });
    assertEquals(nativeEntry(defineCommand(declaration)).journal, {
      logsOutput: true,
      logsArguments: true,
      path: ["фейк"],
    });
  });
  await t.step("в реестре пометка стоит у девятнадцати команд", () => {
    // Все печатают то, чему в журнале не место: `search` — живые
    // токены сессий 10X, `log` — сам журнал (иначе он печатал бы
    // себя), `mcp token` — токен доступа, `users add` — собранную
    // команду с паролем заводимого пользователя, `confirm` — чужой
    // буфер конвейера, дословно равный его вводу, `telegram login` —
    // строку сессии Telegram, то есть полноценный доступ к аккаунту
    // (`docs/specs/telegram-login.md`, инвариант 1), `api get-token` —
    // живой токен sl-back (`docs/specs/api.md`). Остальные — команды
    // `api`, чей ОТВЕТ несёт чужие ключи, токены или персональные
    // данные: четыре читающих и семь из остатка (`api-write.md`).
    // Порядок — порядок реестра.
    const marked = commands
      .filter((command) => !command.logsOutput)
      .map((command) => command.path.join(" "));
    assertEquals(marked, [
      "search",
      "log",
      "mcp token",
      "telegram login",
      "users add",
      "confirm",
      "api add-client-ozon-key",
      "api add-client-wb-token",
      "api auth-login",
      "api auth-refresh",
      "api create-user",
      "api get-token",
      "api get-user",
      "api list-client-ozon-keys",
      "api list-client-wb-tokens",
      "api list-users",
      "api update-user",
      "api wb-token-ping-content",
      "api wb-token-seller-info",
    ]);
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

Deno.test("пометка «без записи аргументов»: текста заметки в журнале нет", async (t) => {
  await t.step("в реестре пометка стоит у пятнадцати команд", () => {
    // Единственный аргумент `telegram log` персонален сам по себе —
    // это заметка пользователя (`docs/specs/telegram-log.md`); у
    // `users add` среди аргументов пароль заводимого пользователя
    // (`docs/specs/portainer-wrappers.md`), у `api get-token` — пароль
    // в `--password` (`docs/specs/api.md`). Остальные двенадцать — из
    // остатка `api`: у них среди объявленных полей пароль, токен или
    // ключ, и строка `$ mpu api … --password …` легла бы на диск
    // вместе с ним (`api-write.md`). Список закрытый: пометка —
    // свойство команды в реестре, и молча вырасти он не должен.
    const marked = commands
      .filter((command) => !command.logsArguments)
      .map((command) => command.path.join(" "));
    assertEquals(marked, [
      "telegram log",
      "users add",
      "api add-client-ozon-key",
      "api add-client-wb-token",
      "api auth-change-password",
      "api auth-login",
      "api cli-log-heartbeat",
      "api cli-log-subscribe",
      "api cli-log-unsubscribe",
      "api create-user",
      "api delete-client-wb-token",
      "api get-token",
      "api update-user",
      "api wb-token-ping-content",
      "api wb-token-seller-info",
    ]);
  });

  await t.step("скрыв ввод, команда решила и про вывод", () => {
    // Тип требует написать `logsOutput` явно, но `as` мимо типа
    // проходит, а решение обязано быть записанным вместе с причиной.
    // Поэтому обход реестра: состав закрыт, и у каждой команды здесь
    // назван довод, по которому вывод скрыт либо оставлен.
    const decided: readonly (readonly [string, boolean, string])[] = [
      [
        "telegram log",
        true,
        "в выводе только номер сообщения, ввода в нём нет",
      ],
      ["users add", false, "в режиме печати вывод и есть ввод"],
      ["api add-client-ozon-key", false, "ответ повторяет ключи клиента"],
      ["api add-client-wb-token", false, "ответ повторяет токен кабинета"],
      [
        "api auth-change-password",
        true,
        "ответ — признак успеха; пароль остался во вводе",
      ],
      ["api auth-login", false, "ответ несёт accessToken"],
      [
        "api cli-log-heartbeat",
        true,
        "ответ — признак живости, ключ остался во вводе",
      ],
      ["api cli-log-subscribe", true, "то же: ключ только во вводе"],
      ["api cli-log-unsubscribe", true, "то же: ключ только во вводе"],
      ["api create-user", false, "ответ несёт почту и ссылку активации"],
      [
        "api delete-client-wb-token",
        true,
        "ответ — признак удаления; токен назван во вводе",
      ],
      ["api get-token", false, "вывод — живой токен sl-back"],
      ["api update-user", false, "ответ несёт персональные данные"],
      ["api wb-token-ping-content", false, "ответ повторяет проверяемый токен"],
      ["api wb-token-seller-info", false, "ответ повторяет проверяемый токен"],
    ];
    assertEquals(
      commands
        .filter((command) => !command.logsArguments)
        .map((command) => [command.path.join(" "), command.logsOutput]),
      decided.map(([path, logsOutput]) => [path, logsOutput]),
      "команда со скрытым вводом не названа здесь вместе с доводом",
    );
  });

  // Ключей бота в стенде нет: вызов падает конфигурацией, но запись
  // журнала создаётся и у падения — она и проверяется.
  const botless = () =>
    makeFakeIo({
      envFile: {
        get: () => undefined,
        values: () => ({}),
        require: (name: string) => {
          throw new DomainError(`env: в файле нет ключа ${name}`);
        },
        set: () => Promise.resolve(),
      },
    });

  await t.step("строка вызова маскирована, текста заметки нет", async () => {
    await withStand(async (stand) => {
      await cli(stand, ["telegram", "log", "деплой упал в 3 ночи"], botless());
      const text = await stand.text();
      assertEquals((await stand.records()).length, 1);
      assertMatch(text, /^\$ mpu telegram log REDACTED$/mu);
      assertEquals(text.includes("деплой упал"), false);
    });
  });

  await t.step(
    "ошибка разбора аргументов заметку не эхо-печатает",
    async () => {
      await withStand(async (stand) => {
        // Заметка без кавычек — самый естественный способ вызова: хвост
        // уходит в «unexpected argument», и его текст попал бы в err.
        const outcome = await cli(
          stand,
          ["telegram", "log", "деплой", "упал"],
          botless(),
        );
        assertStringIncludes(outcome.stderr, "unexpected argument REDACTED");
        const text = await stand.text();
        assertEquals(text.includes("упал"), false);
        // В записи от ошибки ввода помеченной команды остаётся одна
        // маска: её текст по построению может нести сам ввод.
        assertMatch(text, /^--- err run=\S+ ---\nREDACTED\n/mu);
      });
    },
  );
});

Deno.test("журнал: значение опции по объявлению команды", async (t) => {
  await t.step("объявленная опция читается целиком", async () => {
    await withStand(async (stand) => {
      // `--since` объявлена `mpu log` и берёт значение: запись обязана
      // остаться читаемой, иначе журнал перестаёт годиться для разбора.
      await cli(stand, ["log", "--since", "1m", "--file", "/нет/такого.log"]);
      assertMatch(await stand.text(), /^\$ mpu log --since 1m /mu);
    });
  });

  await t.step("необъявленная прячет значение в обеих формах", async () => {
    for (
      const argv of [
        ["log", "--pasword", "hunter2"],
        ["log", "--pasword=hunter2"],
      ]
    ) {
      await withStand(async (stand) => {
        const outcome = await cli(stand, argv);
        const text = await stand.text();
        // Ни в строке вызова, ни в секции ошибки — а обе поверхности
        // обязаны вести себя одинаково: одна дырка сводит на нет вторую
        // защиту.
        assertEquals(text.includes("hunter2"), false);
        assertEquals(outcome.stderr.includes("hunter2"), false);
        assertStringIncludes(text, "--pasword");
      });
    }
  });

  await t.step("хвост ssh пишется целиком", async () => {
    await withStand(async (stand) => {
      // Запись делается тем же путём, что у точки входа, но команда не
      // исполняется: проверяется журнал, а не поход в контейнер.
      const argv = ["ssh", "sl-9", "psql", "--tuples-only", "-c", "SELECT 1"];
      const ssh = commands.find((command) => command.path.join(" ") === "ssh");
      assertEquals(ssh?.inputs.some((input) => input.form.keepsUnknown), true);
      const record = stand.log.begin({ kind: "argv", argv });
      record.nativeCall(ssh!);
      await record.finish(0);
      const text = await stand.text();
      // Чужая командная строка цела: ради неё запись и читают.
      assertStringIncludes(text, "--tuples-only");
      assertStringIncludes(text, "SELECT 1");
      assertEquals(text.includes("REDACTED"), false);
    });
  });
});
