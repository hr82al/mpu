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
  type PortainerLocation,
  serverLocation,
} from "./containers.ts";
export {
  type HttpCall,
  type OnInterrupt,
  type PortainerTarget,
  runOverPortainer,
} from "./portainer.ts";
export { quoteArg, shellCommand } from "./shell.ts";
export { runOverSsh, type RunProcess, type SshTarget } from "./ssh.ts";
export type { OpenChannel } from "./ws.ts";
export {
  chooseTransport,
  type ExecPlace,
  type ExecTarget,
  type TransportSources,
  type Via,
  viaOf,
} from "./target.ts";
