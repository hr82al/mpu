/**
 * Три вида вывода `mpu kiten card` (`docs/specs/kiten-card.md`): сырой
 * JSON, чистый GFM-markdown и наглядный терминальный. Состав данных у всех
 * трёх один (`card_view.ts`), различается оформление, поэтому содержательные
 * куски — шапка, свойства, файлы, комментарии — собираются здесь общими
 * функциями, а видам остаётся их обрамление.
 *
 * Рендер чист: ни сети, ни диска, ни часов (`platform/command-contract.md`,
 * инвариант 2).
 */

import type {
  CardView,
  CommentView,
  FileView,
  PropertyValue,
} from "./card_view.ts";

/** Имена кастомных полей: `id_NNN` → имя из справочника компании. */
export type PropertyNames = Readonly<Record<string, string>>;

/** Расширения, по которым файл считается картинкой наглядного вида. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/** Начало ISO-момента: дата и минуты — всё, что показывают виды. */
const ISO_MINUTE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** Начало ISO-момента до дня: дедлайн показывают датой. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Сырой JSON: отступ 2, юникод как есть, ровно один перевод строки. */
export function renderJson(card: CardView): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}

/**
 * Чистый GFM-markdown. Блоки отделяются пустой строкой, вывод завершается
 * ровно одним `\n`; текст описания и комментариев переносится дословно,
 * включая GFM-чекбоксы — Kaiten их интерактивными не делает нигде.
 */
export function renderMarkdown(card: CardView, names: PropertyNames): string {
  const header = headerFields(card).map(({ label, value }) =>
    `- **${label}**: ${value}`
  );
  const blocks = [`# ${card.title}`, header.join("\n")];

  const properties = propertyFields(card.properties, names);
  if (properties.length > 0) {
    blocks.push(
      "## Свойства",
      properties.map(({ label, value }) => `- ${label}: ${value}`).join("\n"),
    );
  }

  blocks.push("## Описание", description(card));

  if (card.files.length > 0) {
    blocks.push("## Файлы", card.files.map(markdownFile).join("\n"));
  }
  if (card.comments.length > 0) {
    blocks.push("## Комментарии");
    for (const comment of card.comments) {
      blocks.push(`### ${commentHeading(comment)}`, comment.text);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Наглядный терминальный вид: то же содержимое без markdown-разметки,
 * заголовки и подписи — жирным. Оформление спека оставляет на усмотрение
 * реализации; `--no-images` убирает вложения-картинки из списка файлов.
 */
export function renderTerminal(
  card: CardView,
  names: PropertyNames,
  options: { readonly images: boolean },
): string {
  const blocks = [bold(card.title), fieldLines(headerFields(card))];

  const properties = propertyFields(card.properties, names);
  if (properties.length > 0) {
    blocks.push(bold("Свойства"), fieldLines(properties));
  }

  blocks.push(bold("Описание"), description(card));

  const files = options.images ? card.files : card.files.filter(notImage);
  if (files.length > 0) {
    blocks.push(bold("Файлы"), files.map(terminalFile).join("\n"));
  }
  if (card.comments.length > 0) {
    blocks.push(bold("Комментарии"));
    for (const comment of card.comments) {
      blocks.push(bold(commentHeading(comment)), comment.text);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Подписанное значение: обрамление у каждого вида своё, состав — общий. */
interface Field {
  readonly label: string;
  readonly value: string;
}

/**
 * Поля шапки в порядке спеки; попадает только непустое, кроме `URL` и
 * `Этап` — эти два есть всегда.
 */
function headerFields(card: CardView): readonly Field[] {
  const fields: Field[] = [];
  if (nonEmpty(card.key)) fields.push({ label: "Key", value: card.key });
  fields.push(
    { label: "URL", value: card.url },
    { label: "Этап", value: card.state },
  );

  const place = [card.board, card.column, card.lane].filter(nonEmpty);
  if (place.length > 0) {
    fields.push({ label: "Доска", value: place.join(" · ") });
  }
  if (card.owner !== null) {
    fields.push({ label: "Владелец", value: card.owner.full_name });
  }
  if (card.members.length > 0) {
    fields.push({
      label: "Участники",
      value: card.members.map((member) => member.full_name).join(", "),
    });
  }
  const due = card.due_date === null ? null : dateOnly(card.due_date);
  if (nonEmpty(due)) fields.push({ label: "Дедлайн", value: due });
  if (card.tags.length > 0) {
    fields.push({ label: "Теги", value: card.tags.join(", ") });
  }
  return fields;
}

/**
 * Свойства в порядке ответа сервера; подпись — имя из справочника, а не
 * резолвится — сырой ключ `id_NNN` (сбой справочника команду не роняет).
 * Значение-массив печатается элементами через `, `: скобки и кавычки чужого
 * языка — не контракт (`kiten-card.md`, «Известные отклонения»).
 */
function propertyFields(
  properties: Readonly<Record<string, PropertyValue>>,
  names: PropertyNames,
): readonly Field[] {
  return Object.entries(properties).map(([key, value]) => ({
    label: Object.hasOwn(names, key) ? names[key] : key,
    value: propertyValue(value),
  }));
}

/** Поля наглядного вида: подпись и значение через двоеточие, без разметки. */
function fieldLines(fields: readonly Field[]): string {
  return fields.map(({ label, value }) => `${label}: ${value}`).join("\n");
}

function propertyValue(value: PropertyValue): string {
  return typeof value === "string" ? value : value.join(", ");
}

/** Пустое описание — заглушка: раздел «Описание» печатается всегда. */
function description(card: CardView): string {
  return nonEmpty(card.description) ? card.description : "_нет описания_";
}

function markdownFile(file: FileView): string {
  return `- [${nonEmpty(file.name) ? file.name : file.url}](${file.url})`;
}

function terminalFile(file: FileView): string {
  return nonEmpty(file.name) ? `${file.name} — ${file.url}` : file.url;
}

function notImage(file: FileView): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return !IMAGE_EXTENSIONS.includes(extension);
}

/** Автора нет — прочерк; момента нет — только автор. */
function commentHeading(comment: CommentView): string {
  const author = nonEmpty(comment.author) ? comment.author : "—";
  const moment = comment.created === null ? null : minuteStamp(comment.created);
  return moment === null ? author : `${author} · ${moment}`;
}

/** Момент до минут: `2026-08-14T16:33:42.672Z` → `2026-08-14 16:33`. */
function minuteStamp(iso: string): string {
  const parts = ISO_MINUTE.exec(iso);
  return parts === null ? iso : `${parts[1]} ${parts[2]}`;
}

/**
 * Момент до дня. Строка не по образцу — она же как есть: чинить чужой
 * формат команда не берётся, но и терять значение не должна.
 */
function dateOnly(iso: string): string {
  return ISO_DATE.exec(iso)?.[0] ?? iso;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function nonEmpty(value: string | null): value is string {
  return value !== null && value !== "";
}
