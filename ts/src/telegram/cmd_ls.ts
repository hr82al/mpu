/**
 * Команда `mpu telegram ls` (`docs/specs/telegram-ls.md`): последние
 * диалоги или серверный поиск — чтобы найти адресата для других
 * подкоманд.
 *
 * Как и `send`, живой клиент подгружается лениво и только после того,
 * как ввод принят.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { dedupeById, dialogOf } from "./chat.ts";
import { telegramOperation } from "./errors.ts";
import { telegramConfig } from "./config.ts";
import { renderDialogsJson, renderDialogsTable } from "./ls_view.ts";

const LIMIT_MIN = 1;
const LIMIT_MAX = 500;

const argsSchema = z.object({
  query: z.string().default("").describe(
    "что искать; без запроса — последние диалоги",
  ),
  // Значение приходит из argv строкой; разбирает его команда, а не
  // схема: спека требует отказ ровно одной строкой, а отказ схемы несёт
  // хвост-подсказку «попробуй: … --help» (`telegram-ls.md`, «Граничные
  // случаи»). В отказе показывается исходная строка — «много», не NaN.
  limit: z.string().default("50").describe(
    `сколько записей, ${LIMIT_MIN}..${LIMIT_MAX}`,
  ),
  table: z.boolean().default(false).describe("таблица вместо JSON"),
});

const dialogSchema = z.object({
  id: z.number().describe(
    "маркированный id чата; пригоден как адресат других подкоманд",
  ),
  title: z.string().describe(
    "название чата: отображаемое имя у пользователя и бота, название у группы и канала",
  ),
  kind: z.enum(["user", "bot", "group", "channel", "unknown"]).describe(
    "вид чата",
  ),
  username: z.string().nullable().describe(
    "имя пользователя без «@»; у чата без имени — null",
  ),
});

const resultSchema = z.object({
  dialogs: z.array(dialogSchema).describe(
    "найденные чаты в порядке выдачи сервера, с дедупом по id",
  ),
  table: z.boolean().describe("печатать ли таблицу вместо JSON"),
});

type TelegramLsArgs = z.infer<typeof argsSchema>;
type TelegramLsResult = z.infer<typeof resultSchema>;

/** Срез порта: команде нужны только ключи env-файла. */
type LsIo = Pick<CommandIo, "envFile">;

/**
 * Один вызов — один сеанс, он закрывается в любом исходе. Пустой запрос
 * означает последние диалоги, непустой — серверный поиск; пробелы
 * запросом считаются (`telegram-ls.md`, «Граничные случаи»).
 */
async function runTelegramLs(
  args: TelegramLsArgs,
  io: LsIo,
): Promise<TelegramLsResult> {
  const limit = parseLimit(args.limit);
  const config = telegramConfig(io.envFile);
  const { openSession } = await import("./session.ts");
  const session = await openSession(config);
  try {
    // Отказ Telegram оформляется на границе команды: в `session.ts`,
    // где живёт протокол, тестов нет, а здесь ветка проверяема.
    const found = await telegramOperation(() =>
      args.query === ""
        ? session.listDialogs(limit)
        : session.searchChats(args.query, limit)
    );
    return {
      // Схема результата объявляет массив изменяемым (её выводит zod), а
      // дедуп отдаёт readonly — копия здесь дешевле, чем ослабление типа.
      dialogs: [...dedupeById(found.map(dialogOf))],
      table: args.table,
    };
  } finally {
    // Отказ закрытия глушится: соединение уходит вместе с процессом, а
    // бросок отсюда подменил бы собой отказ самого чтения.
    await session.close().catch(() => {});
  }
}

/** Число записей: целое в объявленном диапазоне, иначе отказ ввода. */
function parseLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) {
    throw new UsageError(
      `--limit вне диапазона ${LIMIT_MIN}..${LIMIT_MAX}: ${raw}`,
    );
  }
  return value;
}

export const telegramLsCommand = defineCommand({
  path: ["telegram", "ls"],
  errorName: "telegram ls",
  summary: "Найти адресата: последние диалоги или поиск по названию.",
  usage: "mpu telegram ls [QUERY] [--limit N] [--table]",
  help: `QUERY — что искать. Без запроса печатаются последние диалоги, с
запросом идёт серверный поиск по контактам и глобальному каталогу.
Запрос из одних пробелов — обычный запрос, а не пустота.

--limit N — сколько записей, ${LIMIT_MIN}..${LIMIT_MAX}, по умолчанию 50.
--table — таблица колонками ID, KIND, USERNAME, TITLE вместо JSON.

Вывод по умолчанию — массив JSON: id, title, kind (user|bot|group|
channel|unknown), username. Напечатанный id — маркированный: его можно
без правки передать в --chat других подкоманд.

Адресата команда не принимает: TELEGRAM_DEFAULT_CHAT здесь не читается.

Ключи env-файла: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
(обязательны), TELEGRAM_PROXY.

Exit: 0 — успех, в том числе пустая выдача; 1 — конфигурация или отказ
Telegram; 2 — ошибка ввода (--limit вне диапазона).

Пример: mpu telegram ls 'Команда релиза' --table`,
  policy: "ro",
  argsSchema,
  forms: { query: { positional: "one" } },
  resultSchema,
  run: runTelegramLs,
  render: (result) =>
    result.table
      ? renderDialogsTable(result.dialogs)
      : renderDialogsJson(result.dialogs),
});
