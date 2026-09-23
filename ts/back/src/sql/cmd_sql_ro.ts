/**
 * Команда `mpu sql-ro` (`docs/specs/sql-ro.md`): ad-hoc SQL по селектору
 * в enforced read-only сессии PostgreSQL. Запрет записи держит сервер, а
 * не разбор текста запроса (`platform/readonly-default.md`).
 *
 * Здесь — только объявление команды и её справка: ход вызова общий с
 * write-вариантом и лежит в `run.ts`.
 */

import { defineCommand } from "../command/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { SQL_ITEMS } from "./items.ts";
import { renderOutcome } from "./render.ts";
import {
  argsSchema,
  formatOf,
  resultSchema,
  runSql,
  type SqlIo,
} from "./run.ts";

export const sqlRoCommand = defineCommand({
  path: ["sql-ro"],
  terminalInput: "sql",
  // Однострока — из слепка дерева: имя и описание переехавшей команды
  // видит режим дополнения, и расходиться с эталоном им незачем.
  summary:
    "Выполнить SQL в enforced read-only сессии (безопасный дефолт для чтения).",
  usage: `mpu sql-ro [dry] [verbose] target: ЦЕЛЬ [sql: ЗАПРОС] ` +
    `[${GRAMMAR.close} md|json]`,
  help: `Звать для любого чтения из БД клиента или сервера: запрос идёт в
read-only сессии, запись отклоняет сам сервер (SQLSTATE 25006), а не
разбор текста запроса. Для записи — mpu ask sql.

target: — где исполнить: sl-N (сервер целиком, main — sl-0),
dev:<client_id> (dev-стенд, схема schema_<client_id>), номер клиента,
имя или его часть (поиск по кэшу). Ровно один client_id среди кандидатов
— search_path на его схему, иначе search_path сервера.

sql: — запрос; sql: stdin или без sql: — ввод (с терминала — до Ctrl+D);
пустой — ошибка ввода без подключения. Уходит серверу как есть, одним
вызовом: печатается результат ПЕРВОГО оператора, ошибка любого — отказ
всего вызова.

Форматы после ${GRAMMAR.close}: без формата — таблица; md; json — массив объектов.
dry: мета-блок и SQL без подключения; verbose — тот же блок при
обычном прогоне.

Ключи env-файла (окружение процесса не читается): pg_<N>, PG_PORT
(5432), PG_DB_NAME (wb), PG_MY_USER_NAME/PG_MAIN_USER_NAME и пароли
PG_MY_USER_PASSWORD/PG_MAIN_USER_PASSWORD; для dev — DEV_PG_HOST,
DEV_PG_PORT (5434), DEV_PG_DB (mp_sl_1_dev), DEV_PG_USER,
DEV_PG_PASSWORD.

Exit: 0 — успех, включая dry и запрос без набора строк; 1 — отказ
записи и ошибка БД; 2 — ошибка ввода, резолва и конфигурации.`,
  examples: [
    'mpu sql-ro target: 42 sql: "SELECT count(*) FROM orders"',
    `mpu sql-ro target: sl-1 sql: "select 1" ${GRAMMAR.close} json`,
    'echo "select 1" | mpu sql-ro dry target: dev:54 sql: stdin',
  ],
  keys: { target: "selector", sql: "sql" },
  retired: { server: "target" },
  policy: "ro",
  argsSchema,
  formats: { md: ["--md"] },
  forms: {
    selector: { positional: "one" },
    sql: { positional: "one" },
    verbose: { short: "v" },
  },
  resultSchema,
  run: (args, io: SqlIo) => runSql(args, io, { mode: "read-only" }),
  items: SQL_ITEMS,
  render: (result, args) =>
    result.outcome === null
      ? ""
      : renderOutcome(result.outcome, formatOf(args)),
});
