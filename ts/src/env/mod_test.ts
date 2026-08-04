import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { envFilePath, type EnvFileStore, makeEnvFile } from "./mod.ts";

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

Deno.test("путь: XDG_CONFIG_HOME, HOME, ни того ни другого", async (t) => {
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
    await t.step(
      name,
      () => assertEquals(envFilePath((n) => env[n]), expected),
    );
  }
});

Deno.test("приоритет: окружение процесса побеждает файл", () => {
  const { store } = fakeStore("A=from-file\nB=from-file\n");
  const envFile = makeEnvFile(
    (n) => (n === "A" ? "from-env" : undefined),
    store,
  );
  assertEquals(envFile.get("A"), "from-env");
  assertEquals(envFile.get("B"), "from-file");
  assertEquals(envFile.get("C"), undefined);
});

Deno.test("приоритет: пустая переменная окружения побеждает и считается пустой", () => {
  const { store } = fakeStore("A=from-file\n");
  const envFile = makeEnvFile((n) => (n === "A" ? "" : undefined), store);
  assertEquals(envFile.get("A"), "");
  assertThrows(() => envFile.require("A"), DomainError);
});

Deno.test("файл читается ровно один раз за процесс", () => {
  const { store, reads } = fakeStore("A=1\nB=2\n");
  const envFile = makeEnvFile(() => undefined, store);
  envFile.get("A");
  envFile.get("B");
  envFile.get("нет такого");
  assertEquals(reads(), 1);
});

Deno.test("отсутствующего файла нет — не ошибка", () => {
  const { store } = fakeStore(undefined);
  assertEquals(makeEnvFile(() => undefined, store).get("A"), undefined);
});

Deno.test("require: возвращает значение из окружения или файла", () => {
  const { store } = fakeStore("A=1\n");
  const envFile = makeEnvFile(
    (n) => (n === "B" ? "from-env" : undefined),
    store,
  );
  assertEquals(envFile.require("A"), "1");
  assertEquals(envFile.require("B"), "from-env");
});

Deno.test("require: текст ошибки дословно из спеки", () => {
  const { store } = fakeStore("");
  const envFile = makeEnvFile(() => undefined, store);
  const err = assertThrows(() => envFile.require("PG_HOST"), DomainError);
  assertEquals(
    err.message,
    "environment variable PG_HOST is not set. " +
      "Add it to /cfg/mpu/.env or export in shell.",
  );
});

Deno.test("require: без файла хранилища — путь-дефолт в тексте ошибки", () => {
  const envFile = makeEnvFile(() => undefined, undefined);
  const err = assertThrows(() => envFile.require("PG_HOST"), DomainError);
  assertEquals(
    err.message,
    "environment variable PG_HOST is not set. " +
      "Add it to ~/.config/mpu/.env or export in shell.",
  );
});

Deno.test("set: записывает файл и действует немедленно", async () => {
  const { store, written } = fakeStore("KEEP=1\n");
  const envFile = makeEnvFile(() => undefined, store);
  await envFile.set("TOKEN", "abc");
  assertEquals(written, ["KEEP=1\nTOKEN=abc\n"]);
  assertEquals(envFile.get("TOKEN"), "abc");
});

Deno.test("set: без файла хранилища — текст ошибки дословно из спеки", async () => {
  const envFile = makeEnvFile(() => undefined, undefined);
  const err = await assertRejects(() => envFile.set("A", "1"), DomainError);
  assertEquals(err.message, "cannot write env file: no config directory");
});

Deno.test("set: непригодное значение — текст ошибки дословно из спеки", async () => {
  const { store, written } = fakeStore("A=1\n");
  const envFile = makeEnvFile(() => undefined, store);
  const err = await assertRejects(() => envFile.set("A", "a'b"), DomainError);
  assertEquals(written, []);
  // Сверка целиком, а не подстрокой: раз всё сообщение сверяется дословно,
  // само значение (секрет) не может незаметно оказаться в тексте ошибки —
  // отдельная проверка на его отсутствие избыточна.
  assertEquals(
    err.message,
    "cannot write env value for A: value contains a newline or a single quote",
  );
});

Deno.test("set: дубликат ключа в файле — текст ошибки дословно из спеки", async () => {
  // Запись меняет только первую строку ключа (см. `assignEnvValue`), а
  // разбор берёт последнее значение (см. `parseEnvFile`) — на файле с
  // дубликатом эти две половины расходятся: записанное значение не то,
  // что вернёт последующий `get`. Тихо мириться с этим нельзя (инвариант
  // спеки «записанное значение действует немедленно»), поэтому `set`
  // обязан отказать раньше, чем `store.write` тронет диск.
  const { store, written } = fakeStore("PG_PORT=5432\nPG_PORT=6432\n");
  const envFile = makeEnvFile(() => undefined, store);
  const err = await assertRejects(
    () => envFile.set("PG_PORT", "7777"),
    DomainError,
  );
  assertEquals(written, []);
  // Сверка целиком, а не подстрокой: раз всё сообщение сверяется дословно,
  // значение для записи (секрет) не может незаметно оказаться в тексте
  // ошибки — отдельная проверка на его отсутствие избыточна.
  assertEquals(
    err.message,
    "cannot write env value for PG_PORT: a later line in " +
      `${store.path} repeats the key and would override the write`,
  );
});

Deno.test("set: обычный файл без дубликатов — пишется как раньше", async () => {
  const { store, written } = fakeStore("A=1\nB=2\n");
  const envFile = makeEnvFile(() => undefined, store);
  await envFile.set("A", "3");
  assertEquals(written, ["A=3\nB=2\n"]);
  assertEquals(envFile.get("A"), "3");
});
