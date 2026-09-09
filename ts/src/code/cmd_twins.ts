/**
 * Команда `mpu code twins` (`specs/code-twins.md`): есть ли у этого
 * фрагмента близнец в другом файле.
 *
 * Вход — адрес, а не образец: копия находится не тогда, когда её ищут,
 * а когда меняют соседний код, и тело команда извлекает сама.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { parseAddress } from "./address.ts";
import { treeMarkOf } from "./answer.ts";
import { renderMark, renderMarkOnly } from "./mark.ts";
import { openAnalyzer } from "./open.ts";
import { renderUnresolved } from "./cmd_refs.ts";
import { resolveRepo } from "./sweep.ts";
import {
  collectTwins,
  refusedTwins,
  type TwinsResult,
  twinsResultSchema,
} from "./twins.ts";
import { ProjectBuildError } from "./project.ts";
import type { Repo } from "./workspace.ts";

/** Предел записей в разделе по умолчанию; запись — не строка. */
const DEFAULT_LIMIT = 200;

const argsSchema = z.object({
  address: z.string().min(1, "адрес обязателен: [РЕПОЗИТОРИЙ:]ПУТЬ:СТРОКА"),
  limit: z.number().int().positive("--limit ожидает положительное целое")
    .default(DEFAULT_LIMIT),
});

export const codeTwinsCommand = defineCommand({
  path: ["code", "twins"],
  summary: "есть ли у этого тела близнец в другом файле",
  usage: "mpu code twins АДРЕС [--limit N]",
  help: `АДРЕС = [РЕПОЗИТОРИЙ:]ПУТЬ:СТРОКА, строка обязательна. Тело
берётся у объявления-функции, охватывающего эту строку: объявления,
стрелки, метода. Окно поиска — репозиторий адреса.

Разделов два, и они не смешиваются. «побайтово» — тела, совпадающие
посимвольно от открывающей скобки до закрывающей; запрошенное тело в
нём есть всегда, поэтому раздел не бывает пуст. «похоже» — тела,
совпадающие после нормализации: комментарии сняты, пробелы сжаты,
параметры и локальные имена переименованы по порядку появления,
литералы заменены позиционными метками. Тело из «побайтово» в «похоже»
не повторяется.

У каждой строки «похоже» печатается, чем тела расходятся: литералы
нормализуются намеренно, и решение, копия это или нет, остаётся за
читателем.

Имя объявления в сравнении не участвует — сравниваются тела. Раздел
«не разрешено» печатается всегда, в том числе нулевой.

  --limit N   предел записей в разделе, не строк (по умолчанию 200)

Exit: 0 — ответ, включая усечение; 2 — ошибка ввода (нет строки, в
строке нет объявления-функции, нет файла или репозитория); 1 — тела
здесь не разбираются: в репозитории нет проектов, либо ни одна его
программа не собралась непустой, либо файл не входит ни в одну из них.
Отказ печатается разделом — с отметкой дерева и
причиной, — а не строкой ошибки.

Примеры:
  mpu code twins sl-back:src/orders/mod.ts:42
  mpu code twins sl-back:src/orders/mod.ts:42 --limit 20`,
  policy: "ro",
  argsSchema,
  forms: { address: { positional: "one" } },
  resultSchema: twinsResultSchema,
  run: (args, io) => runTwins(args, io),
  render: renderTwins,
  textExitCode: (result) => result.section.kind === "refused" ? 1 : 0,
});

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура живёт вне git и репозиторием по правилу «подкаталог
 * с `.git`» не является, а проверять команду надо целиком.
 */
export async function runTwins(
  args: { readonly address: string; readonly limit: number },
  io: Pick<CommandIo, "cwd">,
  repos?: readonly Repo[],
): Promise<TwinsResult> {
  const address = parseAddress(args.address);
  const repo = resolveRepo(address, io.cwd(), repos);
  try {
    return await collectTwins(
      address,
      args.limit,
      repo,
      await openAnalyzer(repo, address.path),
    );
  } catch (err) {
    // Отказ построения печатается разделом: он относится к
    // репозиторию, а не к вызову (`platform/code-analyzer.md`).
    if (!(err instanceof ProjectBuildError)) throw err;
    return refusedTwins(await repo.mark(), err.message);
  }
}

/**
 * Текст ответа. Три части формы слоя: шапка с отметкой и гарантией,
 * найденное двумя разделами, «не разрешено» — в том числе нулевое.
 */
export function renderTwins(result: TwinsResult): string {
  const section = result.section;
  if (section.kind === "refused") {
    return `${
      renderMarkOnly(treeMarkOf(section.mark))
    }\n  отказ: ${section.refusal}\n`;
  }
  const blocks = [
    renderMark(treeMarkOf(section.mark), section.guarantee),
    declarationLine(section.query),
    renderSection("побайтово", section.exact),
    renderSection("похоже", section.similar),
    renderUnresolved(section.unresolved),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/** Раздел, который ответил. */
type AnsweredTwins = Extract<TwinsResult["section"], { kind: "answer" }>;

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
