/**
 * Команда `mpu code twins` (`specs/code-twins.md`): есть ли у этого
 * фрагмента близнец в другом файле.
 *
 * Вход — адрес или дифф, а не образец: копия находится не тогда, когда
 * её ищут, а когда меняют соседний код, и тела команда извлекает сама.
 * Откуда они берутся, решает `twins_queries.ts`.
 */

import { z } from "zod";
import { type CommandIo, defineCommand } from "@mpu/command";
import { treeMarkOf } from "./answer.ts";
import { renderMark, renderMarkOnly } from "./mark.ts";
import { renderUnresolved } from "./cmd_refs.ts";
import {
  collectTwins,
  refusedTwins,
  type TwinsResult,
  twinsResultSchema,
} from "./twins.ts";
import { NO_QUESTION, queriesOf, type TwinsArgs } from "./twins_queries.ts";
import { DEFAULT_LIMIT } from "./file_survey.ts";
import { ProjectBuildError } from "./project.ts";
import type { Repo } from "./workspace.ts";

const argsSchema = z.object({
  address: z.string().min(1, NO_QUESTION).optional(),
  base: z.string().optional(),
  in: z.string().optional(),
  limit: z
    .number()
    .int()
    .positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

export const codeTwinsCommand = defineCommand({
  path: ["code", "twins"],
  keys: { address: "address" },
  summary:
    "перед правкой тела или на приёмке диффа: нет ли у тела близнеца в другом файле",
  usage:
    "mpu code twins address: АДРЕС [limit: N] | base: REF [in: РЕПОЗИТОРИЙ] [limit: N]",
  help: `Спрашивают перед тем, как править тело функции: нет ли у него
близнеца в другом файле — иначе починка ляжет в одно место из двух, и
второе разойдётся с первым молча. На приёмке и рецензии диффа — то же
про каждую функцию, которую дифф тронул: копия находится не тогда,
когда её ищут. Совпадение считает разбор, а не подстрока, и ответ либо
полон, либо сам называет, где неполон.

address: — [РЕПОЗИТОРИЙ:]ПУТЬ:СТРОКА, строка обязательна. Тело
берётся у объявления-функции, охватывающего эту строку: объявления,
стрелки, метода. Окно поиска — репозиторий адреса.

  base: REF          вместо адреса: тела, тронутые диффом против
                     merge-base REF HEAD вместе с незакоммиченным
  in: РЕПОЗИТОРИЙ    репозиторий диффа (по умолчанию — текущего каталога)
  limit: N           предел записей в разделе, не строк (по умолчанию ${DEFAULT_LIMIT})

Разделов два, и они не смешиваются. «побайтово» — тела, совпадающие
посимвольно от открывающей скобки до закрывающей; по адресу
запрошенное тело в нём есть всегда, поэтому раздел не бывает пуст. «похоже» — тела,
совпадающие после нормализации: комментарии сняты, пробелы сжаты,
параметры и локальные имена переименованы по порядку появления,
литералы заменены позиционными метками. Тело из «побайтово» в «похоже»
не повторяется.

У каждой строки «похоже» печатается, чем тела расходятся: литералы
нормализуются намеренно, и решение, копия это или нет, остаётся за
читателем.

По диффу тело тронуто, если изменился текст от { до } (удалённая
строка внутри — тоже; переименование файла или функции — нет). Ответ:
«тронуто тел: N, с близнецами: M», затем по блоку на тело с
близнецами — путь:строка, имя и сигнатура, непустые разделы без него
самого. Тело без близнецов есть только в N.

Имя объявления в сравнении не участвует — сравниваются тела. Раздел
«не разрешено» печатается всегда, в том числе нулевой.

Exit: 0 — ответ, включая усечение; 2 — ошибка ввода (нет строки, в
строке нет объявления-функции, нет файла или репозитория, адрес вместе
с base, in без base, base без in вне репозитория, база не
разрешается); 1 — тела здесь не разбираются: в
репозитории нет проектов, либо ни одна его программа не собралась
непустой, либо файл не входит ни в одну из них. Отказ печатается
разделом — с отметкой дерева и причиной, — а не строкой ошибки.`,
  examples: [
    "mpu code twins address: sl-back:src/orders/mod.ts:42",
    "mpu code twins address: sl-back:src/orders/mod.ts:42 limit: 20",
    "mpu code twins base: main in: sl-back",
  ],
  policy: "ro",
  argsSchema,
  forms: { address: { positional: "one" } },
  resultSchema: twinsResultSchema,
  run: (args, io) => runTwins(args, io),
  render: renderTwins,
  textExitCode: (result) => (result.section.kind === "refused" ? 1 : 0),
});

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура живёт вне git и репозиторием по правилу «подкаталог
 * с `.git`» не является, а проверять команду надо целиком.
 */
export async function runTwins(
  args: TwinsArgs,
  io: Pick<CommandIo, "cwd">,
  repos?: readonly Repo[],
): Promise<TwinsResult> {
  const queries = await queriesOf(args, io, repos);
  try {
    return await collectTwins(queries, await queries.open(), args.limit);
  } catch (err) {
    // Отказ построения печатается разделом: он относится к
    // репозиторию, а не к вызову (`platform/code-analyzer.md`).
    if (!(err instanceof ProjectBuildError)) throw err;
    return refusedTwins(await queries.repo.mark(), err.message);
  }
}

/**
 * Текст ответа. Три части формы слоя: шапка с отметкой и гарантией,
 * найденное, «не разрешено» — в том числе нулевое. Форма ответа — данные
 * на границе контракта, поэтому печать выбирается по `kind`.
 */
export function renderTwins(result: TwinsResult): string {
  const section = result.section;
  if (section.kind === "refused") {
    return `${renderMarkOnly(
      treeMarkOf(section.mark),
    )}\n  отказ: ${section.refusal}\n`;
  }
  if (section.kind === "diff") return renderDiff(section);
  const blocks = [
    renderMark(treeMarkOf(section.mark), section.guarantee),
    declarationLine(section.query),
    renderSection("побайтово", section.exact),
    renderSection("похоже", section.similar),
    renderUnresolved(section.unresolved),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/** Раздел, который ответил по адресу. */
type AnsweredTwins = Extract<TwinsResult["section"], { kind: "answer" }>;

/** Раздел, который ответил по диффу. */
type DiffTwins = Extract<TwinsResult["section"], { kind: "diff" }>;

/**
 * Ответ по диффу: счёт тронутых тел, по блоку на тело с близнецами,
 * «не разрешено».
 */
function renderDiff(section: DiffTwins): string {
  const blocks = [
    renderMark(treeMarkOf(section.mark), section.guarantee),
    `тронуто тел: ${section.touched}, с близнецами: ${section.blocks.length}`,
    ...section.blocks.flatMap(renderBlock),
    renderUnresolved(section.unresolved),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Блок тела: строка запроса с местом и разделы с совпадениями. Само тело
 * названо строкой запроса, поэтому раздел без совпадений не печатается.
 */
function renderBlock(block: DiffTwins["blocks"][number]): readonly string[] {
  const sections: readonly (readonly [string, AnsweredTwins["exact"]])[] = [
    ["побайтово", block.exact],
    ["похоже", block.similar],
  ];
  return [
    `${block.query.path}:${block.query.line}  ${declarationLine(block.query)}`,
    ...sections
      .filter(([, found]) => found.total > 0)
      .map(([title, found]) => renderSection(title, found)),
  ];
}

/**
 * Строка запроса: имя и сигнатура. Сигнатуру вывести удаётся не всегда,
 * и тогда печатается одно имя — висящий пробел читался бы как
 * потерянная часть строки.
 */
function declarationLine(query: AnsweredTwins["query"]): string {
  return [query.name, query.signature].filter((part) => part !== "").join(" ");
}

/** Раздел совпадений: заголовок со счётчиком и строки под ним. */
function renderSection(title: string, section: AnsweredTwins["exact"]): string {
  const lines = section.twins.flatMap((twin) => [
    `  ${twin.path}:${twin.line}  ${twin.name}`,
    // Разница печатается всегда, когда она есть: нормализация стирает
    // литералы, и читатель обязан видеть, что именно стёрто.
    ...(twin.difference === null ? [] : [`    разница: ${twin.difference}`]),
  ]);
  if (section.twins.length < section.total) {
    lines.push(
      `  усечено: показано ${section.twins.length} из ${section.total}`,
    );
  }
  return [`${title}: ${section.total}`, ...lines].join("\n");
}
