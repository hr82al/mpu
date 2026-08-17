/**
 * Команда `mpu telegram send` (`docs/specs/telegram-send.md`): текст,
 * файлы или файлы с подписью от имени личного аккаунта.
 *
 * Здесь только склейка: разбор ввода — `plan.ts`, порядок шагов
 * отправки — `send.ts`, конфигурация — `config.ts`, живой клиент
 * MTProto — `session.ts`, и он подгружается лениво, уже после того как
 * ввод принят: старт `mpu` не должен платить за крипту MTProto на каждой
 * команде.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { telegramConfig } from "./config.ts";
import { type PlanIo, type SendArgs, sendPlan } from "./plan.ts";
import { sendMessage } from "./send.ts";
import { renderSent } from "./send_view.ts";

const argsSchema = z.object({
  message: z.string({ error: "нужен MESSAGE: текст сообщения либо '-'" })
    .describe("текст сообщения; '-' — весь stdin"),
  chat: z.string().optional().describe(
    "адресат: me, id, @username, ссылка t.me, телефон или название чата",
  ),
  md: z.boolean().default(false).describe(
    "текст и подпись размечены Markdown",
  ),
  file: z.array(z.string()).default([]).describe(
    "вложение: путь к файлу; флаг повторяется",
  ),
});

const resultSchema = z.object({
  id: z.number().describe(
    "номер отправленного сообщения; при альбоме — последнего из них",
  ),
  chat_id: z.number().describe(
    "маркированный id чата, в который легло сообщение",
  ),
  date: z.string().nullable().describe(
    "время отправки по данным Telegram, ISO-8601; не сообщено — null",
  ),
});

/** Результат вызова: ключи и их порядок — контракт вывода. */
type TelegramSendResult = z.infer<typeof resultSchema>;

/** Срез порта: ввод плана и ключи env-файла. */
type SendIo = PlanIo & Pick<CommandIo, "envFile">;

/**
 * Порядок шагов: весь ввод и конфигурация — до сети; один вызов — один
 * сеанс, и он закрывается в любом исходе
 * (`platform/telegram-mtproto.md`, «Инварианты»).
 */
async function runTelegramSend(
  args: SendArgs,
  io: SendIo,
): Promise<TelegramSendResult> {
  const plan = await sendPlan(
    args,
    io,
    io.envFile.get("TELEGRAM_DEFAULT_CHAT"),
  );
  const config = telegramConfig(io.envFile);
  const { openSession } = await import("./session.ts");
  const session = await openSession(config);
  try {
    const sent = await sendMessage(session, plan);
    return { id: sent.id, chat_id: sent.chatId, date: sent.date };
  } finally {
    // Отказ закрытия глушится намеренно: соединение всё равно уходит
    // вместе с процессом, а бросок отсюда подменил бы собой отказ самой
    // отправки — единственное, что важно знать вызывающему.
    await session.close().catch(() => {});
  }
}

export const telegramSendCommand = defineCommand({
  path: ["telegram", "send"],
  errorName: "telegram send",
  summary: "Отправить сообщение от имени личного аккаунта.",
  usage: "mpu telegram send MESSAGE [--chat X] [--md] [-f PATH]...",
  help: `MESSAGE — текст сообщения; '-' означает весь stdin. Пустая строка
допустима только вместе с -f.

--chat X — адресат: me («Избранное»), id, @username, ссылка t.me,
телефон или название чата. Название ищется поиском, как mpu telegram ls:
точное совпадение старше подстрочного, один подходящий чат — он и
адресат, несколько — отказ со списком. Не задан — берётся
TELEGRAM_DEFAULT_CHAT.

--md — текст и подпись размечены Markdown: [текст](url) становится
ссылкой, **жирный** — жирным. Без флага разметка остаётся видимой.

-f/--file PATH — вложение (флаг повторяется, порядок сохраняется). Файлы
уходят документами без превью, под своими именами; несколько — одним
альбомом. Непустой текст становится подписью к последнему вложению,
отдельного сообщения рядом с файлами не отправляется.

Отправка необратима и уходит от твоего имени; для проверок бери me.

stdout — одна строка JSON: {"id": …, "chat_id": …, "date": …}.

Ключи env-файла: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
(обязательны, пишет mpu init), TELEGRAM_DEFAULT_CHAT, TELEGRAM_PROXY.

Exit: 0 — успех; 1 — конфигурация или отказ Telegram; 2 — ошибка ввода.

Пример: mpu telegram send 'готово' --chat me -f /tmp/report.xlsx`,
  policy: "rw",
  argsSchema,
  forms: {
    message: { positional: "one" },
    file: { short: "f" },
  },
  resultSchema,
  run: runTelegramSend,
  render: renderSent,
});
