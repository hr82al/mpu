/**
 * Тесты драйвера PG (`pg.ts`) в той части, которой не нужен живой
 * PostgreSQL: чтение адреса и кред из env-файла. Их тексты попадают
 * пользователю в строку `warning: failed to query servers: …`
 * (`docs/specs/update.md`), поэтому закреплены дословно.
 *
 * Всё остальное в драйвере — разговор с сервером; его проверяет
 * `bun run smoke` запуском собранного бинаря на заведомо закрытый
 * адрес: там видно, что клиент вообще создаётся и что отказ приходит
 * сетевой ошибкой.
 */

import { describe, expect, it, vi } from "vitest";
import process from "node:process";
import { rejected } from "../testing/thrown.ts";
import driver from "pg";
import {
  clientOptions,
  makePgOpener,
  openSession,
  PgConfigError,
  PgNotReadOnlyError,
  selectQuery,
} from "./pg.ts";
import { DEFAULT_PG_LIMITS, type PgLimits } from "./sync.ts";

const FULL: Readonly<Record<string, string>> = {
  pg_3: "10.0.0.3",
  PG_MAIN_USER_NAME: "proba",
  PG_MAIN_USER_PASSWORD: "proba",
};

describe("конфигурация PG: чего не хватает, то и названо", () => {
  const cases: readonly (readonly [
    string,
    Readonly<Record<string, string>>,
    string,
  ])[] = [
    [
      "нет адреса сервера",
      { ...FULL, pg_3: "" },
      "pg_3 не задан в env-файле",
    ],
    [
      "нет ни личного, ни общего имени",
      { ...FULL, PG_MAIN_USER_NAME: "" },
      "PG_MY_USER_NAME или PG_MAIN_USER_NAME не задан в env-файле",
    ],
    [
      "нет ни личного, ни общего пароля",
      { ...FULL, PG_MAIN_USER_PASSWORD: "" },
      "PG_MY_USER_PASSWORD или PG_MAIN_USER_PASSWORD не задан в env-файле",
    ],
    [
      "порт не число",
      { ...FULL, PG_PORT: "шесть тысяч" },
      "PG_PORT: ожидался номер порта, задано 'шесть тысяч'",
    ],
  ];
  for (const [name, values, message] of cases) {
    it(name, async () => {
      const open = makePgOpener(
        { get: (key) => values[key] },
        DEFAULT_PG_LIMITS,
      );
      // Отказ приходит до всякой сети: адрес 10.0.0.3 в тестах
      // недостижим, и дойди дело до подключения — тест ждал бы таймаут.
      await rejected(
        () => open(3, { signal: new AbortController().signal }),
        PgConfigError,
        message,
      );
    });
  }
});

const TARGET = {
  host: "10.0.0.3",
  port: 6432,
  database: "wb",
  username: "proba",
  password: "proba",
};

const LIMITS: PgLimits = { connectMs: 5_000, queryMs: 20_000 };

describe("пределы времени доезжают до драйвера миллисекундами", () => {
  const options = clientOptions(TARGET, LIMITS);

  it("предел соединения — как объявлен портом, без пересчёта", () => {
    // У прежнего драйвера та же опция измерялась секундами, и перенос
    // «как есть» дал бы предел в тысячу раз меньше объявленного.
    expect(options.connectionTimeoutMillis).toStrictEqual(LIMITS.connectMs);
  });

  it("предел запроса — GUC сессии, тоже в миллисекундах", () => {
    expect(options.options).toContain(`-c statement_timeout=${LIMITS.queryMs}`);
  });
});

describe("сессия открывается read-only и проверяется на соединении", () => {
  it("опция стартового пакета", () => {
    expect(clientOptions(TARGET, LIMITS).options).toContain(
      "-c default_transaction_read_only=on",
    );
  });

  it("соединение, где запрет не действует, к работе не годно", async () => {
    await rejected(
      () => openSession(fakeClient("off").client, signal()),
      PgNotReadOnlyError,
      "transaction_read_only=off",
    );
  });

  it("открыватель сессии проводит вызов через проверку", async () => {
    // Склейка `makePgOpener` → `openSession`: без неё пишущая сессия
    // уехала бы вызывающему как годная. Клиент подставлен — живого
    // PostgreSQL у теста нет.
    const refused = fakeClient("off");
    const open = makePgOpener(
      { get: (key) => FULL[key] },
      DEFAULT_PG_LIMITS,
      () => refused.client,
    );
    await expect(open(3, { signal: signal() })).rejects.toThrow(
      PgNotReadOnlyError,
    );
  });

  it("проверка идёт первой, до всякой выборки спеки", async () => {
    // Порядок важен: выборка на пишущей сессии не должна успеть уйти
    // серверу (`platform/readonly-default.md`, «Инварианты»).
    const refused = fakeClient("off");
    await expect(openSession(refused.client, signal())).rejects.toThrow();
    expect(refused.asked.length).toBe(1);
    expect(refused.asked[0]).toContain("transaction_read_only");

    const ok = fakeClient("on");
    const session = await openSession(ok.client, signal());
    await session.clients({ signal: signal() });
    expect(ok.asked.length).toBe(2);
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Соединение, отвечающее на проверку запрета записи заданным значением. */
function fakeClient(ro: string) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      connect: () => Promise.resolve(),
      query: (config: { text: string }) => {
        asked.push(config.text);
        return Promise.resolve({ rows: [{ ro }] });
      },
      end: () => Promise.resolve(),
      on: () => {},
    },
  };
}

it("тексты трёх выборок — дословно из спеки", () => {
  // `docs/specs/update.md`, «CLI-контракт»: шаги 1–3.
  expect(selectQuery("clients", undefined).text).toBe(
    "SELECT id, server, is_active, is_locked, is_deleted FROM public.clients",
  );
  expect(selectQuery("spreadsheets", undefined).text).toStrictEqual(
    "SELECT client_id, spreadsheet_id, title, template_name, is_active" +
      " FROM public.spreadsheets",
  );
  expect(selectQuery("wbSids", undefined).text).toStrictEqual(
    "SELECT DISTINCT client_id, sid FROM public.wb_tokens" +
      " WHERE sid IS NOT NULL",
  );
});

describe("сужение до одного клиента — связанным значением", () => {
  it("без клиента — выборка по всему серверу, без значений", () => {
    const query = selectQuery("spreadsheets", undefined);
    expect(query.values).toStrictEqual([]);
    expect(query.text.includes("WHERE")).toBe(false);
  });

  it("с клиентом — параметр $1, а не склейка текста", () => {
    for (const name of ["clients", "spreadsheets", "wbSids"] as const) {
      const query = selectQuery(name, 42);
      expect(query.values, name).toStrictEqual([42]);
      expect(query.text).toContain("$1");
      expect(query.text.includes("42"), name).toBe(false);
    }
  });
});

it("уведомление сервера никуда не печатается", () => {
  // У прежнего драйвера печать глушилась опцией `onnotice`; у этого
  // уведомление приходит событием, и без слушателя EventEmitter молчит.
  // Замер, а не предположение: перехватываем оба потока процесса.
  const client = new driver.Client({
    host: "127.0.0.1",
    port: 1,
    user: "u",
    password: "p",
    database: "d",
  });
  const captured = withCapturedOutput(() => {
    client.emit("notice", { message: "NOTICE: таблица уже существует" });
  });
  expect(captured).toBe("");
});

/** Всё, что процесс напечатал за время вызова. */
function withCapturedOutput(fn: () => void): string {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const levels = ["log", "error", "warn", "info", "debug"] as const;
  const origConsole = levels.map((level) => console[level]);
  for (const level of levels) {
    console[level] = (...args: unknown[]) => void chunks.push(args.join(" "));
  }
  const writes = [process.stdout, process.stderr].map((stream) =>
    vi.spyOn(stream, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
        return true;
      },
    )
  );
  try {
    fn();
  } finally {
    levels.forEach((level, i) => void (console[level] = origConsole[i]));
    for (const write of writes) write.mockRestore();
  }
  return chunks.join("");
}
