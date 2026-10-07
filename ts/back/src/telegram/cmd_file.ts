/**
 * Команда `mpu telegram file` (`docs/specs/telegram-file.md`): вложение
 * одного сообщения — в локальный файл.
 *
 * Ввод разбирается до сети; живой клиент подгружается лениво, как у
 * соседей. Что считать файлом и как его назвать, решает вложение
 * (`message_file.ts`), куда и как писать — каталог (`inbox.ts`).
 */

import { z } from "zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import type { PeerRef } from "./client.ts";
import { telegramConfig } from "./config.ts";
import { Inbox, INBOX_DIR } from "./inbox.ts";
import type { MessageFile, SavedFile } from "./message_file.ts";
import { parsePeer } from "./peer.ts";
import { filePicture } from "../picture/mod.ts";
import { type PeerResolver, resolveTarget } from "./resolve.ts";

const argsSchema = z.object({
  chat: z.string().describe(
    "чат сообщения: chat_id из выдачи telegram search, @username, ссылка " +
      "t.me, название или me",
  ),
  // Строкой, а не числом: отказ — текстом спеки, с исходным значением.
  id: z.string().describe("id сообщения внутри чата, целое > 0"),
});

const resultSchema = z.object({
  path: z.string().describe("абсолютный путь записанного файла"),
  name: z.string().describe("имя вложения до замены / и NUL"),
  size: z.number().describe("число байт, записанных в файл"),
  mime: z.string().nullable().describe("MIME-тип; не задан — null"),
});

type TelegramFileArgs = z.infer<typeof argsSchema>;

/** Что нужно команде от клиента поверх резолва адресата. */
export interface FileClient extends PeerResolver {
  /** Вложение сообщения; сообщения нет — объект, отвечающий отказом. */
  readonly messageFile: (chat: PeerRef, id: number) => Promise<MessageFile>;
}

/** Сеанс, каким его видит команда: клиент плюс закрытие. */
export type FileSession = FileClient & { readonly close: () => Promise<void> };

/**
 * Подстановка сеанса и каталога: умолчания — настоящий MTProto (лениво)
 * и `/tmp/mpu-telegram`; прогону подставляют фейк и временный каталог.
 */
export interface FileOptions {
  readonly openSession?: () => Promise<FileSession>;
  readonly dir?: string;
}

/** Один вызов — один сеанс; закрывается в любом исходе. */
export async function runTelegramFile(
  args: TelegramFileArgs,
  io: Pick<CommandIo, "envFile">,
  options: FileOptions = {},
): Promise<SavedFile> {
  const id = messageId(args.id);
  const peer = parsePeer(args.chat);
  const open = options.openSession ?? (async () => {
    const config = telegramConfig(io.envFile);
    const { openSession } = await import("./session.ts");
    return await openSession(config);
  });
  const session = await open();
  try {
    const chat = await resolveTarget(session, args.chat, peer, "чат");
    const file = await session.messageFile(chat, id);
    return await file.saveTo(new Inbox(options.dir ?? INBOX_DIR), chat.id);
  } finally {
    // Отказ закрытия глушится: соединение уходит вместе с процессом, а
    // бросок отсюда подменил бы собой отказ самого скачивания.
    await session.close().catch(() => {});
  }
}

/** Идентификатор сообщения: целое больше нуля. */
function messageId(raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`id — целое больше 0: ${raw}`);
  }
  return value;
}

/**
 * Строка собирается по ключам, а не `JSON.stringify` целиком: контракт —
 * пробел после «:» и «,», как у вывода `telegram send`. Порядок ключей —
 * схемы результата: рендер получает результат, разобранный ею.
 */
function renderSaved(saved: SavedFile): string {
  const pairs = Object.entries(saved).map(([key, value]) =>
    `${JSON.stringify(key)}: ${JSON.stringify(value)}`
  );
  return `{${pairs.join(", ")}}\n`;
}

export const telegramFileCommand = defineCommand({
  path: ["telegram", "file"],
  keys: {},
  texts: ["chat"],
  errorName: "telegram file",
  summary: "Скачать вложение сообщения Telegram в локальный файл.",
  usage: "mpu telegram file chat: X id: N",
  help: `Звать, когда у сообщения в выдаче mpu telegram search есть file
(коллега прислал md, xlsx, скриншот), а прочитать нужно сам файл:
поиск отдаёт только описание. Файл ложится в
/tmp/mpu-telegram/<chat_id>-<id>-<имя>; повторный вызов его заменяет.

Агенту по MCP картинка (JPEG, PNG, GIF, WebP до 3 750 000 байт) приходит
в ответе блоком изображения — файл читать не нужно; вид решают байты
файла, а не mime. Прочие вложения — только файлом.

chat: X — чат сообщения: chat_id из выдачи поиска, @username, ссылка
t.me, название или me. TELEGRAM_DEFAULT_CHAT не читается.
id: N — id сообщения из той же выдачи, целое больше 0.

stdout — одна строка JSON: {"path": …, "name": …, "size": …, "mime": …};
size — записанные байты, mime — строка или null. Фото — photo-<id>.jpg
(наибольший размер), документ без имени — file-<id>; / и NUL в имени на
диске заменяются на _.

Ключи env-файла: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
(обязательны), TELEGRAM_PROXY.

Exit: 0 — файл записан; 1 — в сообщении нет файла, сообщения нет, чат
не найден, отказ Telegram, файл не записан; 2 — ошибка ввода.`,
  examples: ["mpu telegram file chat: -1000000000101 id: 42"],
  policy: "ro",
  argsSchema,
  resultSchema,
  run: runTelegramFile,
  render: renderSaved,
  // Записанный файл — картинка агенту, если его байты ею окажутся
  // (`platform/picture-frame.md`).
  picture: (saved) => filePicture(saved.path),
});
