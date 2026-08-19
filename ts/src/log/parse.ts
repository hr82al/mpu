/**
 * Разбор файла журнала вызовов на записи (`docs/specs/log.md`,
 * «Ввод/вывод»). Формат записи задаёт `platform/invoke-log.md`; здесь
 * только чтение — по паре маркеров.
 *
 * Граница записи держится совпадением `run=<ID>`, а не видом строки:
 * вывод чужой команды бывает похож на маркер, и запись он разрывать не
 * должен. Строка, не подошедшая под шапку, при поиске начала
 * пропускается — обрывки старых записей после ротации не мешают.
 */

/** Одна запись журнала: текст дословно и то, по чему её отбирают. */
export interface LogRecord {
  readonly runId: string;
  /** Строка вызова после `$ `; её нет — пустая строка. */
  readonly commandLine: string;
  /** Код выхода из закрывающего маркера; запись оборвана — `null`. */
  readonly exitCode: number | null;
  /** Момент начала в unix-секундах; время шапки нечитаемо — `null`. */
  readonly startedAt: number | null;
  /** Запись целиком, включая пустую строку-разделитель в конце. */
  readonly text: string;
}

/** Шапка записи: время, зона и идентификатор вызова. */
const HEADER =
  /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3}) (\S+) run=(\S+)/;

/** Записи файла в порядке файла: от старых к новым. */
export function parseRecords(text: string): readonly LogRecord[] {
  const lines = text.split("\n");
  const records: LogRecord[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = HEADER.exec(lines[index]);
    if (header === null) {
      index++;
      continue;
    }
    const runId = header[5];
    const body: string[] = [lines[index]];
    index++;
    let exitCode: number | null = null;
    while (index < lines.length) {
      const line = lines[index];
      body.push(line);
      index++;
      const closing = closingOf(line, runId);
      if (closing !== null) {
        exitCode = closing.exitCode;
        break;
      }
      // Следующая шапка вместо закрывающего маркера: предыдущая запись
      // оборвана (спека, «Граничные случаи»). Её строку возвращаем
      // обратно — она начинает следующую запись.
      if (HEADER.test(line)) {
        body.pop();
        index--;
        break;
      }
    }
    records.push({
      runId,
      commandLine: commandLineOf(body),
      exitCode,
      startedAt: startedAtOf(header),
      // Пустая строка-разделитель — часть напечатанной записи (спека).
      text: `${body.join("\n").replace(/\n+$/, "")}\n\n`,
    });
  }
  return records;
}

/**
 * Закрывающий маркер этой записи: строка — не он либо `run=` чужой →
 * `null`. Именно совпадение идентификатора и держит границу.
 *
 * Маркер без `exit=` запись закрывает, но кода не даёт: подставить ноль
 * значило бы выдать испорченную запись за успешную и спрятать её от
 * `--failed`.
 */
function closingOf(
  line: string,
  runId: string,
): { readonly exitCode: number | null } | null {
  const closing = new RegExp(
    `^--- end run=${escapeRegExp(runId)} exit=(-?\\d+)`,
  ).exec(line);
  if (closing !== null) return { exitCode: Number(closing[1]) };
  return line.startsWith(`--- end run=${runId} `) ? { exitCode: null } : null;
}

/** Строка вызова записи: первая строка, начинающаяся с `$ `. */
function commandLineOf(body: readonly string[]): string {
  const found = body.find((line) => line.startsWith("$ "));
  return found === undefined ? "" : found.slice(2);
}

/**
 * Момент шапки в unix-секундах. Смещение зоны — из самой шапки: журнал
 * пишется местным временем машины, и читать его в UTC значит сдвинуть
 * все отборы `--since` на часовой пояс.
 */
function startedAtOf(header: RegExpExecArray): number | null {
  const parsed = Date.parse(
    `${header[1]}T${header[2]}.${header[3]}${zoneOf(header[4])}`,
  );
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/** Смещение шапки в форме ISO; нечитаемое — пустая строка (локальное). */
function zoneOf(raw: string): string {
  return /^[+-]\d{2}:\d{2}$/.test(raw) ? raw : "";
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
