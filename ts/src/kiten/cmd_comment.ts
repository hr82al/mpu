/**
 * Команда `mpu kiten comment` (`docs/specs/kiten-comment.md`): комментарий
 * к карточке Kaiten — текст, вложения и адресаты первой строкой.
 *
 * Здесь порядок шагов и разбор ввода; текстовые преобразования (адресаты,
 * `@all`, сборка строк) — `comment_text.ts`: они чистые и проверяются без
 * сети. Про HTTP команда не знает — только про каталог
 * (`../kaiten/mod.ts`).
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import {
  createCardComment,
  createCardCommentWithFiles,
  getCard,
  type KaitenAccess,
  parseCardRef,
  type UploadFile,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  baseName,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import {
  commentText,
  expandAllInText,
  mentionsAll,
  recipientsFrom,
  recipientTokens,
} from "./comment_text.ts";

const argsSchema = z.object({
  selector: z.string({ error: "нужен SELECTOR: id карточки или её URL" })
    .describe("id карточки либо её URL, короткий или глубокий"),
  message: z.string().optional().describe("текст комментария (GFM markdown)"),
  "body-file": z.string().optional().describe(
    "файл с текстом комментария; '-' — stdin",
  ),
  file: z.array(z.string()).default([]).describe(
    "вложение: путь к файлу; флаг повторяется",
  ),
  to: z.array(z.string()).default([]).describe(
    "адресаты первой строкой: '@ivan @petr' либо '@all'; флаг повторяется",
  ),
});

const resultSchema = z.object({
  id: z.number().describe("id созданного комментария из ответа сервера"),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
  attachments: z.array(z.string()).describe(
    "имена приложенных файлов в порядке флагов -f",
  ),
  recipients: z.array(z.string()).describe(
    "реально упомянутые адресаты; литеральный @all сюда не входит",
  ),
});

/** Разобранные аргументы вызова. */
type KitenCommentArgs = z.infer<typeof argsSchema>;

/** Результат: созданный комментарий и что в нём оказалось. */
type KitenCommentResult = z.infer<typeof resultSchema>;

/**
 * Срез порта исполнения: доступ к Kaiten, три источника ввода (stdin,
 * текстовый файл, вложение обычным файлом) и служебная строка хода.
 */
type CommentIo =
  & AccessIo
  & Pick<
    CommandIo,
    "progress" | "readRegularFile" | "readTextFile" | "readTextStdin"
  >;

/**
 * Порядок шагов: сперва весь ввод (источники текста, вложения) — и
 * только потом сеть; отбитый ввод не должен стоить ни одного запроса
 * (`kiten-comment.md`, «Инварианты»). Карточка читается лишь тогда,
 * когда нужен владелец: заданы адресаты либо в тексте есть `@all`.
 */
async function runKitenComment(
  args: KitenCommentArgs,
  io: CommentIo,
): Promise<KitenCommentResult> {
  const cardId = parseCardRef(args.selector);
  // Адресаты считаются токенами, а не флагами: `--to ''` — флаг есть, а
  // адресата нет, и текст такому комментарию всё ещё нужен.
  const tokens = recipientTokens(args.to);
  const source = textSource(args, tokens);
  const access = kaitenAccess(io);
  const body = source === undefined ? "" : await readBody(io, source);
  const attachments = await readAttachments(io, args.file);

  const needOwner = tokens.length > 0 || mentionsAll(body);
  try {
    const ownerHandle = needOwner
      ? await ownerHandleOf(access, cardId, io)
      : null;
    const recipients = recipientsFrom(tokens, ownerHandle);
    const text = commentText(
      recipients,
      ownerHandle === null ? body : expandAllInText(body, ownerHandle),
    );
    const comment = attachments.length === 0
      ? await createCardComment(access, cardId, text)
      : await createCardCommentWithFiles(access, cardId, text, attachments);
    return {
      id: comment.id,
      cardUrl: cardUrl(access, cardId),
      attachments: attachments.map((file) => file.name),
      // Литеральный `@all` адресатом не стал: владельца у карточки нет.
      recipients: recipients.filter((handle) =>
        handle.toLowerCase() !== "@all"
      ),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Откуда брать текст: флаг `-m` либо файл `-F`; ни одного — `undefined`. */
type TextSource =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * Источник текста и запрет пустого комментария. Вложения текста не дают:
 * Kaiten отвергает комментарий с пустым `text` (`kiten-comment.md`,
 * «Известные отклонения»), поэтому такой вызов отбивается на входе, а не
 * уходит в сеть за отказом.
 */
function textSource(
  args: KitenCommentArgs,
  tokens: readonly string[],
): TextSource | undefined {
  const path = args["body-file"];
  if (args.message !== undefined && path !== undefined) {
    throw new UsageError("нельзя одновременно -m/--message и -F/--body-file");
  }
  if (args.message !== undefined) {
    return { kind: "message", text: args.message };
  }
  if (path !== undefined) return { kind: "file", path };
  // Текста нет: его дадут адресаты — они становятся первой строкой.
  if (tokens.length > 0) return undefined;
  if (args.file.length > 0) {
    throw new UsageError(
      "нужен текст комментария: вложения без текста Kaiten не принимает",
    );
  }
  throw new UsageError("нужно ровно одно из -m/--message и -F/--body-file");
}

/** Текст источника; заданный явно, он не бывает пустым. */
async function readBody(io: CommentIo, source: TextSource): Promise<string> {
  const text = source.kind === "message"
    ? source.text
    : await readBodyFile(io, source.path);
  if (text.trim() === "") throw new UsageError("пустой текст комментария");
  return text;
}

async function readBodyFile(io: CommentIo, path: string): Promise<string> {
  try {
    return path === "-"
      ? await io.readTextStdin()
      : await io.readTextFile(path);
  } catch (err) {
    throw new UsageError(`не удалось прочитать ${path}: ${reason(err)}`, {
      cause: err,
    });
  }
}

/** Вложения в порядке флагов `-f`; имя в Kaiten — базовое имя пути. */
async function readAttachments(
  io: CommentIo,
  paths: readonly string[],
): Promise<readonly UploadFile[]> {
  const files: UploadFile[] = [];
  for (const path of paths) {
    files.push({ name: baseName(path), bytes: await readAttachment(io, path) });
  }
  return files;
}

async function readAttachment(
  io: CommentIo,
  path: string,
): Promise<Uint8Array> {
  try {
    return await io.readRegularFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new UsageError(`файл-вложение не найден: ${path}`, { cause: err });
    }
    throw new UsageError(
      `не удалось прочитать вложение ${path}: ${reason(err)}`,
      { cause: err },
    );
  }
}

/**
 * Адресат-владелец карточки. Владельца или его логина нет — это не
 * ошибка: предупреждение в stderr, `@all` остаётся литеральным, команда
 * продолжается (`kiten-comment.md`, «Инварианты»).
 */
async function ownerHandleOf(
  access: KaitenAccess,
  cardId: number,
  io: CommentIo,
): Promise<string | null> {
  const card = await getCard(access, cardId);
  const username = card.owner?.username ?? "";
  if (username === "") {
    io.progress(
      "mpu kiten comment: у карточки нет владельца с username — " +
        "оставляю '@all' как есть",
    );
    return null;
  }
  return `@${username}`;
}

/** Причина отказа одной строкой: для текста ошибки ввода. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const kitenCommentCommand = defineCommand({
  path: ["kiten", "comment"],
  errorName: "kiten comment",
  summary: "Комментарий к карточке Kaiten: текст, вложения, адресаты.",
  usage:
    "mpu kiten comment SELECTOR [-m TEXT | -F PATH] [-f PATH]... [--to HANDLES]...",
  help: `SELECTOR — id карточки либо её URL.

Текст — ровно один источник: -m/--message TEXT либо -F/--body-file PATH
('-' — stdin); текст GFM markdown, интерактивных чекбоксов Kaiten в
комментарии не рендерит.

-f/--file PATH — вложение (флаг повторяется): уходит сам файл, имя в
Kaiten — базовое имя пути. Текста вложения не дают: комментарий из одних
файлов Kaiten не принимает, поэтому -f без -m/-F и без --to отбивается до
запроса.

--to HANDLES — адресаты (флаг повторяется, значение делится по пробелам);
токен без '@' его получает, дубли уходят без учёта регистра. Адресаты
становятся первой строкой, поэтому --to без текста проходит. '@all' — и в
--to, и самостоятельным токеном в тексте — разворачивается в логин
владельца карточки; владельца нет — предупреждение в stderr и '@all' как
есть. Ради владельца и читается карточка: без --to и без '@all' уходит
ровно один запрос.

Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL.

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (источники
текста, вложение, селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten comment 65634936 --to '@all' -m 'Готово, проверьте'`,
  policy: "rw",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    message: { short: "m" },
    "body-file": { short: "F" },
    file: { short: "f" },
  },
  resultSchema,
  run: runKitenComment,
  render: (result) => {
    const lines = [`ok: комментарий ${result.id} → ${result.cardUrl}`];
    if (result.attachments.length > 0) {
      lines.push(`   вложения: ${result.attachments.join(", ")}`);
    }
    if (result.recipients.length > 0) {
      lines.push(`   адресаты: ${result.recipients.join(" ")}`);
    }
    return `${lines.join("\n")}\n`;
  },
});
