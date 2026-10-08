/**
 * Кодек кадров WebSocket. Проверка — круговая (закодировали →
 * разобрали) и на границах длины, где меняется форма заголовка.
 */

import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, OPCODE, randomMask } from "./frames.ts";

const MASK = Uint8Array.of(1, 2, 3, 4);

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe("кадр клиента маскирован, кадр сервера — нет", () => {
  it("бит маски и XOR полезной нагрузки", () => {
    const frame = encodeFrame(OPCODE.ping, Uint8Array.of(0xaa), MASK);
    expect(frame[0]).toBe(0x89);
    expect(frame[1]).toBe(0x81);
    expect(frame.subarray(2, 6)).toStrictEqual(MASK);
    expect(frame[6]).toStrictEqual(0xaa ^ 1);
  });

  it("разбор снимает маску", () => {
    const cut = decodeFrame(
      encodeFrame(OPCODE.text, Uint8Array.of(1, 2), MASK),
    );
    expect(cut?.frame.payload).toStrictEqual(Uint8Array.of(1, 2));
    expect(cut?.frame.opcode).toStrictEqual(OPCODE.text);
    expect(cut?.frame.fin).toBe(true);
  });
});

describe("границы длины: 125, 126 и 65536", () => {
  for (const length of [0, 125, 126, 0x1_00_00]) {
    it(`${length} байт`, () => {
      const cut = decodeFrame(
        encodeFrame(OPCODE.binary, bytes(length), randomMask()),
      );
      expect(cut?.frame.payload.length).toStrictEqual(length);
      expect(cut?.rest.length).toBe(0);
    });
  }
});

describe("недочитанный кадр — null, лишний хвост — остаток", () => {
  const frame = encodeFrame(OPCODE.text, bytes(130), MASK);

  it("данных не хватает", () => {
    for (const cut of [0, 1, 3, frame.length - 1]) {
      expect(decodeFrame(frame.subarray(0, cut)), `${cut} байт`).toStrictEqual(
        null,
      );
    }
  });

  it("два кадра подряд разбираются по одному", () => {
    const pair = new Uint8Array(frame.length * 2);
    pair.set(frame);
    pair.set(frame, frame.length);
    const first = decodeFrame(pair);
    expect(first?.rest.length).toStrictEqual(frame.length);
    expect(decodeFrame(first?.rest ?? new Uint8Array())?.rest.length).toBe(0);
  });
});

it("сервер шлёт кадры без маски", () => {
  // Ответ сервера маскировать запрещено, и разбор обязан читать обе
  // формы: тестовый сервер пользуется этим же кодеком.
  const unmasked = Uint8Array.of(0x81, 0x02, 0x41, 0x42);
  const cut = decodeFrame(unmasked);
  expect(cut?.frame.payload).toStrictEqual(Uint8Array.of(0x41, 0x42));
  expect(cut?.rest.length).toBe(0);
});
