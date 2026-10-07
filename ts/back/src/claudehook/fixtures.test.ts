/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { readdir, readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

/** Область канала и её копия: подкаталог `testdata/` назван так же. */
const CHANNEL = "claude-hook-notification";

const NAMES: readonly string[] = [
  "err-bad-json-stderr.txt",
  "notify-stdout.txt",
  "live-payload-idle-prompt.json",
];

const channelRoot = new URL("../../../docs/specs/fixtures/", import.meta.url);
const copyRoot = new URL("testdata/", import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(`${CHANNEL}/${name}`, async () => {
      expect(await readFile(new URL(`${CHANNEL}/${name}`, copyRoot), "utf8"))
        .toStrictEqual(
          await readFile(new URL(`${CHANNEL}/${name}`, channelRoot), "utf8"),
        );
    });
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  const found = await readdir(new URL(`${CHANNEL}/`, copyRoot));
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});

/** Копии эталонов хука `PermissionRequest` (`fixtures/telegram-relay/`). */
const RELAY = "telegram-relay";

const RELAY_COPIES: readonly (readonly [string, string])[] = [
  [
    "hook/live-permission-ask-user-question-multi.json",
    "permission-request/live-permission-ask-user-question-multi.json",
  ],
  [
    "hook/live-permission-ask-user-question-single.json",
    "permission-request/live-permission-ask-user-question-single.json",
  ],
  [
    "hook/live-permission-bash-dev-suggestion.json",
    "permission-request/live-permission-bash-dev-suggestion.json",
  ],
  [
    "hook/live-permission-bash.json",
    "permission-request/live-permission-bash.json",
  ],
  [
    "hook/transcript-titles-and-ask-answered.jsonl",
    "permission-request/transcript-titles-and-ask-answered.jsonl",
  ],
  ["settings-fragment.json", "permission-request/settings-fragment.json"],
];

describe("копии эталонов хука PermissionRequest совпадают с каналом", () => {
  for (const [channel, copy] of RELAY_COPIES) {
    it(copy, async () => {
      expect(await readFile(new URL(copy, copyRoot), "utf8")).toStrictEqual(
        await readFile(new URL(`${RELAY}/${channel}`, channelRoot), "utf8"),
      );
    });
  }
  // Полнота копий — проверка самого теста, а не шага: после случаев.
  afterAll(async () => {
    const found = (await readdir(new URL("permission-request/", copyRoot))).map(
      (name) => `permission-request/${name}`,
    );
    expect(found.sort()).toStrictEqual(
      RELAY_COPIES.map(([, copy]) => copy).sort(),
    );
  });
});

/** Копии эталонов хука `Stop` (`fixtures/telegram-relay/r2/`). */
const STOP_COPIES: readonly (readonly [string, string])[] = [
  ["r2/live-stop.json", "stop/live-stop.json"],
  ["r2/settings-fragment-stop.json", "stop/settings-fragment-stop.json"],
  ["r2/transcript-around-stop.jsonl", "stop/transcript-around-stop.jsonl"],
];

describe("копии эталонов хука Stop совпадают с каналом", () => {
  for (const [channel, copy] of STOP_COPIES) {
    it(copy, async () => {
      expect(await readFile(new URL(copy, copyRoot), "utf8")).toStrictEqual(
        await readFile(new URL(`${RELAY}/${channel}`, channelRoot), "utf8"),
      );
    });
  }
  // Полнота копий — проверка самого теста, а не шага: после случаев.
  afterAll(async () => {
    const found = (await readdir(new URL("stop/", copyRoot))).map((name) =>
      `stop/${name}`
    );
    expect(found.sort()).toStrictEqual(
      STOP_COPIES.map(([, copy]) => copy).sort(),
    );
  });
});

/** Копии эталонов хука `Elicitation` (`fixtures/telegram-relay/r3/`). */
const ELICITATION_COPIES: readonly (readonly [string, string])[] = [
  [
    "r3/live-elicitation-accept-delivered.json",
    "elicitation/live-elicitation-accept-delivered.json",
  ],
  [
    "r3/live-elicitation-fields.json",
    "elicitation/live-elicitation-fields.json",
  ],
  ["r3/live-elicitation-mpu.json", "elicitation/live-elicitation-mpu.json"],
  [
    "r3/settings-fragment-elicitation.json",
    "elicitation/settings-fragment-elicitation.json",
  ],
];

describe("копии эталонов хука Elicitation совпадают с каналом", () => {
  for (const [channel, copy] of ELICITATION_COPIES) {
    it(copy, async () => {
      expect(await readFile(new URL(copy, copyRoot), "utf8")).toStrictEqual(
        await readFile(new URL(`${RELAY}/${channel}`, channelRoot), "utf8"),
      );
    });
  }
  // Полнота копий — проверка самого теста, а не шага: после случаев.
  afterAll(async () => {
    const found = (await readdir(new URL("elicitation/", copyRoot))).map((
      name,
    ) => `elicitation/${name}`);
    expect(found.sort()).toStrictEqual(
      ELICITATION_COPIES.map(([, copy]) => copy).sort(),
    );
  });
});
