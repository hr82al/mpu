/**
 * Оркестратор ролей `mpu-task` (`task-orchestrator.md`): шаг по проектам
 * канала, настоящие порты и цикл процесса.
 */

export type { Hands } from "./ports.ts";
export { runSteps, SYSTEM_CLOCK } from "./run.ts";
export { Orchestra } from "./orchestra.ts";
export {
  SYSTEM_LETTERS,
  SYSTEM_RUN,
  SystemNotices,
  TmuxWindows,
} from "./system.ts";
