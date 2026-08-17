/**
 * Команда `mpu ssh` (`docs/specs/ssh.md`). Живого контейнера здесь нет
 * и быть не может: подпроцесс ssh и канал WebSocket подставные, а
 * наблюдаемое — эталоны канала, код выхода и служебные строки.
 */

import { assertEquals, assertRejects } from "@std/assert";
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
import { sshCommand } from "./cmd_ssh.ts";
import { runSsh, type SshArgs, type SshIo, type SshOptions } from "./run.ts";

const HOME = "/home/проба";

const ENV: Readonly<Record<string, string>> = {
  PORTAINER_API_KEY: "секрет",
  sl_1: "10.0.0.1",
  sl_0: "10.0.0.0",
  PG_MY_USER_NAME: "u",
  DEV_NODE_HOST: "10.1.1.1",
  DEV_NODE_USER: "dev",
};

/** Аргументы вызова: всё, кроме названного, — умолчания схемы. */
function args(overrides: Partial<SshArgs> = {}): SshArgs {
  return {
    selector: undefined,
    command: [],
    via: undefined,
    "all-containers": undefined,
    "stdin-text": undefined,
    "stdin-file": undefined,
    "stdin-tty": false,
    ...overrides,
  };
}

/** Приёмник вывода, копящий текст, — как у вызова тула. */
function sink(): RemoteOutput & { readonly text: () => string } {
  const parts: string[] = [];
  const append = (chunk: Uint8Array) => {
    parts.push(new TextDecoder().decode(chunk));
  };
  return {
    out: append,
    err: append,
    captured: () => parts.join(""),
    text: () => parts.join(""),
  };
}

/** Окружение вызова: env-файл, кэш-БД и накопленный stderr. */
function harness(db?: CacheDb) {
  const progress: string[] = [];
  const output = sink();
  // Закрытие считается, а не выполняется: настоящий `openCacheDb`
  // отдаёт вызову свой экземпляр, а здесь он один на тест, и его
  // закрывает `using` самого теста.
  let closed = 0;
  const io = makeFakeIo({
    env: (name) => name === "HOME" ? HOME : undefined,
    envFile: {
      get: (name) => ENV[name],
      values: () => ({ ...ENV }),
      require: (name) => ENV[name] ?? "",
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
  return { io: io as SshIo, progress, output, closed: () => closed };
}

/** Подставной подпроцесс ssh: помнит вызов, печатает и отдаёт код. */
function fakeSsh(
  answer: { readonly stdout?: string; readonly code?: number } = {},
) {
  const seen: {
    args?: readonly string[];
    stdin?: string;
    bytes?: Uint8Array;
  } = {};
  const run: RunProcess = (_bin, argv, stdin, output) => {
    seen.args = argv;
    seen.bytes = stdin;
    seen.stdin = new TextDecoder().decode(stdin);
    if (answer.stdout !== undefined) {
      output.out(new TextEncoder().encode(answer.stdout));
    }
    return Promise.resolve(answer.code ?? 0);
  };
  return { run, seen };
}

function options(run: RunProcess): SshOptions {
  return { runProcess: run };
}

/**
 * Подставная граница Portainer: создание exec'а отвечает готовым
 * идентификатором, стрим сразу закрывается, код выхода нулевой.
 * Собирает удалённые команды пользователя — служебные exec'ы (уборка)
 * в список не попадают.
 */
function fakePortainer(exitCodes: readonly number[] = []) {
  const commands: string[] = [];
  let finished = 0;
  const PREFIX = "echo $$ > /tmp/__MPU_PSSH_PID; exec sh -c ";
  const http: HttpCall = (url, request) => {
    const body = typeof request.body === "string" ? request.body : "";
    if (body !== "") {
      const cmd = JSON.parse(body).Cmd[2] as string;
      // Безопасная строка уходит без кавычек — снимаем их, если есть.
      if (cmd.startsWith(PREFIX)) {
        const tail = cmd.slice(PREFIX.length);
        commands.push(
          tail.startsWith("'")
            ? tail.slice(1, -1).replaceAll(`'"'"'`, "'")
            : tail,
        );
      }
    }
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
        yield encodeClose();
      })(),
      write: () => {},
      close: () => {},
    });
  return {
    http,
    open,
    commands,
    options: { httpCall: http, openChannel: open },
  };
}

/** Кадр закрытия сервера: без маски (RFC 6455). */
function encodeClose(): Uint8Array {
  return Uint8Array.of(0x88, 0x00);
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/ssh/${name}`, import.meta.url),
  );
}

/** Временная кэш-БД с контейнерами. */
async function withCache(
  rows: readonly { readonly name: string; readonly endpointId?: number }[],
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
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
        null,
        "running",
        "образ",
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("успех: вывод и нулевой код — эталон канала", async (t) => {
  const ssh = fakeSsh({ stdout: await golden("ok-echo-stdout.txt") });
  const { io, output } = harness();
  const result = await runSsh(
    args({ selector: "sl-0", command: ["echo", "mpu-golden-probe"] }),
    io,
    options(ssh.run),
  );

  await t.step("код удалённой команды доходит 1:1", () => {
    assertEquals(result.exitCode, 0);
    assertEquals(sshCommand.textExitCode(result), 0);
  });

  await t.step("вывод — байт в байт эталон", async () => {
    assertEquals(output.text(), await golden("ok-echo-stdout.txt"));
  });

  await t.step("ssh идёт в контейнер сервера ключом из HOME", () => {
    assertEquals(ssh.seen.args, [
      "-i",
      `${HOME}/.ssh/id_rsa`,
      "u@10.0.0.0",
      "docker exec -i mp-sl-0-cli sh -c 'echo mpu-golden-probe'",
    ]);
  });
});

Deno.test("ненулевой код не схлопывается в 0", async () => {
  const ssh = fakeSsh({ code: 7 });
  const { io } = harness();
  const result = await runSsh(
    args({ selector: "sl-1", command: ["sh", "-c", "exit 7"] }),
    io,
    options(ssh.run),
  );
  assertEquals(result.exitCode, 7);
  assertEquals(sshCommand.textExitCode(result), 7);
});

Deno.test("отказы ввода — эталоны канала", async (t) => {
  const cases: readonly [string, SshArgs, string][] = [
    ["пустая команда", args({}), "err-empty-cmd-stderr.txt"],
    [
      "два источника stdin",
      args({
        selector: "sl-1",
        command: ["echo", "x"],
        "stdin-text": "a",
        "stdin-tty": true,
      }),
      "err-stdin-mutex-stderr.txt",
    ],
    [
      "dev-селектор с мусорным хвостом",
      args({ selector: "dev:abc", command: ["ls"] }),
      "err-dev-selector-stderr.txt",
    ],
  ];
  for (const [title, argv, name] of cases) {
    await t.step(title, async () => {
      const { io } = harness();
      const err = await assertRejects(
        () => runSsh(argv, io, options(fakeSsh().run)),
        UsageError,
      );
      assertEquals(`${formatCommandError("ssh", err)}\n`, await golden(name));
    });
  }
});

Deno.test("голый вызов отказывает про команду, а не про селектор", async () => {
  // Замер спеки: проверка пустой команды идёт раньше всех прочих,
  // поэтому кэш-БД и env-файл не читаются вовсе.
  const { io } = harness();
  const err = await assertRejects(
    () => runSsh(args({ selector: "нет-такого-клиента" }), io),
    UsageError,
  );
  assertEquals(err.message, "пустая команда");
});

Deno.test("--all-containers: список, служебные строки и обход", async (t) => {
  await t.step("нет совпадений — эталон канала", async () => {
    await withCache([{ name: "mp-dt-cli" }], async (db) => {
      const { io } = harness(db);
      const err = await assertRejects(
        () =>
          runSsh(
            args({
              selector: "node",
              command: ["-v"],
              "all-containers": "zzz-no-such",
            }),
            io,
            options(fakeSsh().run),
          ),
        UsageError,
      );
      assertEquals(
        `${formatCommandError("ssh", err)}\n`,
        await golden("err-all-containers-empty-stderr.txt"),
      );
    });
  });

  await t.step(
    "селектор возвращается в команду, обход по порядку",
    async () => {
      await withCache(
        [{ name: "wb-loader-2" }, { name: "wb-loader-1" }],
        async (db) => {
          const { io, progress } = harness(db);
          const portainer = fakePortainer();
          const result = await runSsh(
            args({
              selector: "node",
              command: ["-v"],
              "all-containers": "wb-loader",
            }),
            io,
            portainer.options,
          );
          assertEquals(result.exitCode, 0);
          assertEquals(progress, [
            "# mpu ssh: containers = [wb-loader-1, wb-loader-2]",
            "# container=wb-loader-1",
            "# container=wb-loader-2",
          ]);
          // Команда собрана из селектора и хвоста: `node -v`.
          assertEquals(portainer.commands, ["node -v", "node -v"]);
        },
      );
    },
  );
});

Deno.test("контейнер по точному имени идёт Portainer'ом", async () => {
  await withCache([{ name: "mp-dt-cli" }], async (db) => {
    const { io, closed } = harness(db);
    const portainer = fakePortainer();
    const result = await runSsh(
      args({ selector: "mp-dt-cli", command: ["env"] }),
      io,
      portainer.options,
    );
    assertEquals(result.exitCode, 0);
    // Кэш-БД закрыта: у долгоживущего MCP-сервера незакрытый файл
    // пережил бы вызов тула.
    assertEquals(closed(), 1);
    // Прогон один, и он Portainer'ом: ssh-подпроцесса тест не давал
    // вовсе, а контейнер по имени по ssh не исполняется (инвариант).
    assertEquals(portainer.commands, ["env"]);
  });
});

Deno.test("объявление команды: политика и предел описания", async (t) => {
  await t.step("мутирующая команда — класс rw", () => {
    assertEquals(sshCommand.path, ["ssh"]);
    assertEquals(sshCommand.policy, "rw");
    assertEquals(sshCommand.errorName, "ssh");
  });

  await t.step("описание тула укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${sshCommand.summary}\n\n${sshCommand.help}`,
    ).length;
    assertEquals(bytes < 2048, true, `описание не влезло: ${bytes} байт`);
  });
});

Deno.test("источники stdin доезжают до удалённой команды", async (t) => {
  await t.step("--stdin-text уходит байтами", async () => {
    const ssh = fakeSsh();
    const { io } = harness();
    await runSsh(
      args({ selector: "sl-1", command: ["cat"], "stdin-text": "тело\n" }),
      io,
      options(ssh.run),
    );
    assertEquals(ssh.seen.stdin, "тело\n");
  });

  await t.step("--stdin-file читается портом io", async () => {
    const ssh = fakeSsh();
    const { io } = harness();
    const withFile: SshIo = {
      ...io,
      readFile: (path) =>
        path === "/tmp/тело.txt"
          ? Promise.resolve(new TextEncoder().encode("из файла"))
          : Promise.reject(new Error(`лишнее чтение: ${path}`)),
    };
    await runSsh(
      args({
        selector: "sl-1",
        command: ["cat"],
        "stdin-file": "/tmp/тело.txt",
      }),
      withFile,
      options(ssh.run),
    );
    assertEquals(ssh.seen.stdin, "из файла");
  });

  await t.step("--stdin-tty спрашивает и читает до EOF", async () => {
    const ssh = fakeSsh();
    const { io, progress } = harness();
    const withStdin: SshIo = {
      ...io,
      readStdin: () =>
        Promise.resolve(new TextEncoder().encode("с клавиатуры")),
    };
    await runSsh(
      args({ selector: "sl-1", command: ["cat"], "stdin-tty": true }),
      withStdin,
      options(ssh.run),
    );
    assertEquals(ssh.seen.stdin, "с клавиатуры");
    assertEquals(progress, [
      "mpu ssh: введите stdin для команды, завершите Ctrl+D",
    ]);
  });

  await t.step("терминал без явного источника: stdin пустой", async () => {
    const ssh = fakeSsh();
    const { io } = harness();
    await runSsh(
      args({ selector: "sl-1", command: ["cat"] }),
      io,
      options(ssh.run),
    );
    assertEquals(ssh.seen.stdin, "");
  });

  await t.step("пайп читается целиком", async () => {
    const ssh = fakeSsh();
    const { io } = harness();
    const piped: SshIo = {
      ...io,
      stdinIsTerminal: () => false,
      readStdin: () => Promise.resolve(new TextEncoder().encode("из пайпа")),
    };
    await runSsh(
      args({ selector: "sl-1", command: ["cat"] }),
      piped,
      options(ssh.run),
    );
    assertEquals(ssh.seen.stdin, "из пайпа");
  });
});

Deno.test("dev-селектор ведёт на dev-ноду, а не на сервер фермы", async () => {
  const ssh = fakeSsh();
  const { io } = harness();
  await runSsh(
    args({ selector: "dev:1", command: ["ls", "/app"] }),
    io,
    options(ssh.run),
  );
  assertEquals(ssh.seen.args, [
    "-i",
    `${HOME}/.ssh/id_rsa`,
    "dev@10.1.1.1",
    "docker exec -i mp-sl-1-cli sh -c 'ls /app'",
  ]);
});

Deno.test("неоднозначное имя контейнера: кандидаты, без клиент-поиска", async () => {
  await withCache(
    [{ name: "twin" }, { name: "twin", endpointId: 4 }],
    async (db) => {
      const { io } = harness(db);
      const err = await assertRejects(
        () => runSsh(args({ selector: "twin", command: ["env"] }), io),
        UsageError,
      );
      assertEquals(
        `${formatCommandError("ssh", err)}\n`,
        "mpu ssh: container 'twin' ambiguous — 2 Portainer endpoints:\n" +
          "  endpoint=farm-a  id=1  url=https://portainer.example\n" +
          "  endpoint=farm-a  id=4  url=https://portainer.example\n",
      );
    },
  );
});

Deno.test("fan-out прерывается на первом ненулевом коде", async () => {
  await withCache(
    [{ name: "wb-loader-1" }, { name: "wb-loader-2" }],
    async (db) => {
      const { io, progress } = harness(db);
      // Первый контейнер отвечает семёркой — второй запускаться не
      // должен, и код вызова становится его кодом.
      const portainer = fakePortainer([7]);
      const result = await runSsh(
        args({ selector: "node", command: ["-v"], "all-containers": "wb" }),
        io,
        portainer.options,
      );
      assertEquals(result.exitCode, 7);
      assertEquals(portainer.commands, ["node -v"]);
      assertEquals(progress, [
        "# mpu ssh: containers = [wb-loader-1, wb-loader-2]",
        "# container=wb-loader-1",
      ]);
    },
  );
});

Deno.test("stdin-файл не читается — ошибка ввода", async () => {
  const { io } = harness();
  const broken: SshIo = {
    ...io,
    readFile: () => Promise.reject(new NotFoundIoError("no such file")),
  };
  const err = await assertRejects(
    () =>
      runSsh(
        args({
          selector: "sl-1",
          command: ["cat"],
          "stdin-file": "/нет/такого",
        }),
        broken,
        options(fakeSsh().run),
      ),
    UsageError,
  );
  assertEquals(err.message, "stdin-файл не читается: /нет/такого");
});

Deno.test("HOME не задан — ssh-ключ искать негде", async () => {
  const { io } = harness();
  const homeless: SshIo = { ...io, env: () => undefined };
  await assertRejects(
    () =>
      runSsh(
        args({ selector: "sl-1", command: ["ls"] }),
        homeless,
        options(fakeSsh().run),
      ),
    UsageError,
    "путь к ssh-ключу не определён: HOME не задан",
  );
});

Deno.test("клиентский селектор резолвится общим правилом", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
      42,
      "sl-1",
      1_700_000_000,
    );
    const { io } = harness(db);
    const ssh = fakeSsh();
    await runSsh(
      args({ selector: "42", command: ["ls"] }),
      io,
      options(ssh.run),
    );
    // Резолв дал сервер 1 — значит, вызов пошёл в его контейнер.
    assertEquals(ssh.seen.args?.[2], "u@10.0.0.1");
    assertEquals(ssh.seen.args?.[3], "docker exec -i mp-sl-1-cli sh -c ls");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ambiguous внутри fan-out прерывает обход", async () => {
  await withCache(
    [
      { name: "wb-loader-1" },
      { name: "wb-loader-2" },
      { name: "wb-loader-2", endpointId: 4 },
    ],
    async (db) => {
      const { io, progress } = harness(db);
      const portainer = fakePortainer();
      const err = await assertRejects(
        () =>
          runSsh(
            args({ selector: "node", command: ["-v"], "all-containers": "wb" }),
            io,
            portainer.options,
          ),
        UsageError,
      );
      assertEquals(
        `${formatCommandError("ssh", err)}\n`,
        "mpu ssh: container 'wb-loader-2' ambiguous — 2 Portainer endpoints:\n" +
          "  endpoint=farm-a  id=1  url=https://portainer.example\n" +
          "  endpoint=farm-a  id=4  url=https://portainer.example\n",
      );
      // Первый контейнер уже отработал, строка второго напечатана до
      // отказа — обход прерывается именно на нём (спека).
      assertEquals(progress, [
        "# mpu ssh: containers = [wb-loader-1, wb-loader-2]",
        "# container=wb-loader-1",
        "# container=wb-loader-2",
      ]);
      assertEquals(portainer.commands, ["node -v"]);
    },
  );
});

Deno.test("двоичный stdin доезжает байт в байт", async () => {
  // Последовательность недопустима в UTF-8: перекодировка заменила бы
  // её символом-заменителем молча и необратимо
  // (`platform/command-contract.md`, «Ввод/вывод»).
  const raw = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x80);
  const ssh = fakeSsh();
  const { io } = harness();
  const piped: SshIo = {
    ...io,
    stdinIsTerminal: () => false,
    readStdin: () => Promise.resolve(raw),
  };
  await runSsh(
    args({ selector: "sl-1", command: ["gunzip"] }),
    piped,
    options(ssh.run),
  );
  assertEquals(ssh.seen.bytes, raw);
});
