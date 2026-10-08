/**
 * Транспорт удалённого выполнения (`platform/exec-transport.md`):
 * доставить shell-команду в контейнер фермы, стримить её вывод и
 * вернуть код выхода 1:1. Публичная поверхность модуля — этот файл.
 * Сам транспорт — `@mpu/exec`; здесь — выбор цели (селектор, кэш
 * контейнеров, env-файл) и перевод его отказа в ошибку команды.
 */

export {
  type ContainerLocation,
  containerLocations,
  containerNamesLike,
  instanceServerNumbers,
  type PortainerLocation,
  serverCliContainer,
  serverLocation,
} from "./containers.ts";
export {
  detachOverSsh,
  type HttpCall,
  type OnInterrupt,
  type OpenChannel,
  type PortainerTarget,
  type ProcessRun,
  quoteArg,
  type RunProcess,
  runOverSsh,
  shellCommand,
  // Настоящий подпроцесс: им же исполняется локальный `docker exec`
  // у `mpu make-schema` (`docs/specs/make-schema.md`).
  spawnProcess,
  type SshTarget,
} from "@mpu/exec";
export { detachOverPortainer, runOverPortainer } from "./remote.ts";
export { ambiguous, placeOf, type PlaceSources } from "./place.ts";
export { escapeLike, LIKE_ESCAPE } from "./containers.ts";
export {
  chooseTransport,
  devCliContainer,
  type ExecPlace,
  type ExecTarget,
  type PortainerLookup,
  portainerOf,
  requirePortainer,
  type TransportSources,
  type Via,
  viaOf,
} from "./target.ts";
