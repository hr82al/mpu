/**
 * Выбор транспорта (`platform/exec-transport.md`, «Выбор транспорта для
 * сервера N»). Тексты отказов сверяются с эталонами канала, префикс
 * `mpu ssh:` добавляет форматирование ошибки вызвавшей команды — сам
 * транспорт имени команды не знает (спека, «Известные отклонения»).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { formatCommandError, UsageError } from "../command/mod.ts";
import type { CacheReader } from "../selector/mod.ts";
import { chooseTransport, type ExecPlace, type Via, viaOf } from "./target.ts";

const API_KEY = "portainer-key";
const BASE = "https://portainer.example";

/** Кэш без единой строки: путь env-fallback'а. */
const EMPTY_CACHE: CacheReader = { query: () => [] };

/**
 * Кэш с одной строкой контейнера сервера N на endpoint'е 4. Первым идёт
 * запрос о наличии таблицы (`containers.ts`), и на него кэш отвечает
 * непустым — иначе выборка до самой строки не дойдёт. Имени контейнера в
 * этих строках нет: выборка по имени отвечает пустым, и таргет
 * называет первую форму — `sl-<N>-cli` (`containers.ts`,
 * `serverCliContainer`).
 */
function cacheOfServer(serverNumber: number): CacheReader {
  return {
    query: (sql, ...params) => {
      if (sql.includes("sqlite_master")) return [{ name: params[0] ?? null }];
      return params[0] === serverNumber
        ? [{ portainer_url: BASE, endpoint_id: 4 }]
        : [];
    },
  };
}

/**
 * Кэш, знающий имя cli-контейнера сервера 1 второй формой: имя таргета
 * обязано прийти оттуда, а не из зашитой строки (`platform/portainer.md`
 * — exec ходит в то, что печатает `--print`).
 */
const CACHE_MP_NAME: CacheReader = {
  query: (sql, ...params) => {
    if (sql.includes("sqlite_master")) return [{ name: params[0] ?? null }];
    if (params[0] === "mp-sl-1-cli") {
      return [{
        portainer_url: BASE,
        endpoint_id: 4,
        endpoint_name: "farm",
        container_name: "mp-sl-1-cli",
      }];
    }
    return params[0] === 1 ? [{ portainer_url: BASE, endpoint_id: 4 }] : [];
  },
};

function envOf(values: Readonly<Record<string, string>>) {
  return { get: (name: string) => values[name] };
}

const SERVER: ExecPlace = { kind: "server", serverNumber: 1 };

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/exec-transport/${name}`, import.meta.url),
  );
}

Deno.test("--via: только ssh и portainer", async (t) => {
  await t.step(
    "значение вне списка — ошибка ввода эталона канала",
    async () => {
      const err = assertThrows(() => viaOf("portainerr"), UsageError);
      assertEquals(
        `${formatCommandError("ssh", err)}\n`,
        await golden("err-via-stderr.txt"),
      );
    },
  );

  await t.step("допустимые значения проходят", () => {
    assertEquals(viaOf("ssh"), "ssh");
    assertEquals(viaOf("portainer"), "portainer");
    assertEquals(viaOf(undefined), undefined);
    // Пустое значение — тоже «вне списка»: `--via ""` осмысленного
    // умолчания не имеет.
    assertThrows(() => viaOf(""), UsageError, "получено ''");
  });
});

Deno.test("сервер: доступность транспортов решает env и кэш", async (t) => {
  const ssh = { sl_1: "10.0.0.1", PG_MY_USER_NAME: "u" };
  const portainer = { PORTAINER_API_KEY: API_KEY };

  await t.step("доступны оба — Portainer", () => {
    assertEquals(
      chooseTransport({
        place: SERVER,
        env: envOf({ ...ssh, ...portainer }),
        cache: cacheOfServer(1),
      }),
      {
        kind: "portainer",
        access: { baseUrl: BASE, apiKey: API_KEY, verifyTls: false },
        endpointId: 4,
        container: "sl-1-cli",
      },
    );
  });

  await t.step("только ssh", () => {
    assertEquals(
      chooseTransport({
        place: SERVER,
        env: envOf(ssh),
        cache: cacheOfServer(1),
      }),
      { kind: "ssh", host: "10.0.0.1", user: "u", container: "sl-1-cli" },
    );
  });

  await t.step("только Portainer", () => {
    const target = chooseTransport({
      place: SERVER,
      env: envOf(portainer),
      cache: cacheOfServer(1),
    });
    assertEquals(target.kind, "portainer");
  });

  await t.step("ни одного — отказ эталона канала", async () => {
    const err = assertThrows(
      () =>
        chooseTransport({
          place: { kind: "server", serverNumber: 99 },
          env: envOf({}),
          cache: EMPTY_CACHE,
        }),
      UsageError,
    );
    assertEquals(
      `${formatCommandError("ssh", err)}\n`,
      await golden("err-no-transport-stderr.txt"),
    );
  });

  await t.step("ключ Portainer без таргета — Portainer недоступен", () => {
    assertThrows(
      () =>
        chooseTransport({
          place: SERVER,
          env: envOf(portainer),
          cache: EMPTY_CACHE,
        }),
      UsageError,
    );
  });

  await t.step("ssh-адрес без имени пользователя — ssh недоступен", () => {
    assertThrows(
      () =>
        chooseTransport({
          place: SERVER,
          env: envOf({ sl_1: "10.0.0.1" }),
          cache: EMPTY_CACHE,
        }),
      UsageError,
    );
  });
});

Deno.test("имя контейнера серверного таргета — из кэша", async (t) => {
  await t.step("вторая форма в кэше — оба транспорта зовут её", () => {
    const portainer = chooseTransport({
      place: SERVER,
      env: envOf({ PORTAINER_API_KEY: API_KEY }),
      cache: CACHE_MP_NAME,
    });
    assertEquals(portainer.container, "mp-sl-1-cli");
    const ssh = chooseTransport({
      place: SERVER,
      env: envOf({ sl_1: "10.0.0.1", PG_MY_USER_NAME: "u" }),
      cache: CACHE_MP_NAME,
    });
    assertEquals(ssh.container, "mp-sl-1-cli");
  });

  await t.step("dev-нода кэша не спрашивает: у неё вторая форма", () => {
    const target = chooseTransport({
      place: { kind: "dev", serverNumber: 1 },
      env: envOf({}),
      cache: cacheOfServer(1),
    });
    assertEquals(target.container, "mp-sl-1-cli");
  });
});

Deno.test("env-fallback sl_<N>_portainer", async (t) => {
  const withKey = (value: string) =>
    envOf({ PORTAINER_API_KEY: API_KEY, sl_1_portainer: value });

  await t.step("база и endpoint из значения", () => {
    assertEquals(
      chooseTransport({
        place: SERVER,
        env: withKey(`${BASE}/7`),
        cache: EMPTY_CACHE,
      }),
      {
        kind: "portainer",
        access: { baseUrl: BASE, apiKey: API_KEY, verifyTls: false },
        endpointId: 7,
        container: "sl-1-cli",
      },
    );
  });

  await t.step("битое значение — таргета нет", () => {
    // `Number` принял бы `1e3`, `0x4`, ` 7` и пустой хвост — правило
    // спеки строже, и такое же в `../logs/snapshot.ts`.
    for (
      const broken of [
        `${BASE}/abc`,
        "no-slash",
        "/4",
        `${BASE}/`,
        `${BASE}/1e3`,
        `${BASE}/0x4`,
        `${BASE}/ 7`,
        `${BASE}/-1`,
      ]
    ) {
      assertThrows(
        () =>
          chooseTransport({
            place: SERVER,
            env: withKey(broken),
            cache: EMPTY_CACHE,
          }),
        UsageError,
        "не задано ни",
      );
    }
  });

  await t.step("строка кэша старше fallback'а", () => {
    const target = chooseTransport({
      place: SERVER,
      env: withKey(`${BASE}/7`),
      cache: cacheOfServer(1),
    });
    assertEquals(target.kind === "portainer" ? target.endpointId : 0, 4);
  });
});

Deno.test("--via без соответствующего доступа — текст про него", async (t) => {
  const cases: readonly [string, Via, Record<string, string>, string][] = [
    [
      "ssh не настроен",
      "ssh",
      { PORTAINER_API_KEY: API_KEY },
      "--via ssh: для sl-1 не задан ssh-доступ (sl_1 + PG_MY_USER_NAME)",
    ],
    [
      "Portainer не настроен",
      "portainer",
      { sl_1: "10.0.0.1", PG_MY_USER_NAME: "u" },
      "--via portainer: для sl-1 не задан Portainer" +
      " (sl_1_portainer + PORTAINER_API_KEY)",
    ],
  ];
  for (const [title, via, env, message] of cases) {
    await t.step(title, () => {
      const err = assertThrows(
        () =>
          chooseTransport({
            place: SERVER,
            env: envOf(env),
            cache: cacheOfServer(1),
            via,
          }),
        UsageError,
      );
      // Общий текст «не задано ни … ни …» тут врал бы: второй транспорт
      // как раз задан (спека, «CLI-контракт»).
      assertEquals(err.message, message);
    });
  }
});

Deno.test("override транспорта", async (t) => {
  const both = envOf({
    sl_1: "10.0.0.1",
    PG_MY_USER_NAME: "u",
    PORTAINER_API_KEY: API_KEY,
  });

  await t.step("--via ssh уводит с Portainer'а", () => {
    assertEquals(
      chooseTransport({
        place: SERVER,
        env: both,
        cache: cacheOfServer(1),
        via: "ssh",
      }).kind,
      "ssh",
    );
  });

  await t.step("--via portainer — Portainer", () => {
    assertEquals(
      chooseTransport({
        place: SERVER,
        env: both,
        cache: cacheOfServer(1),
        via: "portainer",
      }).kind,
      "portainer",
    );
  });
});

Deno.test("dev-нода: всегда ssh, override не участвует", async (t) => {
  await t.step("встроенные дефолты хоста и пользователя", () => {
    assertEquals(
      chooseTransport({
        place: { kind: "dev", serverNumber: 1 },
        env: envOf({ PORTAINER_API_KEY: API_KEY }),
        cache: cacheOfServer(1),
        via: "portainer",
      }),
      {
        kind: "ssh",
        host: "192.168.150.8",
        user: "develop",
        container: "mp-sl-1-cli",
      },
    );
  });

  await t.step("env-значение старше дефолта", () => {
    assertEquals(
      chooseTransport({
        place: { kind: "dev", serverNumber: 3 },
        env: envOf({ DEV_NODE_HOST: "10.1.1.1", DEV_NODE_USER: "dev" }),
        cache: EMPTY_CACHE,
      }),
      {
        kind: "ssh",
        host: "10.1.1.1",
        user: "dev",
        container: "mp-sl-3-cli",
      },
    );
  });
});

Deno.test("контейнер по точному имени — только Portainer", async (t) => {
  const place: ExecPlace = {
    kind: "container",
    location: {
      portainerUrl: BASE,
      endpointId: 4,
      endpointName: "farm-a",
      containerName: "mp-dt-cli",
    },
  };

  await t.step("ssh-пути нет даже при полной ssh-конфигурации", () => {
    assertEquals(
      chooseTransport({
        place,
        env: envOf({
          sl_1: "10.0.0.1",
          PG_MY_USER_NAME: "u",
          PORTAINER_API_KEY: API_KEY,
        }),
        cache: EMPTY_CACHE,
      }),
      {
        kind: "portainer",
        access: { baseUrl: BASE, apiKey: API_KEY, verifyTls: false },
        endpointId: 4,
        container: "mp-dt-cli",
      },
    );
  });

  await t.step("--via ssh — отказ, --via portainer — no-op", () => {
    assertThrows(
      () =>
        chooseTransport({
          place,
          env: envOf({ PORTAINER_API_KEY: API_KEY }),
          cache: EMPTY_CACHE,
          via: "ssh",
        }),
      UsageError,
      "--via ssh не поддерживается для контейнера по имени; только для sl-N",
    );
    assertEquals(
      chooseTransport({
        place,
        env: envOf({ PORTAINER_API_KEY: API_KEY }),
        cache: EMPTY_CACHE,
        via: "portainer",
      }).kind,
      "portainer",
    );
  });

  await t.step("без ключа Portainer — отказ конфигурации", () => {
    assertThrows(
      () => chooseTransport({ place, env: envOf({}), cache: EMPTY_CACHE }),
      UsageError,
      "PORTAINER_API_KEY не задан в ~/.config/mpu/.env",
    );
  });
});

Deno.test("проверка TLS включается только значением true", async (t) => {
  const cases: readonly [string | undefined, boolean][] = [
    [undefined, false],
    ["true", true],
    ["TRUE", true],
    ["1", false],
    ["false", false],
  ];
  for (const [raw, expected] of cases) {
    await t.step(`PORTAINER_VERIFY_TLS=${raw}`, () => {
      const env = envOf(
        raw === undefined
          ? { PORTAINER_API_KEY: API_KEY }
          : { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: raw },
      );
      const target = chooseTransport({
        place: SERVER,
        env,
        cache: cacheOfServer(1),
      });
      assertEquals(
        target.kind === "portainer" ? target.access.verifyTls : null,
        expected,
      );
    });
  }
});
