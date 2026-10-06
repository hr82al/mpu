/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { assertEquals } from "@std/assert";

/** Область канала и её копия: подкаталог `testdata/` назван так же. */
const CHANNEL = "claude-hook-notification";

const NAMES: readonly string[] = [
  "err-bad-json-stderr.txt",
  "notify-stdout.txt",
  "live-payload-idle-prompt.json",
];

const channelRoot = new URL("../../../docs/specs/fixtures/", import.meta.url);
const copyRoot = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of NAMES) {
    await t.step(`${CHANNEL}/${name}`, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(`${CHANNEL}/${name}`, copyRoot)),
        await Deno.readTextFile(new URL(`${CHANNEL}/${name}`, channelRoot)),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(new URL(`${CHANNEL}/`, copyRoot))) {
    found.push(entry.name);
  }
  assertEquals(found.sort(), [...NAMES].sort());
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

Deno.test("копии эталонов хука PermissionRequest совпадают с каналом", async (t) => {
  for (const [channel, copy] of RELAY_COPIES) {
    await t.step(copy, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(copy, copyRoot)),
        await Deno.readTextFile(new URL(`${RELAY}/${channel}`, channelRoot)),
      );
    });
  }
  const found: string[] = [];
  for await (
    const entry of Deno.readDir(new URL("permission-request/", copyRoot))
  ) {
    found.push(`permission-request/${entry.name}`);
  }
  assertEquals(found.sort(), RELAY_COPIES.map(([, copy]) => copy).sort());
});

/** Копии эталонов хука `Stop` (`fixtures/telegram-relay/r2/`). */
const STOP_COPIES: readonly (readonly [string, string])[] = [
  ["r2/live-stop.json", "stop/live-stop.json"],
  ["r2/settings-fragment-stop.json", "stop/settings-fragment-stop.json"],
];

Deno.test("копии эталонов хука Stop совпадают с каналом", async (t) => {
  for (const [channel, copy] of STOP_COPIES) {
    await t.step(copy, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(copy, copyRoot)),
        await Deno.readTextFile(new URL(`${RELAY}/${channel}`, channelRoot)),
      );
    });
  }
  const found: string[] = [];
  for await (const entry of Deno.readDir(new URL("stop/", copyRoot))) {
    found.push(`stop/${entry.name}`);
  }
  assertEquals(found.sort(), STOP_COPIES.map(([, copy]) => copy).sort());
});
