/**
 * ssh-бэкенд (`platform/exec-transport.md`, «ssh-путь»). Настоящий
 * процесс не запускается: наблюдаемое — аргументы `ssh`, доставленный
 * stdin, поток вывода и код выхода.
 */

import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteOutput } from "../command/mod.ts";
import {
  detachOverSsh,
  runOverSsh,
  type RunProcess,
  spawnProcess,
  sshArgs,
  type SshTarget,
} from "./ssh.ts";

const TARGET: SshTarget = {
  kind: "ssh",
  host: "10.0.0.1",
  user: "u",
  container: "mp-sl-1-cli",
};

const KEY = "/home/u/.ssh/id_rsa";

/** Приёмник, копящий оба потока раздельно. */
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  const decoder = new TextDecoder();
  const output: RemoteOutput = {
    out: (chunk) => {
      out.push(decoder.decode(chunk));
      return Promise.resolve();
    },
    err: (chunk) => {
      err.push(decoder.decode(chunk));
      return Promise.resolve();
    },
    captured: () => "",
  };
  return { output, out, err };
}

describe("аргументы ssh: ключ, адрес и одна строка удалённой команды", () => {
  it("несколько элементов квотируются внутри docker exec", () => {
    expect(sshArgs(TARGET, ["ls", "-la", "/app"], KEY)).toStrictEqual([
      "-i",
      KEY,
      "u@10.0.0.1",
      "docker exec -i mp-sl-1-cli sh -c 'ls -la /app'",
    ]);
  });

  it("единственный элемент — шелл-строка целиком", () => {
    expect(sshArgs(TARGET, ["echo out; echo err 1>&2"], KEY)[3]).toBe(
      `docker exec -i mp-sl-1-cli sh -c 'echo out; echo err 1>&2'`,
    );
  });

  it("кавычка внутри команды не рвёт строку", () => {
    expect(sshArgs(TARGET, ["echo", "it's"], KEY)[3]).toBe(
      `docker exec -i mp-sl-1-cli sh -c 'echo '"'"'it'"'"'"'"'"'"'"'"'s'"'"''`,
    );
  });
});

describe("прогон: stdin доезжает, потоки раздельны, код выхода 1:1", () => {
  const seen: {
    bin?: string;
    args?: readonly string[];
    stdin?: string;
    cwd?: string;
  } = {};
  const encoder = new TextEncoder();
  const run: RunProcess = (bin, args, proc) => {
    seen.bin = bin;
    seen.args = args;
    seen.stdin = new TextDecoder().decode(proc.stdin);
    seen.cwd = proc.cwd;
    proc.output.out(encoder.encode("привет\n"));
    proc.output.err(encoder.encode("ворчание\n"));
    return Promise.resolve(7);
  };
  const { output, out, err } = sink();
  let code = 0;
  beforeAll(async () => {
    code = await runOverSsh({
      target: TARGET,
      command: ["cat"],
      stdin: encoder.encode("тело\n"),
      keyPath: KEY,
      output,
      cwd: "/каталог/вызывающего",
      run,
    });
  });

  it("код удалённой команды не подменяется", () => {
    expect(code).toBe(7);
  });

  it("запускается ssh, stdin уходит байтами", () => {
    expect(seen.bin).toBe("ssh");
    expect(seen.stdin).toBe("тело\n");
    expect(seen.args?.[0]).toBe("-i");
  });

  it("каталог вызывающего доезжает до запуска", () => {
    expect(seen.cwd).toBe("/каталог/вызывающего");
  });

  it("stdout и stderr не смешиваются", () => {
    expect(out.join("")).toBe("привет\n");
    expect(err.join("")).toBe("ворчание\n");
  });
});

describe("настоящий подпроцесс: потоки и код выхода", () => {
  // Двух бинарей здесь достаточно: проверяется сам подпроцесс, а не ssh.
  it("stdout доезжает в приёмник, код 0", async () => {
    const { output, out, err } = sink();
    const code = await spawnProcess("/bin/echo", ["проба"], {
      stdin: new TextEncoder().encode("вход\n"),
      output,
      cwd: process.cwd(),
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe("проба\n");
    expect(err.join("")).toBe("");
  });

  it("подпроцесс стартует в переданном каталоге", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpu-"));
    try {
      const { output, out } = sink();
      const code = await spawnProcess("/bin/bash", ["-c", "pwd"], {
        stdin: new Uint8Array(),
        output,
        cwd: dir,
      });
      expect(code).toBe(0);
      // `pwd` печатает разрешённый путь: у временного каталога он
      // может отличаться от выданного символьной ссылкой (`/tmp`).
      expect(out.join("").trim()).toStrictEqual(await realpath(dir));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("просьба остановиться снимает подпроцесс", async () => {
    const { output } = sink();
    const stopping = new AbortController();
    const done = spawnProcess("/bin/bash", ["-c", "exec sleep 60"], {
      stdin: new Uint8Array(),
      output,
      cwd: process.cwd(),
      signal: stopping.signal,
      killAfterMs: 50,
    });
    // `exec` обязателен: без него `bash` форкнул бы `sleep`, `SIGTERM`
    // снял бы оболочку, а `sleep` осиротел бы — тест был бы зелёным
    // при настоящей утечке.
    stopping.abort();
    // Код 128 + SIGTERM: подпроцесс не доработал, его сняли. Сам факт,
    // что `status` разрешился, и значит «процесса больше нет»:
    // неубитый `sleep 60` держал бы вызов целую минуту.
    expect(await done).toBe(143);
  });

  it("не ушёл по SIGTERM — снимается по сроку", async () => {
    // Просьба посылается не раньше, чем подпроцесс сказал, что готов:
    // иначе `SIGTERM` пришёл бы до того, как он перехватил сигнал, и
    // проверялся бы не тот путь.
    const ready = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    const output = {
      out: (chunk: Uint8Array) => {
        if (decoder.decode(chunk).includes("готов")) ready.resolve();
        return Promise.resolve();
      },
      err: () => Promise.resolve(),
      captured: () => "",
    };
    const stopping = new AbortController();
    // Тест упал по сроку раньше `abort` — потомок, глушащий `SIGTERM`, не
    // должен пережить его.
    onTestFinished(() => stopping.abort());
    // Подпроцесс, который `SIGTERM` не берёт: свой обработчик сигнала
    // отменяет умолчание. У `bash` тот же приём не годится — `trap ""`
    // в этом окружении подпроцесс всё равно снимает (замер).
    const done = spawnProcess(
      "deno",
      [
        "eval",
        "--no-lock",
        'process.on("SIGTERM", () => {});' +
        ' console.log("готов"); await new Promise(() => {});',
      ],
      {
        stdin: new Uint8Array(),
        output,
        cwd: process.cwd(),
        signal: stopping.signal,
        // Срок — параметр: тест не ждёт пять секунд, а называет свой.
        killAfterMs: 50,
      },
    );
    await ready.promise;
    stopping.abort();
    // `SIGTERM` перехвачен и ничего не делает, поэтому по сроку
    // приходит `SIGKILL`: 128 + 9.
    expect(await done).toBe(137);
  });

  it("сигнал взведён до старта: подпроцесс не переживает вызов", async () => {
    const { output } = sink();
    const stopping = new AbortController();
    stopping.abort();
    // Подписка на уже взведённый сигнал события не увидит — просьба
    // обязана дойти и до подпроцесса, запущенного после неё.
    expect(
      await spawnProcess("/bin/bash", ["-c", "exec sleep 60"], {
        stdin: new Uint8Array(),
        output,
        cwd: process.cwd(),
        signal: stopping.signal,
        killAfterMs: 50,
      }),
    ).toBe(143);
  });

  it("ненулевой код доходит как есть", async () => {
    const { output } = sink();
    expect(
      await spawnProcess("/bin/false", [], {
        stdin: new Uint8Array(),
        output,
        cwd: process.cwd(),
      }),
    ).toBe(1);
  });
});

describe("фоновый запуск: заливка скрипта, затем docker exec -d", () => {
  const calls: { remote: string; stdin: string }[] = [];
  const runWith = (codes: readonly number[]): RunProcess => {
    let index = 0;
    return (_bin, argv, proc) => {
      calls.push({
        remote: argv[3] ?? "",
        stdin: new TextDecoder().decode(proc.stdin),
      });
      return Promise.resolve(codes[index++] ?? 0);
    };
  };

  it("две команды по порядку, скрипт на stdin первой", async () => {
    calls.length = 0;
    const { output } = sink();
    const code = await detachOverSsh({
      cwd: "/каталог/вызывающего",
      target: TARGET,
      script: "console.log(1)\n",
      scriptPath: "/tmp/mpu-run-0a1b2c3d.mjs",
      logPath: "/tmp/mpu-run-0a1b2c3d.log",
      keyPath: KEY,
      output,
      run: runWith([0, 0]),
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls[0].remote).toBe(
      "docker exec -i mp-sl-1-cli sh -c 'cat > /tmp/mpu-run-0a1b2c3d.mjs'",
    );
    expect(calls[0].stdin).toBe("console.log(1)\n");
    expect(calls[1].remote).toStrictEqual(
      "docker exec -d mp-sl-1-cli sh -c 'node /tmp/mpu-run-0a1b2c3d.mjs" +
        " > /tmp/mpu-run-0a1b2c3d.log 2>&1 < /dev/null'",
    );
    expect(calls[1].stdin).toBe("");
  });

  it("залить не удалось — стартовать нечего", async () => {
    calls.length = 0;
    const { output } = sink();
    const code = await detachOverSsh({
      cwd: "/каталог/вызывающего",
      target: TARGET,
      script: "x",
      scriptPath: "/tmp/s.mjs",
      logPath: "/tmp/s.log",
      keyPath: KEY,
      output,
      run: runWith([3]),
    });
    expect(code).toBe(3);
    expect(calls.length).toBe(1);
  });
});
