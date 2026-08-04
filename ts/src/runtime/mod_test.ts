import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DomainError, NotFoundIoError } from "../command/mod.ts";
import {
  accessTokenPath,
  defaultConfigStorePath,
  makeDenoIo,
  makeDenoOutput,
} from "./mod.ts";

Deno.test("файл токена — сосед хранилища конфига", () => {
  assertEquals(
    accessTokenPath("/home/u/.config/mpu/config.json"),
    "/home/u/.config/mpu/token",
  );
  // Без HOME хранилища нет, а значит негде держать и токен.
  assertEquals(accessTokenPath(undefined), undefined);
});

Deno.test("без конфиг-каталога токен не читается и не пишется", async () => {
  const io = makeDenoIo(undefined);
  assertEquals(await io.readAccessToken(), undefined);
  // Отказ штатный (exit 1), а не «unexpected»: пользователю сообщают
  // причину, а не трейс.
  await assertRejects(
    () => io.writeAccessToken("любой"),
    DomainError,
    "config store is unavailable",
  );
});

Deno.test("токен читается без хвостового перевода строки", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeDenoIo(`${dir}/config.json`);
    await io.writeAccessToken("token-value");
    assertEquals(await io.readAccessToken(), "token-value");
    assertEquals(await Deno.readTextFile(`${dir}/token`), "token-value\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("путь хранилища выводится из HOME", () => {
  const home = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", "/home/проба");
    assertEquals(
      defaultConfigStorePath(),
      "/home/проба/.config/mpu/config.json",
    );
    // Без HOME хранилища нет: путь угадывать нечем.
    Deno.env.delete("HOME");
    assertEquals(defaultConfigStorePath(), undefined);
    Deno.env.set("HOME", "");
    assertEquals(defaultConfigStorePath(), undefined);
  } finally {
    if (home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", home);
  }
});

Deno.test("вывод пишется целиком, даже когда поток берёт по куску", () => {
  // Приёмник пишет в реальные потоки, поэтому подменяем дескриптор на
  // скупой: он принимает по три байта за раз — ровно тот случай, ради
  // которого в записи есть цикл.
  const written: Uint8Array[] = [];
  const stingy = {
    writeSync(data: Uint8Array): number {
      const chunk = data.subarray(0, 3);
      written.push(chunk.slice());
      return chunk.length;
    },
  };
  const text = "строка с «кавычками»\n";
  const real = Deno.stdout;
  Object.defineProperty(Deno, "stdout", { value: stingy, configurable: true });
  try {
    makeDenoOutput().stdout(text);
  } finally {
    Object.defineProperty(Deno, "stdout", { value: real, configurable: true });
  }
  const joined = written.reduce<number[]>(
    (all, chunk) => [...all, ...chunk],
    [],
  );
  assertEquals(new TextDecoder().decode(Uint8Array.from(joined)), text);
});

Deno.test("отсутствующий файл переводится в NotFoundIoError", async () => {
  const io = makeDenoIo(undefined);
  await assertRejects(() => io.readFile("/нет/такого"), NotFoundIoError);
  await assertRejects(() => io.readTextFile("/нет/такого"), NotFoundIoError);
});

Deno.test("открыватель: нет бинаря — false, прочий сбой — исключение", async () => {
  const io = makeDenoIo(undefined);
  assertEquals(io.launchOpener("такого-бинаря-нет-12345", "/tmp/x"), false);

  const dir = await Deno.makeTempDir();
  try {
    // Файл есть, но не исполняем: это не «нет открывателя», и глотать
    // такую ошибку нельзя — иначе команда молча соврёт про успех.
    const path = `${dir}/opener`;
    await Deno.writeTextFile(path, "#!/bin/sh\n", { mode: 0o600 });
    // Класс не фиксируем: он зависит от прав прогона (без --allow-run
    // это NotCapable, с ним — PermissionDenied). Важно, что ошибка не
    // проглочена и наружу не ушёл ложный успех.
    assertThrows(() => io.launchOpener(path, "/tmp/x"), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("битый файл хранилища не выдаётся за пустое", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeDenoIo(`${dir}/config.json`);
    // Каталог вместо файла: ошибка чтения не NotFound и наружу проходит.
    await Deno.mkdir(`${dir}/config.json`);
    await assertRejects(() => io.readConfigStore());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
