/**
 * Сценарии 173b (`docs/specs/call.md`, «Сценарии 173b»): ход вызова
 * `ozon perf call-ro` / `ozon perf call` на стенде — заглушка транспорта
 * отвечает на обмен токена и на запрос; БД клиента — подставная read-only
 * сессия с `ozon_api_keys`: у клиента 54 ключи Performance заданы, у
 * клиента 56 кабинет есть, ключей Performance нет.
 *
 * Секрет и bearer синтетические; в каждом сценарии они ищутся во всех
 * выходах: stdout, stderr, запись `end json`, заметка журнала.
 */

import { assert, expect, it } from "vitest";
import { DomainError, formatCommandError, UsageError } from "@mpu/command";
import type { OpenSession } from "../sql/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
import { ANY_REQUEST, ReadList } from "./access.ts";
import {
  EXCHANGE_EACH_CALL,
  ozonPerf,
  ozonPerfCallCommand,
  ozonPerfCallRoCommand,
} from "./ozonPerf.ts";
import { READS } from "./reads.ts";
import {
  callExitCode,
  callRecord,
  type CallResult,
  renderCall,
} from "./reply.ts";
import type { CallArgs } from "./args.ts";
import { type CallDeps, runCall } from "./run.ts";
import { ENV, envFileOf, withCache } from "./teststand.ts";

/** Строки `ozon_api_keys` по клиентам: Client-Id, id и секрет Performance. */
const KEYS: Readonly<Record<number, readonly (readonly (string | null)[])[]>> =
  {
    54: [["2129958", "p-54-id", "p-54-secret"]],
    56: [["5600001", null, ""]],
  };

const SECRETS = ["p-54-secret", "b-54-token"];

const TOKEN_URL = "https://api-performance.ozon.ru/api/client/token";

const TOKEN_BODY =
  '{"access_token":"b-54-token","expires_in":1800,"token_type":"Bearer"}';

interface Given {
  /** Ответ на обмен токена; нет — токен стенда. */
  readonly exchange?: () => Response;
  /** Сетевой сбой обмена: запрос отклоняется этой ошибкой. */
  readonly failure?: Error;
  /** Команда записи (`call`) вместо чтения. */
  readonly writing?: boolean;
}

/** Заглушка: обмен — по «Дано», прочее — `200 {"list":[]}`. */
function transport(given: Given, requests: Request[]): CallDeps["fetch"] {
  return (request) => {
    requests.push(request);
    if (request.url === TOKEN_URL) {
      if (given.failure !== undefined) return Promise.reject(given.failure);
      const exchange = given.exchange ?? (() => new Response(TOKEN_BODY));
      return Promise.resolve(exchange());
    }
    return Promise.resolve(new Response('{"list":[]}'));
  };
}

function sessions(): OpenSession {
  return () =>
    Promise.resolve({
      query: (text: string) => {
        const id = Number(/"schema_(\d+)"/.exec(text)?.[1]);
        return Promise.resolve({
          kind: "rows" as const,
          columns: [
            "seller_client_id",
            "performance_client_id",
            "performance_client_secret",
          ],
          rows: (KEYS[id] ?? []).map((row) => [...row]),
        });
      },
      run: () => Promise.reject(new Error("run не ожидается")),
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => Promise.resolve(),
    });
}

/** Прогон одной строки: свой исполнитель — своя память, как живьём. */
async function onStand(args: Partial<CallArgs>, given: Given = {}) {
  const requests: Request[] = [];
  const notes: string[] = [];
  let outcome: CallResult | Error = new Error("не исполнялось");
  await withCache(async (open) => {
    const deps: CallDeps = {
      fetch: transport(given, requests),
      deadline: () => new AbortController().signal,
      now: () => 0,
      openSession: sessions(),
    };
    const io = makeFakeIo({
      envFile: envFileOf(ENV),
      openCacheDb: open,
      note: (line) => void notes.push(line),
    });
    const receiver = {
      marketplace: ozonPerf(EXCHANGE_EACH_CALL),
      access: given.writing ? ANY_REQUEST : new ReadList(READS),
    };
    const full = {
      selector: "54",
      path: "/api/client/campaign",
      dry: false,
      ...args,
    };
    try {
      outcome = await runCall(full, io, deps, receiver);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      outcome = err;
    }
  });
  assertNoSecret(outcome, notes);
  return { outcome, requests, notes };
}

/** Ни в одном выходе нет ни секрета, ни bearer. */
function assertNoSecret(outcome: CallResult | Error, notes: string[]): void {
  const outputs =
    outcome instanceof Error
      ? [outcome.message, errorText(outcome)]
      : [renderCall(outcome), JSON.stringify(callRecord(outcome))];
  for (const text of [...outputs, ...notes]) {
    for (const secret of SECRETS) {
      assert(!text.includes(secret), `${secret} в выводе: ${text}`);
    }
  }
}

function errorText(err: Error): string {
  if (err instanceof UsageError || err instanceof DomainError) {
    return formatCommandError("ozon perf call-ro", err);
  }
  return err.message;
}

function resultOf(outcome: CallResult | Error): CallResult {
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

function refusalOf(outcome: CallResult | Error) {
  assert(outcome instanceof UsageError || outcome instanceof DomainError);
  return {
    code: outcome instanceof UsageError ? 2 : 1,
    stderr: `${errorText(outcome)}\n`,
  };
}

const B1_STDOUT =
  "HTTP 200 GET api-performance.ozon.ru/api/client/campaign\n" +
  '\n{\n  "list": []\n}\n';

/** Обмен и запрос B1, как их видела заглушка. */
async function assertExchangeThenCall(requests: Request[]): Promise<void> {
  expect(requests.map((one) => [one.method, one.url])).toStrictEqual([
    ["POST", TOKEN_URL],
    ["GET", "https://api-performance.ozon.ru/api/client/campaign"],
  ]);
  const [exchange, call] = requests;
  expect(await exchange.json()).toStrictEqual({
    client_id: "p-54-id",
    client_secret: "p-54-secret",
    grant_type: "client_credentials",
  });
  expect(call.headers.get("authorization")).toBe("Bearer b-54-token");
  expect(call.body).toStrictEqual(null);
}

it("B1: обмен, затем GET под bearer — ответ, код 0", async () => {
  const { outcome, requests } = await onStand({});
  const result = resultOf(outcome);
  expect(renderCall(result)).toStrictEqual(B1_STDOUT);
  expect(callExitCode(result)).toBe(0);
  await assertExchangeThenCall(requests);
});

it("B2: следующая строка — обмен снова: токен живёт одну строку", async () => {
  await onStand({});
  const { outcome, requests } = await onStand({});
  expect(renderCall(resultOf(outcome))).toStrictEqual(B1_STDOUT);
  await assertExchangeThenCall(requests);
});

it("B4: у кабинета нет ключей Performance — отказ, запроса нет", async () => {
  for (const dry of [false, true]) {
    const { outcome, requests } = await onStand({ selector: "56", dry });
    expect(refusalOf(outcome)).toStrictEqual({
      code: 2,
      stderr:
        "mpu ozon perf call-ro: у кабинета 5600001 нет ключей Performance API\n",
    });
    expect(requests.length).toBe(0);
  }
});

it("B5: обмен 401 — его статус и тело, секрет скрыт, код 1", async () => {
  const { outcome, requests } = await onStand(
    {},
    {
      exchange: () =>
        new Response(
          '{"error":"invalid_client","client_secret":"p-54-secret"}',
          { status: 401 },
        ),
    },
  );
  const result = resultOf(outcome);
  expect(renderCall(result)).toStrictEqual(
    "HTTP 401 POST api-performance.ozon.ru/api/client/token\n\n" +
      '{\n  "error": "invalid_client",\n  "client_secret": "***"\n}\n',
  );
  expect(callExitCode(result)).toBe(1);
  expect(requests.length).toBe(1);
});

it("обмен 200 без access_token — сбой без тела ответа, код 1", async () => {
  for (const body of ['{"token":"b-54-token"}', "b-54-token"]) {
    const { outcome, requests } = await onStand(
      {},
      {
        exchange: () => new Response(body),
      },
    );
    expect(refusalOf(outcome)).toStrictEqual({
      code: 1,
      stderr:
        "mpu ozon perf call-ro: обмен токена: в ответе нет access_token\n",
    });
    expect(requests.length).toBe(1);
  }
});

it("сетевой сбой обмена — код 1, секрет в тексте сбоя скрыт", async () => {
  const { outcome } = await onStand(
    {},
    {
      failure: new TypeError("connection reset, client_secret=p-54-secret"),
    },
  );
  expect(refusalOf(outcome)).toStrictEqual({
    code: 1,
    stderr:
      "mpu ozon perf call-ro: запрос не выполнен — connection reset, " +
      "client_secret=***\n",
  });
});

it("эхо bearer в теле ответа заменено на ***", async () => {
  const requests: Request[] = [];
  const echo: CallDeps["fetch"] = (request) => {
    requests.push(request);
    if (request.url === TOKEN_URL) {
      return Promise.resolve(new Response(TOKEN_BODY));
    }
    return Promise.resolve(new Response('{"seen":"Bearer b-54-token"}'));
  };
  await withCache(async (open) => {
    const result = await runCall(
      { selector: "54", path: "/api/client/campaign", dry: false },
      makeFakeIo({ envFile: envFileOf(ENV), openCacheDb: open }),
      {
        fetch: echo,
        deadline: () => new AbortController().signal,
        now: () => 0,
        openSession: sessions(),
      },
      {
        marketplace: ozonPerf(EXCHANGE_EACH_CALL),
        access: new ReadList(READS),
      },
    );
    expect((callRecord(result) as { body: unknown }).body).toStrictEqual({
      seen: "Bearer ***",
    });
  });
});

it("B6: ручка заказа отчёта в реестре — POST с телом, код 0", async () => {
  const { outcome, requests } = await onStand({
    path: "/api/client/statistics/json",
    body: '{"campaigns":["1"]}',
  });
  const result = resultOf(outcome);
  expect(callExitCode(result)).toBe(0);
  expect(renderCall(result).split("\n")[0]).toBe(
    "HTTP 200 POST api-performance.ozon.ru/api/client/statistics/json",
  );
  const call = requests[1];
  expect(call.headers.get("content-type")).toBe("application/json");
  expect(await call.text()).toBe('{"campaigns":["1"]}');
});

it("B7: ручки нет в реестре — отказ до чтения ключа", async () => {
  const { outcome, requests } = await onStand({
    path: "/api/client/campaign/1/activate",
  });
  expect(refusalOf(outcome)).toStrictEqual({
    code: 2,
    stderr:
      "mpu ozon perf call-ro: ручки GET /api/client/campaign/1/activate " +
      "нет в списке чтения — запись: mpu ask ozon perf call target: 54 " +
      "path: /api/client/campaign/1/activate\n",
  });
  expect(requests.length).toBe(0);
});

it("call — любая ручка: без body: GET, с body: POST", async () => {
  const cases: readonly [Partial<CallArgs>, string][] = [
    [{ path: "/api/client/campaign/1/activate" }, "GET"],
    [{ path: "/api/client/campaign/1/activate", body: "{}" }, "POST"],
  ];
  for (const [args, method] of cases) {
    const { outcome, requests } = await onStand(args, { writing: true });
    expect(callExitCode(resultOf(outcome))).toBe(0);
    expect(requests[1].method).toStrictEqual(method);
  }
});

it("B8: dry — bearer ***, ни обмена, ни запроса", async () => {
  const { outcome, requests } = await onStand({ dry: true });
  const result = resultOf(outcome);
  expect(renderCall(result)).toStrictEqual(
    "GET https://api-performance.ozon.ru/api/client/campaign\n" +
      "authorization: Bearer ***\n",
  );
  expect(callRecord(result)).toStrictEqual({
    method: "GET",
    url: "https://api-performance.ozon.ru/api/client/campaign",
    headers: { authorization: "Bearer ***" },
    body: null,
  });
  expect(requests.length).toBe(0);
});

it("B10: журнал — без stdout, заметка без секрета и bearer", async () => {
  const { notes } = await onStand({});
  expect(notes).toStrictEqual(["HTTP 200, тело 11 байт"]);
  expect(ozonPerfCallRoCommand.logsStdout).toBe(false);
  expect(ozonPerfCallCommand.logsStdout).toBe(false);
});
