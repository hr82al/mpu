/**
 * Точка входа `mpu-next` (`deno task next`): та же склейка процесса, что
 * у `main.ts`, с исполнением строки цепочкой сообщений. В бинарь не
 * собирается.
 */

import { nextEntry, policyFile } from "./src/next/mod.ts";
import { runProcess } from "./src/process/mod.ts";
import { defaultStateDir, readStdinLine } from "./src/runtime/mod.ts";

if (import.meta.main) {
  const consent = {
    file: policyFile(defaultStateDir()),
    readLine: readStdinLine,
  };
  Deno.exit(await runProcess(Deno.args, nextEntry(consent)));
}
