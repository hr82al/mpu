/**
 * Команда `mpu mr delete` (`docs/specs/mr-write.md`): удаление своей
 * заметки.
 *
 * Единственная необратимая подкоманда семейства: удалённую заметку
 * GitLab не возвращает. Поэтому без `--yes` она спрашивает человека, а
 * без терминала — отказывается вовсе, не пытаясь угадать согласие по
 * умолчанию.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, DomainError } from "../command/mod.ts";
import { deleteNote } from "../gitlab/mod.ts";
import { isYes } from "../confirm/gate.ts";
import {
  asCommandError,
  gitlabAccess,
  mrAddress,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  note: z.number({ error: "нужен id: номер заметки" }).int(
    "id: — целое число",
  ).positive("id: — положительное число").describe(
    "номер заметки (id из mpu mr comments end json)",
  ),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без ключа — открытый MR ветки",
  ),
  yes: z.boolean().default(false).describe(
    "не спрашивать подтверждения (для скриптов)",
  ),
});

const resultSchema = z.object({
  note_id: z.number().describe("номер удалённой заметки"),
});

type DeleteArgs = z.infer<typeof argsSchema>;
type DeleteResult = z.infer<typeof resultSchema>;

/** Порт: к общему срезу добавляется терминал для вопроса человеку. */
export type DeleteIo = MrIo & Pick<CommandIo, "prompt">;

/** Ход вызова: адрес, подтверждение, DELETE. */
export async function runDelete(
  args: DeleteArgs,
  io: DeleteIo,
  options: MrOptions = {},
): Promise<DeleteResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  if (!args.yes) {
    await io.prompt.line(
      `Удалить note ${args.note} в ${address.project}!${address.iid}? [y/N] `,
      {
        given: (answer) => {
          if (!isYes(answer)) throw new DomainError("отменено");
        },
        // Отказ состояния, а не ввода: команда набрана верно, спросить
        // некого. И DELETE при этом не выполняется — в этом весь смысл.
        absent: () => {
          throw new DomainError("нет TTY для подтверждения — добавь yes");
        },
      },
    );
  }
  try {
    await deleteNote(access, address, args.note);
    return { note_id: args.note };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderDelete(result: DeleteResult): string {
  return `note ${result.note_id} удалена\n`;
}

export const mrDeleteCommand = defineCommand({
  path: ["mr", "delete"],
  keys: { id: "note" },
  errorName: "mr delete",
  summary: "Удалить свою заметку в merge request'е.",
  usage: "mpu mr delete [yes] id: ЗАМЕТКА [mr: REF]",
  help: `Звать, когда свою заметку в MR надо убрать. Удаляет её; действие
необратимо: GitLab удалённую заметку
не возвращает.

id: — номер заметки, тот самый id из mpu mr comments end json и из
ссылки #note_<id>.

Без yes команда спрашивает подтверждение в терминале. Если терминала
нет (запуск из скрипта, cron, вызов тула), она отказывается и ничего не
удаляет: молча считать «да» здесь нельзя. Для скриптов есть yes — он
пропускает вопрос.

Чужую заметку удалить не получится: откажет сам GitLab.

mr: REF — адрес MR: URL, 'group/repo!iid' или голый iid; без ключа —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — id: не передан или не число, нераспознанный
mr:; 1 — нет терминала без yes, отказ человека, отказ GitLab,
несуществующая заметка.`,
  examples: [
    "mpu mr delete id: 42",
    "mpu mr delete yes id: 42 mr: 456",
  ],
  policy: "rw",
  argsSchema,
  forms: { note: { positional: "one" } },
  resultSchema,
  run: (args: DeleteArgs, io: DeleteIo) => runDelete(args, io),
  render: (result: DeleteResult) => renderDelete(result),
});
