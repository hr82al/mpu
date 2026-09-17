/**
 * Этапы конвейера `mpu kiten status` (`docs/specs/kiten-status.md`):
 * название колонки доски → канонический этап.
 *
 * Сопоставление идёт ОТ КОНЦА конвейера к началу, а «Готово»
 * проверяется последним из всех: колонка «Готово к тестированию» — это
 * Тест, а не Готово, и порядок проверки здесь — единственное, что это
 * различает.
 */

/** Канонический этап; `—` — колонка ни под одну подстроку не подошла. */
export type Stage =
  | "Очередь"
  | "Оценка"
  | "В работе"
  | "Ревью"
  | "Тест"
  | "DEV"
  | "Пред-прод"
  | "Готово"
  | "—";

/** Латинский алиас `--stage` → канонический этап. */
export const STAGE_ALIASES: Readonly<Record<string, Stage>> = {
  queue: "Очередь",
  estimate: "Оценка",
  work: "В работе",
  review: "Ревью",
  test: "Тест",
  dev: "DEV",
  preprod: "Пред-прод",
  done: "Готово",
};

/** Конвейер в порядке движения работы: он же порядок вывода матрицы. */
export const PIPELINE: readonly Stage[] = [
  "Очередь",
  "Оценка",
  "В работе",
  "Ревью",
  "Тест",
  "DEV",
  "Пред-прод",
  "Готово",
];

/** Подстроки названий колонок по этапам (без учёта регистра). */
const MARKERS: readonly (readonly [Stage, readonly string[]])[] = [
  ["Очередь", ["очеред", "бэклог", "backlog", "назначенн"]],
  ["Оценка", ["оцен"]],
  ["В работе", ["в работе", "разработ", "баги", "эскалац"]],
  ["Ревью", ["ревью", "согласовани"]],
  ["Тест", ["тестирован", "тест"]],
  ["DEV", ["dev", "выгрузк", "выгружен"]],
  ["Пред-прод", ["pred-prod", "предпрод", "фг"]],
  ["Готово", ["готово", "выполненные"]],
];

/** Подстрока, дающая строке признак эскалации (спека). */
const ESCALATION = "эскалац";

/**
 * Этап колонки. `map` — env `KITEN_STAGE_MAP`: он перекрывает правила
 * для своих колонок, ключи сравниваются без учёта регистра.
 */
export function stageOf(
  column: string | null,
  map: Readonly<Record<string, Stage>> = {},
): Stage {
  if (column === null || column.trim() === "") return "—";
  const mapped = map[column.toLowerCase()];
  if (mapped !== undefined) return mapped;
  const lower = column.toLowerCase();
  // От конца конвейера к началу, «Готово» — последним из всех: иначе
  // «Готово к тестированию» встало бы в Готово, а не в Тест.
  const ordered = MARKERS.filter(([stage]) => stage !== "Готово").reverse();
  for (const [stage, markers] of ordered) {
    if (markers.some((marker) => lower.includes(marker))) return stage;
  }
  const done = MARKERS.find(([stage]) => stage === "Готово");
  if (done !== undefined && done[1].some((marker) => lower.includes(marker))) {
    return "Готово";
  }
  return "—";
}

/** Эскалация: та же колонка, отдельный признак строки (спека). */
export function isEscalated(column: string | null): boolean {
  return column !== null && column.toLowerCase().includes(ESCALATION);
}

/**
 * Этап из значения `--stage`: латинский алиас, точное имя этапа либо
 * подстрока канонического имени — всё без учёта регистра. Не подошло —
 * `null`, и вызывающий отвечает отказом ввода со списком алиасов.
 */
export function stageFromInput(raw: string): Stage | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  const alias = STAGE_ALIASES[value];
  if (alias !== undefined) return alias;
  const exact = PIPELINE.find((stage) => stage.toLowerCase() === value);
  if (exact !== undefined) return exact;
  const partial = PIPELINE.filter((stage) =>
    stage.toLowerCase().includes(value)
  );
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Карта этапов из env `KITEN_STAGE_MAP`. Ключи приводятся к нижнему
 * регистру, значения — к каноническим этапам; неизвестный этап в
 * значении отбрасывается, а не роняет команду: карта — подсказка
 * пользователя, а не контракт.
 */
export function stageMapOf(
  parsed: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Stage>> {
  const map: Record<string, Stage> = {};
  for (const [column, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    const stage = stageFromInput(value);
    if (stage !== null) map[column.toLowerCase()] = stage;
  }
  return map;
}
