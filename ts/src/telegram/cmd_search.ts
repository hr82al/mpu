/**
 * Команда `mpu telegram search` (`docs/specs/telegram-search.md`): поиск
 * сообщений по содержимому — по всем диалогам или внутри одного чата.
 *
 * Как и у соседей, живой клиент подгружается лениво и только после того,
 * как ввод принят: запрещённые сочетания аргументов видны без сети.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { telegramConfig } from "./config.ts";
import { findMessages, SCAN_CAP, SCAN_CAP_WARNING } from "./search.ts";
import { LIMIT_MAX, LIMIT_MIN, searchPlan } from "./search_plan.ts";
import { renderMessagesJson, renderMessagesTable } from "./search_view.ts";

const argsSchema = z.object({
  query: z.string().default("").describe(
    "что искать в тексте сообщений; пустой запрос допустим только с --chat",
  ),
  chat: z.string().default("").describe(
    "искать только в этом чате: id, @username, ссылка t.me, название, me",
  ),
  from: z.string().default("").describe(
    "оставить только сообщения этого отправителя",
  ),
  // Значение приходит из argv строкой; разбирает его команда, а не
  // схема: спека требует отказ ровно одной строкой, а отказ схемы несёт
  // хвост-подсказку «попробуй: … --help» (`telegram-search.md`,
  // «Граничные случаи»). В отказе показывается исходная строка.
  limit: z.string().default("50").describe(
    `сколько сообщений в выдаче, ${LIMIT_MIN}..${LIMIT_MAX}`,
  ),
  table: z.boolean().default(false).describe("таблица вместо JSON"),
});

const messageSchema = z.object({
  id: z.number().describe("id сообщения внутри его чата"),
  chat_id: z.number().describe(
    "маркированный id чата сообщения; пригоден как --chat без правки",
  ),
  chat_title: z.string().describe(
    "название чата: отображаемое имя у пользователя и бота, название у группы и канала; не пришло — пустая строка",
  ),
  sender: z.string().nullable().describe(
    "отображаемое имя отправителя; Telegram его не отдал — null",
  ),
  date: z.string().nullable().describe(
    "время отправки в UTC, ISO-8601 без долей секунды; времени нет — null",
  ),
  text: z.string().describe(
    "текст сообщения либо подпись вложения; ни того ни другого — пустая строка",
  ),
  link: z.string().nullable().describe(
    "ссылка на сообщение у супергруппы и канала; у прочих чатов — null",
  ),
});

const resultSchema = z.object({
  messages: z.array(messageSchema).describe(
    "найденные сообщения в порядке выдачи сервера: от новых к старым",
  ),
  table: z.boolean().describe("печатать ли таблицу вместо JSON"),
});

type TelegramSearchArgs = z.infer<typeof argsSchema>;
type TelegramSearchResult = z.infer<typeof resultSchema>;

/** Срез порта: ключи env-файла и строка предупреждения. */
type SearchIo = Pick<CommandIo, "envFile" | "progress">;

/**
 * Один вызов — один сеанс, он закрывается в любом исходе. Режим выбирает
 * `--chat`: с ним — поиск внутри чата, без него — глобальный.
 */
async function runTelegramSearch(
  args: TelegramSearchArgs,
  io: SearchIo,
): Promise<TelegramSearchResult> {
  const plan = searchPlan(args);
  const config = telegramConfig(io.envFile);
  const { openSession } = await import("./session.ts");
  const session = await openSession(config);
  try {
    const found = await findMessages(session, plan);
    // Оборванный потолком скан молчал бы: выдача короче `--limit`
    // неотличима от «совпадений больше нет» (там же, «Известные
    // отклонения», вердикт fix).
    if (found.scanCapped) io.progress(SCAN_CAP_WARNING);
    // Схема результата объявляет массив изменяемым (её выводит zod), а
    // поиск отдаёт readonly — копия здесь дешевле, чем ослабление типа.
    return { messages: [...found.messages], table: args.table };
  } finally {
    // Отказ закрытия глушится: соединение уходит вместе с процессом, а
    // бросок отсюда подменил бы собой отказ самого чтения.
    await session.close().catch(() => {});
  }
}

export const telegramSearchCommand = defineCommand({
  path: ["telegram", "search"],
  errorName: "telegram search",
  summary: "Найти сообщения по содержимому: везде или в одном чате.",
  usage:
    "mpu telegram search [QUERY] [--chat X] [--from Y] [--limit N] [--table]",
  help: `QUERY — что искать в тексте сообщений. Пустой запрос допустим
только вместе с --chat: это история чата без текстового фильтра.
Запрос из одних пробелов — обычный запрос, а не пустота.

--chat X — искать только в этом чате: id, @username, ссылка t.me,
название чата или me (Избранное). Без него поиск идёт по всем диалогам.
--from Y — оставить только сообщения этого отправителя, тем же видом
адресата. Без --chat фильтр применяется на стороне команды: у
глобального поиска Telegram фильтра по отправителю нет, поэтому выдача
просматривается до ${SCAN_CAP} сообщений, и при остановке на потолке в
stderr уходит предупреждение.
--limit N — сколько сообщений в выдаче, ${LIMIT_MIN}..${LIMIT_MAX}, по
умолчанию 50. Ограничивает выдачу, а не число просмотренных.
--table — таблица колонками DATE, CHAT, SENDER, TEXT вместо JSON.

Вывод по умолчанию — массив JSON: id, chat_id, chat_title, sender, date,
text, link. Напечатанный chat_id — маркированный: его можно без правки
передать в --chat. Ничего не найдено — пустой массив и код 0.

Адресата по умолчанию команда не берёт: TELEGRAM_DEFAULT_CHAT здесь не
читается.

Ключи env-файла: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
(обязательны), TELEGRAM_PROXY.

Exit: 0 — успех, в том числе пустая выдача; 1 — конфигурация, отказ
Telegram или ненайденный адресат; 2 — ошибка ввода (--limit вне
диапазона, пустой глобальный поиск, --from без --chat и без запроса).

Примеры: mpu telegram search 'выгрузка' --chat me
mpu telegram search --chat 'Команда' --from @ivan --limit 20 --table`,
  policy: "ro",
  argsSchema,
  forms: { query: { positional: "one" } },
  resultSchema,
  run: runTelegramSearch,
  render: (result) =>
    result.table
      ? renderMessagesTable(result.messages)
      : renderMessagesJson(result.messages),
});
