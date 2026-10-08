/**
 * Вплетение журнала в обе точки входа (`platform/invoke-log.md`):
 * CLI-вызов и вызов тула MCP-сервером. Проверяется не формат записи (он
 * закреплён рядом, `record_test.ts`), а то, у каких вызовов запись
 * появляется и что в неё попадает.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../entrypoint/mod.ts";
import { handleMcp } from "../mcp/mod.ts";
import { nativeEntry } from "../mcp/native_tool.ts";
import { type Command, defineCommand, DomainError, NO_ONE } from "@mpu/command";
import { commands } from "../registry/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const path = `${dir}/mpu.log`;
  const text = async () => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return "";
      }
      throw err;
    }
  };
  try {
    await body({
      log: makeInvokeLog({
        env: { get: () => undefined },
        defaultFile: path,
        pid: 777,
        now,
      }),
      path,
      text,
      records: async () =>
        (await text()).split("\n").filter((line) => line.startsWith("### ")),
    });
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Прогон CLI под журналом — та же склейка, что в `main.ts`. */
async function cli(
  stand: Stand,
  argv: readonly string[],
  io = makeFakeIo({ cwd: () => "/work" }),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const record = stand.log.begin({ kind: "argv", argv, cwd: "/work" });
  const output = record.capture({
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  const code = await runCli(argv, io, output, {
    nativeCall: (command) => record.nativeCall(command),
    note: (line: string) => record.note(line),
    executedBy: (pid) => record.executedBy(pid),
    log: stand.log,
  });
  await record.finish(code);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

it("native-вызов оставляет ровно одну запись", async () => {
  await withStand(async (stand) => {
    const outcome = await cli(stand, ["xlsx", "resolve"]);
    expect((await stand.records()).length).toBe(1);
    const text = await stand.text();
    expect(text).toMatch(/^\$ mpu xlsx resolve$/mu);
    expect(text).toMatch(new RegExp(`exit=${outcome.code} dur=`, "u"));
    // Вывод команды — в записи и на экране одновременно, дословно.
    expect(text).toContain(outcome.stdout.split("\n")[0]);
  });
});

it("вход в Telegram: журнал не получает ни строки вывода", async () => {
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
          get: (name) => (name === "TELEGRAM_SESSION" ? session : undefined),
          values: () => ({}),
          require: () => {
            throw new Error("require не ожидается");
          },
          set: () => Promise.reject(new Error("set не ожидается")),
        },
        // Спросить некого — вход и не начинается; на экран идёт строка
        // «уже авторизован», и она‑то в журнал попасть не должна.
        prompt: NO_ONE,
        progress: () => {},
      }),
    );
    expect(outcome.code).toBe(0);
    const text = await stand.text();
    // Запись о вызове есть — иначе проверять было бы нечего.
    expect((await stand.records()).length).toBe(1);
    expect(text).toMatch(/^\$ mpu telegram login$/mu);
    // А вывода в ней нет вовсе.
    expect(text.includes(session), text).toBe(false);
    expect(text.includes("уже авторизован"), text).toBe(false);
  });
});

describe("реестровые поверхности записей не оставляют", () => {
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
    it(name, async () => {
      await withStand(async (stand) => {
        await cli(stand, argv);
        expect(await stand.text()).toBe("");
      });
    });
  }
});

it("режим дополнения записей не оставляет", async () => {
  await withStand(async (stand) => {
    await cli(
      stand,
      [],
      makeFakeIo({
        env: (name) =>
          ({ _MPU_COMPLETE: "complete_bash", COMP_WORDS: "mpu ver" })[name],
      }),
    );
    expect(await stand.text()).toBe("");
  });
});

it("выброшенный sw-маршрут: запись всё равно есть", async () => {
  await withStand(async (stand) => {
    // Прежде этот вызов уходил мостом в прежнюю реализацию, и обвязка
    // записи не делала: её писал подпроцесс. Маршрут снят (порция 97),
    // отказ печатает сама команда — и запись о вызове теперь наша.
    const outcome = await cli(stand, ["sql-ro", "sw", "SELECT 1"]);
    expect(outcome.code).toBe(2);
    expect((await stand.records()).length).toBe(1);
    expect(await stand.text()).toContain("$ mpu sql-ro sw 'SELECT 1'");
  });
});

it("ошибка команды: запись остаётся, код и текст в ней", async () => {
  await withStand(async (stand) => {
    const outcome = await cli(stand, ["xlsx", "get", "--нет-такой-опции"]);
    expect(outcome.code).toBe(2);
    const text = await stand.text();
    expect((await stand.records()).length).toBe(1);
    expect(text).toMatch(/^--- err run=\S+ ---$/mu);
    expect(text).toContain(outcome.stderr.split("\n")[0]);
    expect(text).toMatch(/exit=2 dur=/u);
  });
});

describe("пометка «без записи вывода» — часть объявления команды", () => {
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
  it("умолчание — вывод пишется", () => {
    expect(defineCommand(declaration).logsOutput).toBe(true);
  });
  it("пометка выключает секции вывода", () => {
    expect(
      defineCommand({ ...declaration, logsOutput: false }).logsOutput,
    ).toBe(false);
  });
  it("пометка доезжает до записи тула", () => {
    const marked = defineCommand({ ...declaration, logsOutput: false });
    expect(nativeEntry(marked).journal).toStrictEqual({
      logsOutput: false,
      logsArguments: true,
      logsStdout: true,
      path: ["фейк"],
    });
    expect(nativeEntry(defineCommand(declaration)).journal).toStrictEqual({
      logsOutput: true,
      logsArguments: true,
      logsStdout: true,
      path: ["фейк"],
    });
  });
  it("в реестре пометка стоит у восемнадцати команд", () => {
    // Все печатают то, чему в журнале не место: `search` — живые
    // токены сессий 10X, `log` — сам журнал (иначе он печатал бы
    // себя), `users add` — собранную
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
    expect(marked).toStrictEqual([
      "search",
      "log",
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
  io = makeFakeIo({ cwd: () => "/work" }),
  published: readonly Command[] = commands,
) {
  return handleMcp(
    {
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
    },
    { io, commands: published, version: "0.0.0-test", log },
  );
}

describe("вызов тула журналируется как вторая точка входа", () => {
  it("строка команды — путь и JSON, маскирование внутри", async () => {
    await withStand(async (stand) => {
      await toolCall(stand.log, "xlsx_resolve", { file: "/tmp/книга.xlsx" });
      const text = await stand.text();
      expect((await stand.records()).length).toBe(1);
      expect(text).toMatch(/^### \S+ \S+ \S+ run=\S+ pid=777 cwd=\/work$/mu);
      expect(text).toMatch(
        /^\$ mpu xlsx resolve '\{"file":"\/tmp\/книга\.xlsx"\}'$/mu,
      );
      expect(text).toMatch(/exit=0 dur=/u);
    });
  });
  it("секретные ключи JSON маскируются", async () => {
    await withStand(async (stand) => {
      await toolCall(stand.log, "xlsx_resolve", { token: "s3cret" });
      const text = await stand.text();
      expect(text).toMatch(/^\$ mpu xlsx resolve '\{"token":"REDACTED"\}'$/mu);
      expect(text.includes("s3cret")).toBe(false);
    });
  });
  it("ошибка ввода — код 2 и текст в err", async () => {
    await withStand(async (stand) => {
      await toolCall(stand.log, "xlsx_resolve", { нет: 1 });
      const text = await stand.text();
      expect(text).toMatch(/exit=2 dur=/u);
      expect(text).toContain('unknown argument "нет"');
    });
  });
  it("строки хода исполнения попадают в запись", async () => {
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
      expect(printed).toStrictEqual(["шаг 1", "шаг 2"]);
      expect(await stand.text()).toMatch(
        /^--- err run=\S+ ---\nшаг 1\nшаг 2\n/mu,
      );
    });
  });
  it("два вызова в одну миллисекунду — разные run_id", async () => {
    await withStand(
      async (stand) => {
        await toolCall(stand.log, "xlsx_resolve", {});
        await toolCall(stand.log, "xlsx_resolve", {});
        const ids = (await stand.records()).map((line) =>
          line.split(" ").find((part) => part.startsWith("run=")),
        );
        expect(ids.length).toBe(2);
        expect(new Set(ids).size, `run_id повторились: ${ids}`).toBe(2);
      },
      () => new Date("2026-08-05T04:42:28.205Z"),
    );
  });
});

describe("пометка «без записи аргументов»: текста заметки в журнале нет", () => {
  it("в реестре пометка стоит у пятнадцати команд", () => {
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
    expect(marked).toStrictEqual([
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

  it("скрыв ввод, команда решила и про вывод", () => {
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
    expect(
      commands
        .filter((command) => !command.logsArguments)
        .map((command) => [command.path.join(" "), command.logsOutput]),
      "команда со скрытым вводом не названа здесь вместе с доводом",
    ).toStrictEqual(decided.map(([path, logsOutput]) => [path, logsOutput]));
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

  it("строка вызова маскирована, текста заметки нет", async () => {
    await withStand(async (stand) => {
      await cli(stand, ["telegram", "log", "деплой упал в 3 ночи"], botless());
      const text = await stand.text();
      expect((await stand.records()).length).toBe(1);
      expect(text).toMatch(/^\$ mpu telegram log REDACTED$/mu);
      expect(text.includes("деплой упал")).toBe(false);
    });
  });

  it("ошибка разбора аргументов заметку не эхо-печатает", async () => {
    await withStand(async (stand) => {
      // Заметка без кавычек — самый естественный способ вызова: хвост
      // уходит в «unexpected argument», и его текст попал бы в err.
      const outcome = await cli(
        stand,
        ["telegram", "log", "деплой", "упал"],
        botless(),
      );
      expect(outcome.stderr).toContain("unexpected argument REDACTED");
      const text = await stand.text();
      expect(text.includes("упал")).toBe(false);
      // В записи от ошибки ввода помеченной команды остаётся одна
      // маска: её текст по построению может нести сам ввод.
      expect(text).toMatch(/^--- err run=\S+ ---\nREDACTED\n/mu);
    });
  });
});

describe("журнал: значение опции по объявлению команды", () => {
  it("объявленная опция читается целиком", async () => {
    await withStand(async (stand) => {
      // `--since` объявлена `mpu log` и берёт значение: запись обязана
      // остаться читаемой, иначе журнал перестаёт годиться для разбора.
      await cli(stand, ["log", "--since", "1m", "--file", "/нет/такого.log"]);
      expect(await stand.text()).toMatch(/^\$ mpu log --since 1m /mu);
    });
  });

  it("необъявленная прячет значение в обеих формах", async () => {
    for (const argv of [
      ["log", "--pasword", "hunter2"],
      ["log", "--pasword=hunter2"],
    ]) {
      await withStand(async (stand) => {
        const outcome = await cli(stand, argv);
        const text = await stand.text();
        // Ни в строке вызова, ни в секции ошибки — а обе поверхности
        // обязаны вести себя одинаково: одна дырка сводит на нет вторую
        // защиту.
        expect(text.includes("hunter2")).toBe(false);
        expect(outcome.stderr.includes("hunter2")).toBe(false);
        expect(text).toContain("--pasword");
      });
    }
  });

  it("хвост ssh пишется целиком", async () => {
    await withStand(async (stand) => {
      // Запись делается тем же путём, что у точки входа, но команда не
      // исполняется: проверяется журнал, а не поход в контейнер.
      const argv = ["ssh", "sl-9", "psql", "--tuples-only", "-c", "SELECT 1"];
      const ssh = commands.find((command) => command.path.join(" ") === "ssh");
      expect(ssh?.inputs.some((input) => input.form.keepsUnknown)).toBe(true);
      const record = stand.log.begin({ kind: "argv", argv, cwd: "/work" });
      record.nativeCall(ssh!);
      await record.finish(0);
      const text = await stand.text();
      // Чужая командная строка цела: ради неё запись и читают.
      expect(text).toContain("--tuples-only");
      expect(text).toContain("SELECT 1");
      expect(text.includes("REDACTED")).toBe(false);
    });
  });
});
