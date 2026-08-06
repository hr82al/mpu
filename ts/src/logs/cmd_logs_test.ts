/**
 * Порядок веток и наблюдаемое поведение `mpu logs`
 * (`docs/specs/logs.md`): `ls`-режимы раньше всего, трактовка первого
 * аргумента как сервиса, разбор аргументов, разовый Loki-запрос,
 * слежение с курсором и legacy-снимок Portainer.
 *
 * Сети нет: оба источника подставляются портами (`sources.ts`), кэш-БД
 * настоящая во временном каталоге. Голденов на строки логов нет
 * намеренно — живая строка несёт данные клиента, поэтому форма печати
 * проверяется на синтетических записях.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openCacheDb } from "../store/mod.ts";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  type EnvFile,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { LogEntry, RangeQuery } from "../loki/mod.ts";
import { LokiError, LokiHttpError } from "../loki/mod.ts";
import type { ContainerLogsQuery, PortainerAccess } from "../portainer/mod.ts";
import { PortainerError } from "../portainer/mod.ts";
import { logsCommand } from "./mod.ts";
import {
  type LogsArgs,
  type LogsOptions,
  type LogsResult,
  runLogs,
} from "./cmd_logs.ts";
import type { LogStream } from "./sources.ts";

/** Момент «сейчас» всех тестов: часы подставляются, окно детерминировано. */
const NOW_MS = 1_754_380_800_000;
const NOW_NS = 1_754_380_800_000_000_000n;

const LOKI_URL = "http://loki.example.test";

function golden(name: string): Promise<string> {
  return Deno.readTextFile(new URL(`testdata/${name}`, import.meta.url));
}

/** Что положить в кэш-БД перед вызовом. */
interface Seed {
  readonly hosts?: readonly string[];
  readonly services?: readonly (readonly [string, string])[];
  readonly containers?: readonly {
    readonly url: string;
    readonly endpointId: number;
    readonly server: number;
  }[];
  readonly clients?: readonly {
    readonly id: number;
    readonly server: string;
  }[];
}

function fill(db: CacheDb, seed: Seed): void {
  for (const host of seed.hosts ?? []) {
    db.execute(
      "INSERT INTO loki_hosts (host, discovered_at) VALUES (?, 0)",
      host,
    );
  }
  for (const [host, service] of seed.services ?? []) {
    db.execute(
      "INSERT INTO loki_services_by_host (host, service, discovered_at)" +
        " VALUES (?, ?, 0)",
      host,
      service,
    );
  }
  for (const container of seed.containers ?? []) {
    db.execute(
      "INSERT INTO portainer_containers (portainer_url, endpoint_id," +
        " container_id, container_name, server_number, discovered_at)" +
        " VALUES (?, ?, ?, ?, ?, 0)",
      container.url,
      container.endpointId,
      `id-${container.server}`,
      `mp-sl-${container.server}-cli`,
      container.server,
    );
  }
  for (const client of seed.clients ?? []) {
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, 0)",
      client.id,
      client.server,
    );
  }
}

function envFileOf(values: Readonly<Record<string, string>>): EnvFile {
  return {
    get: (name) => values[name],
    values: () => ({ ...values }),
    require: () => {
      throw new Error("envFile.require не ожидается");
    },
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  };
}

/**
 * Временный стенд: кэш-БД с посевом и io поверх неё. `bootstrap`
 * вызывается только если посев задан — тест непроинициализированной БД
 * передаёт `undefined`.
 */
async function withStand(
  seed: Seed | undefined,
  env: Readonly<Record<string, string>>,
  body: (io: CommandIo) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/mpu.db`;
    if (seed !== undefined) {
      using db = openCacheDb(path);
      db.bootstrap();
      fill(db, seed);
    }
    await body(makeFakeIo({
      envFile: envFileOf(env),
      openCacheDb: () => openCacheDb(path),
    }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Аргументы вызова: всё, кроме названного, — умолчания схемы. */
function args(overrides: Partial<LogsArgs> = {}): LogsArgs {
  return {
    selector: undefined,
    service: undefined,
    via: "loki",
    tail: "200",
    since: undefined,
    timestamps: false,
    "no-stdout": false,
    "no-stderr": false,
    grep: [],
    "grep-regex": [],
    grep_regex: [],
    level: undefined,
    client: undefined,
    follow: false,
    ...overrides,
  };
}

/** Подставной Loki: помнит запросы, отвечает по правилу теста. */
function fakeLoki(
  reply: (query: RangeQuery) => readonly LogEntry[] | Error,
) {
  const asked: RangeQuery[] = [];
  return {
    asked,
    read: (_access: unknown, query: RangeQuery) => {
      asked.push(query);
      const answer = reply(query);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

/** Подставной поток печати. */
function fakeStream() {
  const out: string[] = [];
  const err: string[] = [];
  const stream: LogStream = {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  return { stream, out: () => out.join(""), err: () => err.join("") };
}

function entry(tsNs: string, line: string): LogEntry {
  return { tsNs, line };
}

/** Умолчания подмен: часы стоят, сети нет. */
function options(overrides: LogsOptions = {}): LogsOptions {
  return { now: () => NOW_MS, ...overrides };
}

/** Текст ошибки так, как его напечатает точка входа. */
function shown(err: UsageError | DomainError): string {
  return `${formatCommandError(["logs"], err)}\n`;
}

Deno.test("ls-режимы: списки из кэша, без сети", async (t) => {
  const hosts = (await golden("ls-hosts-stdout.txt")).trimEnd().split("\n");
  const services = (await golden("ls-services-stdout.txt")).trimEnd().split(
    "\n",
  );

  await t.step("mpu logs ls — хосты по одному на строку", async () => {
    // Порядок посева обратный: сортировку делает сама команда.
    const seed: Seed = { hosts: [...hosts].reverse() };
    await withStand(seed, {}, async (io) => {
      const result = await runLogs(args({ selector: "ls" }), io, options());
      assertEquals(result.kind, "hosts");
      assertEquals(
        logsCommand.renderResult(result, ["ls"]),
        await golden("ls-hosts-stdout.txt"),
      );
    });
  });

  await t.step("mpu logs sl-1 ls — сервисы хоста", async () => {
    const seed: Seed = {
      hosts: ["sl-1"],
      services: [
        ...[...services].reverse().map((s) => ["sl-1", s] as const),
        ["sl-2", "чужой-сервис"] as const,
      ],
    };
    await withStand(seed, {}, async (io) => {
      const result = await runLogs(
        args({ selector: "sl-1", service: "ls" }),
        io,
        options(),
      );
      assertEquals(result.kind, "services");
      assertEquals(
        logsCommand.renderResult(result, ["sl-1", "ls"]),
        await golden("ls-services-stdout.txt"),
      );
    });
  });

  await t.step("ls первым аргументом побеждает всё остальное", async () => {
    // `ls` и сервис с таким же именем в кэше: ветка `ls` идёт раньше
    // трактовки первого аргумента как имени сервиса, поэтому вызов
    // остаётся списком хостов и в сеть не ходит.
    const seed: Seed = {
      hosts: ["sl-1"],
      services: [["sl-1", "ls"]],
    };
    await withStand(seed, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => []);
      const bare = await runLogs(
        args({ selector: "ls" }),
        io,
        options({ readLoki: loki.read }),
      );
      assertEquals(bare.kind, "hosts");
      // Второй аргумент при `ls` игнорируется.
      const withSecond = await runLogs(
        args({ selector: "ls", service: "что-угодно" }),
        io,
        options({ readLoki: loki.read }),
      );
      assertEquals(withSecond.kind, "hosts");
      assertEquals(loki.asked, []);
    });
  });

  await t.step("пустой кэш хостов — exit 2 с текстом спеки", async () => {
    await withStand({}, {}, async (io) => {
      const err = await assertRejects(
        () => runLogs(args({ selector: "ls" }), io, options()),
        UsageError,
      );
      assertEquals(
        err.message,
        "кэш hosts пуст. Запусти `mpu init` или `mpu update`.",
      );
    });
  });

  await t.step("нет сервисов хоста — эталон канала", async () => {
    await withStand({ hosts: ["sl-1"] }, {}, async (io) => {
      const err = await assertRejects(
        () =>
          runLogs(args({ selector: "sl-99", service: "ls" }), io, options()),
        UsageError,
      );
      assertEquals(shown(err), await golden("err-services-empty.txt"));
    });
  });

  await t.step(
    "нет схемы в БД — это пустой кэш, а не сырой отказ",
    async () => {
      await withStand(undefined, {}, async (io) => {
        const err = await assertRejects(
          () => runLogs(args({ selector: "ls" }), io, options()),
          UsageError,
        );
        assertStringIncludes(err.message, "кэш hosts пуст");
      });
    },
  );
});

Deno.test("разбор аргументов: отказы до сети", async (t) => {
  const cases: readonly (readonly [string, Partial<LogsArgs>, string])[] = [
    ["--since abc", { since: "abc" }, "err-since-bad.txt"],
    ["--via docker", { via: "docker" }, "err-via-unknown.txt"],
    [
      "--via portainer без селектора",
      { via: "portainer" },
      "err-portainer-no-selector.txt",
    ],
    [
      "--via portainer без контейнера",
      { via: "portainer", selector: "sl-1" },
      "err-portainer-no-container.txt",
    ],
    [
      "--follow с --via portainer",
      { via: "portainer", selector: "sl-1", service: "api", follow: true },
      "err-follow-portainer.txt",
    ],
  ];

  for (const [title, overrides, fixture] of cases) {
    await t.step(title, async () => {
      await withStand({ hosts: ["sl-1"] }, { LOKI_URL }, async (io) => {
        const loki = fakeLoki(() => []);
        const err = await assertRejects(
          () => runLogs(args(overrides), io, options({ readLoki: loki.read })),
          UsageError,
        );
        assertEquals(shown(err), await golden(fixture));
        assertEquals(loki.asked, [], "запрос ушёл несмотря на отказ ввода");
      });
    });
  }

  await t.step("--tail 0 и отрицательный отвергаются", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      for (const tail of ["0", "-5"]) {
        const err = await assertRejects(
          () => runLogs(args({ tail }), io, options()),
          UsageError,
        );
        assertStringIncludes(err.message, "--tail");
      }
    });
  });

  await t.step("нечисловые --tail и --client — ошибка ввода", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      for (const overrides of [{ tail: "много" }, { client: "abc" }]) {
        const err = await assertRejects(
          () => runLogs(args(overrides), io, options()),
          UsageError,
        );
        assertStringIncludes(err.message, "ожидается целое");
      }
    });
  });

  await t.step("фильтры Loki с --via portainer — ошибка ввода", async () => {
    await withStand({}, {}, async (io) => {
      const err = await assertRejects(
        () =>
          runLogs(
            args({
              via: "portainer",
              selector: "sl-1",
              service: "api",
              level: "error",
            }),
            io,
            options(),
          ),
        UsageError,
      );
      assertEquals(
        err.message,
        "--grep/--grep-regex/--level/--client поддерживаются только" +
          " с --via loki",
      );
    });
  });

  await t.step("LOKI_URL не задан — exit 2 до всякой сети", async () => {
    await withStand({}, {}, async (io) => {
      const err = await assertRejects(
        () => runLogs(args({ selector: "sl-1" }), io, options()),
        UsageError,
      );
      assertEquals(err.message, "LOKI_URL не задан в ~/.config/mpu/.env");
    });
  });
});

Deno.test("MCP-форма входа: слежение — только CLI", async (t) => {
  await t.step("follow: true — ошибка ввода с текстом спеки", async () => {
    await withStand({ hosts: ["sl-1"] }, { LOKI_URL }, async (io) => {
      const err = await assertRejects(
        () => logsCommand.invokeInput({ follow: true }, io),
        UsageError,
      );
      assertEquals(err.message, "--follow доступен только в CLI");
    });
  });

  await t.step("follow: false исполняется как обычно", async () => {
    await withStand({ hosts: ["sl-1"] }, {}, async (io) => {
      const result = await logsCommand.invokeInput(
        { selector: "ls", follow: false },
        io,
      );
      assertEquals(result, {
        kind: "hosts",
        names: ["sl-1"],
        entries: [],
        snapshot: null,
      });
    });
  });
});

Deno.test("разовый запрос в Loki", async (t) => {
  await t.step("окно, лимит и направление", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => []);
      await runLogs(
        args({ selector: "sl-1", tail: "50" }),
        io,
        options({ readLoki: loki.read }),
      );
      assertEquals(loki.asked.length, 1);
      assertEquals(loki.asked[0].logql, '{host="sl-1"}');
      assertEquals(loki.asked[0].startNs, NOW_NS - 300_000_000_000n);
      assertEquals(loki.asked[0].endNs, NOW_NS);
      assertEquals(loki.asked[0].limit, 50);
      assertEquals(loki.asked[0].direction, "backward");
    });
  });

  await t.step("--since двигает нижнюю границу окна", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => []);
      await runLogs(
        args({ selector: "sl-1", since: "1h" }),
        io,
        options({ readLoki: loki.read }),
      );
      assertEquals(loki.asked[0].startNs, NOW_NS - 3_600_000_000_000n);
    });
  });

  await t.step("первый аргумент — имя известного сервиса", async () => {
    const seed: Seed = { hosts: ["sl-1"], services: [["sl-1", "wb-loader"]] };
    await withStand(seed, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => []);
      await runLogs(
        args({ selector: "wb-loader" }),
        io,
        options({ readLoki: loki.read }),
      );
      // Фильтра по хосту нет: сервис берётся со всех хостов.
      assertEquals(
        loki.asked[0].logql,
        '{host=~".+",compose_service="wb-loader"}',
      );
    });
  });

  await t.step("клиентский селектор резолвится в сервер", async () => {
    const seed: Seed = { clients: [{ id: 7, server: "sl-3" }] };
    await withStand(seed, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => []);
      await runLogs(
        args({ selector: "7" }),
        io,
        options({
          readLoki: loki.read,
        }),
      );
      assertEquals(loki.asked[0].logql, '{host="sl-3"}');
    });
  });

  await t.step("нераспознанный селектор — отказ резолва, exit 2", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      await assertRejects(
        () => runLogs(args({ selector: "нет-такого" }), io, options()),
        UsageError,
      );
    });
  });

  await t.step("печать по возрастанию времени, не по ответу", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => [
        entry("1754380800000000003", "третья"),
        entry("1754380800000000001", "первая"),
        entry("1754380800000000002", "вторая"),
      ]);
      const result = await runLogs(
        args({ selector: "sl-1" }),
        io,
        options({ readLoki: loki.read }),
      );
      assertEquals(
        logsCommand.renderResult(result, ["sl-1"]),
        "первая\nвторая\nтретья\n",
      );
    });
  });

  await t.step("строка печатается без хвостового перевода строки", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => [
        entry("1754380800000000001", "с переводом\n"),
        entry("1754380800000000002", "[31mцвет[0m"),
      ]);
      const result = await runLogs(
        args({ selector: "sl-1" }),
        io,
        options({ readLoki: loki.read }),
      );
      // Управляющие последовательности сервиса не трогаются.
      assertEquals(
        logsCommand.renderResult(result, ["sl-1"]),
        "с переводом\n[31mцвет[0m\n",
      );
    });
  });

  await t.step("--timestamps даёт префикс UTC с миллисекундами", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const loki = fakeLoki(() => [entry("1754380800123000000", "строка")]);
      const result = await runLogs(
        args({ selector: "sl-1", timestamps: true }),
        io,
        options({ readLoki: loki.read }),
      );
      assertEquals(
        logsCommand.renderResult(result, ["sl-1", "--timestamps"]),
        "2025-08-05T08:00:00.123Z строка\n",
      );
    });
  });

  await t.step("пустой результат — успех с пустым выводом", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const result = await runLogs(
        args({ selector: "sl-1" }),
        io,
        options({ readLoki: fakeLoki(() => []).read }),
      );
      assertEquals(logsCommand.renderResult(result, ["sl-1"]), "");
    });
  });

  await t.step("ответ вне 2xx — exit 1, текст и строка запроса", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const body = "end timestamp must not be before or equal to start time";
      const err = await assertRejects(
        () =>
          runLogs(
            args({ selector: "sl-1" }),
            io,
            options({
              readLoki: fakeLoki(() =>
                new LokiHttpError(400, ` ${body} `)
              ).read,
            }),
          ),
        DomainError,
      );
      assertEquals(
        shown(err),
        `mpu logs: loki HTTP 400: ${body}\n  query: {host="sl-1"}\n`,
      );
    });
  });

  await t.step("прочий сбой источника — loki error без запроса", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const err = await assertRejects(
        () =>
          runLogs(
            args({ selector: "sl-1" }),
            io,
            options({
              readLoki: fakeLoki(() =>
                new LokiError("no response within 10000ms")
              ).read,
            }),
          ),
        DomainError,
      );
      assertEquals(
        shown(err),
        "mpu logs: loki error: no response within 10000ms\n",
      );
    });
  });
});

Deno.test("чужая ошибка источника не подменяется своим текстом", async () => {
  await withStand({}, { LOKI_URL }, async (io) => {
    const boom = new Error("совсем не про Loki");
    const err = await assertRejects(
      () =>
        runLogs(
          args({ selector: "sl-1" }),
          io,
          options({ readLoki: fakeLoki(() => boom).read }),
        ),
      Error,
    );
    assertEquals(err, boom);
  });
});

Deno.test("слежение: курсор, пустой опрос и отказ опроса", async (t) => {
  await t.step("начальная порция вперёд с лимитом --tail", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const controller = new AbortController();
      controller.abort();
      const loki = fakeLoki(() => []);
      const printed = fakeStream();
      await runLogs(
        args({ selector: "sl-1", follow: true, tail: "7" }),
        io,
        options({
          readLoki: loki.read,
          stream: printed.stream,
          signal: controller.signal,
          wait: () => Promise.resolve(),
        }),
      );
      assertEquals(loki.asked.length, 1);
      assertEquals(loki.asked[0].direction, "forward");
      assertEquals(loki.asked[0].limit, 7);
      assertEquals(loki.asked[0].startNs, NOW_NS - 10_000_000_000n);
    });
  });

  await t.step("опрос идёт с ts последней записи + 1нс", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const controller = new AbortController();
      const answers: (readonly LogEntry[])[] = [
        [entry("1754380800000000001", "первая")],
        [],
        [entry("1754380800000000009", "вторая")],
      ];
      let call = 0;
      const loki = fakeLoki(() => answers[call++] ?? []);
      const printed = fakeStream();
      const waits: number[] = [];
      await runLogs(
        args({ selector: "sl-1", follow: true }),
        io,
        options({
          readLoki: loki.read,
          stream: printed.stream,
          signal: controller.signal,
          wait: (ms) => {
            waits.push(ms);
            if (waits.length === 3) controller.abort();
            return Promise.resolve();
          },
        }),
      );
      assertEquals(waits, [2000, 2000, 2000]);
      // Пустой опрос курсор не двигает: третье окно начинается там же,
      // где второе.
      assertEquals(loki.asked[1].startNs, 1_754_380_800_000_000_002n);
      assertEquals(loki.asked[2].startNs, 1_754_380_800_000_000_002n);
      assertEquals(loki.asked[1].limit, 1000);
      assertEquals(printed.out(), "первая\nвторая\n");
    });
  });

  await t.step("отказ опроса печатается и слежение продолжается", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const controller = new AbortController();
      let call = 0;
      const loki = fakeLoki(() => {
        call += 1;
        if (call === 2) return new LokiError("connection reset");
        return call === 3 ? [entry("1754380800000000005", "жива")] : [];
      });
      const printed = fakeStream();
      let waits = 0;
      await runLogs(
        args({ selector: "sl-1", follow: true }),
        io,
        options({
          readLoki: loki.read,
          stream: printed.stream,
          signal: controller.signal,
          wait: () => {
            waits += 1;
            if (waits === 3) controller.abort();
            return Promise.resolve();
          },
        }),
      );
      assertEquals(
        printed.err(),
        "\nmpu logs: loki error: connection reset\n",
      );
      assertEquals(printed.out(), "жива\n");
    });
  });

  await t.step("чужая ошибка опроса прекращает слежение", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const controller = new AbortController();
      let call = 0;
      const loki = fakeLoki(() => {
        call += 1;
        return call === 1 ? [] : new Error("не отказ источника");
      });
      await assertRejects(
        () =>
          runLogs(
            args({ selector: "sl-1", follow: true }),
            io,
            options({
              readLoki: loki.read,
              stream: fakeStream().stream,
              signal: controller.signal,
              wait: () => Promise.resolve(),
            }),
          ),
        Error,
        "не отказ источника",
      );
    });
  });

  await t.step("отказ начального запроса — отказ вызова", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const controller = new AbortController();
      controller.abort();
      await assertRejects(
        () =>
          runLogs(
            args({ selector: "sl-1", follow: true }),
            io,
            options({
              readLoki: fakeLoki(() => new LokiHttpError(503, "boom")).read,
              stream: fakeStream().stream,
              signal: controller.signal,
              wait: () => Promise.resolve(),
            }),
          ),
        DomainError,
      );
    });
  });

  await t.step("остановка — перевод строки в stdout и успех", async () => {
    await withStand({}, { LOKI_URL }, async (io) => {
      const controller = new AbortController();
      controller.abort();
      const result = await runLogs(
        args({ selector: "sl-1", follow: true }),
        io,
        options({
          readLoki: fakeLoki(() => []).read,
          stream: fakeStream().stream,
          signal: controller.signal,
          wait: () => Promise.resolve(),
        }),
      );
      assertEquals(result.kind, "follow");
      assertEquals(logsCommand.renderResult(result, ["sl-1", "-f"]), "\n");
    });
  });
});

/** Подставной Portainer: имена контейнеров и снимок логов. */
function fakePortainer(names: readonly string[], streams = {
  stdout: "данные\n",
  stderr: "шум\n",
}) {
  const asked: {
    readonly access: PortainerAccess;
    readonly endpointId: number;
    readonly container: string;
    readonly query: ContainerLogsQuery;
  }[] = [];
  const utf8 = new TextEncoder();
  return {
    asked,
    listContainerNames: () => Promise.resolve(names),
    readContainerLogs: (
      access: PortainerAccess,
      endpointId: number,
      container: string,
      query: ContainerLogsQuery,
    ) => {
      asked.push({ access, endpointId, container, query });
      return Promise.resolve({
        stdout: utf8.encode(streams.stdout),
        stderr: utf8.encode(streams.stderr),
      });
    },
  };
}

const PORTAINER_SEED: Seed = {
  containers: [{ url: "https://portainer.test/", endpointId: 4, server: 1 }],
};

Deno.test("legacy-снимок через Portainer", async (t) => {
  await t.step("цель из кэша, потоки разведены, параметры Docker", async () => {
    await withStand(PORTAINER_SEED, {
      PORTAINER_API_KEY: "проба-ключа",
    }, async (io) => {
      const portainer = fakePortainer(["/mp-sl-1-cli", "mp-wb-loader"]);
      const printed = fakeStream();
      const result = await runLogs(
        args({
          via: "portainer",
          selector: "sl-1",
          service: "wb-loader",
          tail: "42",
          since: "1h",
          "no-stderr": true,
        }),
        io,
        options({
          listContainerNames: portainer.listContainerNames,
          readContainerLogs: portainer.readContainerLogs,
          stream: printed.stream,
        }),
      );
      assertEquals(portainer.asked[0].access.baseUrl, "https://portainer.test");
      assertEquals(portainer.asked[0].access.apiKey, "проба-ключа");
      // Проверка сертификата включается только явным «true».
      assertEquals(portainer.asked[0].access.verifyTls, false);
      assertEquals(portainer.asked[0].endpointId, 4);
      assertEquals(portainer.asked[0].container, "mp-wb-loader");
      assertEquals(portainer.asked[0].query, {
        stdout: true,
        stderr: false,
        tail: 42,
        timestamps: false,
        sinceUnix: Math.floor(NOW_MS / 1000) - 3600,
      });
      // stdout-часть — через рендер, stderr-часть — потоком, как есть.
      assertEquals(
        logsCommand.renderResult(result, ["sl-1", "wb-loader"]),
        "данные\n",
      );
      assertEquals(printed.err(), "шум\n");
      assertEquals(printed.out(), "");
    });
  });

  await t.step("точное имя побеждает подстроку", async () => {
    await withStand(PORTAINER_SEED, {
      PORTAINER_API_KEY: "k",
    }, async (io) => {
      const portainer = fakePortainer(["api", "api-worker"]);
      await runLogs(
        args({ via: "portainer", selector: "sl-1", service: "api" }),
        io,
        options({
          listContainerNames: portainer.listContainerNames,
          readContainerLogs: portainer.readContainerLogs,
          stream: fakeStream().stream,
        }),
      );
      assertEquals(portainer.asked[0].container, "api");
    });
  });

  await t.step("подстрока без совпадений — отказ с подсказкой", async () => {
    await withStand(PORTAINER_SEED, { PORTAINER_API_KEY: "k" }, async (io) => {
      const portainer = fakePortainer(["api"]);
      const err = await assertRejects(
        () =>
          runLogs(
            args({ via: "portainer", selector: "sl-1", service: "нет" }),
            io,
            options({
              listContainerNames: portainer.listContainerNames,
              readContainerLogs: portainer.readContainerLogs,
            }),
          ),
        UsageError,
      );
      assertEquals(
        shown(err),
        "mpu logs: контейнер 'нет' не найден на sl-1\n" +
          "  подсказка: mpu ps sl-1\n",
      );
    });
  });

  await t.step("неоднозначная подстрока — список кандидатов", async () => {
    await withStand(PORTAINER_SEED, { PORTAINER_API_KEY: "k" }, async (io) => {
      const portainer = fakePortainer(["mp-api-2", "mp-api-1", "mp-api-1"]);
      const err = await assertRejects(
        () =>
          runLogs(
            args({ via: "portainer", selector: "sl-1", service: "api" }),
            io,
            options({
              listContainerNames: portainer.listContainerNames,
              readContainerLogs: portainer.readContainerLogs,
            }),
          ),
        UsageError,
      );
      assertEquals(
        shown(err),
        "mpu logs: подстрока 'api' даёт несколько контейнеров на sl-1:\n" +
          "  mp-api-1\n  mp-api-2\n",
      );
    });
  });

  await t.step("нет ключа доступа — exit 2 до сети", async () => {
    await withStand(PORTAINER_SEED, {}, async (io) => {
      const portainer = fakePortainer(["api"]);
      const err = await assertRejects(
        () =>
          runLogs(
            args({ via: "portainer", selector: "sl-1", service: "api" }),
            io,
            options({
              listContainerNames: portainer.listContainerNames,
              readContainerLogs: portainer.readContainerLogs,
            }),
          ),
        UsageError,
      );
      assertEquals(
        err.message,
        "PORTAINER_API_KEY не задан в ~/.config/mpu/.env",
      );
      assertEquals(portainer.asked, []);
    });
  });

  await t.step("нет цели ни в кэше, ни в env — exit 2", async () => {
    await withStand({}, { PORTAINER_API_KEY: "k" }, async (io) => {
      const err = await assertRejects(
        () =>
          runLogs(
            args({ via: "portainer", selector: "sl-1", service: "api" }),
            io,
            options({
              listContainerNames: fakePortainer([]).listContainerNames,
            }),
          ),
        UsageError,
      );
      assertEquals(
        err.message,
        "для sl-1 не найден portainer-target (SQLite после `mpu init` или" +
          " sl_1_portainer в ~/.config/mpu/.env)",
      );
    });
  });

  await t.step("legacy-ключ env заменяет цель, битый — нет", async () => {
    const portainer = fakePortainer(["api"]);
    await withStand({}, {
      PORTAINER_API_KEY: "k",
      sl_1_portainer: "https://legacy.test/7",
    }, async (io) => {
      await runLogs(
        args({ via: "portainer", selector: "sl-1", service: "api" }),
        io,
        options({
          listContainerNames: portainer.listContainerNames,
          readContainerLogs: portainer.readContainerLogs,
          stream: fakeStream().stream,
        }),
      );
      assertEquals(portainer.asked[0].access.baseUrl, "https://legacy.test");
      assertEquals(portainer.asked[0].endpointId, 7);
    });

    await withStand({}, {
      PORTAINER_API_KEY: "k",
      sl_1_portainer: "https://legacy.test/семь",
    }, async (io) => {
      await assertRejects(
        () =>
          runLogs(
            args({ via: "portainer", selector: "sl-1", service: "api" }),
            io,
            options({ listContainerNames: portainer.listContainerNames }),
          ),
        UsageError,
      );
    });
  });

  await t.step("отказ Portainer — exit 1 с его причиной", async () => {
    await withStand(PORTAINER_SEED, { PORTAINER_API_KEY: "k" }, async (io) => {
      const err = await assertRejects(
        () =>
          runLogs(
            args({ via: "portainer", selector: "sl-1", service: "api" }),
            io,
            options({
              listContainerNames: () =>
                Promise.reject(new PortainerError("HTTP 502")),
            }),
          ),
        DomainError,
      );
      assertEquals(shown(err), "mpu logs: portainer error: HTTP 502\n");
    });
  });
});

Deno.test("результат: JSON-форма и рендер", async (t) => {
  await t.step("рендер зависит только от результата и аргументов", () => {
    const result: LogsResult = {
      kind: "entries",
      names: [],
      entries: [entry("1754380800000000001", "строка")],
      snapshot: null,
    };
    const first = logsCommand.renderResult(result, ["sl-1"]);
    assertEquals(logsCommand.renderResult(result, ["sl-1"]), first);
    assertEquals(first, "строка\n");
  });

  await t.step("объявленная схема принимает результат снимка", () => {
    logsCommand.assertResult({
      kind: "snapshot",
      names: [],
      entries: [],
      snapshot: { container: "mp-api", stdout: "о\n", stderr: "" },
    });
  });
});
