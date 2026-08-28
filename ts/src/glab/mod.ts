/**
 * Команда `mpu glab-status` (`docs/specs/glab-status.md`): прохождение
 * MR по веткам деплой-пайплайна.
 *
 * Наружу идёт только команда: разбор окна, сборка строк и рендер —
 * внутренности. GitLab-часть берётся из общего атома, своей копии у
 * команды нет.
 */

export { glabStatusCommand } from "./cmd_glab_status.ts";
