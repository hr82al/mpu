/**
 * Команда `mpu ssh` (`docs/specs/ssh.md`): произвольная shell-команда в
 * контейнере по селектору. Транспорт — общий платформенный
 * (`platform/exec-transport.md`); здесь только поверхность команды.
 */

import { defineCommand } from "../command/mod.ts";
import { argsSchema, resultSchema, runSsh, type SshIo } from "./run.ts";

export const sshCommand = defineCommand({
  path: ["ssh"],
  // Однострока — из слепка дерева: её видит режим дополнения, и
  // расходиться с эталоном ему незачем.
  summary:
    "Выполнить команду в `sl-N-cli` ИЛИ в произвольном контейнере по точному имени.",
  usage:
    "mpu ssh [SELECTOR] [--via ssh|portainer] [--all-containers SUBSTR] [--stdin-text T | --stdin-file P | --stdin-tty] [--] CMD...",
  help: `Первый позиционный токен — селектор, остальные позиционные и
неопознанные флаги образуют удалённую команду; \`--\` завершает разбор
флагов. Вывод стримится, код выхода наследуется 1:1.

SELECTOR: sl-N; dev:N (тот же контейнер на dev-ноде); точное имя
контейнера из кэша; client_id / spreadsheet_id / title → единственный
сервер. Транспорт выбирается сам: Portainer, если он настроен, иначе
ssh. --via меняет его для sl-N; для контейнера по имени --via ssh —
ошибка.

--all-containers SUBSTR — последовательно во всех контейнерах кэша, чьё
имя содержит подстроку; селектора при этом нет, все позиционные токены
— команда. Первый ненулевой код прерывает остальные.

stdin: --stdin-text (строка), --stdin-file (байты файла), --stdin-tty
(с терминала до Ctrl+D) — взаимоисключимы. Без них читается пайп; с
терминала stdin пустой.

Exit: код удалённой команды как есть (2 от неё неотличим от ошибки
ввода); 2 — ошибки ввода, резолва и конфигурации; 1 — ошибки
транспорта.

Примеры: mpu ssh sl-1 -- ls -la /app; mpu ssh dev:1 -- ls /app;
mpu ssh mp-dt-cli -- env; cat s.mjs | mpu ssh sl-11 -- node
--input-type=module -; mpu ssh --all-containers wb-loader -- node -v`,
  policy: "rw",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    // Хвост argv — командная строка контейнера: её флаги разбирает
    // удалённый шелл, а не мы (`platform/command-contract.md` таких
    // входов не запрещает, форма объявлена разбором argv).
    command: { positional: "rest", keepsUnknown: true },
  },
  resultSchema,
  run: (args, io: SshIo) => runSsh(args, io),
  render: (result) => result.output,
  // Успех вызова = нулевой код удалённой команды; подменять его нельзя
  // (спека, «Инварианты»).
  textExitCode: (result) => result.exitCode,
});
