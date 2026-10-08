/**
 * Команда `mpu glab-status` (`docs/specs/glab-status.md`): прохождение
 * MR по веткам деплой-пайплайна.
 *
 * Наружу идёт только команда: разбор окна, сборка строк и рендер —
 * внутренности. GitLab-часть — из общих источников, своей копии у
 * команды нет: адрес MR и вызовы API — `@mpu/gitlab`, доступ по
 * env-файлу и перевод отказов в ошибки команды — `@mpu/cmd-mr`.
 */

export { glabStatusCommand } from "./src/cmd_glab_status.ts";
