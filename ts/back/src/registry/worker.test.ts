/**
 * Воркер разбора кода из установленного пакета `@mpu/cmd-code`
 * (`platform/tslibs-commands.md`, D1). Вопрос по нескольким
 * репозиториям считается по репозиторию в отдельном потоке, а поток
 * грузит модуль по адресу рядом с собранным кодом пакета
 * (`dist/repo_worker.js`). Тесты пакета идут по его исходникам, smoke —
 * по бинарю; раскладку `dist/`, на которой идут `ts/` из исходников и
 * `bun run back`, видит только этот тест.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeFakeIo } from "@mpu/command/testing";
import { runCli } from "../entrypoint/mod.ts";

/** Репозиторий с одним файлом `src/a.ts`; `.git` делает его репозиторием. */
async function repo(dir: string, source: string): Promise<void> {
  await mkdir(`${dir}/src`, { recursive: true });
  await mkdir(`${dir}/.git`, { recursive: true });
  await writeFile(
    `${dir}/tsconfig.json`,
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
  );
  await writeFile(`${dir}/src/a.ts`, source);
}

it("code name по двум репозиториям: воркер пакета отвечает за каждый", async () => {
  const ws = await mkdtemp(join(tmpdir(), "code-worker-"));
  try {
    await writeFile(`${ws}/.mp-workspace-root`, "");
    await repo(
      `${ws}/probe`,
      "export function addOne(n: number): number {\n  return n + 1;\n}\n",
    );
    await repo(
      `${ws}/probe-two`,
      "export function addOne(n: number): number {\n  return n + 2;\n}\n",
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ["code", "name", "addOne"],
      makeFakeIo({ cwd: () => `${ws}/probe` }),
      {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      },
    );
    expect(code, `stderr: ${err.join("")}`).toBe(0);
    const stdout = out.join("");
    // Разделы идут в порядке перечня репозиториев: оба посчитаны.
    expect(stdout.indexOf("probe · "), stdout).toBe(0);
    expect(stdout.includes("\nprobe-two · "), stdout).toBe(true);
  } finally {
    await rm(ws, { recursive: true });
  }
});
