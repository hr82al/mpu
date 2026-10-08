/**
 * Тесты команды `mpu init` (`docs/specs/init.md`) без точки входа
 * приложения: приоритет источников Portainer, пределы обхода и прогревов,
 * справка, исход шага 5. Сценарии через точку входа (`runCli`: разбор argv,
 * печать результата, строки `progress`, коды выхода) — в `ts/`
 * (`back/src/entrypoint/init/cmd_init.test.ts`) над тем же стендом
 * (`./teststand.ts`, вход `@mpu/cmd-init/testing`).
 */

import { describe, expect, it } from "vitest";
import { makeFakeIo } from "@mpu/command/testing";
import { serveFetch } from "@mpu/testing";
import { NO_ONE } from "@mpu/command";
import { runTelegramLogin } from "./telegram.ts";
import { runTelegramLoginStep } from "@mpu/cmd-telegram";
import {
  DEFAULT_INIT_LIMITS,
  initCommand,
  requirePortainerAccess,
  runInit,
} from "./cmd_init.ts";
import { HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "@mpu/http";
import type { PortainerAccess } from "@mpu/portainer";
import { KAITEN_TIMEOUTS } from "@mpu/kaiten";
import { WARMUP_BUDGET_MS } from "@mpu/cmd-kiten";
import {
  API_KEY,
  containersResponse,
  endpointsResponse,
  envFileFake,
  fakeStand,
  makeIo,
  standEnv,
  TELEGRAM_SKIPPED,
  withTempDb,
} from "./teststand.ts";

describe("requirePortainerAccess: приоритет --portainer, PORTAINER_VERIFY_TLS, нормализация URL", () => {
  interface Case {
    readonly name: string;
    readonly args: { readonly portainer?: string };
    readonly env: Readonly<Record<string, string>>;
    readonly expected: PortainerAccess;
  }
  const cases: readonly Case[] = [
    {
      name: "--portainer приоритетнее PORTAINER_URL (шаг 2 спеки)",
      args: { portainer: "https://cli.example.com" },
      env: {
        PORTAINER_API_KEY: API_KEY,
        PORTAINER_URL: "https://env.example.com",
      },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: "без --portainer используется PORTAINER_URL",
      args: {},
      env: {
        PORTAINER_API_KEY: API_KEY,
        PORTAINER_URL: "https://env.example.com",
      },
      expected: {
        baseUrl: "https://env.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: "хвостовые / базового URL срезаются",
      args: { portainer: "https://cli.example.com///" },
      env: { PORTAINER_API_KEY: API_KEY },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: "PORTAINER_VERIFY_TLS не задан — verifyTls выключен",
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="true" — verifyTls включён',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "true" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: true,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="True" — verifyTls включён (без учёта регистра)',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "True" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: true,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="TRUE" — verifyTls включён (без учёта регистра)',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "TRUE" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: true,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="false" — verifyTls выключен',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "false" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="1" — verifyTls выключен (сравнение без учёта регистра, но не с "1")',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "1" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(requirePortainerAccess(c.args, envFileFake(c.env))).toStrictEqual(
        c.expected,
      );
    });
  }
});

it("таймаут молчащего endpoint'а: строка ошибки, обход продолжается, время ограничено", async () => {
  await withTempDb(async (dbPath) => {
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = await serveFetch((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "silent" },
          {
            id: 2,
            name: "fine",
          },
        ]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return pending.promise; // никогда не резолвится сам по себе
      }
      if (url.pathname === "/api/endpoints/2/docker/containers/json") {
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    try {
      const progress: string[] = [];
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
        progress: (line) => void progress.push(`${line}\n`),
      });
      // Шаги 1–2 зовутся напрямую, потому что предел заголовков здесь
      // уменьшен на два порядка: через объявление команды он равен
      // продуктовым трём секундам, и тест ждал бы их стеной (`ts/CLAUDE.md`
      // такой сон запрещает). Продуктовые числа проверяет тест `--help`.
      const limits = {
        timeouts: { headersTimeoutMs: 60, totalTimeoutMs: 5_000 },
        kaiten: DEFAULT_INIT_LIMITS.kaiten,
      };
      const start = performance.now();
      const result = await runInit(
        { portainer: undefined, "dry-run": true, reset: false },
        io,
        limits,
      );
      const elapsed = performance.now() - start;
      expect(progress.join("")).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `mpu init: endpoint 1 (silent): no response headers within ` +
          `${limits.timeouts.headersTimeoutMs}ms\n`,
      );
      expect(initCommand.renderResult(result, ["--dry-run"])).toStrictEqual(
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 2 (fine) -> ${baseUrl}/2\n` +
          "# прочих контейнеров: 0\n",
      );
      // Обход уложился в предел заголовков молчащего endpoint'а, а не в
      // общий предел вызова: запас на неспешную машину — тридцатикратный.
      expect(elapsed < 2_000, `elapsed ${elapsed}ms должно быть < 2000ms`).toBe(
        true,
      );
    } finally {
      pending.resolve(new Response("[]"));
      await stop();
    }
  });
});

it("--help содержит числа пределов и укладывается в 2048 байт с summary", () => {
  // Числа — одной точной подстрокой, а не каждое отдельным `includes`:
  // «3000» нашлось бы и внутри «30000». Пределы Kaiten названы отдельно
  // от общих (`platform/kaiten-http.md`).
  expect(initCommand.help).toContain(
    `Portainer и Loki ${HEADERS_TIMEOUT_MS}/${TOTAL_TIMEOUT_MS} ms,\n` +
      `Kaiten ${KAITEN_TIMEOUTS.headersTimeoutMs}/${KAITEN_TIMEOUTS.totalTimeoutMs} ms; ` +
      `бюджет прогрева Kaiten ${WARMUP_BUDGET_MS} ms`,
  );
  expect(HEADERS_TIMEOUT_MS).not.toStrictEqual(TOTAL_TIMEOUT_MS);
  expect(KAITEN_TIMEOUTS.headersTimeoutMs).not.toStrictEqual(
    HEADERS_TIMEOUT_MS,
  );
  expect(KAITEN_TIMEOUTS.totalTimeoutMs).not.toStrictEqual(TOTAL_TIMEOUT_MS);
  const bytes = new TextEncoder().encode(
    `${initCommand.summary}\n\n${initCommand.help}`,
  ).length;
  expect(bytes <= 2048, `описание не влезло: ${bytes} байт`).toBe(true);
});

it("сбой входа не остаётся молчаливым: строка есть, код 0", async () => {
  // До правки эта ветка печатала ноль строк: сам вход до своих
  // сообщений не доходил, а шаг перестал печатать за него. Пропуск без
  // причины — то же, что несделанная работа под видом успеха
  // (`init.md`, шаги 3–5 best-effort: пропуск виден строкой).
  const lines: string[] = [];
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      require: () => {
        throw new Error("require не ожидается");
      },
      set: () => Promise.reject(new Error("set не ожидается")),
    },
    prompt: {
      line: () => Promise.reject(new Error("сломался терминал")),
      secret: () => Promise.reject(new Error("secret не ожидается")),
      copy: () => Promise.reject(new Error("copy не ожидается")),
    },
    progress: (line: string) => void lines.push(line),
  });
  expect(await runTelegramLogin(io)).toBe("сломался терминал");
  expect(lines).toStrictEqual([
    "# telegram: ключей приложения нет; взять их — https://my.telegram.org/apps",
    "# telegram: пропущено (сломался терминал)",
  ]);
});

it("шаг 5 и команда дают один исход на одном входе", async () => {
  // Две реализации одного шага уже стояли рядом (подпроцесс у `init`,
  // своя команда у `telegram login`) и могли разойтись молча: сверки
  // не было ни одной. С порции 95 реализация одна, и это проверяется —
  // на ветках, доступных без терминала и без сети.
  const cases: readonly (readonly [string, Record<string, string>])[] = [
    ["нет TTY", {}],
    ["уже авторизован", { TELEGRAM_SESSION: "живая-сессия" }],
  ];
  for (const [name, keys] of cases) {
    const lines: string[] = [];
    const io = makeFakeIo({
      envFile: {
        get: (key: string) => keys[key],
        values: () => ({ ...keys }),
        require: () => {
          throw new Error("require не ожидается");
        },
        set: () => Promise.reject(new Error("set не ожидается")),
      },
      prompt: NO_ONE,
      progress: (line: string) => void lines.push(line),
    });
    const step = await runTelegramLogin(io);
    const direct = await runTelegramLoginStep(io);
    expect(step, `${name}: шаг и команда разошлись`).toStrictEqual(
      direct.status === "skipped" ? (direct.reason ?? "без причины") : null,
    );
    // Обе половины прогона напечатали одно и то же: строки делятся
    // пополам и половины совпадают.
    const half = lines.length / 2;
    expect(lines.length % 2, `${name}: ${JSON.stringify(lines)}`).toBe(0);
    expect(lines.slice(0, half), `${name}: тексты разошлись`).toStrictEqual(
      lines.slice(half),
    );
  }
});

it("молчащий источник прогрева не тянет команду дольше своего предела", async () => {
  await withTempDb(async (dbPath) => {
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = await fakeStand((url) =>
      url.pathname === "/loki/api/v1/series" ? pending.promise : undefined,
    );
    try {
      const progress: string[] = [];
      const io = makeIo(dbPath, {
        envFile: standEnv(baseUrl),
        progress: (line) => void progress.push(`${line}\n`),
      });
      // Пределы уменьшены на два порядка: ждать продуктовые секунды
      // стеной тест не имеет права (`ts/CLAUDE.md`).
      const limits = {
        timeouts: { headersTimeoutMs: 60, totalTimeoutMs: 5_000 },
        kaiten: DEFAULT_INIT_LIMITS.kaiten,
      };
      const start = performance.now();
      await runInit(
        { portainer: undefined, "dry-run": false, reset: false },
        io,
        limits,
      );
      const elapsed = performance.now() - start;
      expect(progress.join("")).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: пропущено (no response headers within 60ms)\n" +
          "# kaiten: 1 spaces, 2 boards, 3 lanes, 3 columns, 2 roles\n" +
          TELEGRAM_SKIPPED,
      );
      expect(elapsed < 2_000, `elapsed ${elapsed}ms должно быть < 2000ms`).toBe(
        true,
      );
    } finally {
      pending.resolve(new Response("{}"));
      await stop();
    }
  });
});

it("шаг 4 ограничен пределами Kaiten, а не пределами Portainer и Loki", async () => {
  await withTempDb(async (dbPath) => {
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = await fakeStand((url) =>
      url.pathname === "/api/latest/spaces" ? pending.promise : undefined,
    );
    try {
      const progress: string[] = [];
      const io = makeIo(dbPath, {
        envFile: standEnv(baseUrl),
        progress: (line) => void progress.push(`${line}\n`),
      });
      // Пределы групп разведены: если шаг 4 возьмёт общие, отказ назовёт
      // 2000ms, а не предел Kaiten. Числа малы — ждать продуктовые
      // секунды стеной тест не имеет права (`ts/CLAUDE.md`).
      const limits = {
        timeouts: { headersTimeoutMs: 2_000, totalTimeoutMs: 5_000 },
        kaiten: {
          timeouts: { headersTimeoutMs: 60, totalTimeoutMs: 5_000 },
          budgetMs: DEFAULT_INIT_LIMITS.kaiten.budgetMs,
        },
      };
      await runInit(
        { portainer: undefined, "dry-run": false, reset: false },
        io,
        limits,
      );
      expect(progress.join("")).toContain(
        "# kaiten: пропущено (no response headers within 60ms)\n",
      );
    } finally {
      pending.resolve(new Response("[]"));
      await stop();
    }
  });
});
