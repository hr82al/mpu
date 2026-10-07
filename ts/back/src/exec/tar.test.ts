/**
 * Архив tar из одного файла. Проверяется разбором заголовка обратно:
 * поля, контрольная сумма и выравнивание блоков — всё, за чем tar в
 * контейнере и следит.
 */

import { describe, expect, it } from "vitest";
import { tarFile } from "./tar.ts";

const decoder = new TextDecoder();

/** Поле заголовка текстом, без хвостовых NUL и пробелов. */
function field(archive: Uint8Array, at: number, length: number): string {
  return decoder.decode(archive.subarray(at, at + length)).replaceAll(
    /[\0 ]+$/g,
    "",
  );
}

it("заголовок ustar: имя, права, размер, тип", () => {
  const content = new TextEncoder().encode("тело\n");
  const archive = tarFile("__MPU_PSSH_STDIN", content, { mode: 0o644 });

  expect(field(archive, 0, 100)).toBe("__MPU_PSSH_STDIN");
  expect(field(archive, 100, 8)).toBe("0000644");
  expect(field(archive, 124, 12)).toStrictEqual(
    `${content.length.toString(8)}`.padStart(11, "0"),
  );
  expect(String.fromCharCode(archive[156])).toBe("0");
  expect(field(archive, 257, 8)).toStrictEqual("ustar\0" + "00");
});

it("контрольная сумма сходится", () => {
  const archive = tarFile("f", new Uint8Array(3));
  const declared = parseInt(field(archive, 148, 8), 8);
  let sum = 0;
  for (const [index, byte] of archive.subarray(0, 512).entries()) {
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }
  expect(declared).toStrictEqual(sum);
});

describe("тело выровнено по блоку, в конце два нулевых блока", () => {
  it("пустое содержимое — только заголовок и хвост", () => {
    expect(tarFile("f", new Uint8Array()).length).toStrictEqual(512 * 3);
  });

  it("512 байт занимают ровно блок", () => {
    expect(tarFile("f", new Uint8Array(512)).length).toStrictEqual(512 * 4);
  });

  it("513 байта — два блока", () => {
    const archive = tarFile("f", new Uint8Array(513).fill(9));
    expect(archive.length).toStrictEqual(512 * 5);
    // Добивка нулями, а не мусором: tar читает ровно `size` байт, но
    // мусор в хвосте — след чужой памяти в архиве.
    expect(archive.subarray(512 + 513, 512 * 3).some((b) => b !== 0)).toBe(
      false,
    );
  });

  it("последние два блока нулевые", () => {
    const archive = tarFile("f", new Uint8Array(10).fill(1));
    expect(archive.subarray(archive.length - 1024).some((b) => b !== 0)).toBe(
      false,
    );
  });
});

it("одинаковый вход — одинаковые байты", () => {
  expect(tarFile("f", new Uint8Array([1, 2, 3]))).toStrictEqual(
    tarFile("f", new Uint8Array([1, 2, 3])),
  );
});
