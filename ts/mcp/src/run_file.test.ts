/**
 * `run:` через MCP (`platform/program-input.md`, «Справка, дополнение и
 * MCP», «Секрет»): программа у агента — только файлом; ответ и отказ —
 * `structuredContent`, человека нет — «спросить некого», секрет каталога
 * настроек не выходит ни в одну секцию ответа.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { call, withClient, withStack } from "./testkit.ts";

const SECRET = "s3cr3t";

/** Временный `HOME` с токеном в каталоге настроек и каталогом `w`. */
async function withHome(body: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await mkdir(`${home}/.config/mpu`, { recursive: true });
    await mkdir(`${home}/w`);
    await writeFile(`${home}/.config/mpu/mcp-token`, SECRET);
    await writeFile(`${home}/w/x.mpu`, "@col print");
    await writeFile(
      `${home}/w/y.mpu`,
      "ask kiten comment id: 11 text: a",
    );
    await body(home);
  } finally {
    await rm(home, { recursive: true });
  }
}

/** Строка `words` тулом `mpu` на стеке с сервером строк в `home`. */
function viaMcp(home: string, words: readonly string[]) {
  let result: Awaited<ReturnType<typeof call>> | undefined;
  return withStack(
    (stack) =>
      withClient(stack, async (client) => {
        result = await call(stack, client, "mpu", { words });
      }),
    { io: { env: (name) => name === "HOME" ? home : undefined } },
  ).then(() => {
    if (result === undefined) throw new Error("тул не ответил");
    return result;
  });
}

it("MCP run: — программа из файла с параметром", () =>
  withHome(async (home) => {
    const result = await viaMcp(home, [
      "run:",
      `${home}/w/x.mpu`,
      "col:",
      "review",
    ]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toStrictEqual({
      stdout: "review\n",
      stderr: "",
      exit: 0,
    });
  }));

it("MCP run: — нет файла: отказ объектом без подсказки", () =>
  withHome(async (home) => {
    const result = await viaMcp(home, ["run:", `${home}/нет.mpu`]);
    const text = `mpu run: ${home}/нет.mpu: нет файла ${home}/нет.mpu`;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      stdout: "",
      stderr: `${text}\n`,
      exit: 2,
      refusal: { reason: "нет файла", hint: null, candidates: [], text },
    });
  }));

it("MCP run: — ask в тексте без elicitation: спросить некого", () =>
  withHome(async (home) => {
    const result = await viaMcp(home, ["run:", `${home}/w/y.mpu`]);
    expect(result.isError).toBe(true);
    const content = result.structuredContent as Record<string, unknown>;
    expect([content.stderr, content.exit]).toStrictEqual([
      "mpu kiten comment id: 11 text: a: нужно подтверждение, а спросить " +
      "некого\n",
      1,
    ]);
  }));

it("MCP run: — файл каталога настроек не открывается", () =>
  withHome(async (home) => {
    const path = `${home}/.config/mpu/mcp-token`;
    const result = await viaMcp(home, ["run:", path]);
    expect(result.isError).toBe(true);
    const content = result.structuredContent as Record<string, unknown>;
    expect(content.stderr).toStrictEqual(
      `mpu run: ${path}: программа — файл .mpu\n`,
    );
    expect(JSON.stringify(result).includes(SECRET)).toBe(false);
  }));
