/**
 * Публичная поверхность команды `mpu xlsx`: её команды для реестра.
 * Диспетчера здесь больше нет — маршрутизацию и печать ведёт точка
 * входа, а каждая подкоманда объявлена по контракту команды.
 */

import type { Command } from "../command/mod.ts";
import { lsCommand } from "./cmd_ls.ts";
import { getCommand } from "./cmd_get.ts";
import { openCommand } from "./cmd_open.ts";
import { resolveCommand } from "./cmd_resolve.ts";
import {
  aliasAddCommand,
  aliasLsCommand,
  aliasRmCommand,
} from "./cmd_alias.ts";

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
