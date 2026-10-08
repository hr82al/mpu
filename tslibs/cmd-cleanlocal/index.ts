/**
 * Команда `mpu clean-local-clients`
 * (`docs/specs/clean-local-clients.md`): очистка данных локальных
 * клиентов. Наружу — только команда: тексты SQL и подключения её дело.
 */

export { cleanLocalClientsCommand } from "./src/cmd_clean_local.ts";
