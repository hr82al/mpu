/**
 * Подпроцесс поверх `node:child_process` — одинаково под Bun, Deno и Node
 * (`platform/node-runtime.md`, [S.9a]): код выхода, оба потока, отказ
 * запуска кодом ОС, сигнал как код `128 + номер`, отмена — статусом.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasErrorCode } from "../oserror/mod.ts";
import { runProgram, startProgram } from "./mod.ts";

const decoder = new TextDecoder();

describe("запуск до конца: код и оба потока", () => {
  it("ненулевой код и раздельные потоки", async () => {
    const out = await runProgram("/bin/sh", {
      args: ["-c", "printf out; printf err >&2; exit 3"],
      stdout: "piped",
      stderr: "piped",
    });
    expect({
      success: out.success,
      code: out.code,
      signal: out.signal,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    }).toStrictEqual({
      success: false,
      code: 3,
      signal: null,
      stdout: "out",
      stderr: "err",
    });
  });

  it("выход по сигналу — код 128 + номер и имя сигнала", async () => {
    const out = await runProgram("/bin/sh", { args: ["-c", "kill -TERM $$"] });
    expect([out.success, out.code, out.signal]).toStrictEqual([
      false,
      143,
      "SIGTERM",
    ]);
  });

  it("неподключённый поток пуст, а не отсутствует", async () => {
    const out = await runProgram("/bin/sh", {
      args: ["-c", "printf out"],
      stdout: "null",
    });
    expect([out.code, out.stdout.length]).toStrictEqual([0, 0]);
  });

  it("каталог запуска — cwd", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "mpu-")));
    try {
      const out = await runProgram("/bin/pwd", { cwd: dir, stdout: "piped" });
      expect(decoder.decode(out.stdout).trim()).toBe(dir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("окружение", () => {
  it("env дополняет унаследованное, а не заменяет его", async () => {
    const out = await runProgram("/bin/sh", {
      args: ["-c", 'printf "%s|%s" "$MPU_PROBE" "$PATH"'],
      env: { MPU_PROBE: "да" },
      stdout: "piped",
    });
    expect(decoder.decode(out.stdout)).toBe(`да|${process.env.PATH}`);
  });

  it("clearEnv — только переданные переменные", async () => {
    const out = await runProgram("/bin/sh", {
      args: ["-c", 'printf "%s|%s" "$MPU_PROBE" "${HOME-нет}"'],
      env: { MPU_PROBE: "да" },
      clearEnv: true,
      stdout: "piped",
    });
    expect(decoder.decode(out.stdout)).toBe("да|нет");
  });
});

describe("отказ запуска", () => {
  it("программы нет — отказ с кодом ENOENT до потоков", async () => {
    const err = await startProgram("/bin/net-takogo-binarya", {
      stdout: "piped",
    }).then(() => undefined, (err: unknown) => err);
    expect(hasErrorCode(err, "ENOENT"), String(err)).toBe(true);
  });

  it("то же у запуска до конца", async () => {
    const err = await runProgram("/bin/net-takogo-binarya", {}).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(hasErrorCode(err, "ENOENT"), String(err)).toBe(true);
  });
});

describe("запущенный процесс", () => {
  it("stdin доезжает, его закрытие — конец ввода", async () => {
    const child = await startProgram("/bin/cat", {
      stdin: "piped",
      stdout: "piped",
    });
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("строка"));
    await writer.close();
    const out = await child.output();
    expect([out.code, decoder.decode(out.stdout)]).toStrictEqual([
      0,
      "строка",
    ]);
  });

  it("stdin null — конец ввода сразу", async () => {
    const out = await runProgram("/bin/cat", { stdout: "piped" });
    expect([out.code, out.stdout.length]).toStrictEqual([0, 0]);
  });

  it("kill — статус по сигналу; повторный kill кончившегося не бросает", async () => {
    const child = await startProgram("/bin/sleep", { args: ["30"] });
    expect(typeof child.pid).toBe("number");
    child.kill("SIGKILL");
    const status = await child.status;
    expect([status.code, status.signal]).toStrictEqual([137, "SIGKILL"]);
    child.kill("SIGTERM");
  });

  it("отмена сигналом — SIGTERM и статус, а не отказ", async () => {
    const out = await runProgram("/bin/sleep", {
      args: ["30"],
      signal: AbortSignal.timeout(50),
    });
    expect([out.success, out.signal]).toStrictEqual([false, "SIGTERM"]);
  });

  it("уже отменённый сигнал снимает процесс сразу", async () => {
    const out = await runProgram("/bin/sleep", {
      args: ["30"],
      signal: AbortSignal.abort(),
    });
    expect(out.signal).toBe("SIGTERM");
  });
});
