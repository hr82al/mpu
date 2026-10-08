/**
 * Команда `mpu config` (`platform/config.md`) против потребителей её
 * умолчаний вне пакета `@mpu/command`: реестр ключей лежит в пакете, а
 * применяет значения `sheet`, которого пакет не видит. Умолчание берётся
 * из вывода команды (`end json`, поле `default`) — тем, что видит
 * оператор. Остальные случаи команды — в тестах пакета.
 */

import { expect, it } from "vitest";
import { configCommand } from "@mpu/command/config";
import { makeFakeIo } from "@mpu/command/testing";
import { DEFAULTS } from "../sheet/settings.ts";

/** `HOME` порта команды на стенде (`platform/config.md`, «Стенд»). */
const H = "/home/стенд";

/** Строка списка `end json`: ключ и его умолчание (`null` — нет). */
interface ListedKey {
  readonly key: string;
  readonly default: string | null;
}

it("умолчания реестра совпадают с теми, что применяют потребители", async () => {
  // Реестр показывает оператору, что действует без записи, а
  // применяют значения другие модули. Разойдясь, они сделали бы
  // `mpu config` красивой ложью: печатает одно, работает другое.
  // image.dir появится здесь с первым потребителем (`image sync`).
  const io = makeFakeIo({
    env: (name) => (name === "HOME" ? H : undefined),
  });
  // Форма результата закреплена схемой команды и голденом
  // `list-json.stdout` в тестах пакета; здесь берутся два её поля.
  const listed = (await configCommand.invokeInput({}, io)) as {
    readonly entries: readonly ListedKey[];
  };
  const fallback = (key: string) =>
    listed.entries.find((entry) => entry.key === key)?.default;
  expect(fallback("sheet.cache.tab_ttl")).toStrictEqual(
    String(DEFAULTS.tabTtlSeconds),
  );
  expect(fallback("sheet.cache.max_tab_bytes")).toStrictEqual(
    String(DEFAULTS.maxTabBytes),
  );
  expect(fallback("sheet.cache.max_total_mb")).toStrictEqual(
    String(DEFAULTS.maxTotalMb),
  );
  // У целей команд умолчания нет вовсе: не задано — значит не задано.
  // `null` — ключ в реестре есть, умолчания нет; пропавший ключ дал бы
  // `undefined`.
  expect(fallback("sheet.default")).toStrictEqual(null);
  expect(fallback("xlsx.default")).toStrictEqual(null);
});
