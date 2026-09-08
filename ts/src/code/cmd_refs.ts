/**
 * Команда `mpu code refs` (`specs/code-refs.md`): кто ещё ссылается на
 * этот символ и кто читает этот модуль.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { ProjectBuildError } from "./project.ts";
import { type Address, parseAddress } from "./address.ts";
import { renderMark, renderMarkOnly } from "./mark.ts";
import { openAnalyzer } from "./open.ts";
import {
  collectRefs,
  type RefsResult,
  refsResultSchema,
  refusedRefs,
} from "./refs.ts";
import { scopeText, treeMarkOf } from "./answer.ts";
import { spawnGit } from "./git.ts";
import {
  findWorkspaceRoot,
  readRepos,
  type Repo,
  repoOf,
} from "./workspace.ts";

/** Предел записей в разделе по умолчанию; запись — не строка. */
const DEFAULT_LIMIT = 200;

const argsSchema = z.object({
  address: z.string().min(1, "адрес обязателен: [РЕПОЗИТОРИЙ:]ПУТЬ[:СТРОКА]"),
  limit: z.number().int().positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

export const codeRefsCommand = defineCommand({
  path: ["code", "refs"],
  summary: "кто ссылается на символ и кто читает модуль",
  usage: "mpu code refs АДРЕС [--limit N]",
  help: `АДРЕС = [РЕПОЗИТОРИЙ:]ПУТЬ[:СТРОКА]. Со строкой — потребители
символа, объявленного в ней; без строки — файлы, читающие модуль.

Место потребителя — файл и строка, которой он символ получает.
Обращения внутри файла местами не считаются: один файл берёт символ
один раз, а зовёт сколько угодно.

Печатается также область видимости символа — одной строкой — и раздел
«не разрешено», всегда, в том числе нулевой.

Путь относителен корню репозитория. Репозиторий опущен — берётся тот,
внутри которого лежит текущий рабочий каталог. Репозитории рабочей
области — подкаталоги с .git у ближайшего предка с файлом
.mp-workspace-root.

  --limit N   предел записей в разделе, не строк (по умолчанию 200)

Exit: 0 — ответ, включая пустой перечень и усечение; 2 — ошибка ввода
(нет такого репозитория, файла или объявления в строке); 1 — объявления
здесь не разбираются: в репозитории нет проектов либо файл не входит ни
в один из них, и потребителей символа спросить не у чего.

Примеры:
  mpu code refs sl-back:src/orders/mod.ts:42   потребители символа
  mpu code refs sl-back:src/orders/mod.ts      читатели модуля`,
  policy: "ro",
  argsSchema,
  forms: { address: { positional: "one" } },
  resultSchema: refsResultSchema,
  run: (args, io) => runRefs(args, io),
  render: renderRefs,
  // Отказ раздела — не ответ: у команды с одним разделом он и есть
  // отказ команды (`platform/code-analyzer.md`).
  textExitCode: (result) => result.section.kind === "refused" ? 1 : 0,
});

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура живёт вне git и репозиторием по правилу «подкаталог
 * с `.git`» не является, а проверять команду надо целиком.
 */
export async function runRefs(
  args: { readonly address: string; readonly limit: number },
  io: Pick<CommandIo, "cwd">,
  repos?: readonly Repo[],
): Promise<RefsResult> {
  // Адрес разбирается первым: он не зависит от окружения, и ошибка в
  // нём не должна маскироваться отказом «рабочая область не найдена».
  const address = parseAddress(args.address);
  const repo = resolveRepo(address, io.cwd(), repos);
  try {
    return await collectRefs(
      address,
      args.limit,
      repo,
      await openAnalyzer(repo, address.path),
    );
  } catch (err) {
    // Отказ ПОСТРОЕНИЯ печатается разделом, а не уходит в stderr: он
    // относится к репозиторию, а не к вызову, и в ответе по нескольким
    // репозиториям соседи обязаны ответить (`platform/code-analyzer.md`).
    if (!(err instanceof ProjectBuildError)) throw err;
    return refusedRefs(await repo.mark(), err.message);
  }
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
  const known = repos ?? readRepos(findWorkspaceRoot(cwd), spawnGit);
  return address.repo === undefined
    ? currentRepo(known, cwd)
    : named(known, address.repo);
}

/** Репозиторий, названный в адресе. */
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

/**
 * Текст ответа. Три части, и ни одна не опускается: шапка с отметкой и
 * гарантией, найденное, «не разрешено» — в том числе нулевое.
 */
export function renderRefs(result: RefsResult): string {
  const section = result.section;
  if (section.kind === "refused") {
    return `${
      renderMarkOnly(treeMarkOf(section.mark))
    }\n  отказ: ${section.refusal}\n`;
  }
  const blocks = [
    renderMark(treeMarkOf(section.mark), section.guarantee),
    section.symbol === null
      ? `модуль ${section.target.path}`
      : `${declarationLine(section.symbol)}\n  ${
        scopeText(section.symbol.scope)
      }`,
    renderSection(section),
    renderUnresolved(section.unresolved),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/** Раздел, который ответил. */
type AnsweredRefs = Extract<RefsResult["section"], { kind: "answer" }>;

/**
 * Строка объявления: имя и сигнатура. Печатает её только разбор по
 * типам — текстовый объявлений не выдаёт вовсе.
 */
function declarationLine(symbol: NonNullable<AnsweredRefs["symbol"]>): string {
  // Форма вызова примыкает к имени через пробел (`addDays (day: string)`),
  // тип — через двоеточие (`limit: number`): иначе выходит `limit :
  // number` с пробелом перед двоеточием.
  return symbol.signature.startsWith("(")
    ? `${symbol.name} ${symbol.signature}`
    : `${symbol.name}: ${symbol.signature}`;
}

/** Раздел найденного: заголовок со счётчиком и строки под ним. */
function renderSection(section: AnsweredRefs): string {
  const noun = section.target.kind === "module" ? "читатели" : "потребители";
  const { total, places } = section.consumers;
  if (total === 0) return `${noun}: 0`;
  const lines = places.map((place) => `  ${place.path}:${place.line}`);
  if (places.length < total) {
    lines.push(`  усечено: показано ${places.length} из ${total}`);
  }
  return [`${noun}: ${total} ${files(total)}`, ...lines].join("\n");
}

/** Раздел «не разрешено»: печатается всегда, в том числе нулевой. */
export function renderUnresolved(
  unresolved: AnsweredRefs["unresolved"],
): string {
  const { total, items } = unresolved;
  const lines = items.map((item) =>
    `  ${item.path}:${item.line} → ${item.specifier} — ${item.reason}`
  );
  if (items.length < total) {
    lines.push(`  усечено: показано ${items.length} из ${total}`);
  }
  return [`не разрешено: ${total}`, ...lines].join("\n");
}

/** Согласование слова «файл» с числом. */
function files(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return "файлов";
  const last = count % 10;
  if (last === 1) return "файл";
  if (last >= 2 && last <= 4) return "файла";
  return "файлов";
}
