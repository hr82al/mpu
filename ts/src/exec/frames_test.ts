/**
 * Кодек кадров WebSocket. Проверка — круговая (закодировали →
 * разобрали) и на границах длины, где меняется форма заголовка.
 */

import { assertEquals } from "@std/assert";
import { decodeFrame, encodeFrame, OPCODE, randomMask } from "./frames.ts";

const MASK = Uint8Array.of(1, 2, 3, 4);

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

Deno.test("кадр клиента маскирован, кадр сервера — нет", async (t) => {
  await t.step("бит маски и XOR полезной нагрузки", () => {
    const frame = encodeFrame(OPCODE.ping, Uint8Array.of(0xaa), MASK);
    assertEquals(frame[0], 0x89);
    assertEquals(frame[1], 0x81);
    assertEquals(frame.subarray(2, 6), MASK);
    assertEquals(frame[6], 0xaa ^ 1);
  });

  await t.step("разбор снимает маску", () => {
    const cut = decodeFrame(
      encodeFrame(OPCODE.text, Uint8Array.of(1, 2), MASK),
    );
    assertEquals(cut?.frame.payload, Uint8Array.of(1, 2));
    assertEquals(cut?.frame.opcode, OPCODE.text);
    assertEquals(cut?.frame.fin, true);
  });
});

Deno.test("границы длины: 125, 126 и 65536", async (t) => {
  for (const length of [0, 125, 126, 0x1_00_00]) {
    await t.step(`${length} байт`, () => {
      const cut = decodeFrame(
        encodeFrame(OPCODE.binary, bytes(length), randomMask()),
      );
      assertEquals(cut?.frame.payload.length, length);
      assertEquals(cut?.rest.length, 0);
    });
  }
});

Deno.test("недочитанный кадр — null, лишний хвост — остаток", async (t) => {
  const frame = encodeFrame(OPCODE.text, bytes(130), MASK);

  await t.step("данных не хватает", () => {
    for (const cut of [0, 1, 3, frame.length - 1]) {
      assertEquals(decodeFrame(frame.subarray(0, cut)), null, `${cut} байт`);
    }
  });

  await t.step("два кадра подряд разбираются по одному", () => {
    const pair = new Uint8Array(frame.length * 2);
    pair.set(frame);
    pair.set(frame, frame.length);
    const first = decodeFrame(pair);
    assertEquals(first?.rest.length, frame.length);
    assertEquals(decodeFrame(first?.rest ?? new Uint8Array())?.rest.length, 0);
  });
});

Deno.test("сервер шлёт кадры без маски", () => {
  // Ответ сервера маскировать запрещено, и разбор обязан читать обе
  // формы: тестовый сервер пользуется этим же кодеком.
  const unmasked = Uint8Array.of(0x81, 0x02, 0x41, 0x42);
  const cut = decodeFrame(unmasked);
  assertEquals(cut?.frame.payload, Uint8Array.of(0x41, 0x42));
  assertEquals(cut?.rest.length, 0);
});
