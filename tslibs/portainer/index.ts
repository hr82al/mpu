/**
 * `@mpu/portainer` — разговор с Portainer API без привязки к рантайму и к
 * слою команд (`ts/docs/specs/platform/tslibs-ops.md`): список
 * environment'ов и контейнеров (`init.md`, шаг 2), снимок логов контейнера
 * и разбор мультиплексированного потока Docker (`logs.md`, portainer-путь).
 *
 * Адрес, ключ и проверка TLS — параметром `PortainerAccess`; кэша и текстов
 * команд здесь нет. Описание каждого имени — JSDoc у его определения.
 */

export {
  type ContainerLogsQuery,
  containerName,
  type DockerStreams,
  demuxDockerStream,
  fetchContainerLogs,
  listContainers,
  listEndpoints,
  type PortainerAccess,
  type PortainerContainer,
  type PortainerEndpoint,
  PortainerError,
} from "./src/portainer.ts";
