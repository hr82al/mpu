/**
 * `@mpu/subprocess` — запуск локального процесса поверх `node:child_process`
 * одинаково под Bun, Node и Deno (`ts/docs/specs/platform/tslibs-exec.md`,
 * поведение — `platform/node-runtime.md`, [S.9a]): отказ запуска кодом ОС до
 * потоков, код по сигналу — `128 + номер`, отмена — статусом, потоки —
 * веб-потоки. Описание каждого имени — JSDoc у его определения.
 */

export {
  Program,
  type ProgramOptions,
  type ProgramOutput,
  type ProgramStatus,
  runProgram,
  type Stdio,
  startProgram,
} from "./src/subprocess.ts";
