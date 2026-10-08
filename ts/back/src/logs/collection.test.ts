/**
 * Результат `logs` — коллекция строк (`platform/long-output.md`, §3):
 * отбор идёт по записям `time`/`host`/`service`/`stream`/`text`, печать
 * отобранного — вид команды, `it` отбирает из запомненного без нового
 * запроса. Loki — поддельный сервер на петле, кэш-БД — во временном
 * каталоге.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { LastResults, lineEntry, type Memory } from "../line/mod.ts";
import {
  allowEverything,
  consentOf,
  withPolicyFile,
} from "../line/testconsent.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { heldScope } from "../vitest/scope.ts";
import { makeFakeIo } from "@mpu/command/testing";
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

describe("logs — коллекция строк: отбор, печать отобранного, it", () => {
  const held = heldScope<{ readonly file: string; readonly stand: Stand }>(
    (body) =>
      withPolicyFile((file) => withStand((stand) => body({ file, stand }))),
  );
  let file = "";
  let stand: Stand;
  beforeAll(() => {
    ({ file, stand } = held());
    allowEverything(file);
  });

  it("без сообщений — печать прежняя", async () => {
    expect(await run(file, LOGS, stand)).toStrictEqual({
      code: 0,
      stdout: "старт\nERROR: нет связи\nготово\n",
      stderr: "",
    });
  });

  it("end size — число строк", async () => {
    const got = await run(file, [...LOGS, END, "size"], stand);
    expect([got.code, got.stdout], got.stderr).toStrictEqual([0, "3\n"]);
  });

  it("where: text includes: — печать как у logs", async () => {
    const got = await run(
      file,
      [...LOGS, END, "where:", "text", "includes:", "error"],
      stand,
    );
    expect([got.code, got.stdout], got.stderr).toStrictEqual([
      0,
      "ERROR: нет связи\n",
    ]);
  });

  it("timestamps — префикс и у отобранного", async () => {
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
    expect([got.code, got.stdout], got.stderr).toStrictEqual([
      0,
      "2025-08-05T08:00:00.002Z ERROR: нет связи\n",
    ]);
  });

  it("запись: time, host, service, stream, text", async () => {
    const got = await run(file, [...LOGS, END, "first", END, "json"], stand);
    expect(JSON.parse(got.stdout)).toStrictEqual({
      time: "2025-08-05T08:00:00.001Z",
      host: "sl-1",
      service: "wb-loader",
      stream: "stdout",
      text: "старт",
    });
  });

  it("it end last: 2 — без запроса к Loki", async () => {
    await run(file, LOGS, stand);
    const before = stand.asked();
    const got = await run(file, ["it", END, "last:", "2"], stand);
    expect([got.code, got.stdout], got.stderr).toStrictEqual([
      0,
      "ERROR: нет связи\nготово\n",
    ]);
    expect(stand.asked()).toStrictEqual(before);
  });

  it("logs hosts — коллекция имён", async () => {
    const got = await run(file, ["logs", "hosts", END, "size"], stand);
    expect([got.code, got.stdout], got.stderr).toStrictEqual([0, "2\n"]);
  });
});
