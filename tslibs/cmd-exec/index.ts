/**
 * Поверхность пакета: выбор цели удалённого выполнения
 * (`platform/exec-transport.md`) — место по селектору и кэшу контейнеров,
 * транспорт по env-файлу, исполнение через Portainer с переводом отказа
 * `@mpu/exec` в ошибку команды. Команд в пакете нет: его берут пакеты
 * команд (`ps`, `ssh`, `run-js`, обёртки sl-back CLI) и `ts/` (`health`,
 * `move-client`). Сам транспорт (`runOverSsh`, `shellCommand`, `quoteArg`,
 * `spawnProcess`, типы портов) — `@mpu/exec`, отсюда не реэкспортируется.
 * Наружу — ровно то, что берут потребители.
 */

export {
  containerLocations,
  containerNamesLike,
  escapeLike,
  instanceServerNumbers,
  LIKE_ESCAPE,
  serverCliContainer,
} from "./src/containers.ts";
export { ambiguous, type PlaceSources, placeOf } from "./src/place.ts";
export { detachOverPortainer, runOverPortainer } from "./src/remote.ts";
export {
  chooseTransport,
  devCliContainer,
  type ExecPlace,
  type ExecTarget,
  requirePortainer,
  viaOf,
} from "./src/target.ts";
