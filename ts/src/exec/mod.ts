/**
 * Транспорт удалённого выполнения (`platform/exec-transport.md`):
 * доставить shell-команду в контейнер фермы и вернуть код выхода 1:1.
 * Публичная поверхность модуля — этот файл.
 */

export {
  type ContainerLocation,
  containerLocations,
  containerNamesLike,
  type PortainerLocation,
  serverLocation,
} from "./containers.ts";
export { quoteArg, shellCommand } from "./shell.ts";
export {
  chooseTransport,
  type ExecPlace,
  type ExecTarget,
  type TransportSources,
  type Via,
  viaOf,
} from "./target.ts";
