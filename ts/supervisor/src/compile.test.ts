/**
 * Настоящая сборка `compile:back` (`platform/supervisor-install.md`,
 * «Части»): собранный `mpu-back` отвечает на `--version` и несёт в себе
 * воркер разбора кода и оба `.wasm` Telegram — без `--include` они не
 * встроены, и программа падает на `code` и `telegram`. Признак — кусок
 * содержимого каждого файла в байтах бинаря, а не имя (имена встречаются
 * и в исходнике).
 */

import { expect, it, onTestFinished } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INCLUDED = [
  "back/src/code/repo_worker.ts",
  "back/src/telegram/mtcute.wasm",
  "back/src/telegram/mtcute-simd.wasm",
];

/** Сборка идёт дольше умолчания Vitest (5 с); у `deno test` срока не было. */
const BUILD_MS = 300_000;

/** Код выхода и вывод программы; окружение — родителя плюс `env`. */
async function output(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, { env: { ...process.env, ...env } });
  // Тест упал по сроку — сборка не переживает его.
  onTestFinished(() => {
    child.kill();
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code] = await once(child, "close");
  return {
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

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

it("compile:back — --version и встроенные воркер и .wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const out = `${dir}/mpu-back`;
    const built = await output("deno", ["task", "compile:back"], {
      MPU_OUT: out,
    });
    expect(built.code, built.stderr).toBe(0);
    // Бинарь из временного каталога запускается через `bash`.
    const version = await output("/bin/bash", [
      "-c",
      '"$0" --version',
      out,
    ]);
    expect([version.code, version.stdout], version.stderr).toStrictEqual([
      0,
      "0.1.0\n",
    ]);
    const binary = await readFile(out);
    for (const path of INCLUDED) {
      const bytes = await readFile(path);
      // Кусок из середины: не заголовок, общий для всех .wasm.
      const middle = Math.floor(bytes.length / 2);
      const piece = bytes.subarray(middle, middle + 256);
      expect(contains(binary, piece), `${path} не встроен`).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
}, BUILD_MS);
