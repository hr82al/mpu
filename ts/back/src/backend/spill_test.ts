/**
 * Большой вывод двери агента — файлом (`platform/long-output.md`, §4):
 * собранный ответ `/agent/line` сверх порога несёт `file` вместо
 * `stdout`, файл побайтово равен выводу строки; дверь человека, поток
 * NDJSON и ответ до порога — как прежде. Loki — поддельный на петле.
 */

import { assertEquals } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import { lokiBody, withFakeLoki } from "../logs/testloki.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
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

const LOKI_BODY = lokiBody([{
  labels: { host: "sl-1", stream: "stdout" },
  values: LINES.map((line, i) => [String(1754380800000000000 + i), line]),
}]);

const STDOUT = LINES.map((line) => `${line}\n`).join("");

/** Loki на петле и кэш-БД: io строки, которой хватает `logs`. */
function withLoki(
  body: (io: Partial<CommandIo>, asked: () => number) => Promise<void>,
) {
  return withFakeLoki(LOKI_BODY, body);
}

const LOGS = ["logs", "target:", "sl-1", "limit:", "1000"];

function first(words: readonly string[], caller?: string) {
  return { words, cwd: Deno.cwd(), human: false, caller };
}

const JSON_ACCEPT = { accept: "application/json" } as const;

Deno.test("дверь агента: сверх порога — file вместо stdout, файл = вывод", () =>
  withLoki((io) =>
    withBack(async (back) => {
      const whole = await collected(
        back,
        await post(back, "/agent/line", first(LOGS, "mcp:a"), {
          ...JSON_ACCEPT,
          agent: true,
        }),
      );
      const path = `${back.spillDir}/run-1.txt`;
      const bytes = new TextEncoder().encode(STDOUT).byteLength;
      assertEquals(whole, {
        file: { path, bytes, lines: 400, slice: true },
        stderr: "",
        exit: 0,
      });
      assertEquals(await Deno.readTextFile(path), STDOUT);
      // Журнал не зависит от двери: вывод в нём как прежде, пути нет.
      assertEquals(back.logged.includes(STDOUT), true);
      assertEquals(back.logged.some((one) => one.includes(path)), false);
    }, { io, spillThreshold: 1024 })
  ));

Deno.test("дверь агента до порога — ответ побайтово прежний", () =>
  withLoki((io) =>
    withBack(async (back) => {
      const response = await post(back, "/agent/line", first(LOGS, "mcp:a"), {
        ...JSON_ACCEPT,
        agent: true,
      });
      assertEquals(
        await response.text(),
        JSON.stringify({ stdout: STDOUT, stderr: "", exit: 0 }),
      );
    }, { io })
  ));

Deno.test("дверь человека и поток NDJSON — вывод целиком при любом размере", () =>
  withLoki((io) =>
    withBack(async (back) => {
      const human = await collected(
        back,
        await post(back, "/line", first(LOGS), JSON_ACCEPT),
      );
      assertEquals(human.stdout, STDOUT);
      const frames = await ndjson(
        back,
        await post(back, "/agent/line", first(LOGS), { agent: true }),
      );
      assertEquals(outOf(frames), STDOUT);
      assertEquals(frames.at(-1), { exit: 0 });
    }, { io, spillThreshold: 1024 })
  ));

Deno.test("не коллекция и строка без вызывающего — без среза", async (t) => {
  await t.step("version", () =>
    withBack(async (back) => {
      const whole = await collected(
        back,
        await post(back, "/agent/line", first(["version"], "mcp:a"), {
          ...JSON_ACCEPT,
          agent: true,
        }),
      );
      assertEquals((whole.file as { slice: boolean }).slice, false);
    }, { spillThreshold: 1 }));
  await t.step(
    "logs без caller",
    () =>
      withLoki((io) =>
        withBack(async (back) => {
          const whole = await collected(
            back,
            await post(back, "/agent/line", first(LOGS), {
              ...JSON_ACCEPT,
              agent: true,
            }),
          );
          assertEquals((whole.file as { slice: boolean }).slice, false);
        }, { io, spillThreshold: 1024 })
      ),
  );
});

Deno.test("итог после вопроса: file в ответе /agent/line/answer", () =>
  withLoki((io) =>
    withBack(async (back) => {
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
      assertEquals(typeof asked.ticket, "string", JSON.stringify(asked));
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
      assertEquals(answered.stdout, undefined);
      assertEquals((answered.file as { path: string }).path, path);
      assertEquals(answered.exit, 0);
      assertEquals(await Deno.readTextFile(path), STDOUT);
    }, { io, spillThreshold: 1024 })
  ));

Deno.test("it: срез отданного файлом — без нового запроса к Loki", () =>
  withLoki((io, asked) =>
    withBack(async (back) => {
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
      assertEquals(tail.stdout, "строка лога 398\nстрока лога 399\n");
      assertEquals(asked(), before);
    }, { io, spillThreshold: 1024 })
  ));

function askOn(back: TestBack, path: string) {
  using book = RuleBook.open(back.policyFile, []);
  book.set(RulePath.parse(path), ASK);
}

function outOf(frames: readonly Frame[]): string {
  return frames.filter((frame) => "out" in frame).map((frame) => frame.out)
    .join("");
}
