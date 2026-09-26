/**
 * Сценарии 173c (`docs/specs/call.md`, «Сценарии 173c» W1–W10): ход
 * вызова `wb call-ro` / `wb call` на стенде — заглушка транспорта пишет
 * запросы и отвечает `200` с квотой WB; БД клиента — подставная
 * read-only сессия с `public.wb_tokens`. Колонки `usable` и `fits` стенд
 * отдаёт так, как их посчитал бы литерал запроса; сам литерал держит
 * отдельный тест.
 *
 * Токены и секрет синтетические; в каждом сценарии они ищутся во всех
 * выходах: stdout, stderr, запись `end json`, заметка журнала.
 */

import { assert, assertEquals } from "@std/assert";
import { DomainError, formatCommandError, UsageError } from "../command/mod.ts";
import type { OpenSession } from "../sql/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { ANY_REQUEST, ReadList } from "./access.ts";
import type { CallArgs } from "./args.ts";
import { READS } from "./reads.ts";
import {
  callExitCode,
  callRecord,
  type CallResult,
  renderCall,
} from "./reply.ts";
import { type CallDeps, runCall } from "./run.ts";
import { ENV, envFileOf, withCache } from "./teststand.ts";
import { READ_ONLY_FIRST, tokensQuery, wb, WRITABLE_FIRST } from "./wb.ts";

/** Строка `public.wb_tokens` стенда. */
interface Row {
  readonly sid: string;
  readonly token: string;
  readonly categories: readonly string[];
  readonly readOnly: boolean;
  readonly valid: boolean;
}

/** Токены стенда по клиентам. */
const TOKENS: Readonly<Record<number, readonly Row[]>> = {
  57: [
    row("sid-a", "w-ro", ["statistics"], { readOnly: true }),
    row("sid-a", "w-rw", ["statistics"]),
    row("sid-a", "w-bad", ["content"], { valid: false }),
  ],
  58: [
    row("sid-a", "w-58-a", ["statistics"]),
    row("sid-b", "w-58-b", ["content"]),
  ],
};

function row(
  sid: string,
  token: string,
  categories: readonly string[],
  given: { readonly readOnly?: boolean; readonly valid?: boolean } = {},
): Row {
  const { readOnly = false, valid = true } = given;
  return { sid, token, categories, readOnly, valid };
}

const SECRET = "wb-client-secret";

const ALL_SECRETS = [
  ...Object.values(TOKENS).flat().map((one) => one.token),
  SECRET,
];

const W1_URL = "https://statistics-api.wildberries.ru/api/v5/supplier/" +
  "reportDetailByPeriod?dateFrom=2026-09-01";

const CARDS_URL =
  "https://content-api.wildberries.ru/content/v2/get/cards/list";

const SELLER_INFO_URL = "https://common-api.wildberries.ru/api/v1/seller-info";

/** Ответ заглушки по умолчанию. */
function defaultReply(): Response {
  return new Response("[]", {
    status: 200,
    headers: { "x-ratelimit-remaining": "9", "x-ratelimit-limit": "10" },
  });
}

interface Given {
  readonly reply?: () => Response;
  /** Команда записи (`call`) вместо чтения. */
  readonly writing?: boolean;
  /** Env-файл сверх стенда: `WB_CLIENT_SECRET`, `WB_USER_AGENT`. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Что видел стенд за прогон. */
interface Seen {
  readonly requests: Request[];
  readonly queries: readonly (readonly [string, readonly unknown[]])[];
  readonly notes: readonly string[];
}

/**
 * Сессия стенда: строки клиента из параметра запроса; `fits` — по
 * колонке категории, названной в запросе (`true` — любая).
 */
function sessions(
  queries: [string, readonly unknown[]][],
): OpenSession {
  return () =>
    Promise.resolve({
      query: (text: string, params: readonly unknown[] = []) => {
        queries.push([text, params]);
        const column = /(\S+) AS fits/.exec(text)?.[1] ?? "";
        const fits = (one: Row) =>
          column === "true" || one.categories.includes(column.slice(1, -1));
        const rows = TOKENS[Number(params[0])] ?? [];
        return Promise.resolve({
          kind: "rows" as const,
          columns: ["sid", "token", "read_only", "usable", "fits"],
          rows: rows.map((one) => [
            one.sid,
            one.token,
            one.readOnly,
            one.valid,
            fits(one),
          ]),
        });
      },
      run: () => Promise.reject(new Error("run не ожидается")),
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => Promise.resolve(),
    });
}

function argsOf(given: Partial<CallArgs>): CallArgs {
  return { selector: "57", url: W1_URL, dry: false, ...given };
}

/** Прогон на стенде: результат либо ошибка и всё, что стенд видел. */
async function onStand(args: Partial<CallArgs>, given: Given = {}) {
  const requests: Request[] = [];
  const queries: [string, readonly unknown[]][] = [];
  const notes: string[] = [];
  let outcome: CallResult | Error = new Error("не исполнялось");
  await withCache(async (open) => {
    const deps: CallDeps = {
      fetch: (request) => {
        requests.push(request);
        return Promise.resolve((given.reply ?? defaultReply)());
      },
      deadline: () => new AbortController().signal,
      now: () => 0,
      openSession: sessions(queries),
    };
    const io = makeFakeIo({
      envFile: envFileOf({ ...ENV, ...given.env }),
      openCacheDb: open,
      note: (line) => void notes.push(line),
    });
    const receiver = given.writing
      ? { marketplace: wb(WRITABLE_FIRST), access: ANY_REQUEST }
      : { marketplace: wb(READ_ONLY_FIRST), access: new ReadList(READS) };
    try {
      outcome = await runCall(argsOf(args), io, deps, receiver);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      outcome = err;
    }
  });
  const seen: Seen = { requests, queries, notes };
  assertNoSecret(outcome, seen, given.writing ? "wb call" : "wb call-ro");
  return { outcome, seen };
}

function errorText(err: Error, name: string): string {
  if (err instanceof UsageError || err instanceof DomainError) {
    return formatCommandError(name, err);
  }
  return err.message;
}

/** Ни в одном выходе нет ни токена, ни секрета стенда. */
function assertNoSecret(outcome: CallResult | Error, seen: Seen, name: string) {
  const outputs = outcome instanceof Error
    ? [outcome.message, errorText(outcome, name)]
    : [renderCall(outcome), JSON.stringify(callRecord(outcome))];
  for (const text of [...outputs, ...seen.notes]) {
    for (const secret of ALL_SECRETS) {
      assert(!text.includes(secret), `секрет ${secret} в выводе: ${text}`);
    }
  }
}

function resultOf(outcome: CallResult | Error): CallResult {
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

function refusalOf(outcome: CallResult | Error, name = "wb call-ro") {
  assert(outcome instanceof UsageError || outcome instanceof DomainError);
  return {
    code: outcome instanceof UsageError ? 2 : 1,
    stderr: `${errorText(outcome, name)}\n`,
  };
}

const W1_STDOUT = "HTTP 200 GET statistics-api.wildberries.ru/api/v5/" +
  "supplier/reportDetailByPeriod?dateFrom=2026-09-01\n" +
  "x-ratelimit-remaining: 9\nx-ratelimit-limit: 10\n\n[]\n";

Deno.test("W1: call-ro — токен read_only, статус, квота, тело, код 0", async () => {
  const { outcome, seen } = await onStand({});
  const result = resultOf(outcome);
  assertEquals(renderCall(result), W1_STDOUT);
  assertEquals(callExitCode(result), 0);
  assertEquals(seen.requests.length, 1);
  const [request] = seen.requests;
  assertEquals([request.method, request.url], ["GET", W1_URL]);
  assertEquals(request.headers.get("authorization"), "w-ro");
  assertEquals(seen.queries.map(([, params]) => params), [[57]]);
});

Deno.test("W2: call — токен без read_only", async () => {
  const { outcome, seen } = await onStand({}, { writing: true });
  assertEquals(renderCall(resultOf(outcome)), W1_STDOUT);
  assertEquals(seen.requests[0].headers.get("authorization"), "w-rw");
});

Deno.test("предпочтение с откатом: нет своего вида — берётся другой", async (t) => {
  // У клиента 58 в sid-a один токен statistics без read_only.
  await t.step("call-ro без read_only-токена — обычный", async () => {
    const { seen } = await onStand({ selector: "58", cabinet: "sid-a" });
    assertEquals(seen.requests[0].headers.get("authorization"), "w-58-a");
  });
  await t.step("call при одном read_only-токене — он", () => {
    const only = TOKENS[57].filter((one) => one.readOnly);
    assertEquals(WRITABLE_FIRST.choose(only.map(tokenOf)), tokenOf(only[0]));
  });
});

function tokenOf(one: Row) {
  return { value: one.token, readOnly: one.readOnly };
}

Deno.test("W3: ручки нет в реестре — отказ с хостом, до чтения токена", async () => {
  const { outcome, seen } = await onStand({ url: CARDS_URL });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu wb call-ro: ручки GET content-api.wildberries.ru/content/" +
      "v2/get/cards/list нет в списке чтения — запись: mpu ask wb call " +
      `target: 57 url: ${CARDS_URL}\n`,
  });
  assertEquals([seen.queries.length, seen.requests.length], [0, 0]);
});

Deno.test("W4: единственный токен категории недействителен — отказ", async () => {
  const { outcome, seen } = await onStand(
    { url: CARDS_URL, body: "{}" },
    { writing: true },
  );
  assertEquals(refusalOf(outcome, "wb call"), {
    code: 2,
    stderr:
      "mpu wb call: у кабинета sid-a нет действующего токена категории content\n",
  });
  assertEquals(seen.requests.length, 0);
});

Deno.test("W4, dry: нет годного токена — отказ и у dry", async () => {
  const { outcome } = await onStand(
    { url: CARDS_URL, body: "{}", dry: true },
    { writing: true },
  );
  assertEquals(refusalOf(outcome, "wb call").code, 2);
});

Deno.test("W5: хост вне таблицы — отказ до чтения токена", async () => {
  const { outcome, seen } = await onStand({ url: "https://example.com/x" });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu wb call-ro: хост example.com не из API Wildberries\n",
  });
  assertEquals([seen.queries.length, seen.requests.length], [0, 0]);
});

Deno.test("W5, call: хост вне таблицы — отказ и у записи", async () => {
  const { outcome, seen } = await onStand(
    { url: "https://example.com/x" },
    { writing: true },
  );
  assertEquals(refusalOf(outcome, "wb call").code, 2);
  assertEquals([seen.queries.length, seen.requests.length], [0, 0]);
});

Deno.test("url: не адрес или не https — отказ ввода до чтения токена", async (t) => {
  const cases: readonly [string, string][] = [
    [
      "statistics-api.wildberries.ru/x",
      "url: не адрес — statistics-api.wildberries.ru/x",
    ],
    [
      "http://statistics-api.wildberries.ru/x",
      "url: только https://, получено http://statistics-api.wildberries.ru/x",
    ],
  ];
  for (const [url, text] of cases) {
    await t.step(url, async () => {
      const { outcome, seen } = await onStand({ url }, { writing: true });
      assertEquals(refusalOf(outcome, "wb call"), {
        code: 2,
        stderr: `mpu wb call: ${text}\n`,
      });
      assertEquals(seen.queries.length, 0);
    });
  }
});

Deno.test("W6: кабинетов два без cabinet: — отказ со списком sid", async () => {
  const { outcome, seen } = await onStand({
    selector: "58",
    url: SELLER_INFO_URL,
  });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu wb call-ro: у клиента 58 кабинетов WB 2 — укажи " +
      "cabinet: sid-a | sid-b\n",
  });
  assertEquals(seen.requests.length, 0);
});

Deno.test("W7: common-api — токен любой категории кабинета", async () => {
  const { outcome, seen } = await onStand({
    selector: "58",
    cabinet: "sid-b",
    url: SELLER_INFO_URL,
  });
  assertEquals(callExitCode(resultOf(outcome)), 0);
  assertEquals(seen.requests[0].headers.get("authorization"), "w-58-b");
  assert(seen.queries[0][0].includes("true AS fits"), seen.queries[0][0]);
});

Deno.test("нет такого кабинета WB — отказ, код 2", async () => {
  const { outcome } = await onStand({ selector: "58", cabinet: "sid-z" });
  assertEquals(refusalOf(outcome), {
    code: 2,
    stderr: "mpu wb call-ro: у клиента 58 нет кабинета WB sid-z\n",
  });
});

Deno.test("W8: 429 — заголовки и тело напечатаны, код 1, запрос один", async () => {
  const { outcome, seen } = await onStand({}, {
    reply: () =>
      new Response('{"title":"too many requests"}', {
        status: 429,
        headers: { "x-ratelimit-retry": "3" },
      }),
  });
  const result = resultOf(outcome);
  assertEquals(
    renderCall(result),
    "HTTP 429 GET statistics-api.wildberries.ru/api/v5/supplier/" +
      "reportDetailByPeriod?dateFrom=2026-09-01\nx-ratelimit-retry: 3\n\n" +
      '{\n  "title": "too many requests"\n}\n',
  );
  assertEquals(callExitCode(result), 1);
  assertEquals(seen.requests.length, 1);
});

Deno.test("W9: dry — authorization ***, запроса нет", async () => {
  const url =
    "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod";
  const { outcome, seen } = await onStand({ url, dry: true });
  assertEquals(
    renderCall(resultOf(outcome)),
    `GET ${url}\nauthorization: ***\n`,
  );
  assertEquals(seen.requests.length, 0);
});

Deno.test("dry при заданных WB_CLIENT_SECRET и WB_USER_AGENT", async () => {
  const env = { WB_CLIENT_SECRET: SECRET, WB_USER_AGENT: "mpu-probe" };
  const { outcome } = await onStand({ dry: true }, { env });
  assertEquals(
    renderCall(resultOf(outcome)),
    `GET ${W1_URL}\nauthorization: ***\nx-client-secret: ***\n` +
      "user-agent: mpu-probe\n",
  );
});

Deno.test("вызов при заданных WB_CLIENT_SECRET и WB_USER_AGENT", async () => {
  const env = { WB_CLIENT_SECRET: SECRET, WB_USER_AGENT: "mpu-probe" };
  const { seen } = await onStand({}, { env });
  const { headers } = seen.requests[0];
  assertEquals(
    [headers.get("x-client-secret"), headers.get("user-agent")],
    [SECRET, "mpu-probe"],
  );
});

Deno.test("эхо токена и секрета в теле ответа заменено на ***", async () => {
  const env = { WB_CLIENT_SECRET: SECRET };
  const { outcome } = await onStand({}, {
    env,
    reply: () => new Response(`{"echo":"w-ro ${SECRET}"}`),
  });
  assertEquals(callRecord(resultOf(outcome)), {
    status: 200,
    method: "GET",
    url: W1_URL,
    ms: 0,
    headers: {},
    body: { echo: "*** ***" },
  });
});

Deno.test("W10: заметка журнала — статус, размер, квота; без токена", async () => {
  const { seen } = await onStand({});
  assertEquals(seen.notes, [
    "HTTP 200, тело 2 байт, x-ratelimit-remaining: 9, x-ratelimit-limit: 10",
  ]);
});

Deno.test("запрос токенов — литерал отбора спеки", () => {
  assertEquals(
    tokensQuery("statistics-api.wildberries.ru"),
    "SELECT sid::text, token, read_only, (is_valid = true AND (exp IS NULL " +
      "OR exp > now()) AND (acc IS NULL OR acc NOT IN (2, 3, 4) OR (acc = 4 " +
      `AND "for" = 'asid:932c176a-5085-5c6f-bc33-4e84cdf58d7e'))) AS usable, ` +
      '"statistics" AS fits FROM public.wb_tokens WHERE client_id = $1 ' +
      "ORDER BY sid::text",
  );
});
