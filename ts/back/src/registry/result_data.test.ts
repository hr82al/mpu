/**
 * Вид данных результата у команд реестра (`platform/result-record.md`):
 * отбор видит то, что печатает `end json`, — коллекцию под-поля или
 * запись, а не конверт. Результат — образец, прошедший схему команды.
 */

import { describe, expect, it } from "vitest";
import type { Command } from "../command/mod.ts";
import {
  AsideCall,
  type Outcome,
  runChain,
  SELECTABLE,
} from "@mpu/language/objects";
import { said } from "@mpu/language/testing";
import { findCommand } from "./mod.ts";

/** Аргументы вызова там, где пустые не проходят разбор команды. */
const ARGV: Readonly<Record<string, readonly string[]>> = {
  "api wb-loader-resume": ["777"],
};

/** Отбор `words` над данными результата `result` команды `path`. */
function selected(
  path: readonly string[],
  result: unknown,
  words: readonly string[],
): Promise<Outcome> {
  const command: Command | undefined = findCommand(path);
  if (command === undefined) throw new Error(`нет команды ${path.join(" ")}`);
  const origin = new AsideCall(
    "mpu",
    { purpose: "данные", help: "Данные." },
    SELECTABLE.kind,
    () => command.dataOf(result, ARGV[path.join(" ")] ?? []),
  );
  return runChain(words, origin);
}

const TIMER = {
  id: 5,
  started_at: "2026-09-23T10:00:00Z",
  elapsed_minutes: 7,
  comment: "",
};

const FILE = {
  status: "M",
  old_path: "a.ts",
  new_path: "a.ts",
  additions: 1,
  deletions: 0,
};

const DIFF = {
  old_path: "a.ts",
  new_path: "b.ts",
  diff: "",
  new_file: false,
  renamed_file: true,
  deleted_file: false,
};

const GLAB_ROW = {
  repo: "mpu",
  iid: 7,
  title: "первый",
  state: "opened",
  web_url: "https://g/7",
  landed: [],
  project: null,
  source_branch: "f",
  target_branch: "main",
  other_branches: null,
};

const STATUS_ROW = {
  id: 11,
  title: "один",
  url: "https://k/11",
  stage: "работа",
  column: null,
  board: null,
  space: null,
  lane: null,
  state: null,
  closed: false,
  escalated: false,
  due_date: null,
  updated: null,
  my_minutes: 30,
  sources: [],
};

const ENTRY = {
  key: "KITEN_BASE_URL",
  value: null,
  source: "default",
  default: null,
  description: "адрес",
};

/** Команда, образец её результата, отбор и что он печатает. */
const CASES: readonly (readonly [string, unknown, string, string])[] = [
  ["config", { entries: [ENTRY, ENTRY], action: "list" }, "size", "2\n"],
  [
    "glab-status",
    { rows: [GLAB_ROW], selectors: false, columns: null },
    "first title",
    "первый\n",
  ],
  [
    "kiten status",
    {
      rows: [STATUS_ROW],
      out: "table",
      format: null,
      minutesByRole: {},
      now: 0,
    },
    "first my_minutes",
    "30\n",
  ],
  [
    "mr comments",
    {
      headline: "MR",
      threads: [
        {
          id: "t1",
          resolvable: true,
          resolved: false,
          location: null,
          notes: [],
        },
      ],
    },
    "first id",
    "t1\n",
  ],
  ["mr diff", { files: [DIFF, DIFF] }, "size", "2\n"],
  ["mr files", { files: [FILE] }, "first new_path", "a.ts\n"],
  [
    "sheet ls",
    { tabs: [{ title: "Лист", sheet_id: 0, rows: 1, cols: 1, index: 0 }] },
    "first title",
    "Лист\n",
  ],
  [
    "api wb-loader-resume",
    { printed: false, calls: [], entries: [{ sid: "s1", response: null }] },
    "first sid",
    "s1\n",
  ],
  [
    "kiten time status",
    { cardId: 11, timer: TIMER, totalMinutes: 90 },
    "total_minutes",
    "90\n",
  ],
  [
    "kiten time status",
    { cardId: 11, timer: TIMER, totalMinutes: 90 },
    "timer elapsed_minutes",
    "7\n",
  ],
];

describe("отбор видит то, что печатает end json", () => {
  for (const [path, result, words, value] of CASES) {
    it(`${path}: ${words}`, async () => {
      expect(
        await selected(path.split(" "), result, words.split(" ")),
      ).toStrictEqual({ path: [], value });
    });
  }
});

/** Коллекционная команда и поле результата, где её записи. */
const COLLECTIONS: readonly (readonly [string, string])[] = [
  ["config", "entries"],
  ["glab-status", "rows"],
  ["kiten status", "rows"],
  ["mr comments", "threads"],
  ["mr diff", "files"],
  ["mr files", "files"],
  ["sheet ls", "tabs"],
  ["api wb-loader-resume", "entries"],
];

/** Образец результата команды `path` из таблицы случаев. */
function sampleOf(path: string): Record<string, unknown> {
  const found = CASES.find(([one]) => one === path);
  if (found === undefined) throw new Error(`нет образца ${path}`);
  // Образцы таблицы — объекты JSON: `unknown` в ней — ради разных схем.
  return found[1] as Record<string, unknown>;
}

describe("отобранная коллекция печатается видом команды", () => {
  for (const [path, key] of COLLECTIONS) {
    it(path, async () => {
      const sample = sampleOf(path);
      // Поле записей образца — массив: так объявлено в `COLLECTIONS`.
      const [one] = sample[key] as readonly unknown[];
      const command = findCommand(path.split(" "));
      if (command === undefined) throw new Error(`нет команды ${path}`);
      const argv = ARGV[path] ?? [];
      expect(
        await selected(path.split(" "), { ...sample, [key]: [one, one] }, [
          "first:",
          "1",
        ]),
      ).toStrictEqual({
        path: [],
        value: command.renderResult({ ...sample, [key]: [one] }, argv),
      });
    });
  }
});

it("запись kiten time status: коллекционных сообщений нет", async () => {
  const outcome = await selected(
    ["kiten", "time", "status"],
    { cardId: 11, timer: null, totalMinutes: 0 },
    ["size"],
  );
  expect(said(outcome)).toStrictEqual({
    error:
      "mpu: запись не понимает size; ближайшие: card_id, timer, total_minutes",
    code: 2,
  });
});
