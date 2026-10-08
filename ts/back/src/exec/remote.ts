/**
 * Portainer-путь транспорта глазами команд: отказ `@mpu/exec` становится
 * доменной ошибкой (exit 1 — сбой внешней системы, а не ввода,
 * `platform/exec-transport.md`). Пакет слоя команд не знает и бросает свой
 * `ExecError`; перевести его на границе — дело `ts/` (`platform/tslibs-exec.md`).
 *
 * ssh-путь `ExecError` не бросает (отказ ОС у `ssh` проходит как есть, как и
 * прежде), поэтому `runOverSsh`/`detachOverSsh` фасад отдаёт без обёртки.
 */

import * as exec from "@mpu/exec";
import { DomainError } from "@mpu/command";

/** Код выхода удалённой команды; отказ транспорта — `DomainError`. */
export async function runOverPortainer(
  run: exec.PortainerRun,
): Promise<number> {
  try {
    return await exec.runOverPortainer(run);
  } catch (err) {
    throw asDomainError(err);
  }
}

/** Фоновый запуск; отказ транспорта — `DomainError`. */
export async function detachOverPortainer(
  options: exec.PortainerDetach,
): Promise<number> {
  try {
    return await exec.detachOverPortainer(options);
  } catch (err) {
    throw asDomainError(err);
  }
}

/** Отказ транспорта — доменная ошибка с тем же текстом; прочее — как есть. */
function asDomainError(err: unknown): unknown {
  if (!(err instanceof exec.ExecError)) return err;
  return new DomainError(err.message, { cause: err });
}
