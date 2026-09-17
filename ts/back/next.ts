/**
 * Точка входа `mpu-next` (`deno task next`): та же склейка процесса, что
 * у `main.ts`, с исполнением строки цепочкой сообщений. В бинарь не
 * собирается.
 */

import { runNext } from "./src/next/mod.ts";
import { runProcess } from "./src/process/mod.ts";

if (import.meta.main) {
  Deno.exit(await runProcess(Deno.args, runNext));
}
