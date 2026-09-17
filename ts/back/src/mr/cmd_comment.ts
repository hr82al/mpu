/**
 * Команда `mpu mr comment` (`docs/specs/mr-write.md`): инлайн-
 * комментарий к строке диффа.
 *
 * Самая хрупкая команда семейства. Промах не выглядит промахом:
 * GitLab принимает POST с неверной позицией и отвечает успехом, а
 * комментарий повисает в MR без привязки к строке. Поэтому строка
 * ищется в разобранном диффе ДО отправки, и всё, чего в диффе нет,
 * отбивается с перечнем того, что там есть.
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError, UsageError } from "../command/mod.ts";
import {
  type ChangedFile,
  changedFiles,
  commentableLines,
  createDiscussion,
  type DiffSide,
  findLine,
  mergeRequest,
  positionForm,
  rangesText,
} from "../gitlab/mod.ts";
import { type BodyIo, commentBody } from "./body.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

/** Сколько путей называет отказ «файл не изменён» (спека). */
const PATHS_SHOWN = 20;

const argsSchema = z.object({
  target: z.string({ error: "нужен FILE:LINE" }).describe(
    "файл и строка: FILE:LINE, разделитель — последний ':'",
  ),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
  message: z.string().optional().describe("текст комментария"),
  "body-file": z.string().optional().describe(
    "файл с текстом; '-' — весь stdin, только в CLI",
  ),
  old: z.boolean().default(false).describe(
    "номер строки в старой версии файла (левая колонка диффа)",
  ),
});

const resultSchema = z.object({
  discussion: z.string().describe("id созданного треда"),
  note_id: z.number().describe("номер созданной заметки"),
  path: z.string().describe("файл, к которому привязан комментарий"),
  line: z.number().describe("строка на выбранной стороне диффа"),
  url: z.string().describe("ссылка на заметку: web_url MR + #note_<id>"),
});

type CommentArgs = z.infer<typeof argsSchema>;
type CommentResult = z.infer<typeof resultSchema>;

/** Разбор `FILE:LINE`; разделитель — последний `:` (пути с ним бывают). */
export function parseTarget(target: string): { path: string; line: number } {
  const cut = target.lastIndexOf(":");
  const path = cut < 0 ? "" : target.slice(0, cut);
  if (cut < 0 || path === "") {
    throw new UsageError(`ожидается FILE:LINE, получено '${target}'`);
  }
  const rest = target.slice(cut + 1);
  if (!/^\d+$/.test(rest) || Number(rest) <= 0) {
    throw new UsageError(`LINE — положительное число, получено '${target}'`);
  }
  return { path, line: Number(rest) };
}

/** Файл MR по пути: ищется и по новому, и по старому имени. */
function fileByPath(
  files: readonly ChangedFile[],
  path: string,
): ChangedFile | undefined {
  return files.find((file) => file.new_path === path || file.old_path === path);
}

/** Отказ «файл не изменён» с перечнем изменённых путей. */
function unknownFile(files: readonly ChangedFile[], path: string): DomainError {
  // Оба имени: поиск файла принимает и старое, и новое, поэтому
  // переименованный обязан быть виден в перечне под обоими — иначе
  // оператор ищет имя, которое команда приняла бы.
  const paths = [
    ...new Set(files.flatMap((file) => [file.new_path, file.old_path])),
  ].filter((path) => path !== "").sort();
  const shown = paths.slice(0, PATHS_SHOWN).join(", ");
  const tail = paths.length > PATHS_SHOWN ? `${shown}, …` : shown;
  return new DomainError(
    `файл '${path}' не изменён в этом MR; изменённые: ${tail}`,
  );
}

/**
 * Отказ «строка вне диффа» с подсказкой, куда целиться. Подсказка не
 * вежливость: оператор смотрит на файл в редакторе, где номера строк
 * свои, а комментировать может только то, что попало в дифф.
 */
function lineOutside(
  file: ChangedFile,
  side: DiffSide,
  path: string,
  line: number,
): DomainError {
  const head = `${path}:${line} не входит в diff MR`;
  if (side === "new" && file.deleted_file) {
    return new DomainError(`${head}; файл удалён в MR — используй --old`);
  }
  const numbers = commentableLines(file, side);
  if (numbers.length === 0) {
    return new DomainError(
      `${head}; на ${side}-стороне нет комментируемых строк`,
    );
  }
  const hint = side === "new" ? " (строки старой версии — через --old)" : "";
  return new DomainError(
    `${head}; комментируемые ${side}-строки: ${rangesText(numbers)}${hint}`,
  );
}

/** Ход вызова: тело, адрес, дифф, поиск строки, POST с позицией. */
export async function runComment(
  args: CommentArgs,
  io: MrIo & BodyIo,
  options: MrOptions = {},
): Promise<CommentResult> {
  // Тело и форма аргумента — до сети: неверный вызов не должен стоить
  // ни git-подпроцесса, ни обращения к GitLab.
  const body = await commentBody(args, io);
  const { path, line } = parseTarget(args.target);
  const side: DiffSide = args.old ? "old" : "new";
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const mr = await mergeRequest(access, address);
    if (mr.diff_refs === null) {
      throw new DomainError(
        `у MR ${address.project}!${address.iid} нет diff (MR без коммитов)`,
      );
    }
    const files = await changedFiles(access, address);
    const file = fileByPath(files, path);
    if (file === undefined) throw unknownFile(files, path);
    const found = findLine(file, side, line);
    if (found === undefined) throw lineOutside(file, side, path, line);
    const discussion = await createDiscussion(access, address, {
      body,
      ...positionForm(mr.diff_refs, file, found),
    });
    if (discussion.position === null) {
      // Ровно тот исход, ради которого заведена спека: POST принят,
      // комментарий создан — и висит без привязки к строке. Проверка
      // по ОТВЕТУ, а не по тому, что мы отправили: между GET шапки и
      // POST'ом MR мог обновиться, и diff_refs устареть.
      // «Остался» сказано намеренно: без этого слова оператор решит,
      // что вызов не состоялся, повторит его — и в MR будет два
      // непривязанных комментария вместо одного.
      const short = discussion.id.slice(0, 8);
      throw new DomainError(
        `комментарий создан и остался в MR, но GitLab не привязал его ` +
          `к строке (discussion ${short}); проверь mpu mr show ${short}`,
      );
    }
    const noteId = discussion.notes[0].id;
    // Путь берётся из файла MR, а не из ввода: у переименованного
    // файла оператор назвал одно имя, а комментарий ушёл к другому, и
    // подтверждать нужно то, что случилось.
    const shown = side === "new" && file.new_path !== ""
      ? file.new_path
      : file.old_path;
    return {
      discussion: discussion.id,
      note_id: noteId,
      path: shown,
      line,
      url: `${mr.web_url}#note_${noteId}`,
    };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

/** Две строки: что создано и куда смотреть. */
export function renderComment(result: CommentResult): string {
  return `создано: discussion ${result.discussion.slice(0, 8)} на ` +
    `${result.path}:${result.line}\n${result.url}\n`;
}

export const mrCommentCommand = defineCommand({
  path: ["mr", "comment"],
  errorName: "mr comment",
  summary: "Инлайн-комментарий к строке диффа merge request'а.",
  usage: "mpu mr comment FILE:LINE [--mr REF] (-m TEXT | -F PATH) [--old]",
  help: `Создаёт тред ревью, привязанный к строке диффа.

FILE:LINE — путь и номер строки; разделитель — последнее двоеточие, так
что двоеточия в пути допустимы. LINE — номер в НОВОЙ версии файла, то
есть в правой колонке диффа GitLab. Удалённой строки в новой версии
нет: её старый номер задаётся вместе с --old.

Строка проверяется по диффу MR ДО отправки. Если её там нет, команда
отказывается и называет диапазоны, которые можно комментировать: GitLab
принял бы такой комментарий молча, оставив его висеть без привязки к
строке.

Текст — ровно один из -m/--message TEXT и -F/--body-file PATH; '-'
вместо пути означает весь stdin и работает только в CLI. Оба флага
сразу либо ни одного — ошибка ввода. Тело уходит дословно.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — форма FILE:LINE, сочетание флагов тела, пустое
тело, нераспознанный --mr; 1 — отказ GitLab, файл не изменён в MR,
строка вне диффа, у MR нет коммитов.

Примеры: mpu mr comment src/loader.ts:42 -m 'тут гонка';
mpu mr comment src/loader.ts:17 --old -F замечание.md`,
  policy: "rw",
  argsSchema,
  forms: {
    target: { positional: "one" },
    message: { short: "m" },
    "body-file": { short: "F" },
  },
  resultSchema,
  run: (args: CommentArgs, io: MrIo & BodyIo) => runComment(args, io),
  render: (result: CommentResult) => renderComment(result),
});
