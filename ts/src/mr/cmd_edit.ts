/**
 * Команда `mpu mr edit` (`docs/specs/mr-write.md`): замена тела своей
 * заметки.
 *
 * Своей — потому что чужую отобьёт сам GitLab: клиентской проверки
 * автора нет, и заводить её значило бы спрашивать «кто я» лишним
 * вызовом ради ответа, который всё равно даст сервер.
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError } from "../command/mod.ts";
import { updateNote } from "../gitlab/mod.ts";
import { type BodyIo, commentBody } from "./body.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  note: z.number({ error: "нужен NOTE_ID: номер заметки" }).int(
    "NOTE_ID — целое число",
  ).positive("NOTE_ID — положительное число").describe(
    "номер заметки (id из mpu mr comments --json)",
  ),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
  ),
  message: z.string().optional().describe("новый текст заметки"),
  "body-file": z.string().optional().describe(
    "файл с текстом; '-' — весь stdin, только в CLI",
  ),
});

const resultSchema = z.object({
  note_id: z.number().describe("номер изменённой заметки"),
});

type EditArgs = z.infer<typeof argsSchema>;
type EditResult = z.infer<typeof resultSchema>;

/** Ход вызова: тело до сети, затем PUT на названный номер. */
export async function runEdit(
  args: EditArgs,
  io: MrIo & BodyIo,
  options: MrOptions = {},
): Promise<EditResult> {
  const body = await commentBody(args, io);
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  try {
    const note = await updateNote(access, address, args.note, body);
    if (note.id === 0) {
      // Подставить сюда номер из ввода значило бы выдать невнятный
      // ответ за штатную правку.
      throw new DomainError("GitLab не сообщил номер изменённой заметки");
    }
    return { note_id: note.id };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderEdit(result: EditResult): string {
  return `note ${result.note_id} обновлена\n`;
}

export const mrEditCommand = defineCommand({
  path: ["mr", "edit"],
  errorName: "mr edit",
  summary: "Заменить текст своей заметки в merge request'е.",
  usage: "mpu mr edit NOTE_ID [--mr REF] (-m TEXT | -F PATH)",
  help: `Заменяет тело заметки целиком — дописать к прежнему тексту
нельзя, новый текст встаёт вместо старого.

NOTE_ID — номер заметки, тот самый id из mpu mr comments --json и из
ссылки #note_<id>.

Текст — ровно один из -m/--message TEXT и -F/--body-file PATH; '-'
вместо пути означает весь stdin и работает только в CLI. Тело уходит
дословно.

Правится только своя заметка: чужую отобьёт сам GitLab.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — NOTE_ID не передан или не число, сочетание флагов
тела, пустое тело, нераспознанный --mr; 1 — отказ GitLab, чужая или
несуществующая заметка.

Примеры: mpu mr edit 42 -m 'уточнил'; mpu mr edit 42 -F правка.md`,
  policy: "rw",
  argsSchema,
  forms: {
    note: { positional: "one" },
    message: { short: "m" },
    "body-file": { short: "F" },
  },
  resultSchema,
  run: (args: EditArgs, io: MrIo & BodyIo) => runEdit(args, io),
  render: (result: EditResult) => renderEdit(result),
});
