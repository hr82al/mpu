/**
 * Поверхность пакета: команда `mpu ps` (`ps.md`) — таблица контейнеров
 * фермы из кэш-БД или живьём из Portainer. Наружу — то, что берёт `ts/`:
 * объявление команды (реестр) и таблица выравненных колонок, которой
 * печатают ещё `health` и `mr`.
 */

export { psCommand } from "./src/cmd_ps.ts";
export { renderTable } from "./src/table.ts";
