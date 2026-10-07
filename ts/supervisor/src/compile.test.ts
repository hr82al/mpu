/**
 * Настоящая сборка `compile:back` (`platform/supervisor-install.md`,
 * «Части»; `platform/node-runtime.md`, [S.11]): собранный `mpu-back`
 * отвечает на `--version` и несёт в себе воркер разбора кода (вторым
 * входом сборки) и оба wasm Telegram (модулем `wasm_modules.ts`) — без
 * них программа падает на `code` и `telegram`. Признак — кусок
 * содержимого в байтах бинаря, а не имя файла.
 */

import { expect, it, onTestFinished } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MTCUTE_SIMD_WASM,
  MTCUTE_WASM,
} from "../../back/src/telegram/wasm_modules.ts";

/** Что обязано быть в бинаре: имя для сообщения и кусок содержимого. */
function embedded(): readonly (readonly [string, Uint8Array])[] {
  const encoder = new TextEncoder();
  // Кусок из середины base64: не заголовок, общий для обоих wasm.
  const middle = (text: string) =>
    encoder.encode(text.slice(text.length / 2, text.length / 2 + 256));
  return [
    // Второй вход сборки лежит в корне файловой системы бинаря
    // (`--root back/src/code`): там его ищет `new URL("./repo_worker.ts",
    // import.meta.url)` собранного кода. Без входа пути в бинаре нет
    // (проба 2026-10-07).
    [
      "back/src/code/repo_worker.ts",
      encoder.encode("$bunfs/root/repo_worker.js"),
    ],
    ["mtcute.wasm", middle(MTCUTE_WASM)],
    ["mtcute-simd.wasm", middle(MTCUTE_SIMD_WASM)],
  ];
}

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

it("compile:back — --version и встроенные воркер и wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const out = `${dir}/mpu-back`;
    const built = await output("bun", ["run", "compile:back"], {
      MPU_OUT: out,
    });
    expect(built.code, built.stderr).toBe(0);
    // Бинарь из временного каталога запускается через `bash`.
    const version = await output("/bin/bash", ["-c", '"$0" --version', out]);
    expect([version.code, version.stdout], version.stderr).toStrictEqual([
      0,
      "0.1.0\n",
    ]);
    const binary = await readFile(out);
    for (const [name, piece] of embedded()) {
      expect(contains(binary, piece), `${name} не встроен`).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
