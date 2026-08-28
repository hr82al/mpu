/**
 * Группа `mpu api ss-access` (`docs/specs/api-ss-access.md`): авто-тело
 * кнопки, резолв выдачи из main-БД и ожидание с пределом.
 *
 * sl-back и PostgreSQL подставные: проверяется, что ушло на сервер, по
 * какому запросу резолвились выдачи и чем кончилось ожидание. Живой
 * пары отсюда не бывает — она за напарником, и только на стенде.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { SlbackSession } from "../slback/mod.ts";
import type { OpenSession } from "../sql/mod.ts";
import type { SqlSession } from "../sql/session.ts";
import {
  runRequest,
  runReset,
  runRevoke,
  runStatus,
  ssAccessRevokeCommand,
} from "./cmd_ss_access.ts";
import {
  ACTIVE_STATUSES,
  DEFAULT_REASON,
  GrantResolveError,
  RESET_REVOKE_REASON,
  REVOKE_REASON,
} from "./ss_access.ts";

const SS = "1SyntheticSpreadsheetIdForGoldens0000000000";
const EMAIL = "kto@test";

/** Один вызов sl-back, как его увидел подставной сеанс. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Порт с кредами и адресом main-БД; сети и файлов в нём нет. */
function ioOf(files: Record<string, string> = {}) {
  const values: Record<string, string> = {
    BASE_API_URL: "https://slback.test/api",
    TOKEN_EMAIL: EMAIL,
    TOKEN_PASSWORD: "parol",
    pg_0: "10.0.0.1",
    PG_MAIN_USER_NAME: "mpu",
    PG_MAIN_USER_PASSWORD: "secret",
  };
  return makeFakeIo({
    readTextFile: (path: string) => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`нет файла ${path}`))
        : Promise.resolve(text);
    },
    envFile: {
      get: (name: string) => values[name],
      require: (name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`нет ключа ${name}`);
        return value;
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({ ...values }),
    },
  });
}

/** Подставной сеанс sl-back с записью всех вызовов. */
function sessionOf(reply: (sent: Sent, at: number) => unknown = () => ({})) {
  const sent: Sent[] = [];
  const session: SlbackSession = {
    token: () => Promise.resolve("токен"),
    call: (method, path, body) => {
      sent.push({ method, path, body });
      return Promise.resolve(reply(sent[sent.length - 1], sent.length - 1));
    },
  };
  return { session, sent };
}

/** Строки выдач, которые «видит» main-БД на очередном опросе. */
type Rounds = readonly (readonly (readonly [string, string])[])[];

/** Подставная main-БД: по строке на опрос, затем последняя повторяется. */
function dbOf(rounds: Rounds, fail?: Error) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  let at = 0;
  const session: SqlSession = {
    query: (text: string, values?: readonly unknown[]) => {
      if (fail !== undefined) return Promise.reject(fail);
      queries.push(text);
      params.push([...(values ?? [])]);
      const round = rounds[Math.min(at, rounds.length - 1)];
      at += 1;
      return Promise.resolve({
        kind: "rows" as const,
        columns: ["grant_id", "status"],
        rows: round.map(([id, status]) => [id, status]),
      });
    },
    run: () => Promise.reject(new Error("run не ожидается")),
    runMany: () => Promise.reject(new Error("runMany не ожидается")),
    close: () => Promise.resolve(),
  };
  const open: OpenSession = () => Promise.resolve(session);
  return { open, queries, params, rounds: () => at };
}

/** Часы ожидания: каждый «сон» двигает время ровно на свой шаг. */
function clockOf() {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    slept,
  };
}

Deno.test("request без опций шлёт авто-тело кнопки", async () => {
  const { session, sent } = sessionOf();
  await runRequest({ spreadsheet: SS }, ioOf(), { session });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].method, "POST");
  assertEquals(sent[0].path, `/admin/ss/${SS}/my-access/request`);
  // Три поля кнопки, включая `accessTemplateId: null`: сервер ждёт
  // ключ, а не его отсутствие.
  assertEquals(sent[0].body, {
    googleSheetsRole: "editor",
    reason: DEFAULT_REASON,
    accessTemplateId: null,
  });
});

Deno.test("точечные опции правят поля авто-тела", async () => {
  const { session, sent } = sessionOf();
  await runRequest(
    { spreadsheet: SS, reason: "разбор обращения", template: "uuid-1" },
    ioOf(),
    { session },
  );
  assertEquals(sent[0].body, {
    googleSheetsRole: "editor",
    reason: "разбор обращения",
    accessTemplateId: "uuid-1",
  });
});

Deno.test("--body отменяет точечные опции, а не смешивается", async (t) => {
  await t.step("тело уходит целиком", async () => {
    const { session, sent } = sessionOf();
    await runRequest(
      { spreadsheet: SS, body: '{"свой":"формат"}' },
      ioOf(),
      { session },
    );
    // Ни одного поля кнопки: тело заменено, а не дополнено.
    assertEquals(sent[0].body, { "свой": "формат" });
  });

  await t.step("вместе с точечной опцией — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    const err = await assertRejects(
      () =>
        runRequest(
          { spreadsheet: SS, body: "{}", reason: "текст" },
          ioOf(),
          { session },
        ),
      UsageError,
    );
    assertStringIncludes(err.message, "оставь что-то одно");
    assertEquals(sent.length, 0);
  });

  await t.step("@файл читается, а отсутствие названо путём", async () => {
    const { session, sent } = sessionOf();
    await runRequest(
      { spreadsheet: SS, body: "@/тело.json" },
      ioOf({ "/тело.json": '{"из":"файла"}' }),
      { session },
    );
    assertEquals(sent[0].body, { "из": "файла" });
    const err = await assertRejects(
      () =>
        runRequest({ spreadsheet: SS, body: "@/нет.json" }, ioOf(), {
          session,
        }),
      UsageError,
    );
    assertStringIncludes(err.message, "/нет.json");
  });
});

Deno.test("status только читает и в main-БД не ходит", async () => {
  const { session, sent } = sessionOf(() => [{ id: "grant-1" }]);
  const db = dbOf([[]]);
  const result = await runStatus({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  assertEquals(sent, [{
    method: "GET",
    path: `/admin/ss/${SS}/my-access`,
    body: undefined,
  }]);
  assertEquals(db.queries.length, 0);
  assertEquals(result.response, [{ id: "grant-1" }]);
});

Deno.test("revoke резолвит выдачи по трём статусам индекса", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[["grant-1", "applied"], ["grant-2", "created"]]]);
  const result = await runRevoke({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  // Запрос параметризован, и статусы — ровно те три, что входят в
  // частичный уникальный индекс: по всем искать нельзя, отозванная
  // выдача индекс не занимает.
  assertEquals(db.params[0], [SS, EMAIL, [...ACTIVE_STATUSES]]);
  assertStringIncludes(db.queries[0], "status = ANY($3)");
  // Ключ выдачи зовётся `grant_id`: колонки `id` в таблице нет.
  assertStringIncludes(db.queries[0], "SELECT grant_id, status");
  // По job'у на выдачу, каждый с причиной по умолчанию.
  assertEquals(sent.length, 2);
  assertEquals(sent[0].path, "/admin/jobs/ss");
  assertEquals(sent[0].body, {
    type: "accessGrantRevoke",
    data: { grantId: "grant-1", revokedByUserId: null, reason: REVOKE_REASON },
  });
  assertEquals(result.revoked.map((grant) => grant.id), [
    "grant-1",
    "grant-2",
  ]);
});

Deno.test("число отозванных — из работы, а не из длины входа", async () => {
  const { session, sent } = sessionOf();
  // Резолв нашёл одну, хотя статусов в таблице больше: печатается
  // отозванное, и оно же ушло job'ами.
  const db = dbOf([[["grant-7", "permission_added"]]]);
  const result = await runRevoke({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  assertEquals(result.revoked.length, 1);
  assertEquals(sent.length, 1);
  assertEquals(
    ssAccessRevokeCommand.renderResult(result, [SS]),
    "отозвано выдач: 1\n  grant-7 (permission_added)\n",
  );
});

Deno.test("выдач нет — код 0 и «отзывать нечего», без числа", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[]]);
  const result = await runRevoke({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  // Ни одного job'а: отзывать нечего — состояние уже целевое.
  assertEquals(sent.length, 0);
  // «отозвано 0» прочлось бы как неудача там, где её нет.
  assertEquals(
    ssAccessRevokeCommand.renderResult(result, [SS]),
    "отзывать нечего\n",
  );
});

Deno.test("--grant-id обходит резолв, а main-БД не открывается", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[["не-должно", "applied"]]]);
  await runRevoke(
    { spreadsheet: SS, "grant-id": "явный-1", reason: "по обращению" },
    ioOf(),
    { session, openSession: db.open },
  );
  assertEquals(db.queries.length, 0);
  assertEquals(sent.length, 1);
  assertEquals(
    (sent[0].body as {
      data: { grantId: string; revokedByUserId: null; reason: string };
    }).data,
    { grantId: "явный-1", revokedByUserId: null, reason: "по обращению" },
  );
});

Deno.test("отказ main-БД отличается от отказа sl-back", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[]], new Error("connection refused"));
  const err = await assertRejects(
    () =>
      runRevoke({ spreadsheet: SS }, ioOf(), { session, openSession: db.open }),
    GrantResolveError,
  );
  // Сообщение называет резолв и указывает на базу: иначе оператор
  // пойдёт чинить sl-back, который в этот момент цел.
  assertStringIncludes(err.message, "резолв выдачи в main-БД");
  assertStringIncludes(String(err.advice), "pg_0");
  // Класс — ошибка ввода: у неё код 2, а у отказа sl-back — 1.
  assertEquals(err instanceof UsageError, true);
  assertEquals(sent.length, 0);
});

Deno.test("reset: отзыв, ожидание, повторная выдача", async () => {
  const { session, sent } = sessionOf();
  // Первый опрос — резолв (выдача есть), второй — всё ещё есть,
  // третий — ушла из индекса.
  const db = dbOf([
    [["grant-1", "applied"]],
    [["grant-1", "applied"]],
    [],
  ]);
  const clock = clockOf();
  const result = await runReset({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
    now: clock.now,
    sleep: clock.sleep,
  });
  // Отзыв идёт своей причиной, а не `--reason`: тот относится к выдаче.
  assertEquals(
    (sent[0].body as { data: { reason: string } }).data.reason,
    RESET_REVOKE_REASON,
  );
  // Последний вызов — повторная выдача с авто-телом.
  assertEquals(sent[sent.length - 1].path, `/admin/ss/${SS}/my-access/request`);
  assertEquals(result.revoked.length, 1);
  assertEquals(clock.slept, [3_000]);
  assertEquals(result.waitedMs, 3_000);
});

Deno.test("reset: --reason относится к выдаче, а не к отзыву", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[["grant-1", "applied"]], []]);
  const clock = clockOf();
  await runReset(
    { spreadsheet: SS, reason: "по обращению клиента" },
    ioOf(),
    { session, openSession: db.open, now: clock.now, sleep: clock.sleep },
  );
  assertEquals(
    (sent[0].body as { data: { reason: string } }).data.reason,
    RESET_REVOKE_REASON,
  );
  assertEquals(
    (sent[sent.length - 1].body as { reason: string }).reason,
    "по обращению клиента",
  );
});

Deno.test("reset: предел ожидания истёк — код 1, а не молчаливый успех", async () => {
  const { session, sent } = sessionOf();
  // Выдача из индекса не уходит никогда.
  const db = dbOf([[["grant-1", "applied"]]]);
  const clock = clockOf();
  const err = await assertRejects(
    () =>
      runReset({ spreadsheet: SS }, ioOf(), {
        session,
        openSession: db.open,
        now: clock.now,
        sleep: clock.sleep,
        limitMs: 9_000,
      }),
    DomainError,
  );
  // Текст называет предел в секундах и оставшуюся выдачу.
  assertStringIncludes(err.message, "9 с");
  assertStringIncludes(err.message, "grant-1 (applied)");
  // Повторной выдачи не было: она упёрлась бы в тот же индекс.
  assertEquals(
    sent.some((call) => call.path.endsWith("/my-access/request")),
    false,
  );
  // Ожидание было настоящим: опрос шёл до самого предела.
  assertEquals(clock.slept.length > 0, true);
});

Deno.test("reset без выдач: ожидания нет вовсе", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[]]);
  const clock = clockOf();
  const result = await runReset({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
    now: clock.now,
    sleep: clock.sleep,
  });
  // Ждать нечего: ни одного опроса сверх резолва и ни одной паузы.
  assertEquals(clock.slept, []);
  assertEquals(db.queries.length, 1);
  assertEquals(result.revoked, []);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].path, `/admin/ss/${SS}/my-access/request`);
});

Deno.test("очередь отказала на середине — сказано, сколько уже отозвано", async () => {
  const { session, sent } = sessionOf((_sent, at) => {
    if (at === 1) throw new Error("очередь недоступна");
    return {};
  });
  const db = dbOf([[
    ["grant-1", "applied"],
    ["grant-2", "created"],
    ["grant-3", "created"],
  ]]);
  const err = await assertRejects(
    () =>
      runRevoke({ spreadsheet: SS }, ioOf(), { session, openSession: db.open }),
    DomainError,
  );
  // Число — из работы: одна выдача отозвана, на второй отказ, третья
  // не бралась вовсе.
  assertStringIncludes(err.message, "отозвано выдач: 1 из 3");
  assertStringIncludes(err.message, "grant-2");
  assertEquals(sent.length, 2);
});
