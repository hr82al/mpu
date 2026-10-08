/**
 * Драйвер PostgreSQL (node-postgres) отдельным входом: команды, которым
 * он нужен сразу, берут его отсюда, а вход `.` его не грузит — `run.ts`
 * поднимает драйвер лениво (`await import`), и npm-пакет не попадает в
 * путь запуска остальных команд (`ts/CLAUDE.md`, «Производительность»).
 */

export { clientOptions, openPgSession } from "./src/pg.ts";
