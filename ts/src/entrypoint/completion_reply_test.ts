/**
 * Формат ответа режима дополнения (`platform/registry.md`, «Режим
 * дополнения») против эталонов, снятых с живой реализации.
 *
 * Сверка байтовая: это внешняя граница, и ответ для zsh **исполняется**
 * как код — вольность в формате ломает дополнение молча.
 *
 * Часть эталонов снята на дереве, где команда ещё шла подпроцессом:
 * `completion-out-bash-flags` и `completion-out-zsh-nested` —
 * до переезда `xlsx`, `completion-out-bash`, `completion-out-zsh` и
 * `completion-out-zsh-flags` — до переезда `sql-ro`. Формат на них
 * проверяется на данных слепка, а фактический вывод переехавшей команды
 * — отдельно, по свойству: описания и порядок теперь берутся из
 * объявления команды, и это следствие переезда.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { completionReply } from "./completion.ts";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { readManifest } from "../registry/manifest.ts";
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
  // Обе команды переехали на маршрут `native`, и порядок реестра совпал
  // с эталонным: сверка байтовая, без исключений.
  assertEquals(stdout, await golden("completion-out-bash"));
});

Deno.test("completion-out-zsh.txt: _arguments с описаниями", async () => {
  const { stdout } = await complete({
    _MPU_COMPLETE: "complete_zsh",
    _TYPER_COMPLETE_ARGS: "mpu sq",
  });
  const fixture = await golden("completion-out-zsh");
  const entries = /"[^"]+":"[^"]*"/g;
  // Варианты и их описания — эталона: однострокѝ обеих команд взяты из
  // того же слепка, поэтому текст не разошёлся.
  assertEquals(
    [...stdout.matchAll(entries)].map(([entry]) => entry),
    [...fixture.matchAll(entries)].map(([entry]) => entry),
  );
  // Обрамление ответа — байт в байт эталона: его исполняет zsh.
  assertEquals(stdout.replace(entries, "…"), fixture.replace(entries, "…"));
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
  await t.step("уровень-группа — только общий --help", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_bash",
      COMP_WORDS: "mpu xlsx -",
      COMP_CWORD: "2",
    });
    assertEquals(stdout.split("\n").filter(Boolean), ["--help"]);
  });

  await t.step("completion-out-zsh-flags.txt — байт в байт", async () => {
    // Эталон снят до переезда `sql-ro`: у переехавшей команды описание
    // флага своё (следующий шаг), а здесь проверяется форма ответа, и
    // текст берётся тот, что стоит в эталоне. Прежде он приходил из
    // слепка — источник исчез вместе с маршрутом (порция 97), сама
    // форма не изменилась.
    assertEquals(
      completionReply("zsh", [{
        name: "--dry",
        summary: "Только meta + SQL, без коннекта",
      }]),
      await golden("completion-out-zsh-flags"),
    );
  });

  await t.step("описание флага переехавшей команды — из её схемы", async () => {
    const { stdout } = await complete({
      _MPU_COMPLETE: "complete_zsh",
      _TYPER_COMPLETE_ARGS: "mpu sql-ro --d",
    });
    const described = findCommand(["sql-ro"])
      ?.argsJsonSchema.properties["dry"].description ?? "";
    assertEquals(
      stdout,
      completionReply("zsh", [{ name: "--dry", summary: described }]),
    );
    assertStringIncludes(stdout, "без подключения");
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

  await t.step(
    "общий --json предлагается там, где команда его берёт",
    async () => {
      // Прежде этот шаг сравнивал уровень группы с уровнем команды: у
      // группы `--json` неоткуда взяться. Уровень группы теперь проверен
      // соседним шагом («уровень-группа — только общий --help»), и здесь
      // осталась вторая половина — команда, объявившая флаг сама.
      const own = await complete({
        _MPU_COMPLETE: "complete_bash",
        COMP_WORDS: "mpu sheet ls -",
        COMP_CWORD: "3",
      });
      assertEquals(own.stdout.split("\n").includes(JSON_FLAG), true);
      // Команде контракта общий параметр предлагается всегда.
      const native = await complete({
        _MPU_COMPLETE: "complete_bash",
        COMP_WORDS: "mpu xlsx get -",
        COMP_CWORD: "3",
      });
      assertEquals(native.stdout.split("\n").includes(JSON_FLAG), true);
      // Кроме команды, чей хвостовой вход забирает неопознанные токены:
      // там `--json` — флаг чужой командной строки, и предлагать его
      // значило бы советовать испортить чужой вызов
      // (`platform/registry.md`).
      const passthrough = await complete({
        _MPU_COMPLETE: "complete_bash",
        COMP_WORDS: "mpu ssh -",
        COMP_CWORD: "2",
      });
      assertEquals(passthrough.stdout.split("\n").includes(JSON_FLAG), false);
    },
  );
});
