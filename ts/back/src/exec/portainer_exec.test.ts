/**
 * Portainer-бэкенд (`platform/exec-transport.md`, «Portainer-путь»).
 * Наблюдаемое — последовательность обращений к границе: какие адреса,
 * методы и тела ушли, что пришло в приёмник вывода и какой код выхода
 * получился. Ответы Portainer — фикстуры канала.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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
  return await readFile(
    new URL(`./testdata/exec-transport/${name}`, import.meta.url),
    "utf8",
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
    const body =
      typeof options.body === "string"
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
    out: (chunk) => {
      parts.push(new TextDecoder().decode(chunk));
      return Promise.resolve();
    },
    err: (chunk) => {
      parts.push(new TextDecoder().decode(chunk));
      return Promise.resolve();
    },
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

describe("успешный прогон: exec, стрим, код выхода, уборка", () => {
  let sent: readonly Sent[] = [];
  let text = () => "";
  let code = 0;
  let id = "";
  beforeAll(async () => {
    const answers = {
      create: await fixture("portainer-create-exec.json"),
      inspect: [await fixture("portainer-inspect-exec-done.json")],
    };
    const stand = border(answers);
    const sunk = sink();
    sent = stand.sent;
    text = sunk.text;
    code = await run({
      http: stand.http,
      open: channelOf([data("out\n"), data("err\n")]),
      output: sunk.output,
    });
    id = JSON.parse(answers.create).Id;
  });

  it("код выхода из ответа Portainer, 1:1", () => {
    expect(code).toBe(7);
  });

  it("оба потока пришли одним — следствие Tty", () => {
    expect(text()).toBe("out\nerr\n");
  });

  it("создание exec: адрес, метод, обёртка и Tty", () => {
    const create = sent[0];
    expect(create.url).toBe(
      "https://portainer.example/api/endpoints/4/docker/containers/mp-sl-1-cli/exec",
    );
    expect(create.method).toBe("POST");
    expect(JSON.parse(create.body)).toStrictEqual({
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ["sh", "-c", "echo $$ > /tmp/__MPU_PSSH_PID; exec sh -c 'echo hi'"],
    });
  });

  it("ключ уходит заголовком, проверка TLS выключена", () => {
    expect(sent[0].headers["X-API-Key"]).toBe("секрет");
    expect(sent[0].insecure).toBe(true);
  });

  it("код выхода читается у exec'а", () => {
    expect(sent[1].url).toStrictEqual(
      `https://portainer.example/api/endpoints/4/docker/exec/${id}/json`,
    );
    expect(sent[1].method).toBe("GET");
  });

  it("последним уходит уборка pidfile", () => {
    const last = JSON.parse(sent[sent.length - 1].body);
    expect(last.Cmd).toStrictEqual(["sh", "-c", "rm -f /tmp/__MPU_PSSH_PID"]);
  });
});

describe("stdin: архив в /tmp и редирект в команде", () => {
  let sent: readonly Sent[] = [];
  beforeAll(async () => {
    const stand = border({
      create: await fixture("portainer-create-exec.json"),
      inspect: [await fixture("portainer-inspect-exec-done.json")],
    });
    sent = stand.sent;
    const { output } = sink();
    await run({
      http: stand.http,
      open: channelOf([]),
      output,
      stdin: encoder.encode("тело\n"),
    });
  });

  it("архив уходит PUT'ом до создания exec'а", () => {
    expect(sent[0].url).toBe(
      "https://portainer.example/api/endpoints/4/docker/containers/mp-sl-1-cli/archive?path=/tmp",
    );
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].headers["Content-Type"]).toBe("application/x-tar");
    expect(sent[0].body).toContain("__MPU_PSSH_STDIN");
    expect(sent[0].body).toContain("ustar");
  });

  it("команда читает файл", () => {
    expect(JSON.parse(sent[1].body).Cmd[2]).toBe(
      "echo $$ > /tmp/__MPU_PSSH_PID; exec sh -c 'echo hi < /tmp/__MPU_PSSH_STDIN'",
    );
  });

  it("уборка сносит оба файла", () => {
    expect(JSON.parse(sent[sent.length - 1].body).Cmd[2]).toBe(
      "rm -f /tmp/__MPU_PSSH_PID /tmp/__MPU_PSSH_STDIN",
    );
  });
});

it("пустой stdin: ни архива, ни редиректа", async () => {
  const { http, sent } = border({
    create: await fixture("portainer-create-exec.json"),
    inspect: [await fixture("portainer-inspect-exec-done.json")],
  });
  const { output } = sink();
  await run({ http, open: channelOf([]), output });
  expect(sent.some((call) => call.method === "PUT")).toBe(false);
  expect(JSON.parse(sent[0].body).Cmd[2].includes("__MPU_PSSH_STDIN")).toBe(
    false,
  );
});

describe("ExitCode = null: повторный опрос, потом предупреждение", () => {
  it("дождались завершения — код настоящий", async () => {
    const { http, sent } = border({
      create: await fixture("portainer-create-exec.json"),
      inspect: [
        await fixture("portainer-inspect-exec-running.json"),
        await fixture("portainer-inspect-exec-done.json"),
      ],
    });
    const { output } = sink();
    expect(await run({ http, open: channelOf([]), output })).toBe(7);
    expect(sent.filter((call) => call.url.endsWith("/json")).length).toBe(2);
  });

  it("не дождались — предупреждение и код 1", async () => {
    const { http } = border({
      create: await fixture("portainer-create-exec.json"),
      inspect: [await fixture("portainer-inspect-exec-running.json")],
    });
    const warnings: string[] = [];
    const { output } = sink();
    expect(
      await run({
        http,
        open: channelOf([]),
        output,
        warn: (line) => warnings.push(line),
      }),
    ).toBe(1);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("код выхода");
  });
});

it("Ctrl+C: предупреждение, kill по pidfile, уборка", async () => {
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
      out: async (chunk) => {
        await output.out(chunk);
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
  expect(channel.closed()).toBe(true);
  expect(warnings).toStrictEqual(["mpu: Ctrl+C → killing remote process..."]);
  const kill = JSON.parse(sent[1].body).Cmd[2];
  expect(kill).toContain("cat /tmp/__MPU_PSSH_PID");
  expect(kill).toContain('kill -INT "$pid"');
  expect(kill).toContain("sleep 1");
  expect(kill).toContain('kill -KILL "$pid"');
  // Кода выхода после прерывания не спрашивают: exec оборван.
  expect(sent.some((call) => call.url.endsWith("/json"))).toBe(false);
});

it("отказ Portainer — доменная ошибка, уборка всё равно идёт", async () => {
  const { http, sent } = border({
    create: '{"message":"forbidden"}',
    inspect: [],
    status: 403,
  });
  const { output } = sink();
  const failure = run({ http, open: channelOf([]), output });
  await expect(failure).rejects.toThrow(DomainError);
  await expect(failure).rejects.toThrow("создание exec: Portainer ответил 403");
  // Уборка идёт и здесь: без неё доставленный stdin остался бы лежать
  // в контейнере (спека, п. 8).
  expect(sent.map((call) => call.method)).toStrictEqual(["POST", "POST"]);
  expect(sent[1].body).toContain("rm -f /tmp/__MPU_PSSH_PID");
});

it("отказ создания exec после доставки stdin: уборка сносит оба файла", async () => {
  const { http, sent } = border({
    create: '{"message":"boom"}',
    inspect: [],
    status: 500,
  });
  const { output } = sink();
  await expect(
    run({
      http,
      open: channelOf([]),
      output,
      stdin: encoder.encode("тело\n"),
    }),
  ).rejects.toThrow(DomainError);
  expect(JSON.parse(sent[sent.length - 1].body).Cmd[2]).toBe(
    "rm -f /tmp/__MPU_PSSH_PID /tmp/__MPU_PSSH_STDIN",
  );
});

describe("фоновый запуск: скрипт архивом, exec без Tty, статус не ждём", () => {
  let sent: readonly Sent[] = [];
  let code = 0;
  beforeAll(async () => {
    const stand = border({
      create: await fixture("portainer-create-exec.json"),
      inspect: [await fixture("portainer-inspect-exec-done.json")],
    });
    sent = stand.sent;
    const { output } = sink();
    code = await detachOverPortainer({
      target: TARGET,
      script: "console.log(1)\n",
      scriptPath: "/tmp/mpu-run-0a1b2c3d.mjs",
      logPath: "/tmp/mpu-run-0a1b2c3d.log",
      output,
      warn: () => {},
      http: stand.http,
      open: channelOf([]),
      delay: () => Promise.resolve(),
    });
  });

  it("скрипт уезжает тем же архивом, что и stdin", () => {
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].body).toContain("mpu-run-0a1b2c3d.mjs");
    expect(sent[0].headers["Content-Type"]).toBe("application/x-tar");
  });

  it("запуск — nohup и редирект в лог, без Tty", () => {
    const body = JSON.parse(sent[1].body);
    expect(body.Tty).toBe(false);
    expect(body.Cmd).toStrictEqual([
      "sh",
      "-c",
      "nohup node /tmp/mpu-run-0a1b2c3d.mjs" +
        " > /tmp/mpu-run-0a1b2c3d.log 2>&1 < /dev/null &",
    ]);
  });

  it("код запуска — код exec'а, не удалённой команды", () => {
    expect(code).toBe(7);
  });

  it("строку `mpu: detached` launch-команда не печатает", () => {
    // Статус печатает CLI; дубля в удалённой команде нет и на ssh-пути
    // (отклонение `fix` спеки).
    expect(JSON.parse(sent[1].body).Cmd[2].includes("echo")).toBe(false);
  });
});
