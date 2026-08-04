/**
 * Публикация команд маршрута `legacy` тулами (`platform/mcp-server.md`,
 * «Два источника тулов» и «Ответ legacy-тула»): схема аргументов из
 * описания параметров слепка, обратная сборка командной строки,
 * усечение описания и вывода.
 *
 * Ключевая проверка здесь — про списки. Ради неё всё и затевалось:
 * агент звал команды через Bash, список значений уезжал одной строкой,
 * и команда молча обрабатывала ноль элементов, не сообщая об ошибке.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkLegacyArgs,
  legacyToolArgv,
  legacyToolDescription,
  legacyToolSchema,
  MANIFEST_VERSION,
  ManifestError,
  OUTPUT_LIMIT,
  readManifest,
  truncateOutput,
} from "./legacy_tools.ts";
import type { LegacyLeaf, LegacyParam } from "./legacy_tools.ts";
import { UsageError } from "../command/mod.ts";

/** Лист слепка под тест: путь и параметры, прочее — заглушки. */
function leaf(
  path: readonly string[],
  params: readonly LegacyParam[],
  overrides: Partial<LegacyLeaf> = {},
): LegacyLeaf {
  return {
    path,
    params,
    summary: "проба",
    help: "Подробности пробы.",
    ...overrides,
  };
}

const positional = (name: string, extra: Partial<LegacyParam> = {}) => ({
  name,
  kind: "argument" as const,
  type: "string" as const,
  required: false,
  ...extra,
});

const option = (
  name: string,
  opts: string[],
  extra: Partial<LegacyParam> = {},
) => ({
  name,
  kind: "option" as const,
  type: "string" as const,
  required: false,
  opts,
  ...extra,
});

Deno.test("схема аргументов выводится из параметров слепка", async (t) => {
  await t.step("позиционный и флаг — оба поля схемы", () => {
    const schema = legacyToolSchema(leaf(["sql-ro"], [
      positional("selector", { required: true, help: "кого спрашиваем" }),
      option("server", ["--server"], { help: "override резолва" }),
    ]));
    assertEquals(schema.type, "object");
    assertEquals(Object.keys(schema.properties), ["selector", "server"]);
    assertEquals(schema.required, ["selector"]);
    assertEquals(schema.properties.selector.description, "кого спрашиваем");
    assertEquals(schema.additionalProperties, false);
  });

  await t.step("типы переносятся", () => {
    const schema = legacyToolSchema(leaf(["проба"], [
      option("flag", ["--flag"], { type: "boolean", default: false }),
      option("count", ["--count"], { type: "integer" }),
      option("ratio", ["--ratio"], { type: "number" }),
    ]));
    assertEquals(schema.properties.flag.type, "boolean");
    assertEquals(schema.properties.flag.default, false);
    assertEquals(schema.properties.count.type, "integer");
    assertEquals(schema.properties.ratio.type, "number");
  });

  await t.step("choices становятся перечислением", () => {
    const schema = legacyToolSchema(leaf(["проба"], [
      option("out", ["--out"], {
        choices: ["matrix", "json"],
        default: "matrix",
      }),
    ]));
    assertEquals(schema.properties.out.enum, ["matrix", "json"]);
    assertEquals(schema.properties.out.default, "matrix");
  });

  await t.step("повторяемый флаг — массив строк", () => {
    const schema = legacyToolSchema(leaf(["проба"], [
      option("grep", ["--grep"], { multiple: true }),
    ]));
    assertEquals(schema.properties.grep.type, "array");
    assertEquals(schema.properties.grep.items, { type: "string" });
  });

  await t.step("позиционный с nargs -1 — тоже массив", () => {
    const schema = legacyToolSchema(leaf(["проба"], [
      positional("ranges", { nargs: -1 }),
    ]));
    assertEquals(schema.properties.ranges.type, "array");
  });

  await t.step("схема не ветвится на верхнем уровне", () => {
    const schema = legacyToolSchema(leaf(["проба"], [positional("x")]));
    for (const branch of ["anyOf", "oneOf", "allOf"]) {
      assertEquals(Object.keys(schema).includes(branch), false);
    }
  });
});

Deno.test("командная строка собирается обратно из объекта", async (t) => {
  await t.step("позиционные — в порядке объявления", () => {
    const spec = leaf(["sql-ro"], [
      positional("selector", { required: true }),
      positional("sql"),
    ]);
    assertEquals(
      legacyToolArgv(spec, { selector: "sl-1", sql: "select 1" }),
      ["sql-ro", "sl-1", "select 1"],
    );
  });

  await t.step("строковый флаг — имя и значение раздельно", () => {
    const spec = leaf(["logs"], [option("grep", ["--grep"])]);
    // Именно два элемента, а не «--grep значение» одной строкой: иначе
    // подпроцесс получит неизвестный аргумент.
    assertEquals(legacyToolArgv(spec, { grep: "нет места" }), [
      "logs",
      "--grep",
      "нет места",
    ]);
  });

  await t.step("булев флаг: true — имя, false — ничего", () => {
    const spec = leaf(["sql-ro"], [
      option("dry", ["--dry"], { type: "boolean", default: false }),
    ]);
    assertEquals(legacyToolArgv(spec, { dry: true }), ["sql-ro", "--dry"]);
    assertEquals(legacyToolArgv(spec, { dry: false }), ["sql-ro"]);
  });

  await t.step("булев флаг с отрицанием: false — отрицающая форма", () => {
    const spec = leaf(["search"], [
      option("update", ["--update"], {
        type: "boolean",
        default: true,
        negatedOpts: ["--no-update"],
      }),
    ]);
    assertEquals(legacyToolArgv(spec, { update: false }), [
      "search",
      "--no-update",
    ]);
    assertEquals(legacyToolArgv(spec, { update: true }), ["search"]);
  });

  await t.step("число приводится к строке", () => {
    const spec = leaf(["logs"], [
      option("tail", ["--tail"], { type: "integer" }),
    ]);
    assertEquals(legacyToolArgv(spec, { tail: 200 }), [
      "logs",
      "--tail",
      "200",
    ]);
  });

  await t.step("незаданное поле не попадает в строку", () => {
    const spec = leaf(["logs"], [
      option("grep", ["--grep"]),
      positional("target"),
    ]);
    assertEquals(legacyToolArgv(spec, {}), ["logs"]);
  });
});

Deno.test("список значений долетает отдельными аргументами", async (t) => {
  // Тот самый класс багов, ради которого затевался MCP-сервер: список
  // уезжал одной строкой, команда получала ноль элементов и молчала.
  await t.step("повторяемый флаг — по элементу на повтор", () => {
    const spec = leaf(["sheet", "batch-get"], [
      option("expr", ["-e", "--expr"], { multiple: true }),
    ]);
    const argv = legacyToolArgv(spec, { expr: ["A1:B2", "C3:D4", "E5"] });
    assertEquals(argv, [
      "sheet",
      "batch-get",
      "--expr",
      "A1:B2",
      "--expr",
      "C3:D4",
      "--expr",
      "E5",
    ]);
    // И ни один элемент не склеился с соседом.
    assertEquals(argv.filter((arg) => arg.includes(" ")), []);
  });

  await t.step("позиционный список — по элементу, без склейки", () => {
    const spec = leaf(["sheet", "get"], [positional("ranges", { nargs: -1 })]);
    const argv = legacyToolArgv(spec, { ranges: ["Лист!A1", "Лист!B2"] });
    assertEquals(argv, ["sheet", "get", "Лист!A1", "Лист!B2"]);
  });

  await t.step("склейка списка ловится, а не проходит молча", () => {
    const spec = leaf(["sheet", "get"], [positional("ranges", { nargs: -1 })]);
    const argv = legacyToolArgv(spec, { ranges: ["Лист!A1", "Лист!B2"] });
    // Признак склейки: один аргумент вместо двух. Проверяем и число
    // аргументов, и отсутствие пробела внутри — молчаливый ноль
    // элементов начинался именно с этого.
    assertEquals(argv.length, 4);
    assertEquals(argv.includes("Лист!A1 Лист!B2"), false);
  });

  await t.step("пустой список — ни одного аргумента", () => {
    const spec = leaf(["logs"], [
      option("grep", ["--grep"], { multiple: true }),
    ]);
    assertEquals(legacyToolArgv(spec, { grep: [] }), ["logs"]);
  });
});

Deno.test("аргументы проверяются до запуска подпроцесса", async (t) => {
  const spec = leaf(["sheet", "get"], [
    positional("selector", { required: true }),
    positional("ranges", { nargs: -1 }),
    option("sheet", ["--sheet"]),
    option("limit", ["--limit"], { type: "integer" }),
    option("out", ["--out"], { choices: ["table", "json"] }),
    option("dry", ["--dry"], { type: "boolean" }),
  ]);

  await t.step("корректный набор проходит", () => {
    checkLegacyArgs(spec, { selector: "sl-1", ranges: ["A1"], limit: 10 });
  });

  await t.step("не объект — ошибка ввода, а не падение", () => {
    for (const raw of [42, "строка", ["массив"], null]) {
      const err = assertThrows(() => checkLegacyArgs(spec, raw), UsageError);
      assertStringIncludes(String(err), "arguments must be an object");
    }
  });

  await t.step("неизвестное имя — ошибка ввода", () => {
    const err = assertThrows(
      () => checkLegacyArgs(spec, { selector: "sl-1", нетТакого: 1 }),
      UsageError,
    );
    assertStringIncludes(String(err), "нетТакого");
  });

  await t.step("пропущен обязательный — ошибка ввода", () => {
    const err = assertThrows(
      () => checkLegacyArgs(spec, { ranges: ["A1"] }),
      UsageError,
    );
    assertStringIncludes(String(err), "selector");
  });

  await t.step("тип не тот — названы оба типа", () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ selector: "s", dry: "да" }, "expected boolean"],
      [{ selector: "s", limit: "десять" }, "expected number"],
      [{ selector: "s", out: "csv" }, "expected one of"],
      [{ selector: "s", ranges: "A1 B2" }, "expected array"],
      [{ selector: ["s"] }, "expected scalar"],
    ];
    for (const [args, expected] of cases) {
      const err = assertThrows(() => checkLegacyArgs(spec, args), UsageError);
      assertStringIncludes(String(err), expected);
    }
  });
});

Deno.test("описание тула: справка из слепка, при переполнении усечена", async (t) => {
  await t.step("короткая справка отдаётся целиком", () => {
    const text = legacyToolDescription(
      leaf(["ps"], [], { summary: "процессы", help: "Строка справки." }),
    );
    assertEquals(text, "процессы\n\nСтрока справки.");
  });

  await t.step("длинная усечена по границе строки с пометкой", () => {
    const line = "строка справки, довольно длинная, чтобы быстро набрать вес";
    const help = Array.from({ length: 100 }, () => line).join("\n");
    const text = legacyToolDescription(leaf(["ps"], [], { help }));
    const bytes = new TextEncoder().encode(text).length;
    assertEquals(bytes <= 2048, true, `описание не влезло: ${bytes} байт`);
    const lines = text.split("\n");
    assertStringIncludes(
      lines[lines.length - 1],
      "[справка усечена: отброшено",
    );
    assertStringIncludes(lines[lines.length - 1], "байт]");
    // Обрезано по границе строки: последняя строка справки не порвана.
    assertEquals(lines[lines.length - 2], line);
  });
});

Deno.test("вывод подпроцесса усекается с пометкой", async (t) => {
  await t.step("короткий проходит как есть", () => {
    assertEquals(
      truncateOutput("две строки\nвторая\n"),
      "две строки\nвторая\n",
    );
  });

  await t.step("длинный обрезан и помечен", () => {
    const text = `${"строка вывода\n".repeat(20000)}`;
    const cut = truncateOutput(text);
    const bytes = new TextEncoder().encode(cut).length;
    assertEquals(bytes <= OUTPUT_LIMIT + 64, true, `не усечён: ${bytes}`);
    assertStringIncludes(cut, "[вывод усечён: отброшено");
  });
});

Deno.test("слепок незнакомой версии — отказ, а не разбор", async (t) => {
  await t.step("знакомая версия читается", () => {
    const manifest = readManifest({
      manifestVersion: MANIFEST_VERSION,
      mpuVersion: "0.1.0",
      commands: [{ path: ["ps"], params: [], summary: "s", help: "h" }],
    });
    assertEquals(manifest.commands.length, 1);
  });

  await t.step("испорченная форма — отказ с указанием места", async (inner) => {
    const good = { path: ["ps"], params: [], summary: "s", help: "h" };
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["слепок не объект", ["массив"], "ожидался объект"],
      [
        "commands не массив",
        {
          manifestVersion: MANIFEST_VERSION,
          mpuVersion: "0.1.0",
          commands: {},
        },
        "commands не массив",
      ],
      [
        "mpuVersion не строка",
        { manifestVersion: MANIFEST_VERSION, mpuVersion: 1, commands: [] },
        "mpuVersion: ожидалась строка",
      ],
      [
        "пустой путь листа",
        {
          manifestVersion: MANIFEST_VERSION,
          mpuVersion: "0.1.0",
          commands: [{ ...good, path: [] }],
        },
        "path пуст",
      ],
      [
        "params не массив",
        {
          manifestVersion: MANIFEST_VERSION,
          mpuVersion: "0.1.0",
          commands: [{ ...good, params: "нет" }],
        },
        "params не массив",
      ],
      [
        "неизвестный kind параметра",
        {
          manifestVersion: MANIFEST_VERSION,
          mpuVersion: "0.1.0",
          commands: [{
            ...good,
            params: [{
              name: "x",
              kind: "flag",
              type: "string",
              required: false,
            }],
          }],
        },
        "неизвестный kind",
      ],
      [
        "неизвестный type параметра",
        {
          manifestVersion: MANIFEST_VERSION,
          mpuVersion: "0.1.0",
          commands: [{
            ...good,
            params: [{
              name: "x",
              kind: "option",
              type: "date",
              required: false,
            }],
          }],
        },
        "неизвестный type",
      ],
      [
        "summary не строка",
        {
          manifestVersion: MANIFEST_VERSION,
          mpuVersion: "0.1.0",
          commands: [{ ...good, summary: 7 }],
        },
        "summary: ожидалась строка",
      ],
    ];
    for (const [title, raw, expected] of cases) {
      await inner.step(title, () => {
        const err = assertThrows(() => readManifest(raw), ManifestError);
        assertStringIncludes(String(err), expected);
      });
    }
  });

  await t.step("признак группы читается", () => {
    const manifest = readManifest({
      manifestVersion: MANIFEST_VERSION,
      mpuVersion: "0.1.0",
      commands: [
        { path: ["kiten"], params: [], summary: "s", help: "h", group: true },
        { path: ["kiten", "ls"], params: [], summary: "s", help: "h" },
      ],
    });
    assertEquals(manifest.commands[0].group, true);
    // У листа поля нет вовсе, а не `false`: слепок его не пишет.
    assertEquals(manifest.commands[1].group, undefined);
  });

  await t.step("чужая версия — ManifestError с обеими версиями", () => {
    let caught: unknown;
    try {
      readManifest({ manifestVersion: 99, mpuVersion: "0.1.0", commands: [] });
    } catch (err) {
      caught = err;
    }
    assertEquals(caught instanceof ManifestError, true);
    assertStringIncludes(String(caught), "99");
    assertStringIncludes(String(caught), String(MANIFEST_VERSION));
  });
});
