/**
 * Поиск сообщений по содержимому (`docs/specs/telegram-search.md`,
 * «Ввод/вывод»): два режима, различаются наличием `--chat`.
 *
 * Клиент объявлен узким интерфейсом потребителя: выбор режима, фильтр
 * по отправителю и потолок скана проверяются без сети.
 */

import type { PeerRef } from "./client.ts";
import { telegramOperation } from "./errors.ts";
import {
  type FoundMessage,
  foundMessage,
  type RawMessage,
  senderId,
} from "./message.ts";
import { type PeerResolver, resolveTarget } from "./resolve.ts";
import type { SearchPlan } from "./search_plan.ts";

/**
 * Потолок клиентского фильтра. Фильтра по отправителю у глобального
 * поиска Telegram нет, а без потолка вызов с редким отправителем
 * вычерпывал бы выдачу неограниченно (там же, «Известные отклонения»,
 * вердикт preserve).
 */
export const SCAN_CAP = 1000;

/** Предупреждение об остановке скана; печатается в stderr при exit 0. */
export const SCAN_CAP_WARNING =
  `telegram: скан остановлен на ${SCAN_CAP} сообщениях; ` +
  "более старые совпадения не показаны";

/** Запрос поиска внутри чата: адресаты уже опознаны клиентом. */
export interface SearchInChat {
  readonly chat: PeerRef;
  readonly query: string;
  /** Серверный фильтр по отправителю; без фильтра — `null`. */
  readonly from: PeerRef | null;
  readonly limit: number;
}

/** Что нужно поиску от клиента поверх резолва адресата. */
export interface SearchClient extends PeerResolver {
  /** Поиск внутри чата: и текст, и отправитель — фильтры сервера. */
  readonly searchInChat: (
    params: SearchInChat,
  ) => Promise<readonly RawMessage[]>;
  /**
   * Глобальный поиск, от новых сообщений к старым. Страницы гоняет
   * клиент, а сколько их просмотреть — решает вызывающий: фильтра по
   * отправителю у этого поиска нет.
   */
  readonly searchGlobal: (query: string) => AsyncIterable<RawMessage>;
}

/** Найденное и признак того, что просмотр оборвал потолок. */
export interface SearchOutcome {
  readonly messages: readonly FoundMessage[];
  /** Скан остановлен потолком, а не концом выдачи. */
  readonly scanCapped: boolean;
}

/** Ищет сообщения: внутри чата при заданном `--chat`, иначе глобально. */
export async function findMessages(
  client: SearchClient,
  plan: SearchPlan,
): Promise<SearchOutcome> {
  if (plan.chat !== null) return await inChat(client, plan, plan.chat);
  if (plan.from === null) {
    const found = await telegramOperation(() =>
      take(client.searchGlobal(plan.query), plan.limit)
    );
    return { messages: found.map(foundMessage), scanCapped: false };
  }
  const sender = await resolveTarget(
    client,
    plan.from.target,
    plan.from.peer,
    "отправителя",
  );
  return await telegramOperation(() => scan(client, plan, sender.id));
}

/** Поиск внутри чата: оба фильтра серверные, потолка просмотра нет. */
async function inChat(
  client: SearchClient,
  plan: SearchPlan,
  chat: NonNullable<SearchPlan["chat"]>,
): Promise<SearchOutcome> {
  const peer = await resolveTarget(client, chat.target, chat.peer, "чат");
  const from = plan.from === null ? null : await resolveTarget(
    client,
    plan.from.target,
    plan.from.peer,
    "отправителя",
  );
  const found = await telegramOperation(() =>
    client.searchInChat({
      chat: peer,
      query: plan.query,
      from,
      limit: plan.limit,
    })
  );
  return { messages: found.map(foundMessage), scanCapped: false };
}

/**
 * Глобальная выдача под клиентским фильтром: просмотр идёт по порядку и
 * прекращается на `--limit` совпадений либо на потолке просмотренных.
 */
async function scan(
  client: SearchClient,
  plan: SearchPlan,
  sender: number,
): Promise<SearchOutcome> {
  const messages: FoundMessage[] = [];
  let scanned = 0;
  for await (const raw of client.searchGlobal(plan.query)) {
    scanned += 1;
    if (senderId(raw) === sender) messages.push(foundMessage(raw));
    if (messages.length === plan.limit) return { messages, scanCapped: false };
    // Потолок сообщается только при недоборе: набравший `--limit` вызов
    // ничего не потерял, и предупреждать не о чем.
    if (scanned === SCAN_CAP) return { messages, scanCapped: true };
  }
  return { messages, scanCapped: false };
}

/** Первые `limit` элементов: остальное у выдачи не запрашивается. */
async function take(
  found: AsyncIterable<RawMessage>,
  limit: number,
): Promise<readonly RawMessage[]> {
  const taken: RawMessage[] = [];
  for await (const message of found) {
    taken.push(message);
    if (taken.length === limit) break;
  }
  return taken;
}
