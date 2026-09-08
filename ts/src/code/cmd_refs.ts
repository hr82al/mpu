/**
 * Команда `mpu code refs` (`specs/code-refs.md`): кто ещё ссылается на
 * этот символ и кто читает этот модуль.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { parseAddress } from "./address.ts";
import type { Scope } from "./analyzer.ts";
import { renderMark } from "./mark.ts";
import { openAnalyzer } from "./open.ts";
import {
  collectRefs,
  markOf,
  type RefsResult,
  refsResultSchema,
} from "./refs.ts";
import { spawnGit } from "./git.ts";
import {
  findWorkspaceRoot,
  readRepos,
  type Repo,
  repoOf,
} from "./workspace.ts";

/** Предел строк в разделе по умолчанию. */
const DEFAULT_LIMIT = 200;

const argsSchema = z.object({
  address: z.string().min(1, "адрес обязателен: [РЕПОЗИТОРИЙ:]ПУТЬ[:СТРОКА]"),
  limit: z.number().int().positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

/** Три значения области видимости и четвёртое — у проекта без входа. */
const SCOPE_TEXT: Readonly<Record<Scope, string>> = {
  entry: "экспортируется из модуля и из входа проекта",
  "module-only":
    "экспортируется из модуля; из входа проекта не реэкспортируется",
  "no-entry": "экспортируется из модуля; входа у проекта нет",
  private: "приватное в модуле",
  unknown: "область видимости неизвестна: текстовый разбор",
};

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

  --limit N   предел строк в разделе (по умолчанию 200)

Exit: 0 — ответ, включая пустой перечень и усечение; 2 — ошибка ввода
(нет такого репозитория, файла или объявления в строке).

Примеры:
  mpu code refs sl-back:src/orders/mod.ts:42   потребители символа
  mpu code refs sl-back:src/orders/mod.ts      читатели модуля`,
  policy: "ro",
  argsSchema,
  forms: { address: { positional: "one" } },
  resultSchema: refsResultSchema,
  run: (args, io) => runRefs(args, io),
  render: renderRefs,
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
  const cwd = io.cwd();
  // Адрес разбирается первым: он не зависит от окружения, и ошибка в
  // нём не должна маскироваться отказом «рабочая область не найдена».
  const address = parseAddress(args.address);
  const known = repos ?? readRepos(findWorkspaceRoot(cwd), spawnGit);
  const repo = address.repo === undefined
    ? currentRepo(known, cwd)
    : named(known, address.repo);
  return await collectRefs(
    address,
    args.limit,
    repo,
    await openAnalyzer(repo, address.path),
  );
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
  const blocks = [
    renderMark(markOf(result), result.guarantee),
    result.symbol === null
      ? `модуль ${result.target.path}`
      : `${declarationLine(result.symbol)}\n  ${
        SCOPE_TEXT[result.symbol.scope]
      }`,
    renderSection(result),
    renderUnresolved(result),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Строка объявления: имя и сигнатура. Формы объявления текстовый разбор
 * не знает, и незнание называется вслух: одно имя читалось бы как
 * «у символа нет параметров», а это другой ответ
 * (`platform/code-analyzer.md`, «Чего текстовый анализатор не знает»).
 */
function declarationLine(symbol: NonNullable<RefsResult["symbol"]>): string {
  if (symbol.signature === null) {
    return `${symbol.name} — сигнатуры нет: текстовый разбор`;
  }
  // Форма вызова примыкает к имени через пробел (`addDays (day: string)`),
  // тип — через двоеточие (`limit: number`): иначе выходит `limit :
  // number` с пробелом перед двоеточием.
  return symbol.signature.startsWith("(")
    ? `${symbol.name} ${symbol.signature}`
    : `${symbol.name}: ${symbol.signature}`;
}

/** Раздел найденного: заголовок со счётчиком и строки под ним. */
function renderSection(result: RefsResult): string {
  const noun = result.target.kind === "module" ? "читатели" : "потребители";
  const { total, places } = result.consumers;
  if (total === 0) return `${noun}: 0`;
  const lines = places.map((place) => `  ${place.path}:${place.line}`);
  if (places.length < total) {
    lines.push(`  усечено: показано ${places.length} из ${total}`);
  }
  return [`${noun}: ${total} ${files(total)}`, ...lines].join("\n");
}

/** Раздел «не разрешено»: печатается всегда, в том числе нулевой. */
function renderUnresolved(result: RefsResult): string {
  const { total, items } = result.unresolved;
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
