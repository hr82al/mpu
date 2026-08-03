/**
 * Локальные настройки команды `xlsx`: чтение и запись хранилища
 * (`platform/config.md`) и резолв пути к книге по трём источникам.
 * Здесь живут шаги, которым нужен io; сам резолв — чистая функция
 * соседнего модуля.
 */

import { type CommandIo, DomainError } from "../command/mod.ts";
import {
  parseStore,
  serializeStore,
  type StoreData,
  StoreFormatError,
} from "../config/mod.ts";
import { type ResolveReport, resolveXlsxPath } from "./resolve.ts";

/** Хранилище конфига; битый файл — доменная ошибка (exit 1). */
export async function loadStore(io: CommandIo): Promise<StoreData> {
  const raw = await io.readConfigStore();
  try {
    return parseStore(raw);
  } catch (err) {
    if (err instanceof StoreFormatError) {
      throw new DomainError(`corrupt config store (${err.message})`, {
        cause: err,
      });
    }
    throw err;
  }
}

/** Сериализует и пишет хранилище (каталог и права 0600 — io-слой). */
export async function saveStore(io: CommandIo, data: StoreData): Promise<void> {
  await io.writeConfigStore(serializeStore(data));
}

/** Резолв пути по трём источникам спеки (для команд с файлом). */
export async function resolvePath(
  io: CommandIo,
  flagValue: string | undefined,
): Promise<ResolveReport> {
  const store = await loadStore(io);
  return resolveXlsxPath({
    flagValue,
    envValue: io.env("MPU_XLSX"),
    configValue: store.values["xlsx.default"],
    aliasPath: (name) => store.aliases[name],
    cwd: io.cwd(),
    home: io.env("HOME"),
  });
}
