/**
 * Копии таблиц клиента в схему `backups` (`docs/specs/backup.md`).
 *
 * Наружу модуль отдаёт только команды реестра; план копии и сборка
 * запроса остаются внутренностями.
 */

export { backupCommands } from "./src/cmd_backup.ts";
