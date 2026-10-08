/**
 * Поверхность пакета: семейство `mpu code` — ответы о связях кода
 * (`platform/code-analyzer.md`, `code-refs.md`). Воркер разбора
 * (`src/repo_worker.ts`) — второй вход сборки, не экспорт: его берёт по
 * пути сборка бинаря потребителя.
 */

export { codeMentionsCommand } from "./src/cmd_mentions.ts";
export { codeNameCommand } from "./src/cmd_name.ts";
export { codeRefsCommand } from "./src/cmd_refs.ts";
export { codeTwinsCommand } from "./src/cmd_twins.ts";
