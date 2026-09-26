/**
 * `run:` через MCP (`platform/program-input.md`, «Справка, дополнение и
 * MCP», «Секрет»): программа у агента — только файлом; ответ и отказ —
 * `structuredContent`, человека нет — «спросить некого», секрет каталога
 * настроек не выходит ни в одну секцию ответа.
 */

import { assertEquals } from "@std/assert";
import { call, withClient, withStack } from "./testkit.ts";

const SECRET = "s3cr3t";

/** Временный `HOME` с токеном в каталоге настроек и каталогом `w`. */
async function withHome(body: (home: string) => Promise<void>) {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.config/mpu`, { recursive: true });
    await Deno.mkdir(`${home}/w`);
    await Deno.writeTextFile(`${home}/.config/mpu/mcp-token`, SECRET);
    await Deno.writeTextFile(`${home}/w/x.mpu`, "@col print");
    await Deno.writeTextFile(
      `${home}/w/y.mpu`,
      "ask kiten comment id: 11 text: a",
    );
    await body(home);
  } finally {
    await Deno.remove(home, { recursive: true });
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

Deno.test("MCP run: — программа из файла с параметром", () =>
  withHome(async (home) => {
    const result = await viaMcp(home, [
      "run:",
      `${home}/w/x.mpu`,
      "col:",
      "review",
    ]);
    assertEquals(result.isError, false);
    assertEquals(result.structuredContent, {
      stdout: "review\n",
      stderr: "",
      exit: 0,
    });
  }));

Deno.test("MCP run: — нет файла: отказ объектом без подсказки", () =>
  withHome(async (home) => {
    const result = await viaMcp(home, ["run:", `${home}/нет.mpu`]);
    const text = `mpu run: ${home}/нет.mpu: нет файла ${home}/нет.mpu`;
    assertEquals(result.isError, true);
    assertEquals(result.structuredContent, {
      stdout: "",
      stderr: `${text}\n`,
      exit: 2,
      refusal: { reason: "нет файла", hint: null, candidates: [], text },
    });
  }));

Deno.test("MCP run: — ask в тексте без elicitation: спросить некого", () =>
  withHome(async (home) => {
    const result = await viaMcp(home, ["run:", `${home}/w/y.mpu`]);
    assertEquals(result.isError, true);
    const content = result.structuredContent as Record<string, unknown>;
    assertEquals([content.stderr, content.exit], [
      "mpu kiten comment id: 11 text: a: нужно подтверждение, а спросить " +
      "некого\n",
      1,
    ]);
  }));

Deno.test("MCP run: — файл каталога настроек не открывается", () =>
  withHome(async (home) => {
    const path = `${home}/.config/mpu/mcp-token`;
    const result = await viaMcp(home, ["run:", path]);
    assertEquals(result.isError, true);
    const content = result.structuredContent as Record<string, unknown>;
    assertEquals(
      content.stderr,
      `mpu run: ${path}: программа — файл .mpu\n`,
    );
    assertEquals(JSON.stringify(result).includes(SECRET), false);
  }));
