/**
 * Команда `mpu code name` (`specs/code-name.md`): не занято ли это имя
 * другим смыслом.
 *
 * Команда перечисляет объявления с сигнатурами и не описывает их
 * прозой: описание расходится с кодом молча, в отличие от сигнатуры.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { normalizeInside } from "./address.ts";
import { scopeText, treeMarkOf } from "./answer.ts";
import { renderUnresolved } from "./cmd_refs.ts";
import { renderMark, renderMarkOnly } from "./mark.ts";
import {
  collectName,
  type NameResult,
  nameResultSchema,
  type Window,
} from "./name.ts";
import { spawnGit } from "./git.ts";
import { findWorkspaceRoot, readRepos, type Repo } from "./workspace.ts";

/** Предел записей в разделе по умолчанию; запись — не строка. */
const DEFAULT_LIMIT = 200;

const argsSchema = z.object({
  name: z.string().min(1, "нужно имя объявления"),
  in: z.string().optional(),
  limit: z.number().int().positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

export const codeNameCommand = defineCommand({
  path: ["code", "name"],
  summary: "не занято ли имя другим смыслом",
  usage: "mpu code name ИМЯ [--in ОКНО] [--limit N]",
  help: `ИМЯ — точное имя объявления, без подстановочных знаков.

ОКНО = РЕПОЗИТОРИЙ либо РЕПОЗИТОРИЙ:КАТАЛОГ. Окно уровня каталога
нужно потому, что занятость имени решают объявления там, куда вносят
новое, а не во всём репозитории. Без --in отвечает КАЖДЫЙ репозиторий
рабочей области — своим разделом со своей отметкой дерева; разделы не
смешиваются даже при совпадении имён.

На объявление печатаются две строки: путь, строка и сигнатура как
объявлена — и отступом ниже область видимости. В перечень попадают
объявления любой формы: function, стрелка в const, метод; перегрузка —
отдельная запись.

Раздел «та же сигнатура, другое имя» отвечает на вторую половину
вопроса: имя может быть свободно, а вещь под другим именем уже
существовать. Совпадение считается по типам параметров, а возврат
печатается у каждого. Имя не встретилось — раздела нет вовсе.

При двух и более вызываемых объявлениях печатается строка
«типы возврата: …»; если они разные, строка оканчивается
«— различаются». Пустой перечень —
«объявления: 0», это ответ «имя свободно», а не отказ. Раздел
«не разрешено» печатается всегда, в том числе нулевой.

  --in ОКНО   где искать (по умолчанию — вся рабочая область)
  --limit N   предел записей в разделе, не строк (по умолчанию 200)

Exit: 0 — ответ, включая пустой перечень и усечение; 2 — ошибка ввода
(пустое имя, нет такого репозитория или каталога); 1 — объявления здесь
не разбираются: в репозитории нет проектов.

Примеры:
  mpu code name daysBetween --in sl-back
  mpu code name daysBetween --in sl-back:src/orders`,
  policy: "ro",
  argsSchema,
  forms: { name: { positional: "one" } },
  resultSchema: nameResultSchema,
  run: (args, io) => runName(args, io),
  render: renderName,
  // Отказ команды — только если не ответил ни один раздел
  // (`platform/code-analyzer.md`).
  textExitCode: (result) =>
    result.sections.every((section) => section.kind === "refused") ? 1 : 0,
});

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура репозиторием по правилу «подкаталог с `.git`» не
 * является, а проверять команду надо целиком.
 */
export async function runName(
  args: {
    readonly name: string;
    readonly in?: string;
    readonly limit: number;
  },
  io: Pick<CommandIo, "cwd">,
  repos?: readonly Repo[],
): Promise<NameResult> {
  const window = parseWindow(args.in);
  const known = repos ?? readRepos(findWorkspaceRoot(io.cwd()), spawnGit);
  return await collectName(
    args.name,
    window,
    args.limit,
    reposOf(known, window),
  );
}

/** Окно из строки `--in`; без него окно — вся рабочая область. */
export function parseWindow(raw: string | undefined): Window {
  if (raw === undefined) return { repo: undefined, dir: undefined };
  const parts = raw.split(":");
  if (parts.length > 2) {
    throw new UsageError(`окно разобрано неоднозначно: '${raw}'`);
  }
  if (parts[0] === "") throw new UsageError(`в окне нет репозитория: '${raw}'`);
  if (parts.length === 1) return { repo: parts[0], dir: undefined };
  if (parts[1] === "") throw new UsageError(`в окне пустой каталог: '${raw}'`);
  // Нормализация обязательна: без неё `репо:src/..` — это корень
  // репозитория, который никакому префиксу не соответствует, и ответом
  // становилось честное на вид «имя свободно» (замер разбора диффа).
  const dir = normalizeInside(parts[1], raw, "каталог окна");
  return { repo: parts[0], dir: dir === "" ? undefined : dir };
}

/** Репозитории окна: названный либо все. */
function reposOf(repos: readonly Repo[], window: Window): readonly Repo[] {
  if (window.repo === undefined) return repos;
  const found = repos.find((repo) => repo.name === window.repo);
  if (found !== undefined) return [found];
  throw new UsageError(`неизвестный репозиторий '${window.repo}'`, {
    details: repos.map((repo) => `  ${repo.name}`).join("\n"),
  });
}

/**
 * Текст ответа: по разделу на репозиторий, каждый со своей отметкой.
 * Объединённого перечня не бывает — имя занято в конкретном месте, а не
 * «где-то в рабочей области».
 */
export function renderName(result: NameResult): string {
  // Разделы разделены пустой строкой, а хвостовой перевод один на весь
  // ответ: иначе между репозиториями выходило бы три перевода подряд.
  return `${result.sections.map(renderSection).join("\n\n")}\n`;
}

function renderSection(section: NameResult["sections"][number]): string {
  if (section.kind === "refused") {
    return `${
      renderMarkOnly(treeMarkOf(section.mark))
    }\n  отказ: ${section.refusal}`;
  }
  const blocks = [
    renderMark(treeMarkOf(section.mark), section.guarantee),
    renderDeclarations(section),
    ...renderNeighbours(section),
    ...renderReturnTypes(section),
    renderUnresolved(section.unresolved),
  ];
  return blocks.join("\n\n");
}

/** Раздел, который ответил: у него есть и гарантия, и перечни. */
type AnsweredSection = Extract<
  NameResult["sections"][number],
  { kind: "answer" }
>;

/** Раздел объявлений: по две строки на каждое. */
function renderDeclarations(section: AnsweredSection): string {
  const { total, items } = section.declarations;
  const lines = items.flatMap((entry) => [
    `  ${entry.path}:${entry.line}  ${entry.name} ${entry.signature}`,
    `    ${scopeText(entry.scope)}`,
  ]);
  if (items.length < total) {
    lines.push(`  усечено: показано ${items.length} из ${total}`);
  }
  return [`объявления: ${total}`, ...lines].join("\n");
}

/**
 * Раздел соседей по сигнатуре. Имя не встретилось — раздела нет вовсе:
 * образца сигнатуры взять неоткуда, и пустой раздел утверждал бы, что
 * соседей нет.
 */
function renderNeighbours(section: AnsweredSection): readonly string[] {
  const neighbours = section.neighbours;
  if (neighbours === null) return [];
  const lines = neighbours.items.map((entry) =>
    `  ${entry.path}:${entry.line}  ${entry.name} ${entry.signature}`
  );
  if (neighbours.items.length < neighbours.total) {
    lines.push(
      `  усечено: показано ${neighbours.items.length} из ${neighbours.total}`,
    );
  }
  return [
    [`та же сигнатура, другое имя: ${neighbours.total}`, ...lines].join("\n"),
  ];
}

/**
 * Строка типов возврата — при двух и более вызываемых объявлениях.
 * Расхождение помечается явно: два тёзки с разными типами возврата не
 * спросит ни компилятор, ни читатель.
 */
function renderReturnTypes(section: AnsweredSection): readonly string[] {
  // Пусто — значит вызываемых тёзок меньше двух: решение принято при
  // сборке ответа, и переспрашивать его здесь незачем.
  if (section.returnTypes.length === 0) return [];
  const tail = section.returnTypes.length > 1 ? " — различаются" : "";
  return [`типы возврата: ${section.returnTypes.join(", ")}${tail}`];
}
