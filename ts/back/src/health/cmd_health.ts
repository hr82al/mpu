/**
 * Команда `mpu health` (`docs/specs/health.md`): состояние `mp-*`
 * контейнеров сервера и хвосты stderr-логов «виновников».
 */

import { defineCommand } from "../command/mod.ts";
import { renderHealth } from "./render.ts";
import { argsSchema, type HealthIo, resultSchema, runHealth } from "./run.ts";

export const healthCommand = defineCommand({
  path: ["health"],
  keys: { limit: "tail" },
  // Однострока — из слепка дерева: её видит режим дополнения.
  summary: "Health-check сервера: контейнеры + tail логов виновников.",
  usage: "mpu health [all] target: СЕЛЕКТОР [limit: N] [since: S]",
  help: `Звать первым при жалобе «сервер не работает»: какие контейнеры
лежат и что они пишут перед падением.

Живой список \`mp-*\` контейнеров сервера с состояниями и tail
stderr-логов демонов, похожих на лоадеры. \`mp\`-строка — имя,
начинающееся с sl- или wb-, префикс mp- перед ними необязателен: обе
формы живут на ферме одновременно.

Штатно завершённый one-shot (migrations/init-, exited, Exited (0))
проблемой не считается и печатается отдельным блоком. Любой другой
не-running mp-контейнер даёт exit 1.

target: обязателен: sl-N либо client_id/spreadsheet/title.
limit: — строк лога на контейнер (30). since: — окно логов:
<число>{s|m|h|d} назад либо строка из одних цифр как unix-ts; иной
формат — ошибка ввода, и она проверяется до похода в сеть. all —
tail у всех демонов, не только лоадер-подобных.

В tail печатается только stderr: сервисы стека пишут ошибки в него, а
stdout утопил бы диагностику в рабочем шуме. Сбой получения логов по
одному контейнеру кода выхода не меняет.

Exit: 0 — все mp-контейнеры running (или штатно завершены); 1 — есть
неожиданно не-running либо не получен сам список; 2 — ошибки ввода,
резолва и конфигурации.`,
  examples: [
    "mpu health target: sl-1",
    "mpu health target: sl-1 limit: 100 since: 2h",
    "mpu health all target: 42",
  ],
  policy: "ro",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    tail: { short: "n" },
  },
  resultSchema,
  run: (args, io: HealthIo) => runHealth(args, io),
  render: (result) => renderHealth(result),
  // Код выхода несёт смысл: 1 ⇔ есть неожиданно не-running контейнер
  // (спека, «Инварианты»).
  textExitCode: (result) => result.exitCode,
});
