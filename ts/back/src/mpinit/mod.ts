/**
 * Команда `mpu mp-init` (`docs/specs/mp-init.md`): поднять локальный
 * стенд целиком. Наружу идёт только сама команда — план шагов и
 * probe'ы остаются внутренностями.
 */

export { mpInitCommand } from "./cmd_mp_init.ts";
