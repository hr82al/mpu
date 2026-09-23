/**
 * Точка входа `mpu-back` (`deno task back`): сервер строк и запросов.
 * В бинарь не собирается.
 */

import { runBack } from "./src/backend/mod.ts";
import { policyFile } from "./src/line/mod.ts";
import { imageFile } from "./src/image/mod.ts";
import { processIo, processLog } from "./src/process/mod.ts";
import { MarkerDir, NO_MARKERS, ProcessLauncher } from "./src/worker/mod.ts";
import {
  defaultStateDir,
  makeDenoOutput,
  secretText,
  tokenFile,
} from "./src/runtime/mod.ts";

/** Путь программы `name` в каталоге этой программы. */
function besideSelf(name: string): string {
  const self = Deno.execPath();
  return `${self.slice(0, self.lastIndexOf("/"))}/${name}`;
}

if (import.meta.main) {
  const stopped = Promise.withResolvers<void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => stopped.resolve());
  }
  const home = Deno.env.get("HOME");
  const io = processIo();
  const stateDir = defaultStateDir();
  const output = makeDenoOutput();
  const runtimeDir = Deno.env.get("XDG_RUNTIME_DIR");
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
      imageFile: imageFile(stateDir),
      snapshotFile: home === undefined || home === ""
        ? undefined
        : `${home}/.cache/mpu/tree.json`,
      // Без HOME основной токен не создастся раньше, чем понадобятся
      // сессии браузера, — путь к ним не важен.
      webSessions: secretText(`${stateDir ?? ""}/web-sessions`),
      // Сборки фронта — `web/<sha256>/`, действующая — по ссылке `current`
      // (`specs/web.md`, «Приложение (10b)»).
      webRoot: `${home ?? ""}/.local/share/mpu/web/current`,
      output,
      stopped: stopped.promise,
      workers: {
        // Установленный `mpu-worker` лежит рядом с `mpu-back`
        // (`platform/line-executor.md`); из исходников — `--worker`.
        program: besideSelf("mpu-worker"),
        launcher: (program) =>
          new ProcessLauncher({
            command: program,
            args: [],
            diagnose: (line) => output.stderr(`${line}\n`),
            now: () => Date.now(),
          }),
        // Отметки пишет сторож супервизора; без `XDG_RUNTIME_DIR` их нет.
        markers: runtimeDir === undefined || runtimeDir === ""
          ? NO_MARKERS
          : new MarkerDir(`${runtimeDir}/mpu/killed`),
      },
    }),
  );
}
