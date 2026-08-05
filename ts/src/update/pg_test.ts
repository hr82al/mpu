/**
 * Тесты драйвера PG (`pg.ts`) в той части, которой не нужен живой
 * PostgreSQL: чтение адреса и кред из env-файла. Их тексты попадают
 * пользователю в строку `warning: failed to query servers: …`
 * (`docs/specs/update.md`), поэтому закреплены дословно.
 *
 * Всё остальное в драйвере — разговор с сервером; его проверяет
 * `deno task smoke` запуском собранного бинаря на заведомо закрытый
 * адрес: там видно, что клиент вообще создаётся (у него хватает прав) и
 * что отказ приходит сетевой ошибкой.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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

Deno.test("конфигурация PG: чего не хватает, то и названо", async (t) => {
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
    await t.step(name, async () => {
      const open = makePgOpener(
        { get: (key) => values[key] },
        DEFAULT_PG_LIMITS,
      );
      // Отказ приходит до всякой сети: адрес 10.0.0.3 в тестах
      // недостижим, и дойди дело до подключения — тест ждал бы таймаут.
      await assertRejects(
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

Deno.test("пределы времени доезжают до драйвера миллисекундами", async (t) => {
  const options = clientOptions(TARGET, LIMITS);

  await t.step("предел соединения — как объявлен портом, без пересчёта", () => {
    // У прежнего драйвера та же опция измерялась секундами, и перенос
    // «как есть» дал бы предел в тысячу раз меньше объявленного.
    assertEquals(options.connectionTimeoutMillis, LIMITS.connectMs);
  });

  await t.step("предел запроса — GUC сессии, тоже в миллисекундах", () => {
    assertStringIncludes(
      options.options,
      `-c statement_timeout=${LIMITS.queryMs}`,
    );
  });
});

Deno.test("сессия открывается read-only и проверяется на соединении", async (t) => {
  await t.step("опция стартового пакета", () => {
    assertStringIncludes(
      clientOptions(TARGET, LIMITS).options,
      "-c default_transaction_read_only=on",
    );
  });

  await t.step(
    "соединение, где запрет не действует, к работе не годно",
    async () => {
      await assertRejects(
        () => openSession(fakeClient("off").client, signal()),
        PgNotReadOnlyError,
        "transaction_read_only=off",
      );
    },
  );

  await t.step("открыватель сессии проводит вызов через проверку", async () => {
    // Склейка `makePgOpener` → `openSession`: без неё пишущая сессия
    // уехала бы вызывающему как годная. Клиент подставлен — живого
    // PostgreSQL у теста нет.
    const refused = fakeClient("off");
    const open = makePgOpener(
      { get: (key) => FULL[key] },
      DEFAULT_PG_LIMITS,
      () => refused.client,
    );
    await assertRejects(
      () => open(3, { signal: signal() }),
      PgNotReadOnlyError,
    );
  });

  await t.step("проверка идёт первой, до всякой выборки спеки", async () => {
    // Порядок важен: выборка на пишущей сессии не должна успеть уйти
    // серверу (`platform/readonly-default.md`, «Инварианты»).
    const refused = fakeClient("off");
    await assertRejects(() => openSession(refused.client, signal()));
    assertEquals(refused.asked.length, 1);
    assertStringIncludes(refused.asked[0], "transaction_read_only");

    const ok = fakeClient("on");
    const session = await openSession(ok.client, signal());
    await session.clients({ signal: signal() });
    assertEquals(ok.asked.length, 2);
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

Deno.test("тексты трёх выборок — дословно из спеки", () => {
  // `docs/specs/update.md`, «CLI-контракт»: шаги 1–3.
  assertEquals(
    selectQuery("clients", undefined).text,
    "SELECT id, server, is_active, is_locked, is_deleted FROM public.clients",
  );
  assertEquals(
    selectQuery("spreadsheets", undefined).text,
    "SELECT client_id, spreadsheet_id, title, template_name, is_active" +
      " FROM public.spreadsheets",
  );
  assertEquals(
    selectQuery("wbSids", undefined).text,
    "SELECT DISTINCT client_id, sid FROM public.wb_tokens" +
      " WHERE sid IS NOT NULL",
  );
});

Deno.test("сужение до одного клиента — связанным значением", async (t) => {
  await t.step("без клиента — выборка по всему серверу, без значений", () => {
    const query = selectQuery("spreadsheets", undefined);
    assertEquals(query.values, []);
    assertEquals(query.text.includes("WHERE"), false);
  });

  await t.step("с клиентом — параметр $1, а не склейка текста", () => {
    for (const name of ["clients", "spreadsheets", "wbSids"] as const) {
      const query = selectQuery(name, 42);
      assertEquals(query.values, [42], name);
      assertStringIncludes(query.text, "$1");
      assertEquals(query.text.includes("42"), false, name);
    }
  });
});

Deno.test("уведомление сервера никуда не печатается", () => {
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
  assertEquals(captured, "");
});

/** Всё, что процесс напечатал за время вызова. */
function withCapturedOutput(fn: () => void): string {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const levels = ["log", "error", "warn", "info", "debug"] as const;
  const origConsole = levels.map((level) => console[level]);
  const origWrite = [Deno.stdout.write, Deno.stderr.write];
  const origWriteSync = [Deno.stdout.writeSync, Deno.stderr.writeSync];
  for (const level of levels) {
    console[level] = (...args: unknown[]) => void chunks.push(args.join(" "));
  }
  for (const stream of [Deno.stdout, Deno.stderr]) {
    stream.write = (bytes: Uint8Array) => {
      chunks.push(decoder.decode(bytes));
      return Promise.resolve(bytes.length);
    };
    stream.writeSync = (bytes: Uint8Array) => {
      chunks.push(decoder.decode(bytes));
      return bytes.length;
    };
  }
  try {
    fn();
  } finally {
    levels.forEach((level, i) => void (console[level] = origConsole[i]));
    Deno.stdout.write = origWrite[0];
    Deno.stderr.write = origWrite[1];
    Deno.stdout.writeSync = origWriteSync[0];
    Deno.stderr.writeSync = origWriteSync[1];
  }
  return chunks.join("");
}
