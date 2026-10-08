/**
 * `@mpu/exec` — исполнение команды в контейнере фермы без привязки к
 * рантайму и к слою команд (`ts/docs/specs/platform/tslibs-exec.md`,
 * поведение — `platform/exec-transport.md`): Portainer exec по WebSocket
 * (кадры, доставка stdin архивом, код выхода, kill по Ctrl+C) или `ssh` с
 * `docker exec`, одна shell-строка на оба пути.
 *
 * Цель приходит уже разрешённой — данными (`PortainerTarget`, `SshTarget`);
 * селектора, кэша контейнеров и env-файла здесь нет. Отказ транспорта —
 * `ExecError`, код выхода назначает потребитель. Описание каждого имени —
 * JSDoc у его определения.
 */

export { ExecError } from "./src/errors.ts";
export type { RemoteSink } from "./src/output.ts";
export {
  detachOverPortainer,
  type HttpCall,
  type OnInterrupt,
  type PortainerDetach,
  type PortainerRun,
  type PortainerTarget,
  runOverPortainer,
} from "./src/portainer.ts";
export { quoteArg, shellCommand } from "./src/shell.ts";
export {
  detachOverSsh,
  type ProcessRun,
  type RunProcess,
  runOverSsh,
  type SshTarget,
  spawnProcess,
} from "./src/ssh.ts";
export type { ByteChannel, OpenChannel } from "./src/ws.ts";
