/**
 * `mpu api wb-cards-reset` (`docs/specs/api-wb-cards-reset.md`): два
 * режима резолва, отказ на неоднозначности и печать без отправки.
 *
 * Прямой режим проверяется **взрывным** кэшем, а не пустым: разница
 * между «не позвал» и «не смог бы позвать» — та же, что между зелёным
 * тестом и живой парой (замер напарника, порция 79).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import type { CacheDb } from "../command/mod.ts";
import type { SlbackSession } from "../slback/mod.ts";
import {
  curlOf,
  RESET_BODY,
  runCardsReset,
  wbCardsResetCommand,
} from "./cmd_wb_cards_reset.ts";

const SID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER_SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Один вызов sl-back. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function sessionOf() {
  const sent: Sent[] = [];
  const session: SlbackSession = {
    token: () => Promise.resolve("токен"),
    call: (method, path, body) => {
      sent.push({ method, path, body });
      return Promise.resolve({ ok: true });
    },
  };
  return { session, sent };
}

/** Кэш-БД во временном каталоге с клиентами, таблицами и кабинетами. */
async function withCache(
  rows: readonly (readonly [number, string, readonly string[]])[],
  body: (io: ReturnType<typeof makeFakeIo>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (const [clientId, title, sids] of rows) {
      db.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (?, 'sl-1', 1, 0, 0, 0)",
        clientId,
      );
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, 1, 'sl-1', 0)",
        `ss-${clientId}`,
        clientId,
        title,
      );
      for (const sid of sids) {
        db.execute(
          "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
            " VALUES (?, ?, 'sl-1', 0)",
          sid,
          clientId,
        );
      }
    }
    await body(ioWith(db));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALUES: Readonly<Record<string, string>> = {
  BASE_API_URL: "https://slback.test/api",
  TOKEN_EMAIL: "kto@test",
  TOKEN_PASSWORD: "parol",
  pg_1: "10.0.0.1",
};

function ioWith(db: CacheDb) {
  return makeFakeIo({
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    envFile: envFile(),
  });
}

/** Порт со взрывным кэшем: любое открытие роняет вызов. */
function ioWithoutCache() {
  return makeFakeIo({
    openCacheDb: () => {
      throw new Error("кэш-БД открыта, хотя режим прямой");
    },
    envFile: envFile(),
  });
}

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

const args = (over: Record<string, unknown>) =>
  ({ print: false, ...over }) as Parameters<typeof runCardsReset>[0];

Deno.test("прямой режим: --sid не открывает кэш вовсе", async () => {
  const { session, sent } = sessionOf();
  const result = await runCardsReset(
    args({ selector: "любой-селектор", sid: SID }),
    ioWithoutCache(),
    { session },
  );
  // Кэш взрывной: дойди до него команда — упала бы. Это граница, а не
  // намерение.
  assertEquals(result.direct, true);
  assertEquals(result.sid, SID);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].method, "POST");
  assertEquals(
    sent[0].path,
    `/admin/wb-loader/loaders/${SID}/cards/v1/reset`,
  );
  assertEquals(sent[0].body, RESET_BODY);
});

Deno.test("прямой режим: селектор сам формы sid", async () => {
  const { session, sent } = sessionOf();
  const result = await runCardsReset(
    args({ selector: SID }),
    ioWithoutCache(),
    { session },
  );
  assertEquals(result.direct, true);
  assertEquals(sent[0].path, `/admin/wb-loader/loaders/${SID}/cards/v1/reset`);
});

Deno.test("через кэш: один кабинет — резолв до него", async () => {
  await withCache([[777, "Клиент", [SID]]], async (io) => {
    const { session, sent } = sessionOf();
    const result = await runCardsReset(args({ selector: "777" }), io, {
      session,
    });
    assertEquals(result.direct, false);
    assertEquals(result.sid, SID);
    assertEquals(sent.length, 1);
  });
});

Deno.test("несколько кабинетов — отказ с перечнем, а не выбор", async () => {
  await withCache([[777, "Клиент", [SID, OTHER_SID]]], async (io) => {
    const { session, sent } = sessionOf();
    const err = await assertRejects(
      () => runCardsReset(args({ selector: "777" }), io, { session }),
      UsageError,
    );
    // Оба sid'а названы, и сказано, чем выбрать: молчаливый первый
    // отправил бы сброс чужому кабинету.
    assertStringIncludes(err.message, SID);
    assertStringIncludes(err.message, OTHER_SID);
    assertStringIncludes(err.message, "--sid");
    // Ни одного запроса: отказ до сети.
    assertEquals(sent, []);
  });
});

Deno.test("--client-id сужает неоднозначный селектор", async () => {
  await withCache(
    [[777, "Общий заголовок", [SID]], [778, "Общий заголовок", [OTHER_SID]]],
    async (io) => {
      const { session, sent } = sessionOf();
      // Без сужения заголовок даёт два кабинета — отказ.
      await assertRejects(
        () => runCardsReset(args({ selector: "Общий" }), io, { session }),
        UsageError,
      );
      const result = await runCardsReset(
        args({ selector: "Общий", "client-id": "778" }),
        io,
        { session },
      );
      assertEquals(result.sid, OTHER_SID);
      assertEquals(sent.length, 1);
    },
  );
});

Deno.test("селектор без кабинетов — отказ, а не пустой запрос", async () => {
  await withCache([[777, "Клиент", []]], async (io) => {
    const { session, sent } = sessionOf();
    const err = await assertRejects(
      () => runCardsReset(args({ selector: "777" }), io, { session }),
      UsageError,
    );
    assertStringIncludes(err.message, "нет WB-кабинетов");
    assertEquals(sent, []);
  });
});

Deno.test("--print ничего не отправляет", async () => {
  const { session, sent } = sessionOf();
  const result = await runCardsReset(
    args({ selector: SID, print: true }),
    ioWithoutCache(),
    { session },
  );
  assertEquals(result.printed, true);
  assertEquals(result.response, null);
  // Ни одного запроса — в этом весь режим.
  assertEquals(sent, []);
  const text = wbCardsResetCommand.renderResult(result, [SID, "--print"]);
  assertStringIncludes(text, `/admin/wb-loader/loaders/${SID}/cards/v1/reset`);
  assertStringIncludes(text, JSON.stringify(RESET_BODY));
});

Deno.test("печать не подставляет живой токен", () => {
  const text = curlOf({
    sid: SID,
    path: `/admin/wb-loader/loaders/${SID}/cards/v1/reset`,
    direct: true,
    printed: true,
    response: null,
  });
  // Строку копируют и пересылают; живому Bearer там не место.
  assertStringIncludes(text, "Bearer $TOKEN");
  assertEquals(text.includes("токен"), false);
});

Deno.test("тело фиксировано и из опций не собирается", async () => {
  const { session, sent } = sessionOf();
  await runCardsReset(args({ selector: SID }), ioWithoutCache(), { session });
  // Ровно `{"state":{"cursor":null}}` — снято с объекта дословно.
  assertEquals(JSON.stringify(sent[0].body), '{"state":{"cursor":null}}');
});
