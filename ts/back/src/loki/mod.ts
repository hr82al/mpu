/**
 * Запись итога discovery Loki в кэш-БД команд
 * (`docs/specs/platform/loki-http.md`, «Инварианты»; таблицы —
 * `platform/store.md`). Разговор с Loki (series, `query_range`, доступ) —
 * библиотека `@mpu/loki` (`docs/specs/platform/tslibs-ops.md`); здесь —
 * только запись собранного в таблицы `loki_hosts`/`loki_services_by_host`.
 *
 * Потребители — команды `init` (шаг 3) и `update`, тестовый Loki строк
 * `logs` (`logs/testloki.ts`).
 */

import type { LokiSeries } from "@mpu/loki";
import type { CacheDb } from "../command/mod.ts";

/**
 * Полная перезапись обеих таблиц (`loki_hosts`, `loki_services_by_host`)
 * одной транзакцией; `discoveredAt` — unix-секунды. DELETE и вставки —
 * внутри одного `db.transaction`, поэтому сбой посреди записи откатывает
 * всё целиком: инвариант спеки «обе таблицы либо перезаписаны целиком,
 * либо не тронуты» (`loki-http.md`, «Инварианты») не допускает половинки
 * в виде пустых таблиц после упавшей вставки.
 */
export function writeLokiCache(
  db: CacheDb,
  series: LokiSeries,
  discoveredAt: number,
): void {
  db.transaction(() => {
    db.execute("DELETE FROM loki_hosts");
    for (const host of series.hosts) {
      db.execute(
        "INSERT INTO loki_hosts (host, discovered_at) VALUES (?, ?)",
        host,
        discoveredAt,
      );
    }
    db.execute("DELETE FROM loki_services_by_host");
    for (const pair of series.pairs) {
      db.execute(
        "INSERT INTO loki_services_by_host (host, service, discovered_at) VALUES (?, ?, ?)",
        pair.host,
        pair.service,
        discoveredAt,
      );
    }
  });
}
