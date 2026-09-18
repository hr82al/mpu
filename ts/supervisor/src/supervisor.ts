/**
 * Супервизор (`platform/supervisor-install.md`): держит `mpu-back` и
 * `mpu-mcp`, перезапускает каждого отдельно, гасит обоих по сигналу.
 */

import { Child, type Clock, type Launcher, type Log } from "./child.ts";

/** Порты дочерних по умолчанию. */
export const BACK_PORT = 7338;
export const MCP_PORT = 7339;

/** Что нужно супервизору. */
export interface SupervisorParts {
  /** Путь программы `mpu-back`. */
  readonly back: string;
  /** Путь программы `mpu-mcp`. */
  readonly mcp: string;
  readonly launcher: Launcher;
  readonly clock: Clock;
  readonly log: Log;
}

/** Два дочерних под одной службой. */
export class Supervisor {
  readonly back: Child;
  readonly mcp: Child;
  readonly #log: Log;

  constructor(parts: SupervisorParts) {
    const common = {
      launcher: parts.launcher,
      clock: parts.clock,
      log: parts.log,
    };
    this.back = new Child({
      ...common,
      name: "back",
      command: parts.back,
      args: ["--port", String(BACK_PORT)],
    });
    this.mcp = new Child({
      ...common,
      name: "mcp",
      command: parts.mcp,
      args: ["--port", String(MCP_PORT)],
    });
    this.#log = parts.log;
  }

  start() {
    this.#log.out("[supervisor] старт");
    this.back.start();
    this.mcp.start();
  }

  /** Остановка обоих: `SIGTERM`, через 10 с — `SIGKILL`. */
  async stop() {
    this.#log.out("[supervisor] остановка");
    await Promise.all([this.back.stop(), this.mcp.stop()]);
  }
}
