/**
 * Пишущие команды канала (`task.md`, «CLI-контракт»): заведение проекта,
 * постановка и сообщения видов к текущей порции. `rule` и `owner-answer`
 * объявлены «пишет только человек» — решает владелец политики, не они.
 */

import { z } from "@zod/zod";
import {
  type Command,
  defineCommand,
  type OwnerOnly,
  UsageError,
} from "../command/mod.ts";
import {
  ANSWER,
  DECISION,
  type Kind,
  OWNER,
  OWNER_ANSWER,
  QUESTION,
  REPORT,
  RESUME,
  RULE,
  STOP,
} from "./kind.ts";
import { bodyOf, PROJECT, type TaskIo, withJournal } from "./glue.ts";
import { SETUP_TEXT } from "./texts.ts";

const TEXT = z.string().optional().describe(
  "тело сообщения; stdin — ввод строки",
);
const FILE = z.string().optional().describe("файл с телом сообщения");

/** Пустой результат записи: печатать нечего. */
const NOTHING = z.object({});

const BODY_HELP =
  `Тело — text: (одно слово; из нескольких — ^…^; stdin — ввод) или
file: (путь), ровно одно из двух; хранится и печатается побайтово.`;

const setupArgs = z.object({
  project: z.string().optional().describe("имя проекта: завести или обновить"),
  note: z.string().optional().describe("заметка проекта для status"),
});

export const taskSetupCommand: Command = defineCommand({
  path: ["task", "setup"],
  keys: {},
  errorName: "task setup",
  summary: "Заводит проект канала и печатает инструкцию по работе в нём.",
  usage: "mpu task setup [project: ИМЯ [note: ТЕКСТ]]",
  help: `Звать один раз на проект, до первой постановки: без него канал
отказывает любой записи. Без ключей только печатает инструкцию.

project: — завести проект (повтор того же имени обновляет note:);
note: — заметка, которую показывает status.

stdout — инструкция: роли и единственный вход, изоляция исполнителя,
строки для CLAUDE.md проекта, первый цикл командами, частые ошибки.

Exit: 0; 2 — note: без project:.`,
  examples: [
    "mpu ask task setup",
    "mpu ask task setup project: demo note: ^игрушечный проект^",
  ],
  policy: "rw",
  text: true,
  argsSchema: setupArgs,
  resultSchema: z.object({ text: z.string() }),
  run: (args, io: TaskIo) => Promise.resolve(setup(args, io)),
  render: (result) => result.text,
});

function setup(args: z.infer<typeof setupArgs>, io: TaskIo) {
  const name = args.project;
  if (name === undefined) {
    if (args.note !== undefined) throw new UsageError("note: без project:");
    return { text: SETUP_TEXT };
  }
  withJournal(
    io,
    (projects) => projects.setup(name, args.note ?? null, Date.now()),
  );
  return { text: SETUP_TEXT };
}

const postArgs = z.object({
  force: z.boolean().default(false).describe(
    "заменить неотработанную постановку; номер порции не растёт",
  ),
  project: PROJECT,
  text: TEXT,
  file: FILE,
});

export const taskPostCommand: Command = defineCommand({
  path: ["task", "post"],
  keys: {},
  errorName: "task post",
  summary: "Кладёт постановку: открывает следующую порцию проекта.",
  usage: "mpu task post [force] project: ИМЯ text: ТЕКСТ | file: ПУТЬ",
  help: `Звать хосту, когда постановка порции готова: только она открывает
работу исполнителю. Номер порции — на единицу больше максимального.

Последнее сообщение проекта — неотработанная постановка: отказ; вариант
force кладёт новую постановку вместо неё в ту же порцию (прежняя остаётся
в журнале), номер не растёт.

${BODY_HELP}

Exit: 0; 1 — порция не отработана (без force) или заменять нечего (force);
2 — нет проекта, тело пустое или задано дважды.`,
  examples: [
    "mpu task post project: demo file: постановка.md",
    "mpu task post force project: demo text: ^сделай y^",
  ],
  policy: "rw",
  text: true,
  argsSchema: postArgs,
  resultSchema: NOTHING,
  run: async (args, io: TaskIo) => {
    const body = await bodyOf(args, io);
    withJournal(io, (projects, depth) => {
      const project = projects.at(args.project);
      if (args.force) project.replace(body, Date.now(), depth);
      else project.post(body, Date.now(), depth);
    });
    return {};
  },
  render: () => "",
});

const attachArgs = z.object({ project: PROJECT, text: TEXT, file: FILE });

type AttachArgs = z.infer<typeof attachArgs>;

/** Что отличает команду вида: вид, справка и кто пишет. */
interface KindCommand {
  readonly kind: Kind;
  readonly summary: string;
  /** Первый абзац справки: когда звать. */
  readonly when: string;
  /** Пишет только человек; нет — строку решают правила. */
  readonly ownerOnly?: OwnerOnly<AttachArgs>;
}

/** Команда вида: сообщение к текущей (максимальной) порции проекта. */
function kindCommand(spec: KindCommand): Command {
  const word = spec.kind.word;
  return defineCommand({
    path: ["task", word],
    keys: {},
    errorName: `task ${word}`,
    summary: spec.summary,
    usage: `mpu task ${word} project: ИМЯ text: ТЕКСТ | file: ПУТЬ`,
    help: `${spec.when}

Сообщение прикрепляется к текущей (максимальной) порции проекта.

${BODY_HELP}

Exit: 0; 2 — нет проекта, порций ещё нет, тело пустое или задано дважды.`,
    examples: [`mpu task ${word} project: demo text: ^…^`],
    policy: "rw",
    text: true,
    argsSchema: attachArgs,
    resultSchema: NOTHING,
    ownerOnly: spec.ownerOnly,
    run: async (args, io: TaskIo) => {
      const body = await bodyOf(args, io);
      withJournal(
        io,
        (projects, depth) =>
          projects.at(args.project).attach(spec.kind, body, Date.now(), depth),
      );
      return {};
    },
    render: () => "",
  });
}

/** Вид пишет только человек: вопрос и отказ по спеке («Правила»). */
function ownedBy(kind: Kind): OwnerOnly<AttachArgs> {
  return {
    question: (args) =>
      `записать от имени владельца: ${kind.word} в ${args.project}? [y/N] `,
    refusal: () => `писать ${kind.word} может только человек`,
  };
}

/** Сообщения видов в порядке таблицы спеки. */
export const taskKindCommands: readonly Command[] = [
  {
    kind: REPORT,
    summary: "Кладёт отчёт исполнителя о текущей порции.",
    when: "Звать исполнителю, когда порция сделана: отчёт передаёт ход хосту.",
  },
  {
    kind: QUESTION,
    summary: "Кладёт вопрос исполнителя по текущей порции.",
    when:
      "Звать исполнителю, когда спека молчит или противоречит себе: вопрос\n" +
      "передаёт ход хосту вместо догадки.",
  },
  {
    kind: ANSWER,
    summary: "Кладёт ответ хоста на вопрос исполнителя.",
    when: "Звать хосту в ответ на question: ответ возвращает ход исполнителю.",
  },
  {
    kind: DECISION,
    summary: "Записывает решение хоста и правило, по которому решено.",
    when:
      "Звать хосту, когда вопрос решён правилами проекта: решение попадает\n" +
      "в mpu task decisions и переживает переписку сессий. Хода не меняет.",
  },
  {
    kind: OWNER,
    summary: "Кладёт вопрос владельцу, который правила не решают.",
    when: "Звать хосту, когда правила проекта вопроса не решают: ход «ждёт\n" +
      "владельца», пока не придёт owner-answer.",
  },
  {
    kind: OWNER_ANSWER,
    summary: "Ответ владельца: закрывает последний открытый owner.",
    when:
      "Пишет только человек: строка всегда спрашивает подтверждение, мимо\n" +
      "правил; «нет» или без человека — отказ, код 1, журнал не меняется.",
    ownerOnly: ownedBy(OWNER_ANSWER),
  },
  {
    kind: RULE,
    summary: "Правило проекта; действует последняя редакция.",
    when:
      "Пишет только человек: строка всегда спрашивает подтверждение, мимо\n" +
      "правил; «нет» или без человека — отказ, код 1. Правила печатает\n" +
      "mpu task decisions.",
    ownerOnly: ownedBy(RULE),
  },
].map(kindCommand);

const stopArgs = z.object({
  project: PROJECT,
  text: z.string().optional().describe("причина остановки; умолчание — стоп"),
});

/** Причина остановки, когда её не назвали (`task-orchestrator.md`). */
const STOP_BODY = "стоп";

export const taskStopCommand: Command = defineCommand({
  path: ["task", "stop"],
  keys: {},
  errorName: "task stop",
  summary: "Останавливает шаги оркестратора по проекту.",
  usage: "mpu task stop project: ИМЯ [text: ПРИЧИНА]",
  help: `Звать хосту на блокере, который правила проекта не решают: оркестратор
перестаёт будить роли проекта (окна не трогает, не чистит), status
показывает ход «остановлен». Снимает стоп только mpu task resume.

text: — причина (умолчание — стоп); ложится в журнал видом stop, к
текущей порции (порций нет — к порции 0).

Exit: 0; 2 — нет проекта.`,
  examples: ["mpu task stop project: demo text: ^нужен ключ API^"],
  policy: "rw",
  text: true,
  argsSchema: stopArgs,
  resultSchema: NOTHING,
  run: (args, io: TaskIo) => {
    steer(io, args.project, STOP, args.text ?? STOP_BODY);
    return Promise.resolve({});
  },
  render: () => "",
});

export const taskResumeCommand: Command = defineCommand({
  path: ["task", "resume"],
  keys: {},
  errorName: "task resume",
  summary: "Возобновляет шаги оркестратора по остановленному проекту.",
  usage: "mpu task resume project: ИМЯ",
  help: `Звать человеку, когда блокер остановленного проекта снят: оркестратор
снова будит роли, status показывает прежний ход. Решает человек — строка
по умолчанию спрашивает подтверждение.

Ложится в журнал видом resume к текущей порции (порций нет — к порции 0).

Exit: 0; 2 — нет проекта.`,
  examples: ["mpu ask task resume project: demo"],
  policy: "rw",
  text: true,
  argsSchema: z.object({ project: PROJECT }),
  resultSchema: NOTHING,
  run: (args, io: TaskIo) => {
    steer(io, args.project, RESUME, RESUME.word);
    return Promise.resolve({});
  },
  render: () => "",
});

function steer(io: TaskIo, name: string, kind: Kind, body: string) {
  withJournal(
    io,
    (projects, depth) => projects.at(name).steer(kind, body, Date.now(), depth),
  );
}
