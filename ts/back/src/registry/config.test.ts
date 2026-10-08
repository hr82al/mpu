/**
 * Список ключей `mpu config` (`platform/config.md`), собранный реестром
 * из объявлений доменов, против голдена канала и спеки. Ключи объявляют
 * их потребители (`@mpu/cmd-sheet`, `@mpu/cmd-xlsx`, `@mpu/cmd-task`),
 * механику команды проверяет пакет `@mpu/command` над своей фикстурой;
 * собранный список — только здесь.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { configCommand } from "@mpu/command/config";
import { makeFakeIo } from "@mpu/command/testing";
import { CONFIG_REGISTRY } from "./mod.ts";

/** `HOME` порта команды на стенде (`platform/config.md`, «Стенд»). */
const H = "/home/стенд";

/** Запись списка `end json`: ключ, умолчание (`null` — нет), описание. */
interface ListedKey {
  readonly key: string;
  readonly default: string | null;
  readonly description: string;
}

/** Пять записей голдена рабочей версии `fixtures/config/list-json.stdout`. */
async function goldenKeys(): Promise<readonly ListedKey[]> {
  const text = await readFile(
    new URL(
      "../../../docs/specs/fixtures/config/list-json.stdout",
      import.meta.url,
    ),
    "utf8",
  );
  return JSON.parse(text) as readonly ListedKey[];
}

it("умолчания реестра совпадают с теми, что применяют потребители", async () => {
  // Реестр показывает оператору, что действует без записи, а
  // применяют значения домены. Умолчание ключа домен строит из той же
  // константы, что применяет (`sheet.cache.*` — из `DEFAULTS`
  // `@mpu/cmd-sheet`), поэтому здесь сверяется собранный список с тем,
  // что показывает рабочая версия: разойдясь, они сделали бы
  // `mpu config` красивой ложью. Умолчание берётся из вывода команды
  // (`end json`, поле `default`) — тем, что видит оператор.
  const io = makeFakeIo({
    env: (name) => (name === "HOME" ? H : undefined),
  });
  const listed = (await configCommand(CONFIG_REGISTRY).invokeInput({}, io)) as {
    readonly entries: readonly ListedKey[];
  };
  const fallback = (key: string) =>
    listed.entries.find((entry) => entry.key === key)?.default;
  // У целей команд (`sheet.default`, `xlsx.default`) умолчания нет
  // вовсе: `null` — ключ в реестре есть, умолчания нет; пропавший ключ
  // дал бы `undefined`.
  for (const golden of await goldenKeys()) {
    expect(fallback(golden.key), golden.key).toStrictEqual(golden.default);
  }
});

it("реестр: семь ключей по порядку спеки, task.max_busy последним", async () => {
  // Каждое объявление целиком — то, что человек видит в
  // `mpu config end json`, и то, как команда проверяет значение: пять —
  // голден рабочей версии (умолчание и описание; тип — `platform/config.md`,
  // «CLI-контракт»), два ключа mpu — дословно из спек (`task.md`,
  // `task-orchestrator.md`). Умолчание — при `HOME` стенда.
  const types: Readonly<Record<string, string>> = {
    "sheet.default": "str",
    "xlsx.default": "str",
    "sheet.cache.tab_ttl": "int",
    "sheet.cache.max_tab_bytes": "int",
    "sheet.cache.max_total_mb": "int",
  };
  const expected = [
    ...(await goldenKeys()).map((golden) => ({
      key: golden.key,
      type: types[golden.key],
      default: golden.default,
      description: golden.description,
    })),
    {
      key: "task.history",
      type: "int",
      default: "3",
      description:
        "Глубина журнала `mpu task` в порциях: 0 — только текущая, -1 — не чистить",
    },
    {
      key: "task.max_busy",
      type: "int",
      default: "4",
      description:
        "Предел одновременно занятых ролей оркестратора `mpu-task` по всем проектам",
    },
  ];
  expect(
    CONFIG_REGISTRY.entries.map((entry) => ({
      key: entry.key,
      type: entry.type,
      default: entry.fallback(H) ?? null,
      description: entry.description,
    })),
  ).toStrictEqual(expected);
});
