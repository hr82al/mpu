/**
 * Ход `mpu build` (`docs/specs/build.md`): пересобрать программу и
 * заменить установленную.
 *
 * Три примитива, из которых выводится всё остальное: собрать по
 * аргументам задачи, спросить экземпляр по пути, заменить файл по пути.
 * `--check` — та же последовательность, оборванная после проверки
 * сборки.
 */

import { DomainError } from "../command/mod.ts";
import { BuildTaskError, compileArgs } from "./mod.ts";

/** Исход запуска программы. */
export interface RunOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Запуск программы — единственный выход сборки наружу. */
export type RunAt = (
  bin: string,
  args: readonly string[],
  cwd?: string,
) => Promise<RunOutcome>;

const decoder = new TextDecoder();

/** Настоящий запуск: умолчание шва, а не подстановка вызывающего. */
export const spawnAt: RunAt = async (bin, args, cwd) => {
  const output = await new Deno.Command(bin, {
    args: [...args],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

/** Где искали дерево исходников и что нашли. */
export interface TreeSearch {
  /** Найденное дерево; ни один кандидат не подошёл — `undefined`. */
  readonly tree: string | undefined;
  /**
   * Проверенные места в том порядке, в каком проверялись, — каждое
   * описанием попытки, а не только удавшимся путём: отказ обязан
   * назвать оба места, включая то, где и складывать-то было нечего.
   */
  readonly checked: readonly string[];
}

/**
 * Дерево исходников: два кандидата в названном порядке — каталог рядом
 * с работающей программой и рабочая область по сентинелу. Догадываться
 * нельзя: собрать не тот исходник хуже, чем не собрать.
 *
 * @param binDir каталог, в котором лежит работающая программа
 * @param cwd текущий каталог вызова
 */
export async function findSourceTree(
  binDir: string,
  cwd: string,
): Promise<TreeSearch> {
  const candidates = [
    besideProgram(binDir),
    await workspaceTree(cwd),
  ] as const;
  const checked = candidates.map((candidate) => candidate.checked);
  for (const candidate of candidates) {
    if (candidate.tree === undefined) continue;
    if (await isSourceTree(candidate.tree)) {
      return { tree: candidate.tree, checked };
    }
  }
  return { tree: undefined, checked };
}

/** Проверенное место: путь-кандидат и то, как о нём рассказать. */
interface Candidate {
  readonly tree: string | undefined;
  readonly checked: string;
}

/** Первый кандидат: программа лежит в `<дерево>/bin`. */
function besideProgram(binDir: string): Candidate {
  if (!binDir.endsWith("/bin")) {
    return {
      tree: undefined,
      checked: `рядом с программой: ${binDir} — не <дерево>/bin`,
    };
  }
  const tree = binDir.slice(0, -"/bin".length);
  return { tree, checked: `рядом с программой: ${tree}` };
}

/** Второй кандидат: `<корень рабочей области>/mpu/ts` по сентинелу. */
async function workspaceTree(cwd: string): Promise<Candidate> {
  let dir = cwd;
  while (true) {
    if (await exists(`${dir}/.mp-workspace-root`)) {
      const tree = `${dir}/mpu/ts`;
      return { tree, checked: `рабочая область: ${tree}` };
    }
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === "" || parent === dir) {
      return {
        tree: undefined,
        checked:
          `рабочая область: сентинел .mp-workspace-root не найден от ${cwd}`,
      };
    }
    dir = parent;
  }
}

async function isSourceTree(dir: string): Promise<boolean> {
  return await exists(`${dir}/deno.jsonc`) && await exists(`${dir}/main.ts`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Что нужно сборке от окружения вызова. */
export interface BuildPlan {
  /** Дерево исходников. */
  readonly tree: string;
  /** Путь установки: заменяется как путь, по ссылке не идём. */
  readonly target: string;
  /** Значение `$HOME` в правах собираемого бинаря. */
  readonly home: string;
  /** Значение `$XDG_CONFIG_HOME` там же. */
  readonly configHome: string;
}

/** Чем сборка ходит наружу. */
export interface BuildDeps {
  readonly run: RunAt;
  /**
   * Перезапуск службы MCP, если она работает; отвечает, был ли
   * перезапуск. Решает служба, а не сборка.
   */
  readonly restartService: () => Promise<boolean>;
}

/** Что сборка сделала: то же, что печатает команда. */
export interface BuildOutcome {
  readonly tree: string;
  readonly target: string;
  /** Версия собранного кандидата; `--check` — `null`. */
  readonly version: string | null;
  /** Версия, стоявшая по пути установки; её не было — `null`. */
  readonly previous: string | null;
  readonly installed: boolean;
  /** Судьба службы; установка не трогалась — `null`. */
  readonly service: "restarted" | "untouched" | null;
}

/**
 * Собирает и устанавливает. Порядок жёсткий: проверка сборки — до
 * всякого касания пути установки, установленное — под проверкой, и
 * прежний экземпляр живёт до тех пор, пока новое не ответило.
 *
 * @param plan дерево, путь установки и каталоги прав
 * @param check не трогать установку: оборвать после проверки сборки
 */
export async function build(
  plan: BuildPlan,
  deps: BuildDeps,
  check: boolean,
): Promise<BuildOutcome> {
  const previous = await installedVersion(plan.target, deps.run);
  await runSmoke(plan.tree, deps.run);
  if (check) {
    return {
      tree: plan.tree,
      target: plan.target,
      version: null,
      previous,
      installed: false,
      service: null,
    };
  }
  const version = await installCandidate(plan, deps.run);
  const restarted = await deps.restartService();
  return {
    tree: plan.tree,
    target: plan.target,
    version,
    previous,
    installed: true,
    service: restarted ? "restarted" : "untouched",
  };
}

/**
 * Проверка сборки — не устанавливаемого экземпляра: у экземпляра smoke
 * подменены `HOME` и каталог конфигурации, иначе проверка писала бы в
 * настоящий домашний каталог.
 */
async function runSmoke(tree: string, run: RunAt): Promise<void> {
  const outcome = await runDeno(["task", "smoke"], tree, run);
  if (outcome.code === 0) return;
  // Упавшую проверку называет stderr: в stdout smoke пишет только
  // `ok`/`skip`, а `FAIL <имя>` и итог — в stderr (`scripts/smoke.ts`).
  const said = outcome.stderr.trim();
  throw new DomainError(
    `\`deno task smoke\` завершился с ${outcome.code}, установка не тронута` +
      `${said === "" ? "" : `:\n${said}`}`,
  );
}

/** Запуск `deno`: его отсутствие — отказ с причиной, а не трасса. */
async function runDeno(
  args: readonly string[],
  cwd: string,
  run: RunAt,
): Promise<RunOutcome> {
  try {
    return await run("deno", args, cwd);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new DomainError("deno не найден: сборку нечем запустить", {
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Собирает кандидата рядом с целью, проверяет его на месте и заменяет
 * им цель. Возвращает версию установленного.
 */
async function installCandidate(plan: BuildPlan, run: RunAt): Promise<string> {
  const candidate = `${plan.target}.new`;
  const saved = `${plan.target}.prev`;
  await ensureTargetDir(plan.target);
  await compile(plan, candidate, run);
  try {
    await probe(candidate, run);
  } catch (err) {
    // Кандидат не ответил — наружу уходит именно это; неудача уборки
    // временного файла заменила бы причину следствием.
    await Deno.remove(candidate).catch(() => {});
    throw err;
  }
  // Прежний экземпляр сохраняется до тех пор, пока новое не ответило:
  // между двумя переименованиями по пути установки всегда лежит целая
  // программа.
  const hadPrevious = await exists(plan.target);
  if (hadPrevious) await Deno.rename(plan.target, saved);
  await Deno.rename(candidate, plan.target);
  try {
    const version = await probe(plan.target, run);
    // Каталог установки лежит в PATH: оставленный `mpu.prev` был бы
    // работающей командой прежней версии.
    if (hadPrevious) await Deno.remove(saved);
    return version;
  } catch (err) {
    if (hadPrevious) await Deno.rename(saved, plan.target);
    throw err;
  }
}

/**
 * Каталог установки существует и доступен на запись. Проверяется
 * зондом, а не одним `mkdir`: на существующем каталоге `mkdir` успешен
 * независимо от прав, и нехватка вылезла бы позже — отказом сборщика
 * или неперехваченным `rename`, где путь уже не назовёшь.
 */
async function ensureTargetDir(target: string): Promise<void> {
  const dir = target.slice(0, target.lastIndexOf("/"));
  try {
    await Deno.mkdir(dir, { recursive: true });
    const probe = `${target}.probe`;
    await Deno.writeTextFile(probe, "");
    await Deno.remove(probe);
  } catch (err) {
    throw asWriteRefusal(err, dir);
  }
}

/**
 * Отказ в записи — понятным текстом с путём. `NotCapable` наравне с
 * `PermissionDenied`: нехватку собственного `--allow-write` Deno 2
 * называет первым, отказ файловой системы — вторым, а читателю нужен
 * один и тот же путь.
 */
function asWriteRefusal(err: unknown, dir: string): unknown {
  if (
    err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.NotCapable
  ) {
    return new DomainError(`нет прав на запись по пути установки: ${dir}`, {
      cause: err,
    });
  }
  return err;
}

async function compile(
  plan: BuildPlan,
  out: string,
  run: RunAt,
): Promise<void> {
  const args = await buildTaskArgs(plan, out);
  const outcome = await runDeno(args, plan.tree, run);
  if (outcome.code === 0) return;
  throw new DomainError(
    `сборка упала с ${outcome.code}:\n${outcome.stderr}${outcome.stdout}`,
  );
}

/**
 * Аргументы сборки из задачи `build` найденного дерева. Отбор дерева
 * смотрит только на `deno.jsonc` и `main.ts`, поэтому сюда доходит и
 * чужое дерево: невнятная задача — отказ с именем дерева, а не трасса.
 */
async function buildTaskArgs(
  plan: BuildPlan,
  out: string,
): Promise<string[]> {
  const path = `${plan.tree}/deno.jsonc`;
  try {
    return compileArgs(await Deno.readTextFile(path), {
      home: plan.home,
      configHome: plan.configHome,
      out,
    });
  } catch (err) {
    if (err instanceof BuildTaskError) {
      throw new DomainError(`${path}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Экземпляр по пути отвечает `version` и `--help`. Спрашивается своим
 * экземпляром, а не установленным: проверяется именно тот файл.
 */
async function probe(path: string, run: RunAt): Promise<string> {
  const version = await run(path, ["version"]);
  if (version.code !== 0) {
    throw new DomainError(
      `${path} не ответил на version (${version.code}): ` +
        `${version.stderr.trim()}`,
    );
  }
  const help = await run(path, ["--help"]);
  if (help.code !== 0) {
    throw new DomainError(
      `${path} не ответил на --help (${help.code}): ${help.stderr.trim()}`,
    );
  }
  return version.stdout.trim();
}

/**
 * Версия установленного до замены; по пути ничего нет или оно не
 * отвечает — `null`. Первая установка не особый случай: экземпляра нет,
 * и версии у него нет тоже.
 */
async function installedVersion(
  target: string,
  run: RunAt,
): Promise<string | null> {
  if (!await exists(target)) return null;
  try {
    const outcome = await run(target, ["version"]);
    const version = outcome.stdout.trim();
    return outcome.code === 0 && version !== "" ? version : null;
  } catch (err) {
    // По пути установки может лежать что угодно — каталог, чужой
    // неисполняемый файл: «версии нет» и есть ответ про такое.
    if (
      err instanceof Deno.errors.NotFound ||
      err instanceof Deno.errors.PermissionDenied ||
      err instanceof Deno.errors.NotCapable ||
      err instanceof Deno.errors.IsADirectory
    ) return null;
    throw err;
  }
}
