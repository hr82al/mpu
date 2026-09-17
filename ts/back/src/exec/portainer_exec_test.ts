/**
 * Portainer-бэкенд (`platform/exec-transport.md`, «Portainer-путь»).
 * Наблюдаемое — последовательность обращений к границе: какие адреса,
 * методы и тела ушли, что пришло в приёмник вывода и какой код выхода
 * получился. Ответы Portainer — фикстуры канала.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError, type RemoteOutput } from "../command/mod.ts";
import { encodeFrame, OPCODE, randomMask } from "./frames.ts";
import {
  detachOverPortainer,
  type HttpCall,
  type PortainerTarget,
  runOverPortainer,
} from "./portainer.ts";
import type { ByteChannel, OpenChannel } from "./ws.ts";

const TARGET: PortainerTarget = {
  kind: "portainer",
  access: {
    baseUrl: "https://portainer.example",
    apiKey: "секрет",
    verifyTls: false,
  },
  endpointId: 4,
  container: "mp-sl-1-cli",
};

const encoder = new TextEncoder();

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/exec-transport/${name}`, import.meta.url),
  );
}

/** Обращение к HTTP-границе, каким его увидел тест. */
interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly insecure: boolean;
}

/** Границa Portainer: ответы по адресу, журнал обращений. */
function border(answers: {
  readonly create: string;
  readonly inspect: readonly string[];
  readonly status?: number;
}) {
  const sent: Sent[] = [];
  let inspected = 0;
  const http: HttpCall = (url, options) => {
    const body = typeof options.body === "string"
      ? options.body
      : options.body === undefined
      ? ""
      : new TextDecoder("latin1").decode(options.body);
    sent.push({
      url: url.toString(),
      method: options.method ?? "GET",
      body,
      headers: options.headers ?? {},
      insecure: options.insecure === true,
    });
    const text = url.pathname.endsWith("/json")
      ? answers.inspect[Math.min(inspected++, answers.inspect.length - 1)]
      : answers.create;
    return Promise.resolve({
      status: answers.status ?? 200,
      text,
      retryAfter: null,
    });
  };
  return { http, sent };
}

/** Канал WebSocket: рукопожатие, заданные кадры, закрытие. */
function channelOf(frames: readonly Uint8Array[]): OpenChannel {
  return openChannel(frames).open;
}

/**
 * Канал с наблюдаемым закрытием. По умолчанию сервер сам присылает
 * кадр закрытия; `hold` оставляет соединение открытым — тогда стрим
 * завершает только `close`, и потерянная отмена вешала бы прогон
 * вместо того, чтобы тихо пройти.
 */
function openChannel(
  frames: readonly Uint8Array[],
  hold = false,
): { readonly open: OpenChannel; readonly closed: () => boolean } {
  let closed = false;
  let first = true;
  const open: OpenChannel = () => {
    // Держится только первое соединение — то, по которому идёт сама
    // команда. Служебные exec'ы (kill, уборка) идут следом и обязаны
    // завершаться сами.
    const holds = hold && first;
    first = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chunks = [
      encoder.encode("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
      ...frames,
      ...(hold
        ? []
        : [encodeFrame(OPCODE.close, new Uint8Array(), randomMask())]),
    ];
    const channel: ByteChannel = {
      chunks: (async function* () {
        for (const chunk of chunks) yield chunk;
        if (holds) await held;
      })(),
      write: () => {},
      close: () => {
        closed = true;
        release();
      },
    };
    return Promise.resolve(channel);
  };
  return { open, closed: () => closed };
}

/** Приёмник вывода, копящий текст. */
function sink() {
  const parts: string[] = [];
  const output: RemoteOutput = {
    out: (chunk) => parts.push(new TextDecoder().decode(chunk)),
    err: (chunk) => parts.push(new TextDecoder().decode(chunk)),
    captured: () => parts.join(""),
  };
  return { output, text: () => parts.join("") };
}

/** Кадр данных сервера, как их шлёт Docker при `Tty=true`. */
function data(text: string): Uint8Array {
  return encodeFrame(OPCODE.binary, encoder.encode(text), randomMask());
}

function run(options: {
  readonly http: HttpCall;
  readonly open: OpenChannel;
  readonly output: RemoteOutput;
  readonly stdin?: Uint8Array;
  readonly warn?: (line: string) => void;
  readonly onInterrupt?: (handler: () => void) => () => void;
}) {
  return runOverPortainer({
    target: TARGET,
    command: ["echo", "hi"],
    stdin: options.stdin ?? new Uint8Array(),
    output: options.output,
    warn: options.warn ?? (() => {}),
    http: options.http,
    open: options.open,
    onInterrupt: options.onInterrupt ?? (() => () => {}),
    delay: () => Promise.resolve(),
  });
}

Deno.test("успешный прогон: exec, стрим, код выхода, уборка", async (t) => {
  const answers = {
    create: await fixture("portainer-create-exec.json"),
    inspect: [await fixture("portainer-inspect-exec-done.json")],
  };
  const { http, sent } = border(answers);
  const { output, text } = sink();
  const code = await run({
    http,
    open: channelOf([data("out\n"), data("err\n")]),
    output,
  });
  const id = JSON.parse(answers.create).Id;

  await t.step("код выхода из ответа Portainer, 1:1", () => {
    assertEquals(code, 7);
  });

  await t.step("оба потока пришли одним — следствие Tty", () => {
    assertEquals(text(), "out\nerr\n");
  });

  await t.step("создание exec: адрес, метод, обёртка и Tty", () => {
    const create = sent[0];
    assertEquals(
      create.url,
      "https://portainer.example/api/endpoints/4/docker/containers/mp-sl-1-cli/exec",
    );
    assertEquals(create.method, "POST");
    assertEquals(JSON.parse(create.body), {
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: [
        "sh",
        "-c",
        "echo $$ > /tmp/__MPU_PSSH_PID; exec sh -c 'echo hi'",
      ],
    });
  });

  await t.step("ключ уходит заголовком, проверка TLS выключена", () => {
    assertEquals(sent[0].headers["X-API-Key"], "секрет");
    assertEquals(sent[0].insecure, true);
  });

  await t.step("код выхода читается у exec'а", () => {
    assertEquals(
      sent[1].url,
      `https://portainer.example/api/endpoints/4/docker/exec/${id}/json`,
    );
    assertEquals(sent[1].method, "GET");
  });

  await t.step("последним уходит уборка pidfile", () => {
    const last = JSON.parse(sent[sent.length - 1].body);
    assertEquals(last.Cmd, ["sh", "-c", "rm -f /tmp/__MPU_PSSH_PID"]);
  });
});

Deno.test("stdin: архив в /tmp и редирект в команде", async (t) => {
  const { http, sent } = border({
    create: await fixture("portainer-create-exec.json"),
    inspect: [await fixture("portainer-inspect-exec-done.json")],
  });
  const { output } = sink();
  await run({
    http,
    open: channelOf([]),
    output,
    stdin: encoder.encode("тело\n"),
  });

  await t.step("архив уходит PUT'ом до создания exec'а", () => {
    assertEquals(
      sent[0].url,
      "https://portainer.example/api/endpoints/4/docker/containers/mp-sl-1-cli/archive?path=/tmp",
    );
    assertEquals(sent[0].method, "PUT");
    assertEquals(sent[0].headers["Content-Type"], "application/x-tar");
    assertStringIncludes(sent[0].body, "__MPU_PSSH_STDIN");
    assertStringIncludes(sent[0].body, "ustar");
  });

  await t.step("команда читает файл", () => {
    assertEquals(
      JSON.parse(sent[1].body).Cmd[2],
      "echo $$ > /tmp/__MPU_PSSH_PID; exec sh -c 'echo hi < /tmp/__MPU_PSSH_STDIN'",
    );
  });

  await t.step("уборка сносит оба файла", () => {
    assertEquals(
      JSON.parse(sent[sent.length - 1].body).Cmd[2],
      "rm -f /tmp/__MPU_PSSH_PID /tmp/__MPU_PSSH_STDIN",
    );
  });
});

Deno.test("пустой stdin: ни архива, ни редиректа", async () => {
  const { http, sent } = border({
    create: await fixture("portainer-create-exec.json"),
    inspect: [await fixture("portainer-inspect-exec-done.json")],
  });
  const { output } = sink();
  await run({ http, open: channelOf([]), output });
  assertEquals(sent.some((call) => call.method === "PUT"), false);
  assertEquals(
    JSON.parse(sent[0].body).Cmd[2].includes("__MPU_PSSH_STDIN"),
    false,
  );
});

Deno.test("ExitCode = null: повторный опрос, потом предупреждение", async (t) => {
  await t.step("дождались завершения — код настоящий", async () => {
    const { http, sent } = border({
      create: await fixture("portainer-create-exec.json"),
      inspect: [
        await fixture("portainer-inspect-exec-running.json"),
        await fixture("portainer-inspect-exec-done.json"),
      ],
    });
    const { output } = sink();
    assertEquals(await run({ http, open: channelOf([]), output }), 7);
    assertEquals(sent.filter((call) => call.url.endsWith("/json")).length, 2);
  });

  await t.step("не дождались — предупреждение и код 1", async () => {
    const { http } = border({
      create: await fixture("portainer-create-exec.json"),
      inspect: [await fixture("portainer-inspect-exec-running.json")],
    });
    const warnings: string[] = [];
    const { output } = sink();
    assertEquals(
      await run({
        http,
        open: channelOf([]),
        output,
        warn: (line) => warnings.push(line),
      }),
      1,
    );
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "код выхода");
  });
});

Deno.test("Ctrl+C: предупреждение, kill по pidfile, уборка", async () => {
  const { http, sent } = border({
    create: await fixture("portainer-create-exec.json"),
    inspect: [await fixture("portainer-inspect-exec-done.json")],
  });
  const warnings: string[] = [];
  // Сервер соединение не закрывает: завершить стрим обязана отмена, и
  // без неё прогон не закончился бы вовсе.
  const channel = openChannel([data("тик\n")], true);
  let interrupt = () => {};
  const { output } = sink();
  await runOverPortainer({
    target: TARGET,
    command: ["echo", "hi"],
    stdin: new Uint8Array(),
    // Ctrl+C приходит посреди стрима, на первом же куске вывода.
    output: {
      ...output,
      out: (chunk) => {
        output.out(chunk);
        interrupt();
      },
    },
    warn: (line) => warnings.push(line),
    http,
    open: channel.open,
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => {};
    },
    delay: () => Promise.resolve(),
  });
  assertEquals(channel.closed(), true);
  assertEquals(warnings, ["mpu: Ctrl+C → killing remote process..."]);
  const kill = JSON.parse(sent[1].body).Cmd[2];
  assertStringIncludes(kill, "cat /tmp/__MPU_PSSH_PID");
  assertStringIncludes(kill, 'kill -INT "$pid"');
  assertStringIncludes(kill, "sleep 1");
  assertStringIncludes(kill, 'kill -KILL "$pid"');
  // Кода выхода после прерывания не спрашивают: exec оборван.
  assertEquals(sent.some((call) => call.url.endsWith("/json")), false);
});

Deno.test("отказ Portainer — доменная ошибка, уборка всё равно идёт", async () => {
  const { http, sent } = border({
    create: '{"message":"forbidden"}',
    inspect: [],
    status: 403,
  });
  const { output } = sink();
  await assertRejects(
    () => run({ http, open: channelOf([]), output }),
    DomainError,
    "создание exec: Portainer ответил 403",
  );
  // Уборка идёт и здесь: без неё доставленный stdin остался бы лежать
  // в контейнере (спека, п. 8).
  assertEquals(
    sent.map((call) => call.method),
    ["POST", "POST"],
  );
  assertStringIncludes(sent[1].body, "rm -f /tmp/__MPU_PSSH_PID");
});

Deno.test("отказ создания exec после доставки stdin: уборка сносит оба файла", async () => {
  const { http, sent } = border({
    create: '{"message":"boom"}',
    inspect: [],
    status: 500,
  });
  const { output } = sink();
  await assertRejects(
    () =>
      run({
        http,
        open: channelOf([]),
        output,
        stdin: encoder.encode("тело\n"),
      }),
    DomainError,
  );
  assertEquals(
    JSON.parse(sent[sent.length - 1].body).Cmd[2],
    "rm -f /tmp/__MPU_PSSH_PID /tmp/__MPU_PSSH_STDIN",
  );
});

Deno.test("фоновый запуск: скрипт архивом, exec без Tty, статус не ждём", async (t) => {
  const { http, sent } = border({
    create: await fixture("portainer-create-exec.json"),
    inspect: [await fixture("portainer-inspect-exec-done.json")],
  });
  const { output } = sink();
  const code = await detachOverPortainer({
    target: TARGET,
    script: "console.log(1)\n",
    scriptPath: "/tmp/mpu-run-0a1b2c3d.mjs",
    logPath: "/tmp/mpu-run-0a1b2c3d.log",
    output,
    warn: () => {},
    http,
    open: channelOf([]),
    delay: () => Promise.resolve(),
  });

  await t.step("скрипт уезжает тем же архивом, что и stdin", () => {
    assertEquals(sent[0].method, "PUT");
    assertStringIncludes(sent[0].body, "mpu-run-0a1b2c3d.mjs");
    assertEquals(sent[0].headers["Content-Type"], "application/x-tar");
  });

  await t.step("запуск — nohup и редирект в лог, без Tty", () => {
    const body = JSON.parse(sent[1].body);
    assertEquals(body.Tty, false);
    assertEquals(body.Cmd, [
      "sh",
      "-c",
      "nohup node /tmp/mpu-run-0a1b2c3d.mjs" +
      " > /tmp/mpu-run-0a1b2c3d.log 2>&1 < /dev/null &",
    ]);
  });

  await t.step("код запуска — код exec'а, не удалённой команды", () => {
    assertEquals(code, 7);
  });

  await t.step("строку `mpu: detached` launch-команда не печатает", () => {
    // Статус печатает CLI; дубля в удалённой команде нет и на ssh-пути
    // (отклонение `fix` спеки).
    assertEquals(JSON.parse(sent[1].body).Cmd[2].includes("echo"), false);
  });
});
