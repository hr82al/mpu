/**
 * Строки таблицы `mpu glab-status` (`docs/specs/glab-status.md`):
 * разбор окна и списка репозиториев, сборка строки MR.
 *
 * Модуль чистый: сеть и git остаются в команде. Здесь живёт то, что
 * определяет смысл вывода — какие ветки считаются пайплайновыми, в
 * каком порядке они стоят и что означает «данных о ветках нет».
 */

import { UsageError } from "../command/mod.ts";
import type { MergeRequest } from "../gitlab/mod.ts";

/**
 * Ветки деплой-пайплайна в порядке колонок. Порядок — не оформление:
 * по нему оператор читает, докуда доехал MR, и перестановка сместила
 * бы смысл каждой галочки.
 */
export const PIPELINE_BRANCHES: readonly string[] = [
  "trunk",
  "main",
  "dev",
  "qa",
  "predprod",
  "prod",
];

/** Репозитории режима «мои MR» по умолчанию (спека). */
export const DEFAULT_REPOS: readonly string[] = [
  "wb/sw-front",
  "wb/sl-front",
  "wb/sw-back",
  "wb/sl-back",
  "wb/mp-config-local",
];

/** Строка результата: одна на MR. */
export interface StatusRow {
  readonly repo: string;
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly web_url: string;
  /** Ветки пайплайна с landing-коммитом, в порядке колонок. */
  readonly landed: string[];
  readonly project: string | null;
  readonly source_branch: string;
  readonly target_branch: string;
  /**
   * Прочие ветки с landing-коммитом. `null` — данных нет вовсе (refs
   * не запрашивались либо ответ 404); `[]` — запросили и пусто. Эти
   * два случая различаются в подвале, и путать их нельзя.
   */
  readonly other_branches: string[] | null;
}

/** Короткое имя репозитория: последний сегмент пути проекта. */
export function shortRepo(project: string | null): string {
  if (project === null || project === "") return "";
  const parts = project.split("/");
  return parts[parts.length - 1];
}

/**
 * Landing-коммит MR: первый непустой из merge-, squash- и head-SHA.
 * Порядок важен: у смерженного через squash MR головной коммит ветки
 * в целевой не попадает, и галочки были бы пусты.
 */
export function landingSha(mr: MergeRequest): string | undefined {
  for (const sha of [mr.merge_commit_sha, mr.squash_commit_sha, mr.sha]) {
    if (sha !== null && sha !== "") return sha;
  }
  return undefined;
}

/** Проект из веб-адреса MR: путь до маркера `/-/`. */
export function projectFromUrl(webUrl: string): string | null {
  let path: string;
  try {
    path = new URL(webUrl).pathname;
  } catch {
    return null;
  }
  const at = path.indexOf("/-/");
  if (at < 0) return null;
  const project = path.slice(0, at).replace(/^\/+|\/+$/g, "");
  return project === "" ? null : project;
}

/**
 * Разбор `--since`: `<число>{s|m|h|d}` от «сейчас» либо голое число —
 * unix-время как есть. Возвращает секунды эпохи.
 */
export function parseSince(raw: string, nowSeconds: number): number {
  const relative = /^(\d+)([smhd])$/.exec(raw.trim());
  if (relative !== null) {
    const value = Number(relative[1]);
    const scale = { s: 1, m: 60, h: 3600, d: 86400 }[relative[2]] ?? 1;
    return nowSeconds - value * scale;
  }
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  throw new UsageError(
    `--since: ожидается <число>{s|m|h|d} или unix-ts, получено '${raw}'`,
  );
}

/**
 * Момент окна в форме, которую понимает GitLab. Значение вне диапазона
 * дат — отказ команды с её текстом: `toISOString` бросил бы
 * `RangeError`, и наружу вышло бы «unexpected error» без имени
 * команды.
 */
export function isoOf(seconds: number): string {
  const at = new Date(seconds * 1000);
  if (Number.isNaN(at.getTime())) {
    throw new UsageError(`--since: значение вне диапазона дат: ${seconds}`);
  }
  return at.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Разбор `--repos`: повторы флага и значения через запятую. Имя без
 * `/` получает префикс `wb/` — так короткое `sw-front` означает то же,
 * что оператор набирает в браузере.
 */
export function parseRepos(values: readonly string[]): readonly string[] {
  const repos: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[,\s]+/)) {
      const name = part.trim();
      if (name === "") continue;
      repos.push(name.includes("/") ? name : `wb/${name}`);
    }
  }
  return repos;
}

/**
 * Строка результата по MR и веткам landing-коммита. Ветки пайплайна
 * ставятся в порядке колонок независимо от порядка ответа GitLab, а
 * source-ветка самого MR в «прочие» не идёт: она есть у любого MR и
 * ничего не говорит о продвижении.
 */
export function rowOf(
  mr: MergeRequest,
  branches: readonly string[] | undefined,
): StatusRow {
  const project = mr.project === "" ? null : mr.project;
  const found = branches === undefined ? undefined : new Set(branches);
  const landed = found === undefined
    ? []
    : PIPELINE_BRANCHES.filter((branch) => found.has(branch));
  const other = found === undefined ? null : [...found]
    .filter((branch) =>
      !PIPELINE_BRANCHES.includes(branch) && branch !== mr.source_branch
    )
    .sort();
  return {
    repo: shortRepo(project),
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    web_url: mr.web_url,
    landed,
    project,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    other_branches: other,
  };
}
