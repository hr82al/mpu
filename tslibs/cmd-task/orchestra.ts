/**
 * `@mpu/cmd-task/orchestra` — оркестратор ролей `mpu-task`
 * (`docs/specs/task-orchestrator.md`): шаг по проектам канала, настоящие
 * порты и цикл процесса. Порты (`Hands`, `Windows`, `Place`) — протокол
 * оркестратора: его реализуют и настоящие окна tmux, и стенд сценариев
 * приложения.
 */

export * from "./src/orchestra/mod.ts";
export type { Place, Windows } from "./src/orchestra/ports.ts";
