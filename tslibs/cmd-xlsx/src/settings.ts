/**
 * Локальные настройки команды `xlsx`: чтение предпочтений и алиасов
 * (`platform/config.md`) и резолв пути к книге по трём источникам.
 * Здесь живут шаги, которым нужен io; сам резолв — чистая функция
 * соседнего модуля.
 */

import type { CommandIo } from "@mpu/command";
import {
  aliases,
  type ConfigKey,
  configValue,
  NO_FALLBACK,
  readPreferences,
} from "@mpu/command/config";
import { type ResolveReport, resolveXlsxPath } from "./resolve.ts";

/**
 * Книга `mpu xlsx` по умолчанию — ключ `mpu config` (`platform/config.md`,
 * «CLI-контракт»); объявляет его команда, которая значение применяет.
 * Умолчания нет. Описание — дословно из голдена рабочей версии
 * (`fixtures/config/list-json.stdout`).
 */
export const XLSX_DEFAULT: ConfigKey = {
  key: "xlsx.default",
  type: "str",
  fallback: NO_FALLBACK,
  description: "Путь или alias .xlsx по умолчанию для `mpu xlsx`",
};

/**
 * Срез порта для резолва пути: три источника спеки — env-файл, текущий
 * каталог с HOME и предпочтения кэш-БД (`platform/config.md`).
 */
type PathIo = Pick<CommandIo, "cwd" | "env" | "envFile" | "openCacheDb">;

/** Резолв пути по трём источникам спеки (для команд с файлом). */
export function resolvePath(
  io: PathIo,
  flagValue: string | undefined,
): ResolveReport {
  // Предпочтения и алиасы живут в кэш-БД: отдельного файла нет, и
  // читать его значило бы молча отдавать умолчания. Оба источника
  // снимаются за одно открытие: `resolve --json` печатает все три
  // источника, включая config, даже когда победил флаг.
  const store = readPreferences(
    io,
    (db) => ({
      configValue: configValue(db, XLSX_DEFAULT.key),
      aliases: new Map(aliases(db).map((a) => [a.name, a.path])),
    }),
    { configValue: undefined, aliases: new Map<string, string>() },
  );
  return resolveXlsxPath({
    flagValue,
    envValue: io.envFile.get("MPU_XLSX"),
    configValue: store.configValue,
    aliasPath: (name) => store.aliases.get(name),
    cwd: io.cwd(),
    home: io.env("HOME"),
  });
}
