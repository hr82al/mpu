/**
 * Команда `mpu mp-clone` (`docs/specs/mp-clone.md`, «Сценарии C1»).
 *
 * Корень — временный `HOME`, диск настоящий. Подпроцессы подменены:
 * подменный shell пишет вызовы и отвечает по «Дано», а действия,
 * меняющие диск (`clone`, `checkout`, `cp`, `mkdir`, `rm`), исполняет
 * над временным каталогом сам — иначе не проверить, что пустышка
 * пережила клон и что второй прогон ничего не пишет. Настоящие git,
 * ssh, `~/.ssh` и `~/mr/mp` не трогаются.
 */

import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import { UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runMpClone } from "./cmd_mp_clone.ts";
import type { Clock, ProcessOutcome, Shell } from "./ports.ts";
import { systemDisk } from "./ports.ts";

const STAMP = "20260926-120000";
const clock: Clock = { stamp: () => STAMP };
const SHA = "abc1234";
/** Отпечаток подменного ключа — от порта, как в спеке. */
const PRINT = "SHA256:fAkEpRiNt";
/** Файл, который checkout подменного клона кладёт в каждый субрепо. */
const TRACKED = { ".env.example": "UPSTREAM=1\n", "README.md": "readme\n" };
const NOT_FOUND = "ERROR: The project you were looking for could not be " +
  "found or you don't have permission to view it.\n\n" +
  "fatal: Could not read from remote repository.\n";
const REFUSED = "ssh: connect to host gitlab.btlz-api.ru port 2222: " +
  "Connection refused\r\nfatal: Could not read from remote repository.\n";

const ok = (stdout = ""): ProcessOutcome => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 128): ProcessOutcome => ({
  code,
  stdout: "",
  stderr,
});

/** Ответ по «Дано»; `undefined` — ответ по умолчанию. */
type Answer = (argv: readonly string[]) => ProcessOutcome | undefined;

/** Имя субрепо из адреса `ssh://…/wb/<имя>.git`. */
function repoOf(argv: readonly string[]): string {
  const url = argv.find((word) => word.startsWith("ssh://")) ?? "";
  return url.slice(url.lastIndexOf("/") + 1, -".git".length);
}

/**
 * Подменный shell: ключ есть, на сервере всё, кроме
 * `mp-support-scripts-old`, личность git задана.
 */
class FakeShell implements Shell {
  readonly calls: string[][] = [];

  constructor(
    private readonly root: string,
    private readonly answer: Answer = () => undefined,
  ) {}

  async run(argv: readonly string[]): Promise<ProcessOutcome> {
    this.calls.push([...argv]);
    return this.answer(argv) ?? await this.act(argv);
  }

  /** Вызовы, начинающиеся с этих слов. */
  called(...head: string[]): string[][] {
    return this.calls.filter((argv) =>
      head.every((word, i) => argv[i] === word)
    );
  }

  private async act(argv: readonly string[]): Promise<ProcessOutcome> {
    const [bin, ...rest] = argv;
    if (bin === "ssh-keygen") return ok();
    if (bin === "mkdir") {
      await mkdir(rest[1], { recursive: true });
      return ok();
    }
    if (bin === "cp") {
      await copyTree(rest[1], rest[2]);
      return ok();
    }
    if (bin === "rm") {
      await rm(rest[1], { recursive: true });
      return ok();
    }
    return await this.git(rest);
  }

  private async git(args: readonly string[]): Promise<ProcessOutcome> {
    if (args[0] === "ls-remote") {
      return repoOf(args) === "mp-support-scripts-old"
        ? fail(NOT_FOUND)
        : ok(`${SHA}\tHEAD\n`);
    }
    if (args[0] === "clone") {
      await mkdir(`${args.at(-1)}/.git`, { recursive: true });
      if (!args.includes("--no-checkout")) await checkout(args.at(-1) ?? "");
      return ok();
    }
    if (args[0] === "config") return ok("Operator\n");
    const dir = args[1];
    if (args.includes("checkout")) {
      await checkout(dir);
      return ok();
    }
    if (args.includes("--show-toplevel")) {
      return ok(`${await topOf(dir, this.root)}\n`);
    }
    return ok(args.includes("--short") ? `${SHA}\n` : "main\n");
  }
}

/** Как git: каталог со своим `.git` — он сам, иначе корень `mp`. */
async function topOf(dir: string, root: string): Promise<string> {
  try {
    await stat(`${dir}/.git`);
    return await realpath(dir);
  } catch {
    return await realpath(root);
  }
}

async function checkout(dir: string): Promise<void> {
  for (const [name, text] of Object.entries(TRACKED)) {
    await writeFile(`${dir}/${name}`, text);
  }
}

/** `cp -a`: файл или дерево целиком. */
async function copyTree(from: string, to: string): Promise<void> {
  const info = await stat(from);
  if (info.isFile()) return await copyFile(from, to);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    await copyTree(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}

/** Снимок дерева: путь → содержимое; каталоги — пустой строкой. */
async function snapshot(
  dir: string,
  prefix = "",
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    const path = `${dir}/${entry.name}`;
    if (entry.isFile()) found.set(rel, await readFile(path, "utf8"));
    if (!entry.isDirectory()) continue;
    found.set(`${rel}/`, "");
    for (const [key, text] of await snapshot(path, `${rel}/`)) {
      found.set(key, text);
    }
  }
  return found;
}

const WORKSPACE = JSON.stringify({
  folders: [
    { path: "." },
    { path: "sl-back" },
    { path: "sw-front" },
    { path: "mp-support-scripts-old" },
  ],
});

const GITIGNORE = `# head
# Detected subrepos:
/code-index/

# tail
.env
`;

interface Stand {
  readonly home: string;
  readonly root: string;
}

/** Временный `HOME` с корнем `mp`, workspace и `.gitignore`. */
async function withStand(
  body: (stand: Stand) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mpu-"));
  const root = `${home}/mr/mp`;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/.gitignore`, GITIGNORE);
    await writeFile(`${root}/mp.code-workspace`, WORKSPACE);
    await body({ home, root });
  } finally {
    await rm(home, { recursive: true });
  }
}

interface Outcome {
  readonly lines: readonly string[];
  readonly code: number;
}

async function run(
  stand: Stand,
  shell: Shell,
  dryRun = false,
): Promise<Outcome> {
  const lines: string[] = [];
  const io = makeFakeIo({
    env: (name) => name === "HOME" ? stand.home : undefined,
    progress: (line) => void lines.push(line),
  });
  const result = await runMpClone({ "dry-run": dryRun }, io, {
    shell,
    disk: systemDisk,
    clock,
  });
  return { lines, code: result.exitCode };
}

const C1_LINES = [
  `склонирован: sl-back (main ${SHA})`,
  `склонирован: sw-front (main ${SHA})`,
  "нет на сервере: mp-support-scripts-old",
  `склонирован: mp-config-local (main ${SHA})`,
  `склонирован: ai-tools (main ${SHA})`,
  `склонирован: opiu-service (main ${SHA})`,
  "в mp не закоммичено: .gitignore",
  "mp-clone: 5 склонировано, 0 уже было, 1 нет на сервере",
];

it("C1: каталогов нет — клон каждого, итог", () =>
  withStand(async (stand) => {
    const shell = new FakeShell(stand.root);
    expect(await run(stand, shell)).toStrictEqual({ lines: C1_LINES, code: 0 });
    expect(shell.called("git", "clone").map((argv) => argv.slice(2)))
      .toStrictEqual(
        ["sl-back", "sw-front", "mp-config-local", "ai-tools", "opiu-service"]
          .map((name) => [
            `ssh://git@gitlab.btlz-api.ru:2222/wb/${name}.git`,
            `${stand.root}/${name}`,
          ]),
      );
  }));

it("C2: второй прогон подряд — ни клона, ни записи", () =>
  withStand(async (stand) => {
    await run(stand, new FakeShell(stand.root));
    const before = await snapshot(stand.home);
    const shell = new FakeShell(stand.root);
    expect(await run(stand, shell)).toStrictEqual({
      lines: [
        `уже есть: sl-back (main ${SHA})`,
        `уже есть: sw-front (main ${SHA})`,
        "нет на сервере: mp-support-scripts-old",
        `уже есть: mp-config-local (main ${SHA})`,
        `уже есть: ai-tools (main ${SHA})`,
        `уже есть: opiu-service (main ${SHA})`,
        "mp-clone: 0 склонировано, 5 уже было, 1 нет на сервере",
      ],
      code: 0,
    });
    expect(shell.called("git", "clone")).toStrictEqual([]);
    expect(await snapshot(stand.home)).toStrictEqual(before);
  }));

it("C3: ключа нет — отказ с отпечатком, ~/.ssh не тронут", () =>
  withStand(async (stand) => {
    const shell = new FakeShell(stand.root, (argv) => {
      if (argv[1] === "-F") return fail("", 1);
      if (argv[0] === "ssh-keyscan") {
        return ok("[gitlab.btlz-api.ru]:2222 ssh-ed25519 AAAAfake\n");
      }
      if (argv[1] === "-lf") {
        return ok(`256 ${PRINT} [gitlab.btlz-api.ru]:2222 (ED25519)\n`);
      }
      return undefined;
    });
    expect(await run(stand, shell)).toStrictEqual({
      lines: [
        "mpu mp-clone: ключа gitlab.btlz-api.ru:2222 нет в known_hosts — " +
        `отпечаток ${PRINT}; принять: ssh-keyscan -p 2222 ` +
        "gitlab.btlz-api.ru >> ~/.ssh/known_hosts",
      ],
      code: 3,
    });
    expect(shell.called("git", "ls-remote")).toStrictEqual([]);
    expect(shell.calls.filter((argv) => argv.some((w) => w.includes(".ssh"))))
      .toStrictEqual([]);
    expect(await exists(`${stand.home}/.ssh`)).toBeFalsy();
  }));

it("C4: пустышка — копия, клон поверх, правленый файл возвращён", () =>
  withStand(async (stand) => {
    const dummy = `${stand.root}/sw-front`;
    await mkdir(`${dummy}/src`, { recursive: true });
    await writeFile(`${dummy}/.env`, "LOCAL=1\n");
    await writeFile(`${dummy}/.env.example`, "MINE=1\n");
    const shell = new FakeShell(stand.root);
    const backup = `${stand.home}/tmp/mp-clone-backup/${STAMP}/sw-front`;
    const { lines, code } = await run(stand, shell);
    expect(code).toBe(0);
    expect(lines.slice(1, 3)).toStrictEqual([
      `поверх пустышки: sw-front, копия ${backup}`,
      "восстановлен локальный: sw-front/.env.example",
    ]);
    expect(await readFile(`${dummy}/.env`, "utf8")).toBe("LOCAL=1\n");
    expect(await readFile(`${dummy}/.env.example`, "utf8")).toBe("MINE=1\n");
    expect(await readFile(`${dummy}/README.md`, "utf8")).toBe("readme\n");
    assert(await exists(`${dummy}/.git`));
    expect(await readFile(`${backup}/.env.example`, "utf8")).toBe("MINE=1\n");
    // Копия снята до первой записи в каталог.
    const order = shell.calls.map((argv) => argv.join(" "));
    assert(
      order.indexOf(`cp -a ${dummy} ${backup}`) <
        order.findIndex((line) => line.includes(`${dummy}/.git`)),
    );
  }));

it("C5: ошибка сети ls-remote — не «нет на сервере», exit 1", () =>
  withStand(async (stand) => {
    const shell = new FakeShell(
      stand.root,
      (argv) =>
        argv[1] === "ls-remote" && repoOf(argv) === "sl-back"
          ? fail(REFUSED)
          : undefined,
    );
    expect(await run(stand, shell)).toStrictEqual({
      lines: [
        "mpu mp-clone: sl-back — git ls-remote: ssh: connect to host " +
        "gitlab.btlz-api.ru port 2222: Connection refused",
      ],
      code: 1,
    });
    expect(shell.called("git", "clone")).toStrictEqual([]);
  }));

it("C6: клон поверх упал после переноса .git — каталог как был", () =>
  withStand(async (stand) => {
    const dummy = `${stand.root}/sw-front`;
    await mkdir(`${dummy}/src`, { recursive: true });
    await writeFile(`${dummy}/.env`, "LOCAL=1\n");
    await writeFile(`${dummy}/.env.example`, "MINE=1\n");
    const before = await snapshot(dummy);
    const shell = new FakeShell(
      stand.root,
      (argv) => argv.includes("checkout") ? fail("error: checkout") : undefined,
    );
    const backup = `${stand.home}/tmp/mp-clone-backup/${STAMP}/sw-front`;
    const { lines, code } = await run(stand, shell);
    expect(code).toBe(1);
    expect(lines.at(-1)).toStrictEqual(
      "mpu mp-clone: sw-front — clone упал, каталог восстановлен из копии " +
        backup,
    );
    expect(await snapshot(dummy)).toStrictEqual(before);
  }));

it("C6: не удалось и восстановить — путь копии в отказе", () =>
  withStand(async (stand) => {
    await mkdir(`${stand.root}/sw-front`, { recursive: true });
    await writeFile(`${stand.root}/sw-front/.env`, "LOCAL=1\n");
    const shell = new FakeShell(stand.root, (argv) => {
      if (argv.includes("checkout")) return fail("error: checkout");
      return argv[0] === "rm" ? fail("rm: busy", 1) : undefined;
    });
    const backup = `${stand.home}/tmp/mp-clone-backup/${STAMP}/sw-front`;
    const { lines, code } = await run(stand, shell);
    expect(code).toBe(1);
    expect(lines.at(-1)).toStrictEqual(
      "mpu mp-clone: sw-front — rm -rf: rm: busy; каталог не восстановлен " +
        `— копия ${backup}`,
    );
  }));

it("C7: нет сентинела — создан пустым", () =>
  withStand(async (stand) => {
    await run(stand, new FakeShell(stand.root));
    expect(await readFile(`${stand.root}/.mp-workspace-root`, "utf8")).toBe("");
  }));

it("C8: строки субрепо — в блок «Detected subrepos»", () =>
  withStand(async (stand) => {
    await run(stand, new FakeShell(stand.root));
    expect(await readFile(`${stand.root}/.gitignore`, "utf8")).toBe(`# head
# Detected subrepos:
/code-index/
/sl-back/
/sw-front/
/mp-config-local/
/ai-tools/
/opiu-service/

# tail
.env
`);
  }));

it("C8: нет .gitignore — файл с одним блоком", () =>
  withStand(async (stand) => {
    await rm(`${stand.root}/.gitignore`);
    await run(stand, new FakeShell(stand.root));
    expect(await readFile(`${stand.root}/.gitignore`, "utf8")).toStrictEqual(
      "# Detected subrepos:\n/sl-back/\n/sw-front/\n/mp-config-local/\n" +
        "/ai-tools/\n/opiu-service/\n",
    );
  }));

it("C9: нет личности git — предупреждение, конфиг не тронут", () =>
  withStand(async (stand) => {
    const shell = new FakeShell(
      stand.root,
      (argv) => argv[1] === "config" ? fail("", 1) : undefined,
    );
    const { lines, code } = await run(stand, shell);
    expect(code).toBe(0);
    assert(lines.includes(
      "warning: нет личности git — git config --global user.name … && " +
        "git config --global user.email …",
    ));
    expect(shell.called("git", "config").map((argv) => argv.slice(2)))
      .toStrictEqual([["--global", "--get", "user.name"]]);
  }));

it("C10: dry — план с префиксом, ls-remote есть, записей нет", () =>
  withStand(async (stand) => {
    const before = await snapshot(stand.home);
    const shell = new FakeShell(stand.root);
    expect(await run(stand, shell, true)).toStrictEqual({
      lines: [
        "план: склонирован: sl-back",
        "план: склонирован: sw-front",
        "план: нет на сервере: mp-support-scripts-old",
        "план: склонирован: mp-config-local",
        "план: склонирован: ai-tools",
        "план: склонирован: opiu-service",
        "план: в mp не закоммичено: .gitignore",
        "план: mp-clone: 5 склонировано, 0 уже было, 1 нет на сервере",
        "dry-run: ничего не выполнено",
      ],
      code: 0,
    });
    expect(shell.called("git", "ls-remote").length).toBe(6);
    expect(shell.called("git", "clone")).toStrictEqual([]);
    expect(await snapshot(stand.home)).toStrictEqual(before);
  }));

it("C11: нет mp.code-workspace — ошибка ввода с путём", () =>
  withStand(async (stand) => {
    await rm(`${stand.root}/mp.code-workspace`);
    const shell = new FakeShell(stand.root);
    const err = await run(stand, shell).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert(err instanceof UsageError);
    expect(err.message).toStrictEqual(`нет ${stand.root}/mp.code-workspace`);
    expect(shell.calls).toStrictEqual([]);
  }));

it("C13: каталог со своим .git — «уже есть», ни fetch, ни checkout", () =>
  withStand(async (stand) => {
    await writeFile(
      `${stand.root}/mp.code-workspace`,
      JSON.stringify({ folders: [{ path: "." }, { path: "mpu" }] }),
    );
    await mkdir(`${stand.root}/mpu/.git`, { recursive: true });
    const shell = new FakeShell(stand.root);
    const { lines, code } = await run(stand, shell);
    expect(code).toBe(0);
    expect(lines[0]).toStrictEqual(`уже есть: mpu (main ${SHA})`);
    const touched = shell.calls.filter((argv) =>
      argv.includes(`${stand.root}/mpu`)
    );
    expect(touched.map((argv) => argv.slice(3))).toStrictEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--short", "HEAD"],
    ]);
  }));

it("всё склонировано — к серверу не ходит, ключ не нужен", () =>
  withStand(async (stand) => {
    await writeFile(
      `${stand.root}/mp.code-workspace`,
      JSON.stringify({ folders: [{ path: "." }] }),
    );
    for (const name of ["mp-config-local", "ai-tools", "opiu-service"]) {
      await mkdir(`${stand.root}/${name}/.git`, { recursive: true });
    }
    const shell = new FakeShell(stand.root);
    expect((await run(stand, shell)).code).toBe(0);
    expect(shell.called("ssh-keygen")).toStrictEqual([]);
    expect(shell.called("git", "ls-remote")).toStrictEqual([]);
  }));

it("упал git clone — exit 1 с текстом git, дальше не идёт", () =>
  withStand(async (stand) => {
    const shell = new FakeShell(
      stand.root,
      (argv) =>
        argv[1] === "clone" && repoOf(argv) === "sw-front"
          ? fail("fatal: early EOF\n")
          : undefined,
    );
    const { lines, code } = await run(stand, shell);
    expect(code).toBe(1);
    expect(lines).toStrictEqual([
      `склонирован: sl-back (main ${SHA})`,
      "mpu mp-clone: sw-front — git clone: fatal: early EOF",
    ]);
    expect(shell.called("git", "clone").length).toBe(2);
    expect(await exists(`${stand.root}/.mp-workspace-root`)).toBeFalsy();
  }));

describe("workspace без folders и без HOME — ошибка ввода", () => {
  it("мусор в mp.code-workspace", () =>
    withStand(async (stand) => {
      await writeFile(`${stand.root}/mp.code-workspace`, "{oops");
      const err = await run(stand, new FakeShell(stand.root)).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      assert(err instanceof UsageError);
      expect(err.message).toStrictEqual(
        `${stand.root}/mp.code-workspace: нет списка folders[].path`,
      );
    }));
  it("HOME не задан", async () => {
    const err = await runMpClone(
      { "dry-run": false },
      makeFakeIo({ env: () => undefined }),
      { shell: new FakeShell("/nowhere"), disk: systemDisk, clock },
    ).then(() => undefined, (caught: unknown) => caught);
    assert(err instanceof UsageError);
    expect(err.message).toBe("корень mp не найден: HOME не задан");
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
