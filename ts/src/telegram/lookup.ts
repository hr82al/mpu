/**
 * Поиск чата по названию (`docs/specs/telegram-ls.md`, «Резолв по
 * названию») — та часть резолва, которую платформенный слой оставил
 * подкоманде `ls`, потому что без серверного поиска она не решается.
 *
 * Живёт отдельно от команды `ls`: `ls` — её поверхность, а пользуются
 * ею `send` и будущие `status` и `search`. Отсюда и узкий интерфейс
 * потребителя: нужен только поиск, не весь клиент.
 */

import { dedupeById, type Dialog, dialogOf, type RawChat } from "./chat.ts";
import { configError, telegramOperation } from "./errors.ts";

/** Что нужно поиску от клиента: один серверный запрос. */
export interface ChatSearch {
  readonly searchChats: (
    query: string,
    limit: number,
  ) => Promise<readonly RawChat[]>;
}

/**
 * Предел выдачи поиска. Тот же, что у `ls` по умолчанию: канонические
 * адресаты — id и имя пользователя, а название чата — удобство
 * (там же, «Известные отклонения», вердикт preserve).
 */
const CANDIDATES = 50;

/**
 * Ищет чат по названию. `subject` называет предмет поиска в отказе:
 * «чат» для адресата, «отправителя» для фильтра по автору.
 */
export async function findChatByTitle(
  client: ChatSearch,
  title: string,
  subject: string,
  /**
   * Отказ предыдущей попытки резолва, если она была: наружу он не
   * показывается — пользователю нужен итог, — но в цепочке `cause`
   * остаётся, иначе первопричина теряется совсем.
   */
  cause?: unknown,
): Promise<Dialog> {
  const found = dedupeById((await search(client, title)).map(dialogOf));
  const matches = pick(found, title);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw notFound(title, subject, cause);
  throw ambiguous(title, matches, cause);
}

/**
 * Сам запрос к Telegram. Его отказ — отказ Telegram, а не «чат не
 * найден»: срок ожидания при rate-limit иначе теряется.
 */
function search(
  client: ChatSearch,
  title: string,
): Promise<readonly RawChat[]> {
  return telegramOperation(() => client.searchChats(title, CANDIDATES));
}

/**
 * Кандидаты по названию: точные совпадения старше подстрочных, регистр
 * не учитывается. Порядок внутри группы — порядок выдачи сервера.
 */
function pick(found: readonly Dialog[], title: string): readonly Dialog[] {
  const needle = title.toLowerCase();
  const exact = found.filter((chat) => chat.title.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  return found.filter((chat) => chat.title.toLowerCase().includes(needle));
}

function ambiguous(
  title: string,
  matches: readonly Dialog[],
  cause?: unknown,
): Error {
  const listed = matches
    .map((chat) => `'${chat.title}' → id ${chat.id}`)
    .join("; ");
  return configError(
    `под название '${title}' подходит несколько чатов: ${listed}; ` +
      "попробуй: указать адресата по id или @username",
    { cause },
  );
}

function notFound(title: string, subject: string, cause?: unknown): Error {
  return configError(
    `не удалось найти ${subject} '${title}': совпадений нет; ` +
      `попробуй: mpu telegram ls '${title}' и укажи id или @username`,
    { cause },
  );
}
