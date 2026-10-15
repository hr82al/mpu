/**
 * Поверхность пакета: семейство `mpu code` — ответы о связях кода
 * (`platform/code-analyzer.md`, `code-refs.md`). Воркер разбора
 * (`src/repo_worker.ts`) — второй вход сборки, не экспорт: его берёт по
 * пути сборка бинаря потребителя.
 */

export { codeCopiesCommand } from "./src/cmd_copies.ts";
export { codeLiteralsCommand } from "./src/cmd_literals.ts";
export { codeMentionsCommand } from "./src/cmd_mentions.ts";
export { codeNameCommand } from "./src/cmd_name.ts";
export { codeRefsCommand } from "./src/cmd_refs.ts";
export { codeShapeCommand } from "./src/cmd_shape.ts";
export { codeTwinsCommand } from "./src/cmd_twins.ts";
