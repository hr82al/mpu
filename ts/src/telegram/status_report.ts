/**
 * Текст дневного отчёта `mpu telegram status`
 * (`docs/specs/telegram-status.md`, «Ввод/вывод»): дедуп, порядок,
 * подпись колонки и усечение под предел Telegram.
 *
 * Модуль чистый: собранные записи на входе, готовый текст на выходе —
 * поэтому один и тот же набор всегда даёт один и тот же отчёт.
 */

/** Перемещение карточки, откуда бы оно ни пришло — журнал или Kaiten. */
export interface CardMove {
  readonly cardId: number;
  /** Заголовок карточки; его нет — в отчёте стоит `#<id>`. */
  readonly title: string | null;
  readonly url: string;
  /** Название колонки «куда», уже приведённое сборщиком. */
  readonly column: string;
  /** Момент перемещения, epoch-секунды. */
  readonly movedAt: number;
}

/** Переопределения из env-файла: замена имени колонки и эмодзи. */
export interface ReportStyle {
  /** Имя колонки → замена; ключи сравниваются без учёта регистра. */
  readonly columnMap: Readonly<Record<string, string>>;
  /** Имя колонки → эмодзи; ключи сравниваются без учёта регистра. */
  readonly emoji: Readonly<Record<string, string>>;
}

/** Сырые значения переопределений из env-файла. */
export interface StyleSource {
  /** `KITEN_COLUMN_MAP` — JSON-объект «имя колонки → замена». */
  readonly columns: string | undefined;
  /** `KITEN_STATUS_EMOJI` — JSON-объект «имя колонки → эмодзи». */
  readonly emoji: string | undefined;
}

/**
 * Стиль отчёта из env-файла. Пусто, невалидный JSON, не объект и
 * нестроковое значение — просто отсутствие переопределения: отчёт важнее
 * опечатки в настройке (там же, «Конфигурация»).
 */
export function reportStyle(source: StyleSource): ReportStyle {
  return { columnMap: table(source.columns), emoji: table(source.emoji) };
}

/** Таблица «имя → строка» из JSON; всё сомнительное отбрасывается молча. */
function table(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Опечатка в настройке не отменяет отчёт: переопределений просто нет.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Маркер усечения; он же занимает место в пределе. */
const CUT_MARK = "\n…(обрезано)";

/**
 * Эмодзи по подстроке имени колонки, в порядке проверки: побеждает
 * первое совпадение (там же, правило 3).
 */
const BY_SUBSTRING: readonly (readonly [string, string])[] = [
  ["ревью", "👀"],
  ["тест", "🧪"],
  ["разработ", "🛠️"],
  ["выгру", "🚀"],
  ["dev", "🚀"],
  ["prod", "🚀"],
  ["очеред", "📋"],
  ["оцен", "📊"],
  ["баг", "🐞"],
];

/** Имена колонки завершённой работы: точное совпадение, не подстрока. */
const DONE = ["готово", "выполнено"];

const DEFAULT_EMOJI = "🔹";

/**
 * Отчёт целиком, без перевода строки в конце: его добавляет печать, а
 * отправке он не нужен. День приходит готовым — тем же, по которому
 * собрано окно сбора, иначе вызов на полночь назвал бы чужой день.
 */
export function reportText(
  moves: readonly CardMove[],
  day: string,
  style: ReportStyle,
): string {
  const head = `Отчёт за сегодня (${day} МСК):`;
  const lines = ordered(moves).map(
    (move, index) => `${index + 1}. ${entry(move, style)}`,
  );
  if (lines.length === 0) return `${head}\n\nСегодня перемещений не было.`;
  return `${head}\n\n${lines.join("\n")}`;
}

/**
 * Усечение под предел Telegram по границе целых строк: маркер обязан
 * уложиться в предел вместе с текстом и не встать посреди разорванной
 * markdown-ссылки (там же, «Известные отклонения», вердикт fix).
 */
export function cutToLimit(text: string, limit: number): string {
  if (length(text) <= limit) return text;
  const room = limit - length(CUT_MARK);
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    // Каждая строка, кроме первой, приносит с собой перевод строки.
    const cost = length(line) + (kept.length === 0 ? 0 : 1);
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  // Не влезло ни одной строки — остаётся один маркер, уже без переноса:
  // переносить нечего.
  if (kept.length === 0) return CUT_MARK.slice(1);
  return `${kept.join("\n")}${CUT_MARK}`;
}

/**
 * Записи в порядке отчёта: дедуп по карточке (побеждает наибольший
 * момент), затем убывание по паре (момент, id карточки).
 */
function ordered(moves: readonly CardMove[]): readonly CardMove[] {
  const latest = new Map<number, CardMove>();
  for (const move of moves) {
    const known = latest.get(move.cardId);
    if (known === undefined || move.movedAt > known.movedAt) {
      latest.set(move.cardId, move);
    }
  }
  return [...latest.values()].sort((a, b) =>
    b.movedAt - a.movedAt || b.cardId - a.cardId
  );
}

/** Строка записи без номера: ссылка, колонка и эмодзи. */
function entry(move: CardMove, style: ReportStyle): string {
  const column = lookup(move.column, style.columnMap) ?? move.column;
  return `[${title(move)}](${move.url}) — ${column} ${emoji(column, style)}`;
}

/**
 * Заголовок карточки для markdown-ссылки. Квадратные скобки заменяются
 * полноширинными: обычные разорвали бы ссылку пополам.
 */
function title(move: CardMove): string {
  if (move.title === null || move.title === "") return `#${move.cardId}`;
  return move.title.replaceAll("[", "［").replaceAll("]", "］");
}

/** Эмодзи колонки: переопределение, «готово», подстрока, умолчание. */
function emoji(column: string, style: ReportStyle): string {
  // Переопределение опознаётся наличием ключа, а не отличием значения:
  // эмодзи, совпавшее с именем колонки, — тоже переопределение.
  const override = lookup(column, style.emoji);
  if (override !== undefined) return override;
  const needle = column.toLowerCase();
  if (DONE.includes(needle)) return "✅";
  const rule = BY_SUBSTRING.find(([part]) => needle.includes(part));
  return rule === undefined ? DEFAULT_EMOJI : rule[1];
}

/** Значение таблицы по имени колонки без учёта регистра; ключа нет — `undefined`. */
function lookup(
  column: string,
  table: Readonly<Record<string, string>>,
): string | undefined {
  const needle = column.toLowerCase();
  for (const [key, value] of Object.entries(table)) {
    if (key.toLowerCase() === needle) return value;
  }
  return undefined;
}

/** Длина в символах, а не в кодовых единицах: предел Telegram — символы. */
function length(text: string): number {
  return [...text].length;
}
