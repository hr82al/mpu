/**
 * Архив tar из одного файла. Проверяется разбором заголовка обратно:
 * поля, контрольная сумма и выравнивание блоков — всё, за чем tar в
 * контейнере и следит.
 */

import { assertEquals } from "@std/assert";
import { tarFile } from "./tar.ts";

const decoder = new TextDecoder();

/** Поле заголовка текстом, без хвостовых NUL и пробелов. */
function field(archive: Uint8Array, at: number, length: number): string {
  return decoder.decode(archive.subarray(at, at + length)).replaceAll(
    /[\0 ]+$/g,
    "",
  );
}

Deno.test("заголовок ustar: имя, права, размер, тип", () => {
  const content = new TextEncoder().encode("тело\n");
  const archive = tarFile("__MPU_PSSH_STDIN", content, { mode: 0o644 });

  assertEquals(field(archive, 0, 100), "__MPU_PSSH_STDIN");
  assertEquals(field(archive, 100, 8), "0000644");
  assertEquals(
    field(archive, 124, 12),
    `${content.length.toString(8)}`.padStart(11, "0"),
  );
  assertEquals(String.fromCharCode(archive[156]), "0");
  assertEquals(field(archive, 257, 8), "ustar\0" + "00");
});

Deno.test("контрольная сумма сходится", () => {
  const archive = tarFile("f", new Uint8Array(3));
  const declared = parseInt(field(archive, 148, 8), 8);
  let sum = 0;
  for (const [index, byte] of archive.subarray(0, 512).entries()) {
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }
  assertEquals(declared, sum);
});

Deno.test("тело выровнено по блоку, в конце два нулевых блока", async (t) => {
  await t.step("пустое содержимое — только заголовок и хвост", () => {
    assertEquals(tarFile("f", new Uint8Array()).length, 512 * 3);
  });

  await t.step("512 байт занимают ровно блок", () => {
    assertEquals(tarFile("f", new Uint8Array(512)).length, 512 * 4);
  });

  await t.step("513 байта — два блока", () => {
    const archive = tarFile("f", new Uint8Array(513).fill(9));
    assertEquals(archive.length, 512 * 5);
    // Добивка нулями, а не мусором: tar читает ровно `size` байт, но
    // мусор в хвосте — след чужой памяти в архиве.
    assertEquals(
      archive.subarray(512 + 513, 512 * 3).some((b) => b !== 0),
      false,
    );
  });

  await t.step("последние два блока нулевые", () => {
    const archive = tarFile("f", new Uint8Array(10).fill(1));
    assertEquals(
      archive.subarray(archive.length - 1024).some((b) => b !== 0),
      false,
    );
  });
});

Deno.test("одинаковый вход — одинаковые байты", () => {
  assertEquals(
    tarFile("f", new Uint8Array([1, 2, 3])),
    tarFile("f", new Uint8Array([1, 2, 3])),
  );
});
