/**
 * Команда `mpu sql-ro` (`docs/specs/sql-ro.md`): ad-hoc SQL по селектору
 * в enforced read-only сессии PostgreSQL. Запрет записи держит сервер, а
 * не разбор текста запроса (`platform/readonly-default.md`).
 *
 * Здесь — только объявление команды и её справка: ход вызова общий с
 * write-вариантом и лежит в `run.ts`.
 */

import { defineCommand } from "../command/mod.ts";
import { renderOutcome } from "./render.ts";
import {
  argsSchema,
  formatOf,
  resultSchema,
  runSql,
  selectorOf,
  type SqlIo,
} from "./run.ts";
import { routeOf } from "./target.ts";

export const sqlRoCommand = defineCommand({
  path: ["sql-ro"],
  // Однострока — из слепка дерева: имя и описание переехавшей команды
  // видит режим дополнения, и расходиться с эталоном им незачем.
  summary:
    "Выполнить SQL в enforced read-only сессии (безопасный дефолт для чтения).",
  usage: "mpu sql-ro SELECTOR [SQL] [--server sl-N] [--dry] [--json|--md] [-v]",
  help: `Запись отклоняет сам сервер (SQLSTATE 25006), а не разбор
текста запроса; для записи — \`mpu sql\`.

SELECTOR: sl-N (сервер целиком, main — sl-0), dev:<client_id>
(dev-стенд, схема schema_<client_id>), sw-алиас (БД воркспейсов) либо
поиск по кэшу. Ровно один client_id среди кандидатов — search_path на
его схему, иначе search_path сервера. --server sl-N резолв отменяет.

SQL — второй аргумент, иначе stdin целиком (с терминала — до Ctrl+D);
пустой — ошибка ввода без подключения. Уходит серверу как есть, одним
вызовом: печатается результат ПЕРВОГО оператора, ошибка любого — отказ
всего вызова.

Вывод: таблица, --json (массив объектов), --md; вместе --json и --md —
ошибка ввода. --dry: мета-блок и SQL без подключения; -v — тот же блок
при обычном прогоне.

Ключи env-файла (окружение процесса не читается): pg_<N>, PG_PORT
(5432), PG_DB_NAME (wb), PG_MY_USER_NAME/PG_MAIN_USER_NAME и пароли
PG_MY_USER_PASSWORD/PG_MAIN_USER_PASSWORD; для dev — DEV_PG_HOST,
DEV_PG_PORT (5434), DEV_PG_DB (mp_sl_1_dev), DEV_PG_USER,
DEV_PG_PASSWORD.

Exit: 0 — успех, включая --dry и запрос без набора строк; 1 — отказ
записи и ошибка БД; 2 — ошибка ввода, резолва и конфигурации.

Пример: mpu sql-ro 42 'SELECT count(*) FROM orders' --json`,
  policy: "ro",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    sql: { positional: "one" },
    verbose: { short: "v" },
  },
  resultSchema,
  // Вызов с sw-селектором целиком исполняет прежняя реализация
  // (`specs/sql-ro.md`, маршрут 2): argv разбирается ею же, поэтому
  // селектор ищется в сыром argv, до схемы.
  bridge: (args) => routeOf(selectorOf(args) ?? "").kind === "sw",
  run: (args, io: SqlIo) => runSql(args, io, { mode: "read-only" }),
  render: (result, args) =>
    result.outcome === null
      ? ""
      : renderOutcome(result.outcome, formatOf(args)),
});
