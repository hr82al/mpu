/**
 * Сверка обеих половин таблицы `api` с эталоном (`docs/specs/api.md`,
 * `api-write.md`).
 *
 * Эталон — снимок объекта Python-реализации, снятый **целиком**, а не
 * проекцией: у поля тела в нём есть и обязательность, и текст помощи.
 * Прежний эталон пишущей половины хранил у поля только имя и тип, и
 * сверка честно оговаривала, что сверяет только снятые поля, — из-за
 * чего обязательность не была перенесена ни у одной из 23 команд, у
 * которых она есть, и никто этого не видел (замер 2026-08-31).
 *
 * Объявление по-прежнему шире снимка (`sensitiveOutput`, `secretInput`,
 * имена опций) — на его полноту сверка не претендует. Вопрос у неё
 * один: **перенесли ли всё и без искажений**.
 *
 * Половины сверяются одной функцией, а не двумя копиями: вторая копия
 * разошлась бы с первой молча — ровно тем же способом, каким разошлись
 * эталон и таблица.
 */

import { assertEquals } from "@std/assert";
import readFixture from "../../docs/specs/fixtures/api/read-endpoints.json" with {
  type: "json",
};
import writeFixture from "../../docs/specs/fixtures/api/write-endpoints.json" with {
  type: "json",
};
import { type EndpointSpec, PATH_ARG_HELP } from "./endpoint.ts";
import { apiCommands } from "./mod.ts";
import { READ_ENDPOINTS } from "./endpoints.ts";
import { WRITE_ENDPOINTS } from "./endpoints_write.ts";

/** Поле тела в снимке объекта. */
interface SnapshotField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

/** Запись эталона: всё, что есть у объекта. */
interface Snapshot {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  /**
   * Однострока и абзац описания у объекта. Дословно с объявлениями не
   * сверяются: там они намеренно свои (решение порции 88) — у объекта
   * тексты писаны под его же справку, и дословная сверка запрещала бы
   * их улучшать. В снимке оставлены, а не вычищены: вычищать
   * непригодившееся значило бы править снимок под себя — ровно та
   * проекция, из-за которой обязательность и не переносилась.
   */
  readonly summary: string;
  readonly description: string | null;
  readonly path_params: readonly { name: string; description: string }[];
  readonly body_fields: readonly SnapshotField[];
  readonly accepts_raw_body: boolean;
  readonly no_auth: boolean;
  readonly token_only: boolean;
}

/** Доли механик половины: считаются из эталона, а не переносятся текстом. */
interface Shares {
  readonly total: number;
  readonly rawBody: number;
  readonly withFields: number;
  readonly noAuth: number;
  readonly tokenOnly: number;
  /** Команды с обязательными полями и число самих полей. */
  readonly requiredCommands: number;
  readonly requiredFields: number;
}

/** Половина таблицы: эталон, объявления и имена вне таблицы. */
interface Half {
  readonly title: string;
  readonly snapshots: readonly Snapshot[];
  readonly declared: readonly EndpointSpec[];
  /**
   * Имена эталона, которых в таблице нет намеренно, — поимённо, а не
   * условием вроде «пропускать `token_only`»: условие завтра проглотит
   * второе такое имя молча, а список на него покраснеет.
   */
  readonly custom: readonly string[];
  readonly shares: Shares;
}

const HALVES: readonly Half[] = [
  {
    title: "читающая",
    snapshots: readFixture as readonly Snapshot[],
    declared: READ_ENDPOINTS,
    // `get-token` живёт своей командой (`cmd_get_token.ts`): у неё
    // кэш токена и своя справка, строкой таблицы она не выражается.
    custom: ["get-token"],
    // Доли считаются по всему снимку, включая исключённое имя: это
    // утверждение о снимке объекта, а не о таблице. Отсюда total 22
    // при 21 объявленной, а `noAuth`/`tokenOnly` — целиком про
    // `get-token`.
    shares: {
      total: 22,
      rawBody: 1,
      withFields: 2,
      noAuth: 1,
      tokenOnly: 1,
      requiredCommands: 1,
      requiredFields: 1,
    },
  },
  {
    title: "пишущая",
    snapshots: writeFixture as readonly Snapshot[],
    declared: WRITE_ENDPOINTS,
    custom: [],
    shares: {
      total: 68,
      rawBody: 42,
      withFields: 55,
      noAuth: 2,
      tokenOnly: 0,
      requiredCommands: 23,
      requiredFields: 33,
    },
  },
];

/** Имена обязательных полей — то, чего прежний эталон не снимал. */
function requiredNames(
  fields: readonly { name: string; required?: boolean }[],
): readonly string[] {
  return fields.filter((field) => field.required === true).map((f) => f.name);
}

for (const half of HALVES) {
  Deno.test(`${half.title} половина: состав равен эталону в обе стороны`, () => {
    const declared = half.declared.map((spec) => spec.name).sort();
    const snapped = half.snapshots
      .map((entry) => entry.name)
      .filter((name) => !half.custom.includes(name))
      .sort();
    // Каждая сторона называется своим словом: недоперенос и выдуманное
    // при переезде — разные дефекты, и чинятся они по-разному.
    const missing = snapped.filter((name) => !declared.includes(name));
    const extra = declared.filter((name) => !snapped.includes(name));
    assertEquals(missing, [], `не перенесены: ${missing.join(", ")}`);
    assertEquals(extra, [], `нет в эталоне: ${extra.join(", ")}`);
    assertEquals(declared.length, snapped.length);
    // Список исключений не переживает эталон: имя, ушедшее из снимка,
    // осталось бы в нём мёртвым и молча прикрывало бы недоперенос.
    const names = half.snapshots.map((entry) => entry.name);
    assertEquals(
      half.custom.filter((name) => !names.includes(name)),
      [],
      "исключение названо, а в эталоне такого имени нет",
    );
    // И само исключение — утверждение, а не дыра: команда обязана
    // существовать своей реализацией. Иначе именем в этом списке
    // гасился бы недоперенос: тест зеленел бы, а команды не было бы.
    const declaredElsewhere = apiCommands.map((command) => command.path[1]);
    assertEquals(
      half.custom.filter((name) => !declaredElsewhere.includes(name)),
      [],
      "исключение названо, а команды с таким именем нет",
    );
  });

  Deno.test(`${half.title} половина: снятое совпадает у каждой команды`, async (t) => {
    const byName = new Map(half.declared.map((spec) => [spec.name, spec]));
    for (const entry of half.snapshots) {
      if (half.custom.includes(entry.name)) continue;
      await t.step(entry.name, () => {
        const spec = byName.get(entry.name);
        if (spec === undefined) {
          // Состав стережёт соседний тест; здесь пропуск, а не второй
          // отказ о том же.
          return;
        }
        const fields = spec.fields ?? [];
        assertEquals(spec.method, entry.method, `${entry.name}: метод`);
        assertEquals(spec.path, entry.path, `${entry.name}: путь`);
        assertEquals(
          fields.map((field) => ({ name: field.name, type: field.type })),
          entry.body_fields.map((field) => ({
            name: field.name,
            type: field.type,
          })),
          `${entry.name}: поля тела`,
        );
        // Обязательность — списком имён, а не поштучно: в отказе видно
        // и команду, и какое поле разошлось.
        assertEquals(
          requiredNames(fields),
          requiredNames(entry.body_fields),
          `${entry.name}: обязательные поля тела`,
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
        // Справочные тексты в объявлениях намеренно свои: у объекта они
        // писаны под его же справку, и дословная сверка запрещала бы их
        // улучшать. Поэтому проверяется НАЛИЧИЕ строки помощи там, где
        // она есть у объекта, а не совпадение текста: молчать о них
        // нельзя — молчание эталона о необязательном и завело эту
        // порцию.
        const silent = entry.body_fields
          .filter((field) => field.description !== "")
          .map((field) => field.name)
          .filter((name) =>
            (fields.find((field) => field.name === name)?.help ?? "") === ""
          );
        assertEquals(
          silent,
          [],
          `${entry.name}: нет строки помощи у полей: ${silent.join(", ")}`,
        );
        // То же для path-параметров: пояснения к ним живут одной
        // таблицей на все пути (`PATH_ARG_HELP`), и её пробел виден
        // здесь, а не в справке у пользователя.
        const mute = entry.path_params
          .filter((param) => param.description !== "")
          .map((param) => param.name)
          .filter((name) => (PATH_ARG_HELP[name] ?? "") === "");
        assertEquals(
          mute,
          [],
          `${entry.name}: нет пояснения к path-параметрам: ${mute.join(", ")}`,
        );
      });
    }
  });

  Deno.test(`${half.title} половина: доли механик — те, что названы в спеке`, () => {
    // Числа считаются здесь, а не переносятся текстом: перенесённое
    // число переживает источник, из которого получено, и расходится с
    // ним молча.
    const snaps = half.snapshots;
    const withRequired = snaps.filter((entry) =>
      entry.body_fields.some((field) => field.required)
    );
    assertEquals({
      total: snaps.length,
      rawBody: snaps.filter((entry) => entry.accepts_raw_body).length,
      withFields: snaps.filter((entry) => entry.body_fields.length > 0).length,
      noAuth: snaps.filter((entry) => entry.no_auth).length,
      tokenOnly: snaps.filter((entry) => entry.token_only).length,
      requiredCommands: withRequired.length,
      requiredFields: snaps.reduce(
        (sum, entry) =>
          sum + entry.body_fields.filter((field) => field.required).length,
        0,
      ),
    }, half.shares);
  });
}
