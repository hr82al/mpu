/**
 * Рабочая область и её репозитории (`platform/code-analyzer.md`,
 * «Ввод/вывод»).
 *
 * Корень ищется по файлу-сентинелу, а не настраивается: ключа конфига у
 * слоя нет, и заводить его в замороженный реестр незачем — сентинел уже
 * лежит в корне и служит той же цели соседнему тулингу.
 */

import { VerbatimError } from "../command/mod.ts";
import { gitTreeMark, type MarkSource, type RunGit } from "./mark.ts";

/** Файл, по которому опознаётся корень рабочей области. */
export const SENTINEL = ".mp-workspace-root";

/** Репозиторий рабочей области, готовый к разбору. */
export interface Repo {
  readonly name: string;
  readonly root: string;
  readonly mark: MarkSource;
}

/**
 * Корень рабочей области: ближайший предок `from` с сентинелом. Ни у
 * одного предка его нет — отказ: догадываться о корне нельзя, ответ на
 * чужом дереве хуже отсутствия ответа.
 */
export function findWorkspaceRoot(from: string): string {
  for (let dir = from; dir !== ""; dir = dir.slice(0, dir.lastIndexOf("/"))) {
    if (exists(`${dir}/${SENTINEL}`)) return dir;
  }
  // Префикс здесь `mpu code`, а не имя команды: отказ принадлежит
  // общему слою семейства, и текст его задаёт слой
  // (`platform/code-analyzer.md`, «Граничные случаи»).
  throw new VerbatimError(
    `mpu code: рабочая область не найдена: сентинела ${SENTINEL} нет ни у одного предка ${from}`,
  );
}

/**
 * Репозитории рабочей области — подкаталоги первого уровня с `.git`.
 * Список снимается с диска на каждый вызов: кэш, собранный на одной
 * ветке и прочитанный на другой, уверенно врёт.
 */
export function readRepos(root: string, run: RunGit): readonly Repo[] {
  const found: Repo[] = [];
  for (const entry of Deno.readDirSync(root)) {
    if (!entry.isDirectory) continue;
    const repoRoot = `${root}/${entry.name}`;
    if (!exists(`${repoRoot}/.git`)) continue;
    found.push({
      name: entry.name,
      root: repoRoot,
      mark: () => gitTreeMark(run, repoRoot, entry.name),
    });
  }
  if (found.length === 0) {
    throw new VerbatimError("mpu code: в рабочей области нет репозиториев");
  }
  return found.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Репозиторий, внутри которого лежит каталог `dir`. */
export function repoOf(
  repos: readonly Repo[],
  dir: string,
): Repo | undefined {
  return repos.find((repo) =>
    dir === repo.root || dir.startsWith(`${repo.root}/`)
  );
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
