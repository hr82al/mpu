/**
 * Выбор роли записи времени и её название для вывода
 * (`docs/specs/kiten-time.md`, «CLI-контракт»).
 *
 * Сеть здесь одна и снаружи: `listUserRoles` вызывает команда, а модуль
 * выбирает роль внутри уже прочитанного справочника. Так вышло потому,
 * что справочник нужен мутирующим подкомандам ВСЕГДА — ответ создания и
 * правки записи названия роли не несёт (`platform/kaiten-api-time.md`,
 * «Инварианты»), а печатается всегда название. Прятать сеть внутрь
 * выбора значило бы ходить за одним и тем же справочником дважды:
 * сперва за резолвом `--role`, потом за названием.
 *
 * Единственное исключение — `resolveRoleId`: фильтр `ls` справочника не
 * требует, если значение числовое, и лишнего запроса делать не должен
 * (инвариант спеки о двух случаях запроса справочника).
 *
 * Три операции, и различие между ними существенно. `chooseRoleId` — там,
 * где роль ВЫБИРАЕТСЯ и обязана быть: `add` и, следующей порцией, `stop`;
 * только у неё есть цепочка «флаг → env → дефолт». `pickRoleId` — там,
 * где роль лишь названа пользователем: ось `edit` (фильтр `ls` приходит
 * сюда через `resolveRoleId`); без значения она не
 * подставляет ничего, иначе фильтр молча срезал бы чужие роли, а `edit`
 * переписывал бы роль в каждом вызове. `roleNameOf` — для вывода.
 */

import { UsageError } from "../command/mod.ts";
import {
  type KaitenAccess,
  type KaitenRole,
  listUserRoles,
} from "../kaiten/mod.ts";

/** Ключ env-файла с ролью по умолчанию. */
export const ROLE_ENV_KEY = "KITEN_TIME_ROLE";

/** Роль по умолчанию — «Техподдержка»; числовая, резолва не требует. */
export const DEFAULT_ROLE_ID = 12058;

/** Сколько кандидатов показывать при неоднозначном названии. */
const MAX_CANDIDATES = 10;

/** Только цифры — значит id, и поиск по названию не нужен. */
const NUMERIC_REF = /^\d+$/;

/**
 * Роль записи внутри прочитанного справочника: явный `--role` → ключ
 * env-файла → дефолт. Нерезолвимое значение env — отказ с его именем в
 * префиксе, БЕЗ отката на дефолт: настроенная и не сработавшая роль
 * означает, что запись уйдёт не туда. Пустое значение ключа равносильно
 * его отсутствию — уходит на дефолт, а не резолвится.
 */
export function chooseRoleId(
  roles: readonly KaitenRole[],
  ref: string | undefined,
  configured: string | undefined,
): number {
  if (ref !== undefined) return pickRoleId(roles, ref);
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_ROLE_ID;
  }
  return pickRoleId(roles, configured, `${ROLE_ENV_KEY}: `);
}

/**
 * Названное пользователем значение роли в id. Числовое — id как есть;
 * нечисловое ищется в справочнике: точное совпадение названия без учёта
 * регистра, иначе подстрока. `prefix` ставится перед причиной, когда
 * значение пришло не из флага, а из настройки.
 */
export function pickRoleId(
  roles: readonly KaitenRole[],
  ref: string,
  prefix = "",
): number {
  if (NUMERIC_REF.test(ref)) return Number(ref);
  return pickRole(roles, ref, prefix).id;
}

/**
 * Название роли для человекочитаемого вывода; роли нет в справочнике или
 * название пусто — `null`, и печатается числовой id (`kiten-time.md`,
 * «Роль в выводе — всегда название, а не id»).
 */
export function roleNameOf(
  roles: readonly KaitenRole[],
  id: number | null,
): string | null {
  if (id === null) return null;
  const name = roles.find((role) => role.id === id)?.name;
  return name === undefined || name === "" ? null : name;
}

/**
 * То же, что `pickRoleId`, но справочник читается только когда он нужен:
 * числовое значение берётся как id без сетевого запроса. Здесь и только
 * здесь — фильтр `ls`, которому название роли не нужно вовсе.
 */
export async function resolveRoleId(
  access: KaitenAccess,
  ref: string,
  prefix = "",
): Promise<number> {
  if (NUMERIC_REF.test(ref)) return Number(ref);
  return pickRoleId(await listUserRoles(access), ref, prefix);
}

/** Выбор роли из справочника по названию. */
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
