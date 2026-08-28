/**
 * Команда `mpu glab-status` (`docs/specs/glab-status.md`): прохождение
 * MR по веткам деплой-пайплайна одной таблицей.
 *
 * Два режима. Без аргументов — мои MR за окно по выбранным
 * репозиториям; с адресами — ровно перечисленные MR, любых авторов, а
 * окно и фильтр репозиториев не действуют.
 *
 * Формы адреса MR берутся из атома (`platform/gitlab-api.md`): URL,
 * `group/repo!iid` и голый iid с проектом из git remote. Своя копия
 * этого разбора разошлась бы с `mpu mr` ровно там, где оператор ждёт
 * одинакового поведения.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import {
  commitBranches,
  type GitlabAccess,
  type MergeRequest,
  mergeRequest,
  mergeRequestOf,
  type MrAddress,
  MrRefError,
  myMergeRequests,
  parseMrRef,
  projectFromRemote,
  type RawObject,
  type ResolveContext,
  type RunGit,
} from "../gitlab/mod.ts";
import { spawnGit } from "../gitlab/git.ts";
import { asCommandError, gitlabAccess, type MrIo } from "../mr/common.ts";
import {
  DEFAULT_REPOS,
  isoOf,
  landingSha,
  parseRepos,
  parseSince,
  projectFromUrl,
  rowOf,
  type StatusRow,
} from "./rows.ts";
import { headline, renderFooter, renderRows } from "./render.ts";

const argsSchema = z.object({
  mr: z.array(z.string()).default([]).describe(
    "адреса MR: URL | 'group/repo!iid' | iid; без них — мои MR за окно",
  ),
  since: z.string().optional().describe(
    "окно режима «мои MR»: <число>{s|m|h|d} или unix-ts; дефолт 7d",
  ),
  repos: z.array(z.string()).default([]).describe(
    "репозитории режима «мои MR»: через запятую либо повтором флага",
  ),
  branches: z.boolean().default(false).describe(
    "печатать «прочие ветки» полным списком; только с адресом MR",
  ),
  json: z.boolean().default(false).describe("массив строк JSON"),
});

const rowSchema = z.object({
  repo: z.string(),
  iid: z.number(),
  title: z.string(),
  state: z.string(),
  web_url: z.string(),
  landed: z.array(z.string()),
  project: z.union([z.string(), z.null()]),
  source_branch: z.string(),
  target_branch: z.string(),
  other_branches: z.union([z.array(z.string()), z.null()]),
});

const resultSchema = z.object({
  rows: z.array(rowSchema).describe("строки таблицы: одна на MR"),
  selectors: z.boolean().describe("режим адресов MR"),
  columns: z.union([z.number(), z.null()]).describe(
    "ширина терминала для усечения заголовка; null — без ограничения",
  ),
});

type StatusArgs = z.infer<typeof argsSchema>;
type StatusResult = z.infer<typeof resultSchema>;

/**
 * Срез порта: доступ к GitLab, служебная печать и признаки терминала.
 * Ширина нужна усечению заголовка, а `progress` — строке о пустом
 * результате: она идёт в stderr, а не в stdout (спека).
 */
export type StatusIo =
  & MrIo
  & Pick<CommandIo, "env" | "progress" | "stdoutIsTerminal">;

/** Подстановки для тестов: живого GitLab и git у них нет. */
export interface StatusOptions {
  readonly runGit?: RunGit;
  readonly nowSeconds?: number;
  /** Ширина терминала в тестах; `null` — без ограничения. */
  readonly columns?: number | null;
}

/** Дефолтное окно режима «мои MR». */
const DEFAULT_SINCE = "7d";

/**
 * Подсказка при 404: селектор здесь позиционный, флага `--mr` у
 * команды нет вовсе (`glab-status.md`, «Граничные случаи»).
 */
const NOT_FOUND_HINT = "проверь адрес MR (URL | 'group/repo!iid' | iid)";

/** Разбор адреса MR по правилам атома; project — из git при нужде. */
async function addressOf(
  io: StatusIo,
  access: GitlabAccess,
  selector: string,
  runGit: RunGit,
): Promise<MrAddress> {
  // Разбор — атомный: `parseMrRef` либо даёт iid, либо отказывает
  // сам, поэтому своей ветки «iid не определился» здесь нет. Деривация
  // iid из текущей ветки командой не используется: адрес называет
  // человек (спека).
  const parsed = parseMrRef(selector, access.baseUrl);
  if (parsed.iid === undefined) throw new Error("unreachable");
  if (parsed.project !== undefined) {
    return { project: parsed.project, iid: parsed.iid };
  }
  const context: ResolveContext = { access, cwd: io.cwd(), runGit };
  try {
    // Голый iid: проект берётся из git remote — то же правило, что у
    // `mpu mr`, и подсказка своя, потому что флага `--mr` здесь нет.
    const project = await projectFromRemote(
      context,
      "укажи MR как 'group/repo!iid' или полным URL",
    );
    return { project, iid: parsed.iid };
  } catch (err) {
    if (err instanceof MrRefError) {
      // Разбор адреса — до сети, значит ошибка ввода: правило у команды
      // общее с `mpu mr` (`glab-status.md`, «Граничные случаи»).
      throw new UsageError(`MR '${selector}': ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/** Строка по одному MR: шапка плюс ветки landing-коммита. */
async function statusOf(
  access: GitlabAccess,
  mr: MergeRequest,
): Promise<StatusRow> {
  const sha = landingSha(mr);
  // Ветки спрашиваются только у смерженного MR с известным проектом:
  // у остальных ответа всё равно нет, а лишний вызов стоил бы времени
  // на каждой строке таблицы.
  const ask = mr.state === "merged" && sha !== undefined &&
    mr.project_id !== null;
  const branches = ask
    ? await commitBranches(access, mr.project_id as number, sha as string)
    : undefined;
  return rowOf(mr, branches);
}

/** Ход вызова: режим по наличию адресов. */
export async function runGlabStatus(
  args: StatusArgs,
  io: StatusIo,
  options: StatusOptions = {},
): Promise<StatusResult> {
  const selectors = args.mr.length > 0;
  // Конфликты режимов — до чтения токена и до сети: вызов заведомо
  // неверен, и незачем спрашивать у оператора доступ ради отказа.
  const misplaced = [
    ...(args.since !== undefined ? ["--since"] : []),
    ...(args.repos.length > 0 ? ["--repos"] : []),
  ];
  if (selectors && misplaced.length > 0) {
    // Оба флага названы разом: убрав только первый, оператор получил
    // бы второй отказ следующим вызовом (спека).
    const named = misplaced.join("/");
    throw new UsageError(
      `${named} — только для режима «мои MR», с адресом MR не сочетается`,
      { hint: `убрать ${named} либо вызвать mpu glab-status без адресов MR` },
    );
  }
  if (!selectors && args.branches) {
    throw new UsageError(
      "--branches применяется только с адресом MR",
      { hint: "указать адрес MR либо убрать флаг" },
    );
  }

  const access = gitlabAccess(io);
  const runGit = options.runGit ?? spawnGit;
  try {
    const rows = selectors
      ? await selectedRows(io, access, args.mr, runGit)
      : await myRows(access, args, options);
    if (rows.length === 0 && !selectors && !args.json) {
      // Молчание не отличить от «команда что-то проглотила»: строка
      // говорит, что искали и не нашли (спека, exit 0).
      io.progress("(нет моих MR за интервал в выбранных репозиториях)");
    }
    return { rows: [...rows], selectors, columns: columnsOf(io, options) };
  } catch (err) {
    // Правило кодов общее с `mpu mr`: 2 — всё, что разобрано до сети,
    // 1 — всё после обращения наружу (`glab-status.md`, сведено
    // 2026-08-28). Своего перевода на границе команды поэтому нет.
    throw asCommandError(io, err, NOT_FOUND_HINT);
  }
}

/** Режим адресов: ровно перечисленные MR, повторы схлопываются. */
async function selectedRows(
  io: StatusIo,
  access: GitlabAccess,
  selectors: readonly string[],
  runGit: RunGit,
): Promise<readonly StatusRow[]> {
  const seen = new Set<string>();
  const rows: StatusRow[] = [];
  for (const selector of selectors) {
    const address = await addressOf(io, access, selector, runGit);
    const key = `${address.project}!${address.iid}`;
    // Один и тот же MR, названный двумя формами, — это один MR.
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(await statusOf(access, await mergeRequest(access, address)));
  }
  return rows;
}

/** Режим «мои MR»: окно, фильтр репозиториев, порядок (repo, iid). */
async function myRows(
  access: GitlabAccess,
  args: StatusArgs,
  options: StatusOptions,
): Promise<readonly StatusRow[]> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const since = parseSince(args.since ?? DEFAULT_SINCE, nowSeconds);
  const repos = args.repos.length > 0 ? parseRepos(args.repos) : DEFAULT_REPOS;
  const raw = await myMergeRequests(access, isoOf(since));
  const rows: StatusRow[] = [];
  for (const item of raw) {
    const mr = withProject(item);
    // closed и locked в «моих MR» не показываются: команда про
    // продвижение работы, а не про её историю.
    if (mr.state !== "opened" && mr.state !== "merged") continue;
    if (mr.project === "" || !repos.includes(mr.project)) continue;
    rows.push(await statusOf(access, mr));
  }
  return rows.sort((a, b) =>
    a.repo === b.repo ? a.iid - b.iid : a.repo.localeCompare(b.repo)
  );
}

/** Проект глобального ответа восстанавливается из `web_url`. */
function withProject(raw: RawObject): MergeRequest {
  const url = typeof raw.web_url === "string" ? raw.web_url : "";
  return mergeRequestOf(raw, projectFromUrl(url) ?? "");
}

/**
 * Ширина терминала: подстановка теста, затем `COLUMNS`, затем размер
 * консоли. Решается в `run`, потому что `render` среды не видит — тот
 * же приём, что у `mpu kiten card` с видом вывода.
 */
function columnsOf(io: StatusIo, options: StatusOptions): number | null {
  if (options.columns !== undefined) return options.columns;
  const declared = Number(io.env("COLUMNS"));
  if (Number.isInteger(declared) && declared > 0) return declared;
  if (!io.stdoutIsTerminal()) return null;
  try {
    return Deno.consoleSize().columns;
  } catch {
    // Консоли нет (пайп, cron) — ограничения тоже нет.
    return null;
  }
}

/** Вывод: JSON, таблица либо строка о пустом результате. */
export function renderGlabStatus(
  result: StatusResult,
  args: StatusArgs,
): string {
  if (args.json) return `${JSON.stringify(result.rows, null, 2)}\n`;
  if (result.rows.length === 0) return "";
  const table = renderRows(result.rows, result.columns);
  if (!result.selectors) return table;
  const heads = result.rows.map((row) => `${headline(row)}\n`).join("");
  return `${heads}\n${table}${renderFooter(result.rows, args.branches)}`;
}

export const glabStatusCommand = defineCommand({
  path: ["glab-status"],
  errorName: "glab-status",
  summary: "Прохождение merge request'ов по веткам деплой-пайплайна.",
  usage:
    "mpu glab-status [MR]... [--since S] [--repos R] [--branches] [--json]",
  help: `Показывает таблицей, до каких веток пайплайна доехал каждый MR:
колонка на ветку (trunk, main, dev, qa, predprod, prod), галочка — ветка
содержит landing-коммит MR.

Без аргументов печатает мои MR за окно: по умолчанию неделя и пять
репозиториев. --since задаёт окно (<число>{s|m|h|d} или unix-ts),
--repos — репозитории через запятую или повтором флага; имя без слэша
получает префикс wb/. Пустой список — одна строка-объяснение, не ошибка.

С адресами MR показывает ровно их, любых авторов и репозиториев; окно и
фильтр репозиториев тогда не действуют, и указывать их вместе с адресом
нельзя. Адрес — URL, 'group/repo!iid' или голый iid: во втором случае
проект берётся из git remote текущего каталога.

У каждого MR печатается шапка и подвал «прочие ветки» — ветки с
landing-коммитом вне пайплайна. --branches раскрывает их списком.
«(MR не смержен)» и «(нет данных)» — разные вещи: во втором случае
ветки спрашивали, но GitLab не ответил.

Ветки спрашиваются только у смерженного MR: у остальных landed пуст, и
это корректные данные, а не ошибка.

--json печатает массив строк со всеми полями, включая полный список
прочих веток.

Ключи env-файла: GLAB_TOKEN (обязателен), GITLAB_BASE_URL
(необязателен).

Exit: 0 — успех, включая пустой список; 1 — отказ GitLab, неразбираемый
адрес, конфликт режимов; 2 — неизвестный флаг.

Примеры: mpu glab-status; mpu glab-status --since 2d;
mpu glab-status 'group/repo!456' --branches`,
  policy: "ro",
  argsSchema,
  forms: { mr: { positional: "rest" } },
  resultSchema,
  run: (args: StatusArgs, io: StatusIo) => runGlabStatus(args, io),
  render: (result: StatusResult, args: StatusArgs) =>
    renderGlabStatus(result, args),
});
