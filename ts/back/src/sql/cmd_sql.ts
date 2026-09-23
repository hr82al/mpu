/**
 * Команда `mpu sql` (`docs/specs/sql.md`): ad-hoc SQL по селектору в
 * пишущей сессии PostgreSQL. Контракт общий с `mpu sql-ro`, отличий
 * четыре — режим сессии, мета-блок без строки режима, префикс ошибок и
 * отсутствие собственного подтверждения мутаций.
 *
 * Запись защищает внешний слой разрешений запускающего окружения
 * (паттерн 1 `platform/readonly-default.md`), а не проверка внутри
 * команды: `--dry` — превью, не защита.
 */

import { defineCommand } from "../command/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { renderOutcome } from "./render.ts";
import {
  argsSchema,
  formatOf,
  resultSchema,
  runSql,
  type SqlIo,
} from "./run.ts";

export const sqlCommand = defineCommand({
  path: ["sql"],
  terminalInput: "sql",
  // Однострока — из слепка дерева: имя и описание переехавшей команды
  // видит режим дополнения, и расходиться с эталоном им незачем.
  summary: "Выполнить SQL (write-capable) на PG, выбранном по селектору.",
  usage: `mpu sql target: ЦЕЛЬ [sql: ЗАПРОС] [--dry] [--verbose] ` +
    `[${GRAMMAR.close} md|json]`,
  help: `Звать, когда запрос пишет: INSERT/UPDATE/DELETE/DDL исполняются и
фиксируются в БД клиента, поэтому строка спрашивает подтверждение
человека. Для чтения — mpu sql-ro.

target: — где исполнить: sl-N (сервер целиком, main — sl-0),
dev:<client_id> (dev-стенд, схема schema_<client_id>), номер клиента,
имя или его часть (поиск по кэшу). Ровно один client_id среди кандидатов
— search_path на его схему, иначе search_path сервера.

sql: — запрос; sql: stdin или без sql: — ввод (с терминала — до Ctrl+D);
пустой — ошибка ввода без подключения. Уходит серверу как есть, в одной
транзакции: печатается результат ПЕРВОГО оператора, ошибка любого —
откат всего вызова, частичной записи не бывает.

Форматы после ${GRAMMAR.close}: без формата — таблица; md; json — массив объектов.
Запись без набора строк — OK (rowcount=<N>). --dry: мета-блок и SQL без
подключения; --verbose — тот же блок при прогоне.

Ключи env-файла (окружение процесса не читается): pg_<N>, PG_PORT
(5432), PG_DB_NAME (wb), PG_MY_USER_NAME/PG_MAIN_USER_NAME и пароли
PG_MY_USER_PASSWORD/PG_MAIN_USER_PASSWORD; для dev — DEV_PG_HOST,
DEV_PG_PORT (5434), DEV_PG_DB (mp_sl_1_dev), DEV_PG_USER,
DEV_PG_PASSWORD.

Exit: 0 — успех, включая --dry и запрос без набора строк; 1 — ошибка
БД; 2 — ошибка ввода, резолва и конфигурации.`,
  examples: [
    `mpu ask sql target: 42 sql: "UPDATE orders SET status = 'done' WHERE id = 7"`,
    "mpu ask sql target: sl-1 --dry",
  ],
  keys: { target: "selector", sql: "sql" },
  retired: { server: "target" },
  policy: "rw",
  argsSchema,
  formats: { md: ["--md"] },
  forms: {
    selector: { positional: "one" },
    sql: { positional: "one" },
    verbose: { short: "v" },
  },
  resultSchema,
  run: (args, io: SqlIo) => runSql(args, io, { mode: "write" }),
  render: (result, args) =>
    result.outcome === null
      ? ""
      : renderOutcome(result.outcome, formatOf(args)),
});
