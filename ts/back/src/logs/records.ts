/**
 * Результат `logs` как коллекция строк лога (`platform/long-output.md`,
 * §3): запись — строка с полями `time`, `host`, `service`, `stream`,
 * `text`, и обратно — записи в тот вид, который печатает команда.
 * Отбор над записями — дело вида данных (`collection-protocol.md`);
 * здесь только перевод туда и обратно.
 */

import type { LogEntry } from "../loki/mod.ts";
import { isoOf } from "./render.ts";

/** Строка лога — запись коллекции. */
export interface LogRecord {
  /** ISO UTC с миллисекундами; времени нет — пусто. */
  readonly time: string;
  readonly host: string;
  /** Метка `compose_service`; нет — пусто. */
  readonly service: string;
  /** `stdout` или `stderr`; источник не назвал — пусто. */
  readonly stream: string;
  /** Текст записи без хвостового перевода строки. */
  readonly text: string;
}

/** Снимок Portainer, как его держит результат команды. */
export interface SnapshotParts {
  readonly container: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Docker ставил метку времени в начало каждой строки. */
  readonly timestamps: boolean;
}

/** Записи Loki — записи коллекции. */
export function entryRecords(entries: readonly LogEntry[]): LogRecord[] {
  return entries.map((entry) => ({
    time: isoOf(entry.tsNs),
    host: entry.labels.host ?? "",
    service: entry.labels.compose_service ?? "",
    stream: entry.labels.stream ?? "",
    text: withoutNewline(entry.line),
  }));
}

/**
 * Записи коллекции — обратно в записи Loki для печати: время — с
 * точностью записи (миллисекунды, их и печатает префикс), а к тексту
 * возвращается ровно один перевод строки, который печать снимет.
 */
export function recordEntries(records: readonly LogRecord[]): LogEntry[] {
  return records.map((record) => ({
    tsNs: String(BigInt(Date.parse(record.time)) * 1_000_000n),
    line: `${record.text}\n`,
    labels: labelsOf(record),
  }));
}

/**
 * Строки снимка — записи: сначала stdout-часть, затем stderr-часть.
 * `text` — строка целиком, с меткой Docker, если она есть: иначе печать
 * отобранного потеряла бы её наносекунды.
 */
export function snapshotRecords(snapshot: SnapshotParts): LogRecord[] {
  return [
    ...linesOf(snapshot.stdout).map((text) =>
      snapshotRecord(text, "stdout", snapshot.timestamps)
    ),
    ...linesOf(snapshot.stderr).map((text) =>
      snapshotRecord(text, "stderr", snapshot.timestamps)
    ),
  ];
}

/** Снимок с другими строками: части собираются из записей своего потока. */
export function recordSnapshot(
  snapshot: SnapshotParts,
  records: readonly LogRecord[],
): SnapshotParts {
  const partOf = (stream: string) =>
    records
      .filter((record) => record.stream === stream)
      .map((record) => `${record.text}\n`)
      .join("");
  return { ...snapshot, stdout: partOf("stdout"), stderr: partOf("stderr") };
}

function snapshotRecord(
  text: string,
  stream: string,
  timestamps: boolean,
): LogRecord {
  return {
    time: timestamps ? dockerTime(text) : "",
    host: "",
    service: "",
    stream,
    text,
  };
}

/**
 * Время из метки Docker в начале строки (RFC 3339 с наносекундами) —
 * ISO с миллисекундами; не разобралось — пусто.
 */
function dockerTime(text: string): string {
  const space = text.indexOf(" ");
  const ms = Date.parse(space < 0 ? text : text.slice(0, space));
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

/** Строки части снимка; последний перевод строки строку не начинает. */
function linesOf(part: string): string[] {
  if (part === "") return [];
  return withoutNewline(part).split("\n");
}

function withoutNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Метки потока из полей записи: пустое поле — метки нет. */
function labelsOf(record: LogRecord): Record<string, string> {
  const pairs: [string, string][] = [
    ["host", record.host],
    ["compose_service", record.service],
    ["stream", record.stream],
  ];
  return Object.fromEntries(pairs.filter(([, value]) => value !== ""));
}
