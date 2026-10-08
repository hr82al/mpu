/**
 * Канал работы между ролями проекта (`docs/specs/task.md`): проекты и
 * журналы сообщений в кэш-БД, команды группы `mpu task` и ключи
 * `mpu config` канала (`task.history`, `task.max_busy` — список собирает
 * приложение). Оркестратор ролей `mpu-task` — вход
 * `@mpu/cmd-task/orchestra`.
 */

import type { Command } from "@mpu/command";
import {
  CLEAR,
  REAL_TIME,
  taskDecisionsCommand,
  taskHistoryCommand,
  taskReadCommand,
  taskRulesCommand,
  taskStatusCommand,
  waitCommand,
} from "./src/cmd_read.ts";
import {
  taskMarkCommands,
  taskRoleCommand,
  taskRolesCommand,
} from "./src/cmd_roles.ts";
import {
  taskKindCommands,
  taskPostCommand,
  taskResumeCommand,
  taskSetupCommand,
  taskStopCommand,
} from "./src/cmd_write.ts";

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

export { TASK_HISTORY } from "./src/glue.ts";
export { TASK_MAX_BUSY } from "./src/orchestra/orchestra.ts";
