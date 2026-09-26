/**
 * Читающие команды канала (`task.md`, «CLI-контракт», «Вывод»): правила
 * письма, тело сообщения, ожидание, статус, журнал и документ решений.
 * `history clear` — режим журнала: звено пути правила со своим посевом.
 */

import { z } from "@zod/zod";
import {
  type Command,
  defineCommand,
  DomainError,
  items,
  record,
  UsageError,
} from "../command/mod.ts";
import { kindNamed } from "./kind.ts";
import { contractError, PROJECT, type TaskIo, withJournal } from "./glue.ts";
import {
  ANY_KIND,
  type Decisions,
  type HistoryRow,
  onlyKind,
  type Project,
  type Projects,
  type StatusRow,
} from "./project.ts";
import { RULES_TEXT } from "./texts.ts";

const SOME_PROJECT = z.string().optional().describe(
  "имя проекта; без него — все проекты",
);
const TEXT_RESULT = z.object({ text: z.string() });
/** `end json` записи печатает массивом записей (`task.md`, «CLI-контракт»). */
const JSON_RECORDS = z.boolean().default(false).describe("массив записей JSON");

/** Строки записей текстом или массивом JSON. */
function rendered<T>(
  rows: readonly T[],
  json: boolean,
  line: (row: T) => string,
): string {
  if (json) return `${JSON.stringify(rows, null, 2)}\n`;
  return rows.map(line).join("");
}

export const taskRulesCommand: Command = defineCommand({
  path: ["task", "rules"],
  keys: {},
  errorName: "task rules",
  summary: "Печатает правила письма спецификаций с причинами.",
  usage: "mpu task rules",
  help: `Звать перед первой спекой проекта и при сомнении, как её писать:
правила одни для всех проектов канала, состояния команда не читает.

stdout — четырнадцать правил с причинами. Exit: 0.`,
  examples: ["mpu task rules"],
  policy: "ro",
  text: true,
  argsSchema: z.object({}),
  resultSchema: TEXT_RESULT,
  run: () => Promise.resolve({ text: RULES_TEXT }),
  render: (result) => result.text,
});

const readArgs = z.object({
  keep: z.boolean().default(false).describe("не помечать прочитанным"),
  project: PROJECT,
  kind: z.string().optional().describe("вид сообщения; без него — любой"),
});

export const taskReadCommand: Command = defineCommand({
  path: ["task", "read"],
  keys: {},
  errorName: "task read",
  summary: "Печатает тело последнего сообщения проекта.",
  usage: "mpu task read [keep] project: ИМЯ [kind: ВИД]",
  help: `Звать, чтобы забрать постановку, отчёт или ответ, не дожидаясь:
печатает последнее сообщение (или последнее вида kind:) и помечает его
прочитанным; вариант keep — не помечать.

Виды: task, report, question, answer, decision, owner, owner-answer, rule.

stdout — тело побайтово, как подано. Exit: 0; 1 — таких сообщений нет;
2 — нет проекта или неизвестный вид.`,
  examples: [
    "mpu task read project: demo",
    "mpu task read keep project: demo kind: report",
  ],
  policy: "ro",
  text: true,
  argsSchema: readArgs,
  resultSchema: TEXT_RESULT,
  run: (args, io: TaskIo) =>
    Promise.resolve(withJournal(io, (projects) => {
      const pick = args.kind === undefined
        ? ANY_KIND
        : onlyKind(kindNamed(args.kind));
      return { text: projects.at(args.project).read(pick, args.keep) };
    })),
  render: (result) => result.text,
});

/** Опрос журнала при ожидании (`task.md`, «Побочные эффекты»). */
const POLL_MS = 2000;

/** Часы и сон ожидания: параметры, чтобы тест вёл время сам. */
export interface Waiting {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Настоящие часы и сон, прерываемый просьбой остановиться. */
export const REAL_TIME: Waiting = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      signal.addEventListener("abort", stop, { once: true });
    }),
};

const waitArgs = z.object({
  project: PROJECT,
  kind: z.string({ error: "нужен kind: <вид>" }).describe(
    "вид ожидаемого сообщения",
  ),
  timeout: z.number().int().min(0).default(3600).describe(
    "сколько ждать, секунды",
  ),
});

type WaitArgs = z.infer<typeof waitArgs>;

/**
 * Команда `wait` с часами `waiting`: тесты подставляют свои.
 *
 * @param waiting часы и сон
 */
export function waitCommand(waiting: Waiting): Command {
  return defineCommand({
    path: ["task", "wait"],
    keys: {},
    errorName: "task wait",
    summary: "Ждёт непрочитанного сообщения вида и печатает его тело.",
    usage: "mpu task wait project: ИМЯ kind: ВИД [timeout: СЕК]",
    help: `Звать фоном, отдав свою часть: исполнитель после отчёта ждёт task,
хост после постановки — report или question. Сессия просыпается, когда
сообщение легло, без участия человека.

Опрос раз в 2 с, соединение с базой между опросами не держится. Найденное
помечается прочитанным; уже прочитанное не возвращается.
timeout: — секунды, умолчание 3600.

stdout — тело побайтово. Exit: 0; 1 — не пришло за timeout:; 2 — нет
проекта или неизвестный вид.`,
    examples: ["mpu task wait project: demo kind: report timeout: 600"],
    policy: "ro",
    text: true,
    argsSchema: waitArgs,
    resultSchema: TEXT_RESULT,
    run: async (args, io: TaskIo) => ({
      text: await awaited(args, io, waiting),
    }),
    render: (result) => result.text,
  });
}

/** Тело первого подходящего опроса; срок вышел — отказ. */
function awaited(
  args: WaitArgs,
  io: TaskIo,
  waiting: Waiting,
): Promise<string> {
  const kind = contracted(() => kindNamed(args.kind));
  const deadline = waiting.now() + args.timeout * 1000;
  // Опрос отдаёт продолжение, а исполняется оно после `withJournal`:
  // соединение закрыто раньше, чем начнётся сон до следующего опроса.
  const poll = (): Promise<string> =>
    withJournal(io, (projects) =>
      projects.at(args.project).take(
        kind,
        (body) => () => Promise.resolve(body),
        () => later,
      ))();
  const later = async (): Promise<string> => {
    const left = deadline - waiting.now();
    if (left <= 0) {
      throw new DomainError(
        `${kind.word} в ${args.project} не пришёл за ${args.timeout} с`,
      );
    }
    await waiting.sleep(Math.min(POLL_MS, left), io.signal);
    return await poll();
  };
  return poll();
}

/** Отказ канала на границе разбора — классом контракта. */
function contracted<T>(act: () => T): T {
  try {
    return act();
  } catch (err) {
    throw contractError(err);
  }
}

const statusResult = z.object({
  rows: z.array(z.object({
    project: z.string(),
    portion: z.number(),
    turn: z.string(),
    last: z.string().nullable(),
    age_s: z.number().nullable(),
    unread: z.boolean(),
    note: z.string(),
  })),
});

type StatusResult = z.infer<typeof statusResult>;

export const taskStatusCommand: Command = defineCommand({
  path: ["task", "status"],
  keys: {},
  errorName: "task status",
  summary: "Строка на проект: порция, чей ход, последнее сообщение.",
  usage: "mpu task status [project: ИМЯ]",
  help: `Звать, чтобы понять, кто кого ждёт: ход выводится из журнала, а не
хранится. Ход — ждёт исполнителя (последнее из task, answer), ждёт хоста
(report, question), ждёт владельца (owner без owner-answer после него —
важнее прочих), - у пустого проекта.

Строка: проект, порция N, ход, вид последнего, возраст (Ns|m|h|d),
непрочитано|-, заметка — через два пробела. end json — записи project,
portion, turn, last, age_s, unread, note.

Exit: 0; 2 — нет проекта.`,
  examples: ["mpu task status", "mpu task status project: demo end json"],
  policy: "ro",
  argsSchema: z.object({ project: SOME_PROJECT, json: JSON_RECORDS }),
  resultSchema: statusResult,
  data: items<StatusResult>({
    records: (result) => result.rows,
    with: (_result, records) => ({ rows: records }),
  }),
  run: (args, io: TaskIo) =>
    Promise.resolve(withJournal(io, (projects) => ({
      rows: chosen(projects, args.project).map((one) => one.status(Date.now())),
    }))),
  render: (result, args) => rendered(result.rows, args.json, statusLine),
});

/** Проекты строки: один по имени или все. */
function chosen(projects: Projects, name: string | undefined): Project[] {
  return name === undefined ? projects.all() : [projects.at(name)];
}

function statusLine(row: StatusRow): string {
  return [
    row.project,
    `порция ${row.portion}`,
    row.turn,
    row.last ?? "-",
    row.age_s === null ? "-" : age(row.age_s),
    row.unread ? "непрочитано" : "-",
    row.note,
  ].join("  ") + "\n";
}

/** Возраст крупнейшей целой единицей: секунды, минуты, часы, дни. */
export function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const historyArgs = z.object({
  mode: z.string().optional().describe("режим: clear"),
  project: SOME_PROJECT,
  limit: z.number().int().min(1).optional().describe(
    "сколько сообщений показать",
  ),
  json: JSON_RECORDS,
});

const historyResult = z.object({
  rows: z.array(z.object({
    project: z.string(),
    portion: z.number(),
    kind: z.string(),
    at: z.string(),
    first_line: z.string(),
  })),
});

type HistoryResult = z.infer<typeof historyResult>;

/** Режим чистки журнала: сообщение листа и звено пути правила. */
export const CLEAR = "clear";

/** Что делает `history` с журналами проектов. */
interface HistoryAct {
  run(projects: readonly Project[], limit: number | undefined): HistoryResult;
}

const LISTING: HistoryAct = {
  run: (projects, limit) => ({ rows: freshFirst(projects).slice(0, limit) }),
};

const CLEARING: HistoryAct = {
  run(projects) {
    for (const one of projects) one.clear();
    return { rows: [] };
  },
};

/** Действие по входу режима (граница разбора): нет — список. */
function historyAct(mode: string | undefined): HistoryAct {
  if (mode === undefined) return LISTING;
  if (mode === CLEAR) return CLEARING;
  throw new UsageError(`неизвестный режим ${mode}`);
}

export const taskHistoryCommand: Command = defineCommand({
  path: ["task", "history"],
  keys: {},
  modes: {
    [CLEAR]: {
      purpose: "удалить журнал, кроме текущей порции",
      label: "чистка журнала",
      fixed: { mode: CLEAR },
      // Ключ входа режима есть только внутри режима: вне его строка не
      // может задать чистку ключом и обойти правило «task history clear».
      keys: { project: "project", mode: "mode" },
    },
  },
  errorName: "task history",
  summary: "Журнал сообщений от свежего к старому; clear — чистка.",
  usage: "mpu task history [project: ИМЯ] [limit: N] | clear [project: ИМЯ]",
  help: `Звать, чтобы восстановить ход порции или найти сообщение: строка на
сообщение — проект, порция, вид, время ISO, первая строка тела. Журнал
хранит task.history порций (mpu config), чистится при записи.

clear удаляет всё, кроме текущей порции (спрашивает подтверждение).
end json — записи project, portion, kind, at, first_line.

Exit: 0; 2 — нет проекта.`,
  examples: [
    "mpu task history project: demo limit: 20",
    "mpu ask task history clear project: demo",
  ],
  policy: "rw",
  argsSchema: historyArgs,
  forms: { mode: { positional: "one" } },
  resultSchema: historyResult,
  data: items<HistoryResult>({
    records: (result) => result.rows,
    with: (_result, records) => ({ rows: records }),
  }),
  run: (args, io: TaskIo) =>
    Promise.resolve(withJournal(
      io,
      (projects) =>
        historyAct(args.mode).run(chosen(projects, args.project), args.limit),
    )),
  render: (result, args) => rendered(result.rows, args.json, historyLine),
});

/** Журналы проектов вместе, от свежего к старому. */
function freshFirst(projects: readonly Project[]): HistoryRow[] {
  return projects.flatMap((one) => one.history())
    .sort((a, b) => b.at.localeCompare(a.at));
}

function historyLine(row: HistoryRow): string {
  return [row.project, row.portion, row.kind, row.at, row.first_line]
    .join("  ") + "\n";
}

const decisionsArgs = z.object({
  project: PROJECT,
  query: z.string().optional().describe("слово в сообщениях порций"),
  limit: z.number().int().min(1).default(5).describe(
    "сколько последних порций показать",
  ),
});

const decisionsResult = z.object({
  rules: z.string().nullable(),
  portions: z.array(z.object({
    portion: z.number(),
    items: z.array(z.object({
      kind: z.string(),
      at: z.string(),
      text: z.string(),
    })),
  })),
});

export const taskDecisionsCommand: Command = defineCommand({
  path: ["task", "decisions"],
  keys: {},
  errorName: "task decisions",
  summary: "Правила проекта и решения последних порций одним документом.",
  usage: "mpu task decisions project: ИМЯ [query: СЛОВО] [limit: N]",
  help: `Звать перед решением вопроса исполнителя и перед постановкой:
действующие правила и прежние решения в одном месте, вместо поиска по
переписке.

Markdown: ## Правила (последняя редакция rule), затем ## Порция N и под
ним - вид: тело (decision, owner, owner-answer в порядке журнала) —
последние limit: порций, где есть что показать (умолчание 5). query: —
только сообщения со словом (без учёта регистра), по всему журналу; раздел
правил печатается всегда.

end json — {rules, portions: [{portion, items: [{kind, at, text}]}]}.

Exit: 0; 2 — нет проекта.`,
  examples: [
    "mpu task decisions project: demo",
    "mpu task decisions project: demo query: мерж",
  ],
  policy: "ro",
  argsSchema: decisionsArgs,
  resultSchema: decisionsResult,
  data: record<Decisions>((result) => result),
  run: (args, io: TaskIo) =>
    Promise.resolve(
      withJournal(io, (projects) =>
        projects.at(args.project).decisions(args.query ?? "", args.limit)),
    ),
  render: (result) => decisionsText(result),
});

function decisionsText(decisions: Decisions): string {
  const rules = `## Правила\n\n${decisions.rules ?? "(нет)"}\n`;
  const portions = decisions.portions.map((one) =>
    `\n## Порция ${one.portion}\n\n` +
    one.items.map((item) => `- ${item.kind}: ${item.text}\n`).join("")
  );
  return rules + portions.join("");
}
