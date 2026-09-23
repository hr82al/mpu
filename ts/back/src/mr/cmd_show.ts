/**
 * Команда `mpu mr show` (`docs/specs/mr-read.md`): один тред целиком.
 *
 * Продолжение `comments`: там виден список и восемь символов id, здесь
 * — весь разговор по этому id. Поэтому селектором служит префикс, а не
 * только полный 40-hex: списком человек уже пользовался.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { discussions, matchDiscussion } from "../gitlab/mod.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";
import {
  noteHeadline,
  statusWord,
  type Thread,
  threadOf,
  threadSchema,
} from "./threads.ts";

const argsSchema = z.object({
  discussion: z.string({
    error: "нужен id: полный id треда или префикс от 6 символов",
  }).describe("id треда или его префикс (≥6 символов)"),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без ключа — открытый MR ветки",
  ),
  json: z.boolean().default(false).describe("объект треда JSON"),
});

type ShowArgs = z.infer<typeof argsSchema>;
type ShowResult = Thread;

/** Ход вызова: треды MR, затем матчинг селектора по ним. */
export async function runShow(
  args: ShowArgs,
  io: MrIo,
  options: MrOptions = {},
): Promise<ShowResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const threads = await discussions(access, address);
    return threadOf(matchDiscussion(threads, args.discussion));
  } catch (err) {
    throw asCommandError(io, err);
  }
}

/** Заголовок треда и ноты под ним; id — полный, не обрезанный. */
export function renderShow(thread: ShowResult, json: boolean): string {
  if (json) return `${JSON.stringify(thread, null, 2)}\n`;
  const parts = [
    `discussion ${thread.id} · ${thread.location ?? "general"} · ` +
    statusWord(thread),
  ];
  for (const note of thread.notes) {
    parts.push("", noteHeadline(note), note.body);
  }
  return `${parts.join("\n").replace(/\n*$/, "")}\n`;
}

export const mrShowCommand = defineCommand({
  path: ["mr", "show"],
  keys: { id: "discussion" },
  errorName: "mr show",
  summary: "Один тред ревью целиком: все ноты по порядку.",
  usage: "mpu mr show id: ТРЕД [mr: REF] [end json]",
  help: `Звать, когда из списка mpu mr comments нужен один тред целиком.
Печатает заголовок с полным id, позицией и
состоянием, затем каждую ноту — кто, когда и текст.

id: — полный id треда либо его префикс от 6 символов (короче —
отказ). Префикс, подошедший нескольким тредам, тоже отказ, с перечнем
кандидатов: показать «какой-нибудь» из них хуже, чем не показать
ничего. Восемь символов, которые печатает mpu mr comments, годятся.

mr: REF — адрес MR: URL, 'group/repo!iid' или голый iid; без ключа —
открытый MR текущей ветки.

end json печатает объект треда {id, resolvable, resolved, location,
notes} — той же формы, что элемент массива mpu mr comments end json.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — id: не передан, нераспознанный mr:; 1 —
отказ GitLab, ненайденный MR, короткий/ненайденный/неоднозначный
селектор треда.`,
  examples: [
    "mpu mr show id: 953d395b",
    "mpu mr show id: 953d395b mr: 456 end json",
  ],
  policy: "ro",
  argsSchema,
  forms: { discussion: { positional: "one" } },
  resultSchema: threadSchema,
  run: (args: ShowArgs, io: MrIo) => runShow(args, io),
  render: (result: ShowResult, args: ShowArgs) => renderShow(result, args.json),
});
