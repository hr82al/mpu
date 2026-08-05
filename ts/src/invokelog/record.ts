/**
 * Текст одной записи журнала вызовов (`platform/invoke-log.md`,
 * «Ввод/вывод»): шапка, строка команды, секции и маркер конца. Формат
 * унаследован от оригинала дословно и здесь только собирается — ни
 * файла, ни времени «сейчас» этот слой не знает.
 *
 * Локальное время считается от переданного смещения зоны, а не от
 * настройки машины: иначе одна и та же запись собиралась бы по-разному
 * на разных хостах, и golden-сверка зависела бы от `TZ` окружения.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Всё, из чего собирается запись. */
export interface InvokeRecordFields {
  /** Момент начала вызова: из него же выводится `run_id`. */
  readonly startedAt: Date;
  /** Смещение зоны в минутах: `+03:00` — это 180. */
  readonly offsetMinutes: number;
  readonly pid: number;
  readonly cwd: string;
  /** Строка после `$ `: `mpu …` после маскирования и кавычения. */
  readonly commandLine: string;
  /** Диагностика обвязки; пусто — секции не будет. */
  readonly note: string;
  readonly out: string;
  readonly err: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** Предел байт на поток; 0 — без обрезки. */
  readonly maxOutputBytes: number;
}

/** `run_id` = `YYYYMMDD-HHMMSS.mmm-<pid>` по локальному времени начала. */
export function runIdOf(
  at: Date,
  offsetMinutes: number,
  pid: number,
): string {
  const local = localParts(at, offsetMinutes);
  return `${local.date.replaceAll("-", "")}-` +
    `${local.time.replaceAll(":", "")}-${pid}`;
}

/** Собирает запись целиком, включая пустую строку-разделитель в конце. */
export function formatRecord(fields: InvokeRecordFields): string {
  const runId = runIdOf(fields.startedAt, fields.offsetMinutes, fields.pid);
  const local = localParts(fields.startedAt, fields.offsetMinutes);
  const dur = (fields.durationMs / 1000).toFixed(3);
  return `### ${local.date} ${local.time} ${local.offset} run=${runId}` +
    ` pid=${fields.pid} cwd=${fields.cwd}\n` +
    `$ ${fields.commandLine}\n` +
    section(runId, "note", fields.note, 0) +
    section(runId, "out", fields.out, fields.maxOutputBytes) +
    section(runId, "err", fields.err, fields.maxOutputBytes) +
    `--- end run=${runId} exit=${fields.exitCode} dur=${dur}s ---\n\n`;
}

/**
 * Секция потока с маркером обрезки, если содержимое не поместилось.
 * Пустая секция не печатается вовсе (спека). Перевод строки в конце
 * дописывается: без него маркер конца оказался бы на строке вывода.
 */
function section(
  runId: string,
  stream: string,
  text: string,
  maxBytes: number,
): string {
  if (text === "") return "";
  const { kept, dropped } = truncate(text, maxBytes);
  if (kept === "") {
    // Обрезка съела содержимое целиком: печатать пустую секцию нечего,
    // но число отброшенных байт остаётся наблюдаемым.
    return `--- truncated run=${runId} stream=${stream} dropped=${dropped} ---\n`;
  }
  const tail = dropped === 0
    ? ""
    : `--- truncated run=${runId} stream=${stream} dropped=${dropped} ---\n`;
  const body = kept.endsWith("\n") ? kept : `${kept}\n`;
  return `--- ${stream} run=${runId} ---\n${body}${tail}`;
}

/**
 * Обрезка по границе байт с дорезом неполного хвостового символа. Счёт
 * в байтах, а не в символах: предел задан байтами, и один эмодзи не
 * должен считаться за один шаг к нему.
 *
 * Граница ищется по самим байтам, а не по символу замены в декодированном
 * тексте: U+FFFD бывает и настоящим — его печатает всякий, кто декодировал
 * чужие байты нестрого, — и по декодированному дорез съедал бы целый
 * символ вывода.
 */
function truncate(
  text: string,
  maxBytes: number,
): { readonly kept: string; readonly dropped: number } {
  if (maxBytes <= 0) return { kept: text, dropped: 0 };
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { kept: text, dropped: 0 };
  // Байты-продолжения UTF-8 — `10xxxxxx`: пока предел пришёлся на такой,
  // символ разорван и граница сдвигается назад, к его началу.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
  return {
    kept: decoder.decode(bytes.subarray(0, end)),
    dropped: bytes.length - end,
  };
}

/** Локальные части времени: дата, время с миллисекундами и смещение. */
function localParts(
  at: Date,
  offsetMinutes: number,
): { readonly date: string; readonly time: string; readonly offset: string } {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  const iso = shifted.toISOString();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const total = Math.abs(offsetMinutes);
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 23),
    offset: `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
