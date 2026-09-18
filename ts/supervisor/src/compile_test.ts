/**
 * Настоящая сборка `compile:back` (`platform/supervisor-install.md`,
 * «Части»): собранный `mpu-back` отвечает на `--version` и несёт в себе
 * воркер разбора кода и оба `.wasm` Telegram — без `--include` они не
 * встроены, и программа падает на `code` и `telegram`. Признак — кусок
 * содержимого каждого файла в байтах бинаря, а не имя (имена встречаются
 * и в исходнике).
 */

import { assertEquals } from "@std/assert";

const INCLUDED = [
  "back/src/code/repo_worker.ts",
  "back/src/telegram/mtcute.wasm",
  "back/src/telegram/mtcute-simd.wasm",
];

/** Есть ли `needle` в `haystack` (побайтно). */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  for (
    let at = haystack.indexOf(first);
    at >= 0;
    at = haystack.indexOf(first, at + 1)
  ) {
    if (at + needle.length > haystack.length) return false;
    let same = true;
    for (let i = 1; i < needle.length && same; i++) {
      same = haystack[at + i] === needle[i];
    }
    if (same) return true;
  }
  return false;
}

Deno.test("compile:back — --version и встроенные воркер и .wasm", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const out = `${dir}/mpu-back`;
    const built = await new Deno.Command("deno", {
      args: ["task", "compile:back"],
      env: { MPU_OUT: out },
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(built.code, 0, new TextDecoder().decode(built.stderr));
    // Бинарь из временного каталога запускается через `bash`: список
    // `--allow-run` теста знает программы по путям, временных там нет.
    const version = await new Deno.Command("/bin/bash", {
      args: ["-c", '"$0" --version', out],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      [version.code, new TextDecoder().decode(version.stdout)],
      [0, "0.1.0\n"],
      new TextDecoder().decode(version.stderr),
    );
    const binary = await Deno.readFile(out);
    for (const path of INCLUDED) {
      const bytes = await Deno.readFile(path);
      // Кусок из середины: не заголовок, общий для всех .wasm.
      const middle = Math.floor(bytes.length / 2);
      const piece = bytes.subarray(middle, middle + 256);
      assertEquals(contains(binary, piece), true, `${path} не встроен`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
