/**
 * Локальные настройки команды `xlsx`: чтение предпочтений и алиасов
 * (`platform/config.md`) и резолв пути к книге по трём источникам.
 * Здесь живут шаги, которым нужен io; сам резолв — чистая функция
 * соседнего модуля.
 */

import type { CommandIo } from "../command/mod.ts";
import { aliases, configValue, readPreferences } from "../config/mod.ts";
import { type ResolveReport, resolveXlsxPath } from "./resolve.ts";

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
  const store = readPreferences(io, (db) => ({
    configValue: configValue(db, "xlsx.default"),
    aliases: new Map(aliases(db).map((a) => [a.name, a.path])),
  }), { configValue: undefined, aliases: new Map<string, string>() });
  return resolveXlsxPath({
    flagValue,
    envValue: io.envFile.get("MPU_XLSX"),
    configValue: store.configValue,
    aliasPath: (name) => store.aliases.get(name),
    cwd: io.cwd(),
    home: io.env("HOME"),
  });
}
