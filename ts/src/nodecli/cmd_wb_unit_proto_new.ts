/**
 * Команда `mpu wb-unit-proto-new` (`docs/specs/portainer-wrappers.md`):
 * перелив данных WB UNIT из старой таблицы в новую.
 *
 * Листовая по той же причине, что `ss-datasets` и `wb-unit-calc`:
 * группа с единственной подкомандой в рабочей версии схлопнута, и
 * наблюдаемая форма имени подкоманды не содержит.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import {
  commonArgs,
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  type WrapIo,
} from "./run.ts";

const argsSchema = z.object({ ...commonArgs });

export const wbUnitProtoNewCommand = defineCommand({
  path: ["wb-unit-proto-new"],
  summary: "Перелить данные WB UNIT из старой таблицы в новую.",
  usage:
    "mpu wb-unit-proto-new SELECTOR [--server sl-N] [-p [--local]] [--client-id N]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:wbUnitProtoNew copyDataFromOldTable\` и
стримит его вывод, код выхода наследуется 1:1. Это перелив данных
клиента, а не отчёт о нём.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--client-id берётся из кандидатов селектора, если у всех кандидатов он
один. Доменных флагов у команды нет вовсе.

Имени подкоманды у команды нет: в рабочей версии группа с единственной
подкомандой схлопнута.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu wb-unit-proto-new 777; mpu wb-unit-proto-new 777 -p`,
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: { selector: { positional: "one" }, print: { short: "p" } },
  resultSchema,
  run: (args, io: WrapIo) =>
    runWrap(
      {
        service: "wbUnitProtoNew",
        method: "copyDataFromOldTable",
        flags: () => [],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});
