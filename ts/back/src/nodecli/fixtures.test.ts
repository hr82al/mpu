/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). В этой порции сверяются копии всех
 * файлов канала, включая те, что понадобятся следующей: расхождение
 * копии с каналом должно ловиться сразу, а не в тот день, когда до неё
 * дойдут руки.
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

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
  "process-dev-print.stdout.txt",
  "process-lists-print.stdout.txt",
  "process-print.stdout.txt",
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

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(
            `../../../docs/specs/fixtures/${CHANNEL}/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for (const entry of await readdir(copyDir, { withFileTypes: true }))
    found.push(entry.name);
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});
