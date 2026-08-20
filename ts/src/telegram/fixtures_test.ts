/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { assertEquals } from "@std/assert";

/** Область канала и её копия: `copy` — подкаталог `testdata/`. */
interface FixtureSet {
  readonly channel: string;
  readonly copy: string;
  readonly names: readonly string[];
}

/**
 * Копии по командам: подкаталог на команду, его имя совпадает с областью
 * канала. Раскладка одна на всё семейство — иначе у сверки заводятся
 * частные случаи, а копия команды теряется среди чужих файлов.
 */
const SETS: readonly FixtureSet[] = [
  {
    channel: "telegram-send",
    copy: "telegram-send/",
    names: [
      "err-empty-text-stderr.txt",
      "err-file-missing-stderr.txt",
      "send-album-stdout.txt",
      "send-file-stdout.txt",
      "send-text-stdout.txt",
    ],
  },
  {
    channel: "telegram-log",
    copy: "telegram-log/",
    names: [
      "err-empty-text-stderr.txt",
      "log-stdout.txt",
    ],
  },
  {
    channel: "telegram-ls",
    copy: "telegram-ls/",
    names: [
      "err-limit-stderr.txt",
      "ls-empty-stdout.txt",
      "ls-empty-table-stdout.txt",
      "ls-json-stdout.txt",
    ],
  },
  {
    channel: "telegram-search",
    copy: "telegram-search/",
    names: [
      "err-empty-query-stderr.txt",
      "err-from-without-chat-stderr.txt",
      "err-limit-stderr.txt",
      "search-empty-stdout.txt",
      "search-empty-table-stdout.txt",
      "search-json-stdout.txt",
      "warn-scan-cap-stderr.txt",
    ],
  },
  {
    channel: "telegram-status",
    copy: "telegram-status/",
    names: [
      "err-no-chat-stderr.txt",
      "status-empty-stdout.txt",
      "status-report-stdout.txt",
      "warn-card-history-stderr.txt",
      "warn-live-skipped-stderr.txt",
    ],
  },
];

const channelRoot = new URL("../../docs/specs/fixtures/", import.meta.url);
const copyRoot = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const set of SETS) {
    for (const name of set.names) {
      await t.step(`${set.channel}/${name}`, async () => {
        assertEquals(
          await Deno.readTextFile(new URL(`${set.copy}${name}`, copyRoot)),
          await Deno.readTextFile(
            new URL(`${set.channel}/${name}`, channelRoot),
          ),
        );
      });
    }
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const declared = SETS
    .flatMap((set) => set.names.map((name) => `${set.copy}${name}`))
    .sort();
  assertEquals((await copiedNames()).sort(), declared);
});

/** Всё, что лежит в `testdata/`, путями относительно него. */
async function copiedNames(prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(new URL(prefix, copyRoot))) {
    if (entry.isDirectory) {
      found.push(...await copiedNames(`${prefix}${entry.name}/`));
      continue;
    }
    found.push(`${prefix}${entry.name}`);
  }
  return found;
}
