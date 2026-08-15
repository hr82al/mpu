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
    channel: "kiten-card",
    copy: "kiten-card/",
    names: [
      "live-raw-card.json",
      "live-raw-comments.json",
      "raw-card-file-property.json",
      "live-json-stdout.json",
      "live-md-stdout.md",
      "live-md-no-comments-stdout.md",
      "live-empty-json-stdout.json",
      "live-empty-md-stdout.md",
      "synthetic-card-detail.json",
      "synthetic-comments.json",
      "synthetic-json-stdout.json",
      "synthetic-md-stdout.md",
      "synthetic-md-no-comments-stdout.md",
      "err-not-found-stderr.txt",
      "err-selector-message.txt",
    ],
  },
  {
    channel: "kiten-field",
    copy: "kiten-field/",
    // `err-badkind-message.txt` канала не копируется: его текст целиком —
    // обрамление прежнего CLI-фреймворка, а не контракт (спека закрепляет
    // только exit 2 без сети).
    names: [
      "ok-set-mr-stdout.txt",
      "ok-set-hypothesis-stdout.txt",
      "ok-artefact-set-stdout.txt",
      "ok-artefact-set-upper-md-stdout.txt",
      "ok-artefact-rm-stdout.txt",
      "ok-artefact-rm-two-files-stdout.txt",
      "ok-artefact-rm-empty-stdout.txt",
      "err-not-md-message.txt",
    ],
  },
  {
    channel: "kiten-comment",
    copy: "kiten-comment/",
    // `err-attachment-without-text-stderr.txt` канала не копируется: он
    // снят как свидетельство отклонения с вердиктом fix и в новой
    // реализации недостижим — комментарий из одних вложений отбивается
    // до сети.
    names: [
      "ok-message-stdout.txt",
      "ok-stdin-stdout.txt",
      "ok-recipients-stdout.txt",
      "ok-recipients-only-stdout.txt",
      "ok-recipients-dedup-stdout.txt",
      "ok-attachment-stdout.txt",
      "ok-attachment-two-stdout.txt",
      "ok-attachment-recipients-stdout.txt",
      "err-no-text-message.txt",
      "err-both-sources-message.txt",
      "err-file-not-found-message.txt",
    ],
  },
  {
    channel: "kiten-time",
    copy: "kiten-time/",
    // Голдены таймера (`status-*`, `start-*`, `discard-*`, `err-start-*`)
    // не копируются: подкоманды таймера едут следующей порцией, а копия
    // без теста — второй источник истины без стерегущей его проверки.
    names: [
      "ls-stdout.txt",
      "ls-all-stdout.txt",
      "ls-json-stdout.txt",
      "ls-empty-stdout.txt",
      "add-stdout.txt",
      "edit-stdout.txt",
      "edit-comment-cleared-stdout.txt",
      "rm-stdout.txt",
      "rm-with-comment-stdout.txt",
      "err-log-not-on-card-stderr.txt",
      "err-duration-zero-message.txt",
      "err-duration-empty-message.txt",
      "err-duration-tail-message.txt",
      "err-duration-minutes-message.txt",
      "err-edit-duration-zero-message.txt",
      "err-edit-no-axis-message.txt",
      "err-date-format-message.txt",
      "start-stdout.txt",
      "status-idle-stdout.txt",
      "status-running-stdout.txt",
      "status-running-comment-stdout.txt",
      "status-json-stdout.txt",
      "discard-stdout.txt",
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
