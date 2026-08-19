/**
 * Обёртки `mpu ss-update` и `mpu wb-loader`
 * (`docs/specs/portainer-wrappers.md`). Живого контейнера в тестах нет:
 * подпроцесс ssh и буфер обмена подставные, а печать сверяется с
 * эталонами канала — в них домашний каталог записан плейсхолдером.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type CacheDb,
  formatCommandError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import type { RunProcess } from "../exec/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { dataLoaderCommand } from "./cmd_data_loader.ts";
import { ozonRecalculateExpensesCommand } from "./cmd_ozon_recalculate_expenses.ts";
import { ozonSaveExpensesCommand } from "./cmd_ozon_save_expenses.ts";
import { ssUpdateCommand } from "./cmd_ss_update.ts";
import { wbLoaderCommands } from "./cmd_wb_loader.ts";
import { wbRecalculateExpensesCommand } from "./cmd_wb_recalculate_expenses.ts";
import { wbSaveExpensesCommand } from "./cmd_wb_save_expenses.ts";
import { localDate } from "./dates.ts";
import {
  runWrap,
  type WrapArgs,
  type WrapContext,
  type WrapIo,
  type WrapOptions,
  type WrapResult,
} from "./run.ts";

const HOME = "/home/проба";

/** Синтетический конфиг эталонов канала. */
const ENV: Readonly<Record<string, string>> = {
  sl_9: "10.9.9.9",
  PG_MY_USER_NAME: "probeuser",
};

/** Клиент 777 на девятом сервере с единственной таблицей. */
const CLIENT = { id: 777, server: "sl-9", sheet: "SHEET123" };

function harness(db: CacheDb, env: Readonly<Record<string, string>> = ENV) {
  const progress: string[] = [];
  const output: RemoteOutput & { readonly text: () => string } = (() => {
    const parts: string[] = [];
    const append = (chunk: Uint8Array) => {
      parts.push(new TextDecoder().decode(chunk));
    };
    return {
      out: append,
      err: append,
      captured: () => parts.join(""),
      text: () => parts.join(""),
    };
  })();
  const io = makeFakeIo({
    env: (name) => name === "HOME" ? HOME : undefined,
    envFile: {
      get: (name) => env[name],
      values: () => ({ ...env }),
      require: (name) => env[name] ?? "",
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    progress: (line: string) => progress.push(line),
    openRemoteOutput: () => output,
  });
  return { io, progress, output };
}

/** Копия эталона канала с подставленным домашним каталогом. */
async function golden(name: string): Promise<string> {
  const text = await Deno.readTextFile(
    new URL(`./testdata/portainer-wrappers/${name}`, import.meta.url),
  );
  return text.replaceAll("<HOME>", HOME);
}

/** Кэш-БД с одним клиентом; `containers` — строки таблицы контейнеров. */
async function withCache(
  containers: readonly string[],
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
      CLIENT.id,
      CLIENT.server,
      1_700_000_000,
    );
    db.execute(
      "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
        " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
      CLIENT.sheet,
      CLIENT.id,
      "Таблица клиента",
      CLIENT.server,
      1_700_000_000,
    );
    for (const [index, name] of containers.entries()) {
      db.execute(
        "INSERT INTO portainer_containers (portainer_url, endpoint_id," +
          " endpoint_name, container_id, container_name, server_number," +
          " state, image, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "https://portainer.example",
        1,
        "farm",
        `id-${index}`,
        name,
        9,
        "running",
        "образ",
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Подставной ssh: помнит удалённую строку и отдаёт код. */
function fakeSsh(code = 0) {
  const calls: string[] = [];
  const run: RunProcess = (_bin, argv, _stdin, output) => {
    calls.push(argv[3] ?? "");
    output.out(new TextEncoder().encode("вывод inner-команды\n"));
    return Promise.resolve(code);
  };
  return { run, calls };
}

function options(overrides: Partial<WrapOptions> = {}): WrapOptions {
  return { copy: () => Promise.resolve(true), ...overrides };
}

/** Аргументы `ss-update`: всё, кроме названного, — умолчания схемы. */
function ssArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: false,
    local: false,
    "client-id": undefined,
    "spreadsheet-id": undefined,
    spreadsheet_id: undefined,
    "update-type": undefined,
    update_type: undefined,
    logs: "info",
    ...overrides,
  };
}

/** Подкоманда `cards`: опечатка в имени обязана падать здесь, а не на голдене. */
const cards = (() => {
  const found = wbLoaderCommands.find((command) => command.path[1] === "cards");
  if (found === undefined) throw new Error("подкоманда cards не объявлена");
  return found;
})();

function loaderArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: false,
    local: false,
    "client-id": undefined,
    sid: "SID42",
    ...overrides,
  };
}

Deno.test("ss-update: ssh-печать — эталон канала", async (t) => {
  await withCache([], async (db) => {
    const copied: string[] = [];
    const { io } = harness(db);
    const result = await ssUpdateCommand.invokeInput(
      ssArgs({ print: true }),
      io,
    ) as WrapResult;

    await t.step("строка печати байт в байт", async () => {
      assertEquals(
        ssUpdateCommand.renderResult(result, ["777", "-p"]),
        await golden("ss-update-print.stdout.txt"),
      );
    });

    await t.step("дефолты --update-type и --logs попали в команду", () => {
      assertStringIncludes(result.inner, "--update-type schedule --logs info");
    });

    await t.step("--spreadsheet-id взят из кандидатов селектора", () => {
      assertStringIncludes(result.inner, `--spreadsheet-id ${CLIENT.sheet}`);
    });

    await t.step("код выхода печати — 0, выполнения нет", () => {
      assertEquals(result.exitCode, 0);
      assertEquals(result.output, "");
    });

    await t.step("напечатанное уходит в буфер обмена", async () => {
      const { io: io2 } = harness(db);
      const printed = await printWith(io2, (text) => {
        copied.push(text);
        return Promise.resolve(true);
      });
      // В буфер уходит ровно та строка, что напечатана: копирование —
      // довесок к уже готовому тексту (`platform/clipboard.md`).
      assertEquals(copied, [printed.printed]);
    });
  });
});

Deno.test("wb-loader cards: обе формы печати — эталоны канала", async (t) => {
  await withCache([], async (db) => {
    const { io } = harness(db);

    await t.step("ssh-форма", async () => {
      const result = await cards.invokeInput(
        loaderArgs({ print: true }),
        io,
      ) as WrapResult;
      assertEquals(
        cards.renderResult(result, ["777", "--sid", "SID42", "-p"]),
        await golden("wb-loader-cards-print.stdout.txt"),
      );
    });

    await t.step("локальная форма", async () => {
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      assertEquals(
        cards.renderResult(result, ["777", "--sid", "SID42", "-p"]),
        await golden("wb-loader-cards-print-local.stdout.txt"),
      );
    });

    await t.step("обе формы несут одну и ту же inner-команду", async () => {
      const ssh = await cards.invokeInput(
        loaderArgs({ print: true }),
        io,
      ) as WrapResult;
      const local = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      assertEquals(ssh.inner, local.inner);
    });
  });
});

Deno.test("имя cli-контейнера берётся из кэша", async (t) => {
  await t.step("пустой кэш — форма `sl-<N>-cli`", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db);
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      assertStringIncludes(result.printed ?? "", "sl-9-cli sh -c");
    });
  });

  await t.step("в кэше только `mp-sl-<N>-cli` — берётся она", async () => {
    await withCache(["mp-sl-9-cli"], async (db) => {
      const { io } = harness(db);
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      // Переименование контейнеров на серверах не должно ломать вызов
      // по селектору (спека).
      assertStringIncludes(result.printed ?? "", "mp-sl-9-cli sh -c");
    });
  });

  await t.step("есть обе — побеждает первая форма", async () => {
    await withCache(["mp-sl-9-cli", "sl-9-cli"], async (db) => {
      const { io } = harness(db);
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      assertStringIncludes(result.printed ?? "", "sl-9-cli sh -c");
    });
  });
});

Deno.test("отказы ввода — эталоны канала", async (t) => {
  await t.step("ssh-печать без PG_MY_USER_NAME", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db, { sl_9: "10.9.9.9" });
      const err = await assertRejects(
        () => ssUpdateCommand.invokeInput(ssArgs({ print: true }), io),
        UsageError,
      );
      assertEquals(
        `${formatCommandError("ss-update", err)}\n`,
        await golden("err-no-pg-user.stderr.txt"),
      );
    });
  });

  await t.step("значение с пробелом", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db);
      const err = await assertRejects(
        () =>
          ssUpdateCommand.invokeInput(
            ssArgs({ print: true, "spreadsheet-id": "a b" }),
            io,
          ),
        UsageError,
      );
      assertEquals(
        `${formatCommandError("ss-update", err)}\n`,
        await golden("err-unsafe-token.stderr.txt"),
      );
    });
  });

  await t.step("--local без --print — отказ, а не выполнение", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db);
      // Отклонение `fix`: оригинал молча выполнял команду в проде.
      const err = await assertRejects(
        () => ssUpdateCommand.invokeInput(ssArgs({ local: true }), io),
        UsageError,
      );
      assertEquals(err.message, "--local имеет смысл только вместе с --print");
    });
  });

  await t.step("ssh-печать без адреса сервера", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db, { PG_MY_USER_NAME: "probeuser" });
      const err = await assertRejects(
        () => ssUpdateCommand.invokeInput(ssArgs({ print: true }), io),
        UsageError,
      );
      assertEquals(err.message, "no sl_9 in ~/.config/mpu/.env");
    });
  });
});

Deno.test("объявления семейства: политика, имя ошибок, предел описания", async (t) => {
  await t.step("все обёртки мутирующие", () => {
    assertEquals(ssUpdateCommand.policy, "rw");
    for (const command of wbLoaderCommands) assertEquals(command.policy, "rw");
  });

  await t.step("у подкоманд имя ошибок — имя группы", () => {
    for (const command of wbLoaderCommands) {
      assertEquals(command.errorName, "wb-loader");
    }
  });

  await t.step("восемь подкоманд, пути по спеке", () => {
    assertEquals(wbLoaderCommands.map((command) => command.path[1]), [
      "reports",
      "cards",
      "adv-auto-keywords-stats",
      "adv-fullstats",
      "search-texts",
      "analytics-by-period",
      "adverts",
      "search-clusters-bids",
    ]);
  });

  await t.step("описания тулов укладываются в предел клиента", () => {
    for (const command of [ssUpdateCommand, ...wbLoaderCommands]) {
      const bytes = new TextEncoder().encode(
        `${command.summary}\n\n${command.help}`,
      ).length;
      assert(bytes < 2048, `${command.path.join(" ")}: ${bytes} байт`);
    }
  });
});

Deno.test("режим выполнения: inner уходит транспортом, код 1:1", async () => {
  await withCache([], async (db) => {
    const { io, output } = harness(db);
    const ssh = fakeSsh(7);
    const result = await runWrapOf(io, { runProcess: ssh.run });
    assertEquals(result.exitCode, 7);
    assertEquals(result.printed, null);
    assertEquals(output.text(), "вывод inner-команды\n");
    // Транспорт получает ту же команду, что печатают режимы печати.
    assertStringIncludes(ssh.calls[0], `sh -c '${result.inner}'`);
  });
});

/** Обёртка `ss-update` глазами машинерии: та же сборка флагов. */
const SS_UPDATE = {
  service: "ssUpdater",
  method: "update",
  flags: (context: WrapContext) => [
    {
      name: "spreadsheet-id",
      value: context.pick("--spreadsheet-id", (c) => c.spreadsheetId),
    },
    { name: "update-type", value: "schedule" },
    { name: "logs", value: "info" },
  ],
};

/** Прогон обёртки печатью — с подставным буфером обмена. */
function printWith(
  io: WrapIo,
  copy: (text: string) => Promise<boolean>,
): Promise<WrapResult> {
  return runWrap(
    SS_UPDATE,
    {
      selector: String(CLIENT.id),
      print: true,
      local: false,
      clientId: CLIENT.id,
    },
    io,
    options({ copy }),
  );
}

/** Прогон обёртки в режиме выполнения через машинерию (с подстановками). */
function runWrapOf(
  io: WrapIo,
  overrides: Partial<WrapOptions>,
): Promise<WrapResult> {
  return runWrap(
    {
      service: "wbLoader",
      method: "wbCards",
      flags: () => [{ name: "sid", value: "SID42" }],
    },
    {
      selector: String(CLIENT.id),
      print: false,
      local: false,
      clientId: CLIENT.id,
    },
    io,
    options(overrides),
  );
}

Deno.test("три режима строят одну и ту же inner-команду", async () => {
  await withCache([], async (db) => {
    const printed = await printWith(
      harness(db).io,
      () => Promise.resolve(true),
    );
    const local = await runWrap(
      SS_UPDATE,
      {
        selector: String(CLIENT.id),
        print: true,
        local: true,
        clientId: CLIENT.id,
      },
      harness(db).io,
      options(),
    );
    const ssh = fakeSsh();
    const executed = await runWrap(
      SS_UPDATE,
      {
        selector: String(CLIENT.id),
        print: false,
        local: false,
        clientId: CLIENT.id,
      },
      harness(db).io,
      options({ runProcess: ssh.run }),
    );
    // Расходиться режимам нельзя: печать ровно то, что выполнилось бы
    // (инвариант `platform/portainer.md`).
    assertEquals(local.inner, printed.inner);
    assertEquals(executed.inner, printed.inner);
    assertStringIncludes(ssh.calls[0], `sh -c '${printed.inner}'`);
    assertStringIncludes(printed.printed ?? "", `sh -c "${printed.inner}"`);
    assertStringIncludes(local.printed ?? "", `sh -c "${printed.inner}"`);
  });
});

Deno.test("auto-pick: явный флаг, единственное значение, отказ", async (t) => {
  await t.step("явный флаг побеждает кандидатов", async () => {
    await withCache([], async (db) => {
      const result = await runWrap(
        SS_UPDATE_EXPLICIT,
        {
          selector: String(CLIENT.id),
          print: true,
          local: true,
          clientId: 999,
        },
        harness(db).io,
        options(),
      );
      // Кандидат несёт 777 и SHEET123, но заданное значение старше.
      assertStringIncludes(result.inner, "--client-id 999");
      assertStringIncludes(result.inner, "--spreadsheet-id EXPLICIT");
    });
  });

  await t.step("разные значения у кандидатов — отказ со списком", async () => {
    await withTwoSheets(async (db) => {
      const err = await assertRejects(
        () =>
          runWrap(
            SS_UPDATE,
            {
              selector: String(CLIENT.id),
              print: true,
              local: true,
              clientId: CLIENT.id,
            },
            harness(db).io,
            options(),
          ),
        UsageError,
      );
      assertEquals(
        err.message,
        "cannot resolve --spreadsheet-id from selector; pass --spreadsheet-id",
      );
      // Список кандидатов идёт подробностями отказа, по строке на
      // кандидата (`platform/selector.md`).
      assertStringIncludes(err.details ?? "", "  client_id=777  server=sl-9");
      assertEquals((err.details ?? "").endsWith("\n"), false);
    });
  });

  await t.step("кандидатов нет — подробностей тоже", async () => {
    await withCache([], async (db) => {
      // `--server` резолвит сервер сам, кандидатов не остаётся: пустой
      // список не должен превращаться в пустую строку после отказа.
      const err = await assertRejects(
        () =>
          runWrap(
            SS_UPDATE,
            { selector: "sl-9", server: "sl-9", print: true, local: true },
            harness(db).io,
            options(),
          ),
        UsageError,
      );
      assertEquals(err.details, undefined);
    });
  });
});

/** Та же обёртка, но со значениями, заданными явно. */
const SS_UPDATE_EXPLICIT = {
  service: "ssUpdater",
  method: "update",
  flags: () => [{ name: "spreadsheet-id", value: "EXPLICIT" }],
};

/** Кэш, где у клиента две таблицы: auto-pick обязан отказать. */
async function withTwoSheets(body: (db: CacheDb) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
      CLIENT.id,
      CLIENT.server,
      1_700_000_000,
    );
    for (const sheet of ["SHEET123", "SHEET456"]) {
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
        sheet,
        CLIENT.id,
        "Таблица",
        CLIENT.server,
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("exec-режим видит Portainer-таргет из кэша", async () => {
  await withCache(["sl-9-cli"], async (db) => {
    const { io } = harness(db, {
      ...ENV,
      PORTAINER_API_KEY: "k",
    });
    let asked = "";
    const result = await runWrap(
      SS_UPDATE,
      {
        selector: String(CLIENT.id),
        print: false,
        local: false,
        clientId: CLIENT.id,
      },
      io,
      options({
        httpCall: (url) => {
          if (asked === "") asked = url.toString();
          return Promise.resolve({
            status: 200,
            text: url.pathname.endsWith("/json")
              ? '{"ExitCode":0}'
              : '{"Id":"exec-1"}',
            retryAfter: null,
          });
        },
        openChannel: () =>
          Promise.resolve({
            chunks: (async function* () {
              yield new TextEncoder().encode(
                "HTTP/1.1 101 Switching Protocols\r\n\r\n",
              );
              yield Uint8Array.of(0x88, 0x00);
            })(),
            write: () => {},
            close: () => {},
          }),
        runProcess: () => {
          throw new Error("ssh не должен участвовать: Portainer настроен");
        },
      }),
    );
    assertEquals(result.exitCode, 0);
    // Строка кэша, наполненная `mpu init`, обязана быть видна выбору
    // транспорта — иначе обёртка уходит по ssh там, где `mpu ssh` того
    // же сервера идёт Portainer'ом.
    assertStringIncludes(asked, "https://portainer.example/api/endpoints/1/");
  });
});

/* ------------------------------------------------------------------ *
 * Пять новых обёрток: `data-loader`, `wb-recalculate-expenses`,
 * `wb-save-expenses`, `ozon-save-expenses`, `ozon-recalculate-expenses`
 * (`docs/specs/portainer-wrappers.md`).
 * ------------------------------------------------------------------ */

/** Аргументы `data-loader`: всё, кроме названного, — умолчания схемы. */
function dataLoaderArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: false,
    local: false,
    "client-id": undefined,
    sids: undefined,
    sid: undefined,
    ...overrides,
  };
}

/** Аргументы `wb-recalculate-expenses`/`wb-save-expenses`: обе несут nm-ids. */
function wbDatedArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: false,
    local: false,
    "client-id": undefined,
    "date-from": undefined,
    date_from: undefined,
    "date-to": undefined,
    date_to: undefined,
    "nm-ids": undefined,
    nm_ids: undefined,
    ...overrides,
  };
}

/** Аргументы `ozon-save-expenses`: та же схема периода, без nm-ids. */
function ozonSaveArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: false,
    local: false,
    "client-id": undefined,
    "date-from": undefined,
    date_from: undefined,
    "date-to": undefined,
    date_to: undefined,
    ...overrides,
  };
}

/** Аргументы `ozon-recalculate-expenses`: единственная обёртка с verbose. */
function ozonRecalcArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: false,
    local: false,
    "client-id": undefined,
    "date-from": undefined,
    date_from: undefined,
    "date-to": undefined,
    date_to: undefined,
    "ref-date": undefined,
    ref_date: undefined,
    "ref-fields": undefined,
    ref_fields: undefined,
    skus: undefined,
    "logs-level": undefined,
    logs_level: undefined,
    verbose: false,
    ...overrides,
  };
}

Deno.test("data-loader: печать — эталон канала", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const result = await dataLoaderCommand.invokeInput(
      dataLoaderArgs({ print: true, sids: ["abc", "def"] }),
      io,
    ) as WrapResult;
    assertEquals(
      dataLoaderCommand.renderResult(result, [
        "777",
        "--sids",
        "abc",
        "--sids",
        "def",
        "-p",
      ]),
      await golden("data-loader-print.stdout.txt"),
    );
  });
});

Deno.test("wb-recalculate-expenses: печать — эталон канала", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const result = await wbRecalculateExpensesCommand.invokeInput(
      wbDatedArgs({
        print: true,
        "date-from": "2026-01-01",
        "date-to": "2026-01-31",
        "nm-ids": "[1,2,3]",
      }),
      io,
    ) as WrapResult;
    assertEquals(
      wbRecalculateExpensesCommand.renderResult(result, [
        "777",
        "--date-from",
        "2026-01-01",
        "--date-to",
        "2026-01-31",
        "--nm-ids",
        "[1,2,3]",
        "-p",
      ]),
      await golden("wb-recalculate-expenses-print.stdout.txt"),
    );
  });
});

Deno.test("wb-save-expenses: печать — эталон канала", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const result = await wbSaveExpensesCommand.invokeInput(
      wbDatedArgs({
        print: true,
        "date-from": "2026-01-01",
        "date-to": "2026-01-31",
      }),
      io,
    ) as WrapResult;
    assertEquals(
      wbSaveExpensesCommand.renderResult(result, [
        "777",
        "--date-from",
        "2026-01-01",
        "--date-to",
        "2026-01-31",
        "-p",
      ]),
      await golden("wb-save-expenses-print.stdout.txt"),
    );
  });
});

Deno.test("ozon-save-expenses: печать — эталон канала", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const result = await ozonSaveExpensesCommand.invokeInput(
      ozonSaveArgs({
        print: true,
        "date-from": "2026-01-01",
        "date-to": "2026-01-31",
      }),
      io,
    ) as WrapResult;
    assertEquals(
      ozonSaveExpensesCommand.renderResult(result, [
        "777",
        "--date-from",
        "2026-01-01",
        "--date-to",
        "2026-01-31",
        "-p",
      ]),
      await golden("ozon-save-expenses-print.stdout.txt"),
    );
  });
});

Deno.test("ozon-recalculate-expenses: verbose-печать — эталоны канала", async () => {
  await withCache([], async (db) => {
    const { io, progress } = harness(db);
    const result = await ozonRecalculateExpensesCommand.invokeInput(
      ozonRecalcArgs({
        print: true,
        verbose: true,
        "date-from": "2026-01-01",
        "date-to": "2026-01-31",
        "ref-fields": ["sebes_rub"],
        // Вход объявлен числовым списком: через MCP-вход значения
        // приходят числами, а из argv их приводит разбор.
        skus: [123],
      }),
      io,
    ) as WrapResult;
    assertEquals(
      ozonRecalculateExpensesCommand.renderResult(result, [
        "777",
        "--date-from",
        "2026-01-01",
        "--date-to",
        "2026-01-31",
        "--ref-fields",
        "sebes_rub",
        "--skus",
        "123",
        "-v",
        "-p",
      ]),
      await golden("ozon-recalculate-expenses-verbose-print.stdout.txt"),
    );
    // `# inner: …` — служебная строка канала: каждая запись `progress`
    // с добавленным переводом строки (в CLI это уходит в stderr).
    assertEquals(
      progress.map((line) => `${line}\n`).join(""),
      await golden("ozon-recalculate-expenses-verbose-print.stderr.txt"),
    );
  });
});

Deno.test("дефолты периода: --date-to сегодняшняя, --date-from 2025-01-01", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const result = await wbRecalculateExpensesCommand.invokeInput(
      wbDatedArgs({ print: true }),
      io,
    ) as WrapResult;
    // Дефолт вычисляется в момент вызова — эталон тоже берём временем
    // вызова, а не зашитой строкой (иначе тест краснеет на границе
    // суток).
    const expectedDateTo = localDate(
      Date.now(),
      new Date().getTimezoneOffset(),
    );
    assertStringIncludes(result.inner, "--date-from 2025-01-01");
    assertStringIncludes(result.inner, `--date-to ${expectedDateTo}`);
  });
});

Deno.test("--verbose: одна и та же inner-строка в progress во всех трёх режимах", async () => {
  await withCache([], async (db) => {
    // Флаги машинерии, а не реальная команда: режим выполнения не
    // проходит через `invokeInput` (у него нет входа для подмены
    // транспорта), поэтому все три режима гоняются напрямую через
    // `runWrap`, как в тесте «режим выполнения: inner уходит
    // транспортом».
    const spec = {
      service: "ozonUnitCalculatedData",
      method: "recalculateExpenses",
      flags: () => [
        { name: "date-from", value: "2026-01-01" },
        { name: "date-to", value: "2026-01-31" },
      ],
    };
    const argsFor = (overrides: Partial<WrapArgs> = {}): WrapArgs => ({
      selector: String(CLIENT.id),
      print: false,
      local: false,
      clientId: CLIENT.id,
      verbose: true,
      ...overrides,
    });

    const sshOut = harness(db);
    const ssh = await runWrap(
      spec,
      argsFor({ print: true }),
      sshOut.io,
      options(),
    );
    assertEquals(sshOut.progress, [`# inner: ${ssh.inner}`]);
    assert(ssh.printed !== null);

    const localOut = harness(db);
    const local = await runWrap(
      spec,
      argsFor({ print: true, local: true }),
      localOut.io,
      options(),
    );
    assertEquals(localOut.progress, [`# inner: ${local.inner}`]);
    assert(local.printed !== null);

    const execOut = harness(db);
    const fake = fakeSsh(0);
    const executed = await runWrap(
      spec,
      argsFor(),
      execOut.io,
      options({ runProcess: fake.run }),
    );
    // Обычный вывод не подменяется служебной строкой: он остаётся
    // выводом inner-команды, а `# inner: …` идёт отдельно в progress.
    assertEquals(execOut.progress, [`# inner: ${executed.inner}`]);
    assertEquals(execOut.output.text(), "вывод inner-команды\n");

    assertEquals(local.inner, ssh.inner);
    assertEquals(executed.inner, ssh.inner);
  });
});

Deno.test("data-loader: --sids обязателен, повтор — один флаг с двумя значениями", async (t) => {
  await withCache([], async (db) => {
    await t.step("без --sids — отказ ввода", async () => {
      const { io } = harness(db);
      await assertRejects(
        () => dataLoaderCommand.invoke(["777", "-p"], io),
        UsageError,
      );
    });

    await t.step(
      "--sids дважды — один флаг подряд с двумя значениями",
      async () => {
        const { io } = harness(db);
        const result = await dataLoaderCommand.invoke(
          ["777", "--sids", "abc", "--sids", "def", "-p"],
          io,
        ) as WrapResult;
        assertStringIncludes(result.inner, "--sids abc def");
        assertEquals(result.inner.match(/--sids/g)?.length, 1);
      },
    );
  });
});

Deno.test("ozon-recalculate-expenses: --skus", async (t) => {
  await withCache([], async (db) => {
    await t.step("не задан — следа в inner нет", async () => {
      const { io } = harness(db);
      const result = await ozonRecalculateExpensesCommand.invoke(
        ["777", "--date-from", "2026-01-01", "--date-to", "2026-01-31", "-p"],
        io,
      ) as WrapResult;
      assertEquals(result.inner.includes("--skus"), false);
    });

    await t.step("задан трижды — ровно один токен [1,2,3]", async () => {
      const { io } = harness(db);
      const result = await ozonRecalculateExpensesCommand.invoke(
        [
          "777",
          "--date-from",
          "2026-01-01",
          "--date-to",
          "2026-01-31",
          "--skus",
          "1",
          "--skus",
          "2",
          "--skus",
          "3",
          "-p",
        ],
        io,
      ) as WrapResult;
      assertStringIncludes(result.inner, "--skus [1,2,3]");
      assertEquals(result.inner.match(/--skus/g)?.length, 1);
    });

    await t.step("нецифровое значение — отказ разбора ввода", async () => {
      const { io } = harness(db);
      // Отказ до печати и до сети: буфер обмена и транспорт не
      // подставлены вовсе, дойди вызов до них — тест упал бы иначе.
      await assertRejects(
        () =>
          ozonRecalculateExpensesCommand.invoke(
            ["777", "--skus", "abc", "-p"],
            io,
          ),
        UsageError,
      );
    });
  });
});

Deno.test("snake-написания: тот же inner, что kebab; при обоих — kebab побеждает", async (t) => {
  await withCache([], async (db) => {
    await t.step(
      "wb-recalculate-expenses: date_from/date_to/nm_ids совпадают с kebab",
      async () => {
        const kebab = await wbRecalculateExpensesCommand.invokeInput(
          wbDatedArgs({
            print: true,
            "date-from": "2026-02-01",
            "date-to": "2026-02-28",
            "nm-ids": "[1,2]",
          }),
          harness(db).io,
        ) as WrapResult;
        const snake = await wbRecalculateExpensesCommand.invokeInput(
          wbDatedArgs({
            print: true,
            date_from: "2026-02-01",
            date_to: "2026-02-28",
            nm_ids: "[1,2]",
          }),
          harness(db).io,
        ) as WrapResult;
        assertEquals(snake.inner, kebab.inner);
      },
    );

    await t.step("оба заданы сразу — побеждает kebab", async () => {
      const result = await wbRecalculateExpensesCommand.invokeInput(
        wbDatedArgs({
          print: true,
          "date-from": "2026-03-01",
          date_from: "2099-01-01",
          "date-to": "2026-03-31",
          date_to: "2099-12-31",
          "nm-ids": "[1]",
          nm_ids: "[2]",
        }),
        harness(db).io,
      ) as WrapResult;
      assertStringIncludes(result.inner, "--date-from 2026-03-01");
      assertStringIncludes(result.inner, "--date-to 2026-03-31");
      assertStringIncludes(result.inner, "--nm-ids [1]");
      assertEquals(result.inner.includes("2099"), false);
      assertEquals(result.inner.includes("[2]"), false);
    });

    await t.step(
      "ozon-recalculate-expenses: ref_fields совпадает с ref-fields",
      async () => {
        const kebab = await ozonRecalculateExpensesCommand.invokeInput(
          ozonRecalcArgs({ print: true, "ref-fields": ["a", "b"] }),
          harness(db).io,
        ) as WrapResult;
        const snake = await ozonRecalculateExpensesCommand.invokeInput(
          ozonRecalcArgs({ print: true, ref_fields: ["a", "b"] }),
          harness(db).io,
        ) as WrapResult;
        assertEquals(snake.inner, kebab.inner);
      },
    );
  });
});
