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
import { sendBotMessage } from "./bot.ts";
import { botConfig } from "./bot_config.ts";
import { inputError } from "./errors.ts";

const argsSchema = z.object({
  message: z.string({ error: "нужен MESSAGE: текст заметки либо '-'" })
    .describe("текст заметки; '-' — весь stdin, только в CLI"),
});

const resultSchema = z.object({
  id: z.number().describe("номер отправленного сообщения"),
});

type LogArgs = z.infer<typeof argsSchema>;
type LogResult = z.infer<typeof resultSchema>;

/** Срез порта: только чтение stdin и ключи env-файла. */
type LogIo = Pick<CommandIo, "readStdin" | "envFile">;

/**
 * Текст сообщения: аргумент либо весь stdin. Вынесено из `run`, чтобы
 * разбор ввода проверялся без сети.
 */
export async function logText(
  args: LogArgs,
  io: Pick<CommandIo, "readStdin">,
): Promise<string> {
  const text = args.message === "-"
    ? new TextDecoder().decode(await io.readStdin())
    : args.message;
  if (text.trim() === "") throw inputError("нужен непустой MESSAGE");
  return text;
}

/** Весь ввод и конфигурация — до сети; сеанс MTProto не открывается. */
async function runTelegramLog(args: LogArgs, io: LogIo): Promise<LogResult> {
  const text = await logText(args, io);
  const config = botConfig(io.envFile);
  const sent = await sendBotMessage(config, text);
  return { id: sent.id };
}

export const telegramLogCommand = defineCommand({
  path: ["telegram", "log"],
  errorName: "telegram log",
  summary: "Отправить заметку себе в личного бота.",
  usage: "mpu telegram log MESSAGE",
  help: `MESSAGE — текст заметки; '-' означает весь stdin и работает
только в CLI: у вызова тула stdin нет. Пустой текст — ошибка ввода.

Отправка идёт от имени бота (Bot API), а не от твоего аккаунта. Отсюда
два следствия, ради которых команда и заведена: чат с ботом не виден
командам mpu telegram ls и mpu telegram search, а текст заметки не
попадает в журнал вызовов — в записи он заменён на REDACTED.

Адресат единственный и берётся из TELEGRAM_BOT_ID; опции выбора чата
нет намеренно: динамический адресат означал бы, что сообщение может
уйти постороннему, написавшему боту.

stdout — одна строка JSON: {"id": …}.

Ключи env-файла: TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_ID (обязательны),
TELEGRAM_BOT_NAME (необязателен, попадает в подсказку при отказе).
Ключи сеанса MTProto команде не нужны.

Exit: 0 — успех; 1 — конфигурация или отказ Bot API; 2 — ошибка ввода.

Пример: mpu telegram log 'деплой упал, посмотреть утром'`,
  policy: "rw",
  logsArguments: false,
  argsSchema,
  forms: {
    message: { positional: "one" },
  },
  resultSchema,
  run: runTelegramLog,
  render: (result: LogResult) => `{"id": ${result.id}}\n`,
});
