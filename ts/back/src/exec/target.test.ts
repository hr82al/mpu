/**
 * Выбор транспорта (`platform/exec-transport.md`, «Выбор транспорта для
 * сервера N»). Тексты отказов сверяются с эталонами канала, префикс
 * `mpu ssh:` добавляет форматирование ошибки вызвавшей команды — сам
 * транспорт имени команды не знает (спека, «Известные отклонения»).
 */

import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { readFile } from "node:fs/promises";
import { formatCommandError, UsageError } from "@mpu/command";
import type { CacheReader } from "@mpu/command/selector";
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
      return [
        {
          portainer_url: BASE,
          endpoint_id: 4,
          endpoint_name: "farm",
          container_name: "mp-sl-1-cli",
        },
      ];
    }
    return params[0] === 1 ? [{ portainer_url: BASE, endpoint_id: 4 }] : [];
  },
};

function envOf(values: Readonly<Record<string, string>>) {
  return { get: (name: string) => values[name] };
}

const SERVER: ExecPlace = { kind: "server", serverNumber: 1 };

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/exec-transport/${name}`, import.meta.url),
    "utf8",
  );
}

describe("--via: только ssh и portainer", () => {
  it("значение вне списка — ошибка ввода эталона канала", async () => {
    const err = thrown(() => {
      viaOf("portainerr");
    }, UsageError);
    expect(`${formatCommandError("ssh", err)}\n`).toStrictEqual(
      await golden("err-via-stderr.txt"),
    );
  });

  it("допустимые значения проходят", () => {
    expect(viaOf("ssh")).toBe("ssh");
    expect(viaOf("portainer")).toBe("portainer");
    expect(viaOf(undefined)).toStrictEqual(undefined);
    // Пустое значение — тоже «вне списка»: `--via ""` осмысленного
    // умолчания не имеет.
    expect(() => viaOf("")).toThrow(UsageError);
    expect(() => viaOf("")).toThrow("получено ''");
  });
});

describe("сервер: доступность транспортов решает env и кэш", () => {
  const ssh = { sl_1: "10.0.0.1", PG_MY_USER_NAME: "u" };
  const portainer = { PORTAINER_API_KEY: API_KEY };

  it("доступны оба — Portainer", () => {
    expect(
      chooseTransport({
        place: SERVER,
        env: envOf({ ...ssh, ...portainer }),
        cache: cacheOfServer(1),
      }),
    ).toStrictEqual({
      kind: "portainer",
      access: { baseUrl: BASE, apiKey: API_KEY, verifyTls: false },
      endpointId: 4,
      container: "sl-1-cli",
    });
  });

  it("только ssh", () => {
    expect(
      chooseTransport({
        place: SERVER,
        env: envOf(ssh),
        cache: cacheOfServer(1),
      }),
    ).toStrictEqual({
      kind: "ssh",
      host: "10.0.0.1",
      user: "u",
      container: "sl-1-cli",
    });
  });

  it("только Portainer", () => {
    const target = chooseTransport({
      place: SERVER,
      env: envOf(portainer),
      cache: cacheOfServer(1),
    });
    expect(target.kind).toBe("portainer");
  });

  it("ни одного — отказ эталона канала", async () => {
    const err = thrown(() => {
      chooseTransport({
        place: { kind: "server", serverNumber: 99 },
        env: envOf({}),
        cache: EMPTY_CACHE,
      });
    }, UsageError);
    expect(`${formatCommandError("ssh", err)}\n`).toStrictEqual(
      await golden("err-no-transport-stderr.txt"),
    );
  });

  it("ключ Portainer без таргета — Portainer недоступен", () => {
    expect(() =>
      chooseTransport({
        place: SERVER,
        env: envOf(portainer),
        cache: EMPTY_CACHE,
      }),
    ).toThrow(UsageError);
  });

  it("ssh-адрес без имени пользователя — ssh недоступен", () => {
    expect(() =>
      chooseTransport({
        place: SERVER,
        env: envOf({ sl_1: "10.0.0.1" }),
        cache: EMPTY_CACHE,
      }),
    ).toThrow(UsageError);
  });
});

describe("имя контейнера серверного таргета — из кэша", () => {
  it("вторая форма в кэше — оба транспорта зовут её", () => {
    const portainer = chooseTransport({
      place: SERVER,
      env: envOf({ PORTAINER_API_KEY: API_KEY }),
      cache: CACHE_MP_NAME,
    });
    expect(portainer.container).toBe("mp-sl-1-cli");
    const ssh = chooseTransport({
      place: SERVER,
      env: envOf({ sl_1: "10.0.0.1", PG_MY_USER_NAME: "u" }),
      cache: CACHE_MP_NAME,
    });
    expect(ssh.container).toBe("mp-sl-1-cli");
  });

  it("dev-нода кэша не спрашивает: у неё вторая форма", () => {
    const target = chooseTransport({
      place: { kind: "dev", serverNumber: 1 },
      env: envOf({}),
      cache: cacheOfServer(1),
    });
    expect(target.container).toBe("mp-sl-1-cli");
  });
});

describe("env-fallback sl_<N>_portainer", () => {
  const withKey = (value: string) =>
    envOf({ PORTAINER_API_KEY: API_KEY, sl_1_portainer: value });

  it("база и endpoint из значения", () => {
    expect(
      chooseTransport({
        place: SERVER,
        env: withKey(`${BASE}/7`),
        cache: EMPTY_CACHE,
      }),
    ).toStrictEqual({
      kind: "portainer",
      access: { baseUrl: BASE, apiKey: API_KEY, verifyTls: false },
      endpointId: 7,
      container: "sl-1-cli",
    });
  });

  it("битое значение — таргета нет", () => {
    // `Number` принял бы `1e3`, `0x4`, ` 7` и пустой хвост — правило
    // спеки строже, и такое же в `@mpu/cmd-logs` (`src/snapshot.ts`).
    for (const broken of [
      `${BASE}/abc`,
      "no-slash",
      "/4",
      `${BASE}/`,
      `${BASE}/1e3`,
      `${BASE}/0x4`,
      `${BASE}/ 7`,
      `${BASE}/-1`,
    ]) {
      expect(() =>
        chooseTransport({
          place: SERVER,
          env: withKey(broken),
          cache: EMPTY_CACHE,
        }),
      ).toThrow(UsageError);
      expect(() =>
        chooseTransport({
          place: SERVER,
          env: withKey(broken),
          cache: EMPTY_CACHE,
        }),
      ).toThrow("не задано ни");
    }
  });

  it("строка кэша старше fallback'а", () => {
    const target = chooseTransport({
      place: SERVER,
      env: withKey(`${BASE}/7`),
      cache: cacheOfServer(1),
    });
    expect(target.kind === "portainer" ? target.endpointId : 0).toBe(4);
  });
});

describe("--via без соответствующего доступа — текст про него", () => {
  const cases: readonly [string, Via, Record<string, string>, string][] = [
    [
      "ssh не настроен",
      "ssh",
      { PORTAINER_API_KEY: API_KEY },
      "ssh: для sl-1 не задан ssh-доступ (sl_1 + PG_MY_USER_NAME)",
    ],
    [
      "Portainer не настроен",
      "portainer",
      { sl_1: "10.0.0.1", PG_MY_USER_NAME: "u" },
      "portainer: для sl-1 не задан Portainer" +
        " (sl_1_portainer + PORTAINER_API_KEY)",
    ],
  ];
  for (const [title, via, env, message] of cases) {
    it(title, () => {
      const err = thrown(() => {
        chooseTransport({
          place: SERVER,
          env: envOf(env),
          cache: cacheOfServer(1),
          via,
        });
      }, UsageError);
      // Общий текст «не задано ни … ни …» тут врал бы: второй транспорт
      // как раз задан (спека, «CLI-контракт»).
      expect(err.message).toStrictEqual(message);
    });
  }
});

describe("override транспорта", () => {
  const both = envOf({
    sl_1: "10.0.0.1",
    PG_MY_USER_NAME: "u",
    PORTAINER_API_KEY: API_KEY,
  });

  it("--via ssh уводит с Portainer'а", () => {
    expect(
      chooseTransport({
        place: SERVER,
        env: both,
        cache: cacheOfServer(1),
        via: "ssh",
      }).kind,
    ).toBe("ssh");
  });

  it("--via portainer — Portainer", () => {
    expect(
      chooseTransport({
        place: SERVER,
        env: both,
        cache: cacheOfServer(1),
        via: "portainer",
      }).kind,
    ).toBe("portainer");
  });
});

describe("dev-нода: всегда ssh, override не участвует", () => {
  it("встроенные дефолты хоста и пользователя", () => {
    expect(
      chooseTransport({
        place: { kind: "dev", serverNumber: 1 },
        env: envOf({ PORTAINER_API_KEY: API_KEY }),
        cache: cacheOfServer(1),
        via: "portainer",
      }),
    ).toStrictEqual({
      kind: "ssh",
      host: "192.168.150.8",
      user: "develop",
      container: "mp-sl-1-cli",
    });
  });

  it("env-значение старше дефолта", () => {
    expect(
      chooseTransport({
        place: { kind: "dev", serverNumber: 3 },
        env: envOf({ DEV_NODE_HOST: "10.1.1.1", DEV_NODE_USER: "dev" }),
        cache: EMPTY_CACHE,
      }),
    ).toStrictEqual({
      kind: "ssh",
      host: "10.1.1.1",
      user: "dev",
      container: "mp-sl-3-cli",
    });
  });
});

describe("контейнер по точному имени — только Portainer", () => {
  const place: ExecPlace = {
    kind: "container",
    location: {
      portainerUrl: BASE,
      endpointId: 4,
      endpointName: "farm-a",
      containerName: "mp-dt-cli",
    },
  };

  it("ssh-пути нет даже при полной ssh-конфигурации", () => {
    expect(
      chooseTransport({
        place,
        env: envOf({
          sl_1: "10.0.0.1",
          PG_MY_USER_NAME: "u",
          PORTAINER_API_KEY: API_KEY,
        }),
        cache: EMPTY_CACHE,
      }),
    ).toStrictEqual({
      kind: "portainer",
      access: { baseUrl: BASE, apiKey: API_KEY, verifyTls: false },
      endpointId: 4,
      container: "mp-dt-cli",
    });
  });

  it("--via ssh — отказ, --via portainer — no-op", () => {
    expect(() =>
      chooseTransport({
        place,
        env: envOf({ PORTAINER_API_KEY: API_KEY }),
        cache: EMPTY_CACHE,
        via: "ssh",
      }),
    ).toThrow(UsageError);
    expect(() =>
      chooseTransport({
        place,
        env: envOf({ PORTAINER_API_KEY: API_KEY }),
        cache: EMPTY_CACHE,
        via: "ssh",
      }),
    ).toThrow("ssh не поддерживается для контейнера по имени; только для sl-N");
    expect(
      chooseTransport({
        place,
        env: envOf({ PORTAINER_API_KEY: API_KEY }),
        cache: EMPTY_CACHE,
        via: "portainer",
      }).kind,
    ).toBe("portainer");
  });

  it("без ключа Portainer — отказ конфигурации", () => {
    expect(() =>
      chooseTransport({ place, env: envOf({}), cache: EMPTY_CACHE }),
    ).toThrow(UsageError);
    expect(() =>
      chooseTransport({ place, env: envOf({}), cache: EMPTY_CACHE }),
    ).toThrow("PORTAINER_API_KEY не задан в ~/.config/mpu/.env");
  });
});

describe("проверка TLS включается только значением true", () => {
  const cases: readonly [string | undefined, boolean][] = [
    [undefined, false],
    ["true", true],
    ["TRUE", true],
    ["1", false],
    ["false", false],
  ];
  for (const [raw, expected] of cases) {
    it(`PORTAINER_VERIFY_TLS=${raw}`, () => {
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
      expect(
        target.kind === "portainer" ? target.access.verifyTls : null,
      ).toStrictEqual(expected);
    });
  }
});
