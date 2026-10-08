/**
 * Вплетение `mpu update` (`docs/specs/update.md`) в точку входа: отказ
 * недоступного main одной строкой и справка с пределами времени. Прогон
 * идёт через `runCli`; прочие тесты команды — в пакете `@mpu/cmd-update`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS } from "@mpu/cmd-update";
import { openCacheDb } from "@mpu/command/store";
import type { EnvFile } from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import { runCli } from "./mod.ts";

function envFileFake(values: Readonly<Record<string, string>> = {}): EnvFile {
  return {
    get: (name) => values[name],
    require: () => {
      throw new Error("envFile.require must not be touched");
    },
    set: () => {
      throw new Error("envFile.set must not be touched");
    },
    values: () => ({ ...values }),
  };
}

it("недоступный main: отказ одной строкой, exit 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io = makeFakeIo({
      openCacheDb: () => openCacheDb(`${dir}/mpu.db`),
      envFile: envFileFake({}),
    });
    const out: string[] = [];
    const err: string[] = [];
    // Через точку входа целиком: `pg_0` в env-файле нет, поэтому в PG не
    // уходит ни байта, а команда отказывает так же, как при недоступном
    // сервере (`update.md`, «Известные отклонения»).
    const code = await runCli(["update"], io, {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    });

    expect(code).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toBe(
      "mpu update: main (sl-0) недоступен: pg_0 не задан в env-файле\n",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("справка называет пределы времени", async () => {
  const io = makeFakeIo();
  const out: string[] = [];
  const code = await runCli(["update", "--help"], io, {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });

  expect(code).toBe(0);
  const help = out.join("");
  expect(help).toContain(`${CONNECT_TIMEOUT_MS} ms на соединение`);
  expect(help).toContain(`${QUERY_TIMEOUT_MS} ms на запрос`);
  expect(help).toContain("--quiet");
});
