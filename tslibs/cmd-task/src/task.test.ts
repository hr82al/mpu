/**
 * Случаи канала `mpu task` (`task.md`) без стенда строки: голден
 * инструкции `setup`, возраст в выводе и соединение `wait` между
 * опросами. Сценарии T1–T24 строкой целиком — в `ts/`
 * (`back/src/line/task/task.test.ts`): им нужен стенд приложения.
 */

import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { CacheDb } from "@mpu/command";
import { fakeConfigDb, makeFakeIo } from "@mpu/command/testing";
import { age, waitCommand, type Waiting } from "./cmd_read.ts";
import { SETUP_TEXT } from "./texts.ts";

it("T2: голден setup.txt — текст инструкции побайтово", async () => {
  const golden = await readFile(
    new URL("./testdata/setup.txt", import.meta.url),
    "utf8",
  );
  expect(SETUP_TEXT).toStrictEqual(golden);
});

it("возраст — крупнейшей целой единицей", () => {
  for (const [seconds, text] of [
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86399, "23h"],
    [86400, "1d"],
  ] as const) {
    expect(age(seconds), String(seconds)).toStrictEqual(text);
  }
});

it("wait не держит соединение с базой между опросами", async () => {
  const db = fakeConfigDb();
  let open = 0;
  const openedDuringSleep: number[] = [];
  const io = makeFakeIo({
    openCacheDb: () => {
      open++;
      const handle: CacheDb = db();
      return { ...handle, [Symbol.dispose]: () => void open-- };
    },
  });
  let now = 0;
  const waiting: Waiting = {
    now: () => now,
    sleep: (ms) => {
      openedDuringSleep.push(open);
      now += ms;
      return Promise.resolve();
    },
  };
  const setup = db();
  setup.bootstrap();
  setup.execute(
    "CREATE TABLE IF NOT EXISTS task_projects (name TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  setup.execute("INSERT INTO task_projects VALUES ('demo', '', 0)");
  const command = waitCommand(waiting);
  let refused = "";
  try {
    await command.invoke(
      ["--project", "demo", "--kind", "report", "--timeout", "5"],
      io,
    );
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  expect(refused).toBe("report в demo не пришёл за 5 с");
  expect(openedDuringSleep).toStrictEqual([0, 0, 0]);
  expect(open).toBe(0);
});
