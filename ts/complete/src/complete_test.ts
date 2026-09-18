/**
 * `mpu-complete` (`specs/complete.md`): случаи таблицы на снимке-фикстуре,
 * скрипты подключения — эталоны, bash не режет слово с `:`, отказы и
 * «нет снимка — нет вариантов».
 */

import { assertEquals } from "@std/assert";
import { complete, initScript, runComplete } from "./mod.ts";

const DATA = new URL("testdata/complete/", import.meta.url);
const tree = () => Deno.readTextFile(new URL("tree.json", DATA));

interface Case {
  readonly name: string;
  readonly words: readonly string[];
  readonly output: string;
}

Deno.test("случаи таблицы на снимке-фикстуре", async (t) => {
  const { cases } = JSON.parse(
    await Deno.readTextFile(new URL("cases.json", DATA)),
  ) as { cases: readonly Case[] };
  const snapshot = await tree();
  for (const one of cases) {
    await t.step(one.name, () => {
      assertEquals(complete(one.words, snapshot), one.output);
    });
  }
});

/** Прогон процесса с подставленным чтением снимка. */
async function run(args: readonly string[], snapshot = "") {
  const out: string[] = [];
  const err: string[] = [];
  const read: string[] = [];
  const code = await runComplete(args, {
    snapshotPath: "/home/test/.cache/mpu/tree.json",
    read: (path) => {
      read.push(path);
      return Promise.resolve(snapshot);
    },
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join(""), read };
}

Deno.test("нет снимка или мусор — пусто, код 0", async () => {
  for (
    const snapshot of ["", "{", "[]", '{"nodes": 5}', '{"nodes": [1, "x"]}']
  ) {
    assertEquals(await run(["--", ""], snapshot), {
      code: 0,
      stdout: "",
      stderr: "",
      read: ["/home/test/.cache/mpu/tree.json"],
    });
  }
});

Deno.test("--snapshot заменяет путь; без -- — код 2", async () => {
  const snapshot = await tree();
  const other = await run(["--snapshot", "/tmp/x.json", "--", "ki"], snapshot);
  assertEquals(other.read, ["/tmp/x.json"]);
  assertEquals(other.stdout.startsWith("kiten\t"), true);
  for (
    const args of [[], ["ki"], ["--snapshot", "/x"], ["--что-то", "--", "x"]]
  ) {
    assertEquals(await run(args), {
      code: 2,
      stdout: "",
      stderr: "mpu-complete: нужен -- и слова\n",
      read: [],
    }, args.join(" "));
  }
});

Deno.test("init: bash, fish, nu — эталоны; zsh — код 2; --command", async () => {
  const files = {
    bash: "init-bash.sh",
    fish: "init-fish.fish",
    nu: "init-nu.nu",
  };
  for (const [shell, file] of Object.entries(files)) {
    const printed = await run(["init", shell]);
    assertEquals(printed.code, 0);
    assertEquals(printed.stdout, await Deno.readTextFile(new URL(file, DATA)));
  }
  assertEquals(await run(["init", "zsh"]), {
    code: 2,
    stdout: "",
    stderr: "mpu-complete: оболочка zsh не поддерживается (bash, fish, nu)\n",
    read: [],
  });
  const named = await run(["init", "fish", "--command", "mpu-dev"]);
  assertEquals(named.stdout.includes("complete -c mpu-dev "), true);
});

Deno.test("--version — версия, снимок не читается", async () => {
  assertEquals(await run(["--version"]), {
    code: 0,
    stdout: "0.1.0\n",
    stderr: "",
    read: [],
  });
});

/**
 * bash со скриптом подключения и заглушкой `mpu-complete`: переменные
 * дополнения — как их ставит bash для строки `line` с курсором в конце.
 */
async function bashComplete(line: string, words: string[], answer: string) {
  // Скрипт — из кода, а не эталон: проверяется то, что печатает `init`.
  const script = initScript("bash", "mpu-next");
  const program = `
${script}
mpu-complete() { local IFS=' '; printf '%s\\n' "$*" >&2; printf '${answer}'; }
COMP_LINE=${JSON.stringify(line)}
COMP_POINT=\${#COMP_LINE}
COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(" ")})
COMP_CWORD=${words.length - 1}
_mpu_next_complete
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  const output = await new Deno.Command("/bin/bash", {
    args: ["-c", program],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).split("\n").filter((row) => row !== "");
  return { replies: decode(output.stdout), asked: decode(output.stderr) };
}

Deno.test("bash: слово с «:» не разрезается, ответ — без набранного до «:»", async () => {
  // bash разрезал «seller-id:12» по ':' на три слова.
  const glued = await bashComplete(
    "mpu-next ozon-loader seller-id:12",
    ["mpu-next", "ozon-loader", "seller-id", ":", "12"],
    "seller-id:123\\tописание\\n",
  );
  assertEquals(glued.asked, ["-- ozon-loader seller-id:12"]);
  assertEquals(glued.replies, ["123"]);
  const plain = await bashComplete(
    "mpu-next ki",
    ["mpu-next", "ki"],
    "kiten\\tкарточки\\n",
  );
  assertEquals(plain.asked, ["-- ki"]);
  assertEquals(plain.replies, ["kiten"]);
  const empty = await bashComplete(
    "mpu-next kiten ",
    ["mpu-next", "kiten", ""],
    "card\\tx\\nls\\ty\\n",
  );
  assertEquals(empty.asked, ["-- kiten "]);
  assertEquals(empty.replies, ["card", "ls"]);
});
