import { describe, expect, it } from "vitest";
import { rejected, thrown } from "@mpu/testing/thrown";
import { DomainError } from "../command/mod.ts";
import {
  envFilePath,
  type EnvFileStore,
  makeEnvFile,
  xdgConfigHome,
} from "./mod.ts";

function fakeStore(text: string | undefined) {
  let reads = 0;
  const written: string[] = [];
  const store: EnvFileStore = {
    path: "/cfg/mpu/.env",
    readSync: () => {
      reads++;
      return text;
    },
    write: (next) => {
      written.push(next);
      text = next;
      return Promise.resolve();
    },
  };
  return { store, written, reads: () => reads };
}

describe("путь: XDG_CONFIG_HOME, HOME, ни того ни другого", () => {
  const cases: readonly [string, Record<string, string>, string | undefined][] =
    [
      ["XDG задана", { XDG_CONFIG_HOME: "/x" }, "/x/mpu/.env"],
      [
        "XDG пуста — дефолт",
        { XDG_CONFIG_HOME: "", HOME: "/h" },
        "/h/.config/mpu/.env",
      ],
      ["только HOME", { HOME: "/h" }, "/h/.config/mpu/.env"],
      ["HOME пуста — не задана", { HOME: "" }, undefined],
      ["ничего нет", {}, undefined],
    ];
  for (const [name, env, expected] of cases) {
    it(name, () => expect(envFilePath((n) => env[n])).toStrictEqual(expected));
  }
});

describe("каталог конфигурации: пустая и относительная XDG_CONFIG_HOME — как незаданная", () => {
  // Относительное значение спецификация XDG велит игнорировать: иначе
  // каталог конфигурации зависел бы от текущего каталога вызова
  // (`platform/env-file.md`, «Граничные случаи и ошибки»). Тильду оболочка
  // в значении переменной не раскрывает — `~/cfg` тоже относительный.
  const cases: ReadonlyArray<
    readonly [string, Readonly<Record<string, string>>, string | undefined]
  > = [
    ["абсолютная", { XDG_CONFIG_HOME: "/abs", HOME: "/дом" }, "/abs"],
    ["пустая", { XDG_CONFIG_HOME: "", HOME: "/дом" }, "/дом/.config"],
    ["не задана", { HOME: "/дом" }, "/дом/.config"],
    ["cfg", { XDG_CONFIG_HOME: "cfg", HOME: "/дом" }, "/дом/.config"],
    ["./cfg", { XDG_CONFIG_HOME: "./cfg", HOME: "/дом" }, "/дом/.config"],
    ["../cfg", { XDG_CONFIG_HOME: "../cfg", HOME: "/дом" }, "/дом/.config"],
    ["~/cfg", { XDG_CONFIG_HOME: "~/cfg", HOME: "/дом" }, "/дом/.config"],
    // Пробел в начале не обрезается: такой путь не абсолютный.
    ["« /x»", { XDG_CONFIG_HOME: " /x", HOME: "/дом" }, "/дом/.config"],
    // И в конце значение не обрезается: `"/x "` абсолютный, берётся как есть.
    ["«/x »", { XDG_CONFIG_HOME: "/x ", HOME: "/дом" }, "/x "],
    [
      "относительная, HOME пуст",
      { XDG_CONFIG_HOME: "cfg", HOME: "" },
      undefined,
    ],
    ["относительная, HOME не задан", { XDG_CONFIG_HOME: "cfg" }, undefined],
  ];
  for (const [name, env, expected] of cases) {
    it(name, () => {
      expect(xdgConfigHome((key) => env[key])).toStrictEqual(expected);
    });
  }
});

describe("инвариант: окружение процесса на get не влияет", () => {
  // Решение 2026-08-05 (env-file.md, «Ввод/вывод», «Известные
  // отклонения»): слой читает только файл, право бинаря на чтение
  // окружения конфиг-ключей не покрывает. Обе половины инварианта
  // проверяются через настоящее окружение процесса — иначе подмена
  // читалки в самом тесте могла бы молча спрятать регресс.
  it("ключ и в окружении, и в файле — побеждает файл", () => {
    const key = "MPU_TEST_ENV_FILE_BOTH";
    const previous = process.env[key];
    process.env[key] = "from-process-env";
    try {
      const { store } = fakeStore(`${key}=from-file\n`);
      expect(makeEnvFile(store).get(key)).toBe("from-file");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("ключ только в окружении — не виден слою", () => {
    const key = "MPU_TEST_ENV_ONLY_PROCESS";
    const previous = process.env[key];
    process.env[key] = "from-process-env";
    try {
      const { store } = fakeStore("");
      expect(makeEnvFile(store).get(key)).toStrictEqual(undefined);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

it("файл читается ровно один раз за процесс", () => {
  const { store, reads } = fakeStore("A=1\nB=2\n");
  const envFile = makeEnvFile(store);
  envFile.get("A");
  envFile.get("B");
  envFile.get("нет такого");
  expect(reads()).toBe(1);
});

it("отсутствующего файла нет — не ошибка", () => {
  const { store } = fakeStore(undefined);
  expect(makeEnvFile(store).get("A")).toStrictEqual(undefined);
});

it("require: возвращает значение из файла", () => {
  const { store } = fakeStore("A=1\n");
  const envFile = makeEnvFile(store);
  expect(envFile.require("A")).toBe("1");
});

it("require: пустое значение в файле равнозначно отсутствию", () => {
  const { store } = fakeStore("A=\n");
  const envFile = makeEnvFile(store);
  expect(envFile.get("A")).toBe("");
  expect(() => envFile.require("A")).toThrow(DomainError);
});

it("require: текст ошибки дословно из спеки", () => {
  const { store } = fakeStore("");
  const envFile = makeEnvFile(store);
  const err = thrown(() => envFile.require("PG_HOST"), DomainError);
  expect(err.message).toStrictEqual(
    "environment variable PG_HOST is not set. " +
      "Add it to /cfg/mpu/.env or export in shell.",
  );
});

it("require: без файла хранилища — путь-дефолт в тексте ошибки", () => {
  const envFile = makeEnvFile(undefined);
  const err = thrown(() => envFile.require("PG_HOST"), DomainError);
  expect(err.message).toStrictEqual(
    "environment variable PG_HOST is not set. " +
      "Add it to ~/.config/mpu/.env or export in shell.",
  );
});

it("set: записывает файл и действует немедленно", async () => {
  const { store, written } = fakeStore("KEEP=1\n");
  const envFile = makeEnvFile(store);
  await envFile.set("TOKEN", "abc");
  expect(written).toStrictEqual(["KEEP=1\nTOKEN=abc\n"]);
  expect(envFile.get("TOKEN")).toBe("abc");
});

it("set: без файла хранилища — текст ошибки дословно из спеки", async () => {
  const envFile = makeEnvFile(undefined);
  const err = await rejected(() => envFile.set("A", "1"), DomainError);
  expect(err.message).toBe("cannot write env file: no config directory");
});

it("set: непригодное значение — текст ошибки дословно из спеки", async () => {
  const { store, written } = fakeStore("A=1\n");
  const envFile = makeEnvFile(store);
  const err = await rejected(() => envFile.set("A", "a'b"), DomainError);
  expect(written).toStrictEqual([]);
  // Сверка целиком, а не подстрокой: раз всё сообщение сверяется дословно,
  // само значение (секрет) не может незаметно оказаться в тексте ошибки —
  // отдельная проверка на его отсутствие избыточна.
  expect(err.message).toBe(
    "cannot write env value for A: value contains a newline or a single quote",
  );
});

it("set: дубликат ключа в файле — текст ошибки дословно из спеки", async () => {
  // Запись меняет только первую строку ключа (см. `assignEnvValue`), а
  // разбор берёт последнее значение (см. `parseEnvFile`) — на файле с
  // дубликатом эти две половины расходятся: записанное значение не то,
  // что вернёт последующий `get`. Тихо мириться с этим нельзя (инвариант
  // спеки «записанное значение действует немедленно»), поэтому `set`
  // обязан отказать раньше, чем `store.write` тронет диск.
  const { store, written } = fakeStore("PG_PORT=5432\nPG_PORT=6432\n");
  const envFile = makeEnvFile(store);
  const err = await rejected(() => envFile.set("PG_PORT", "7777"), DomainError);
  expect(written).toStrictEqual([]);
  // Сверка целиком, а не подстрокой: раз всё сообщение сверяется дословно,
  // значение для записи (секрет) не может незаметно оказаться в тексте
  // ошибки — отдельная проверка на его отсутствие избыточна.
  expect(err.message).toStrictEqual(
    "cannot write env value for PG_PORT: a later line in " +
      `${store.path} repeats the key and would override the write`,
  );
});

it("set: обычный файл без дубликатов — пишется как раньше", async () => {
  const { store, written } = fakeStore("A=1\nB=2\n");
  const envFile = makeEnvFile(store);
  await envFile.set("A", "3");
  expect(written).toStrictEqual(["A=3\nB=2\n"]);
  expect(envFile.get("A")).toBe("3");
});
