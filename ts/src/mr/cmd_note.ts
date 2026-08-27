/**
 * Команда `mpu mr note` (`docs/specs/mr-write.md`): общий комментарий
 * к MR, без привязки к строке.
 *
 * От `comment` отличается ровно отсутствием позиции: ни диффа, ни
 * поиска строки — тред создаётся тем же POST, только без
 * position-ключей.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { createDiscussion, mergeRequest } from "../gitlab/mod.ts";
import { type BodyIo, commentBody } from "./body.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
  message: z.string().optional().describe("текст комментария"),
  "body-file": z.string().optional().describe(
    "файл с текстом; '-' — весь stdin, только в CLI",
  ),
});

const resultSchema = z.object({
  discussion: z.string().describe("id созданного треда"),
  note_id: z.number().describe("номер созданной заметки"),
  url: z.string().describe("ссылка на заметку: web_url MR + #note_<id>"),
});

type NoteArgs = z.infer<typeof argsSchema>;
type NoteResult = z.infer<typeof resultSchema>;

/** Ход вызова: тело до сети, затем POST треда без позиции. */
export async function runNote(
  args: NoteArgs,
  io: MrIo & BodyIo,
  options: MrOptions = {},
): Promise<NoteResult> {
  const body = await commentBody(args, io);
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const mr = await mergeRequest(access, address);
    const discussion = await createDiscussion(access, address, { body });
    const noteId = discussion.notes[0].id;
    return {
      discussion: discussion.id,
      note_id: noteId,
      url: `${mr.web_url}#note_${noteId}`,
    };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderNote(result: NoteResult): string {
  return `создано: discussion ${
    result.discussion.slice(0, 8)
  }\n${result.url}\n`;
}

export const mrNoteCommand = defineCommand({
  path: ["mr", "note"],
  errorName: "mr note",
  summary: "Общий комментарий к merge request'у, без привязки к строке.",
  usage: "mpu mr note [--mr REF] (-m TEXT | -F PATH)",
  help: `Создаёт общий тред MR — тот, что виден в обсуждении, а не у
строки диффа. Для замечания к конкретной строке есть mpu mr comment.

Текст — ровно один из -m/--message TEXT и -F/--body-file PATH; '-'
вместо пути означает весь stdin и работает только в CLI. Оба флага
сразу либо ни одного — ошибка ввода. Тело уходит дословно.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Повторный вызов с тем же текстом создаёт второй тред: дедупликации
нет.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — сочетание флагов тела, пустое тело,
нераспознанный --mr; 1 — отказ GitLab, ненайденный MR.

Примеры: mpu mr note -m 'посмотрел, вопросов нет';
mpu mr note --mr 456 -F разбор.md`,
  policy: "rw",
  argsSchema,
  forms: { message: { short: "m" }, "body-file": { short: "F" } },
  resultSchema,
  run: (args: NoteArgs, io: MrIo & BodyIo) => runNote(args, io),
  render: (result: NoteResult) => renderNote(result),
});
