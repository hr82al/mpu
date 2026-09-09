/**
 * Команда `mpu build` (`docs/specs/build.md`): пересобрать программу и
 * заменить установленную. Тулом не публикуется — её нет в закрытом
 * списке, и вносить нельзя: агент, работающий через сервер, заменял бы
 * программу, которой сам же исполняется.
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError } from "../command/mod.ts";
import { xdgConfigHome } from "../env/mod.ts";
import { restartServiceIfRunning } from "../mcp/cmd_service.ts";
import { build, findSourceTree, type ServiceFate, spawnAt } from "./build.ts";
import { installedBinPath } from "./mod.ts";

const argsSchema = z.object({
  check: z.boolean().default(false).describe(
    "собрать и проверить, установку не трогать",
  ),
});

/**
 * Судьба службы. Союз, а не пара полей: причина принадлежит одному
 * исходу, и «перезапущена с причиной отказа» выразить нечем.
 */
const serviceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restarted") }),
  z.object({ kind: z.literal("untouched") }),
  z.object({
    kind: z.literal("restart-failed"),
    reason: z.string().describe("отказ перезапуска дословно"),
  }),
]);

const resultSchema = z.object({
  tree: z.string().describe("дерево исходников, из которого собрано"),
  target: z.string().describe("путь установки"),
  version: z.string().nullable().describe(
    "версия собранного кандидата; null — прогон --check",
  ),
  previous: z.string().nullable().describe(
    "версия, стоявшая по пути установки; null — её не было",
  ),
  installed: z.boolean().describe("путь установки заменён"),
  service: serviceSchema.nullable().describe(
    "судьба службы MCP; null — установка не трогалась",
  ),
});

export const buildCommand = defineCommand({
  path: ["build"],
  summary: "пересобрать mpu из исходников и переустановить",
  usage: "mpu build [--check]",
  help: `Собирает бинарь из дерева исходников и заменяет им установленную
программу. Порядок жёсткий: сперва \`deno task smoke\` — сборка со
списком прав задачи и проверка того, что видно только запуску бинаря;
красная — установка не тронута. Затем кандидат собирается рядом с
целью, отвечает \`version\` и \`--help\` своим экземпляром и только
потом переименовывается поверх цели. Прежний экземпляр живёт, пока
установленное не ответило: не ответило — возвращается на место.

Путь установки (~/.local/bin/mpu) заменяется КАК ПУТЬ: если там лежала
символическая ссылка, на её месте окажется файл. Идти по ссылке нельзя
— её цель лежит в дереве исходников.

Дерево исходников ищется двумя кандидатами: каталог рядом с работающей
программой (\`<дерево>/bin\`) и рабочая область по сентинелу
\`.mp-workspace-root\` (\`<корень>/mpu/ts\`). Ни один не подошёл —
отказ называет оба проверенных места.

Работающая служба MCP перезапускается после установки: иначе в памяти
остаётся прежняя версия. Не установлена или остановлена — не трогается.
Перезапуск не удался — печатаются обе строки, и «установлено», и отказ:
программа к тому моменту уже заменена, и молчать об этом нельзя.

--check обрывает порядок после \`deno task smoke\`: по пути установки
кандидат не появляется вовсе.

Гейты разработки (формат, линтер, типы, тесты) команда не гоняет: это
не проверка установки.

Exit: 0 — установлено (или проверено при --check); 1 — дерева нет,
сборка или проверка упали, установленное не ответило, нет прав на
запись по пути установки, служба не перезапустилась; 2 — ошибка ввода.

Примеры: mpu build; mpu build --check`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: async (args, io) => {
    const home = io.env("HOME");
    const configHome = xdgConfigHome(io.env);
    if (home === undefined || home === "" || configHome === undefined) {
      throw new DomainError("HOME не задана: путь установки не вычислить");
    }
    const found = await findSourceTree(programDir(), io.cwd());
    if (found.tree === undefined) {
      throw new DomainError(
        `дерево исходников не найдено; проверены: ${
          found.checked.join(", ") || "(ни одного места)"
        }`,
      );
    }
    return await build(
      {
        tree: found.tree,
        target: installedBinPath(home),
        home,
        configHome,
      },
      { run: spawnAt, restartService: () => restartServiceIfRunning(io) },
      args.check,
    );
  },
  render: (result) => {
    if (!result.installed) {
      return `дерево исходников: ${result.tree}\n` +
        `было: ${result.previous ?? "ничего не установлено"}\n` +
        "проверка: `deno task smoke` зелёный\n" +
        "установка не тронута (--check)\n";
    }
    return `собрано: ${result.version}\n` +
      `было: ${result.previous ?? "ничего не установлено"}\n` +
      "проверка: `deno task smoke` зелёный, кандидат ответил " +
      "version и --help\n" +
      `установлено: ${result.target}\n` +
      serviceLine(result.service);
  },
  // Отказ перезапуска — код 1 при состоявшейся установке: обе строки
  // напечатаны, но итог вызова неуспешен (`docs/specs/build.md`).
  textExitCode: (result) => result.service?.kind === "restart-failed" ? 1 : 0,
});

/**
 * Строка о судьбе службы. Отказ печатается вместе с причиной и следом
 * за строкой «установлено»: программа заменена, и об этом сказано, что
 * бы ни случилось со службой.
 *
 * Про службу ничего не известно (`null`) — строки нет вовсе: она
 * появляется только там, где установка была.
 */
function serviceLine(service: ServiceFate | null): string {
  if (service === null) return "";
  switch (service.kind) {
    case "restarted":
      return "служба MCP: перезапущена\n";
    case "untouched":
      return "служба MCP: не тронута\n";
    case "restart-failed":
      return `служба MCP: перезапуск не удался — ${service.reason}\n`;
    default: {
      const unknown: never = service;
      throw new TypeError(`неизвестная судьба службы: ${String(unknown)}`);
    }
  }
}

/**
 * Каталог работающей программы. Символические ссылки разрешаются: на
 * Linux `Deno.execPath()` уже разрешён ядром, и первый кандидат ищет
 * дерево рядом с настоящим файлом.
 */
function programDir(): string {
  const path = Deno.execPath();
  return path.slice(0, path.lastIndexOf("/"));
}
