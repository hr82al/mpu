/**
 * Результат `logs` — коллекция строк (`platform/long-output.md`, §3):
 * отбор идёт по записям `time`/`host`/`service`/`stream`/`text`, печать
 * отобранного — вид команды, `it` отбирает из запомненного без нового
 * запроса. Loki — поддельный сервер на петле, кэш-БД — во временном
 * каталоге.
 */

import { assertEquals } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { LastResults, lineEntry, type Memory } from "../line/mod.ts";
import {
  allowEverything,
  consentOf,
  withPolicyFile,
} from "../line/testconsent.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lokiBody, withFakeLoki } from "./testloki.ts";

const END = GRAMMAR.close;

/** Ответ Loki: три строки двух потоков, одна — с `ERROR`. */
const LOKI_BODY = lokiBody([
  {
    labels: { host: "sl-1", compose_service: "wb-loader", stream: "stdout" },
    values: [
      ["1754380800001000000", "старт\n"],
      ["1754380800003000000", "готово"],
    ],
  },
  {
    labels: { host: "sl-1", compose_service: "wb-loader", stream: "stderr" },
    values: [["1754380800002000000", "ERROR: нет связи\n"]],
  },
]);

/** Подменённый Loki, кэш-БД и память вызывающего. */
interface Stand {
  readonly io: Partial<CommandIo>;
  readonly memory: Memory;
  /** Сколько раз спросили Loki. */
  readonly asked: () => number;
}

function withStand(fn: (stand: Stand) => Promise<void>) {
  return withFakeLoki(
    LOKI_BODY,
    (io, asked) =>
      fn({ io, memory: new LastResults(() => 0).of("ppid:1"), asked }),
    ["sl-1", "sl-2"],
  );
}

async function run(file: string, argv: readonly string[], stand: Stand) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await lineEntry(consentOf(file, [], stand.memory))(
    argv,
    makeFakeIo(stand.io),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    { nativeCall: () => {}, note: () => {} } as unknown as InvokeJournal,
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}

const LOGS = ["logs", "target:", "sl-1"];

Deno.test("logs — коллекция строк: отбор, печать отобранного, it", async (t) => {
  await withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);

      await t.step("без сообщений — печать прежняя", async () => {
        assertEquals(await run(file, LOGS, stand), {
          code: 0,
          stdout: "старт\nERROR: нет связи\nготово\n",
          stderr: "",
        });
      });

      await t.step("end size — число строк", async () => {
        const got = await run(file, [...LOGS, END, "size"], stand);
        assertEquals([got.code, got.stdout], [0, "3\n"], got.stderr);
      });

      await t.step("where: text includes: — печать как у logs", async () => {
        const got = await run(
          file,
          [...LOGS, END, "where:", "text", "includes:", "error"],
          stand,
        );
        assertEquals(
          [got.code, got.stdout],
          [0, "ERROR: нет связи\n"],
          got.stderr,
        );
      });

      await t.step("timestamps — префикс и у отобранного", async () => {
        const got = await run(
          file,
          [
            "logs",
            "timestamps",
            "target:",
            "sl-1",
            END,
            "where:",
            "stream",
            "is:",
            "stderr",
          ],
          stand,
        );
        assertEquals(
          [got.code, got.stdout],
          [0, "2025-08-05T08:00:00.002Z ERROR: нет связи\n"],
          got.stderr,
        );
      });

      await t.step("запись: time, host, service, stream, text", async () => {
        const got = await run(
          file,
          [...LOGS, END, "first", END, "json"],
          stand,
        );
        assertEquals(JSON.parse(got.stdout), {
          time: "2025-08-05T08:00:00.001Z",
          host: "sl-1",
          service: "wb-loader",
          stream: "stdout",
          text: "старт",
        });
      });

      await t.step("it end last: 2 — без запроса к Loki", async () => {
        await run(file, LOGS, stand);
        const before = stand.asked();
        const got = await run(file, ["it", END, "last:", "2"], stand);
        assertEquals(
          [got.code, got.stdout],
          [0, "ERROR: нет связи\nготово\n"],
          got.stderr,
        );
        assertEquals(stand.asked(), before);
      });

      await t.step("logs hosts — коллекция имён", async () => {
        const got = await run(file, ["logs", "hosts", END, "size"], stand);
        assertEquals([got.code, got.stdout], [0, "2\n"], got.stderr);
      });
    })
  );
});
