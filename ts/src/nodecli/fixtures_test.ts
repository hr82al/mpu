/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). В этой порции сверяются копии всех
 * файлов канала, включая те, что понадобятся следующей: расхождение
 * копии с каналом должно ловиться сразу, а не в тот день, когда до неё
 * дойдут руки.
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "portainer-wrappers";

const NAMES: readonly string[] = [
  "app-migrations-latest-print.stdout.txt",
  "clients-migrations-latest-print.stdout.txt",
  "data-loader-jobs-show-print.stdout.txt",
  "data-loader-print.stdout.txt",
  "datasets-migrations-list-print.stdout.txt",
  "err-ambiguous-spreadsheet.stderr.txt",
  "err-no-pg-user.stderr.txt",
  "err-unsafe-token.stderr.txt",
  "ozon-jobs-show-print.stdout.txt",
  "ozon-loader-campaigns-print.stdout.txt",
  "ozon-loader-load-data-print.stdout.txt",
  "ozon-recalculate-expenses-verbose-print.stderr.txt",
  "ozon-recalculate-expenses-verbose-print.stdout.txt",
  "ozon-save-expenses-print.stdout.txt",
  "ss-datasets-print.stdout.txt",
  "ss-load-print.stdout.txt",
  "ss-update-print.stdout.txt",
  "users-add-print.stdout.txt",
  "users-add-role-print.stdout.txt",
  "wb-jobs-show-print.stdout.txt",
  "wb-loader-cards-print-local.stdout.txt",
  "wb-loader-cards-print.stdout.txt",
  "wb-recalculate-expenses-print.stdout.txt",
  "wb-save-expenses-print.stdout.txt",
  "wb-unit-calc-print.stdout.txt",
  "wb-unit-proto-new-print.stdout.txt",
];

const copyDir = new URL(`testdata/${CHANNEL}/`, import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of NAMES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(
          new URL(
            `../../docs/specs/fixtures/${CHANNEL}/${name}`,
            import.meta.url,
          ),
        ),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) found.push(entry.name);
  assertEquals(found.sort(), [...NAMES].sort());
});
