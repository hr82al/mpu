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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { completionReply } from "./completion.ts";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { readManifest } from "../mcp/legacy_tools.ts";
import { findCommand } from "../registry/mod.ts";

/** Общий параметр формы вывода: он есть только у маршрута `native`. */
const JSON_FLAG = "--json";
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

/**
 * Подкоманды `xlsx` в слепке: имя и однострока, в порядке слепка.
 * Однострока берётся из записи самогó узла — у листа своя, у группы
 * `xlsx alias` тоже своя (слепок v2).
 */
function snapshotXlsxChildren(): readonly { name: string; summary: string }[] {
  const children: { name: string; summary: string }[] = [];
  for (const node of readManifest(treeManifest).commands) {
    if (node.path[0] !== "xlsx" || node.path.length !== 2) continue;
    children.push({ name: node.path[1], summary: node.summary });
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

Deno.test("completion-out-zsh-nested.txt: вложенный уровень", async () => {
  // Слепок v2 несёт запись группы `xlsx alias`, поэтому эталон
  // воспроизводится целиком: сверка байтовая, без исключений.
  assertEquals(
    completionReply("zsh", snapshotXlsxChildren()),
    await golden("completion-out-zsh-nested"),
  );
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

  await t.step("completion-out-zsh-flags.txt — байт в байт", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_zsh",
      _TYPER_COMPLETE_ARGS: "mpu sql-ro --d",
    });
    assertEquals(stdout, await golden("completion-out-zsh-flags"));
  });

  await t.step("описание флага — из того же слепка", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_zsh",
      _TYPER_COMPLETE_ARGS: "mpu sql-ro --d",
    });
    const leaf = readManifest(treeManifest).commands.find(
      (item) => item.path.join(" ") === "sql-ro",
    );
    const dry = leaf?.params.find((param) => param.name === "dry");
    assertEquals(
      stdout,
      completionReply("zsh", [{ name: "--dry", summary: dry?.help ?? "" }]),
    );
    assertStringIncludes(stdout, "Только meta");
  });

  await t.step("описание флага команды контракта — из её схемы", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_zsh",
      _TYPER_COMPLETE_ARGS: "mpu xlsx get --ts",
    });
    const command = findCommand(["xlsx", "get"]);
    const declared = command?.argsJsonSchema.properties["tsv"].description ??
      "";
    // Тот же текст, что в справке команды: второго источника нет, а
    // обрезку по длине делает общее форматирование ответа.
    assertEquals(
      stdout,
      completionReply("zsh", [{ name: "--tsv", summary: declared }]),
    );
    assertStringIncludes(stdout, "таблица с шапкой range/value");
  });

  await t.step("общий --json командам legacy не добавляется", async () => {
    // Точка входа его для этого маршрута не распознаёт: он уходит
    // подпроцессу как обычный аргумент (`platform/registry.md`).
    // У `mpu health` своего `--json` в слепке нет — значит и в
    // подсказке ему взяться неоткуда.
    const legacy = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu health -",
      COMP_CWORD: "2",
    });
    assertEquals(legacy.stdout.split("\n").includes(JSON_FLAG), false);
    // А там, где команда объявляет его сама (`mpu ps`), он есть — и
    // приходит из слепка, а не от точки входа.
    const own = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu ps -",
      COMP_CWORD: "2",
    });
    assertEquals(own.stdout.split("\n").includes(JSON_FLAG), true);
    // Команде контракта общий параметр предлагается всегда.
    const native = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu xlsx get -",
      COMP_CWORD: "3",
    });
    assertEquals(native.stdout.split("\n").includes(JSON_FLAG), true);
  });
});
