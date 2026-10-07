/**
 * Демультиплексирование потока Docker (`docs/specs/logs.md`,
 * portainer-путь): кадры с восьмибайтовым заголовком, big-endian длина,
 * отбрасывание потока 0 и неполного хвоста, ответ TTY-контейнера без
 * фрейминга вовсе.
 */

import { expect, it } from "vitest";
import { demuxDockerStream } from "./mod.ts";

const utf8 = new TextEncoder();

/** Кадр потока `stream` с полезной нагрузкой `payload`. */
function frame(stream: number, payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? utf8.encode(payload) : payload;
  const out = new Uint8Array(8 + bytes.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, bytes.length, false);
  out.set(bytes, 8);
  return out;
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

it("кадры разводятся по потокам в порядке поступления", () => {
  const streams = demuxDockerStream(join(
    frame(1, "первая\n"),
    frame(2, "ошибка\n"),
    frame(1, "вторая\n"),
  ));
  expect(text(streams.stdout)).toBe("первая\nвторая\n");
  expect(text(streams.stderr)).toBe("ошибка\n");
});

it("длина кадра читается big-endian", () => {
  // Payload длиннее 255 байт: при little-endian длина уехала бы в
  // сотни мегабайт, кадр стал бы «неполным» и весь вывод пропал.
  const long = "я".repeat(300);
  const streams = demuxDockerStream(join(frame(1, long), frame(1, "хвост")));
  expect(text(streams.stdout)).toStrictEqual(`${long}хвост`);
});

it("поток 0 и неполный хвостовой кадр отбрасываются", () => {
  const truncated = frame(1, "потерянное").subarray(0, 12);
  const streams = demuxDockerStream(join(
    frame(0, "ввод"),
    frame(1, "видно\n"),
    truncated,
  ));
  expect(text(streams.stdout)).toBe("видно\n");
  expect(text(streams.stderr)).toBe("");
});

it("хвост короче заголовка кадра отбрасывается", () => {
  const streams = demuxDockerStream(join(
    frame(1, "видно\n"),
    new Uint8Array([1, 0, 0]),
  ));
  expect(text(streams.stdout)).toBe("видно\n");
});

it("первый байт вне {0,1,2} — фрейминга нет, всё это stdout", () => {
  const raw = utf8.encode("строка без фрейминга\n");
  const streams = demuxDockerStream(raw);
  expect(text(streams.stdout)).toBe("строка без фрейминга\n");
  expect(streams.stderr.length).toBe(0);
});

it("пустой ответ — пустые потоки", () => {
  const streams = demuxDockerStream(new Uint8Array());
  expect(streams.stdout.length).toBe(0);
  expect(streams.stderr.length).toBe(0);
});
