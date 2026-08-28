/**
 * Сверка таблицы остатка с эталоном (`docs/specs/api-write.md`).
 *
 * Эталон — снимок объекта Python-реализации, а не источник объявлений:
 * объявление шире снимка (в нём `sensitiveOutput`, `secretInput`,
 * имена опций), и на его полноту эта сверка не претендует. Она
 * отвечает на один вопрос — **перенесли ли всё и без искажений**, — и
 * потому сверяет только снятые поля.
 *
 * Сверка двусторонняя: имя эталона без объявления — недоперенос, имя
 * объявления без эталона — опечатка либо команда, выдуманная при
 * переезде. Односторонняя поймала бы первое и пропустила второе.
 */

import { assertEquals } from "@std/assert";
import fixture from "../../docs/specs/fixtures/api/write-endpoints.json" with {
  type: "json",
};
import { pathParams } from "./endpoint.ts";
import { WRITE_ENDPOINTS } from "./endpoints_write.ts";

/** Запись эталона: снятые поля, и только они. */
interface Snapshot {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly path_params: readonly string[];
  readonly body_fields: readonly { name: string; type: string }[];
  readonly accepts_raw_body: boolean;
  readonly no_auth: boolean;
  readonly token_only: boolean;
}

const snapshots = fixture as readonly Snapshot[];

/**
 * `path_params` эталона записаны метавменами CLI (`SS_ID`), а в пути
 * стоят `:spreadsheetId`: имена разные у одного и того же параметра.
 * Сверяется поэтому их **число и порядок мест**, а не написание —
 * именование опций эталон не снимал, и требовать от него совпадения
 * значило бы сверять с ним то, чего в нём нет.
 */
const shapeOf = (spec: { path: string }) => pathParams(spec.path).length;

Deno.test("состав таблицы равен эталону, поимённо в обе стороны", () => {
  const declared = WRITE_ENDPOINTS.map((spec) => spec.name).sort();
  const snapped = snapshots.map((entry) => entry.name).sort();
  const missing = snapped.filter((name) => !declared.includes(name));
  const extra = declared.filter((name) => !snapped.includes(name));
  // Каждая сторона называется своим словом: недоперенос и выдуманное
  // при переезде — разные дефекты, и чинятся они по-разному.
  assertEquals(missing, [], `не перенесены: ${missing.join(", ")}`);
  assertEquals(extra, [], `нет в эталоне: ${extra.join(", ")}`);
  assertEquals(declared.length, snapshots.length);
});

Deno.test("снятые поля совпадают у каждой команды", async (t) => {
  const byName = new Map(WRITE_ENDPOINTS.map((spec) => [spec.name, spec]));
  for (const entry of snapshots) {
    await t.step(entry.name, () => {
      const spec = byName.get(entry.name);
      if (spec === undefined) {
        // Состав стережёт соседний тест; здесь пропуск, а не второй
        // отказ о том же.
        return;
      }
      assertEquals(spec.method, entry.method, `${entry.name}: метод`);
      assertEquals(spec.path, entry.path, `${entry.name}: путь`);
      assertEquals(
        shapeOf(spec),
        pathParams(entry.path).length,
        `${entry.name}: число path-параметров`,
      );
      assertEquals(
        (spec.fields ?? []).map((field) => ({
          name: field.name,
          type: field.type,
        })),
        entry.body_fields.map((field) => ({
          name: field.name,
          type: field.type,
        })),
        `${entry.name}: поля тела`,
      );
      assertEquals(
        spec.body === true,
        entry.accepts_raw_body,
        `${entry.name}: признак произвольного тела`,
      );
      assertEquals(
        spec.noAuth === true,
        entry.no_auth,
        `${entry.name}: признак no_auth`,
      );
    });
  }
});

Deno.test("доли механик — те, что названы в спеке", () => {
  // Числа считаются здесь, а не переносятся текстом: перенесённое
  // число переживает источник, из которого получено, и расходится с
  // ним молча.
  const raw = snapshots.filter((entry) => entry.accepts_raw_body).length;
  const withFields =
    snapshots.filter((entry) => entry.body_fields.length > 0).length;
  const noAuth = snapshots.filter((entry) => entry.no_auth).length;
  assertEquals([snapshots.length, raw, withFields, noAuth], [68, 42, 55, 2]);
  // `token_only` в остатке не стоит ни у одной; поле оставлено в
  // снимке мёртвым намеренно — вычищать непригодившееся значило бы
  // править снимок под себя.
  assertEquals(snapshots.filter((entry) => entry.token_only).length, 0);
});
