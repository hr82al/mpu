/**
 * Копия клиента: схема через `pg_dump`/`pg_restore` плюс public- и
 * токен-строки (`copy-client.md`, шаги 1, 3, 4).
 *
 * Модуль общий для двух команд: `copy-client` берёт источником прод,
 * `copy-dev` — dev-стенд, и различаются они ровно источником. Второй
 * копии этой машинерии быть не должно: порядок «дамп → снос цели →
 * восстановление» и построчные счётчики — контракт, и разъехавшись,
 * две реализации разошлись бы и в нём.
 */

import { DomainError } from "../command/mod.ts";
import {
  type SqlSession,
  type Statement,
  StatementError,
} from "../sql/session.ts";
import type { PgTarget } from "../sql/target.ts";
import {
  clientWhere,
  SL0_CLIENT_TABLES,
  SL1_CLIENT_TABLES,
  SPREADSHEET_CHILDREN,
  spreadsheetIds,
  spreadsheetWhere,
  type TableCount,
  tableStatements,
} from "./rows.ts";
import { localUnreachable } from "./targets.ts";
import {
  dumpSchemaArgs,
  restoreArgs,
  type RunTool,
  runTool,
  toolFailure,
} from "./tools.ts";

/**
 * Открыватель сессии. Режим передаётся явно: источник открывается
 * только на чтение, и это держит сервер (`default_transaction_read_only`),
 * а не дисциплина вызовов — одна строчка, написанная через `run`
 * вместо `query`, иначе означала бы запись в прод.
 */
export type OpenSession = (
  target: PgTarget,
  mode: "read-only" | "write",
) => Promise<SqlSession>;

/** Всё, что нужно копии клиента. */
export interface ClientCopy {
  readonly progress: (line: string) => void;
  readonly clientId: number;
  readonly source: PgTarget;
  readonly sl1: PgTarget;
  readonly sl0: PgTarget;
  readonly run: RunTool;
  readonly open: OpenSession;
  readonly tempFile: () => string;
  readonly removeFile: (path: string) => void;
  readonly nowMs: () => number;
}

/** Счётчики перенесённых строк по обоим приёмникам. */
export interface CopyCounts {
  readonly sl1: readonly TableCount[];
  readonly sl0: readonly TableCount[];
}

/** Открывает локальную сессию, называя контейнер при отказе. */
async function openLocal(
  open: OpenSession,
  target: PgTarget,
): Promise<SqlSession> {
  try {
    return await open(target, "write");
  } catch (err) {
    throw localUnreachable(target, err);
  }
}

/**
 * Шаг 1: дамп с источника, снос цели, восстановление.
 *
 * Порядок именно такой. Снос до дампа оставил бы оператора без обеих
 * копий, если дамп упадёт (`DROP SCHEMA … CASCADE` необратим), а без
 * сноса восстановление легло бы поверх уцелевших вчерашних таблиц:
 * дамп несёт `CREATE SCHEMA`, но не удаляет лишнего.
 */
export async function copySchema(copy: ClientCopy): Promise<void> {
  const schema = `schema_${copy.clientId}`;
  copy.progress(
    `схема ${schema} на приёмнике: ${await schemaState(copy, schema)}`,
  );
  const file = copy.tempFile();
  try {
    const dumpArgv = dumpSchemaArgs(copy.source, schema, file);
    copy.progress(`$ ${dumpArgv.join(" ")}`);
    const dump = await runTool(
      copy.run,
      dumpArgv,
      copy.source,
      copy.progress,
      copy.nowMs,
      (seconds) => copy.progress(`  … pg_dump идёт ${seconds}s`),
    );
    if (dump.code !== 0) {
      throw new DomainError(toolFailure("pg_dump", schema, dump));
    }
    const to = await openLocal(copy.open, copy.sl1);
    try {
      copy.progress(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
      await to.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
    } finally {
      await to.close();
    }
    const restoreArgv = restoreArgs(copy.sl1, file);
    copy.progress(`$ ${restoreArgv.join(" ")}`);
    const restore = await runTool(
      copy.run,
      restoreArgv,
      copy.sl1,
      copy.progress,
      copy.nowMs,
      (seconds) => copy.progress(`  … pg_restore идёт ${seconds}s`),
    );
    if (restore.code !== 0) {
      // Ненулевой код — отказ, даже когда схема на месте: разбирать
      // чужие ошибки по тексту команда не должна. Но последняя ошибка
      // входит в сообщение, иначе оператор видит «failed» и не знает,
      // что данные скопировались (`copy-client.md`, «Ловушки»).
      throw new DomainError(toolFailure("pg_restore", schema, restore));
    }
  } finally {
    // Дамп схемы клиента — его данные: на диске им делать нечего ни
    // при успехе, ни при отказе.
    copy.removeFile(file);
  }
}

/**
 * Состояние схемы на приёмнике: оператор видит, поверх чего ложится
 * копия. Упавшая проверка равнозначна «схемы нет» — это диагностика, и
 * ронять из-за неё копию незачем (спека, «Граничные случаи»).
 */
async function schemaState(copy: ClientCopy, schema: string): Promise<string> {
  try {
    const to = await copy.open(copy.sl1, "write");
    try {
      const outcome = await to.query(
        "SELECT nspname FROM pg_namespace WHERE nspname = " +
          `'${schema}'`,
      );
      return outcome.kind === "rows" && outcome.rows.length > 0
        ? "есть, будет пересоздана"
        : "нет, будет создана";
    } finally {
      await to.close();
    }
  } catch {
    return "нет, будет создана";
  }
}

/** Шаги 3–4: public-строки в sl-1, токен-строки в sl-0. */
export async function copyRows(copy: ClientCopy): Promise<CopyCounts> {
  // Источник — только на чтение: инвариант «источник не мутируется»
  // держит сервер, а не аккуратность этого файла.
  const from = await copy.open(copy.source, "read-only");
  try {
    return {
      sl1: await copyInto(copy, from, copy.sl1, "sl-1"),
      sl0: await copyInto(copy, from, copy.sl0, "sl-0"),
    };
  } finally {
    await from.close();
  }
}

/**
 * Посев одной транзакцией. Отказ называет таблицу, на которой встало, и
 * говорит прямо, что посев откачен целиком: «invalid input syntax» без
 * этого не сообщает оператору ни где остановились, ни в каком состоянии
 * остался приёмник, — а от второго зависит, повторять прогон или сперва
 * чинить данные.
 *
 * Числа перенесённого в тексте нет намеренно: транзакция одна, откат
 * полный, и любое число здесь читалось бы как «столько-то доехало».
 * Названо другое, честное: сколько строк этой таблицы прочитано с
 * источника — по нему видно, на большой таблице встало или на пустой.
 */
async function seed(
  to: SqlSession,
  statements: readonly Statement[],
  counts: readonly TableCount[],
): Promise<void> {
  try {
    await to.runMany(statements);
  } catch (err) {
    // Отказ `BEGIN` или `COMMIT` приходит обычной ошибкой БД: он не
    // относится ни к одному оператору списка, и называть таблицу
    // нечем — но доменной ошибкой он всё равно обязан быть.
    if (!(err instanceof StatementError)) {
      throw new DomainError(`перенос строк: ${message(err)}`, { cause: err });
    }
    const label = statements[err.index]?.label ?? err.label;
    const read = counts.find((count) => count.table === label);
    const where = read === undefined
      ? `оператор ${err.index + 1} (${label ?? "?"})`
      : `таблица ${label}, прочитано с источника ${read.rows} строк`;
    throw new DomainError(
      `перенос строк: ${where}; посев откачен целиком; ${err.message}`,
      { cause: err },
    );
  }
}

/** Причина отказа одной строкой. */
function message(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/** Перенос набора таблиц в один приёмник; печатает счётчики. */
async function copyInto(
  copy: ClientCopy,
  from: SqlSession,
  target: PgTarget,
  label: "sl-1" | "sl-0",
): Promise<readonly TableCount[]> {
  const to = await openLocal(copy.open, target);
  try {
    const counts: TableCount[] = [];
    // Replica-режим снимает FK и триггеры: порядок таблиц перестаёт
    // иметь значение, и список можно держать плоским.
    const statements: Statement[] = [{
      sql: "SET session_replication_role = replica",
      label: "session_replication_role",
    }];

    const clients = await tableStatements(from, "clients", {
      text: "id = $1",
      params: [copy.clientId],
    });
    counts.push(clients.count);
    statements.push(...clients.statements);
    // Клиент на стенде живёт на sl-1, чем бы он ни был в источнике:
    // иначе локальные сервисы искали бы его на чужом сервере.
    statements.push({
      sql: "UPDATE public.clients SET server = 'sl-1' WHERE id = $1",
      params: [copy.clientId],
      label: "clients",
    });

    const tables = label === "sl-1" ? SL1_CLIENT_TABLES : SL0_CLIENT_TABLES;
    for (const table of tables) {
      const prepared = await tableStatements(
        from,
        table,
        clientWhere(copy.clientId),
      );
      counts.push(prepared.count);
      statements.push(...prepared.statements);
    }

    if (label === "sl-1") {
      const sourceIds = await spreadsheetIds(from, copy.clientId);
      // Множество приёмника добавляется к фильтру удаления: таблица,
      // удалённая на источнике, иначе оставила бы на стенде висячих
      // детей от прошлой копии (спека, шаг 3).
      const targetIds = await spreadsheetIds(to, copy.clientId);
      const select = spreadsheetWhere([...sourceIds]);
      const remove = spreadsheetWhere([
        ...new Set([...sourceIds, ...targetIds]),
      ]);
      for (const table of SPREADSHEET_CHILDREN) {
        const prepared = await tableStatements(from, table, select, remove);
        counts.push(prepared.count);
        statements.push(...prepared.statements);
      }
    }

    // Одна транзакция на весь посев: он либо применяется целиком, либо
    // не применяется вовсе. Значения уходят параметрами, поэтому
    // операторы идут по одному — расширенный протокол несёт ровно один
    // оператор на вызов.
    await seed(to, statements, counts);
    for (const count of counts) {
      // Построчные счётчики — то, по чему оператор видит, что именно
      // скопировалось: «готово» без чисел не отличить от пустой копии.
      copy.progress(`  ${label} ${count.table}: ${count.rows}`);
    }
    return counts;
  } finally {
    await to.close();
  }
}

/** Полная копия клиента: схема, затем строки обоих приёмников. */
export async function copyClientData(copy: ClientCopy): Promise<CopyCounts> {
  await copySchema(copy);
  return await copyRows(copy);
}
