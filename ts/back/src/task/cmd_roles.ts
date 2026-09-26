/**
 * Команды профилей ролей и отметок (`task-roles.md`, «CLI-контракт»):
 * `role` пишет только человек — решает владелец политики, не правило;
 * отметки `busy`/`idle` ставит сама роль.
 */

import { z } from "@zod/zod";
import {
  type Command,
  defineCommand,
  items,
  UsageError,
} from "../command/mod.ts";
import { age } from "./cmd_read.ts";
import { PROJECT, type TaskIo, withJournal } from "./glue.ts";
import {
  type MarkWord,
  PROFILE_DEFAULTS,
  type ProfileInput,
  profileOf,
  roleNamed,
  type RoleRecord,
} from "./roles.ts";

const ROLE = z.string({ error: "нужен role: host|exec" }).describe(
  "роль проекта: host или exec",
);

const NOTHING = z.object({});

const roleArgs = z.object({
  forget: z.boolean().default(false).describe("удалить профиль роли"),
  project: PROJECT,
  role: ROLE,
  dir: z.string().optional().describe("каталог запуска, абсолютный"),
  powers: z.string().optional().describe(
    "полномочия текстом — в первое сообщение роли дословно",
  ),
  session: z.string().optional().describe("сессия tmux"),
  window: z.string().optional().describe("окно tmux"),
  model: z.string().optional().describe("модель Claude Code"),
  mode: z.string().optional().describe("режим разрешений"),
  "add-dir": z.array(z.string()).default([]).describe(
    "каталог вне каталога запуска; повторяемый",
  ),
  read: z.array(z.string()).default([]).describe(
    "файл, который роль читает первым; повторяемый",
  ),
});

type RoleArgs = z.infer<typeof roleArgs>;

export const taskRoleCommand: Command = defineCommand({
  path: ["task", "role"],
  keys: {},
  texts: ["powers"],
  errorName: "task role",
  summary: "Записывает профиль роли проекта; forget — удаляет.",
  usage: "mpu task role [forget] project: ИМЯ role: host|exec " +
    "dir: ПУТЬ powers: ТЕКСТ [ключи профиля]",
  help: `Звать человеку, решая, как оркестратор запускает роль: каталог,
модель, режим и полномочия сессии. Пишет только человек: строка всегда
спрашивает подтверждение, мимо правил; без человека — отказ, код 1.

Профиль заменяется целиком: не названное в строке — умолчание, а не
прежнее значение. dir: (абсолютный) и powers: обязательны; session:
(${PROFILE_DEFAULTS.session}), window: (<проект>-<роль>),
model: (${PROFILE_DEFAULTS.model}), mode: (${PROFILE_DEFAULTS.mode}); add-dir: и read: повторяются.
Каталог роли другого проекта — отказ.
forget удаляет профиль роли.

Exit: 0; 1 — нет человека или «нет»; 2 — нет проекта, роль не host|exec,
dir: нет, не абсолютный или занят.`,
  examples: [
    "mpu task role project: demo role: exec dir: /home/u/demo powers: ^прод — только чтение^",
    "mpu task role forget project: demo role: exec",
  ],
  policy: "rw",
  text: true,
  argsSchema: roleArgs,
  resultSchema: NOTHING,
  ownerOnly: {
    question: (args: RoleArgs) =>
      `изменить профиль роли: ${args.project} ${args.role}? [y/N] `,
    refusal: () => "менять профиль роли может только человек",
  },
  run: (args, io: TaskIo) => {
    withJournal(io, (projects) => {
      const roles = projects.at(args.project).roles();
      const role = roleNamed(args.role);
      if (args.forget) return roles.forget(role);
      roles.put(role, profileOf(args.project, role, profileInput(args)));
    });
    return Promise.resolve({});
  },
  render: () => "",
});

/**
 * Профиль из строки. Проверки — после согласия владельца, а не схемой:
 * отказ разбора до согласия увёл бы строку к правилам пути, а у `role`
 * их нет.
 */
function profileInput(args: RoleArgs): ProfileInput {
  const { dir, powers } = args;
  if (dir === undefined) {
    throw new UsageError("нет dir: — каталог запуска обязателен");
  }
  if (!dir.startsWith("/")) {
    throw new UsageError(`dir: — абсолютный путь, получено ${dir}`);
  }
  if (powers === undefined) {
    throw new UsageError("нет powers: — полномочия обязательны");
  }
  return { ...args, dir, powers };
}

const rolesResult = z.object({
  rows: z.array(z.object({
    role: z.string(),
    mark: z.string().nullable(),
    mark_age_s: z.number().nullable(),
    session: z.string(),
    window: z.string(),
    dir: z.string(),
    model: z.string(),
    mode: z.string(),
    add_dir: z.array(z.string()),
    read: z.array(z.string()),
    powers: z.string(),
  })),
});

type RolesResult = z.infer<typeof rolesResult>;

export const taskRolesCommand: Command = defineCommand({
  path: ["task", "roles"],
  keys: {},
  errorName: "task roles",
  summary: "Профили ролей проекта и их отметки busy/idle.",
  usage: "mpu task roles project: ИМЯ",
  help: `Звать, чтобы узнать, как запускается роль и занята ли она: профиль
и отметка из кэш-БД, экран и tmux не читаются.

Блок на роль, блоки через пустую строку: роль, отметка (busy, idle, - —
не было) и её возраст (Ns|m|h|d); затем session:, window:, model:, mode:;
dir:; add-dir: и read: по строке на значение; powers:. Роль без профиля
не печатается. end json — записи role, mark, mark_age_s, session, window,
dir, model, mode, add_dir, read, powers.

Exit: 0; 2 — нет проекта.`,
  examples: [
    "mpu task roles project: demo",
    "mpu task roles project: demo end json",
  ],
  policy: "ro",
  argsSchema: z.object({
    project: PROJECT,
    json: z.boolean().default(false).describe("массив записей JSON"),
  }),
  resultSchema: rolesResult,
  data: items<RolesResult>({
    records: (result) => result.rows,
    with: (_result, records) => ({ rows: records }),
  }),
  run: (args, io: TaskIo) =>
    Promise.resolve(withJournal(io, (projects) => {
      const now = Date.now();
      const all = projects.at(args.project).roles().all();
      return { rows: all.map((role) => role.record(now)) };
    })),
  render: (result, args) =>
    args.json
      ? `${JSON.stringify(result.rows)}\n`
      : result.rows.map(roleBlock).join("\n"),
});

function roleBlock(row: RoleRecord): string {
  const marked = row.mark_age_s === null ? "-" : age(row.mark_age_s);
  return [
    `${row.role}  ${row.mark ?? "-"}  ${marked}`,
    `  session: ${row.session}  window: ${row.window}  model: ${row.model}  mode: ${row.mode}`,
    `  dir: ${row.dir}`,
    ...row.add_dir.map((dir) => `  add-dir: ${dir}`),
    ...row.read.map((file) => `  read: ${file}`),
    `  powers: ${row.powers}`,
  ].map((line) => `${line}\n`).join("");
}

/** Команда отметки: роль говорит о себе `word` со временем. */
function markCommand(word: MarkWord, when: string): Command {
  return defineCommand({
    path: ["task", word],
    keys: {},
    errorName: `task ${word}`,
    summary: `Отмечает роль проекта: ${word}.`,
    usage: `mpu task ${word} project: ИМЯ role: host|exec`,
    help: `${when}

Хранится только последняя отметка роли и её время; roles печатает её
возраст.

Exit: 0; 2 — нет проекта или роль не host|exec.`,
    examples: [`mpu task ${word} project: demo role: exec`],
    policy: "rw",
    text: true,
    argsSchema: z.object({ project: PROJECT, role: ROLE }),
    resultSchema: NOTHING,
    run: (args, io: TaskIo) => {
      withJournal(
        io,
        (projects) =>
          projects.at(args.project).roles().mark(
            roleNamed(args.role),
            word,
            Date.now(),
          ),
      );
      return Promise.resolve({});
    },
    render: () => "",
  });
}

export const taskMarkCommands: readonly Command[] = [
  markCommand(
    "busy",
    "Звать роли, начиная работу: оркестратор не очищает занятую роль.",
  ),
  markCommand(
    "idle",
    "Звать роли, закончив работу: по отметке оркестратор понимает, что её\n" +
      "можно очистить, не читая экран.",
  ),
];
