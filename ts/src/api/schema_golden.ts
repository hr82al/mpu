/**
 * Голдены состава колонок (`docs/specs/fixtures/api/schema/`): чтение и
 * сверка. Живут в `src`, а не в скрипте проверки, потому что нужны
 * обоим её концам — тесту без базы и `deno task smoke` с базой, — и
 * потому что сверяемая часть должна проверяться сама.
 *
 * Голден отвечает на вопрос «есть ли такая колонка», но не на вопрос
 * «та ли это база»: второе умеет только сверка с живой
 * `information_schema`, и она идёт из smoke при поднятом стенде.
 */

import type { EnvFile } from "../command/mod.ts";
import { type PgTarget, serverTarget } from "../sql/mod.ts";

/** Каталог голденов; единица — файл, а не список имён в коде. */
export const SCHEMA_DIR = "../../docs/specs/fixtures/api/schema/";

const SUFFIX = ".columns";

/** Голден одной таблицы: имя берётся из имени файла. */
export interface SchemaGolden {
  readonly table: string;
  readonly columns: readonly string[];
}

/**
 * Все голдены каталога, по имени таблицы. Каталог обходится целиком:
 * взять первый файл значило бы завести молчаливый предел, который
 * никак не виден следующему, кто положит второй голден.
 */
export async function schemaGoldens(
  dir: URL = new URL(SCHEMA_DIR, import.meta.url),
): Promise<readonly SchemaGolden[]> {
  const out: SchemaGolden[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(SUFFIX)) continue;
    const text = await Deno.readTextFile(new URL(entry.name, dir));
    out.push({
      table: entry.name.slice(0, -SUFFIX.length),
      columns: columnsOf(text),
    });
  }
  return out.sort((a, b) => a.table < b.table ? -1 : 1);
}

/** Колонки из текста голдена: по имени на строку, пустые пропускаются. */
export function columnsOf(text: string): readonly string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  );
}

/** Расхождение голдена с живой схемой, по сторонам. */
export interface SchemaDiff {
  /** Есть в голдене, нет в базе: колонку переименовали или убрали. */
  readonly missing: readonly string[];
  /** Есть в базе, нет в голдене: колонку добавили, снимок устарел. */
  readonly extra: readonly string[];
}

/**
 * Сверка состава. Стороны названы по отдельности намеренно: пропавшая
 * колонка ломает запрос сегодня, а новая — лишь означает, что снимок
 * устарел, и чинятся они по-разному.
 */
export function compareColumns(
  golden: readonly string[],
  live: readonly string[],
): SchemaDiff {
  return {
    missing: golden.filter((name) => !live.includes(name)),
    extra: live.filter((name) => !golden.includes(name)),
  };
}

/** Номер сервера main-БД: тот же, откуда `mpu update` берёт клиентов. */
const MAIN_SERVER = 0;

/**
 * Куда идти за живой схемой — либо почему идти некуда. Решение вынесено
 * из скрипта проверки, чтобы проверяться без базы: «пропустить» и
 * «сверить» — разные исходы, и подменить первый вторым нельзя молча.
 */
export type SchemaCheckPlan =
  | { readonly kind: "check"; readonly target: PgTarget }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * План сверки по реквизитам оператора. Нет реквизитов — пропуск с
 * причиной, а не отказ: стенд поднимают не всегда, и «не с чем
 * сверять» — это другой исход, чем «сверили и разошлось».
 */
export function schemaCheckPlan(envFile: EnvFile): SchemaCheckPlan {
  try {
    return { kind: "check", target: serverTarget(envFile, MAIN_SERVER) };
  } catch (err) {
    return {
      kind: "skip",
      reason: `реквизиты main-БД не заданы: ${
        (err instanceof Error ? err.message : String(err)).split("\n")[0]
      }`,
    };
  }
}
