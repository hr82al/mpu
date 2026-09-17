/**
 * Тело `multipart/form-data`: части, их заголовки, экранирование имени
 * файла и закрывающая граница. Форма задана спекой Kaiten
 * (`docs/specs/platform/kaiten-http.md`, раздел «Запрос»), но сам формат
 * общий, и потребителей у него двое — вызовы Kaiten с файлами и
 * `sendDocument` Bot API (`docs/specs/telegram-log.md`); поэтому сборщик
 * лежит в транспортном слое, а не внутри одного из клиентов.
 *
 * Сборка — чистая функция: границу выбирает вызывающий (транспорт
 * генерирует её на запрос), поэтому тело воспроизводимо и проверяется
 * побайтно. О вызовах, принимающих файлы, файл не знает — имя поля формы
 * задаёт вызывающий.
 */

/** Часть тела: текстовое поле либо файл с именем и содержимым. */
export type MultipartPart =
  | {
    readonly kind: "field";
    readonly name: string;
    readonly value: string;
  }
  | {
    readonly kind: "file";
    /** Имя поля формы: его задаёт каталог (`files[]` у вызова 5, `file` у 13). */
    readonly name: string;
    readonly filename: string;
    readonly bytes: Uint8Array;
  };

/** Собранное тело и заголовок его типа с объявленной границей. */
export interface MultipartBody {
  readonly contentType: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Части и строки заголовков разделяются CRLF (`kaiten-http.md`). */
const CRLF = "\r\n";

/** Тип файловой части, когда расширение имени таблице неизвестно. */
const DEFAULT_FILE_TYPE = "application/octet-stream";

/**
 * Тип содержимого файловой части по расширению имени. Таблица задана
 * спекой и закрыта списком (`kaiten-http.md`, «Запрос») — ровно те типы,
 * что команды прикладывают к карточке; всё прочее закрывает умолчание,
 * названное там же. Системная таблица типов сюда не тянется: она стоит
 * времени старта процесса.
 */
const FILE_TYPES = new Map<string, string>([
  ["md", "text/markdown"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["html", "text/html"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

/**
 * Тело `multipart/form-data` из частей: по part'у на поле и на файл, в
 * порядке передачи. Граница объявляется в `contentType` и закрывает тело
 * двумя дефисами на конце.
 */
export function buildMultipartBody(
  parts: readonly MultipartPart[],
  boundary: string,
): MultipartBody {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(
      encoder.encode(`--${boundary}${CRLF}${partHeaders(part)}${CRLF}${CRLF}`),
    );
    chunks.push(
      part.kind === "field" ? encoder.encode(part.value) : part.bytes,
    );
    chunks.push(encoder.encode(CRLF));
  }
  chunks.push(encoder.encode(`--${boundary}--`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    bytes: concat(chunks),
  };
}

/** Заголовки одной части: расположение, а у файла — ещё и тип содержимого. */
function partHeaders(part: MultipartPart): string {
  switch (part.kind) {
    case "field":
      return `Content-Disposition: form-data; name="${part.name}"`;
    case "file":
      return [
        `Content-Disposition: form-data; name="${part.name}"; filename="${
          escapeFilename(part.filename)
        }"`,
        `Content-Type: ${fileContentType(part.filename)}`,
      ].join(CRLF);
    default: {
      const unknown: never = part;
      throw new TypeError(`неизвестная часть тела: ${String(unknown)}`);
    }
  }
}

/**
 * Имя файла в заголовке части: кавычка — `%22`, перевод строки и возврат
 * каретки — пробел (`kaiten-http.md`). Без этого part ломается: кавычка
 * закрывает значение раньше времени, а перевод строки — весь заголовок.
 */
function escapeFilename(filename: string): string {
  return filename.replaceAll('"', "%22").replace(/[\r\n]/g, " ");
}

/** Тип содержимого по расширению имени; неизвестное — общее умолчание. */
function fileContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return DEFAULT_FILE_TYPE;
  return FILE_TYPES.get(filename.slice(dot + 1).toLowerCase()) ??
    DEFAULT_FILE_TYPE;
}

/** Склейка частей одним буфером: суммарный размер известен заранее. */
function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
