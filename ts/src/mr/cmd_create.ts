/**
 * Команда `mpu mr create` (`docs/specs/mr-write.md`): создание MR.
 *
 * Единственная подкоманда семейства без `--mr`: адресовать ещё нечего.
 * Вместо него — проект (из git remote) и исходная ветка (текущая),
 * поэтому у неё свои тексты отказов: «укажи --source» вместо «укажи
 * MR через --mr», который здесь бессмыслен.
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError } from "../command/mod.ts";
import {
  createMergeRequest,
  projectFromRemote,
  type ResolveContext,
  type RunGit,
} from "../gitlab/mod.ts";
import { spawnGit } from "../gitlab/git.ts";
import { type BodyIo, commentBody } from "./body.ts";
import {
  asCommandError,
  gitlabAccess,
  type MrIo,
  type MrOptions,
} from "./common.ts";

const argsSchema = z.object({
  title: z.string({ error: "нужен --title" }).describe("заголовок MR"),
  target: z.string({ error: "нужен --target" }).describe(
    "ветка назначения, куда вливать",
  ),
  source: z.string().optional().describe(
    "исходная ветка; без флага — текущая ветка каталога",
  ),
  project: z.string().optional().describe(
    "проект group/repo; без флага — из git remote origin",
  ),
  message: z.string().optional().describe("описание MR; необязательно"),
  "body-file": z.string().optional().describe(
    "файл с описанием; '-' — весь stdin, только в CLI",
  ),
});

const resultSchema = z.object({
  project: z.string(),
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  url: z.string().describe("web_url созданного MR"),
});

type CreateArgs = z.infer<typeof argsSchema>;
type CreateResult = z.infer<typeof resultSchema>;

/** Текущая ветка каталога; detached HEAD — свой текст (спека). */
async function currentBranch(
  context: ResolveContext,
  runGit: RunGit,
): Promise<string> {
  const outcome = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    context.cwd,
  );
  if (outcome === null) {
    throw new DomainError("git не найден в PATH — укажи --source");
  }
  if (outcome.code !== 0) {
    const reason = outcome.stderr.trim();
    throw new DomainError(
      `${reason === "" ? "git rev-parse: ошибка" : reason} — укажи --source`,
    );
  }
  const branch = outcome.stdout.trim();
  if (branch === "HEAD") {
    throw new DomainError("detached HEAD — укажи --source");
  }
  return branch;
}

/** Ход вызова: описание, проект, ветка, POST создания. */
export async function runCreate(
  args: CreateArgs,
  io: MrIo & BodyIo,
  options: MrOptions = {},
): Promise<CreateResult> {
  // Описание необязательно: без -m и -F MR создаётся с пустым.
  const description = await commentBody(args, io, false);
  const access = gitlabAccess(io);
  const runGit = options.runGit ?? spawnGit;
  const context: ResolveContext = { access, cwd: io.cwd(), runGit };
  try {
    const project = args.project ??
      await projectFromRemote(context, "укажи --project");
    const source = args.source ?? await currentBranch(context, runGit);
    const mr = await createMergeRequest(access, project, {
      source_branch: source,
      target_branch: args.target,
      title: args.title,
      description,
    });
    return {
      project,
      iid: mr.iid,
      title: mr.title,
      state: mr.state,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      url: mr.web_url,
    };
  } catch (err) {
    throw asCommandError(io, err);
  }
}

export function renderCreate(result: CreateResult): string {
  return `создан MR ${result.project}!${result.iid} — ${result.title} ` +
    `[${result.state}]\n` +
    `branch: ${result.source_branch} → ${result.target_branch}\n` +
    `${result.url}\n`;
}

export const mrCreateCommand = defineCommand({
  path: ["mr", "create"],
  errorName: "mr create",
  summary: "Создать merge request из текущей ветки.",
  usage:
    "mpu mr create --title TEXT --target BRANCH [--source B] [--project P] [-m|-F]",
  help: `Создаёт merge request.

--title и --target обязательны: заголовок и ветка, куда вливать.
--source — исходная ветка; без флага берётся текущая ветка каталога, а
в detached HEAD команда отказывается и просит указать её явно.
--project group/repo; без флага берётся из git remote origin.

Описание необязательно: -m/--message TEXT либо -F/--body-file PATH
('-' — весь stdin, только в CLI). Без обоих MR создаётся с пустым
описанием; оба сразу — ошибка ввода.

Повторный вызов на ту же исходную ветку GitLab отклоняет: открытый MR
у ветки может быть только один.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех; 2 — нет --title или --target, оба флага описания; 1 —
detached HEAD без --source, git недоступен, отказ GitLab (в том числе
уже существующий MR ветки).

Примеры: mpu mr create --title 'feat: загрузчик' --target main;
mpu mr create --title 'fix' --target main --source hotfix -F тело.md`,
  policy: "rw",
  argsSchema,
  forms: { message: { short: "m" }, "body-file": { short: "F" } },
  resultSchema,
  run: (args: CreateArgs, io: MrIo & BodyIo) => runCreate(args, io),
  render: (result: CreateResult) => renderCreate(result),
});
