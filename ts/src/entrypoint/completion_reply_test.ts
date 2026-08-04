/**
 * Формат ответа режима дополнения (`platform/registry.md`, «Режим
 * дополнения») против эталонов, снятых с живой реализации.
 *
 * Сверка байтовая: это внешняя граница, и ответ для zsh **исполняется**
 * как код — вольность в формате ломает дополнение молча.
 *
 * Два эталона (`completion-out-bash-flags`, `completion-out-zsh-nested`)
 * сняты на дереве, где `xlsx` ещё был командой маршрута `legacy`.
 * Поэтому формат на них проверяется на данных слепка, а фактический
 * вывод переехавшего `xlsx` — отдельно, по свойству: описания и порядок
 * теперь берутся из объявления команд, и это следствие переезда.
 */

import { assertEquals } from "@std/assert";
import { completionReply } from "./completion.ts";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { readManifest } from "../mcp/legacy_tools.ts";
import treeManifest from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

const golden = (name: string) =>
  Deno.readTextFile(
    new URL(`../registry/testdata/${name}.txt`, import.meta.url),
  );

/** Прогон режима дополнения: переменные shell подставляются целиком. */
async function complete(env: Readonly<Record<string, string>>) {
  const out: string[] = [];
  const code = await runCli([], makeFakeIo({ env: (name) => env[name] }), {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });
  return { code, stdout: out.join("") };
}

/** Подкоманды `xlsx` в слепке: имя и однострока, в порядке слепка. */
function snapshotXlsxChildren(): readonly { name: string; summary: string }[] {
  const children: { name: string; summary: string }[] = [];
  for (const leaf of readManifest(treeManifest).commands) {
    if (leaf.path[0] !== "xlsx" || leaf.path.length < 2) continue;
    const name = leaf.path[1];
    if (children.some((child) => child.name === name)) continue;
    children.push({ name, summary: leaf.summary });
  }
  return children;
}

Deno.test("completion-out-bash.txt: по варианту на строку", async () => {
  const { code, stdout } = await complete({
    _MPU_COMPLETE: "complete_bash",
    COMP_WORDS: "mpu sq",
    COMP_CWORD: "1",
  });
  assertEquals(code, 0);
  assertEquals(stdout, await golden("completion-out-bash"));
});

Deno.test("completion-out-zsh.txt: _arguments с описаниями", async () => {
  const { stdout } = await complete({
    _MPU_COMPLETE: "complete_zsh",
    _TYPER_COMPLETE_ARGS: "mpu sq",
  });
  assertEquals(stdout, await golden("completion-out-zsh"));
});

Deno.test("completion-out-zsh-nested.txt: вложенный уровень", async (t) => {
  const fixture = await golden("completion-out-zsh-nested");
  const reply = completionReply("zsh", snapshotXlsxChildren());

  await t.step("обёртка _arguments и разбиение по строкам", () => {
    assertEquals(reply.startsWith(`_arguments '*: :((`), true);
    assertEquals(reply.endsWith(`))'\n`), true);
    assertEquals(reply.split("\n").length, fixture.split("\n").length);
  });

  await t.step("пары, выводимые из слепка, — байт в байт", () => {
    // Описания подкоманд слепок несёт, описания группы `alias` — нет:
    // у составного имени своей однострокѝ в слепке не бывает (то же
    // ограничение, что при сборке реестра). Поэтому строка `alias`
    // сверяется отдельно, по имени.
    const mine = reply.split("\n");
    const theirs = fixture.split("\n");
    for (let index = 0; index < theirs.length; index++) {
      if (theirs[index].startsWith(`"alias"`)) continue;
      assertEquals(mine[index], theirs[index], `строка ${index}`);
    }
    assertEquals(mine[4].startsWith(`"alias":"`), true);
  });
});

Deno.test("completion-out-bash-flags.txt: флаги уровня", async (t) => {
  await t.step("формат — по флагу на строку", async () => {
    const flags = [
      "--file",
      "--sheet",
      "--from",
      "--render",
      "--json",
      "--raw",
      "--tsv",
      "--help",
    ].map((name) => ({ name, summary: "" }));
    assertEquals(
      completionReply("bash", flags),
      await golden("completion-out-bash-flags"),
    );
  });

  await t.step("фактический вывод xlsx get: тот же набор", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu xlsx get -",
      COMP_CWORD: "3",
    });
    const mine = stdout.split("\n").filter(Boolean);
    const fixture = (await golden("completion-out-bash-flags"))
      .split("\n").filter(Boolean);
    // Набор совпадает; порядок — объявления команды, а не Python-версии.
    assertEquals([...mine].sort(), [...fixture].sort());
  });
});

Deno.test("значения перечислений не дополняются", async () => {
  const { stdout } = await complete({
    _MPU_COMPLETE: "complete_bash",
    COMP_WORDS: "mpu xlsx get --render ",
    COMP_CWORD: "4",
  });
  assertEquals(stdout, "");
});

Deno.test("флаги берутся из того же источника, что и справка", async (t) => {
  await t.step("команда маршрута legacy — из слепка", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu sql-ro -",
      COMP_CWORD: "2",
    });
    const flags = stdout.split("\n").filter(Boolean);
    const leaf = readManifest(treeManifest).commands.find(
      (item) => item.path.join(" ") === "sql-ro",
    );
    const expected = (leaf?.params ?? [])
      .filter((param) => param.kind === "option")
      .map((param) =>
        param.opts?.find((opt) => opt.startsWith("--")) ?? `--${param.name}`
      );
    // Ровно объявленные в слепке флаги плюс общий `--help`.
    assertEquals(flags, [...expected, "--help"]);
  });

  await t.step("уровень-группа — только общий --help", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu xlsx -",
      COMP_CWORD: "2",
    });
    assertEquals(stdout.split("\n").filter(Boolean), ["--help"]);
  });

  await t.step("описания флагов пусты: подсказка — имя флага", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_zsh",
      _TYPER_COMPLETE_ARGS: "mpu sql-ro --d",
    });
    assertEquals(stdout, `_arguments '*: :(("--dry":""))'\n`);
  });
});
