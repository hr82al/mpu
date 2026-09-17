/**
 * Точка входа `deno compile` → бинарь `mpu`: отдаёт argv процессу с
 * нынешней точкой входа CLI. Логика — в src/…; здесь только склейка,
 * чтобы всё остальное тестировалось без запуска бинаря.
 */

import { runCli } from "./src/entrypoint/mod.ts";
import { runProcess } from "./src/process/mod.ts";

if (import.meta.main) {
  Deno.exit(await runProcess(Deno.args, runCli));
}
