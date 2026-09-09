/**
 * Обход репозиториев рабочей области (`platform/code-analyzer.md`,
 * «Стоимость ответа»).
 *
 * Одно место на четыре поверхности, и в нём два вопроса: какие
 * репозитории берёт окно вопроса и как их обходят. Прежде обход был у
 * `name` и у `mentions` свой, а выбор репозитория повторялся трижды —
 * правка стоимости трогала бы каждую поверхность отдельно, хотя
 * решение у них одно.
 */

import { UsageError } from "../command/mod.ts";
import type { Address } from "./address.ts";
import { spawnGit } from "./git.ts";
import {
  findWorkspaceRoot,
  readRepos,
  type Repo,
  repoOf,
} from "./workspace.ts";

/**
 * Репозитории рабочей области. Подставленный перечень берётся как
 * есть: дерево-фикстура репозиторием по правилу «подкаталог с `.git`»
 * не является, а проверять команды надо целиком.
 */
function knownRepos(
  cwd: string,
  repos?: readonly Repo[],
): readonly Repo[] {
  return repos ?? readRepos(findWorkspaceRoot(cwd), spawnGit);
}

/**
 * Репозитории окна: названный в нём либо вся рабочая область. Общий на
 * `name` и `mentions` — правило окна у них одно.
 */
export function windowRepos(
  cwd: string,
  repo: string | undefined,
  repos?: readonly Repo[],
): readonly Repo[] {
  const known = knownRepos(cwd, repos);
  return repo === undefined ? known : [named(known, repo)];
}

/**
 * Репозиторий адреса: названный в нём либо тот, внутри которого лежит
 * рабочий каталог. Общий для всех поверхностей семейства — правило
 * разрешения одно на всех.
 */
export function resolveRepo(
  address: Address,
  cwd: string,
  repos?: readonly Repo[],
): Repo {
  const known = knownRepos(cwd, repos);
  return address.repo === undefined
    ? currentRepo(known, cwd)
    : named(known, address.repo);
}

/**
 * Разделы ответа: по одному на репозиторий, в порядке перечня. Порядок
 * задаёт слой (`platform/code-analyzer.md`, «Форма ответа»), поэтому он
 * и здесь свойство перечня, а не порядка исполнения.
 *
 * Обход пока последовательный, тогда как спека уже требует
 * параллельного: параллельность приходит следующим коммитом и заменяет
 * ровно эту функцию — ради чего обход сюда и сведён.
 */
export async function sectionsOf<S>(
  repos: readonly Repo[],
  sectionOf: (repo: Repo) => Promise<S>,
): Promise<S[]> {
  const sections: S[] = [];
  for (const repo of repos) sections.push(await sectionOf(repo));
  return sections;
}

/** Репозиторий, названный в окне или адресе. */
function named(repos: readonly Repo[], name: string): Repo {
  const found = repos.find((repo) => repo.name === name);
  if (found !== undefined) return found;
  throw new UsageError(`неизвестный репозиторий '${name}'`, {
    details: repos.map((repo) => `  ${repo.name}`).join("\n"),
  });
}

/** Репозиторий текущего каталога; вне репозиториев — отказ. */
function currentRepo(repos: readonly Repo[], cwd: string): Repo {
  const found = repoOf(repos, cwd);
  if (found !== undefined) return found;
  throw new UsageError(
    `каталог ${cwd} вне репозиториев рабочей области`,
    { hint: "mpu code refs РЕПОЗИТОРИЙ:ПУТЬ" },
  );
}
