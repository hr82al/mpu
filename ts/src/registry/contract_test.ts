/**
 * Семь инвариантов `platform/command-contract.md`, проверяемых обходом
 * реестра: каждая зарегистрированная команда обязана удовлетворять им,
 * поэтому новая команда попадает под проверку без правки этого файла.
 * Способ проверки для каждого инварианта назван спекой и повторён в
 * названии шага.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { commands, findCommand } from "./mod.ts";
import { type Command, type CommandIo, UsageError } from "../command/mod.ts";

/**
 * Образец вызова команды: аргументы, которые она принимает, и образец
 * её результата. Таблица обязана покрывать реестр целиком — это
 * проверяет отдельный шаг, иначе новая команда молча выпадет из обхода.
 */
interface CommandCase {
  /** Путь команды через пробел, как в реестре. */
  readonly path: string;
  /** Аргументы командной строки без пути команды. */
  readonly argv: readonly string[];
  /** Литеральный результат для проверки рендера и сериализации. */
  readonly sampleResult: unknown;
}

const CASES: readonly CommandCase[] = [
  {
    path: "xlsx ls",
    argv: ["-f", "sample.xlsx"],
    sampleResult: {
      sheets: [{ title: "Данные", index: 0, rows: 6, cols: 3 }],
    },
  },
  {
    path: "xlsx get",
    argv: ["-f", "sample.xlsx", "Данные!A1"],
    sampleResult: {
      file: "/tmp/книга.xlsx",
      cells: [
        { range: "Данные!A1", value: "имя" },
        { range: "Данные!A2", value: 42, formula: "=6*7" },
        { range: "Данные!A3", value: null },
      ],
    },
  },
  {
    path: "xlsx open",
    argv: ["-f", "sample.xlsx", "--print"],
    sampleResult: { path: "/tmp/книга.xlsx", launched: false },
  },
  {
    path: "xlsx resolve",
    argv: ["-f", "sample.xlsx"],
    sampleResult: {
      resolved: { path: "/tmp/книга.xlsx", source: "flag" },
      checked: [
        {
          source: "flag",
          label: "--file/-f",
          value: "sample.xlsx",
          used: true,
        },
        { source: "env", label: "env MPU_XLSX", value: null, used: false },
        {
          source: "config",
          label: "config xlsx.default",
          value: null,
          used: false,
        },
      ],
    },
  },
  {
    path: "xlsx alias add",
    argv: ["otchet", "/tmp/книга.xlsx"],
    sampleResult: { name: "otchet", path: "/tmp/книга.xlsx", created: true },
  },
  {
    path: "xlsx alias ls",
    argv: [],
    sampleResult: { aliases: [{ name: "otchet", path: "/tmp/книга.xlsx" }] },
  },
  {
    path: "xlsx alias rm",
    argv: ["otchet"],
    sampleResult: { name: "otchet", removed: true },
  },
  {
    path: "mcp token",
    argv: [],
    // Значение синтетическое: настоящий токен в образцы не попадает.
    sampleResult: { headers: { Authorization: "Bearer проба-токена" } },
  },
];

Deno.test("реестр непуст и покрыт образцами вызова", () => {
  assert(commands.length > 0, "реестр пуст: обходить нечего");
  const registered = commands.map((c) => c.path.join(" ")).sort();
  const covered = CASES.map((c) => c.path).sort();
  assertEquals(covered, registered, "таблица образцов разошлась с реестром");
});

Deno.test("инвариант 1: исполнение не печатает", async () => {
  await withSampleDir(async (dir) => {
    for (const testCase of CASES) {
      const command = mustFind(testCase.path);
      const captured = await withCapturedOutput(async () => {
        await command.invoke(testCase.argv, makeIo(dir));
      });
      assertEquals(
        captured,
        "",
        `${testCase.path} писала в приёмник вывода: ${captured}`,
      );
    }
  });
});

Deno.test("инвариант 2: рендер чист", () => {
  for (const testCase of CASES) {
    const command = mustFind(testCase.path);
    // Литеральный результат, вне окружения: io команде не передаётся.
    const first = command.renderResult(testCase.sampleResult, testCase.argv);
    const second = command.renderResult(testCase.sampleResult, testCase.argv);
    assertEquals(second, first, `${testCase.path}: рендер не воспроизводим`);
  }
});

Deno.test("инвариант 3: политика объявлена и не зависит от аргументов", () => {
  for (const command of commands) {
    const name = command.path.join(" ");
    assert(
      command.policy === "ro" || command.policy === "rw",
      `${name}: политика не объявлена`,
    );
    // Значения аргументов на политику не влияют: класс команды не
    // выводится из входа (отклонение-fix про `--print` и `--dry`).
    const before = command.policy;
    for (const input of command.inputs) {
      command.parseArgs(argvFor(command, [...required(command), input.name]));
      assertEquals(
        command.policy,
        before,
        `${name}: политика изменилась после разбора "${input.name}"`,
      );
    }
  }
});

Deno.test("инвариант 4: имена входа совпадают со схемой аргументов", () => {
  for (const command of commands) {
    const name = command.path.join(" ");
    const schemaNames = Object.keys(command.argsJsonSchema.properties);
    // Каждое имя схемы разбор argv действительно принимает: переданное
    // значение доезжает до разобранных аргументов под тем же именем.
    // Обязательные входы добавляются, иначе разбор упадёт раньше.
    for (const input of command.inputs) {
      const argv = argvFor(command, [...required(command), input.name]);
      const parsed = command.parseArgs(argv);
      assertEquals(
        parsed[input.name],
        sampleValue(command, input),
        `${name}: вход "${input.name}" не принят из argv`,
      );
    }
    assertEquals(
      command.inputs.map((input) => input.name).sort(),
      [...schemaNames].sort(),
      `${name}: схема объявляет входы, которых нет у разбора argv`,
    );
    // Короткая форма — то же имя схемы, записанное иначе.
    for (const input of command.inputs) {
      if (input.form.short === undefined) continue;
      const value = sampleValue(command, input);
      const written = input.kind === "boolean"
        ? [`-${input.form.short}`]
        : [`-${input.form.short}`, String(value)];
      const parsed = command.parseArgs([...requiredArgv(command), ...written]);
      assertEquals(
        parsed[input.name],
        value,
        `${name}: короткая форма "-${input.form.short}" не принята`,
      );
    }
    // И ничего сверх схемы: постороннее имя отвергается как опция.
    const err = assertThrows(
      () => command.parseArgs([...requiredArgv(command), "--нет-такого-входа"]),
      UsageError,
      `unknown option "--нет-такого-входа"`,
    );
    assertEquals(err.hint, `mpu ${name} --help`);
  }
});

Deno.test("инвариант 5: обязательность совпадает", () => {
  for (const command of commands) {
    const name = command.path.join(" ");
    const names = command.requiredInputNames;
    // Набора из одних обязательных хватает: необязательные входы можно
    // не писать в argv. Полный набор здесь не проверяется — у команды
    // бывают взаимоисключающие входы (`--raw` и `--tsv` у get).
    command.parseArgs(requiredArgv(command));
    for (const missing of names) {
      const kept = names.filter((input) => input !== missing);
      assertThrows(
        () => command.parseArgs(argvFor(command, kept)),
        UsageError,
        undefined,
        `${name}: без обязательного "${missing}" разбор не упал`,
      );
    }
    // Параметр со значением по умолчанию не обязателен ни там, ни там.
    for (
      const [key, field] of Object.entries(command.argsJsonSchema.properties)
    ) {
      if (field.default === undefined) continue;
      assert(
        !names.includes(key),
        `${name}: "${key}" имеет значение по умолчанию и обязателен`,
      );
    }
  }
});

/** argv, записывающий перечисленные входы: сначала флаги, потом позиционные. */
function argvFor(command: Command, names: readonly string[]): string[] {
  const flags: string[] = [];
  const positional: string[] = [];
  for (const input of command.inputs) {
    if (!names.includes(input.name)) continue;
    const value = sampleValue(command, input);
    if (input.form.positional !== undefined) {
      positional.push(Array.isArray(value) ? value[0] : String(value));
      continue;
    }
    if (input.kind === "boolean") {
      flags.push(`--${input.name}`);
      continue;
    }
    flags.push(`--${input.name}`, Array.isArray(value) ? value[0] : `${value}`);
  }
  return [...flags, ...positional];
}

function requiredArgv(command: Command): string[] {
  return argvFor(command, required(command));
}

function required(command: Command): readonly string[] {
  return command.requiredInputNames;
}

/** Что окажется в разобранных аргументах, если записать вход в argv. */
function sampleValue(
  command: Command,
  input: Command["inputs"][number],
): unknown {
  if (input.kind === "boolean") return true;
  // Значение обязано проходить ограничения схемы: у перечисления берём
  // допустимое, остальным годится короткая строка без спецсимволов.
  const allowed = command.argsJsonSchema.properties[input.name]?.enum;
  const value = allowed === undefined ? "x" : String(allowed[0]);
  return input.kind === "strings" ? [value] : value;
}

Deno.test("инвариант 6: результат сериализуем без потерь", () => {
  for (const testCase of CASES) {
    const command = mustFind(testCase.path);
    const restored = JSON.parse(JSON.stringify(testCase.sampleResult));
    assertEquals(
      restored,
      testCase.sampleResult,
      `${testCase.path}: результат не переживает JSON`,
    );
    // Образец обязан удовлетворять объявленной схеме результата, иначе
    // проверка сериализации сверяет не то, что команда возвращает.
    command.assertResult(testCase.sampleResult);
  }
});

Deno.test("инвариант 7: результат — объект в корне", () => {
  for (const command of commands) {
    assertEquals(
      command.resultJsonSchema.type,
      "object",
      `${command.path.join(" ")}: корень схемы результата не объект`,
    );
  }
});

function mustFind(path: string): Command {
  const command = findCommand(path.split(" "));
  assert(command !== undefined, `команда "${path}" не зарегистрирована`);
  return command;
}

/**
 * Приёмник вывода процесса на время вызова: инвариант 1 требует, чтобы
 * исполнение не печатало, а печать в Deno идёт мимо io команды — через
 * console и потоки процесса.
 */
async function withCapturedOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  // Перехватываются все пути печати процесса, а не только привычные:
  // проверка обязана ловить и console.warn, и синхронную запись в
  // поток, иначе «ничего не напечатано» доказывает слишком мало.
  const levels = ["log", "error", "warn", "info", "debug"] as const;
  const origConsole = levels.map((level) => console[level]);
  const origWrite = [Deno.stdout.write, Deno.stderr.write];
  const origWriteSync = [Deno.stdout.writeSync, Deno.stderr.writeSync];
  for (const level of levels) {
    console[level] = (...args: unknown[]) => void chunks.push(args.join(" "));
  }
  for (const stream of [Deno.stdout, Deno.stderr]) {
    stream.write = (bytes: Uint8Array) => {
      chunks.push(decoder.decode(bytes));
      return Promise.resolve(bytes.length);
    };
    stream.writeSync = (bytes: Uint8Array) => {
      chunks.push(decoder.decode(bytes));
      return bytes.length;
    };
  }
  try {
    await fn();
  } finally {
    levels.forEach((level, i) => void (console[level] = origConsole[i]));
    Deno.stdout.write = origWrite[0];
    Deno.stderr.write = origWrite[1];
    Deno.stdout.writeSync = origWriteSync[0];
    Deno.stderr.writeSync = origWriteSync[1];
  }
  return chunks.join("");
}

/** Каталог с книгой-фикстурой: команды обхода читают настоящий файл. */
async function withSampleDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    // Книга-фикстура лежит в тестовом каталоге команды xlsx: копировать
    // её второй раз незачем, источник истины у обеих копий один —
    // docs/specs/fixtures/xlsx.
    const base64 = await Deno.readTextFile(
      new URL("../xlsx/testdata/sample.xlsx.b64", import.meta.url),
    );
    const binary = atob(base64.replaceAll(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.codePointAt(0) ?? 0);
    await Deno.writeFile(`${dir}/sample.xlsx`, bytes);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Настоящие чтение и запись в пределах временного каталога. */
function makeIo(dir: string): CommandIo {
  const inDir = (path: string) =>
    path.startsWith("/") ? path : `${dir}/${path}`;
  return {
    env: () => undefined,
    cwd: () => dir,
    readFile: (path) => Deno.readFile(inDir(path)),
    readTextFile: (path) => Deno.readTextFile(inDir(path)),
    readTextStdin: () => Promise.resolve(""),
    readAccessToken: () => Promise.resolve("проба-токена"),
    writeAccessToken: (token) =>
      Deno.writeTextFile(`${dir}/token`, token, { mode: 0o600 }),
    readConfigStore: async () => {
      try {
        return await Deno.readTextFile(`${dir}/config.json`);
      } catch {
        // Хранилища ещё нет — по контракту это пустое хранилище.
        return undefined;
      }
    },
    writeConfigStore: (text) =>
      Deno.writeTextFile(`${dir}/config.json`, text, { mode: 0o600 }),
    // Запуск открывателя в обходе не нужен: образец зовёт open с --print.
    launchOpener: () => false,
  };
}
