/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): заметка
 * или уведомление себе через личного бота.
 *
 * Здесь только склейка: конфигурация — `bot_config.ts`, отправка —
 * `bot.ts`. Сеанс MTProto не открывается: у канала другой протокол, и
 * в этом весь смысл команды — чат с ботом недостижим для `ls` и
 * `search`, а текст не попадает в журнал (пометка `logsArguments`).
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { readAttachment } from "./attachment.ts";
import { type BotMessage, sendBotMessage } from "./bot.ts";
import { botConfig } from "./bot_config.ts";
import { inputError } from "./errors.ts";

const argsSchema = z.object({
  message: z.string({ error: "нужен MESSAGE: текст заметки либо '-'" })
    .describe("текст заметки; '-' — весь stdin, только в CLI"),
  file: z.string().optional().describe(
    "вложение: путь к файлу; ровно один, флаг не повторяется",
  ),
});

const resultSchema = z.object({
  id: z.number().describe("номер отправленного сообщения"),
});

type LogArgs = z.infer<typeof argsSchema>;
type LogResult = z.infer<typeof resultSchema>;

/** Срез порта: только чтение stdin, вложения и ключи env-файла. */
type LogIo = Pick<CommandIo, "readStdin" | "readRegularFile" | "envFile">;

/**
 * Предел длины подписи документа у Bot API; у текста сообщения он свой и
 * вчетверо шире, поэтому проверка живёт только на ветке с файлом.
 *
 * Единица счёта — UTF-16 (`string.length`): чем меряет сам Telegram, не
 * проверено, а UTF-16 — граница консервативная (для всего BMP совпадает
 * с кодовыми точками и расходится только на emoji и прочем astral) и
 * ошибается в сторону понятного отказа до сети, а не невнятного после.
 */
export const CAPTION_LIMIT = 1024;

/**
 * Разбор ввода в сообщение бота: текст либо документ с подписью.
 * Вынесено из `run`, чтобы проверяться без сети — отбитый вызов не стоит
 * ни одного обращения наружу.
 */
export async function logMessage(
  args: LogArgs,
  io: Pick<CommandIo, "readStdin" | "readRegularFile">,
): Promise<BotMessage> {
  const text = args.message === "-"
    ? new TextDecoder().decode(await io.readStdin())
    : args.message;
  if (args.file === undefined) {
    if (text.trim() === "") throw inputError("нужен непустой MESSAGE");
    return { kind: "text", text };
  }
  // Пустой текст с вложением означает документ без подписи; пустой —
  // и текст из одних пробелов: подписью он быть не может, а раз так, то
  // и уходить в Telegram ему незачем (то же правило у `send`).
  const caption = text.trim() === "" ? "" : text;
  assertCaptionFits(caption);
  return {
    kind: "document",
    caption,
    file: await readAttachment(io, args.file),
  };
}

/**
 * Отказ до сети, а не после: предел подписи Telegram проверяет и сам, но
 * его отказ — код 400 с невнятным описанием, и приходит он, когда вызов
 * уже сделан.
 */
function assertCaptionFits(caption: string): void {
  if (caption.length <= CAPTION_LIMIT) return;
  throw inputError(
    `подпись длиннее предела Bot API: ${caption.length} символов, ` +
      `можно ${CAPTION_LIMIT}`,
  );
}

/** Весь ввод и конфигурация — до сети; сеанс MTProto не открывается. */
async function runTelegramLog(args: LogArgs, io: LogIo): Promise<LogResult> {
  const message = await logMessage(args, io);
  const config = botConfig(io.envFile);
  const sent = await sendBotMessage(config, message);
  return { id: sent.id };
}

export const telegramLogCommand = defineCommand({
  path: ["telegram", "log"],
  errorName: "telegram log",
  summary: "Отправить заметку себе в личного бота.",
  usage: "mpu telegram log MESSAGE [-f PATH]",
  help: `MESSAGE — текст заметки; '-' означает весь stdin и работает
только в CLI: у вызова тула stdin нет. Пустой текст — ошибка ввода,
кроме случая с -f.

-f/--file PATH — вложение, ровно одно: флаг не повторяется. Файл уходит
документом под своим именем, текст становится его подписью, отдельного
сообщения рядом нет. Подпись длиннее 1024 символов — ошибка ввода до
сети (у текста без файла предел 4096).

Шлёт бот (Bot API), а не твой аккаунт: чат с ботом не виден mpu
telegram ls и search, а заметка не попадает в журнал вызовов — в записи
она заменена на REDACTED.

Адресат единственный, из TELEGRAM_BOT_ID; опции выбора чата нет
намеренно: динамический адресат мог бы увести заметку постороннему,
написавшему боту.

stdout — одна строка JSON: {"id": …}.

Ключи env-файла: TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_ID (обязательны),
TELEGRAM_BOT_NAME (необязателен, идёт в подсказку при отказе). Ключи
сеанса MTProto команде не нужны.

Прокси — TELEGRAM_PROXY, иначе HTTPS_PROXY, иначе https_proxy. Схемы:
http, https, socks5, socks5h; socks4 не принимается (у mpu telegram send
через MTProto — работает).

Exit: 0 — успех; 1 — конфигурация или отказ Bot API; 2 — ошибка ввода.

Пример: mpu telegram log 'разбор за среду' -f /tmp/разбор.md`,
  policy: "rw",
  logsArguments: false,
  argsSchema,
  forms: {
    message: { positional: "one" },
    // Повтор флага — ошибка, а не «последний побеждает»: sendDocument
    // несёт ровно один документ, и молча потерять второй файл нельзя.
    file: { short: "f", once: true },
  },
  resultSchema,
  run: runTelegramLog,
  render: (result: LogResult) => `{"id": ${result.id}}\n`,
});
