/**
 * Команда `mpu run-js` (`docs/specs/run-js.md`). Живого контейнера
 * здесь нет и быть не может: подпроцесс ssh, граница Portainer и буфер
 * обмена подставные. Наблюдаемое — эталоны канала, служебные строки,
 * коды выхода и состав обращений к границе.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { rejected, thrown } from "../testing/thrown.ts";
import {
  type CacheDb,
  formatCommandError,
  NotFoundIoError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import type { HttpCall, OpenChannel, RunProcess } from "../exec/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runJsCommand } from "./cmd_run_js.ts";
import {
  type RunJsArgs,
  type RunJsIo,
  type RunJsOptions,
  runRunJs,
} from "./run.ts";

const HOME = "/home/проба";
const DETACH_ID = "0a1b2c3d";

/** Ферма, доступная по ssh: Portainer-ключа нет, и выбор однозначен. */
const ENV: Readonly<Record<string, string>> = {
  sl_0: "10.0.0.0",
  sl_1: "10.0.0.1",
  sl_2: "10.0.0.2",
  sl_3: "10.0.0.3",
  PG_MY_USER_NAME: "u",
};

function args(overrides: Partial<RunJsArgs> = {}): RunJsArgs {
  return {
    selector: undefined,
    code: undefined,
    file: undefined,
    all: false,
    "all-containers": undefined,
    "dry-run": false,
    via: undefined,
    parallel: false,
    jobs: 0,
    detach: false,
    ...overrides,
  };
}

/** Приёмник вывода, копящий текст, — как у вызова тула. */
function sink(): RemoteOutput & { readonly text: () => string } {
  const parts: string[] = [];
  const append = (chunk: Uint8Array) => {
    parts.push(new TextDecoder().decode(chunk));
    return Promise.resolve();
  };
  return {
    out: append,
    err: append,
    captured: () => parts.join(""),
    text: () => parts.join(""),
  };
}

function harness(db?: CacheDb, extra: Readonly<Record<string, string>> = {}) {
  const progress: string[] = [];
  const output = sink();
  const env = { ...ENV, ...extra };
  // Закрытие считается, а не выполняется: экземпляр в тесте один, и его
  // закрывает `using` самого теста.
  let closed = 0;
  const io = makeFakeIo({
    env: (name) => name === "HOME" ? HOME : undefined,
    envFile: {
      get: (name) => env[name],
      values: () => ({ ...env }),
      require: (name) => env[name] ?? "",
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    },
    openCacheDb: () => {
      if (db === undefined) throw new Error("кэш-БД открываться не должна");
      return {
        ...db,
        [Symbol.dispose]: () => {
          closed++;
        },
      };
    },
    progress: (line: string) => progress.push(line),
    openRemoteOutput: () => output,
    stdinIsTerminal: () => true,
  });
  return { io: io as RunJsIo, progress, output, closed: () => closed };
}

/** Подставной ssh: помнит вызовы, печатает и отдаёт коды по очереди. */
function fakeSsh(
  answer: {
    readonly stdout?: (remote: string) => string;
    readonly codes?: readonly number[];
  } = {},
) {
  const calls: { remote: string; stdin: string }[] = [];
  let index = 0;
  const run: RunProcess = (_bin, argv, proc) => {
    const remote = argv[3] ?? "";
    calls.push({ remote, stdin: new TextDecoder().decode(proc.stdin) });
    const text = answer.stdout?.(remote);
    if (text !== undefined) proc.output.out(new TextEncoder().encode(text));
    return Promise.resolve(answer.codes?.[index++] ?? 0);
  };
  return { run, calls };
}

/** Подставная граница Portainer: exec, стрим, код выхода. */
function fakePortainer(exitCodes: readonly number[] = []) {
  const commands: string[] = [];
  let finished = 0;
  const http: HttpCall = (url, request) => {
    const body = typeof request.body === "string" ? request.body : "";
    if (body !== "") commands.push(JSON.parse(body).Cmd[2] as string);
    return Promise.resolve({
      status: 200,
      text: url.pathname.endsWith("/json")
        ? `{"ExitCode":${exitCodes[finished++] ?? 0}}`
        : '{"Id":"exec-1"}',
      retryAfter: null,
    });
  };
  const open: OpenChannel = () =>
    Promise.resolve({
      chunks: (async function* () {
        yield new TextEncoder().encode(
          "HTTP/1.1 101 Switching Protocols\r\n\r\n",
        );
        yield Uint8Array.of(0x88, 0x00);
      })(),
      write: () => {},
      close: () => {},
    });
  return { commands, options: { httpCall: http, openChannel: open } };
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/run-js/${name}`, import.meta.url),
    "utf8",
  );
}

/** Временная кэш-БД с контейнерами. */
async function withCache(
  rows: readonly {
    readonly name: string;
    readonly serverNumber?: number;
    readonly endpointId?: number;
  }[],
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (const [index, row] of rows.entries()) {
      db.execute(
        "INSERT INTO portainer_containers (portainer_url, endpoint_id," +
          " endpoint_name, container_id, container_name, server_number," +
          " state, image, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "https://portainer.example",
        row.endpointId ?? 1,
        "farm-a",
        `id-${index}`,
        row.name,
        row.serverNumber ?? null,
        "running",
        "образ",
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

function options(run: RunProcess): RunJsOptions {
  return { runProcess: run, copy: () => Promise.resolve() };
}

describe("успех: вывод и служебные строки — эталоны канала", () => {
  let ssh: ReturnType<typeof fakeSsh>;
  let progress: string[];
  let output: RemoteOutput & { readonly text: () => string };
  let result: Awaited<ReturnType<typeof runRunJs>>;

  beforeAll(async () => {
    const stdout = await golden("ok-console-log-stdout.txt");
    ssh = fakeSsh({ stdout: () => stdout });
    const harnessed = harness();
    progress = harnessed.progress;
    output = harnessed.output;
    result = await runRunJs(
      args({ selector: "sl-0", code: 'console.log("mpu-golden")' }),
      harnessed.io,
      options(ssh.run),
    );
  });

  it("stdout — байт в байт, включая CR", async () => {
    // Пара CR+LF приходит из контейнера (псевдотерминал Portainer):
    // нормализовать её запрещено инвариантом транспорта.
    expect(output.text()).toStrictEqual(
      await golden("ok-console-log-stdout.txt"),
    );
  });

  it("служебные строки — эталон канала", async () => {
    expect(progress.map((line) => `${line}\n`).join("")).toStrictEqual(
      await golden("ok-console-log-stderr.txt"),
    );
  });

  it("код кладётся на stdin команде node", () => {
    expect(result.exitCode).toBe(0);
    expect(ssh.calls[0].remote).toBe(
      "docker exec -i sl-0-cli sh -c 'node --input-type=module -'",
    );
    expect(ssh.calls[0].stdin).toBe('console.log("mpu-golden")');
  });
});

describe("--dry-run: блок эталона, буфер обмена, ни сети ни выполнения", () => {
  let copied: string[];
  let progress: string[];
  let result: Awaited<ReturnType<typeof runRunJs>>;

  beforeAll(async () => {
    copied = [];
    const harnessed = harness();
    progress = harnessed.progress;
    result = await runRunJs(
      args({ selector: "sl-0", code: "console.log(1)", "dry-run": true }),
      harnessed.io,
      {
        copy: (text) => {
          copied.push(text);
          return Promise.resolve();
        },
        runProcess: () => {
          throw new Error("выполнения при --dry-run быть не должно");
        },
      },
    );
  });

  it("stdout — эталон канала", async () => {
    expect(runJsCommand.renderResult(result, ["sl-0"])).toStrictEqual(
      await golden("dry-run-stdout.txt"),
    );
  });

  it("stderr пуст: список таргетов не печатается", () => {
    expect(progress).toStrictEqual([]);
  });

  it("в буфер уходит ровно напечатанное", async () => {
    expect(copied).toStrictEqual([await golden("dry-run-stdout.txt")]);
    expect(result.exitCode).toBe(0);
  });

  it("отказ буфера кода выхода не меняет", async () => {
    const { io: io2 } = harness();
    const failed = await runRunJs(
      args({ selector: "sl-0", code: "console.log(1)", "dry-run": true }),
      io2,
      { copy: () => Promise.resolve() },
    );
    expect(failed.exitCode).toBe(0);
    expect(failed.preview).toStrictEqual(await golden("dry-run-stdout.txt"));
  });
});

describe("отказы ввода — эталоны канала", () => {
  const cases: readonly [string, RunJsArgs, string][] = [
    [
      "код и --file вместе",
      args({ selector: "sl-0", code: "console.log(1)", file: "/tmp/s.mjs" }),
      "err-code-and-file-stderr.txt",
    ],
  ];
  for (const [title, argv, name] of cases) {
    it(title, async () => {
      const { io } = harness();
      const err = await rejected(
        () => runRunJs(argv, io, options(fakeSsh().run)),
        UsageError,
      );
      expect(`${formatCommandError("run-js", err)}\n`).toStrictEqual(
        await golden(name),
      );
    });
  }

  it("пустой stdin-пайп", async () => {
    const { io } = harness();
    const piped: RunJsIo = {
      ...io,
      stdinIsTerminal: () => false,
      readStdin: () => Promise.resolve(new Uint8Array()),
    };
    const err = await rejected(
      () => runRunJs(args({ selector: "sl-0" }), piped, options(fakeSsh().run)),
      UsageError,
    );
    expect(`${formatCommandError("run-js", err)}\n`).toStrictEqual(
      await golden("err-empty-js-stderr.txt"),
    );
  });

  it("ни селектора, ни fan-out", async () => {
    const { io } = harness();
    const err = await rejected(
      () => runRunJs(args({ code: "console.log(1)" }), io, {}),
      UsageError,
    );
    expect(err.message).toBe(
      "укажите ровно один из target: / all / all-containers:",
    );
  });

  it("два позиционных при fan-out", async () => {
    const { io } = harness();
    const err = await rejected(
      () =>
        runRunJs(
          args({ all: true, selector: "console.log(1)", code: "лишнее" }),
          io,
          {},
        ),
      UsageError,
    );
    expect(err.message).toContain("target: избыточен");
  });

  it("--via проверяется до любого вывода", async () => {
    const { io, progress } = harness();
    await rejected(
      () =>
        runRunJs(
          args({ selector: "sl-0", code: "1", via: "portainerr" }),
          io,
          {},
        ),
      UsageError,
      "--via должен быть ssh|portainer, получено 'portainerr'",
    );
    // Отклонение `fix`: оригинал печатал служебные строки раньше отказа.
    expect(progress).toStrictEqual([]);
  });
});

it("--all: инстансы кэша по возрастанию, abort на первом сбое", async () => {
  await withCache([
    { name: "mp-sl-2-cli", serverNumber: 2 },
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-0-cli", serverNumber: 0 },
  ], async (db) => {
    const { io, progress } = harness(db);
    const ssh = fakeSsh({ codes: [3] });
    const result = await runRunJs(
      args({ all: true, selector: "console.log(1)" }),
      io,
      { ...options(ssh.run), httpCall: undefined },
    );
    expect(result.exitCode).toBe(3);
    // sl-0 в fan-out не входит (отклонение `preserve`), sl-2 не начат.
    expect(progress).toStrictEqual([
      "# mpu run-js: targets = [sl-1, sl-2]",
      "# target=sl-1",
      "mpu run-js: sl-1 exit=3 — abort",
    ]);
    expect(ssh.calls.length).toBe(1);
  });
});

it("--parallel: обходятся все, сбой изолируется, exit 1", async () => {
  await withCache([
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-2-cli", serverNumber: 2 },
  ], async (db) => {
    const { io, progress, output } = harness(db);
    const ssh = fakeSsh({
      codes: [5, 0],
      stdout: (remote) => remote.includes("mp-sl-1") ? "первый\n" : "второй\n",
    });
    const result = await runRunJs(
      args({ all: true, selector: "console.log(1)", parallel: true }),
      io,
      options(ssh.run),
    );
    expect(result.exitCode).toBe(1);
    expect(ssh.calls.length).toBe(2);
    expect(progress.join("\n")).toContain(
      "# mpu run-js: parallel — 2 targets, 2 workers;",
    );
    expect(progress.join("\n")).toContain("# ===== sl-1 (exit=5) =====");
    expect(progress.join("\n")).toContain("# ===== sl-2 (exit=0) =====");
    expect(progress.join("\n")).toContain("mpu run-js: failures on [sl-1]");
    // Вывод обоих таргетов дошёл целиком.
    expect(output.text()).toContain("первый\n");
    expect(output.text()).toContain("второй\n");
  });
});

it("--jobs ограничивает число одновременных", async () => {
  await withCache([
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-2-cli", serverNumber: 2 },
    { name: "mp-sl-3-cli", serverNumber: 3 },
  ], async (db) => {
    const { io, progress } = harness(db);
    let inFlight = 0;
    let peak = 0;
    const run: RunProcess = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return 0;
    };
    await runRunJs(
      args({
        all: true,
        selector: "console.log(1)",
        parallel: true,
        jobs: 2,
      }),
      io,
      options(run),
    );
    expect(peak <= 2, `одновременно шло ${peak}`).toBe(true);
    expect(progress.join("\n")).toContain(
      "# mpu run-js: parallel — 3 targets, 2 workers;",
    );
  });
});

it("--detach: один id на вызов, обход не прерывается, подсказки", async () => {
  await withCache([
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-2-cli", serverNumber: 2 },
  ], async (db) => {
    const { io, progress } = harness(db);
    // Первый таргет: заливка прошла, запуск отказал; второй — успех.
    const ssh = fakeSsh({ codes: [0, 4, 0, 0] });
    const result = await runRunJs(
      args({ all: true, selector: "console.log(1)", detach: true }),
      io,
      { ...options(ssh.run), newDetachId: () => DETACH_ID },
    );
    const log = `/tmp/mpu-run-${DETACH_ID}.log`;

    expect(result.exitCode).toBe(1);
    expect(result.detach).toStrictEqual({ id: DETACH_ID, log });
    expect(progress).toStrictEqual([
      "# mpu run-js: targets = [sl-1, sl-2]",
      `# mpu run-js: detached run_id=${DETACH_ID} — лог на каждом сервере: ${log}`,
      "# sl-1: launch exit=4",
      `# sl-2: started → ${log}`,
      '# собрать логи: mpu run-js all text: \'import fs from "node:fs";' +
      ` process.stdout.write(fs.existsSync("${log}")` +
      ` ? fs.readFileSync("${log}","utf8") : "no log yet\\n")'`,
      `# или вживую: mpu ssh target: sl-1 cmd: 'tail -f ${log}'`,
      "mpu run-js: detach failures on [sl-1]",
    ]);
    // Один id на все таргеты: пути скрипта совпадают.
    const uploads = ssh.calls.filter((call) => call.remote.includes("cat >"));
    expect(uploads.length).toBe(2);
    expect(
      uploads.every((call) =>
        call.remote.includes(`/tmp/mpu-run-${DETACH_ID}.mjs`)
      ),
    ).toBe(true);
  });
});

it("контейнер по имени идёт Portainer'ом и без подсказок логов", async () => {
  await withCache([{ name: "wb-loader" }], async (db) => {
    const { io, progress } = harness(db, { PORTAINER_API_KEY: "k" });
    const portainer = fakePortainer();
    const result = await runRunJs(
      args({
        "all-containers": "wb-loader",
        selector: "console.log(1)",
        detach: true,
      }),
      io,
      { ...portainer.options, newDetachId: () => DETACH_ID },
    );
    expect(result.exitCode).toBe(0);
    // Серверных таргетов нет — строки «собрать логи» не печатаются.
    expect(progress.some((line) => line.startsWith("# собрать логи"))).toBe(
      false,
    );
    expect(portainer.commands.some((cmd) => cmd.startsWith("nohup node"))).toBe(
      true,
    );
  });
});

describe("объявление команды: политика и предел описания", () => {
  it("мутирующая команда — класс rw", () => {
    expect(runJsCommand.path).toStrictEqual(["run-js"]);
    expect(runJsCommand.policy).toBe("rw");
    expect(runJsCommand.errorName).toBe("run-js");
  });

  it("описание тула укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${runJsCommand.summary}\n\n${runJsCommand.help}`,
    ).length;
    expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
  });
});

it("несколько таргетов в --dry-run: блок с меткой на каждый", async () => {
  await withCache([
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-2-cli", serverNumber: 2 },
  ], async (db) => {
    const { io } = harness(db);
    const result = await runRunJs(
      args({ all: true, selector: "console.log(1)", "dry-run": true }),
      io,
      { copy: () => Promise.resolve() },
    );
    expect(result.preview).toStrictEqual(
      "# target=sl-1\nmpu ssh target: sl-1 cmd: 'node --input-type=module -'" +
        " <<'__MPU_RUN_JS_EOF__'\nconsole.log(1)\n__MPU_RUN_JS_EOF__\n" +
        "# target=sl-2\nmpu ssh target: sl-2 cmd: 'node --input-type=module -'" +
        " <<'__MPU_RUN_JS_EOF__'\nconsole.log(1)\n__MPU_RUN_JS_EOF__\n",
    );
  });
});

describe("код из файла и его отсутствие", () => {
  it("--file читается портом io", async () => {
    const ssh = fakeSsh();
    const { io } = harness();
    const withFile: RunJsIo = {
      ...io,
      readTextFile: (path) =>
        path === "/tmp/s.mjs"
          ? Promise.resolve("console.log('из файла')\n")
          : Promise.reject(new Error(`лишнее чтение: ${path}`)),
    };
    await runRunJs(
      args({ selector: "sl-1", file: "/tmp/s.mjs" }),
      withFile,
      options(ssh.run),
    );
    expect(ssh.calls[0].stdin).toBe("console.log('из файла')\n");
  });

  it("файла нет — ошибка ввода", async () => {
    const { io } = harness();
    const broken: RunJsIo = {
      ...io,
      readTextFile: () => Promise.reject(new NotFoundIoError("нет файла")),
    };
    const err = await rejected(
      () => runRunJs(args({ selector: "sl-1", file: "/нет" }), broken, {}),
      UsageError,
    );
    expect(err.message).toBe("файл не читается: /нет");
  });
});

it("stdin с терминала: подсказка и чтение до EOF", async () => {
  const ssh = fakeSsh();
  const { io, progress } = harness();
  const typed: RunJsIo = {
    ...io,
    readStdin: () =>
      Promise.resolve(new TextEncoder().encode("console.log('с клавиатуры')")),
  };
  await runRunJs(args({ selector: "sl-1" }), typed, options(ssh.run));
  expect(progress[0]).toBe("mpu run-js: введите ESM-код, завершите Ctrl+D");
  expect(ssh.calls[0].stdin).toBe("console.log('с клавиатуры')");
});

describe("пустой fan-out — отказ с подсказкой про init", () => {
  it("--all по пустому кэшу", async () => {
    await withCache([{ name: "mp-dt-cli" }], async (db) => {
      const { io } = harness(db);
      const err = await rejected(
        () => runRunJs(args({ all: true, selector: "1" }), io, {}),
        UsageError,
      );
      expect(err.message).toBe(
        "в SQLite-кэше нет sl-N (N>0); запусти `mpu init`",
      );
    });
  });

  it("--all-containers без совпадений", async () => {
    await withCache([{ name: "mp-dt-cli" }], async (db) => {
      const { io } = harness(db);
      const err = await rejected(
        () =>
          runRunJs(
            args({ "all-containers": "zzz", selector: "1" }),
            io,
            {},
          ),
        UsageError,
      );
      expect(err.message).toBe(
        "контейнеры с подстрокой 'zzz' не найдены в кэше; запусти `mpu init`",
      );
    });
  });
});

it("--jobs принимает только целое ≥ 0", async () => {
  await withCache([{ name: "mp-sl-1-cli", serverNumber: 1 }], async (db) => {
    const { io } = harness(db);
    await rejected(
      () =>
        runRunJs(
          args({ all: true, selector: "1", parallel: true, jobs: -1 }),
          io,
          options(fakeSsh().run),
        ),
      UsageError,
      "--jobs: ожидалось целое ≥ 0, задано '-1'",
    );
    // Нечисловое значение до команды не доходит: его отвергает схема
    // (`platform/command-contract.md`, «Ввод/вывод»).
    thrown(
      () => runJsCommand.parseArgs(["sl-1", "код", "-j", "два"]),
      UsageError,
      "expected number",
    );
  });
});

it("рендер: вне --dry-run печатается вывод, а не блок", () => {
  expect(runJsCommand.renderResult({
    mode: "sequential",
    targets: [{ label: "sl-1", exitCode: 0, failure: null }],
    detach: null,
    preview: "",
    output: "вывод\n",
    exitCode: 0,
  }, ["sl-1"])).toBe("вывод\n");
});

it("--parallel: исключение таргета изолируется", async () => {
  await withCache([
    { name: "mp-sl-1-cli", serverNumber: 1 },
    { name: "mp-sl-2-cli", serverNumber: 2 },
  ], async (db) => {
    const { io, progress } = harness(db);
    const seen: string[] = [];
    const run: RunProcess = (_bin, argv) => {
      const remote = argv[3] ?? "";
      seen.push(remote);
      if (remote.includes("mp-sl-1")) {
        return Promise.reject(new Error("сокет оборвался"));
      }
      return Promise.resolve(0);
    };
    const result = await runRunJs(
      args({ all: true, selector: "console.log(1)", parallel: true }),
      io,
      options(run),
    );
    // Обойдены оба; сбойный учтён причиной, а не кодом.
    expect(seen.length).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(result.targets).toStrictEqual([
      { label: "sl-1", exitCode: null, failure: "сокет оборвался" },
      { label: "sl-2", exitCode: 0, failure: null },
    ]);
    expect(progress.join("\n")).toContain(
      "# ===== sl-1 (FAILED — сокет оборвался) =====",
    );
  });
});

it("--via ssh с таргетом-контейнером — отказ до вывода", async () => {
  await withCache([{ name: "wb-loader" }], async (db) => {
    const { io, progress } = harness(db, { PORTAINER_API_KEY: "k" });
    const err = await rejected(
      () =>
        runRunJs(
          args({
            "all-containers": "wb-loader",
            selector: "console.log(1)",
            via: "ssh",
          }),
          io,
          {},
        ),
      UsageError,
    );
    // Отклонение `fix`: оригинал молча шёл Portainer'ом.
    expect(err.message).toBe(
      "ssh не поддерживается для контейнера по имени; только для sl-N",
    );
    expect(progress).toStrictEqual([]);
  });
});

it("--parallel с одним таргетом — последовательный режим", async () => {
  const ssh = fakeSsh();
  const { io, progress } = harness();
  await runRunJs(
    args({ selector: "sl-1", code: "console.log(1)", parallel: true }),
    io,
    options(ssh.run),
  );
  // Заголовка parallel нет: с одним таргетом делить нечего (спека).
  expect(progress).toStrictEqual([
    "# mpu run-js: targets = [sl-1]",
    "# target=sl-1",
  ]);
});

it("--detach вместе с --parallel — выполняется detach", async () => {
  const ssh = fakeSsh();
  const { io, progress } = harness();
  const result = await runRunJs(
    args({
      selector: "sl-1",
      code: "console.log(1)",
      parallel: true,
      detach: true,
    }),
    io,
    { ...options(ssh.run), newDetachId: () => DETACH_ID },
  );
  expect(result.mode).toBe("detach");
  expect(progress.join("\n")).toContain(`detached run_id=${DETACH_ID}`);
});

it("кэш-БД закрывается ровно один раз", async () => {
  await withCache([{ name: "mp-sl-1-cli", serverNumber: 1 }], async (db) => {
    const { io, closed } = harness(db);
    await runRunJs(
      args({ all: true, selector: "console.log(1)" }),
      io,
      options(fakeSsh().run),
    );
    // У долгоживущего MCP-сервера незакрытый файл пережил бы вызов.
    expect(closed()).toBe(1);
  });
});
