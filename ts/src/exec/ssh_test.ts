/**
 * ssh-бэкенд (`platform/exec-transport.md`, «ssh-путь»). Настоящий
 * процесс не запускается: наблюдаемое — аргументы `ssh`, доставленный
 * stdin, поток вывода и код выхода.
 */

import { assertEquals } from "@std/assert";
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
    out: (chunk) => out.push(decoder.decode(chunk)),
    err: (chunk) => err.push(decoder.decode(chunk)),
    captured: () => "",
  };
  return { output, out, err };
}

Deno.test("аргументы ssh: ключ, адрес и одна строка удалённой команды", async (t) => {
  await t.step("несколько элементов квотируются внутри docker exec", () => {
    assertEquals(sshArgs(TARGET, ["ls", "-la", "/app"], KEY), [
      "-i",
      KEY,
      "u@10.0.0.1",
      "docker exec -i mp-sl-1-cli sh -c 'ls -la /app'",
    ]);
  });

  await t.step("единственный элемент — шелл-строка целиком", () => {
    assertEquals(
      sshArgs(TARGET, ["echo out; echo err 1>&2"], KEY)[3],
      `docker exec -i mp-sl-1-cli sh -c 'echo out; echo err 1>&2'`,
    );
  });

  await t.step("кавычка внутри команды не рвёт строку", () => {
    assertEquals(
      sshArgs(TARGET, ["echo", "it's"], KEY)[3],
      `docker exec -i mp-sl-1-cli sh -c 'echo '"'"'it'"'"'"'"'"'"'"'"'s'"'"''`,
    );
  });
});

Deno.test("прогон: stdin доезжает, потоки раздельны, код выхода 1:1", async (t) => {
  const seen: { bin?: string; args?: readonly string[]; stdin?: string } = {};
  const encoder = new TextEncoder();
  const run: RunProcess = (bin, args, stdin, output) => {
    seen.bin = bin;
    seen.args = args;
    seen.stdin = new TextDecoder().decode(stdin);
    output.out(encoder.encode("привет\n"));
    output.err(encoder.encode("ворчание\n"));
    return Promise.resolve(7);
  };
  const { output, out, err } = sink();
  const code = await runOverSsh({
    target: TARGET,
    command: ["cat"],
    stdin: encoder.encode("тело\n"),
    keyPath: KEY,
    output,
    run,
  });

  await t.step("код удалённой команды не подменяется", () => {
    assertEquals(code, 7);
  });

  await t.step("запускается ssh, stdin уходит байтами", () => {
    assertEquals(seen.bin, "ssh");
    assertEquals(seen.stdin, "тело\n");
    assertEquals(seen.args?.[0], "-i");
  });

  await t.step("stdout и stderr не смешиваются", () => {
    assertEquals(out.join(""), "привет\n");
    assertEquals(err.join(""), "ворчание\n");
  });
});

Deno.test("настоящий подпроцесс: потоки и код выхода", async (t) => {
  // Права тестов допускают только эти два бинаря (`deno.jsonc`), и
  // большего здесь не нужно: проверяется сам подпроцесс, а не ssh.
  await t.step("stdout доезжает в приёмник, код 0", async () => {
    const { output, out, err } = sink();
    const code = await spawnProcess(
      "/bin/echo",
      ["проба"],
      new TextEncoder().encode("вход\n"),
      output,
    );
    assertEquals(code, 0);
    assertEquals(out.join(""), "проба\n");
    assertEquals(err.join(""), "");
  });

  await t.step("ненулевой код доходит как есть", async () => {
    const { output } = sink();
    assertEquals(
      await spawnProcess("/bin/false", [], new Uint8Array(), output),
      1,
    );
  });
});

Deno.test("фоновый запуск: заливка скрипта, затем docker exec -d", async (t) => {
  const calls: { remote: string; stdin: string }[] = [];
  const runWith = (codes: readonly number[]): RunProcess => {
    let index = 0;
    return (_bin, argv, stdin) => {
      calls.push({
        remote: argv[3] ?? "",
        stdin: new TextDecoder().decode(stdin),
      });
      return Promise.resolve(codes[index++] ?? 0);
    };
  };

  await t.step("две команды по порядку, скрипт на stdin первой", async () => {
    calls.length = 0;
    const { output } = sink();
    const code = await detachOverSsh({
      target: TARGET,
      script: "console.log(1)\n",
      scriptPath: "/tmp/mpu-run-0a1b2c3d.mjs",
      logPath: "/tmp/mpu-run-0a1b2c3d.log",
      keyPath: KEY,
      output,
      run: runWith([0, 0]),
    });
    assertEquals(code, 0);
    assertEquals(calls.length, 2);
    assertEquals(
      calls[0].remote,
      "docker exec -i mp-sl-1-cli sh -c 'cat > /tmp/mpu-run-0a1b2c3d.mjs'",
    );
    assertEquals(calls[0].stdin, "console.log(1)\n");
    assertEquals(
      calls[1].remote,
      "docker exec -d mp-sl-1-cli sh -c 'node /tmp/mpu-run-0a1b2c3d.mjs" +
        " > /tmp/mpu-run-0a1b2c3d.log 2>&1 < /dev/null'",
    );
    assertEquals(calls[1].stdin, "");
  });

  await t.step("залить не удалось — стартовать нечего", async () => {
    calls.length = 0;
    const { output } = sink();
    const code = await detachOverSsh({
      target: TARGET,
      script: "x",
      scriptPath: "/tmp/s.mjs",
      logPath: "/tmp/s.log",
      keyPath: KEY,
      output,
      run: runWith([3]),
    });
    assertEquals(code, 3);
    assertEquals(calls.length, 1);
  });
});
