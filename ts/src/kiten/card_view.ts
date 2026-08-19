/**
 * Вид карточки для команды `mpu kiten card` (`docs/specs/kiten-card.md`):
 * плоский объект из тех же ключей, что печатает `--json`. Он же питает
 * markdown и наглядный вид — источник данных у трёх видов один, различается
 * только оформление (`render.ts`).
 *
 * Форма объявлена схемой, а тип выведен из неё: ключи объекта — контракт
 * спеки, и второй их список в виде отдельного интерфейса разошёлся бы с
 * первым. Имена ключей snake_case намеренно: объект уходит в stdout как
 * есть, переименование в привычный camelCase сломало бы вывод.
 */

import { z } from "@zod/zod";
import type { Card, CardFile, Comment, Member } from "../kaiten/mod.ts";

/** Человек в выводе: владелец карточки и элемент `members`. */
const personSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  email: z.string().nullable(),
  username: z.string(),
});

/** Файл карточки в выводе: подмножество формы каталога. */
const fileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  url: z.string(),
  mime_type: z.string().nullable(),
  comment_id: z.number().int().nullable(),
  card_cover: z.boolean(),
});

/** Комментарий в выводе: автор — строкой, а не объектом. */
const commentSchema = z.object({
  id: z.number().int(),
  author: z.string().nullable(),
  created: z.string().nullable(),
  text: z.string(),
});

/**
 * Значение кастомного поля: строка либо массив uid — так приходит файловое
 * (attachment) поле (`platform/kaiten-api-cards.md`, «Инварианты»).
 */
const propertyValueSchema = z.union([
  z.string(),
  z.array(z.string()).readonly(),
]);

/** Карточка целиком — ровно то, что печатает `--json`, в порядке спеки. */
export const cardViewSchema = z.object({
  id: z.number().int(),
  key: z.string().nullable(),
  title: z.string(),
  state: z.string().describe("метка этапа: queued, in progress, done"),
  condition: z.number().int().describe("1 активная, 2 архив"),
  due_date: z.string().nullable(),
  board: z.string().nullable(),
  column: z.string().nullable(),
  lane: z.string().nullable(),
  size_text: z.string().nullable(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  type: z.string().nullable(),
  tags: z.array(z.string()).readonly(),
  url: z.string(),
  owner: personSchema.nullable(),
  members: z.array(personSchema).readonly(),
  properties: z.record(z.string(), propertyValueSchema).describe(
    "кастомные поля: ключи сырые (id_NNN), имена полей — отдельным полем результата",
  ),
  description: z.string().nullable(),
  files: z.array(fileSchema).readonly(),
  comments: z.array(commentSchema).readonly(),
});

/** Карточка так, как её видит вывод команды. */
export type CardView = z.infer<typeof cardViewSchema>;

/** Значение кастомного поля в выводе. */
export type PropertyValue = z.infer<typeof propertyValueSchema>;

/** Файл карточки в выводе. */
export type FileView = z.infer<typeof fileSchema>;

/** Комментарий в выводе. */
export type CommentView = z.infer<typeof commentSchema>;

/**
 * Карточка и её комментарии в вид вывода. Комментарии сортируются здесь, а
 * не в каталоге: порядок ответа сервера не задан, и хронологию наводит
 * потребитель (`platform/kaiten-api-cards.md`, «Инварианты»).
 */
export function cardView(
  card: Card,
  comments: readonly Comment[],
  baseUrl: string,
): CardView {
  return {
    id: card.id,
    key: card.key,
    title: card.title,
    state: stateLabel(card.state),
    condition: card.condition,
    due_date: card.dueDate,
    board: card.boardTitle,
    column: card.columnTitle,
    lane: card.laneTitle,
    size_text: card.sizeText,
    created: card.created,
    updated: card.updated,
    type: card.typeName,
    tags: card.tags,
    url: `${baseUrl}/${card.id}`,
    owner: card.owner === null ? null : personOf(card.owner),
    members: card.members.map(personOf),
    properties: card.properties,
    description: card.description,
    files: card.files.map(fileOf),
    comments: byCreated(comments).map(commentOf),
  };
}

/**
 * Метка этапа: закрытый список 1/2/3, число вне списка — оно само строкой
 * (`kiten-card.md`, «Ввод/вывод»). Экспортируется: ту же метку печатают
 * `kiten ls` и `kiten status`, и второй список значений разъехался бы с
 * этим на первой же правке.
 */
export function stateLabel(state: number): string {
  switch (state) {
    case 1:
      return "queued";
    case 2:
      return "in progress";
    case 3:
      return "done";
    default:
      return String(state);
  }
}

/**
 * Комментарии по возрастанию `created`, при равных — по `id`. Момента нет —
 * такой комментарий идёт первым: пустая строка меньше любой даты, и это то
 * место, где «неизвестно когда» не спорит с известными моментами.
 */
function byCreated(comments: readonly Comment[]): readonly Comment[] {
  return [...comments].sort((left, right) => {
    // Сравнение лексикографическое, а не по локали: моменты ISO-8601
    // сравнимы посимвольно, а правила локали умеют игнорировать дефис.
    const first = left.created ?? "";
    const second = right.created ?? "";
    if (first !== second) return first < second ? -1 : 1;
    return left.id - right.id;
  });
}

function personOf(member: Member): z.infer<typeof personSchema> {
  return {
    id: member.id,
    full_name: member.fullName,
    email: member.email,
    username: member.username,
  };
}

/** Привязка файла к кастомному полю наружу не выходит — она внутренняя. */
function fileOf(raw: CardFile): FileView {
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    mime_type: raw.mimeType,
    comment_id: raw.commentId,
    card_cover: raw.cardCover,
  };
}

function commentOf(raw: Comment): CommentView {
  return {
    id: raw.id,
    author: raw.author === null ? null : raw.author.fullName,
    created: raw.created,
    text: raw.text,
  };
}
