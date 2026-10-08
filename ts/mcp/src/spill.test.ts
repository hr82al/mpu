/**
 * Большой вывод в ответе тула — файлом (`platform/long-output.md`, §4):
 * текст с путём (и строкой среза у коллекции), `structuredContent.file`
 * без `stdout`; до порога — как прежде.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { lokiBody, withFakeLoki } from "@mpu/cmd-logs/testing";
import { call, withClient, withStack } from "./testkit.ts";

const LINES = Array.from({ length: 300 }, (_, i) => `строка ${i}`);
const STDOUT = LINES.map((line) => `${line}\n`).join("");
const LOKI_BODY = lokiBody([
  {
    labels: { host: "sl-1", stream: "stdout" },
    values: LINES.map((line, i) => [String(1754380800000000000 + i), line]),
  },
]);

const LOGS = ["logs", "target:", "sl-1", "limit:", "1000"];

it("коллекция сверх порога — путь и строка среза, file без stdout", () =>
  withFakeLoki(LOKI_BODY, (io) =>
    withStack(
      (stack) =>
        withClient(stack, async (client) => {
          const result = await call(stack, client, "mpu", { words: LOGS });
          const path = `${stack.back.spillDir}/run-1.txt`;
          const bytes = new TextEncoder().encode(STDOUT).byteLength;
          const kib = Math.ceil(bytes / 1024);
          expect(result.content).toStrictEqual([
            {
              type: "text",
              text:
                `вывод 300 строк, ${kib} КиБ — файл ${path}; срез без ` +
                "повторного запроса: it end last: 100 · it end size",
            },
          ]);
          expect(result.structuredContent).toStrictEqual({
            file: { path, bytes, lines: 300 },
            stderr: "",
            exit: 0,
          });
          expect(result.isError).toBe(false);
          expect(await readFile(path, "utf8")).toStrictEqual(STDOUT);
        }),
      { io, spillThreshold: 1024 },
    ),
  ));

it("не коллекция сверх порога — только путь", () =>
  withStack(
    (stack) =>
      withClient(stack, async (client) => {
        const result = await call(stack, client, "mpu", { words: ["version"] });
        const path = `${stack.back.spillDir}/run-1.txt`;
        expect(result.content).toStrictEqual([
          {
            type: "text",
            text: `вывод 1 строк, 1 КиБ — файл ${path}`,
          },
        ]);
        expect(result.structuredContent).toStrictEqual({
          file: { path, bytes: 6, lines: 1 },
          stderr: "",
          exit: 0,
        });
      }),
    { spillThreshold: 1 },
  ));

it("до порога — ответ прежний: stdout целиком", () =>
  withFakeLoki(LOKI_BODY, (io) =>
    withStack(
      (stack) =>
        withClient(stack, async (client) => {
          const result = await call(stack, client, "mpu", { words: LOGS });
          expect(result.content).toStrictEqual([
            {
              type: "text",
              text: STDOUT,
            },
          ]);
          expect(result.structuredContent).toStrictEqual({
            stdout: STDOUT,
            stderr: "",
            exit: 0,
          });
        }),
      { io },
    ),
  ));
