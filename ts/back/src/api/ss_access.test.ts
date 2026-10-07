/**
 * Группа `mpu api ss-access` (`docs/specs/api-ss-access.md`): авто-тело
 * кнопки, резолв выдачи из main-БД и ожидание с пределом.
 *
 * sl-back и PostgreSQL подставные: проверяется, что ушло на сервер, по
 * какому запросу резолвились выдачи и чем кончилось ожидание. Живой
 * пары отсюда не бывает — она за напарником, и только на стенде.
 */

import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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

it("request без опций шлёт авто-тело кнопки", async () => {
  const { session, sent } = sessionOf();
  await runRequest({ spreadsheet: SS }, ioOf(), { session });
  expect(sent.length).toBe(1);
  expect(sent[0].method).toBe("POST");
  expect(sent[0].path).toStrictEqual(`/admin/ss/${SS}/my-access/request`);
  // Три поля кнопки, включая `accessTemplateId: null`: сервер ждёт
  // ключ, а не его отсутствие.
  expect(sent[0].body).toStrictEqual({
    googleSheetsRole: "editor",
    reason: DEFAULT_REASON,
    accessTemplateId: null,
  });
});

it("точечные опции правят поля авто-тела", async () => {
  const { session, sent } = sessionOf();
  await runRequest(
    { spreadsheet: SS, reason: "разбор обращения", template: "uuid-1" },
    ioOf(),
    { session },
  );
  expect(sent[0].body).toStrictEqual({
    googleSheetsRole: "editor",
    reason: "разбор обращения",
    accessTemplateId: "uuid-1",
  });
});

describe("--body отменяет точечные опции, а не смешивается", () => {
  it("тело уходит целиком", async () => {
    const { session, sent } = sessionOf();
    await runRequest({ spreadsheet: SS, body: '{"свой":"формат"}' }, ioOf(), {
      session,
    });
    // Ни одного поля кнопки: тело заменено, а не дополнено.
    expect(sent[0].body).toStrictEqual({ свой: "формат" });
  });

  it("вместе с точечной опцией — отказ до сети", async () => {
    const { session, sent } = sessionOf();
    const err = await rejected(
      () =>
        runRequest({ spreadsheet: SS, body: "{}", reason: "текст" }, ioOf(), {
          session,
        }),
      UsageError,
    );
    expect(err.message).toContain("оставь что-то одно");
    expect(sent.length).toBe(0);
  });

  it("body-file: читается, а отсутствие названо путём", async () => {
    const { session, sent } = sessionOf();
    await runRequest(
      { spreadsheet: SS, "body-file": "/тело.json" },
      ioOf({ "/тело.json": '{"из":"файла"}' }),
      { session },
    );
    expect(sent[0].body).toStrictEqual({ из: "файла" });
    const err = await rejected(
      () =>
        runRequest({ spreadsheet: SS, "body-file": "/нет.json" }, ioOf(), {
          session,
        }),
      UsageError,
    );
    expect(err.message).toContain("/нет.json");
  });
});

it("status только читает и в main-БД не ходит", async () => {
  const { session, sent } = sessionOf(() => [{ id: "grant-1" }]);
  const db = dbOf([[]]);
  const result = await runStatus({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  expect(sent).toStrictEqual([
    {
      method: "GET",
      path: `/admin/ss/${SS}/my-access`,
      body: undefined,
    },
  ]);
  expect(db.queries.length).toBe(0);
  expect(result.response).toStrictEqual([{ id: "grant-1" }]);
});

it("revoke резолвит выдачи по трём статусам индекса", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[["grant-1", "applied"]]]);
  const result = await runRevoke({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  // Запрос параметризован, и статусы — ровно те три, что входят в
  // частичный уникальный индекс: по всем искать нельзя, отозванная
  // выдача индекс не занимает.
  expect(db.params[0]).toStrictEqual([SS, EMAIL, [...ACTIVE_STATUSES]]);
  expect(db.queries[0]).toContain("status = ANY($3)");
  // Ключ выдачи зовётся `grant_id`: колонки `id` в таблице нет.
  expect(db.queries[0]).toContain("SELECT grant_id, status");
  // Один job на найденную выдачу, с причиной по умолчанию.
  expect(sent.length).toBe(1);
  expect(sent[0].path).toBe("/admin/jobs/ss");
  expect(sent[0].body).toStrictEqual({
    type: "accessGrantRevoke",
    data: { grantId: "grant-1", revokedByUserId: null, reason: REVOKE_REASON },
  });
  expect(result.revoked.map((grant) => grant.id)).toStrictEqual(["grant-1"]);
});

it("число отозванных — из работы, а не из длины входа", async () => {
  const { session, sent } = sessionOf();
  // Резолв нашёл одну, хотя статусов в таблице больше: печатается
  // отозванное, и оно же ушло job'ами.
  const db = dbOf([[["grant-7", "permission_added"]]]);
  const result = await runRevoke({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  expect(result.revoked.length).toBe(1);
  expect(sent.length).toBe(1);
  expect(ssAccessRevokeCommand.renderResult(result, [SS])).toBe(
    "отозвано выдач: 1\n  grant-7 (permission_added)\n",
  );
});

it("выдач нет — код 0 и «отзывать нечего», без числа", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[]]);
  const result = await runRevoke({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
  });
  // Ни одного job'а: отзывать нечего — состояние уже целевое.
  expect(sent.length).toBe(0);
  // «отозвано 0» прочлось бы как неудача там, где её нет.
  expect(ssAccessRevokeCommand.renderResult(result, [SS])).toBe(
    "отзывать нечего\n",
  );
});

it("--grant-id обходит резолв, а main-БД не открывается", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[["не-должно", "applied"]]]);
  await runRevoke(
    { spreadsheet: SS, "grant-id": "явный-1", reason: "по обращению" },
    ioOf(),
    { session, openSession: db.open },
  );
  expect(db.queries.length).toBe(0);
  expect(sent.length).toBe(1);
  expect(
    (
      sent[0].body as {
        data: { grantId: string; revokedByUserId: null; reason: string };
      }
    ).data,
  ).toStrictEqual({
    grantId: "явный-1",
    revokedByUserId: null,
    reason: "по обращению",
  });
});

it("отказ main-БД отличается от отказа sl-back", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[]], new Error("connection refused"));
  const err = await rejected(
    () =>
      runRevoke({ spreadsheet: SS }, ioOf(), {
        session,
        openSession: db.open,
      }),
    GrantResolveError,
  );
  // Сообщение называет резолв и указывает на базу: иначе оператор
  // пойдёт чинить sl-back, который в этот момент цел.
  expect(err.message).toContain("резолв выдачи в main-БД");
  expect(String(err.advice)).toContain("pg_0");
  // Класс — ошибка ввода: у неё код 2, а у отказа sl-back — 1.
  expect(err instanceof UsageError).toBe(true);
  expect(sent.length).toBe(0);
});

it("reset: отзыв, ожидание, повторная выдача", async () => {
  const { session, sent } = sessionOf();
  // Первый опрос — резолв (выдача есть), второй — всё ещё есть,
  // третий — ушла из индекса.
  const db = dbOf([[["grant-1", "applied"]], [["grant-1", "applied"]], []]);
  const clock = clockOf();
  const result = await runReset({ spreadsheet: SS }, ioOf(), {
    session,
    openSession: db.open,
    now: clock.now,
    sleep: clock.sleep,
  });
  // Отзыв идёт своей причиной, а не `--reason`: тот относится к выдаче.
  expect(
    (sent[0].body as { data: { reason: string } }).data.reason,
  ).toStrictEqual(RESET_REVOKE_REASON);
  // Последний вызов — повторная выдача с авто-телом.
  expect(sent[sent.length - 1].path).toStrictEqual(
    `/admin/ss/${SS}/my-access/request`,
  );
  expect(result.revoked.length).toBe(1);
  expect(clock.slept).toStrictEqual([3_000]);
  expect(result.waitedMs).toBe(3_000);
});

it("reset: --reason относится к выдаче, а не к отзыву", async () => {
  const { session, sent } = sessionOf();
  const db = dbOf([[["grant-1", "applied"]], []]);
  const clock = clockOf();
  await runReset({ spreadsheet: SS, reason: "по обращению клиента" }, ioOf(), {
    session,
    openSession: db.open,
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(
    (sent[0].body as { data: { reason: string } }).data.reason,
  ).toStrictEqual(RESET_REVOKE_REASON);
  expect((sent[sent.length - 1].body as { reason: string }).reason).toBe(
    "по обращению клиента",
  );
});

it("reset: предел ожидания истёк — код 1, а не молчаливый успех", async () => {
  const { session, sent } = sessionOf();
  // Выдача из индекса не уходит никогда.
  const db = dbOf([[["grant-1", "applied"]]]);
  const clock = clockOf();
  const err = await rejected(
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
  expect(err.message).toContain("9 с");
  expect(err.message).toContain("grant-1 (applied)");
  // Повторной выдачи не было: она упёрлась бы в тот же индекс.
  expect(sent.some((call) => call.path.endsWith("/my-access/request"))).toBe(
    false,
  );
  // Ожидание было настоящим: опрос шёл до самого предела.
  expect(clock.slept.length > 0).toBe(true);
});

it("reset без выдач: ожидания нет вовсе", async () => {
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
  expect(clock.slept).toStrictEqual([]);
  expect(db.queries.length).toBe(1);
  expect(result.revoked).toStrictEqual([]);
  expect(sent.length).toBe(1);
  expect(sent[0].path).toStrictEqual(`/admin/ss/${SS}/my-access/request`);
});

it("две активные выдачи — отказ: индекс обещает одну", async () => {
  const { session, sent } = sessionOf();
  // Резолв обязан не «отозвать обе», а сказать, что база разошлась со
  // снимком: уникальность держит частичный индекс, и две активные по
  // одной паре означают, что индекса больше нет.
  const db = dbOf([
    [
      ["grant-1", "applied"],
      ["grant-2", "created"],
    ],
  ]);
  const err = await rejected(
    () =>
      runRevoke({ spreadsheet: SS }, ioOf(), {
        session,
        openSession: db.open,
      }),
    GrantResolveError,
  );
  expect(err.message).toContain("индекс");
  expect(err.message).toContain("не больше одной");
  expect(sent.length).toBe(0);
});
