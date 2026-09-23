/**
 * Команда `mpu run-js` (`docs/specs/run-js.md`): ESM-код внутри
 * контейнера sl-back. Транспорт и резолв таргета — платформенные
 * (`platform/exec-transport.md`); здесь поверхность команды.
 */

import { defineCommand } from "../command/mod.ts";
import { argsSchema, resultSchema, type RunJsIo, runRunJs } from "./run.ts";

export const runJsCommand = defineCommand({
  path: ["run-js"],
  keys: { text: "code" },
  // Однострока — из слепка дерева: её видит режим дополнения.
  summary: "Выполнить JS-код в контейнере sl-back.",
  usage:
    "mpu run-js [target: СЕЛЕКТОР] [text: КОД] [file: PATH] [--all|--all-containers SUBSTR] [--dry-run] [via: ssh|portainer] [--parallel [jobs: N]] [--detach]",
  help: `Звать, когда нужно выполнить JS-код внутри приложения
sl-back на сервере или в контейнере: с его node_modules, алиасами и env,
а не в локальном node.

Код уходит на stdin команде \`node --input-type=module -\`,
поэтому ему доступны node_modules, import-алиасы и env приложения;
рабочий каталог — корень приложения.

Адресация — ровно одна из трёх: target: (как у mpu ssh), --all
(инстанс-серверы кэша, N>0; sl-0 не входит) либо all-containers:
ПОДСТРОКА.

Код: text:, иначе file:, иначе stdin (с терминала — до Ctrl+D).
text: вместе с file: и пустой код — ошибки ввода.

Режимы: по умолчанию последовательно, первый ненулевой код прерывает
обход и становится кодом выхода; --parallel — все сразу (jobs: N
ограничивает одновременные, 0 — все), вывод каждого печатается по его
завершении, обходятся все; --detach — фоновый запуск, скрипт и лог остаются в
/tmp контейнера, завершения не ждём.

--dry-run печатает команду на каждый таргет и копирует её в буфер
обмена; ни выполнения, ни сети. via: меняет транспорт серверного
таргета; контейнер по имени идёт Portainer'ом всегда.

Exit: 0 — успех всех; код первого сбоя в последовательном режиме; 1 —
любой сбой при --parallel и --detach; 2 — ошибки ввода и конфигурации.`,
  examples: [
    'mpu run-js target: sl-1 text: "console.log(1)"',
    "cat s.mjs | mpu run-js target: sl-11",
    "mpu run-js --all --parallel file: s.mjs",
    "mpu run-js --all --detach file: s.mjs",
  ],
  policy: "rw",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    code: { positional: "one" },
    file: { short: "f" },
    jobs: { short: "j" },
    detach: { short: "d" },
  },
  resultSchema,
  run: (args, io: RunJsIo) => runRunJs(args, io),
  render: (result) =>
    result.mode === "dry-run" ? result.preview : result.output,
  // Код удалённой команды не подменяется формой вывода (спека,
  // «Инварианты»).
  textExitCode: (result) => result.exitCode,
});
