/**
 * Резолв MR-адреса (`platform/gitlab-api.md`, «Резолв MR-адреса»):
 * селектор `--mr` либо открытый MR текущей ветки → `(project, iid)`.
 *
 * Шаги идут строго по нарастанию цены: разбор строки, затем git-
 * подпроцессы, затем сеть. Полный селектор (URL, `group/repo!iid`) не
 * запускает git вовсе — это инвариант спеки, а не оптимизация: у
 * вызова из чужого каталога git-репозитория может не быть.
 *
 * Запуск git — внедряемая функция, а не порт `CommandIo`: подменить её
 * в тесте достаточно, чтобы проверить все ветки, и настоящий git при
 * этом не нужен.
 */

import { type GitlabAccess, gitlabGetAll } from "./http.ts";
import { type RawObject } from "./model.ts";

/** Разобранный адрес MR. */
export interface MrAddress {
  readonly project: string;
  readonly iid: number;
}

/**
 * Отказ резолва: ошибка ввода (строку разобрать не удалось) либо
 * состояния (git, ветка, число открытых MR). Различие несёт вызывающий:
 * `mr-read.md` разводит их по кодам выхода 2 и 1.
 */
export class MrRefError extends Error {
  override name = "MrRefError";
  /** Разбор селектора — ошибка ввода; всё прочее — состояния. */
  readonly input: boolean;

  constructor(message: string, input: boolean) {
    super(message);
    this.input = input;
  }
}

/** Итог запуска git: код и оба потока. */
export interface GitOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Запуск локального git в заданном каталоге. `null` — исполняемого
 * файла нет в PATH: это отдельный исход, а не ненулевой код.
 */
export type RunGit = (
  args: readonly string[],
  cwd: string,
) => Promise<GitOutcome | null>;

/** Что нужно резолву: доступ к API, каталог вызова и запуск git. */
export interface ResolveContext {
  readonly access: GitlabAccess;
  readonly cwd: string;
  readonly runGit: RunGit;
}

/** Маркер MR в пути веб-адреса. */
const URL_MARKER = "/-/merge_requests/";

/** Разбор селектора: голое число, URL либо `group/repo!iid`. */
export function parseMrRef(
  ref: string,
  baseUrl: string,
): { project: string | undefined; iid: number | undefined } {
  if (/^\d+$/.test(ref)) return { project: undefined, iid: Number(ref) };
  if (/^https?:\/\//i.test(ref)) return parseMrUrl(ref, baseUrl);
  if (ref.includes("!")) {
    const cut = ref.lastIndexOf("!");
    const project = trimSlashes(ref.slice(0, cut));
    const iid = ref.slice(cut + 1);
    if (project === "" || !/^\d+$/.test(iid)) {
      throw new MrRefError(
        `ожидается 'group/repo!iid', получено '${ref}'`,
        true,
      );
    }
    return { project, iid: Number(iid) };
  }
  throw new MrRefError(
    `не удалось разобрать MR '${ref}'; формы: URL | 'group/repo!iid' | iid`,
    true,
  );
}

/** Разбор веб-адреса MR; хост обязан совпадать с базой API. */
function parseMrUrl(
  ref: string,
  baseUrl: string,
): { project: string; iid: number } {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new MrRefError(`не удалось разобрать MR-URL '${ref}'`, true);
  }
  const expected = hostPort(baseUrl);
  if (url.host !== expected) {
    // Структурно валидный URL чужого хоста отклоняется всегда: иначе
    // токен внутреннего GitLab ушёл бы на посторонний адрес.
    throw new MrRefError(
      `хост MR-URL '${url.host}' != '${expected}' (GITLAB_BASE_URL)`,
      true,
    );
  }
  const at = url.pathname.indexOf(URL_MARKER);
  if (at < 0) {
    throw new MrRefError(`не удалось разобрать MR-URL '${ref}'`, true);
  }
  const project = trimSlashes(url.pathname.slice(0, at));
  // Хвост после iid (`/diffs`, query) игнорируется: ссылка из браузера
  // приходит именно такой.
  const iid = url.pathname.slice(at + URL_MARKER.length).split("/")[0];
  if (project === "" || !/^\d+$/.test(iid)) {
    throw new MrRefError(`не удалось разобрать MR-URL '${ref}'`, true);
  }
  return { project, iid: Number(iid) };
}

/** `host[:port]` базового адреса; неразбираемый — как есть. */
function hostPort(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Путь проекта из git remote; формы ssh, scp и https. */
export function parseRemoteUrl(url: string): {
  host: string;
  path: string;
} | null {
  const trimmed = url.trim();
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    return { host: parsed.hostname, path: parsed.pathname };
  }
  // scp-форма `git@host:group/repo.git` — не URL: у неё нет схемы, а
  // двоеточие отделяет путь, а не порт.
  if (scp !== null) return { host: scp[1], path: scp[2] };
  return null;
}

/** Снимает крайние `/` и суффикс `.git`. */
function projectOf(path: string): string {
  const trimmed = trimSlashes(path);
  return trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/** Запускает git и переводит его исходы в отказы спеки. */
async function git(
  context: ResolveContext,
  args: readonly string[],
): Promise<string> {
  const outcome = await context.runGit(args, context.cwd);
  if (outcome === null) {
    throw new MrRefError("git не найден в PATH — укажи MR через --mr", false);
  }
  if (outcome.code !== 0) {
    const reason = outcome.stderr.trim();
    // Пустой stderr заменяет ПРИЧИНУ, а не всё сообщение: подсказка
    // «укажи MR через --mr» — единственное действие, которое читателю
    // поможет, и терять её вместе с текстом причины незачем.
    const cause = reason === "" ? `git ${args.join(" ")}: ошибка` : reason;
    throw new MrRefError(`${cause} — укажи MR через --mr`, false);
  }
  return outcome.stdout.trim();
}

/** Путь проекта из `git remote get-url origin`. */
export async function projectFromRemote(
  context: ResolveContext,
): Promise<string> {
  const url = await git(context, ["remote", "get-url", "origin"]);
  const remote = parseRemoteUrl(url);
  if (remote === null) {
    throw new MrRefError(`не удалось разобрать git remote '${url}'`, false);
  }
  const expected = hostPort(context.access.baseUrl).split(":")[0];
  if (remote.host !== expected) {
    // Порт в сверке не участвует: ssh-remote ходит по своему.
    throw new MrRefError(
      `git remote смотрит на '${remote.host}', а не на '${expected}' — ` +
        "укажи MR через --mr",
      false,
    );
  }
  const project = projectOf(remote.path);
  if (project === "") {
    throw new MrRefError(`пустой project в git remote '${url}'`, false);
  }
  return project;
}

/** Iid единственного открытого MR текущей ветки. */
async function iidFromBranch(
  context: ResolveContext,
  project: string,
): Promise<number> {
  const branch = await git(context, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    throw new MrRefError(
      "detached HEAD — не определить ветку, укажи MR через --mr",
      false,
    );
  }
  const opened = await openMergeRequests(context.access, project, branch);
  if (opened.length === 0) {
    throw new MrRefError(
      `нет открытого MR ветки '${branch}' в ${project} — укажи --mr`,
      false,
    );
  }
  if (opened.length > 1) {
    const list = opened
      .map((mr) => `${project}!${mr.iid} ${mr.title}`)
      .join("; ");
    throw new MrRefError(
      `несколько открытых MR ветки '${branch}': ${list} — укажи --mr`,
      false,
    );
  }
  return opened[0].iid;
}

/** Открытые MR ветки: единственный сетевой шаг резолва. */
async function openMergeRequests(
  access: GitlabAccess,
  project: string,
  branch: string,
): Promise<readonly { iid: number; title: string }[]> {
  const raw = await gitlabGetAll(
    access,
    `/projects/${encodeURIComponent(project)}/merge_requests`,
    { source_branch: branch, state: "opened" },
  );
  return raw.map((item: RawObject) => ({
    iid: typeof item.iid === "number" ? item.iid : 0,
    title: typeof item.title === "string" ? item.title : "",
  }));
}

/**
 * Адрес MR: селектор, затем git-remote для project, затем открытый MR
 * ветки для iid. Каждый следующий шаг делается только тогда, когда
 * предыдущий не дал ответа.
 */
export async function resolveMr(
  context: ResolveContext,
  ref: string | undefined,
): Promise<MrAddress> {
  let project: string | undefined;
  let iid: number | undefined;
  if (ref !== undefined) {
    const parsed = parseMrRef(ref, context.access.baseUrl);
    project = parsed.project;
    iid = parsed.iid;
  }
  if (project === undefined) project = await projectFromRemote(context);
  if (iid === undefined) iid = await iidFromBranch(context, project);
  return { project, iid };
}
