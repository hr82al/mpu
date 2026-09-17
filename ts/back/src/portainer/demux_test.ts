/**
 * Демультиплексирование потока Docker (`docs/specs/logs.md`,
 * portainer-путь): кадры с восьмибайтовым заголовком, big-endian длина,
 * отбрасывание потока 0 и неполного хвоста, ответ TTY-контейнера без
 * фрейминга вовсе.
 */

import { assertEquals } from "@std/assert";
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

Deno.test("кадры разводятся по потокам в порядке поступления", () => {
  const streams = demuxDockerStream(join(
    frame(1, "первая\n"),
    frame(2, "ошибка\n"),
    frame(1, "вторая\n"),
  ));
  assertEquals(text(streams.stdout), "первая\nвторая\n");
  assertEquals(text(streams.stderr), "ошибка\n");
});

Deno.test("длина кадра читается big-endian", () => {
  // Payload длиннее 255 байт: при little-endian длина уехала бы в
  // сотни мегабайт, кадр стал бы «неполным» и весь вывод пропал.
  const long = "я".repeat(300);
  const streams = demuxDockerStream(join(frame(1, long), frame(1, "хвост")));
  assertEquals(text(streams.stdout), `${long}хвост`);
});

Deno.test("поток 0 и неполный хвостовой кадр отбрасываются", () => {
  const truncated = frame(1, "потерянное").subarray(0, 12);
  const streams = demuxDockerStream(join(
    frame(0, "ввод"),
    frame(1, "видно\n"),
    truncated,
  ));
  assertEquals(text(streams.stdout), "видно\n");
  assertEquals(text(streams.stderr), "");
});

Deno.test("хвост короче заголовка кадра отбрасывается", () => {
  const streams = demuxDockerStream(join(
    frame(1, "видно\n"),
    new Uint8Array([1, 0, 0]),
  ));
  assertEquals(text(streams.stdout), "видно\n");
});

Deno.test("первый байт вне {0,1,2} — фрейминга нет, всё это stdout", () => {
  const raw = utf8.encode("строка без фрейминга\n");
  const streams = demuxDockerStream(raw);
  assertEquals(text(streams.stdout), "строка без фрейминга\n");
  assertEquals(streams.stderr.length, 0);
});

Deno.test("пустой ответ — пустые потоки", () => {
  const streams = demuxDockerStream(new Uint8Array());
  assertEquals(streams.stdout.length, 0);
  assertEquals(streams.stderr.length, 0);
});
