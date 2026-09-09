/**
 * Команда `mpu code mentions` (`specs/code-mentions.md`): где путь
 * упомянут в документации и существует ли он в коде.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { fileInsideRepo } from "./address.ts";
import { treeMarkOf } from "./answer.ts";
import { renderUnresolved } from "./cmd_refs.ts";
import { parseWindow } from "./cmd_name.ts";
import { renderMark } from "./mark.ts";
import {
  collectMentions,
  type MentionsResult,
  mentionsResultSchema,
} from "./mentions.ts";
import { spawnGit } from "./git.ts";
import { findWorkspaceRoot, readRepos, type Repo } from "./workspace.ts";

/** Предел записей в разделе по умолчанию; запись — не строка. */
const DEFAULT_LIMIT = 200;

const argsSchema = z.object({
  path: z.string().min(1, "нужен путь"),
  in: z.string().optional(),
  limit: z.number().int().positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

export const codeMentionsCommand = defineCommand({
  path: ["code", "mentions"],
  summary: "где путь упомянут в документации и есть ли он в коде",
  usage: "mpu code mentions ПУТЬ [--in ОКНО] [--limit N]",
  help: `ПУТЬ — путь к файлу от корня репозитория, как его пишут в
документах. Совпадение считается по подстроке: в тексте адрес обычно
обрамлён обратными кавычками, скобками ссылки или знаками препинания.

Область просмотра — файлы .md репозитория вне node_modules.

Первой строкой печатается, существует ли путь в коде: «— есть в коде»
либо «— в коде нет». Без неё перечень упоминаний не отвечает на
заданный вопрос — протух адрес или нет.

Гарантия в шапке всегда пониженная: команда работает по тексту
документов, а не по разбору, и разбором не притворяется.

Вхождение — пара «документ, строка»: несколько вхождений в одной строке
считаются одним, разные строки одного документа — разными.

ОКНО = РЕПОЗИТОРИЙ либо РЕПОЗИТОРИЙ:КАТАЛОГ. Без --in отвечает каждый
репозиторий рабочей области своим разделом.

  --in ОКНО   где искать (по умолчанию — вся рабочая область)
  --limit N   предел записей в разделе, не строк (по умолчанию 200)

Exit: 0 — ответ, включая пустой перечень и усечение; 2 — ошибка ввода
(пустой путь, нет такого репозитория или каталога). Отказа у этой
поверхности не бывает: анализатора она не открывает.

Примеры:
  mpu code mentions src/orders/mod.ts --in sl-back
  mpu code mentions src/orders/mod.ts --in sl-back:docs`,
  policy: "ro",
  argsSchema,
  forms: { path: { positional: "one" } },
  resultSchema: mentionsResultSchema,
  run: (args, io) => runMentions(args, io),
  render: renderMentions,
});

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура репозиторием по правилу «подкаталог с `.git`» не
 * является, а проверять команду надо целиком.
 */
export async function runMentions(
  args: {
    readonly path: string;
    readonly in?: string;
    readonly limit: number;
  },
  io: Pick<CommandIo, "cwd">,
  repos?: readonly Repo[],
): Promise<MentionsResult> {
  const window = parseWindow(args.in);
  // Путь нормализуется наравне с окном: без этого `../q/src/a.ts`
  // отвечал бы про соседнее дерево под отметкой этого. Свёрнутый в
  // корень путь — ошибка ввода: пустая строка совпадает с любой
  // подстрокой, и поиск по ней объявил бы упоминанием весь текст.
  const path = fileInsideRepo(
    args.path,
    args.path,
    "путь",
    "нужен путь внутри репозитория",
  );
  const known = repos ?? readRepos(findWorkspaceRoot(io.cwd()), spawnGit);
  const chosen = window.repo === undefined
    ? known
    : [named(known, window.repo)];
  return await collectMentions(path, window.dir, args.limit, chosen);
}

/** Репозиторий, названный в окне. */
function named(repos: readonly Repo[], name: string): Repo {
  const found = repos.find((repo) => repo.name === name);
  if (found !== undefined) return found;
  throw new UsageError(`неизвестный репозиторий '${name}'`, {
    details: repos.map((repo) => `  ${repo.name}`).join("\n"),
  });
}

/** Текст ответа: по разделу на репозиторий, каждый со своей отметкой. */
export function renderMentions(result: MentionsResult): string {
  return `${
    result.sections.map((section) => renderSection(result.path, section))
      .join("\n\n")
  }\n`;
}

function renderSection(
  path: string,
  section: MentionsResult["sections"][number],
): string {
  const blocks = [
    // Гарантия всегда пониженная: разбором команда не пользуется.
    renderMark(treeMarkOf(section.mark), "text"),
    `${path} — ${section.exists ? "есть в коде" : "в коде нет"}`,
    renderMentionsSection(section),
    renderUnresolved(section.unresolved),
  ];
  return blocks.join("\n\n");
}

/** Раздел упоминаний: заголовок со счётчиком и строки под ним. */
function renderMentionsSection(
  section: MentionsResult["sections"][number],
): string {
  const { total, places } = section.mentions;
  const lines = places.map((place) => `  ${place.path}:${place.line}`);
  if (places.length < total) {
    lines.push(`  усечено: показано ${places.length} из ${total}`);
  }
  return [`упоминания: ${total}`, ...lines].join("\n");
}
