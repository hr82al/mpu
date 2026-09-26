/**
 * Сценарии 173a (`docs/specs/call.md`, «Сценарии 173a» A1–A18): ход
 * вызова `ozon call-ro` / `ozon call` на стенде — транспорт HTTP подменён
 * заглушкой, которая записывает запросы и отвечает по таблице «Дано»;
 * БД клиента — подставная read-only сессия с `ozon_api_keys`; кэш-БД
 * селектора — настоящая, во временном файле.
 *
 * Ключи стенда синтетические. В каждом сценарии ключ ищется во всех
 * выходах: stdout, stderr (текст ошибки), запись `end json`, заметка
 * журнала.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { DomainError, formatCommandError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { OpenSession } from "../sql/mod.ts";
import { ANY_REQUEST, ReadList } from "./access.ts";
import { OZON_SELLER, ozonCallCommand, ozonCallRoCommand } from "./ozon.ts";
import { READS } from "./reads.ts";
import {
  callExitCode,
  callRecord,
  type CallResult,
  renderCall,
} from "./reply.ts";
import { type CallArgs, type CallDeps, runCall } from "./run.ts";
import { ENV, envFileOf, withCache } from "./teststand.ts";

/** Ключи стенда по клиентам: строки таблицы в её порядке. */
const KEYS: Readonly<Record<number, readonly (readonly [string, string])[]>> = {
  54: [["2129958", "k-54-seller"]],
  55: [["2129958", "k-55-a"], ["1539401", "k-55-b"], ["870282", "k-55-c"]],
};

const ALL_KEYS = Object.values(KEYS).flat().map(([, key]) => key);

/** Ответ заглушки по умолчанию. */
function defaultReply(): Response {
  return new Response('{"name":"cool_flaps","id":2129958}', {
    status: 200,
    headers: { "ratelimit-remaining": "7", "content-type": "application/json" },
  });
}

/** Что видел стенд за прогон. */
interface Seen {
  readonly requests: Request[];
  readonly sessions: number;
  readonly notes: readonly string[];
  readonly deadlines: readonly number[];
}

interface Given {
  /** Ответ заглушки; нет — ответ по умолчанию. */
  readonly reply?: () => Response;
  /** Заглушка молчит: ответа нет до срабатывания сигнала. */
  readonly silent?: boolean;
  /** Команда записи (`call`) вместо чтения. */
  readonly writing?: boolean;
  /** Сетевой сбой заглушки: запрос отклоняется этой ошибкой. */
  readonly failure?: Error;
}

/** Сессия стенда: строки ключей клиента по имени его схемы. */
function sessions(onOpen: () => void): OpenSession {
  return () => {
    onOpen();
    return Promise.resolve({
      query: (text: string) => {
        const id = Number(/"schema_(\d+)"/.exec(text)?.[1]);
        return Promise.resolve({
          kind: "rows" as const,
          columns: ["seller_client_id", "seller_api_key"],
          rows: (KEYS[id] ?? []).map(([cabinet, key]) => [cabinet, key]),
        });
      },
      run: () => Promise.reject(new Error("run не ожидается")),
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => Promise.resolve(),
    });
  };
}

/** Заглушка транспорта: пишет запрос, отвечает по «Дано». */
function transport(given: Given, requests: Request[]): CallDeps["fetch"] {
  return (request) => {
    requests.push(request);
    if (given.failure !== undefined) return Promise.reject(given.failure);
    if (!given.silent) return Promise.resolve((given.reply ?? defaultReply)());
    return new Promise((_, reject) => {
      const stop = () => reject(request.signal.reason);
      if (request.signal.aborted) stop();
      request.signal.addEventListener("abort", stop);
    });
  };
}

/** Аргументы вызова: всё, кроме названного, — умолчания схемы. */
function argsOf(given: Partial<CallArgs>): CallArgs {
  return {
    selector: "54",
    path: "/v1/seller/info",
    dry: false,
    ...given,
  };
}

/** Прогон на стенде: результат либо ошибка и всё, что стенд видел. */
async function onStand(args: Partial<CallArgs>, given: Given = {}) {
  const requests: Request[] = [];
  const notes: string[] = [];
  const deadlines: number[] = [];
  let opened = 0;
  let clock = 0;
  let outcome: CallResult | Error = new Error("не исполнялось");
  await withCache(async (open) => {
    const deps: CallDeps = {
      fetch: transport(given, requests),
      // Молчащая заглушка ждёт сигнала: срок у стенда уже вышел.
      deadline: (ms) => {
        deadlines.push(ms);
        return given.silent
          ? AbortSignal.abort()
          : new AbortController().signal;
      },
      now: () => (clock += 201) - 201,
      openSession: sessions(() => opened++),
    };
    const io = makeFakeIo({
      envFile: envFileOf(ENV),
      openCacheDb: open,
      note: (line) => void notes.push(line),
    });
    const receiver = {
      marketplace: OZON_SELLER,
      access: given.writing ? ANY_REQUEST : new ReadList(READS),
    };
    try {
      outcome = await runCall(argsOf(args), io, deps, receiver);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      outcome = err;
    }
  });
  const seen: Seen = { requests, sessions: opened, notes, deadlines };
  assertNoKey(outcome, seen);
  return { outcome, seen };
}

/** Ни в одном выходе нет ни одного ключа стенда. */
function assertNoKey(outcome: CallResult | Error, seen: Seen): void {
  const outputs = outcome instanceof Error
    ? [outcome.message, errorText(outcome)]
    : [renderCall(outcome), JSON.stringify(callRecord(outcome))];
  for (const text of [...outputs, ...seen.notes]) {
    for (const key of ALL_KEYS) {
      assert(!text.includes(key), `ключ ${key} в выводе: ${text}`);
    }
  }
}

function errorText(err: Error): string {
  if (err instanceof UsageError || err instanceof DomainError) {
    return formatCommandError("ozon call-ro", err);
  }
  return err.message;
}

function resultOf(outcome: CallResult | Error): CallResult {
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

/** Текст отказа, как его печатает точка входа, и класс (код). */
function refusalOf(outcome: CallResult | Error) {
  assert(outcome instanceof UsageError || outcome instanceof DomainError);
  return {
    code: outcome instanceof UsageError ? 2 : 1,
    stderr: `${errorText(outcome)}\n`,
  };
}

const A1_STDOUT = "HTTP 200 POST api-seller.ozon.ru/v1/seller/info\n" +
  "ratelimit-remaining: 7\n\n" +
  '{\n  "name": "cool_flaps",\n  "id": 2129958\n}\n';

Deno.test("A1: ответ 200 — статус, квота, тело с отступами, код 0", async () => {
  const { outcome } = await onStand({});
  const result = resultOf(outcome);
  assertEquals(renderCall(result), A1_STDOUT);
  assertEquals(callExitCode(result), 0);
});

Deno.test("A2: end json — одна запись полями спеки", async () => {
  const { outcome } = await onStand({});
  assertEquals(
    JSON.stringify(callRecord(resultOf(outcome))),
    '{"status":200,"method":"POST","url":"https://api-seller.ozon.ru/v1/seller/info",' +
      '"ms":201,"headers":{"ratelimit-remaining":"7"},' +
      '"body":{"name":"cool_flaps","id":2129958}}',
  );
});

Deno.test("A3: заглушка видит ключ кабинета в заголовках и тело {}", async () => {
  const { seen } = await onStand({});
  assertEquals(seen.requests.length, 1);
  const [request] = seen.requests;
  assertEquals(request.method, "POST");
  assertEquals(request.url, "https://api-seller.ozon.ru/v1/seller/info");
  assertEquals(request.headers.get("client-id"), "2129958");
  assertEquals(request.headers.get("api-key"), "k-54-seller");
  assertEquals(request.headers.get("content-type"), "application/json");
  assertEquals(await request.text(), "{}");
});

Deno.test("A4: кабинетов три без cabinet: — отказ со списком, запроса нет", async () => {
  const { outcome, seen } = await onStand({ selector: "55" });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu ozon call-ro: у клиента 55 кабинетов Ozon 3 — укажи " +
      "cabinet: 2129958 | 1539401 | 870282\n",
  });
  assertEquals(seen.requests.length, 0);
});

Deno.test("A5: cabinet: выбирает ключ кабинета", async () => {
  const { outcome, seen } = await onStand({
    selector: "55",
    cabinet: "1539401",
  });
  assertEquals(renderCall(resultOf(outcome)), A1_STDOUT);
  assertEquals(seen.requests[0].headers.get("api-key"), "k-55-b");
  assertEquals(seen.requests[0].headers.get("client-id"), "1539401");
});

Deno.test("A6: нет такого кабинета — отказ, код 2", async () => {
  const { outcome, seen } = await onStand({ selector: "55", cabinet: "999" });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu ozon call-ro: у клиента 55 нет кабинета Ozon 999\n",
  });
  assertEquals(seen.requests.length, 0);
});

Deno.test("A7: ручки нет в реестре — отказ до чтения ключа", async () => {
  const { outcome, seen } = await onStand({ path: "/v1/product/import" });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu ozon call-ro: ручки POST /v1/product/import нет в списке " +
      "чтения — запись: mpu ask ozon call target: 54 path: /v1/product/import\n",
  });
  assertEquals(seen.sessions, 0);
  assertEquals(seen.requests.length, 0);
});

Deno.test("A9: call — любая ручка, тело как задано", async () => {
  const { outcome, seen } = await onStand(
    { path: "/v1/product/import", body: '{"items":[]}' },
    { writing: true },
  );
  const result = resultOf(outcome);
  assertEquals(
    renderCall(result).split("\n").slice(0, 2),
    [
      "HTTP 200 POST api-seller.ozon.ru/v1/product/import",
      "ratelimit-remaining: 7",
    ],
  );
  assertEquals(await seen.requests[0].text(), '{"items":[]}');
});

Deno.test("A10: 429 — заголовки и тело напечатаны, код 1, запрос один", async () => {
  const { outcome, seen } = await onStand({}, {
    reply: () =>
      new Response(
        '{"code":8,"message":"You have reached request rate limit per second"}',
        {
          status: 429,
          headers: { "retry-after": "1", "ratelimit-remaining": "0" },
        },
      ),
  });
  const result = resultOf(outcome);
  assertEquals(
    renderCall(result),
    "HTTP 429 POST api-seller.ozon.ru/v1/seller/info\n" +
      "ratelimit-remaining: 0\nretry-after: 1\n\n" +
      '{\n  "code": 8,\n  "message": "You have reached request rate limit per second"\n}\n',
  );
  assertEquals(callExitCode(result), 1);
  assertEquals(seen.requests.length, 1);
});

Deno.test("A11: тело не JSON — как есть, в json — строкой", async () => {
  const { outcome } = await onStand({}, {
    reply: () =>
      new Response("ok", {
        headers: { "ratelimit-remaining": "7", "content-type": "text/plain" },
      }),
  });
  const result = resultOf(outcome);
  assertEquals(
    renderCall(result),
    "HTTP 200 POST api-seller.ozon.ru/v1/seller/info\nratelimit-remaining: 7\n\nok\n",
  );
  assertEquals(callExitCode(result), 0);
  assertEquals((callRecord(result) as { body: unknown }).body, "ok");
});

Deno.test("A12: заглушка молчит — нет ответа за timeout:, код 1", async () => {
  const { outcome, seen } = await onStand({ timeout: 1 }, { silent: true });
  assertEquals(refusalOf(outcome), {
    code: 1,
    stderr: "mpu ozon call-ro: нет ответа за 1 с\n",
  });
  assertEquals(seen.deadlines, [1000]);
});

Deno.test("A13: dry — запрос с ключом ***, в сеть ничего", async () => {
  const { outcome, seen } = await onStand({ dry: true });
  const result = resultOf(outcome);
  assertEquals(
    renderCall(result),
    "POST https://api-seller.ozon.ru/v1/seller/info\nclient-id: 2129958\n" +
      "api-key: ***\ncontent-type: application/json\n\n{}\n",
  );
  assertEquals(callExitCode(result), 0);
  assertEquals(seen.requests.length, 0);
});

Deno.test("A14: эхо ключа в теле ответа заменено на ***", async () => {
  const { outcome } = await onStand({}, {
    reply: () => new Response('{"message":"bad key k-54-seller"}'),
  });
  assertEquals(
    callRecord(resultOf(outcome)),
    {
      status: 200,
      method: "POST",
      url: "https://api-seller.ozon.ru/v1/seller/info",
      ms: 201,
      headers: {},
      body: { message: "bad key ***" },
    },
  );
});

Deno.test("A15: body: не JSON — отказ с сообщением разборщика", async () => {
  const { outcome, seen } = await onStand({ body: '{"a":}' });
  const { code, stderr } = refusalOf(outcome);
  assertEquals(code, 2);
  assert(stderr.startsWith("mpu ozon call-ro: body: не JSON — "), stderr);
  assertEquals([seen.sessions, seen.requests.length], [0, 0]);
});

Deno.test("A16: GET по реестру с body: — отказ", async () => {
  const { outcome } = await onStand({ path: "/v1/actions", body: "{}" });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu ozon call-ro: тело у GET не отправляется — убери body:\n",
  });
});

Deno.test("GET по реестру без body: — метод правила, тела нет", async () => {
  const { seen } = await onStand({ path: "/v1/actions" });
  assertEquals(seen.requests[0].method, "GET");
  assertEquals(seen.requests[0].body, null);
  assertEquals(seen.requests[0].headers.get("content-type"), null);
});

Deno.test("A17: заметка журнала — статус, размер тела, квота; тела нет", async () => {
  const { seen } = await onStand({});
  assertEquals(seen.notes, ["HTTP 200, тело 34 байт, ratelimit-remaining: 7"]);
  assertEquals(ozonCallRoCommand.logsStdout, false);
  assertEquals(ozonCallCommand.logsStdout, false);
  assertEquals(ozonCallRoCommand.logsOutput, true);
});

Deno.test("A18: timeout: вне 1…300 — отказ до всего", async () => {
  const { outcome, seen } = await onStand({ timeout: 301 });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu ozon call-ro: timeout: 1…300, получено 301\n",
  });
  assertEquals([seen.sessions, seen.requests.length], [0, 0]);
});

Deno.test("call-ro вне реестра — транспорт не зовётся ни при каком методе", async () => {
  for (const method of ["GET", "POST"] as const) {
    await assertRejects(
      () =>
        runCall(
          argsOf({ path: "/v2/product/delete", method }),
          makeFakeIo({
            openCacheDb: () => {
              throw new Error("кэш читаться не должен");
            },
          }),
          {
            fetch: () => {
              throw new Error("транспорт звать нельзя");
            },
            deadline: () => new AbortController().signal,
            now: () => 0,
            openSession: () => {
              throw new Error("ключ читать нельзя");
            },
          },
          { marketplace: OZON_SELLER, access: new ReadList(READS) },
        ),
      UsageError,
    );
  }
});

Deno.test("сетевой сбой — код 1, текст сбоя без ключа", async () => {
  const { outcome } = await onStand({}, {
    failure: new TypeError("connection reset, api-key k-54-seller"),
  });
  assertEquals(refusalOf(outcome), {
    code: 1,
    stderr: "mpu ozon call-ro: запрос не выполнен — connection reset, " +
      "api-key ***\n",
  });
});

Deno.test("dry в end json — запрос с ключом ***", async () => {
  const { outcome } = await onStand({ dry: true });
  assertEquals(callRecord(resultOf(outcome)), {
    method: "POST",
    url: "https://api-seller.ozon.ru/v1/seller/info",
    headers: {
      "client-id": "2129958",
      "api-key": "***",
      "content-type": "application/json",
    },
    body: "{}",
  });
});

Deno.test("отказы селектора и пути — до чтения ключа", async () => {
  const cases: readonly [Partial<CallArgs>, string][] = [
    [
      { selector: "sw" },
      "маршрут sw выброшен: доступа к контуру воркспейсов нет",
    ],
    [{ selector: "dev:x" }, "нужен клиент: dev:<client_id>, получено dev:x"],
    [
      { path: "v1/seller/info" },
      "path: начинается с /, получено v1/seller/info",
    ],
    [{ selector: "56" }, "у клиента 56 нет кабинетов Ozon"],
  ];
  for (const [args, text] of cases) {
    const { outcome, seen } = await onStand(args);
    assert(outcome instanceof UsageError, text);
    assertEquals(outcome.message, text);
    assertEquals(seen.requests.length, 0);
  }
});

Deno.test("dev:<client_id> — ключ из схемы клиента на dev-стенде", async () => {
  const requests: Request[] = [];
  const targets: string[] = [];
  const env = {
    DEV_PG_HOST: "10.1.1.1",
    DEV_PG_USER: "du",
    DEV_PG_PASSWORD: "dp",
  };
  const open = sessions(() => {});
  const result = await runCall(
    argsOf({ selector: "dev:54" }),
    makeFakeIo({ envFile: envFileOf(env) }),
    {
      fetch: transport({}, requests),
      deadline: () => new AbortController().signal,
      now: () => 0,
      openSession: (target) => {
        targets.push(target.host);
        return open(target);
      },
    },
    { marketplace: OZON_SELLER, access: new ReadList(READS) },
  );
  assertEquals(callExitCode(result), 0);
  assertEquals(targets, ["10.1.1.1"]);
  assertEquals(requests[0].headers.get("client-id"), "2129958");
});

Deno.test("отказ БД при чтении ключа — ошибка БД, код 1", async () => {
  const { DbError } = await import("../sql/mod.ts");
  await withCache(async (open) => {
    const err = await assertRejects(
      () =>
        runCall(
          argsOf({}),
          makeFakeIo({ envFile: envFileOf(ENV), openCacheDb: open }),
          {
            fetch: () => Promise.reject(new Error("транспорт звать нельзя")),
            deadline: () => new AbortController().signal,
            now: () => 0,
            openSession: () =>
              Promise.reject(
                new DbError('relation "ozon_api_keys" does not exist'),
              ),
          },
          { marketplace: OZON_SELLER, access: new ReadList(READS) },
        ),
      DomainError,
    );
    assertEquals(
      err.message,
      'db error: relation "ozon_api_keys" does not exist',
    );
  });
});
