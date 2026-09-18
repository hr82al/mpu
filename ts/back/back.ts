/**
 * Точка входа `mpu-back` (`deno task back`): сервер строк и запросов.
 * В бинарь не собирается.
 */

import { runBack } from "./src/backend/mod.ts";
import { policyFile } from "./src/next/mod.ts";
import { processIo, processLog } from "./src/process/mod.ts";
import {
  defaultStateDir,
  makeDenoOutput,
  tokenFile,
} from "./src/runtime/mod.ts";

if (import.meta.main) {
  const stopped = Promise.withResolvers<void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => stopped.resolve());
  }
  const home = Deno.env.get("HOME");
  const io = processIo();
  const stateDir = defaultStateDir();
  Deno.exit(
    await runBack(Deno.args, {
      io,
      // Без HOME каталога состояния нет: основной токен не создастся с
      // той же ошибкой, что у `mpu mcp`, раньше агентского.
      agentToken: stateDir === undefined
        ? io
        : tokenFile(`${stateDir}/agent-token`),
      log: processLog(io),
      policyFile: policyFile(stateDir),
      snapshotFile: home === undefined || home === ""
        ? undefined
        : `${home}/.cache/mpu/tree.json`,
      output: makeDenoOutput(),
      stopped: stopped.promise,
    }),
  );
}
