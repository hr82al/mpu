/**
 * Публичная поверхность команды `mpu xlsx`: её команды для реестра и
 * ключ `xlsx.default` для списка `mpu config` (собирает приложение).
 * Диспетчера здесь больше нет — маршрутизацию и печать ведёт точка
 * входа, а каждая подкоманда объявлена по контракту команды.
 */

import type { Command } from "@mpu/command";
import { lsCommand } from "./src/cmd_ls.ts";
import { getCommand } from "./src/cmd_get.ts";
import { openCommand } from "./src/cmd_open.ts";
import { resolveCommand } from "./src/cmd_resolve.ts";
import {
  aliasAddCommand,
  aliasLsCommand,
  aliasRmCommand,
} from "./src/cmd_alias.ts";

/** Команды xlsx в порядке показа в индексе справки. */
export const xlsxCommands: readonly Command[] = [
  lsCommand,
  getCommand,
  openCommand,
  resolveCommand,
  aliasAddCommand,
  aliasLsCommand,
  aliasRmCommand,
];

export { XLSX_DEFAULT } from "./src/settings.ts";
