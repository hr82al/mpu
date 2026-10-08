/**
 * Большой вывод двери агента — файлом (`platform/long-output.md`, §4):
 * собранный ответ `/agent/line` сверх порога несёт `file` вместо
 * `stdout`, файл побайтово равен выводу строки; дверь человека, поток
 * NDJSON и ответ до порога — как прежде. Loki — поддельный на петле.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import { lokiBody, withFakeLoki } from "@mpu/cmd-logs/testing";
import { ASK, RuleBook, RulePath } from "@mpu/command/policy";
import {
  collected,
  type Frame,
  ndjson,
  post,
  type TestBack,
  withBack,
} from "./testback.ts";

/** 400 строк лога: вывод около 12 КиБ. */
const LINES = Array.from({ length: 400 }, (_, i) => `строка лога ${i}`);

const LOKI_BODY = lokiBody([
  {
    labels: { host: "sl-1", stream: "stdout" },
    values: LINES.map((line, i) => [String(1754380800000000000 + i), line]),
  },
]);

const STDOUT = LINES.map((line) => `${line}\n`).join("");

/** Loki на петле и кэш-БД: io строки, которой хватает `logs`. */
function withLoki(
  body: (io: Partial<CommandIo>, asked: () => number) => Promise<void>,
) {
  return withFakeLoki(LOKI_BODY, body);
}

const LOGS = ["logs", "target:", "sl-1", "limit:", "1000"];

function first(words: readonly string[], caller?: string) {
  return { words, cwd: process.cwd(), human: false, caller };
}

const JSON_ACCEPT = { accept: "application/json" } as const;

it("дверь агента: сверх порога — file вместо stdout, файл = вывод", () =>
  withLoki((io) =>
    withBack(
      async (back) => {
        const whole = await collected(
          back,
          await post(back, "/agent/line", first(LOGS, "mcp:a"), {
            ...JSON_ACCEPT,
            agent: true,
          }),
        );
        const path = `${back.spillDir}/run-1.txt`;
        const bytes = new TextEncoder().encode(STDOUT).byteLength;
        expect(whole).toStrictEqual({
          file: { path, bytes, lines: 400, slice: true },
          stderr: "",
          exit: 0,
        });
        expect(await readFile(path, "utf8")).toStrictEqual(STDOUT);
        // Журнал не зависит от двери: вывод в нём как прежде, пути нет.
        expect(back.logged.includes(STDOUT)).toBe(true);
        expect(back.logged.some((one) => one.includes(path))).toBe(false);
      },
      { io, spillThreshold: 1024 },
    ),
  ));

it("дверь агента до порога — ответ побайтово прежний", () =>
  withLoki((io) =>
    withBack(
      async (back) => {
        const response = await post(back, "/agent/line", first(LOGS, "mcp:a"), {
          ...JSON_ACCEPT,
          agent: true,
        });
        expect(await response.text()).toStrictEqual(
          JSON.stringify({ stdout: STDOUT, stderr: "", exit: 0 }),
        );
      },
      { io },
    ),
  ));

it("дверь человека и поток NDJSON — вывод целиком при любом размере", () =>
  withLoki((io) =>
    withBack(
      async (back) => {
        const human = await collected(
          back,
          await post(back, "/line", first(LOGS), JSON_ACCEPT),
        );
        expect(human.stdout).toStrictEqual(STDOUT);
        const frames = await ndjson(
          back,
          await post(back, "/agent/line", first(LOGS), { agent: true }),
        );
        expect(outOf(frames)).toStrictEqual(STDOUT);
        expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      },
      { io, spillThreshold: 1024 },
    ),
  ));

describe("не коллекция и строка без вызывающего — без среза", () => {
  it("version", () =>
    withBack(
      async (back) => {
        const whole = await collected(
          back,
          await post(back, "/agent/line", first(["version"], "mcp:a"), {
            ...JSON_ACCEPT,
            agent: true,
          }),
        );
        expect((whole.file as { slice: boolean }).slice).toBe(false);
      },
      { spillThreshold: 1 },
    ));
  it("logs без caller", () =>
    withLoki((io) =>
      withBack(
        async (back) => {
          const whole = await collected(
            back,
            await post(back, "/agent/line", first(LOGS), {
              ...JSON_ACCEPT,
              agent: true,
            }),
          );
          expect((whole.file as { slice: boolean }).slice).toBe(false);
        },
        { io, spillThreshold: 1024 },
      ),
    ));
});

it("итог после вопроса: file в ответе /agent/line/answer", () =>
  withLoki((io) =>
    withBack(
      async (back) => {
        askOn(back, "logs");
        const asked = await collected(
          back,
          // Основной токен: канал агента верит «человек есть».
          await post(
            back,
            "/agent/line",
            { ...first(["ask", ...LOGS], "mcp:a"), human: true },
            JSON_ACCEPT,
          ),
        );
        expect(typeof asked.ticket, JSON.stringify(asked)).toBe("string");
        const answered = await collected(
          back,
          await post(
            back,
            "/agent/line/answer",
            { ticket: asked.ticket, answer: "y" },
            JSON_ACCEPT,
          ),
        );
        const path = `${back.spillDir}/run-1.txt`;
        expect(answered.stdout).toStrictEqual(undefined);
        expect((answered.file as { path: string }).path).toStrictEqual(path);
        expect(answered.exit).toBe(0);
        expect(await readFile(path, "utf8")).toStrictEqual(STDOUT);
      },
      { io, spillThreshold: 1024 },
    ),
  ));

it("it: срез отданного файлом — без нового запроса к Loki", () =>
  withLoki((io, asked) =>
    withBack(
      async (back) => {
        const options = { ...JSON_ACCEPT, agent: true };
        await collected(
          back,
          await post(back, "/agent/line", first(LOGS, "mcp:a"), options),
        );
        const before = asked();
        const tail = await collected(
          back,
          await post(
            back,
            "/agent/line",
            first(["it", "end", "last:", "2"], "mcp:a"),
            options,
          ),
        );
        expect(tail.stdout).toBe("строка лога 398\nстрока лога 399\n");
        expect(asked()).toStrictEqual(before);
      },
      { io, spillThreshold: 1024 },
    ),
  ));

function askOn(back: TestBack, path: string) {
  using book = RuleBook.open(back.policyFile, []);
  book.set(RulePath.parse(path), ASK);
}

function outOf(frames: readonly Frame[]): string {
  return frames
    .filter((frame) => "out" in frame)
    .map((frame) => frame.out)
    .join("");
}
