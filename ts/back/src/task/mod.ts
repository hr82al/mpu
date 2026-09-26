/**
 * Канал работы между ролями проекта (`docs/specs/task.md`): проекты и
 * журналы сообщений в кэш-БД, команды группы `mpu task`.
 */

import type { Command } from "../command/mod.ts";
import {
  CLEAR,
  REAL_TIME,
  taskDecisionsCommand,
  taskHistoryCommand,
  taskReadCommand,
  taskRulesCommand,
  taskStatusCommand,
  waitCommand,
} from "./cmd_read.ts";
import {
  taskMarkCommands,
  taskRoleCommand,
  taskRolesCommand,
} from "./cmd_roles.ts";
import {
  taskKindCommands,
  taskPostCommand,
  taskResumeCommand,
  taskSetupCommand,
  taskStopCommand,
} from "./cmd_write.ts";

/** Путь режима чистки журнала: у него свой посев (`ask`). */
export const HISTORY_CLEAR_PATH: readonly string[] = [
  ...taskHistoryCommand.path,
  CLEAR,
];

/** Команды группы `task` в порядке контракта спеки. */
export const taskCommands: readonly Command[] = [
  taskSetupCommand,
  taskRulesCommand,
  taskPostCommand,
  ...taskKindCommands,
  taskReadCommand,
  waitCommand(REAL_TIME),
  taskStatusCommand,
  taskHistoryCommand,
  taskDecisionsCommand,
  taskRoleCommand,
  taskRolesCommand,
  ...taskMarkCommands,
  taskStopCommand,
  taskResumeCommand,
];
