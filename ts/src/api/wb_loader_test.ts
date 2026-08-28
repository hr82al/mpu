/**
 * Группа `mpu api wb-loader-*` (`docs/specs/api-wb-loader.md`): формы
 * имени загрузчика, взаимоисключающие флаги, окно из `--from` и
 * неотменяемый первый шаг у `--and-load`.
 *
 * Все проверки ввода обязаны срабатывать до сети, поэтому подставной
 * сеанс здесь ещё и свидетель: там, где отказ правильный, он не должен
 * увидеть ни одного вызова.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import type { CacheDb } from "../command/mod.ts";
import type { SlbackSession } from "../slback/mod.ts";
import {
  runBlocked,
  runConfig,
  runReset,
  runResume,
  wbLoaderResetCommand,
  wbLoaderStatusCommand,
} from "./cmd_wb_loader.ts";
import {
  LOADERS,
  REASONS,
  requireLoader,
  requireSlug,
  slugOf,
  stateFromDate,
} from "./wb_loader.ts";

const SID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER_SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function sessionOf(fail?: (at: number) => boolean) {
  const sent: Sent[] = [];
  const session: SlbackSession = {
    token: () => Promise.resolve("токен"),
    call: (method, path, body) => {
      sent.push({ method, path, body });
      if (fail?.(sent.length - 1)) {
        return Promise.reject(new Error("сервер отказал"));
      }
      return Promise.resolve({ ok: true });
    },
  };
  return { session, sent };
}

const VALUES: Readonly<Record<string, string>> = {
  BASE_API_URL: "https://slback.test/api",
  TOKEN_EMAIL: "kto@test",
  TOKEN_PASSWORD: "parol",
};

function envFile() {
  return {
    get: (name: string) => VALUES[name],
    require: (name: string) => {
      const value = VALUES[name];
      if (value === undefined) throw new Error(`нет ключа ${name}`);
      return value;
    },
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    values: () => ({ ...VALUES }),
  };
}

/** Порт со взрывным кэшем: его открытие роняет вызов. */
function ioDirect() {
  return makeFakeIo({
    openCacheDb: () => {
      throw new Error("кэш открыт, хотя режим прямой");
    },
    envFile: envFile(),
  });
}

/** Кэш-БД с одним клиентом и его кабинетами. */
async function withCache(
  sids: readonly string[],
  body: (io: ReturnType<typeof makeFakeIo>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (777, 'sl-1', 1, 0, 0, 0)",
    );
    for (const sid of sids) {
      db.execute(
        "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
          " VALUES (?, 777, 'sl-1', 0)",
        sid,
      );
    }
    await body(ioWith(db));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function ioWith(db: CacheDb) {
  return makeFakeIo({
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    envFile: envFile(),
  });
}

const args = (over: Record<string, unknown>) =>
  ({
    print: false,
    "only-permanent": false,
    all: false,
    "and-load": false,
    ...over,
  }) as never;

Deno.test("две формы имени загрузчика и подсказка на перепутанной", async (t) => {
  await t.step("слаг выводится из имени по одному правилу", () => {
    assertEquals(slugOf("wbCards"), "cards");
    assertEquals(slugOf("wbAdvFullstats"), "adv-fullstats");
    assertEquals(
      slugOf("wbAdvNormqueryStatsByDates"),
      "adv-normquery-stats-by-dates",
    );
    // Списки закрыты и не пусты: пустой прошёл бы любую проверку.
    assertEquals(LOADERS.length, 25);
    assertEquals(REASONS.length, 17);
  });

  await t.step("camelCase там, где ждут camelCase", () => {
    assertEquals(requireLoader("wbCards"), "wbCards");
    const err = assertThrowsUsage(() => requireLoader("cards"));
    // Оператор набрал существующую сущность не той формой — ему нужна
    // форма, а не список из двадцати пяти имён.
    assertStringIncludes(String(err.hint), "используй camelCase-имя: wbCards");
  });

  await t.step("слаг там, где ждут слаг", () => {
    assertEquals(requireSlug("cards"), "cards");
    const err = assertThrowsUsage(() => requireSlug("wbCards"));
    assertStringIncludes(String(err.hint), "используй kebab-слаг: cards");
  });

  await t.step("несуществующее имя — перечень допустимых", () => {
    const err = assertThrowsUsage(() => requireSlug("нет-такого"));
    assertStringIncludes(String(err.hint), "один из: ");
    assertStringIncludes(String(err.hint), "cards");
  });
});

function assertThrowsUsage(body: () => unknown): UsageError {
  try {
    body();
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error("ожидался UsageError");
}

Deno.test("config: три флага правки взаимоисключающи, и это до сети", async (t) => {
  for (
    const pair of [["enable", "disable"], ["enable", "reset"], [
      "disable",
      "reset",
    ]]
  ) {
    await t.step(pair.join(" + "), async () => {
      const { session, sent } = sessionOf();
      const err = await assertRejects(
        () =>
          runConfig(
            args({
              selector: SID,
              loader: "cards",
              [pair[0]]: true,
              [pair[1]]: true,
            }),
            ioDirect(),
            { session },
          ),
        UsageError,
      );
      assertStringIncludes(err.message, "взаимоисключающи");
      // Ни одного вызова: «последний выигрывает» включил бы загрузчик
      // там, где просили выключить.
      assertEquals(sent, []);
    });
  }

  await t.step("без флагов — чтение", async () => {
    const { session, sent } = sessionOf();
    await runConfig(
      args({ selector: SID, loader: "cards" }),
      ioDirect(),
      { session },
    );
    assertEquals(sent[0].method, "GET");
    assertEquals(sent[0].body, undefined);
    assertStringIncludes(sent[0].path, `/loaders/${SID}/cards/v1/config`);
  });

  await t.step("один флаг — правка своим телом", async () => {
    const { session, sent } = sessionOf();
    await runConfig(
      args({ selector: SID, loader: "cards", disable: true }),
      ioDirect(),
      { session },
    );
    assertEquals(sent[0].method, "PATCH");
    assertEquals(sent[0].body, { enabled: false });
  });
});

Deno.test("reset: --state и --from взаимоисключающи, до сети", async () => {
  const { session, sent } = sessionOf();
  const err = await assertRejects(
    () =>
      runReset(
        args({
          selector: SID,
          loader: "orders",
          state: "{}",
          from: "2026-08-01",
        }),
        ioDirect(),
        { session },
      ),
    UsageError,
  );
  assertStringIncludes(err.message, "взаимоисключающи");
  assertEquals(sent, []);
});

Deno.test("--from собирает состояние на день раньше указанной", async (t) => {
  await t.step("чистая функция", () => {
    // Загрузчик идёт вперёд по дате и начинает со следующего дня после
    // сохранённого: «с 1 августа» означает сохранить 31 июля.
    assertEquals(stateFromDate("2026-08-01"), { lastLoadedDate: "2026-07-31" });
    assertEquals(stateFromDate("2026-01-01"), { lastLoadedDate: "2025-12-31" });
    assertEquals(stateFromDate("2026-03-01"), { lastLoadedDate: "2026-02-28" });
  });

  await t.step("и она же уходит в теле запроса", async () => {
    const { session, sent } = sessionOf();
    await runReset(
      args({ selector: SID, loader: "orders", from: "2026-08-01" }),
      ioDirect(),
      { session },
    );
    assertEquals(sent[0].body, { state: { lastLoadedDate: "2026-07-31" } });
  });

  await t.step("негодная дата — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    await assertRejects(
      () =>
        runReset(
          args({ selector: SID, loader: "orders", from: "01.08.2026" }),
          ioDirect(),
          { session },
        ),
      UsageError,
    );
    assertEquals(sent, []);
  });
});

Deno.test("--and-load: отказ прогона не отменяет сброса", async () => {
  // Первый вызов проходит, второй падает.
  const { session, sent } = sessionOf((at) => at === 1);
  const err = await assertRejects(
    () =>
      runReset(
        args({ selector: SID, loader: "orders", "and-load": true }),
        ioDirect(),
        { session },
      ),
    DomainError,
  );
  // Сообщение обязано сказать, что сброс уже произошёл: иначе оператор
  // решит, что состояние прежнее, и повторит сброс.
  assertStringIncludes(err.message, "сброс состояния прошёл");
  assertStringIncludes(err.message, "форс-прогон не удался");
  assertEquals(sent.length, 2);
  assertEquals(sent[0].path.endsWith("/v1/reset"), true);
  assertEquals(sent[1].path.endsWith("/v1/load"), true);
});

Deno.test("--and-load: успех даёт оба ответа", async () => {
  const { session, sent } = sessionOf();
  const result = await runReset(
    args({ selector: SID, loader: "orders", "and-load": true }),
    ioDirect(),
    { session },
  );
  assertEquals(sent.length, 2);
  assertEquals(result.loaded, { ok: true });
});

Deno.test("blocked: фильтр из заданного, --server в тело не идёт", async (t) => {
  await t.step("пустой фильтр — вся ферма", async () => {
    const { session, sent } = sessionOf();
    await runBlocked(args({}), ioDirect(), { session });
    assertEquals(sent[0].body, { filter: {} });
    assertEquals(sent[0].path, "/admin/wb-loader/blocked-loaders/v1/find");
  });

  await t.step("заданное попадает, --server — нет", async () => {
    const { session, sent } = sessionOf();
    await runBlocked(
      args({
        loader: "wbCards",
        reason: "unknown_error",
        "only-permanent": true,
        sid: SID,
        server: "wb-3",
      }),
      ioDirect(),
      { session },
    );
    assertEquals(sent[0].body, {
      filter: {
        sid: SID,
        loader: "wbCards",
        reason: "unknown_error",
        only_permanent: true,
      },
    });
    // `--server` — клиентский постфильтр: в теле его быть не должно.
    assertEquals(JSON.stringify(sent[0].body).includes("wb-3"), false);
  });

  await t.step("негодная причина — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    await assertRejects(
      () => runBlocked(args({ reason: "нет-такой" }), ioDirect(), { session }),
      UsageError,
    );
    assertEquals(sent, []);
  });
});

Deno.test("resume: показ не мутирует, --all с именем — отказ", async (t) => {
  await t.step("без имени и без --all идёт find", async () => {
    const { session, sent } = sessionOf();
    await runResume(args({ selector: SID }), ioDirect(), { session });
    assertEquals(sent[0].path, "/admin/wb-loader/blocked-loaders/v1/find");
    assertEquals(sent[0].body, { filter: { sid: SID } });
  });

  await t.step("с именем идёт resume", async () => {
    const { session, sent } = sessionOf();
    await runResume(
      args({ selector: SID, loader: "wbCards" }),
      ioDirect(),
      { session },
    );
    assertEquals(sent[0].path, "/admin/wb-loader/blocked-loaders/v1/resume");
    assertEquals(sent[0].body, { filter: { sid: SID, loader: "wbCards" } });
  });

  await t.step("--all вместе с именем — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    const err = await assertRejects(
      () =>
        runResume(
          args({ selector: SID, loader: "wbCards", all: true }),
          ioDirect(),
          { session },
        ),
      UsageError,
    );
    assertStringIncludes(err.message, "взаимоисключающи");
    assertEquals(sent, []);
  });

  await t.step("--all снимает всё: имени в фильтре нет", async () => {
    const { session, sent } = sessionOf();
    await runResume(
      args({ selector: SID, all: true }),
      ioDirect(),
      { session },
    );
    assertEquals(sent[0].body, { filter: { sid: SID } });
    assertEquals(sent[0].path.endsWith("/resume"), true);
  });
});

Deno.test("резолв по кэшу: один sid берётся, несколько — отказ", async (t) => {
  await t.step("единственный", async () => {
    await withCache([SID], async (io) => {
      const { session, sent } = sessionOf();
      await runResume(args({ selector: "777" }), io, { session });
      assertEquals(sent[0].body, { filter: { sid: SID } });
    });
  });

  await t.step("несколько — отказ со списком", async () => {
    await withCache([SID, OTHER_SID], async (io) => {
      const { session, sent } = sessionOf();
      const err = await assertRejects(
        () => runResume(args({ selector: "777" }), io, { session }),
        UsageError,
      );
      assertStringIncludes(err.message, "несколько WB sid");
      assertStringIncludes(String(err.details), SID);
      assertStringIncludes(String(err.details), OTHER_SID);
      assertEquals(sent, []);
    });
  });
});

Deno.test("--print печатает вызов и не отправляет ничего", async () => {
  const { session, sent } = sessionOf();
  const result = await runReset(
    args({
      selector: SID,
      loader: "orders",
      from: "2026-08-01",
      print: true,
      "and-load": true,
    }),
    ioDirect(),
    { session },
  );
  assertEquals(sent, []);
  const text = wbLoaderResetCommand.renderResult(result, [
    SID,
    "orders",
    "--from",
    "2026-08-01",
    "--print",
    "--and-load",
  ]);
  assertStringIncludes(text, "TOKEN=$(mpu api get-token)");
  assertStringIncludes(text, `/loaders/${SID}/orders/v1/reset`);
  assertStringIncludes(text, '"lastLoadedDate":"2026-07-31"');
  // Живого токена в сниппете нет: строку копируют и пересылают.
  assertEquals(text.includes("токен"), false);
});

Deno.test("status: слаг в пути, прямой режим без кэша", async () => {
  // Через `--print`: настоящий сеанс здесь пошёл бы в сеть, а проверяем
  // мы путь, а не поход.
  const result = await wbLoaderStatusCommand.invoke(
    [SID, "adv-fullstats", "--print"],
    ioDirect(),
  ) as { call: { path: string }; printed: boolean };
  assertEquals(result.printed, true);
  assertEquals(
    result.call.path,
    `/admin/wb-loader/loaders/${SID}/adv-fullstats/v1/status`,
  );
});
