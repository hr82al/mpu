/**
 * Точка входа `mpu-task` (`task-orchestrator.md`, «Процесс»): третий
 * ребёнок `mpu-supervisor`. Аргументов нет; кэш-БД —
 * `$HOME/.config/mpu/mpu.db`, файлы первых сообщений —
 * `$XDG_RUNTIME_DIR/mpu-task/`. Строки лога — stdout (супервизор
 * добавляет `[task] `), остановка — `SIGTERM`/`SIGINT`.
 */

import { openCacheDb } from "./src/store/mod.ts";
import {
  Orchestra,
  runSteps,
  SYSTEM_CLOCK,
  SYSTEM_LETTERS,
  SYSTEM_RUN,
  SystemNotices,
  TmuxWindows,
} from "./src/task/orchestra/mod.ts";
import { VERSION } from "./src/version.ts";

if (import.meta.main) {
  // Как у соседей: `--version` — версия сборки, ничего не поднимая
  // (`platform/supervisor-install.md`, «Части»).
  if (Deno.args.length === 1 && Deno.args[0] === "--version") {
    console.log(VERSION);
    Deno.exit(0);
  }
  const home = Deno.env.get("HOME") ?? "";
  const runtime = Deno.env.get("XDG_RUNTIME_DIR") ?? "";
  if (Deno.args.length > 0 || home === "" || runtime === "") {
    console.error(
      "mpu-task: аргументов нет; нужны HOME и XDG_RUNTIME_DIR",
    );
    Deno.exit(2);
  }
  const line = (text: string) => console.log(text);
  const orchestra = new Orchestra({
    windows: new TmuxWindows(SYSTEM_RUN),
    clock: SYSTEM_CLOCK,
    notices: new SystemNotices(line, SYSTEM_RUN),
    letters: SYSTEM_LETTERS,
    letterDir: `${runtime}/mpu-task`,
  }, () => openCacheDb(`${home}/.config/mpu/mpu.db`));
  const stopping = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => stopping.abort());
  }
  line("старт");
  await runSteps(orchestra, stopping.signal, line);
  line("остановка");
  Deno.exit(0);
}
