/**
 * Сценарии 173c и 173d (`docs/specs/call.md`, W1–W14): ход
 * вызова `wb call-ro` / `wb call` на стенде — заглушка транспорта пишет
 * запросы и отвечает `200` с квотой WB; БД клиента — подставная
 * read-only сессия с `public.wb_tokens`. Колонки `usable` и `fits` стенд
 * отдаёт так, как их посчитал бы литерал запроса; сам литерал держит
 * отдельный тест.
 *
 * Токены и секрет синтетические; в каждом сценарии они ищутся во всех
 * выходах: stdout, stderr, запись `end json`, заметка журнала.
 */

import { assert, describe, expect, it } from "vitest";
import { DomainError, formatCommandError, UsageError } from "../command/mod.ts";
import type { InvokeJournal, Invoker } from "../entrypoint/mod.ts";
import { lineEntry } from "../line/mod.ts";
import { consentOf, withPolicyFile } from "../line/testconsent.ts";
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
import {
  READ_ONLY_FIRST,
  tokensQuery,
  wb,
  wbMessages,
  WRITABLE_FIRST,
} from "./wb.ts";

/** Строка `public.wb_tokens` стенда. */
interface Row {
  readonly sid: string;
  readonly token: string;
  readonly categories: readonly string[];
  readonly readOnly: boolean;
  readonly valid: boolean;
  /** Сервисный токен (`acc = 4`). */
  readonly service: boolean;
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
  // W11, W12: у кабинета только сервисные токены statistics.
  56: [row("sid-a", "w-svc", ["statistics"], { service: true })],
  // W13: сервисный и несервисный токены statistics.
  55: [
    row("sid-a", "w-svc-55", ["statistics"], { service: true }),
    row("sid-a", "w-plain-55", ["statistics"]),
  ],
};

function row(
  sid: string,
  token: string,
  categories: readonly string[],
  given: {
    readonly readOnly?: boolean;
    readonly valid?: boolean;
    readonly service?: boolean;
  } = {},
): Row {
  const { readOnly = false, valid = true, service = false } = given;
  return { sid, token, categories, readOnly, valid, service };
}

const SECRET = "wb-client-secret";

const ALL_SECRETS = [
  ...Object.values(TOKENS)
    .flat()
    .map((one) => one.token),
  SECRET,
  "cs-1",
];

const W1_URL =
  "https://statistics-api.wildberries.ru/api/v5/supplier/" +
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
function sessions(queries: [string, readonly unknown[]][]): OpenSession {
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
          columns: ["sid", "token", "read_only", "usable", "fits", "service"],
          rows: rows.map((one) => [
            one.sid,
            one.token,
            one.readOnly,
            one.valid,
            fits(one),
            one.service,
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
  const outputs =
    outcome instanceof Error
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

const W1_STDOUT =
  "HTTP 200 GET statistics-api.wildberries.ru/api/v5/" +
  "supplier/reportDetailByPeriod?dateFrom=2026-09-01\n" +
  "x-ratelimit-remaining: 9\nx-ratelimit-limit: 10\n\n[]\n";

it("W1: call-ro — токен read_only, статус, квота, тело, код 0", async () => {
  const { outcome, seen } = await onStand({});
  const result = resultOf(outcome);
  expect(renderCall(result)).toStrictEqual(W1_STDOUT);
  expect(callExitCode(result)).toBe(0);
  expect(seen.requests.length).toBe(1);
  const [request] = seen.requests;
  expect([request.method, request.url]).toStrictEqual(["GET", W1_URL]);
  expect(request.headers.get("authorization")).toBe("w-ro");
  expect(seen.queries.map(([, params]) => params)).toStrictEqual([[57]]);
});

it("W2: call — токен без read_only", async () => {
  const { outcome, seen } = await onStand({}, { writing: true });
  expect(renderCall(resultOf(outcome))).toStrictEqual(W1_STDOUT);
  expect(seen.requests[0].headers.get("authorization")).toBe("w-rw");
});

describe("предпочтение с откатом: нет своего вида — берётся другой", () => {
  // У клиента 58 в sid-a один токен statistics без read_only.
  it("call-ro без read_only-токена — обычный", async () => {
    const { seen } = await onStand({ selector: "58", cabinet: "sid-a" });
    expect(seen.requests[0].headers.get("authorization")).toBe("w-58-a");
  });
  it("call при одном read_only-токене — он", () => {
    const only = TOKENS[57].filter((one) => one.readOnly);
    expect(WRITABLE_FIRST.choose(only.map(tokenOf))).toStrictEqual(
      tokenOf(only[0]),
    );
  });
});

function tokenOf(one: Row) {
  return { value: one.token, readOnly: one.readOnly, service: one.service };
}

it("W3: ручки нет в реестре — отказ с хостом, до чтения токена", async () => {
  const { outcome, seen } = await onStand({ url: CARDS_URL });
  expect(refusalOf(outcome)).toStrictEqual({
    code: 2,
    stderr:
      "mpu wb call-ro: ручки GET content-api.wildberries.ru/content/" +
      "v2/get/cards/list нет в списке чтения — запись: mpu ask wb call " +
      `target: 57 url: ${CARDS_URL}\n`,
  });
  expect([seen.queries.length, seen.requests.length]).toStrictEqual([0, 0]);
});

it("W4: единственный токен категории недействителен — отказ", async () => {
  const { outcome, seen } = await onStand(
    { url: CARDS_URL, body: "{}" },
    { writing: true },
  );
  expect(refusalOf(outcome, "wb call")).toStrictEqual({
    code: 2,
    stderr:
      "mpu wb call: у кабинета sid-a нет действующего токена категории content\n",
  });
  expect(seen.requests.length).toBe(0);
});

it("W4, dry: нет годного токена — отказ и у dry", async () => {
  const { outcome } = await onStand(
    { url: CARDS_URL, body: "{}", dry: true },
    { writing: true },
  );
  expect(refusalOf(outcome, "wb call").code).toBe(2);
});

it("W5: хост вне таблицы — отказ до чтения токена", async () => {
  const { outcome, seen } = await onStand({ url: "https://example.com/x" });
  expect(refusalOf(outcome)).toStrictEqual({
    code: 2,
    stderr: "mpu wb call-ro: хост example.com не из API Wildberries\n",
  });
  expect([seen.queries.length, seen.requests.length]).toStrictEqual([0, 0]);
});

it("W5, call: хост вне таблицы — отказ и у записи", async () => {
  const { outcome, seen } = await onStand(
    { url: "https://example.com/x" },
    { writing: true },
  );
  expect(refusalOf(outcome, "wb call").code).toBe(2);
  expect([seen.queries.length, seen.requests.length]).toStrictEqual([0, 0]);
});

describe("url: не адрес или не https — отказ ввода до чтения токена", () => {
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
    it(url, async () => {
      const { outcome, seen } = await onStand({ url }, { writing: true });
      expect(refusalOf(outcome, "wb call")).toStrictEqual({
        code: 2,
        stderr: `mpu wb call: ${text}\n`,
      });
      expect(seen.queries.length).toBe(0);
    });
  }
});

it("W6: кабинетов два без cabinet: — отказ со списком sid", async () => {
  const { outcome, seen } = await onStand({
    selector: "58",
    url: SELLER_INFO_URL,
  });
  expect(refusalOf(outcome)).toStrictEqual({
    code: 2,
    stderr:
      "mpu wb call-ro: у клиента 58 кабинетов WB 2 — укажи " +
      "cabinet: sid-a | sid-b\n",
  });
  expect(seen.requests.length).toBe(0);
});

it("W7: common-api — токен любой категории кабинета", async () => {
  const { outcome, seen } = await onStand({
    selector: "58",
    cabinet: "sid-b",
    url: SELLER_INFO_URL,
  });
  expect(callExitCode(resultOf(outcome))).toBe(0);
  expect(seen.requests[0].headers.get("authorization")).toBe("w-58-b");
  assert(seen.queries[0][0].includes("true AS fits"), seen.queries[0][0]);
});

it("нет такого кабинета WB — отказ, код 2", async () => {
  const { outcome } = await onStand({ selector: "58", cabinet: "sid-z" });
  expect(refusalOf(outcome)).toStrictEqual({
    code: 2,
    stderr: "mpu wb call-ro: у клиента 58 нет кабинета WB sid-z\n",
  });
});

it("W8: 429 — заголовки и тело напечатаны, код 1, запрос один", async () => {
  const { outcome, seen } = await onStand(
    {},
    {
      reply: () =>
        new Response('{"title":"too many requests"}', {
          status: 429,
          headers: { "x-ratelimit-retry": "3" },
        }),
    },
  );
  const result = resultOf(outcome);
  expect(renderCall(result)).toStrictEqual(
    "HTTP 429 GET statistics-api.wildberries.ru/api/v5/supplier/" +
      "reportDetailByPeriod?dateFrom=2026-09-01\nx-ratelimit-retry: 3\n\n" +
      '{\n  "title": "too many requests"\n}\n',
  );
  expect(callExitCode(result)).toBe(1);
  expect(seen.requests.length).toBe(1);
});

it("W9: dry — authorization ***, запроса нет", async () => {
  const url =
    "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod";
  const { outcome, seen } = await onStand({ url, dry: true });
  expect(renderCall(resultOf(outcome))).toStrictEqual(
    `GET ${url}\nauthorization: ***\n`,
  );
  expect(seen.requests.length).toBe(0);
});

it("dry при заданных WB_CLIENT_SECRET и WB_USER_AGENT", async () => {
  const env = { WB_CLIENT_SECRET: SECRET, WB_USER_AGENT: "mpu-probe" };
  const { outcome } = await onStand({ dry: true }, { env });
  expect(renderCall(resultOf(outcome))).toStrictEqual(
    `GET ${W1_URL}\nauthorization: ***\nx-client-secret: ***\n` +
      "user-agent: mpu-probe\n",
  );
});

it("вызов при заданных WB_CLIENT_SECRET и WB_USER_AGENT", async () => {
  const env = { WB_CLIENT_SECRET: SECRET, WB_USER_AGENT: "mpu-probe" };
  const { seen } = await onStand({}, { env });
  const { headers } = seen.requests[0];
  expect([
    headers.get("x-client-secret"),
    headers.get("user-agent"),
  ]).toStrictEqual([SECRET, "mpu-probe"]);
});

it("эхо токена и секрета в теле ответа заменено на ***", async () => {
  const env = { WB_CLIENT_SECRET: SECRET };
  const { outcome } = await onStand(
    {},
    {
      env,
      reply: () => new Response(`{"echo":"w-ro ${SECRET}"}`),
    },
  );
  expect(callRecord(resultOf(outcome))).toStrictEqual({
    status: 200,
    method: "GET",
    url: W1_URL,
    ms: 0,
    headers: {},
    body: { echo: "*** ***" },
  });
});

it("W10: заметка журнала — статус, размер, квота; без токена", async () => {
  const { seen } = await onStand({});
  expect(seen.notes).toStrictEqual([
    "HTTP 200, тело 2 байт, x-ratelimit-remaining: 9, x-ratelimit-limit: 10",
  ]);
});

it("запрос токенов — литерал отбора спеки", () => {
  expect(tokensQuery("statistics-api.wildberries.ru")).toStrictEqual(
    "SELECT sid::text, token, read_only, (is_valid = true AND (exp IS NULL " +
      "OR exp > now()) AND (acc IS NULL OR acc NOT IN (2, 3, 4) OR (acc = 4 " +
      `AND "for" = 'asid:932c176a-5085-5c6f-bc33-4e84cdf58d7e'))) AS usable, ` +
      '"statistics" AS fits, acc = 4 AS service FROM public.wb_tokens ' +
      "WHERE client_id = $1 ORDER BY sid::text",
  );
});

const ONLY_SERVICE =
  "mpu wb call-ro: у кабинета sid-a только сервисные токены — нужен " +
  "WB_CLIENT_SECRET в ~/.config/mpu/.env\n";

describe("W11: одни сервисные токены, секрета нет — отказ до запроса", () => {
  it("вызов", async () => {
    const { outcome, seen } = await onStand({ selector: "56" });
    expect(refusalOf(outcome)).toStrictEqual({ code: 2, stderr: ONLY_SERVICE });
    expect(seen.requests.length).toBe(0);
  });
  it("dry", async () => {
    const { outcome } = await onStand({ selector: "56", dry: true });
    expect(refusalOf(outcome)).toStrictEqual({ code: 2, stderr: ONLY_SERVICE });
  });
});

it("W12: одни сервисные, секрет задан — запрос несёт x-client-secret", async () => {
  const env = { WB_CLIENT_SECRET: "cs-1" };
  const { outcome, seen } = await onStand({ selector: "56" }, { env });
  expect(callExitCode(resultOf(outcome))).toBe(0);
  expect(seen.requests.length).toBe(1);
  const { headers } = seen.requests[0];
  expect([
    headers.get("authorization"),
    headers.get("x-client-secret"),
  ]).toStrictEqual(["w-svc", "cs-1"]);
});

describe("W13: сервисный и несервисный, секрета нет — ушёл несервисный", () => {
  for (const writing of [false, true]) {
    it(writing ? "call" : "call-ro", async () => {
      const { outcome, seen } = await onStand({ selector: "55" }, { writing });
      expect(callExitCode(resultOf(outcome))).toBe(0);
      expect(seen.requests[0].headers.get("authorization")).toBe("w-plain-55");
    });
  }
});

/**
 * Строка на стенде: разбор, дверь и правила настоящие; объявления
 * `wb call-ro` / `wb call` — те же `wbMessages`, что в дереве, над
 * заглушками стенда.
 */
async function lineOnStand(words: readonly string[], answers?: string[]) {
  const requests: Request[] = [];
  let stdout = "";
  let stderr = "";
  let code = -1;
  const stand = wbMessages({
    fetch: (request) => {
      requests.push(request);
      return Promise.resolve(defaultReply());
    },
    deadline: () => new AbortController().signal,
    now: () => 0,
    openSession: sessions([]),
  });
  const invoker: Invoker = {
    invoke: (command, args, io) => {
      const path = command.path.join(" ");
      const same = stand.find((one) => one.path.join(" ") === path);
      return (same ?? command).invoke(args, io);
    },
  };
  const human =
    answers === undefined
      ? {}
      : { stdinIsTerminal: () => true, stderrIsTerminal: () => true };
  const journal = {
    nativeCall: () => {},
    note: () => {},
  } as unknown as InvokeJournal;
  await withPolicyFile((file) =>
    withCache(async (open) => {
      const io = makeFakeIo({
        envFile: envFileOf(ENV),
        openCacheDb: open,
        readStdin: () => Promise.resolve(new Uint8Array()),
        ...human,
      });
      const ports = { ...consentOf(file, answers), invoker };
      code = await lineEntry(ports)(
        words,
        io,
        {
          stdout: (text: string) => void (stdout += text),
          stderr: (text: string) => void (stderr += text),
        },
        journal,
      );
    }),
  );
  return { code, stdout, stderr, requests };
}

describe("W14: объявления через строку — call-ro берёт w-ro, call — w-rw", () => {
  const keys = ["target:", "57", "url:", W1_URL];
  it("W1: wb call-ro", async () => {
    const ran = await lineOnStand(["wb", "call-ro", ...keys]);
    expect([ran.code, ran.stdout]).toStrictEqual([0, W1_STDOUT]);
    expect(ran.requests.length).toBe(1);
    expect(ran.requests[0].headers.get("authorization")).toBe("w-ro");
  });
  it("W2: ask wb call, ответ y", async () => {
    const ran = await lineOnStand(["ask", "wb", "call", ...keys], ["y"]);
    expect([ran.code, ran.stdout]).toStrictEqual([0, W1_STDOUT]);
    expect(ran.requests.length).toBe(1);
    expect(ran.requests[0].headers.get("authorization")).toBe("w-rw");
  });
});
