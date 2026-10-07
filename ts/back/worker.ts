/**
 * Точка входа `mpu-worker` (`platform/line-executor.md`): исполнитель
 * одной строки. Кадры ядра — stdin, свои кадры — stdout, диагностика —
 * stderr (ядро пишет её в журнал службы). Исполнил строку или увидел
 * конец stdin — выходит.
 */

import process from "node:process";
import { Readable, Writable } from "node:stream";
import { processIo } from "./src/process/mod.ts";
import { VERSION } from "./src/version.ts";
import { serveOne, streamWire } from "./src/worker/mod.ts";

if (import.meta.main) {
  // Как у соседей: `--version` — версия сборки, ничего не поднимая
  // (`platform/supervisor-install.md`, «Части»).
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
    process.exit(0);
  }
  await serveOne(
    streamWire(
      // stdin без кодировки отдаёт байты: тип `toWeb` их не знает.
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      Writable.toWeb(process.stdout),
    ),
    processIo(),
    // stderr исполнителя ядро пишет в журнал службы с его pid.
    (line) => console.error(line),
  );
  // Выход явный: библиотеки команды (клиент базы, таймеры повторов)
  // могут держать цикл событий, а процесс живёт ровно одну строку.
  process.exit(0);
}
