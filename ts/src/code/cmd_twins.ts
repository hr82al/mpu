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
import { renderMark } from "./mark.ts";
import { openAnalyzer } from "./open.ts";
import { renderUnresolved, resolveRepo } from "./cmd_refs.ts";
import { collectTwins, type TwinsResult, twinsResultSchema } from "./twins.ts";
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
здесь не разбираются: в репозитории нет проектов либо файл не входит ни
в один из них.

Примеры:
  mpu code twins sl-back:src/orders/mod.ts:42
  mpu code twins sl-back:src/orders/mod.ts:42 --limit 20`,
  policy: "ro",
  argsSchema,
  forms: { address: { positional: "one" } },
  resultSchema: twinsResultSchema,
  run: (args, io) => runTwins(args, io),
  render: renderTwins,
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
  return await collectTwins(
    address,
    args.limit,
    repo,
    await openAnalyzer(repo, address.path),
  );
}

/**
 * Текст ответа. Три части формы слоя: шапка с отметкой и гарантией,
 * найденное двумя разделами, «не разрешено» — в том числе нулевое.
 */
export function renderTwins(result: TwinsResult): string {
  const blocks = [
    renderMark(treeMarkOf(result.mark), result.guarantee),
    declarationLine(result.query),
    renderSection("побайтово", result.exact),
    renderSection("похоже", result.similar),
    renderUnresolved(result.unresolved),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Строка запроса: имя и сигнатура. Сигнатуру вывести удаётся не всегда,
 * и тогда печатается одно имя — висящий пробел читался бы как
 * потерянная часть строки.
 */
function declarationLine(query: TwinsResult["query"]): string {
  return [query.name, query.signature].filter((part) => part !== "").join(" ");
}

/** Раздел совпадений: заголовок со счётчиком и строки под ним. */
function renderSection(
  title: string,
  section: TwinsResult["exact"],
): string {
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
