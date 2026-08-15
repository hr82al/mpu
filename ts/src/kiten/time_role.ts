/**
 * Выбор роли записи времени (`docs/specs/kiten-time.md`, «CLI-контракт»).
 *
 * Две операции, и различие между ними существенно. `chooseRoleId` — там,
 * где роль ВЫБИРАЕТСЯ и обязана быть: `add` и, следующей порцией, `stop`;
 * только у неё есть цепочка «флаг → env → дефолт». `resolveRoleId` — там,
 * где роль лишь названа пользователем: фильтр `ls` и ось `edit`; без
 * значения она не подставляет ничего, иначе фильтр молча срезал бы чужие
 * роли, а `edit` переписывал бы роль в каждом вызове.
 *
 * Справочник ролей запрашивается только на нечисловом значении — числовое
 * берётся как id (инвариант спеки).
 */

import { UsageError } from "../command/mod.ts";
import {
  type KaitenAccess,
  type KaitenRole,
  listUserRoles,
} from "../kaiten/mod.ts";
import type { AccessIo } from "./access.ts";

/** Ключ env-файла с ролью по умолчанию. */
export const ROLE_ENV_KEY = "KITEN_TIME_ROLE";

/** Роль по умолчанию — «Техподдержка»; числовая, запроса не требует. */
export const DEFAULT_ROLE_ID = 12058;

/** Сколько кандидатов показывать при неоднозначном названии. */
const MAX_CANDIDATES = 10;

/** Только цифры — значит id, и справочник не нужен. */
const NUMERIC_REF = /^\d+$/;

/**
 * Роль записи: явный `--role` → ключ env-файла → дефолт. Нерезолвимое
 * значение env — отказ с его именем в префиксе, БЕЗ отката на дефолт:
 * настроенная и не сработавшая роль означает, что запись уйдёт не туда.
 */
export async function chooseRoleId(
  access: KaitenAccess,
  ref: string | undefined,
  io: AccessIo,
): Promise<number> {
  if (ref !== undefined) return await resolveRoleId(access, ref);
  const configured = io.envFile.get(ROLE_ENV_KEY);
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_ROLE_ID;
  }
  return await resolveRoleId(access, configured, `${ROLE_ENV_KEY}: `);
}

/**
 * Названное пользователем значение роли в id. Числовое — id как есть;
 * нечисловое ищется в живом справочнике: точное совпадение названия без
 * учёта регистра, иначе подстрока. `prefix` ставится перед причиной, когда
 * значение пришло не из флага, а из настройки.
 */
export async function resolveRoleId(
  access: KaitenAccess,
  ref: string,
  prefix = "",
): Promise<number> {
  if (NUMERIC_REF.test(ref)) return Number(ref);
  return pickRole(await listUserRoles(access), ref, prefix).id;
}

/** Выбор роли из справочника; чист — сеть остаётся у вызывающего. */
function pickRole(
  roles: readonly KaitenRole[],
  ref: string,
  prefix: string,
): KaitenRole {
  const needle = ref.toLowerCase();
  const exact = roles.filter((role) => role.name.toLowerCase() === needle);
  // Точное совпадение старше подстроки: «Диагностика» не должна стать
  // неоднозначной из-за соседней «Диагностика оборудования».
  const found = exact.length > 0
    ? exact
    : roles.filter((role) => role.name.toLowerCase().includes(needle));
  if (found.length === 0) {
    throw new UsageError(
      `${prefix}role '${ref}' не найден — см. \`mpu kiten roles\``,
    );
  }
  if (found.length > 1) {
    throw new UsageError(
      `${prefix}role '${ref}' неоднозначен (${found.length} совпадений):`,
      { details: candidateLines(found) },
    );
  }
  return found[0];
}

/** Кандидаты списком `id (название)`; длинный список обрезается. */
function candidateLines(roles: readonly KaitenRole[]): string {
  return roles
    .slice(0, MAX_CANDIDATES)
    .map((role) => `${role.id} (${role.name})`)
    .join("\n");
}
