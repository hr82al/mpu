/**
 * Ход вызова API маркетплейса под ключом кабинета (`docs/specs/call.md`):
 * проверки ввода, допуск, клиент, ключ, затем `dry` либо ровно один
 * запрос. Что знает маркетплейс (хост, заголовки квоты, источник ключа),
 * отдаёт получатель `Marketplace`; чтение это или запись — допуск `Access`.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import {
  type CacheReader,
  requireSingleClient,
  resolveSelector,
} from "../selector/mod.ts";
import {
  DbError,
  devTarget,
  type OpenSession,
  type PgTarget,
  routeOf,
  serverTarget,
  type SqlSession,
} from "../sql/mod.ts";
import type { Access } from "./access.ts";
import { cabinetOf, type KeyRow } from "./key.ts";
import type { Method } from "./reads.ts";
import {
  type CallResult,
  journalNote,
  parsedBody,
  type Reply,
} from "./reply.ts";

/** Предел ожидания по умолчанию и наибольший, секунды. */
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 300;

export const argsSchema = z.object({
  selector: z.string({ error: "нужен target: клиент" }).describe(
    "клиент: client_id, имя или часть, dev:<client_id>",
  ),
  cabinet: z.string().optional().describe(
    "кабинет: у Ozon — Client-Id; один кабинет у клиента — можно опустить",
  ),
  path: z.string({ error: "нужен path: путь ручки, начинается с /" })
    .describe("путь ручки, начинается с /"),
  body: z.string().optional().describe("JSON-текст тела"),
  method: z.enum(["GET", "POST"]).optional().describe("метод запроса"),
  timeout: z.number().int().optional().describe(
    `предел ожидания ответа, секунды: 1…${MAX_TIMEOUT_S}, по умолчанию ` +
      DEFAULT_TIMEOUT_S,
  ),
  dry: z.boolean().default(false).describe(
    "напечатать запрос с ключом *** — без сети",
  ),
});

/** Разобранные аргументы вызова. */
export type CallArgs = z.infer<typeof argsSchema>;

/** Срез порта исполнения, который потребляет вызов. */
export type CallIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "note" | "signal"
>;

/** Внешнее вызова — переданной ссылкой: сеть, часы, сессия БД клиента. */
export interface CallDeps {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Сигнал, срабатывающий через `ms` миллисекунд. */
  readonly deadline: (ms: number) => AbortSignal;
  /** Монотонные миллисекунды — для `ms` результата. */
  readonly now: () => number;
  /** Сессия PG сервера клиента; открывается только для чтения. */
  readonly openSession: OpenSession;
}

/** Получатель-маркетплейс: что он знает сам. */
export interface Marketplace {
  /** Путь получателя в дереве: `ozon`. */
  readonly path: readonly string[];
  readonly host: string;
  /** Метод, когда его не задали ни вызывающий, ни допуск. */
  readonly usualMethod: Method;
  /** Тело POST, когда `body:` не задан. */
  readonly emptyBody: string;
  /** Заголовки квоты — имена в нижнем регистре, в порядке печати. */
  readonly quotaHeaders: readonly string[];
  /** Строки ключей кабинетов клиента из его схемы. */
  keys(session: SqlSession, clientId: number): Promise<readonly KeyRow[]>;
}

/** Прогон одного вызова. */
export async function runCall(
  args: CallArgs,
  io: CallIo,
  deps: CallDeps,
  receiver: { readonly marketplace: Marketplace; readonly access: Access },
): Promise<CallResult> {
  const { marketplace, access } = receiver;
  const seconds = timeoutOf(args);
  requireJson(args.body);
  const path = pathOf(args.path);
  const method = access.method(
    marketplace.host,
    path,
    args.method,
    marketplace.usualMethod,
  );
  if (method === "GET" && args.body !== undefined) {
    throw new UsageError("тело у GET не отправляется — убери body:");
  }
  // Допуск — до резолва и до чтения ключа: `call-ro` вне реестра не
  // узнаёт о ключе ничего (спека, «Инварианты»).
  access.admit(
    { method, host: marketplace.host, path },
    writingLine(marketplace, args),
  );
  const client = placeOf(args.selector, io);
  const rows = await keyRows(deps.openSession, client, marketplace);
  const key = cabinetOf(rows, args.cabinet, args.selector);
  const url = `https://${marketplace.host}${path}`;
  const body = method === "POST" ? args.body ?? marketplace.emptyBody : null;
  const kind = { "content-type": "application/json" };
  if (args.dry) {
    return {
      kind: "dry",
      method,
      url,
      headers: { ...key.shown(), ...kind },
      body: body ?? "",
    };
  }
  const request = { method, url, headers: { ...key.sign(), ...kind }, body };
  const reply = await send(request, {
    seconds,
    stop: io.signal,
    deps,
    quotaHeaders: marketplace.quotaHeaders,
    mask: (text) => key.mask(text),
  });
  // Эхо ключа в теле (ошибка авторизации) скрывается до разбора: в
  // результат, печать и журнал уходит уже замаскированное.
  const { text, ...answer } = reply;
  const result: Reply = { ...answer, body: parsedBody(key.mask(text)) };
  io.note(journalNote(result));
  return result;
}

/** `timeout:` вызова в секундах; вне 1…300 — ошибка ввода. */
function timeoutOf(args: CallArgs): number {
  const seconds = args.timeout ?? DEFAULT_TIMEOUT_S;
  if (seconds >= 1 && seconds <= MAX_TIMEOUT_S) return seconds;
  throw new UsageError(`timeout: 1…${MAX_TIMEOUT_S}, получено ${seconds}`);
}

/** `body:` обязан быть JSON: отправлять заведомо битое тело незачем. */
function requireJson(body: string | undefined): void {
  if (body === undefined) return;
  try {
    JSON.parse(body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(`body: не JSON — ${reason}`, { cause: err });
  }
}

function pathOf(path: string): string {
  if (path.startsWith("/")) return path;
  throw new UsageError(`path: начинается с /, получено ${path}`);
}

/** Та же строка записью: `mpu ask <получатель> call <ключи вызова>`. */
function writingLine(marketplace: Marketplace, args: CallArgs): string {
  const given: readonly [string, string | number | undefined][] = [
    ["target", args.selector],
    ["cabinet", args.cabinet],
    ["path", args.path],
    ["body", args.body],
    ["method", args.method],
    ["timeout", args.timeout],
  ];
  const keys = given
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${spelled(String(value))}`);
  return ["mpu", "ask", ...marketplace.path, "call", ...keys].join(" ");
}

/** Значение с пробелом — в кавычках, как у подсказки двери. */
function spelled(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

/** Клиент вызова: адрес его сервера и номер. */
interface Client {
  readonly target: PgTarget;
  readonly clientId: number;
}

/** Селектор — в клиента: ключ кабинета лежит в схеме одного клиента. */
function placeOf(selector: string, io: CallIo): Client {
  const route = routeOf(selector);
  if (route.kind === "sw") {
    throw new UsageError(
      "маршрут sw выброшен: доступа к контуру воркспейсов нет",
    );
  }
  if (route.kind === "dev") {
    if (route.clientId === null) {
      throw new UsageError(
        `нужен клиент: dev:<client_id>, получено ${selector}`,
      );
    }
    return { target: devTarget(io.envFile), clientId: route.clientId };
  }
  let db: CacheDb | undefined;
  // Кэш открывается первым запросом резолва, как у `sql-ro`.
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  try {
    const resolved = resolveSelector({ cache, env: io.envFile }, selector);
    return {
      target: serverTarget(io.envFile, resolved.serverNumber),
      clientId: requireSingleClient(resolved),
    };
  } finally {
    db?.[Symbol.dispose]();
  }
}

/** Строки ключей: одна read-only сессия, закрытая при любом исходе. */
async function keyRows(
  open: OpenSession,
  client: Client,
  marketplace: Marketplace,
): Promise<readonly KeyRow[]> {
  let session: SqlSession | undefined;
  try {
    session = await open(client.target);
    return await marketplace.keys(session, client.clientId);
  } catch (err) {
    if (err instanceof DbError) {
      throw new DomainError(`db error: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    // Сбой закрытия исхода не меняет: строки уже прочитаны либо ошибка
    // уже брошена.
    await session?.close().catch(() => {});
  }
}

/** Запрос, как он уходит: с ключом — поэтому наружу не отдаётся. */
interface Signed {
  readonly method: Method;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/** Ответ до маскирования: `text` — тело как пришло. */
type Received = Omit<Reply, "body"> & { readonly text: string };

/** Как отправлять: пределы, внешнее и что прятать в тексте сбоя. */
interface Sending {
  readonly seconds: number;
  /** Просьба остановиться от вызывающего строку. */
  readonly stop: AbortSignal;
  readonly deps: CallDeps;
  readonly quotaHeaders: readonly string[];
  /** Маска ключа: текст сбоя сети может повторить заголовки запроса. */
  readonly mask: (text: string) => string;
}

/**
 * Ровно один запрос, без повторов ни на 429, ни на 5xx (спека,
 * «Побочные эффекты»): ответ маркетплейса и есть результат.
 */
async function send(request: Signed, sending: Sending): Promise<Received> {
  const { seconds, stop, deps } = sending;
  const deadline = deps.deadline(seconds * 1000);
  const started = deps.now();
  try {
    const response = await deps.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.any([deadline, stop]),
      }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      kind: "reply",
      status: response.status,
      method: request.method,
      url: request.url,
      ms: Math.round(deps.now() - started),
      headers: quotaOf(response.headers, sending.quotaHeaders),
      text: new TextDecoder().decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch (err) {
    if (deadline.aborted) throw new DomainError(`нет ответа за ${seconds} с`);
    if (stop.aborted) throw err;
    // Причина — только замаскированным текстом, без `cause`: исходная
    // ошибка может нести ключ, и дальше по цепочке её не сторожит никто.
    const reason = err instanceof Error ? err.message : String(err);
    throw new DomainError(`запрос не выполнен — ${sending.mask(reason)}`);
  }
}

/** Присланные заголовки квоты — в порядке списка получателя. */
function quotaOf(
  headers: Headers,
  names: readonly string[],
): Record<string, string> {
  const quota: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) quota[name] = value;
  }
  return quota;
}
