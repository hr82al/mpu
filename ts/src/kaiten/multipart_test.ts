/**
 * Тело `multipart/form-data` (`docs/specs/platform/kaiten-http.md`,
 * раздел «Запрос»): состав частей и их заголовки, тип содержимого файла
 * по расширению, экранирование имени файла, закрывающая граница.
 *
 * Граница здесь задаётся явно: её генерация — дело транспорта, а тело
 * проверяется побайтно. Содержимое файлов в фикстурах — текст, поэтому
 * тело читается строкой.
 */

import { assertEquals } from "@std/assert";
import { buildMultipartBody, type MultipartPart } from "./multipart.ts";

const BOUNDARY = "mpu-proba-granica";

/** Тело строкой: фикстуры целиком в UTF-8. */
function bodyText(parts: readonly MultipartPart[]): string {
  return new TextDecoder().decode(buildMultipartBody(parts, BOUNDARY).bytes);
}

/** Файловая часть с текстовым содержимым. */
function filePart(filename: string, text = ""): MultipartPart {
  return {
    kind: "file",
    name: "files[]",
    filename,
    bytes: new TextEncoder().encode(text),
  };
}

Deno.test("тело из текстового поля и двух файлов — part на каждый", () => {
  const body = bodyText([
    { kind: "field", name: "text", value: "смотри вложения" },
    filePart("otchet.md", "# отчёт\n"),
    filePart("dannye.csv", "a,b\n1,2\n"),
  ]);

  assertEquals(
    body,
    [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="text"',
      "",
      "смотри вложения",
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="files[]"; filename="otchet.md"',
      "Content-Type: text/markdown",
      "",
      "# отчёт\n",
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="files[]"; filename="dannye.csv"',
      "Content-Type: text/csv",
      "",
      "a,b\n1,2\n",
      `--${BOUNDARY}--`,
    ].join("\r\n"),
  );
});

Deno.test("заголовок типа содержимого объявляет границу тела", () => {
  const built = buildMultipartBody([filePart("otchet.md")], BOUNDARY);

  assertEquals(built.contentType, `multipart/form-data; boundary=${BOUNDARY}`);
});

Deno.test("тип содержимого файла — по расширению имени", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["otchet.md", "text/markdown"],
    ["zametka.txt", "text/plain"],
    ["dannye.csv", "text/csv"],
    ["otvet.json", "application/json"],
    ["stranica.html", "text/html"],
    ["shema.svg", "image/svg+xml"],
    ["snimok.png", "image/png"],
    ["foto.jpg", "image/jpeg"],
    ["foto.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["kartinka.webp", "image/webp"],
    ["dogovor.pdf", "application/pdf"],
    ["arhiv.zip", "application/zip"],
    [
      "tablica.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    // Регистр расширения роли не играет.
    ["SNIMOK.PNG", "image/png"],
    // Неизвестное расширение и его отсутствие — общее умолчание.
    ["dump.qqq", "application/octet-stream"],
    ["bez-rasshireniya", "application/octet-stream"],
  ];

  for (const [filename, contentType] of cases) {
    await t.step(filename, () => {
      assertEquals(
        bodyText([filePart(filename)]).includes(
          `Content-Type: ${contentType}\r\n`,
        ),
        true,
        `часть файла ${filename} должна объявлять ${contentType}`,
      );
    });
  }
});

Deno.test("имя файла экранируется, иначе part ломается", () => {
  const body = bodyText([
    filePart('otchet "июль"\r\nи август.md'),
  ]);

  // Кавычка — `%22`, перевод строки и возврат каретки — пробел.
  assertEquals(
    body.includes(
      'filename="otchet %22июль%22  и август.md"',
    ),
    true,
    `имя файла экранировано не по спеке: ${body}`,
  );
});

Deno.test("пустой список частей — только закрывающая граница", () => {
  assertEquals(bodyText([]), `--${BOUNDARY}--`);
});
