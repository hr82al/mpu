/**
 * Тесты драйвера PG (`pg.ts`) в той части, которой не нужен живой
 * PostgreSQL: чтение адреса и кред из env-файла. Их тексты попадают
 * пользователю в строку `warning: failed to query servers: …`
 * (`docs/specs/update.md`), поэтому закреплены дословно.
 *
 * Всё остальное в драйвере — разговор с сервером; его проверяет
 * `deno task smoke` запуском собранного бинаря на заведомо закрытый
 * адрес: там видно, что клиент вообще создаётся (у него хватает прав) и
 * что отказ приходит сетевой ошибкой.
 */

import { assertRejects } from "@std/assert";
import { makePgOpener, PgConfigError } from "./pg.ts";
import { DEFAULT_PG_LIMITS } from "./sync.ts";

const FULL: Readonly<Record<string, string>> = {
  pg_3: "10.0.0.3",
  PG_MAIN_USER_NAME: "proba",
  PG_MAIN_USER_PASSWORD: "proba",
};

Deno.test("конфигурация PG: чего не хватает, то и названо", async (t) => {
  const cases: readonly (readonly [
    string,
    Readonly<Record<string, string>>,
    string,
  ])[] = [
    [
      "нет адреса сервера",
      { ...FULL, pg_3: "" },
      "pg_3 не задан в env-файле",
    ],
    [
      "нет ни личного, ни общего имени",
      { ...FULL, PG_MAIN_USER_NAME: "" },
      "PG_MY_USER_NAME или PG_MAIN_USER_NAME не задан в env-файле",
    ],
    [
      "нет ни личного, ни общего пароля",
      { ...FULL, PG_MAIN_USER_PASSWORD: "" },
      "PG_MY_USER_PASSWORD или PG_MAIN_USER_PASSWORD не задан в env-файле",
    ],
    [
      "порт не число",
      { ...FULL, PG_PORT: "шесть тысяч" },
      "PG_PORT: ожидался номер порта, задано 'шесть тысяч'",
    ],
  ];
  for (const [name, values, message] of cases) {
    await t.step(name, async () => {
      const open = makePgOpener(
        { get: (key) => values[key] },
        DEFAULT_PG_LIMITS,
      );
      // Отказ приходит до всякой сети: адрес 10.0.0.3 в тестах
      // недостижим, и дойди дело до подключения — тест ждал бы таймаут.
      await assertRejects(
        () => open(3, { signal: new AbortController().signal }),
        PgConfigError,
        message,
      );
    });
  }
});
