/**
 * Чтения таблицы контейнеров кэш-БД (`platform/exec-transport.md`, «Кэш
 * контейнеров»). БД настоящая, во временном каталоге: проверяется в том
 * числе SQL (DISTINCT, LIKE, порядок), а его подставной кэш не проверил
 * бы (как в `../selector/resolve_test.ts`).
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { CacheDb } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  containerLocations,
  containerNamesLike,
  instanceServerNumbers,
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
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    if (rows !== undefined) fill(db, rows);
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Portainer-таргет сервера — по номеру из кэша", async () => {
  await withCache([
    { name: "/mp-sl-1-cli", serverNumber: 1 },
    { name: "/mp-sl-2-cli", serverNumber: 2, endpointId: 4, url: URL_B },
  ], (db) => {
    assertEquals(serverLocation(db, 2), {
      portainerUrl: URL_B,
      endpointId: 4,
    });
    assertEquals(serverLocation(db, 9), null);
  });
});

Deno.test("контейнер по точному имени", async (t) => {
  await withCache([
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
  ], async (db) => {
    await t.step("единственный", () => {
      assertEquals(containerLocations(db, "mp-dt-cli"), [{
        portainerUrl: URL_A,
        endpointId: 1,
        endpointName: "farm-a",
        containerName: "mp-dt-cli",
      }]);
    });

    await t.step("реплики схлопываются", () => {
      assertEquals(containerLocations(db, "wb-loader").length, 1);
    });

    await t.step("одно имя на разных endpoint'ах — два кандидата", () => {
      assertEquals(containerLocations(db, "twin").length, 2);
    });

    await t.step("нет такого", () => {
      assertEquals(containerLocations(db, "нет-такого"), []);
    });
  });
});

Deno.test("имена по подстроке: по возрастанию, без повторов", async () => {
  await withCache([
    { name: "wb-loader-2", containerId: "a" },
    { name: "wb-loader-1", containerId: "b" },
    { name: "wb-loader-1", containerId: "c", endpointId: 4 },
    { name: "mp-dt-cli", containerId: "d" },
  ], (db) => {
    assertEquals(containerNamesLike(db, "wb-loader"), [
      "wb-loader-1",
      "wb-loader-2",
    ]);
    assertEquals(containerNamesLike(db, "zzz-no-such"), []);
  });
});

Deno.test("порча кэша: нечисловой endpoint_id — отказ, не догадка", () => {
  const cache = {
    query: () => [{ portainer_url: URL_A, endpoint_id: "четыре" }],
  };
  assertThrows(() => serverLocation(cache, 1), TypeError, "endpoint_id");
});

Deno.test("endpoint_name допускает NULL — пустая строка в кандидате", async () => {
  await withCache(
    [{ name: "mp-dt-cli", endpointName: null }],
    (db) => {
      assertEquals(containerLocations(db, "mp-dt-cli")[0].endpointName, "");
    },
  );
});

Deno.test("неинициализированная кэш-БД — пустой результат, не отказ", async () => {
  await withCache(undefined, (db) => {
    assertEquals(serverLocation(db, 1), null);
    assertEquals(containerLocations(db, "mp-dt-cli"), []);
    assertEquals(containerNamesLike(db, "wb"), []);
  });
});

Deno.test("подстрока — это подстрока: спецсимволы образца не шаблон", async (t) => {
  await withCache([
    { name: "wb-loader", containerId: "a" },
    { name: "wb_loader", containerId: "b" },
    { name: "sl-1-cli", containerId: "c" },
    { name: "sl%cli", containerId: "d" },
    { name: "backslash\\name", containerId: "e" },
  ], async (db) => {
    // `_` и `%` в фильтре — символы имени, а не шаблон: иначе fan-out
    // живых прод-команд заходил бы в чужой контейнер (спека, `fix`).
    await t.step("подчёркивание не значит «любой символ»", () => {
      assertEquals(containerNamesLike(db, "wb_loader"), ["wb_loader"]);
    });

    await t.step("процент не значит «что угодно»", () => {
      assertEquals(containerNamesLike(db, "sl%cli"), ["sl%cli"]);
    });

    await t.step("обратная косая — тоже символ имени", () => {
      assertEquals(containerNamesLike(db, "backslash\\"), ["backslash\\name"]);
    });

    await t.step("обычная подстрока по-прежнему ловит всё своё", () => {
      assertEquals(containerNamesLike(db, "loader"), [
        "wb-loader",
        "wb_loader",
      ]);
    });
  });
});

Deno.test("номера инстанс-серверов: без нуля и NULL, по возрастанию", async () => {
  await withCache([
    { name: "mp-sl-2-cli", serverNumber: 2 },
    { name: "mp-sl-0-cli", serverNumber: 0 },
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-1-api", serverNumber: 1 },
    { name: "mp-dt-cli" },
  ], (db) => {
    // Main-сервер в fan-out не входит намеренно (спека `run-js`,
    // отклонение `preserve`), контейнеры без номера — тем более.
    assertEquals(instanceServerNumbers(db), [1, 2]);
  });
});
