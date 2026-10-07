/**
 * Чтения таблицы контейнеров кэш-БД (`platform/exec-transport.md`, «Кэш
 * контейнеров»). БД настоящая, во временном каталоге: проверяется в том
 * числе SQL (DISTINCT, LIKE, порядок), а его подставной кэш не проверил
 * бы (как в `../selector/resolve_test.ts`).
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheDb } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { heldScope } from "../testing/scope.ts";
import {
  containerLocations,
  containerNamesLike,
  instanceServerNumbers,
  serverCliContainer,
  serverLocation,
} from "./containers.ts";

const URL_A = "https://portainer.example";
const URL_B = "https://portainer-b.example";

interface Row {
  readonly url?: string;
  readonly endpointId?: number;
  readonly endpointName?: string | null;
  readonly containerId?: string;
  readonly name: string;
  readonly serverNumber?: number | null;
}

function fill(db: CacheDb, rows: readonly Row[]): void {
  db.bootstrap();
  for (const [index, row] of rows.entries()) {
    db.execute(
      "INSERT INTO portainer_containers (portainer_url, endpoint_id," +
        " endpoint_name, container_id, container_name, server_number," +
        " state, image, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.url ?? URL_A,
      row.endpointId ?? 1,
      row.endpointName === undefined ? "farm-a" : row.endpointName,
      row.containerId ?? `id-${index}`,
      row.name,
      row.serverNumber ?? null,
      "running",
      "registry.example/mp-sl:latest",
      1_700_000_000,
    );
  }
}

async function withCache(
  rows: readonly Row[] | undefined,
  body: (db: CacheDb) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    if (rows !== undefined) fill(db, rows);
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

it("Portainer-таргет сервера — по номеру из кэша", async () => {
  await withCache([
    { name: "/mp-sl-1-cli", serverNumber: 1 },
    { name: "/mp-sl-2-cli", serverNumber: 2, endpointId: 4, url: URL_B },
  ], (db) => {
    expect(serverLocation(db, 2)).toStrictEqual({
      portainerUrl: URL_B,
      endpointId: 4,
    });
    expect(serverLocation(db, 9)).toStrictEqual(null);
  });
});

describe("контейнер по точному имени", () => {
  const db = heldScope<CacheDb>((body) =>
    withCache([
      { name: "mp-dt-cli", containerId: "a" },
      // Реплики одного сервиса на одном endpoint'е — не неоднозначность:
      // их схлопывает DISTINCT (спека).
      { name: "wb-loader", containerId: "b" },
      { name: "wb-loader", containerId: "c" },
      { name: "twin", containerId: "d" },
      {
        name: "twin",
        containerId: "e",
        endpointId: 4,
        endpointName: "farm-b",
        url: URL_B,
      },
    ], body)
  );
  it("единственный", () => {
    expect(containerLocations(db(), "mp-dt-cli")).toStrictEqual([{
      portainerUrl: URL_A,
      endpointId: 1,
      endpointName: "farm-a",
      containerName: "mp-dt-cli",
    }]);
  });

  it("реплики схлопываются", () => {
    expect(containerLocations(db(), "wb-loader").length).toBe(1);
  });

  it("одно имя на разных endpoint'ах — два кандидата", () => {
    expect(containerLocations(db(), "twin").length).toBe(2);
  });

  it("нет такого", () => {
    expect(containerLocations(db(), "нет-такого")).toStrictEqual([]);
  });
});

it("имена по подстроке: по возрастанию, без повторов", async () => {
  await withCache([
    { name: "wb-loader-2", containerId: "a" },
    { name: "wb-loader-1", containerId: "b" },
    { name: "wb-loader-1", containerId: "c", endpointId: 4 },
    { name: "mp-dt-cli", containerId: "d" },
  ], (db) => {
    expect(containerNamesLike(db, "wb-loader")).toStrictEqual([
      "wb-loader-1",
      "wb-loader-2",
    ]);
    expect(containerNamesLike(db, "zzz-no-such")).toStrictEqual([]);
  });
});

it("порча кэша: нечисловой endpoint_id — отказ, не догадка", () => {
  const cache = {
    query: () => [{ portainer_url: URL_A, endpoint_id: "четыре" }],
  };
  expect(() => serverLocation(cache, 1)).toThrow(TypeError);
  expect(() => serverLocation(cache, 1)).toThrow("endpoint_id");
});

it("endpoint_name допускает NULL — пустая строка в кандидате", async () => {
  await withCache(
    [{ name: "mp-dt-cli", endpointName: null }],
    (db) => {
      expect(containerLocations(db, "mp-dt-cli")[0].endpointName).toBe("");
    },
  );
});

it("неинициализированная кэш-БД — пустой результат, не отказ", async () => {
  await withCache(undefined, (db) => {
    expect(serverLocation(db, 1)).toStrictEqual(null);
    expect(containerLocations(db, "mp-dt-cli")).toStrictEqual([]);
    expect(containerNamesLike(db, "wb")).toStrictEqual([]);
  });
});

describe("подстрока — это подстрока: спецсимволы образца не шаблон", () => {
  const db = heldScope<CacheDb>((body) =>
    withCache([
      { name: "wb-loader", containerId: "a" },
      { name: "wb_loader", containerId: "b" },
      { name: "sl-1-cli", containerId: "c" },
      { name: "sl%cli", containerId: "d" },
      { name: "backslash\\name", containerId: "e" },
    ], body)
  );
  // `_` и `%` в фильтре — символы имени, а не шаблон: иначе fan-out
  // живых прод-команд заходил бы в чужой контейнер (спека, `fix`).
  it("подчёркивание не значит «любой символ»", () => {
    expect(containerNamesLike(db(), "wb_loader")).toStrictEqual(["wb_loader"]);
  });

  it("процент не значит «что угодно»", () => {
    expect(containerNamesLike(db(), "sl%cli")).toStrictEqual(["sl%cli"]);
  });

  it("обратная косая — тоже символ имени", () => {
    expect(containerNamesLike(db(), "backslash\\")).toStrictEqual([
      "backslash\\name",
    ]);
  });

  it("обычная подстрока по-прежнему ловит всё своё", () => {
    expect(containerNamesLike(db(), "loader")).toStrictEqual([
      "wb-loader",
      "wb_loader",
    ]);
  });
});

it("номера инстанс-серверов: без нуля и NULL, по возрастанию", async () => {
  await withCache([
    { name: "mp-sl-2-cli", serverNumber: 2 },
    { name: "mp-sl-0-cli", serverNumber: 0 },
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-1-api", serverNumber: 1 },
    { name: "mp-dt-cli" },
  ], (db) => {
    // Main-сервер в fan-out не входит намеренно (спека `run-js`,
    // отклонение `preserve`), контейнеры без номера — тем более.
    expect(instanceServerNumbers(db)).toStrictEqual([1, 2]);
  });
});

describe("имя cli-контейнера сервера — из кэша, не зашито", () => {
  it("в кэше форма `sl-<N>-cli` — она и берётся", async () => {
    await withCache([{ name: "sl-9-cli", serverNumber: 9 }], (db) => {
      expect(serverCliContainer(db, 9)).toBe("sl-9-cli");
    });
  });

  it("в кэше только `mp-sl-<N>-cli` — берётся она", async () => {
    await withCache([{ name: "mp-sl-9-cli", serverNumber: 9 }], (db) => {
      expect(serverCliContainer(db, 9)).toBe("mp-sl-9-cli");
    });
  });

  it("есть обе формы — побеждает первая", async () => {
    await withCache([
      { name: "mp-sl-9-cli", serverNumber: 9 },
      { name: "sl-9-cli", serverNumber: 9, containerId: "id-b" },
    ], (db) => {
      expect(serverCliContainer(db, 9)).toBe("sl-9-cli");
    });
  });

  it("кэш пуст — первая форма", async () => {
    await withCache([], (db) => {
      expect(serverCliContainer(db, 9)).toBe("sl-9-cli");
    });
  });

  it("контейнер чужого сервера именем не подходит", async () => {
    await withCache([{ name: "sl-8-cli", serverNumber: 8 }], (db) => {
      expect(serverCliContainer(db, 9)).toBe("sl-9-cli");
    });
  });
});
