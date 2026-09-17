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
  note: z.number({ error: "нужен NOTE_ID: номер заметки" }).int(
    "NOTE_ID — целое число",
  ).positive("NOTE_ID — положительное число").describe(
    "номер заметки (id из mpu mr comments --json)",
  ),
  mr: z.string().optional().describe(
    "MR: URL | 'group/repo!iid' | iid; без флага — открытый MR ветки",
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
export type DeleteIo = MrIo & Pick<CommandIo, "openTerminal">;

/** Ход вызова: адрес, подтверждение, DELETE. */
export async function runDelete(
  args: DeleteArgs,
  io: DeleteIo,
  options: MrOptions = {},
): Promise<DeleteResult> {
  const access = gitlabAccess(io);
  const address = await mrAddress(io, access, args.mr, options);
  if (!args.yes) {
    using terminal = await io.openTerminal();
    if (terminal === undefined) {
      // Отказ состояния, а не ввода: команда набрана верно, спросить
      // некого. И DELETE при этом не выполняется — в этом весь смысл.
      throw new DomainError("нет TTY для подтверждения — добавь --yes");
    }
    await terminal.write(
      `Удалить note ${args.note} в ${address.project}!${address.iid}? [y/N] `,
    );
    if (!isYes(await terminal.readLine())) {
      throw new DomainError("отменено");
    }
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
  errorName: "mr delete",
  summary: "Удалить свою заметку в merge request'е.",
  usage: "mpu mr delete NOTE_ID [--mr REF] [--yes]",
  help: `Удаляет заметку. Действие необратимо: GitLab удалённую заметку
не возвращает.

NOTE_ID — номер заметки, тот самый id из mpu mr comments --json и из
ссылки #note_<id>.

Без --yes команда спрашивает подтверждение в терминале. Если терминала
нет (запуск из скрипта, cron, вызов тула), она отказывается и ничего не
удаляет: молча считать «да» здесь нельзя. Для скриптов есть --yes — он
пропускает вопрос.

Чужую заметку удалить не получится: откажет сам GitLab.

--mr REF — адрес MR: URL, 'group/repo!iid' или голый iid; без флага —
открытый MR текущей ветки.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — NOTE_ID не передан или не число, нераспознанный
--mr; 1 — нет терминала без --yes, отказ человека, отказ GitLab,
несуществующая заметка.

Примеры: mpu mr delete 42; mpu mr delete 42 --yes --mr 456`,
  policy: "rw",
  argsSchema,
  forms: { note: { positional: "one" } },
  resultSchema,
  run: (args: DeleteArgs, io: DeleteIo) => runDelete(args, io),
  render: (result: DeleteResult) => renderDelete(result),
});
