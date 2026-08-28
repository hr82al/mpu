/**
 * Общие части группы `mpu api wb-loader-*` (`docs/specs/api-wb-loader.md`):
 * закрытые списки загрузчиков и причин, две формы имени, резолв цели до
 * sid и сборка curl-сниппета для `--print`.
 *
 * Списки закрыты и живут здесь одни на все шесть команд: имя загрузчика
 * приходит в двух формах (camelCase в фильтрах, kebab-слаг в пути), и
 * вторая копия любого из списков разошлась бы с первой на следующем же
 * добавлении.
 */

import { UsageError } from "../command/mod.ts";
import {
  type CacheReader,
  type Candidate,
  isSidLike,
  searchCandidates,
  type ServerAddresses,
} from "../selector/mod.ts";

/**
 * 25 загрузчиков в порядке реестра (спека, «Загрузчики и причины»).
 * Порядок значим: он идёт в подсказку отказа, и алфавит там читался бы
 * хуже — оператор ищет соседа по смыслу, а не по букве.
 */
export const LOADERS = [
  "wbCards",
  "wbOrders",
  "wbSales",
  "wbReports",
  "wbAnalytics",
  "wbFeedbacks",
  "wbAdvertsDetailed",
  "wbSearchTexts",
  "wbSupplies",
  "wbAnalyticsStocks",
  "wbAcceptanceReports",
  "wbPrices",
  "wbPaidStorage",
  "wbSellerInfo",
  "wbAdvBudget",
  "wbFbsWarehouses",
  "wbFbsStocks",
  "wbAdvUpd",
  "wbAdvFullstats",
  "wbAdvNormqueryStats",
  "wbAdvNormqueryStatsByDates",
  "wbSearchClustersBids",
  "wbTariffsBox",
  "wbTariffsPallet",
  "wbTariffsCommissions",
] as const;

/** Причины, восстанавливающиеся сами: `resume` им не нужен. */
export const OPERATIONAL_REASONS = [
  "no_token",
  "cards_not_loaded",
  "cards_filter_not_ready",
  "adverts_detailed_not_loaded",
  "fbs_warehouses_not_loaded",
  "feature_disabled",
  "endpoint_forbidden",
] as const;

/** Причины, требующие ручного снятия. */
export const PERMANENT_REASONS = [
  "invalid_token",
  "payment_required",
  "response_parse_error",
  "dto_mapping_error",
  "db_write_error",
  "unexpected_http_status",
  "network_error",
  "paid_storage_recreate_limit",
  "not_using",
  "unknown_error",
] as const;

export const REASONS = [
  ...OPERATIONAL_REASONS,
  ...PERMANENT_REASONS,
] as const;

/**
 * Kebab-слаг имени: имя без префикса `wb`, слова через дефис в нижнем
 * регистре (`wbAdvFullstats` → `adv-fullstats`). Слаг — сегмент URL, а
 * camelCase — значение фильтра, и путать их нельзя: сервер поймёт не
 * ту сущность либо не поймёт вовсе.
 */
export function slugOf(loader: string): string {
  return loader
    .replace(/^wb/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/** Имя по слагу; такого слага нет — `undefined`. */
export function loaderOfSlug(slug: string): string | undefined {
  return LOADERS.find((name) => slugOf(name) === slug);
}

/**
 * Загрузчик в camelCase-форме (фильтры `blocked` и `resume`).
 * Перепутанная форма отбивается подсказкой с правильной: оператор
 * набрал существующую сущность не тем написанием, и список из
 * двадцати пяти имён ему сейчас не нужен.
 */
export function requireLoader(value: string): string {
  if ((LOADERS as readonly string[]).includes(value)) return value;
  const bySlug = loaderOfSlug(value);
  throw new UsageError(`неизвестный loader '${value}'`, {
    hint: bySlug === undefined
      ? `один из: ${LOADERS.join(", ")}`
      : `используй camelCase-имя: ${bySlug}`,
  });
}

/** Загрузчик в форме слага (сегмент пути `status`, `config`, `load`). */
export function requireSlug(value: string): string {
  if (loaderOfSlug(value) !== undefined) return value;
  if ((LOADERS as readonly string[]).includes(value)) {
    throw new UsageError(`неизвестный loader '${value}'`, {
      hint: `используй kebab-слаг: ${slugOf(value)}`,
    });
  }
  const slugs = LOADERS.map(slugOf).sort();
  throw new UsageError(`неизвестный loader '${value}'`, {
    hint: `один из: ${slugs.join(", ")}`,
  });
}

/** Причина блокировки из закрытого списка. */
export function requireReason(value: string): string {
  if ((REASONS as readonly string[]).includes(value)) return value;
  throw new UsageError(`неизвестный reason '${value}'`, {
    hint: `один из: ${REASONS.join(", ")}`,
  });
}

/** Цель вызова: sid и то, что удалось узнать про клиента. */
export interface LoaderTarget {
  readonly sid: string;
  /** Клиенты кабинета по кэшу; прямой режим без `--client-id` — пусто. */
  readonly clientIds: readonly number[];
  /** Прямой режим: кэш не открывался. */
  readonly direct: boolean;
}

/** Ввод резолва: селектор и уточнения. */
export interface TargetInput {
  readonly selector: string;
  readonly sid?: string;
  readonly clientId?: string;
}

/**
 * Прямой режим: sid задан флагом либо селектор сам им является. Кэш при
 * этом не нужен вовсе — загрузчику нужен sid, а не клиент, и требовать
 * наличия sid в кэше значило бы отказывать там, где кэш просто устарел.
 */
export function directTarget(input: TargetInput): LoaderTarget | undefined {
  const sid = input.sid ?? (isSidLike(input.selector) ? input.selector : null);
  if (sid === null) return undefined;
  const clientId = input.clientId === undefined
    ? []
    : [requireClientId(input.clientId)];
  return { sid, clientIds: clientId, direct: true };
}

/**
 * Резолв по локальному кэшу: клиент и его sid'ы. Названный селектором
 * sid побеждает; иначе годится единственный. Несколько — отказ со
 * списком: молчаливый выбор отправил бы команду чужому кабинету.
 */
export function cacheTarget(
  cache: CacheReader,
  env: ServerAddresses,
  input: TargetInput,
): LoaderTarget {
  const candidates = narrowByClient(
    searchCandidates({ cache, env }, input.selector),
    input.clientId,
  );
  const sids = [...new Set(candidates.flatMap((one) => one.sids))];
  if (sids.length === 0) {
    throw new UsageError("не удалось определить sid клиента (кэш пуст?)", {
      hint: "укажи --sid <sid> или обнови кэш: mpu update",
    });
  }
  const named = sids.find((sid) => sid === input.selector) ??
    onlyMatching(sids, input.selector);
  if (named === undefined && sids.length > 1) {
    throw new UsageError(
      `у клиента несколько WB sid (${sids.length})`,
      {
        hint: "укажи --sid <sid>",
        details: sids.map((sid) => `  --sid ${sid}`).join("\n"),
      },
    );
  }
  const sid = named ?? sids[0];
  return {
    sid,
    clientIds: clientIdsOf(candidates, sid),
    direct: false,
  };
}

/** Единственный sid, содержащий селектор подстрокой; иначе `undefined`. */
function onlyMatching(
  sids: readonly string[],
  selector: string,
): string | undefined {
  const matched = sids.filter((sid) => sid.includes(selector));
  return matched.length === 1 ? matched[0] : undefined;
}

/** Клиенты, у которых есть этот sid; порядок — по возрастанию номера. */
function clientIdsOf(
  candidates: readonly Candidate[],
  sid: string,
): readonly number[] {
  const ids = candidates
    .filter((one) => one.sids.includes(sid))
    .map((one) => one.clientId)
    .filter((id): id is number => id !== null);
  return [...new Set(ids)].sort((a, b) => a - b);
}

function narrowByClient(
  candidates: readonly Candidate[],
  clientId: string | undefined,
): readonly Candidate[] {
  if (clientId === undefined) return candidates;
  const wanted = requireClientId(clientId);
  return candidates.filter((one) => one.clientId === wanted);
}

function requireClientId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new UsageError(`--client-id: ожидается число, получено '${raw}'`);
  }
  return value;
}

/** Запрос, который команда собирается сделать. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/**
 * Curl-сниппет для `--print`. Токен не подставляется: строка уходит на
 * экран и в чужую переписку, а живой Bearer там не нужен никому — его
 * берёт `mpu api get-token` в первой строке, уже у читателя.
 */
export function curlSnippet(
  calls: Call | readonly Call[],
  extra: readonly string[] = [],
): string {
  // Вызовов может быть несколько: команда, делающая два запроса, обязана
  // напечатать оба — иначе оператор, скопировав вывод, сделает половину
  // операции и будет уверен, что сделал всё. Строка получения токена
  // при этом одна на весь сниппет: она не часть вызова, а подготовка.
  const list = Array.isArray(calls) ? calls : [calls as Call];
  const lines = ["TOKEN=$(mpu api get-token)"];
  for (const call of list) {
    lines.push(`curl -sS -X ${call.method} "$BASE_API_URL${call.path}" \\`);
    if (call.body === undefined) {
      lines.push('  -H "authorization: Bearer $TOKEN"');
      continue;
    }
    lines.push('  -H "authorization: Bearer $TOKEN" \\');
    lines.push("  -H 'content-type: application/json' \\");
    lines.push(`  -d '${JSON.stringify(call.body)}'`);
  }
  return [...lines, ...extra].join("\n") + "\n";
}

/** Путь загрузчика: подстановки экранируются, как везде в `api`. */
export function loaderPath(sid: string, slug: string, tail: string): string {
  return `/admin/wb-loader/loaders/${encodeURIComponent(sid)}/` +
    `${encodeURIComponent(slug)}/v1/${tail}`;
}

/** Сборка состояния окна из `--from`. */
export const STATE_FROM_SHIFT_DAYS = 1;

/**
 * Состояние для `--from`: дата **на день раньше** указанной. Загрузчик
 * идёт вперёд по дате и начинает со следующего дня после сохранённого,
 * поэтому «с 5-го» означает сохранить 4-е — иначе прогон начнётся с
 * 6-го и пропустит день, который просили.
 */
export function stateFromDate(date: string): Record<string, unknown> {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (parsed === null) {
    throw new UsageError(
      `--from: ожидается дата YYYY-MM-DD, получено '${date}'`,
    );
  }
  const at = Date.UTC(
    Number(parsed[1]),
    Number(parsed[2]) - 1,
    Number(parsed[3]),
  );
  const shifted = new Date(at - STATE_FROM_SHIFT_DAYS * 86_400_000);
  return { lastLoadedDate: shifted.toISOString().slice(0, 10) };
}
