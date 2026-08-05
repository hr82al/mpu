/**
 * Кандидат резолва селектора и его печать
 * (`docs/specs/platform/selector.md`, «Ввод/вывод»). Откуда кандидаты
 * берутся — `cache.ts`, как по ним выносится вердикт — `resolve.ts`;
 * здесь только форма строки выдачи и её текст для человека.
 */

/** Имя сервера в кэше — `sl-<N>`; номер из него и есть `ServerNumber`. */
const SERVER_NAME = /^sl-(\d+)$/;

/** Строка выдачи резолва: клиент, его таблица и сервер. */
export interface Candidate {
  readonly clientId: number | null;
  readonly spreadsheetId: string | null;
  readonly title: string | null;
  /** Имя сервера как оно лежит в кэше (`sl-3`); неизвестен — `null`. */
  readonly server: string | null;
  /** `N` из имени сервера; не разобралось — `null`, и тогда кандидат в
   * вердикте по серверам не участвует (спека, «Инварианты»). */
  readonly serverNumber: number | null;
  /** Все WB sid'ы клиента по возрастанию, не только совпавший. */
  readonly sids: readonly string[];
}

/**
 * Номер сервера из его имени: `sl-3` → `3`. Диапазон N не ограничен —
 * несуществующий сервер падает позже, на подключении (спека, «Ввод/вывод»,
 * п. 2), поэтому проверяется только форма имени.
 */
export function serverNumberOf(name: string | null): number | null {
  const matched = name === null ? null : SERVER_NAME.exec(name);
  return matched === null ? null : Number(matched[1]);
}

/**
 * Список кандидатов для stderr: по строке на кандидата, каждая с
 * переводом строки; пустой список — пустая строка. Форма строки — спека,
 * «Ввод/вывод»: отступ в два пробела, поля через два пробела,
 * `server_number` и sid'ы не печатаются.
 */
export function formatCandidates(candidates: readonly Candidate[]): string {
  return candidates.map((candidate) => `${line(candidate)}\n`).join("");
}

function line(candidate: Candidate): string {
  const fields = [
    `client_id=${candidate.clientId ?? ""}`,
    `server=${candidate.server ?? ""}`,
  ];
  // Заголовок и таблица печатаются только непустыми: у кандидата-клиента
  // без таблиц их нет вовсе, и пустые `title=""  spreadsheet_id=` были бы
  // шумом в списке, который читают глазами.
  if (candidate.title !== null && candidate.title !== "") {
    fields.push(`title="${candidate.title}"`);
  }
  if (candidate.spreadsheetId !== null && candidate.spreadsheetId !== "") {
    fields.push(`spreadsheet_id=${candidate.spreadsheetId}`);
  }
  return `  ${fields.join("  ")}`;
}
