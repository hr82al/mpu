/**
 * Треды ревью в формах вывода `mpu mr` (`docs/specs/mr-read.md`):
 * фильтры, схема результата и три рендера.
 *
 * Общее место для `comments` и `show`: у одного тред печатается
 * списком, у другого — целиком, но форма треда и ноты обязана быть
 * одна. Разъехавшись, они дали бы оператору два разных ответа на один
 * вопрос «что здесь обсуждают».
 */

import { z } from "@zod/zod";
import type { Discussion } from "../gitlab/mod.ts";
import { renderTable } from "../ps/table.ts";
import { locationOf } from "./location.ts";

/** Длина обрезки колонки EXCERPT, вместе с многоточием. */
const EXCERPT_LIMIT = 60;

/** Сколько символов id треда показывает таблица и заголовок markdown. */
const SHORT_ID = 8;

export const positionSchema = z.object({
  old_path: z.union([z.string(), z.null()]),
  new_path: z.union([z.string(), z.null()]),
  old_line: z.union([z.number(), z.null()]),
  new_line: z.union([z.number(), z.null()]),
});

export const noteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author_name: z.string(),
  author_username: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  system: z.boolean(),
  resolvable: z.boolean(),
  resolved: z.boolean(),
  type: z.union([z.string(), z.null()]),
  position: z.union([positionSchema, z.null()]),
});

export const threadSchema = z.object({
  id: z.string(),
  resolvable: z.boolean(),
  resolved: z.boolean(),
  location: z.union([z.string(), z.null()]),
  notes: z.array(noteSchema),
});

export type Thread = z.infer<typeof threadSchema>;

/** Тред в форме вывода: позиция сведена в строку LOCATION. */
export function threadOf(discussion: Discussion): Thread {
  return {
    id: discussion.id,
    resolvable: discussion.resolvable,
    resolved: discussion.resolved,
    location: locationOf(discussion.position),
    notes: discussion.notes.map((note) => ({ ...note })),
  };
}

/** Фильтры `comments`; складываются, а не заменяют друг друга. */
export interface ThreadFilters {
  readonly unresolved: boolean;
  readonly file: string | undefined;
  readonly author: string | undefined;
}

/**
 * Отбор тредов по фильтрам вызова, в порядке ответа API. Отбор идёт по
 * форме атома, а не по уже собранной строке LOCATION: позиция там
 * сведена один раз, и второй поиск по нотам разошёлся бы с первым.
 */
export function filterDiscussions(
  threads: readonly Discussion[],
  filters: ThreadFilters,
): readonly Discussion[] {
  return threads.filter((thread) => {
    if (filters.unresolved && !(thread.resolvable && !thread.resolved)) {
      return false;
    }
    if (filters.file !== undefined && !matchesFile(thread, filters.file)) {
      return false;
    }
    if (
      filters.author !== undefined && !matchesAuthor(thread, filters.author)
    ) {
      return false;
    }
    return true;
  });
}

/** Тред без позиции под файловый фильтр не подходит вовсе (спека). */
function matchesFile(thread: Discussion, substring: string): boolean {
  const position = thread.position;
  if (position === null) return false;
  // Оба пути, а не один: тред на переименованном файле оператор ищет
  // по тому имени, которое помнит.
  return (position.new_path ?? "").includes(substring) ||
    (position.old_path ?? "").includes(substring);
}

/** Автор — первая нота треда; сравнение без учёта регистра. */
function matchesAuthor(thread: Discussion, substring: string): boolean {
  const first = thread.notes[0];
  if (first === undefined) return false;
  const haystack = `${first.author_username} ${first.author_name}`
    .toLowerCase();
  return haystack.includes(substring.toLowerCase());
}

/** Число открытых тредов — хвост таблицы и второй счётчик. */
export function unresolvedCount(threads: readonly Thread[]): number {
  return threads.filter((t) => t.resolvable && !t.resolved).length;
}

/** Колонка RES: закрытый, открытый и общий тред различимы на глаз. */
function resolutionMark(thread: Thread): string {
  if (!thread.resolvable) return "";
  return thread.resolved ? "✓" : "·";
}

/** Первая строка первой ноты, обрезанная до предела колонки. */
function excerptOf(thread: Thread): string {
  const body = thread.notes[0]?.body ?? "";
  const line = body.split("\n")[0];
  const chars = [...line];
  return chars.length <= EXCERPT_LIMIT
    ? line
    : `${chars.slice(0, EXCERPT_LIMIT - 1).join("")}…`;
}

/** Автор для колонки AUTHOR и заголовков: username, иначе имя. */
function authorOf(thread: Thread): string {
  const first = thread.notes[0];
  if (first === undefined) return "";
  return first.author_username === ""
    ? first.author_name
    : first.author_username;
}

/** Таблица тредов с хвостом-счётчиком. */
export function renderThreadTable(
  headline: string,
  threads: readonly Thread[],
): string {
  const rows = threads.map((thread) => [
    thread.id.slice(0, SHORT_ID),
    resolutionMark(thread),
    thread.location ?? "",
    authorOf(thread),
    String(thread.notes.length),
    excerptOf(thread),
  ]);
  const table = renderTable(
    ["DISC", "RES", "LOCATION", "AUTHOR", "NOTES", "EXCERPT"],
    rows,
  );
  return `${headline}\n${table}(${threads.length} discussions, ` +
    `${unresolvedCount(threads)} unresolved)\n`;
}

/** Состояние треда словом: общий тред резолву не подлежит вовсе. */
export function statusWord(thread: Thread): string {
  if (!thread.resolvable) return "note";
  return thread.resolved ? "resolved" : "open";
}

/** Заголовок ноты: кто, когда и с каким номером. */
export function noteHeadline(note: Thread["notes"][number]): string {
  const name = note.author_name === ""
    ? note.author_username
    : note.author_name;
  // Первые 16 символов ISO-времени с пробелом вместо «T»: секунды и
  // зона в списке ревью не нужны, а строка становится читаемой.
  const at = note.created_at.slice(0, 16).replace("T", " ");
  return `**${name}** (@${note.author_username}) · note ${note.id} · ${at}`;
}

/** Markdown: заголовок MR, затем тред за тредом. */
export function renderThreadsMarkdown(
  headline: string,
  threads: readonly Thread[],
): string {
  const parts = [`# ${headline}`, ""];
  for (const thread of threads) {
    parts.push(
      `## ${thread.id.slice(0, SHORT_ID)} · ${
        thread.location ?? "general"
      } · ` +
        statusWord(thread),
    );
    for (const note of thread.notes) {
      parts.push(noteHeadline(note), "", note.body, "");
    }
    parts.push("---", "");
  }
  return `${parts.join("\n")}`.replace(/\n*$/, "\n");
}
