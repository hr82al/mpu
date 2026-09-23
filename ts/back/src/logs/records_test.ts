/**
 * Строки лога — записи коллекции и обратно (`platform/long-output.md`,
 * §3): записи Loki и снимка Portainer, печать отобранного байт в байт.
 */

import { assertEquals } from "@std/assert";
import type { LogEntry } from "../loki/mod.ts";
import {
  entryRecords,
  recordEntries,
  recordSnapshot,
  snapshotRecords,
} from "./records.ts";
import { formatEntries } from "./render.ts";

Deno.test("записи Loki: поля из меток, текст без одного перевода строки", () => {
  const entries: LogEntry[] = [
    {
      tsNs: "1754380800123456789",
      line: "два\n\n",
      labels: { host: "sl-1", compose_service: "api", stream: "stderr" },
    },
    { tsNs: "1754380800200000000", line: "без меток", labels: {} },
  ];
  const records = entryRecords(entries);
  assertEquals(records, [
    {
      time: "2025-08-05T08:00:00.123Z",
      host: "sl-1",
      service: "api",
      stream: "stderr",
      text: "два\n",
    },
    {
      time: "2025-08-05T08:00:00.200Z",
      host: "",
      service: "",
      stream: "",
      text: "без меток",
    },
  ]);
  // Печать через записи — та же, что без них, с префиксом и без.
  for (const timestamps of [false, true]) {
    assertEquals(
      formatEntries(recordEntries(records), timestamps),
      formatEntries(entries, timestamps),
    );
  }
});

Deno.test("снимок: строки обоих потоков, метка Docker — время и часть текста", () => {
  const snapshot = {
    container: "mp-api",
    stdout: "2026-09-23T10:00:00.123456789Z старт\n" +
      "2026-09-23T10:00:01.5Z готово\n",
    stderr: "2026-09-23T10:00:00.9Z ERROR\n",
    timestamps: true,
  };
  const records = snapshotRecords(snapshot);
  assertEquals(records.map((one) => [one.time, one.stream, one.text]), [
    [
      "2026-09-23T10:00:00.123Z",
      "stdout",
      "2026-09-23T10:00:00.123456789Z старт",
    ],
    ["2026-09-23T10:00:01.500Z", "stdout", "2026-09-23T10:00:01.5Z готово"],
    ["2026-09-23T10:00:00.900Z", "stderr", "2026-09-23T10:00:00.9Z ERROR"],
  ]);
  assertEquals(
    records.every((one) => one.host === "" && one.service === ""),
    true,
  );
  assertEquals(recordSnapshot(snapshot, records), snapshot);
  assertEquals(recordSnapshot(snapshot, records.slice(1)), {
    ...snapshot,
    stdout: "2026-09-23T10:00:01.5Z готово\n",
  });
});

Deno.test("снимок без меток времени — time пусто, пустые части — нет записей", () => {
  const snapshot = {
    container: "mp-api",
    stdout: "2026-09-23T10:00:00Z похоже на метку\n",
    stderr: "",
    timestamps: false,
  };
  assertEquals(snapshotRecords(snapshot), [{
    time: "",
    host: "",
    service: "",
    stream: "stdout",
    text: "2026-09-23T10:00:00Z похоже на метку",
  }]);
  assertEquals(snapshotRecords({ ...snapshot, stdout: "" }), []);
});
