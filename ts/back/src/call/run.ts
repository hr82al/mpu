/**
 * Ход вызова API маркетплейса под ключом кабинета (`docs/specs/call.md`):
 * проверки ввода, допуск, клиент, ключ, затем `dry` либо ровно один
 * запрос. Что знает маркетплейс (хост, заголовки квоты, источник ключа),
 * отдаёт получатель `Marketplace`; чтение это или запись — допуск `Access`.
 */

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
import type { Address, Aim } from "./address.ts";
import { type CallArgs, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from "./args.ts";
import { type CabinetKey, cabinetOf } from "./key.ts";
import type { Method } from "./reads.ts";
import {
  type CallResult,
  journalNote,
  parsedBody,
  type Reply,
} from "./reply.ts";
import { type Net, send } from "./transport.ts";

/** Срез порта исполнения, который потребляет вызов. */
export type CallIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "note" | "signal"
>;

/** Внешнее вызова — переданной ссылкой: сеть, часы, сессия БД клиента. */
export interface CallDeps extends Net {
  /** Сессия PG сервера клиента; открывается только для чтения. */
  readonly openSession: OpenSession;
}

/** Получатель-маркетплейс: что он знает сам. */
export interface Marketplace {
  /** Путь получателя в дереве: `ozon`. */
  readonly path: readonly string[];
  /** Имя в текстах отказов: `Ozon`. */
  readonly name: string;
  /** Ключ адреса запроса и его разбор. */
  readonly address: Address;
  /**
   * Метод, когда его не задали ни вызывающий, ни допуск.
   *
   * @param body `body:` вызова
   */
  usualMethod(body: string | undefined): Method;
  /** Тело POST, когда `body:` не задан; `null` — POST уходит без тела. */
  readonly emptyBody: string | null;
  /** Заголовки квоты — имена в нижнем регистре, в порядке печати. */
  readonly quotaHeaders: readonly string[];
  /** Ключи кабинетов клиента для запроса по этой цели. */
  keys(session: SqlSession, wanted: Wanted): Promise<readonly CabinetKey[]>;
}

/** Чей ключ и для чего: клиент, цель запроса, env-файл. */
export interface Wanted {
  readonly clientId: number;
  readonly aim: Aim;
  /** Необязательные заголовки получателя (`WB_USER_AGENT`) — из env. */
  readonly env: Pick<CommandIo["envFile"], "get">;
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
  const aim = marketplace.address.aim(args);
  const method = access.method(
    aim.host,
    aim.path,
    args.method,
    marketplace.usualMethod(args.body),
  );
  if (method === "GET" && args.body !== undefined) {
    throw new UsageError("тело у GET не отправляется — убери body:");
  }
  // Допуск — до резолва и до чтения ключа: `call-ro` вне реестра не
  // узнаёт о ключе ничего (спека, «Инварианты»).
  access.admit({ method, ...aim }, writingLine(marketplace, args));
  const client = placeOf(args.selector, io);
  const keys = await keysOf(deps.openSession, client.target, marketplace, {
    clientId: client.clientId,
    aim,
    env: io.envFile,
  });
  const key = cabinetOf(keys, {
    cabinet: args.cabinet,
    client: args.selector,
    marketplace: marketplace.name,
  });
  const { url } = aim;
  const body = method === "POST" ? args.body ?? marketplace.emptyBody : null;
  // Тип тела — только у запроса с телом: у GET описывать нечего.
  const kind: Record<string, string> = body === null
    ? {}
    : { "content-type": "application/json" };
  if (args.dry) {
    return {
      kind: "dry",
      method,
      url,
      headers: { ...key.shown(), ...kind },
      body,
    };
  }
  const reply = await key.call(
    { method, url, headers: kind, body },
    (signed) =>
      send(signed, {
        seconds,
        stop: io.signal,
        net: deps,
        quotaHeaders: marketplace.quotaHeaders,
        mask: (text) => key.mask(text),
      }),
  );
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

/** Та же строка записью: `mpu ask <получатель> call <ключи вызова>`. */
function writingLine(marketplace: Marketplace, args: CallArgs): string {
  const given: readonly [string, string | number | undefined][] = [
    ["target", args.selector],
    ["cabinet", args.cabinet],
    [marketplace.address.key, args[marketplace.address.key]],
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

/** Ключи клиента: одна read-only сессия, закрытая при любом исходе. */
async function keysOf(
  open: OpenSession,
  target: PgTarget,
  marketplace: Marketplace,
  wanted: Wanted,
): Promise<readonly CabinetKey[]> {
  let session: SqlSession | undefined;
  try {
    session = await open(target);
    return await marketplace.keys(session, wanted);
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
