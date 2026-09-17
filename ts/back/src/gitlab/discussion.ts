/**
 * Матчинг дискуссии по селектору (`platform/gitlab-api.md`, «Матчинг
 * дискуссии по селектору»): полный id либо однозначный префикс.
 *
 * Порог в шесть символов — не вкусовщина: id дискуссии 40-hex, и
 * префикс короче почти наверняка совпал бы с несколькими тредами
 * активного MR, а «показать не тот тред» здесь неотличимо от «показать
 * тот».
 */

import type { Discussion } from "./model.ts";

/** Минимальная длина префикса id (спека). */
const MIN_PREFIX = 6;

/** Отказ матчинга; на стороне команды — exit 1 (спека `mr-read.md`). */
export class DiscussionRefError extends Error {
  override name = "DiscussionRefError";
}

/** Тред по селектору: точный id, затем однозначный префикс. */
export function matchDiscussion(
  discussions: readonly Discussion[],
  ref: string,
): Discussion {
  const needle = ref.toLowerCase();
  const exact = discussions.find((d) => d.id.toLowerCase() === needle);
  if (exact !== undefined) return exact;
  if (needle.length < MIN_PREFIX) {
    throw new DiscussionRefError(
      `префикс id дискуссии короче ${MIN_PREFIX} символов: '${ref}'`,
    );
  }
  const matched = discussions.filter((d) =>
    d.id.toLowerCase().startsWith(needle)
  );
  if (matched.length === 0) {
    throw new DiscussionRefError(`дискуссия '${ref}' не найдена в этом MR`);
  }
  if (matched.length > 1) {
    throw new DiscussionRefError(
      `префикс '${ref}' неоднозначен: ` +
        matched.map((d) => d.id.slice(0, 12)).join(", "),
    );
  }
  return matched[0];
}
