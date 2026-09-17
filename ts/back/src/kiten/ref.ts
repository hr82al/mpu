/**
 * Резолв справочной ссылки (`docs/specs/platform/kaiten-http.md`,
 * «Резолв справочной ссылки»): опции `--space`/`--board`/`--lane`/
 * `--column`/`--role` принимают id или подстроку названия.
 *
 * Вид справочника — параметр, а не отдельная функция на вид: правило
 * одно на все пять, и второй его экземпляр разошёлся бы с первым.
 */

import { UsageError } from "../command/mod.ts";

/** Вид справочника; он же стоит в текстах отказа. */
export type RefKind = "space" | "board" | "lane" | "column" | "role";

/** Что нужно резолву от записи справочника. */
export interface RefItem {
  readonly id: number;
  readonly title: string;
}

/** Сколько кандидатов показывать при неоднозначном названии. */
const MAX_CANDIDATES = 10;

/** Только цифры — значит id, а не подстрока названия. */
const NUMERIC_REF = /^\d+$/;

/**
 * Запись справочника по ссылке: числовая — по id, прочая — точное
 * совпадение названия без учёта регистра, иначе подстрока.
 *
 * Числовая ссылка тоже ищется в списке, а не берётся как есть: список
 * здесь — это справочник целевой доски, и чужая колонка карточку не
 * примет; отказать положено раньше первой мутации (`kiten-move.md`,
 * «CLI-контракт»: дорожка и колонка резолвятся в скоупе целевой доски).
 */
export function resolveRef<T extends RefItem>(
  kind: RefKind,
  items: readonly T[],
  ref: string,
): T {
  if (NUMERIC_REF.test(ref)) {
    const byId = items.find((item) => item.id === Number(ref));
    if (byId === undefined) throw notFound(kind, ref);
    return byId;
  }
  const needle = ref.toLowerCase();
  const exact = items.filter((item) => item.title.toLowerCase() === needle);
  // Точное совпадение старше подстроки: «Готово» не должно стать
  // неоднозначным из-за соседнего «Готово к релизу».
  const found = exact.length > 0
    ? exact
    : items.filter((item) => item.title.toLowerCase().includes(needle));
  if (found.length === 0) throw notFound(kind, ref);
  if (found.length > 1) {
    throw new UsageError(
      `${kind} '${ref}' неоднозначен (${found.length} совпадений):`,
      { details: candidateLines(found) },
    );
  }
  return found[0];
}

function notFound(kind: RefKind, ref: string): UsageError {
  return new UsageError(
    `${kind} '${ref}' не найден — см. \`mpu kiten ${kind}s\``,
  );
}

/** Кандидаты списком `id (название)`; длинный список обрезается. */
function candidateLines(items: readonly RefItem[]): string {
  return items
    .slice(0, MAX_CANDIDATES)
    .map((item) => `${item.id} (${item.title})`)
    .join("\n");
}
