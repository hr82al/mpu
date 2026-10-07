/**
 * Обёртки `mpu ss-update` и `mpu wb-loader`
 * (`docs/specs/portainer-wrappers.md`). Живого контейнера в тестах нет:
 * подпроцесс ssh и буфер обмена подставные, а печать сверяется с
 * эталонами канала — в них домашний каталог записан плейсхолдером.
 */

import { assert, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CacheDb,
  type Command,
  type CommandIo,
  formatCommandError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import type { RunProcess } from "../exec/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { heldScope } from "../testing/scope.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { dataLoaderCommand } from "./cmd_data_loader.ts";
import { jobsCommands } from "./cmd_jobs.ts";
import { migrationsCommands } from "./cmd_migrations.ts";
import { ozonLoaderCommands } from "./cmd_ozon_loader.ts";
import { ozonRecalculateExpensesCommand } from "./cmd_ozon_recalculate_expenses.ts";
import { ozonSaveExpensesCommand } from "./cmd_ozon_save_expenses.ts";
import { processCommand } from "./cmd_process.ts";
import { ssDatasetsCommand } from "./cmd_ss_datasets.ts";
import { ssLoadCommand } from "./cmd_ss_load.ts";
import { ssUpdateCommand } from "./cmd_ss_update.ts";
import { usersCommands } from "./cmd_users.ts";
import { wbLoaderCommands } from "./cmd_wb_loader.ts";
import { wbRecalculateExpensesCommand } from "./cmd_wb_recalculate_expenses.ts";
import { wbSaveExpensesCommand } from "./cmd_wb_save_expenses.ts";
import { wbUnitCalcCommand } from "./cmd_wb_unit_calc.ts";
import { wbUnitProtoNewCommand } from "./cmd_wb_unit_proto_new.ts";
import { localDate, today } from "../dates/mod.ts";
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
      return Promise.resolve();
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
  const text = await readFile(
    new URL(`./testdata/portainer-wrappers/${name}`, import.meta.url),
    "utf8",
  );
  return text.replaceAll("<HOME>", HOME);
}

/** Кэш-БД с одним клиентом; `containers` — строки таблицы контейнеров. */
async function withCache(
  containers: readonly string[],
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
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
    await rm(dir, { recursive: true });
  }
}

/** Подставной ssh: помнит удалённую строку и отдаёт код. */
function fakeSsh(code = 0) {
  const calls: string[] = [];
  const run: RunProcess = (_bin, argv, proc) => {
    calls.push(argv[3] ?? "");
    proc.output.out(new TextEncoder().encode("вывод inner-команды\n"));
    return Promise.resolve(code);
  };
  return { run, calls };
}

function options(overrides: Partial<WrapOptions> = {}): WrapOptions {
  return { copy: () => Promise.resolve(), ...overrides };
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

describe("ss-update: ssh-печать — эталон канала", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  const copied: string[] = [];
  let result: WrapResult;
  beforeAll(async () => {
    const { io } = harness(db());
    result = await ssUpdateCommand.invokeInput(
      ssArgs({ print: true }),
      io,
    ) as WrapResult;
  });

  it("строка печати байт в байт", async () => {
    expect(ssUpdateCommand.renderResult(result, ["777", "-p"])).toStrictEqual(
      await golden("ss-update-print.stdout.txt"),
    );
  });

  it("дефолты --update-type и --logs попали в команду", () => {
    expect(result.inner).toContain("--update-type schedule --logs info");
  });

  it("--spreadsheet-id взят из кандидатов селектора", () => {
    expect(result.inner).toContain(`--spreadsheet-id ${CLIENT.sheet}`);
  });

  it("код выхода печати — 0, выполнения нет", () => {
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });

  it("напечатанное уходит в буфер обмена", async () => {
    const { io: io2 } = harness(db());
    const printed = await printWith(io2, (text) => {
      copied.push(text);
      return Promise.resolve();
    });
    // В буфер уходит ровно та строка, что напечатана: копирование —
    // довесок к уже готовому тексту (`platform/clipboard.md`).
    expect(copied).toStrictEqual([printed.printed]);
  });
});

describe("wb-loader cards: обе формы печати — эталоны канала", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("ssh-форма", async () => {
    const result = await cards.invokeInput(
      loaderArgs({ print: true }),
      io,
    ) as WrapResult;
    expect(cards.renderResult(result, ["777", "--sid", "SID42", "-p"]))
      .toStrictEqual(await golden("wb-loader-cards-print.stdout.txt"));
  });

  it("локальная форма", async () => {
    const result = await cards.invokeInput(
      loaderArgs({ print: true, local: true }),
      io,
    ) as WrapResult;
    expect(cards.renderResult(result, ["777", "--sid", "SID42", "-p"]))
      .toStrictEqual(await golden("wb-loader-cards-print-local.stdout.txt"));
  });

  it("обе формы несут одну и ту же inner-команду", async () => {
    const ssh = await cards.invokeInput(
      loaderArgs({ print: true }),
      io,
    ) as WrapResult;
    const local = await cards.invokeInput(
      loaderArgs({ print: true, local: true }),
      io,
    ) as WrapResult;
    expect(ssh.inner).toStrictEqual(local.inner);
  });
});

describe("имя cli-контейнера берётся из кэша", () => {
  it("пустой кэш — форма `sl-<N>-cli`", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db);
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      expect(result.printed ?? "").toContain("sl-9-cli sh -c");
    });
  });

  it("в кэше только `mp-sl-<N>-cli` — берётся она", async () => {
    await withCache(["mp-sl-9-cli"], async (db) => {
      const { io } = harness(db);
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      // Переименование контейнеров на серверах не должно ломать вызов
      // по селектору (спека).
      expect(result.printed ?? "").toContain("mp-sl-9-cli sh -c");
    });
  });

  it("есть обе — побеждает первая форма", async () => {
    await withCache(["mp-sl-9-cli", "sl-9-cli"], async (db) => {
      const { io } = harness(db);
      const result = await cards.invokeInput(
        loaderArgs({ print: true, local: true }),
        io,
      ) as WrapResult;
      expect(result.printed ?? "").toContain("sl-9-cli sh -c");
    });
  });
});

describe("отказы ввода — эталоны канала", () => {
  it("ssh-печать без PG_MY_USER_NAME", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db, { sl_9: "10.9.9.9" });
      const err = await ssUpdateCommand.invokeInput(ssArgs({ print: true }), io)
        .catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(`${formatCommandError("ss-update", err)}\n`).toStrictEqual(
        await golden("err-no-pg-user.stderr.txt"),
      );
    });
  });

  it("значение с пробелом", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db);
      const err = await ssUpdateCommand.invokeInput(
        ssArgs({ print: true, "spreadsheet-id": "a b" }),
        io,
      ).catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(`${formatCommandError("ss-update", err)}\n`).toStrictEqual(
        await golden("err-unsafe-token.stderr.txt"),
      );
    });
  });

  it("--local без --print — отказ, а не выполнение", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db);
      // Отклонение `fix`: оригинал молча выполнял команду в проде.
      const err = await ssUpdateCommand.invokeInput(ssArgs({ local: true }), io)
        .catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(err.message).toBe("local имеет смысл только вместе с print");
    });
  });

  it("ssh-печать без адреса сервера", async () => {
    await withCache([], async (db) => {
      const { io } = harness(db, { PG_MY_USER_NAME: "probeuser" });
      const err = await ssUpdateCommand.invokeInput(ssArgs({ print: true }), io)
        .catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(err.message).toBe("no sl_9 in ~/.config/mpu/.env");
    });
  });
});

describe("объявления семейства: политика, имя ошибок, предел описания", () => {
  it("все обёртки мутирующие", () => {
    expect(ssUpdateCommand.policy).toBe("rw");
    for (const command of wbLoaderCommands) expect(command.policy).toBe("rw");
  });

  it("у подкоманд имя ошибок — имя группы", () => {
    for (const command of wbLoaderCommands) {
      expect(command.errorName).toBe("wb-loader");
    }
  });

  it("восемь подкоманд, пути по спеке", () => {
    expect(wbLoaderCommands.map((command) => command.path[1])).toStrictEqual([
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

  it("описания тулов укладываются в предел клиента", () => {
    for (const command of [ssUpdateCommand, ...wbLoaderCommands]) {
      const bytes = new TextEncoder().encode(
        `${command.summary}\n\n${command.help}`,
      ).length;
      assert(bytes < 2048, `${command.path.join(" ")}: ${bytes} байт`);
    }
  });
});

it("режим выполнения: inner уходит транспортом, код 1:1", async () => {
  await withCache([], async (db) => {
    const { io, output } = harness(db);
    const ssh = fakeSsh(7);
    const result = await runWrapOf(io, { runProcess: ssh.run });
    expect(result.exitCode).toBe(7);
    expect(result.printed).toStrictEqual(null);
    expect(output.text()).toBe("вывод inner-команды\n");
    // Транспорт получает ту же команду, что печатают режимы печати.
    expect(ssh.calls[0]).toContain(`sh -c '${result.inner}'`);
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
  copy: (text: string) => Promise<void>,
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

it("три режима строят одну и ту же inner-команду", async () => {
  await withCache([], async (db) => {
    const printed = await printWith(
      harness(db).io,
      () => Promise.resolve(),
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
    expect(local.inner).toStrictEqual(printed.inner);
    expect(executed.inner).toStrictEqual(printed.inner);
    expect(ssh.calls[0]).toContain(`sh -c '${printed.inner}'`);
    expect(printed.printed ?? "").toContain(`sh -c "${printed.inner}"`);
    expect(local.printed ?? "").toContain(`sh -c "${printed.inner}"`);
  });
});

describe("auto-pick: явный флаг, единственное значение, отказ", () => {
  it("явный флаг побеждает кандидатов", async () => {
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
      expect(result.inner).toContain("--client-id 999");
      expect(result.inner).toContain("--spreadsheet-id EXPLICIT");
    });
  });

  it("разные значения у кандидатов — отказ со списком", async () => {
    await withTwoSheets(async (db) => {
      const err = await runWrap(
        SS_UPDATE,
        {
          selector: String(CLIENT.id),
          print: true,
          local: true,
          clientId: CLIENT.id,
        },
        harness(db).io,
        options(),
      ).catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(err.message).toBe(
        "cannot resolve --spreadsheet-id from selector; pass --spreadsheet-id",
      );
      // Список кандидатов идёт подробностями отказа, по строке на
      // кандидата (`platform/selector.md`).
      expect(err.details ?? "").toContain("  client_id=777  server=sl-9");
      expect((err.details ?? "").endsWith("\n")).toBe(false);
    });
  });

  it("кандидатов нет — подробностей тоже", async () => {
    await withCache([], async (db) => {
      // `--server` резолвит сервер сам, кандидатов не остаётся: пустой
      // список не должен превращаться в пустую строку после отказа.
      const err = await runWrap(
        SS_UPDATE,
        { selector: "sl-9", server: "sl-9", print: true, local: true },
        harness(db).io,
        options(),
      ).catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(err.details).toStrictEqual(undefined);
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
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
    await rm(dir, { recursive: true });
  }
}

it("exec-режим видит Portainer-таргет из кэша", async () => {
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
    expect(result.exitCode).toBe(0);
    // Строка кэша, наполненная `mpu init`, обязана быть видна выбору
    // транспорта — иначе обёртка уходит по ssh там, где `mpu ssh` того
    // же сервера идёт Portainer'ом.
    expect(asked).toContain("https://portainer.example/api/endpoints/1/");
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

it("data-loader: печать — эталон канала", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const result = await dataLoaderCommand.invokeInput(
      dataLoaderArgs({ print: true, sids: ["abc", "def"] }),
      io,
    ) as WrapResult;
    expect(dataLoaderCommand.renderResult(result, [
      "777",
      "--sids",
      "abc",
      "--sids",
      "def",
      "-p",
    ])).toStrictEqual(await golden("data-loader-print.stdout.txt"));
  });
});

it("wb-recalculate-expenses: печать — эталон канала", async () => {
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
    expect(wbRecalculateExpensesCommand.renderResult(result, [
      "777",
      "--date-from",
      "2026-01-01",
      "--date-to",
      "2026-01-31",
      "--nm-ids",
      "[1,2,3]",
      "-p",
    ])).toStrictEqual(await golden("wb-recalculate-expenses-print.stdout.txt"));
  });
});

it("wb-save-expenses: печать — эталон канала", async () => {
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
    expect(wbSaveExpensesCommand.renderResult(result, [
      "777",
      "--date-from",
      "2026-01-01",
      "--date-to",
      "2026-01-31",
      "-p",
    ])).toStrictEqual(await golden("wb-save-expenses-print.stdout.txt"));
  });
});

it("ozon-save-expenses: печать — эталон канала", async () => {
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
    expect(ozonSaveExpensesCommand.renderResult(result, [
      "777",
      "--date-from",
      "2026-01-01",
      "--date-to",
      "2026-01-31",
      "-p",
    ])).toStrictEqual(await golden("ozon-save-expenses-print.stdout.txt"));
  });
});

it("ozon-recalculate-expenses: verbose-печать — эталоны канала", async () => {
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
    expect(ozonRecalculateExpensesCommand.renderResult(result, [
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
    ])).toStrictEqual(
      await golden("ozon-recalculate-expenses-verbose-print.stdout.txt"),
    );
    // `# inner: …` — служебная строка канала: каждая запись `progress`
    // с добавленным переводом строки (в CLI это уходит в stderr).
    expect(progress.map((line) => `${line}\n`).join("")).toStrictEqual(
      await golden("ozon-recalculate-expenses-verbose-print.stderr.txt"),
    );
  });
});

it("дефолты периода: --date-to сегодняшняя, --date-from 2025-01-01", async () => {
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
    expect(result.inner).toContain("--date-from 2025-01-01");
    expect(result.inner).toContain(`--date-to ${expectedDateTo}`);
  });
});

it("--verbose: одна и та же inner-строка в progress во всех трёх режимах", async () => {
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
    expect(sshOut.progress).toStrictEqual([`# inner: ${ssh.inner}`]);
    assert(ssh.printed !== null);

    const localOut = harness(db);
    const local = await runWrap(
      spec,
      argsFor({ print: true, local: true }),
      localOut.io,
      options(),
    );
    expect(localOut.progress).toStrictEqual([`# inner: ${local.inner}`]);
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
    expect(execOut.progress).toStrictEqual([`# inner: ${executed.inner}`]);
    expect(execOut.output.text()).toBe("вывод inner-команды\n");

    expect(local.inner).toStrictEqual(ssh.inner);
    expect(executed.inner).toStrictEqual(ssh.inner);
  });
});

describe("data-loader: --sids обязателен, повтор — один флаг с двумя значениями", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  it("без --sids — отказ ввода", async () => {
    const { io } = harness(db());
    await expect(dataLoaderCommand.invoke(["777", "-p"], io)).rejects.toThrow(
      UsageError,
    );
  });

  it("--sids дважды — один флаг подряд с двумя значениями", async () => {
    const { io } = harness(db());
    const result = await dataLoaderCommand.invoke(
      ["777", "--sids", "abc", "--sids", "def", "-p"],
      io,
    ) as WrapResult;
    expect(result.inner).toContain("--sids abc def");
    expect(result.inner.match(/--sids/g)?.length).toBe(1);
  });
});

describe("ozon-recalculate-expenses: --skus", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  it("не задан — следа в inner нет", async () => {
    const { io } = harness(db());
    const result = await ozonRecalculateExpensesCommand.invoke(
      ["777", "--date-from", "2026-01-01", "--date-to", "2026-01-31", "-p"],
      io,
    ) as WrapResult;
    expect(result.inner.includes("--skus")).toBe(false);
  });

  it("задан трижды — ровно один токен [1,2,3]", async () => {
    const { io } = harness(db());
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
    expect(result.inner).toContain("--skus [1,2,3]");
    expect(result.inner.match(/--skus/g)?.length).toBe(1);
  });

  it("нецифровое значение — отказ разбора ввода", async () => {
    const { io } = harness(db());
    // Отказ до печати и до сети: буфер обмена и транспорт не
    // подставлены вовсе, дойди вызов до них — тест упал бы иначе.
    await expect(ozonRecalculateExpensesCommand.invoke(
      ["777", "--skus", "abc", "-p"],
      io,
    )).rejects.toThrow(UsageError);
  });
});

describe("snake-написания: тот же inner, что kebab; при обоих — kebab побеждает", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  it(
    "wb-recalculate-expenses: date_from/date_to/nm_ids совпадают с kebab",
    async () => {
      const kebab = await wbRecalculateExpensesCommand.invokeInput(
        wbDatedArgs({
          print: true,
          "date-from": "2026-02-01",
          "date-to": "2026-02-28",
          "nm-ids": "[1,2]",
        }),
        harness(db()).io,
      ) as WrapResult;
      const snake = await wbRecalculateExpensesCommand.invokeInput(
        wbDatedArgs({
          print: true,
          date_from: "2026-02-01",
          date_to: "2026-02-28",
          nm_ids: "[1,2]",
        }),
        harness(db()).io,
      ) as WrapResult;
      expect(snake.inner).toStrictEqual(kebab.inner);
    },
  );

  it("оба заданы сразу — побеждает kebab", async () => {
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
      harness(db()).io,
    ) as WrapResult;
    expect(result.inner).toContain("--date-from 2026-03-01");
    expect(result.inner).toContain("--date-to 2026-03-31");
    expect(result.inner).toContain("--nm-ids [1]");
    expect(result.inner.includes("2099")).toBe(false);
    expect(result.inner.includes("[2]")).toBe(false);
  });

  it(
    "ozon-recalculate-expenses: ref_fields совпадает с ref-fields",
    async () => {
      const kebab = await ozonRecalculateExpensesCommand.invokeInput(
        ozonRecalcArgs({ print: true, "ref-fields": ["a", "b"] }),
        harness(db()).io,
      ) as WrapResult;
      const snake = await ozonRecalculateExpensesCommand.invokeInput(
        ozonRecalcArgs({ print: true, ref_fields: ["a", "b"] }),
        harness(db()).io,
      ) as WrapResult;
      expect(snake.inner).toStrictEqual(kebab.inner);
    },
  );
});

/**
 * Порция очередей, миграций и загрузчика Ozon. Обёртки те же, поэтому
 * харнесс общий: разница только во входах и в том, что у части команд
 * `--client-id` нет вовсе.
 */

/** Обёртка по пути; опечатка обязана падать здесь, а не на голдене. */
function wrapper(commands: readonly Command[], sub: string): Command {
  const found = commands.find((command) => command.path[1] === sub);
  if (found === undefined) throw new Error(`подкоманда ${sub} не объявлена`);
  return found;
}

/** Аргументы обёртки уровня сервера: селектор — сам сервер. */
function serverArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: CLIENT.server,
    server: undefined,
    print: true,
    local: false,
    ...overrides,
  };
}

/** Аргументы обёртки уровня клиента. */
function clientArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: true,
    local: false,
    "client-id": undefined,
    ...overrides,
  };
}

describe("очереди задач: печать — эталоны канала", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });
  const cases: readonly (readonly [string, Command, string])[] = [
    [
      "wb-jobs show",
      wrapper(jobsCommands, "show"),
      "wb-jobs-show-print.stdout.txt",
    ],
    [
      "ozon-jobs show --pattern",
      wrapper(jobsCommands.filter((c) => c.path[0] === "ozon-jobs"), "show"),
      "ozon-jobs-show-print.stdout.txt",
    ],
  ];
  for (const [title, command, file] of cases) {
    it(title, async () => {
      const result = await command.invokeInput(
        serverArgs(file.startsWith("ozon") ? { pattern: "ozonLoader" } : {}),
        io,
      ) as WrapResult;
      expect(command.renderResult(result, ["sl-9", "-p"])).toStrictEqual(
        await golden(file),
      );
    });
  }

  it("data-loader-jobs show", async () => {
    const command = wrapper(
      jobsCommands.filter((c) => c.path[0] === "data-loader-jobs"),
      "show",
    );
    const result = await command.invokeInput(serverArgs(), io) as WrapResult;
    expect(command.renderResult(result, ["sl-9", "-p"])).toStrictEqual(
      await golden("data-loader-jobs-show-print.stdout.txt"),
    );
  });

  it("незаданный --pattern не оставляет следа", async () => {
    const command = wrapper(
      jobsCommands.filter((c) => c.path[0] === "ozon-jobs"),
      "prune",
    );
    const result = await command.invokeInput(serverArgs(), io) as WrapResult;
    expect(result.inner).toBe("node cli service:ozonJobs pruneJobs");
  });

  it("--client-id у очередей нет ни в схеме, ни в команде", () => {
    for (const command of jobsCommands) {
      expect(
        command.inputs.some((input) => input.name === "client-id"),
        `${command.path.join(" ")}: client-id объявлен`,
      ).toBe(false);
    }
  });
});

describe("миграции: печать, обязательные и необязательные флаги", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("app-migrations latest — эталон канала", async () => {
    const command = wrapper(
      migrationsCommands.filter((c) => c.path[0] === "app-migrations"),
      "latest",
    );
    const result = await command.invokeInput(serverArgs(), io) as WrapResult;
    expect(command.renderResult(result, ["sl-9", "-p"])).toStrictEqual(
      await golden("app-migrations-latest-print.stdout.txt"),
    );
  });

  it("clients-migrations latest — эталон канала", async () => {
    const command = clientsMigration("latest");
    const result = await command.invokeInput(
      clientArgs({ type: "wb", forced: false }),
      io,
    ) as WrapResult;
    expect(command.renderResult(result, ["777", "--type", "wb", "-p"]))
      .toStrictEqual(
        await golden("clients-migrations-latest-print.stdout.txt"),
      );
  });

  it("--forced уходит голым флагом, без значения", async () => {
    const result = await clientsMigration("up").invokeInput(
      clientArgs({ type: "wb", forced: true, name: "0007_add" }),
      io,
    ) as WrapResult;
    expect(result.inner).toStrictEqual(
      "node cli service:clientsMigrations up --client-id 777 --type wb" +
        " --name 0007_add --forced",
    );
  });

  it("latest-all не эмитит --client-id", async () => {
    const command = clientsMigration("latest-all");
    const result = await command.invokeInput(
      serverArgs({ type: "wb" }),
      io,
    ) as WrapResult;
    expect(result.inner).toBe(
      "node cli service:clientsMigrations latestAll --type wb",
    );
    expect(command.inputs.some((input) => input.name === "client-id")).toBe(
      false,
    );
  });

  it("datasets-migrations list — эталон канала", async () => {
    const command = wrapper(
      migrationsCommands.filter((c) => c.path[0] === "datasets-migrations"),
      "list",
    );
    const result = await command.invokeInput(
      clientArgs({ dataset: "wb_unit" }),
      io,
    ) as WrapResult;
    expect(
      command.renderResult(result, ["777", "--dataset", "wb_unit", "-p"]),
    ).toStrictEqual(
      await golden("datasets-migrations-list-print.stdout.txt"),
    );
  });

  it("имя метода совпадает с именем подкоманды", async () => {
    for (const sub of ["up", "rollback", "down", "init"]) {
      const result = await clientsMigration(sub).invokeInput(
        clientArgs({ type: "wb", forced: false }),
        io,
      ) as WrapResult;
      expect(result.inner).toContain(`service:clientsMigrations ${sub} `);
    }
  });
});

/** Подкоманда `clients-migrations`: их две пачки в общем списке. */
function clientsMigration(sub: string): Command {
  return wrapper(
    migrationsCommands.filter((c) => c.path[0] === "clients-migrations"),
    sub,
  );
}

describe("ozon-loader: кабинет, множественное число и sequence", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("campaigns — эталон канала", async () => {
    const command = wrapper(ozonLoaderCommands, "campaigns");
    const result = await command.invokeInput(
      clientArgs({ "seller-client-id": ["999001"] }),
      io,
    ) as WrapResult;
    expect(command.renderResult(result, ["777", "-p"])).toStrictEqual(
      await golden("ozon-loader-campaigns-print.stdout.txt"),
    );
  });

  it("load-data — эталон канала с восемнадцатью шагами", async () => {
    const command = wrapper(ozonLoaderCommands, "load-data");
    const result = await command.invokeInput(
      clientArgs({ "seller-client-id": ["999001"] }),
      io,
    ) as WrapResult;
    const printed = command.renderResult(result, ["777", "-p"]);
    expect(printed).toStrictEqual(
      await golden("ozon-loader-load-data-print.stdout.txt"),
    );
    // Шаги идут отдельными токенами, а не одной склейкой: считаем их.
    const sequence = result.inner.split("--sequence ")[1];
    expect(sequence.split(" ").length).toBe(18);
    expect(sequence.startsWith("ozonProductInfo ozonCampaigns")).toBe(true);
    expect(sequence.endsWith("ozonPostingsReports")).toBe(true);
  });

  it("у load-data флаг метода — во множественном числе", async () => {
    const result = await wrapper(ozonLoaderCommands, "load-data")
      .invokeInput(
        clientArgs({ "seller-client-id": ["999001", "999002"] }),
        io,
      ) as WrapResult;
    expect(result.inner).toContain(
      "--seller-client-ids 999001 999002 --sequence",
    );
    expect(result.inner.includes("--seller-client-id 999001")).toBe(false);
  });

  it("кабинет обязателен у всех семи подкоманд", async () => {
    for (const command of ozonLoaderCommands) {
      const failure = command.invokeInput(clientArgs(), io);
      await expect(failure).rejects.toThrow(UsageError);
      await expect(failure).rejects.toThrow("нужен --seller-client-id");
    }
  });

  it("повтор кабинета вне load-data — ошибка ввода", async () => {
    const failure = wrapper(ozonLoaderCommands, "campaigns").invokeInput(
      clientArgs({ "seller-client-id": ["999001", "999002"] }),
      io,
    );
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow("повторяется только у load-data");
  });
});

/**
 * Порция штучных обёрток: `ss-load`, `ss-datasets`, `wb-unit-calc`,
 * `wb-unit-proto-new`, `users`. Три из пяти листовые — в рабочей
 * версии это группы с единственной подкомандой, схлопнутые typer'ом.
 */

describe("ss-load: печать, порядок флагов и дефолт --logs", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("эталон канала", async () => {
    const result = await ssLoadCommand.invokeInput(
      clientArgs({
        dataset: "wb_unit",
        "sheet-name": "UNIT",
        "spreadsheet-id": CLIENT.sheet,
        forced: false,
        logs: "info",
      }),
      io,
    ) as WrapResult;
    expect(ssLoadCommand.renderResult(result, [
      "777",
      "--dataset",
      "wb_unit",
      "-p",
    ])).toStrictEqual(await golden("ss-load-print.stdout.txt"));
  });

  it("--client-id стоит вторым, а не первым", async () => {
    const result = await ssLoadCommand.invokeInput(
      clientArgs({ dataset: "wb_unit", forced: false, logs: "info" }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain(
      "service:ssLoader load --dataset wb_unit --client-id 777",
    );
  });

  it("--logs эмитится и при умолчании", async () => {
    const result = await ssLoadCommand.invokeInput(
      clientArgs({ dataset: "wb_unit", forced: false, logs: "info" }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain("--logs info");
  });

  it("--forced уходит голым флагом", async () => {
    const result = await ssLoadCommand.invokeInput(
      clientArgs({ dataset: "wb_unit", forced: true, logs: "debug" }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain("--forced --logs debug");
  });

  it("--spreadsheet-id взят из кандидатов селектора", async () => {
    const result = await ssLoadCommand.invokeInput(
      clientArgs({ dataset: "wb_unit", forced: false, logs: "info" }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain(`--spreadsheet-id ${CLIENT.sheet}`);
  });
});

describe("ss-datasets: таблица вместо клиента и трёхзначный признак", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });
  const args = (overrides: Record<string, unknown> = {}) =>
    serverArgs({
      selector: String(CLIENT.id),
      dataset: "wb_unit",
      "sheet-name": "UNIT",
      "spreadsheet-id": CLIENT.sheet,
      ...overrides,
    });

  it("эталон канала", async () => {
    const result = await ssDatasetsCommand.invokeInput(
      args(),
      io,
    ) as WrapResult;
    expect(ssDatasetsCommand.renderResult(result, [
      "777",
      "--dataset",
      "wb_unit",
      "-p",
    ])).toStrictEqual(await golden("ss-datasets-print.stdout.txt"));
  });

  it("--client-id нет ни в схеме, ни в команде", async () => {
    const result = await ssDatasetsCommand.invokeInput(
      args(),
      io,
    ) as WrapResult;
    expect(result.inner.includes("--client-id")).toBe(false);
    expect(
      ssDatasetsCommand.inputs.some((input) => input.name === "client-id"),
    ).toBe(false);
  });

  it("--spreadsheet-id берётся из кандидатов", async () => {
    const result = await ssDatasetsCommand.invokeInput(
      args({ "spreadsheet-id": undefined }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain(`--spreadsheet-id ${CLIENT.sheet}`);
  });

  it("--is-active уходит голым флагом", async () => {
    const result = await ssDatasetsCommand.invokeInput(
      args({ "is-active": true }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain("--sheet-name UNIT --is-active");
  });

  it("--no-is-active не эмитит ничего (сохранено)", async () => {
    // Выключить признак этой командой нельзя: эмиссия семейства
    // выбрасывает `false` наравне с `None`. Поведение рабочей версии,
    // закреплено до проверки контракта метода sl-back (спека,
    // «Открытые вопросы»).
    const off = await ssDatasetsCommand.invokeInput(
      args({ "is-active": false }),
      io,
    ) as WrapResult;
    const unset = await ssDatasetsCommand.invokeInput(
      args(),
      io,
    ) as WrapResult;
    expect(off.inner.includes("is-active")).toBe(false);
    expect(off.inner).toStrictEqual(unset.inner);
  });
});

describe("wb-unit-*: дата всегда явная, подкоманды нет", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("wb-unit-calc — эталон канала", async () => {
    const result = await wbUnitCalcCommand.invokeInput(
      clientArgs({ "nm-id": "123", date: "2026-08-01" }),
      io,
    ) as WrapResult;
    expect(
      wbUnitCalcCommand.renderResult(result, ["777", "--nm-id", "123", "-p"]),
    ).toStrictEqual(await golden("wb-unit-calc-print.stdout.txt"));
  });

  it("дефолт --date — сегодняшний день, явным токеном", async () => {
    const result = await wbUnitCalcCommand.invokeInput(
      clientArgs({ "nm-id": "123", date: undefined }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain(`--date ${today()}`);
  });

  it("wb-unit-proto-new — эталон канала", async () => {
    const result = await wbUnitProtoNewCommand.invokeInput(
      clientArgs(),
      io,
    ) as WrapResult;
    expect(wbUnitProtoNewCommand.renderResult(result, ["777", "-p"]))
      .toStrictEqual(await golden("wb-unit-proto-new-print.stdout.txt"));
  });

  it("имени подкоманды у обеих нет", () => {
    // Схлопнутая группа осталась схлопнутой: путь однозвенный, и
    // имя подкоманды не является ни обязательным, ни допустимым.
    expect(wbUnitCalcCommand.path).toStrictEqual(["wb-unit-calc"]);
    expect(wbUnitProtoNewCommand.path).toStrictEqual(["wb-unit-proto-new"]);
    expect(ssDatasetsCommand.path).toStrictEqual(["ss-datasets"]);
  });
});

describe("users: сервер вместо клиента, пароль вне журнала", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });
  const add = wrapper(usersCommands, "add");
  const addRole = wrapper(usersCommands, "add-role");

  it("add — эталон канала", async () => {
    const result = await add.invokeInput(
      serverArgs({ email: "test@example.com" }),
      io,
    ) as WrapResult;
    expect(
      add.renderResult(result, ["sl-9", "--email", "test@example.com", "-p"]),
    ).toStrictEqual(await golden("users-add-print.stdout.txt"));
  });

  it("add-role — эталон канала", async () => {
    const result = await addRole.invokeInput(
      serverArgs({ id: "42", role: "client" }),
      io,
    ) as WrapResult;
    expect(addRole.renderResult(result, [
      "sl-9",
      "--id",
      "42",
      "--role",
      "client",
      "-p",
    ])).toStrictEqual(await golden("users-add-role-print.stdout.txt"));
  });

  it("--client-id нет ни у одной из двух", async () => {
    for (const command of usersCommands) {
      expect(
        command.inputs.some((input) => input.name === "client-id"),
        `${command.path.join(" ")}: client-id объявлен`,
      ).toBe(false);
    }
    const result = await addRole.invokeInput(
      serverArgs({ id: "42", role: "client" }),
      io,
    ) as WrapResult;
    expect(result.inner.includes("--client-id")).toBe(false);
  });

  it("аргументы add в журнал не пишутся: там пароль", () => {
    expect(add.logsArguments).toBe(false);
    // Вывод тоже: в режиме печати stdout несёт тот же пароль.
    expect(add.logsOutput).toBe(false);
    // У второй подкоманды пароля нет, и скрывать ей нечего.
    expect(addRole.logsArguments).toBe(true);
  });
});

it("auto-pick --spreadsheet-id: две таблицы — отказ с кандидатами", async () => {
  await withCache([], async (db) => {
    db.execute(
      "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
        " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
      "SHEET456",
      CLIENT.id,
      "Вторая таблица клиента",
      CLIENT.server,
      1_700_000_000,
    );
    const { io } = harness(db);
    const err = await ssLoadCommand.invokeInput(
      clientArgs({ dataset: "wb_unit", forced: false, logs: "info" }),
      io,
    ).catch((thrown: unknown) => thrown);
    assert(err instanceof UsageError);
    expect(`${formatCommandError("ss-load", err)}\n`).toStrictEqual(
      await golden("err-ambiguous-spreadsheet.stderr.txt"),
    );
  });
});

/**
 * `mpu process`: три правила списков, ветка `dev:N` и порядок флагов.
 * Живого контейнера нет — печать и подставной ssh, как у соседей.
 */

/** Аргументы `process`: всё, кроме названного, — умолчания схемы. */
function processArgs(overrides: Record<string, unknown> = {}) {
  return {
    selector: String(CLIENT.id),
    server: undefined,
    print: true,
    local: false,
    "client-id": undefined,
    "spreadsheet-id": undefined,
    "date-from": undefined,
    "date-to": undefined,
    domain: undefined,
    dataset: undefined,
    datasets: undefined,
    modules: undefined,
    "exclude-datasets": undefined,
    "exclude-modules": undefined,
    "with-tags": undefined,
    "without-tags": undefined,
    "no-deps": false,
    forced: false,
    "forced-update": false,
    "dry-run": false,
    sid: undefined,
    "nm-ids": undefined,
    skus: undefined,
    logs: undefined,
    verbose: false,
    ...overrides,
  };
}

describe("process: печать, порядок флагов и три правила списков", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("простой вызов — эталон канала", async () => {
    const result = await processCommand.invokeInput(
      processArgs({ dataset: "wb_unit" }),
      io,
    ) as WrapResult;
    expect(processCommand.renderResult(result, ["777", "-p"])).toStrictEqual(
      await golden("process-print.stdout.txt"),
    );
  });

  it("списки и флаги — эталон канала", async () => {
    const result = await processCommand.invokeInput(
      processArgs({
        datasets: ["wb_unit"],
        "with-tags": ["source"],
        skus: [1, 2],
        "nm-ids": "[7,8]",
        forced: true,
        "dry-run": true,
        logs: "debug",
      }),
      io,
    ) as WrapResult;
    expect(processCommand.renderResult(result, ["777", "-p"])).toStrictEqual(
      await golden("process-lists-print.stdout.txt"),
    );
  });

  it("единственное значение списка дублируется", async () => {
    const one = await processCommand.invokeInput(
      processArgs({ modules: ["wb"] }),
      io,
    ) as WrapResult;
    const two = await processCommand.invokeInput(
      processArgs({ modules: ["wb", "ozon"] }),
      io,
    ) as WrapResult;
    // Дубль — обход схлопывания одиночного значения парсером sl-back
    // (спека, `preserve`); у двух значений его нет.
    expect(one.inner).toContain("--modules wb wb");
    expect(two.inner).toContain("--modules wb ozon");
  });

  it("--dataset дублированию не подвержен", async () => {
    const result = await processCommand.invokeInput(
      processArgs({ dataset: "wb_unit" }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain("--dataset wb_unit");
    expect(result.inner.includes("wb_unit wb_unit")).toBe(false);
    expect(result.inner.endsWith("--dataset wb_unit")).toBe(true);
  });

  it("--skus уходит одним скобочным токеном", async () => {
    const result = await processCommand.invokeInput(
      processArgs({ skus: [10, 20, 30] }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain("--skus [10,20,30]");
  });

  it("незаданные флаги следа не оставляют", async () => {
    const result = await processCommand.invokeInput(
      processArgs({ dataset: "wb_unit" }),
      io,
    ) as WrapResult;
    for (const flag of ["--modules", "--forced", "--skus", "--logs"]) {
      expect(result.inner.includes(flag), `${flag} эмитился`).toBe(false);
    }
  });

  it("--spreadsheet-id из кандидатов, но не обязателен", async () => {
    // У клиента одна таблица — значение подставилось.
    const result = await processCommand.invokeInput(
      processArgs({ dataset: "wb_unit" }),
      io,
    ) as WrapResult;
    expect(result.inner).toContain(`--spreadsheet-id ${CLIENT.sheet}`);
  });

  it("-v печатает inner в служебный поток", async () => {
    const { io: verboseIo, progress } = harness(db());
    const result = await processCommand.invokeInput(
      processArgs({ dataset: "wb_unit", verbose: true }),
      verboseIo,
    ) as WrapResult;
    expect(progress).toStrictEqual([`# inner: ${result.inner}`]);
    // И обычный вывод не подменяет: строка печати на месте.
    expect(result.printed !== null).toBe(true);
  });
});

it("кэш-БД закрывается после вызова обёртки", async () => {
  // Настоящий хэндл, а не фейк: у MCP-сервера процесс живёт долго, и
  // незакрытая БД копилась бы на каждый вызов тула. Считается именно
  // закрытие: санитайзер ресурсов SQLite-хэндла не видит.
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  let disposed = 0;
  try {
    const io = makeFakeIo({
      envFile: {
        get: () => undefined,
        require: () => "",
        set: () => Promise.resolve(),
        values: () => ({}),
      },
      openCacheDb: () => {
        const db = openCacheDb(`${dir}/mpu.db`);
        return {
          ...db,
          [Symbol.dispose]: () => {
            disposed += 1;
            db[Symbol.dispose]();
          },
        };
      },
      progress: () => {},
    });
    // Селектор ни во что не резолвится: вызов отбивается, но кэш к
    // этому моменту уже открыт — и обязан закрыться.
    await expect(processCommand.invokeInput(
      processArgs({ selector: "нет-такого-клиента", dataset: "wb_unit" }),
      io,
    )).rejects.toThrow();
    expect(disposed, "кэш открыт и не закрыт").toBe(1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("process: неоднозначная таблица — флаг не эмитится", async () => {
  await withCache([], async (db) => {
    db.execute(
      "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
        " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
      "SHEET456",
      CLIENT.id,
      "Вторая таблица",
      CLIENT.server,
      1_700_000_000,
    );
    const { io } = harness(db);
    const result = await processCommand.invokeInput(
      processArgs({ dataset: "wb_unit" }),
      io,
    ) as WrapResult;
    // В отличие от `ss-load`, неоднозначность здесь не отказ: таблица
    // у метода — уточнение, а не адрес вызова.
    expect(result.inner.includes("--spreadsheet-id")).toBe(false);
    expect(result.inner).toContain("--client-id 777 --dataset wb_unit");
  });
});

describe("process: ветка dev:N — своя печать и обязательный клиент", () => {
  const db = heldScope<CacheDb>((body) => withCache([], body));
  let io: CommandIo;
  beforeAll(() => {
    ({ io } = harness(db()));
  });

  it("печать — вызов mpu ssh, а не ssh-обёртка", async () => {
    const result = await processCommand.invokeInput(
      processArgs({
        selector: "dev:1",
        "client-id": 777,
        dataset: "wb_unit",
      }),
      io,
    ) as WrapResult;
    expect(processCommand.renderResult(result, ["dev:1", "-p"]))
      .toStrictEqual(await golden("process-dev-print.stdout.txt"));
    expect(result.server).toBe("dev:1");
  });

  it("без --client-id — ошибка ввода", async () => {
    const failure = processCommand.invokeInput(
      processArgs({ selector: "dev:1", dataset: "wb_unit" }),
      io,
    );
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow("dev-селектор требует --client-id");
  });

  it("кэш не открывается вовсе", async () => {
    // Ленивый кэш и существует ради этой ветки: на dev-ноде прод-кэша
    // клиентов нет, и открывать его незачем. Голый фейк падает на
    // первом же обращении.
    const bare = makeFakeIo({
      envFile: {
        get: () => undefined,
        require: () => "",
        set: () => Promise.resolve(),
        values: () => ({}),
      },
    });
    const result = await processCommand.invokeInput(
      processArgs({
        selector: "dev:1",
        "client-id": 777,
        dataset: "wb_unit",
        print: true,
      }),
      { ...bare, progress: () => {} },
    ) as WrapResult;
    expect(result.printed ?? "").toContain("mpu ssh target: dev:1 cmd: ");
  });

  it("--server вместе с dev:N — ошибка ввода", async () => {
    const failure = processCommand.invokeInput(
      processArgs({
        selector: "dev:1",
        "client-id": 777,
        server: "sl-3",
        dataset: "wb_unit",
      }),
      io,
    );
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow(
      "--server не имеет смысла с селектором dev:N",
    );
  });

  it("нечисловой хвост — ошибка ввода", async () => {
    const failure = processCommand.invokeInput(
      processArgs({ selector: "dev:main", "client-id": 777 }),
      io,
    );
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow(
      "dev-селектор ожидает номер sl-сервера",
    );
  });
});
