/**
 * Команда `mpu mr reply` (`docs/specs/mr-write.md`): ответ в
 * существующий тред ревью.
 *
 * Тред адресуется тем же селектором, что и `mr show`: восемью
 * символами из `mr comments`. Системные треды по нему недостижимы —
 * их не показывает список, и отвечать в них незачем.
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError } from "../command/mod.ts";
import {
  discussions,
  matchDiscussion,
  mergeRequest,
  replyToDiscussion,
} from "../gitlab/mod.ts";
import { type BodyIo, commentBody } from "./body.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  discussion: z.string({
    error: "нужен DISCUSSION: полный id треда или префикс от 6 символов",
  }).describe("id треда или его префикс (≥6 символов)"),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
  message: z.string().optional().describe("текст ответа"),
  "body-file": z.string().optional().describe(
    "файл с текстом; '-' — весь stdin, только в CLI",
  ),
});

const resultSchema = z.object({
  discussion: z.string().describe("id треда, в который ушёл ответ"),
  note_id: z.number().describe("номер созданной заметки"),
  url: z.string().describe("ссылка на заметку: web_url MR + #note_<id>"),
});

type ReplyArgs = z.infer<typeof argsSchema>;
type ReplyResult = z.infer<typeof resultSchema>;

/** Ход вызова: тело, тред по селектору, POST ноты в него. */
export async function runReply(
  args: ReplyArgs,
  io: MrIo & BodyIo,
  options: MrOptions = {},
): Promise<ReplyResult> {
  const body = await commentBody(args, io);
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const mr = await mergeRequest(access, address);
    const thread = matchDiscussion(
      await discussions(access, address),
      args.discussion,
    );
    const note = await replyToDiscussion(access, address, thread.id, body);
    if (note.id === 0) {
      // Ответ не той формы: ссылка `#note_0` вела бы в никуда, а exit 0
      // говорил бы, что ответ доставлен.
      throw new DomainError("GitLab не сообщил номер созданной заметки");
    }
    return {
      discussion: thread.id,
      note_id: note.id,
      url: `${mr.web_url}#note_${note.id}`,
    };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderReply(result: ReplyResult): string {
  return `reply: note ${result.note_id} в discussion ` +
    `${result.discussion.slice(0, 8)}\n${result.url}\n`;
}

export const mrReplyCommand = defineCommand({
  path: ["mr", "reply"],
  errorName: "mr reply",
  summary: "Ответ в существующий тред ревью.",
  usage: "mpu mr reply DISCUSSION [--mr REF] (-m TEXT | -F PATH)",
  help: `Добавляет заметку в существующий тред — тот же разговор, а не
новый тред рядом.

DISCUSSION — полный id треда либо его префикс от 6 символов; восемь
символов, которые печатает mpu mr comments, годятся. Префикс, подошедший
нескольким тредам, — отказ с перечнем кандидатов. Системные треды
GitLab списком не показываются и по префиксу недостижимы.

Текст — ровно один из -m/--message TEXT и -F/--body-file PATH; '-'
вместо пути означает весь stdin и работает только в CLI. Тело уходит
дословно.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — DISCUSSION не передан, сочетание флагов тела,
пустое тело, нераспознанный --mr; 1 — отказ GitLab, ненайденный или
неоднозначный тред.

Примеры: mpu mr reply 953d395b -m 'поправил'; mpu mr reply 953d395b -F -`,
  policy: "rw",
  argsSchema,
  forms: {
    discussion: { positional: "one" },
    message: { short: "m" },
    "body-file": { short: "F" },
  },
  resultSchema,
  run: (args: ReplyArgs, io: MrIo & BodyIo) => runReply(args, io),
  render: (result: ReplyResult) => renderReply(result),
});
