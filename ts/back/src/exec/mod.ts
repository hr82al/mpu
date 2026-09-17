/**
 * Транспорт удалённого выполнения (`platform/exec-transport.md`):
 * доставить shell-команду в контейнер фермы, стримить её вывод и
 * вернуть код выхода 1:1. Публичная поверхность модуля — этот файл;
 * кодек кадров, архив и клиент WebSocket наружу не выходят.
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
  detachOverPortainer,
  type HttpCall,
  type OnInterrupt,
  type PortainerTarget,
  runOverPortainer,
} from "./portainer.ts";
export { ambiguous, placeOf, type PlaceSources } from "./place.ts";
export { escapeLike, LIKE_ESCAPE } from "./containers.ts";
export { quoteArg, shellCommand } from "./shell.ts";
export {
  detachOverSsh,
  runOverSsh,
  type RunProcess,
  // Настоящий подпроцесс: им же исполняется локальный `docker exec`
  // у `mpu make-schema` (`docs/specs/make-schema.md`).
  spawnProcess,
  type SshTarget,
} from "./ssh.ts";
export type { OpenChannel } from "./ws.ts";
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
