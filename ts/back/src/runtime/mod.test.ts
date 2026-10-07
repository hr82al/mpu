import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { rejected, thrown } from "@mpu/testing/thrown";
import { DomainError, NotFoundIoError } from "../command/mod.ts";
import {
  accessTokenPath,
  defaultCredsDir,
  defaultInvokeLogPath,
  defaultStateDir,
  makeDenoIo,
  makeDenoOutput,
  makeEnvFileStore,
  parseProcStat,
  type ProcStat,
  shellInAncestors,
  tokenCachePath,
} from "./mod.ts";

it("файл токена — сосед хранилища конфига", () => {
  expect(accessTokenPath("/home/u/.config/mpu")).toBe(
    "/home/u/.config/mpu/token",
  );
  // Без HOME каталога нет, а значит негде держать и токен.
  expect(accessTokenPath(undefined)).toStrictEqual(undefined);
});

it("без каталога состояния токен не читается и не пишется", async () => {
  const io = makeDenoIo(undefined);
  expect(await io.readAccessToken()).toStrictEqual(undefined);
  // Отказ штатный (exit 1), а не «unexpected»: пользователю сообщают
  // причину, а не трейс.
  await rejected(
    () => io.writeAccessToken("любой"),
    DomainError,
    "config store is unavailable",
  );
});

it("токен читается без хвостового перевода строки", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io = makeDenoIo(dir);
    await io.writeAccessToken("token-value");
    expect(await io.readAccessToken()).toBe("token-value");
    expect(await readFile(`${dir}/token`, "utf8")).toBe("token-value\n");
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("путь каталога состояния выводится из HOME", () => {
  const home = process.env.HOME;
  try {
    process.env.HOME = "/home/проба";
    expect(defaultStateDir()).toBe("/home/проба/.config/mpu");
    // Без HOME каталога нет: путь угадывать нечем.
    delete process.env.HOME;
    expect(defaultStateDir()).toStrictEqual(undefined);
    process.env.HOME = "";
    expect(defaultStateDir()).toStrictEqual(undefined);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

/** Прогон с подменёнными переменными и возвратом прежних значений. */
function withEnv(
  values: Readonly<Record<string, string | undefined>>,
  body: () => void,
): void {
  const before = new Map<string, string | undefined>();
  for (const name of Object.keys(values)) before.set(name, process.env[name]);
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("граница каталогов: HOME уводит состояние, XDG_CONFIG_HOME — конфигурацию", () => {
  it("подменная XDG_CONFIG_HOME состояние не уводит", () => {
    withEnv({ HOME: "/home/проба", XDG_CONFIG_HOME: "/подмена" }, () => {
      // Кэш-БД и журнал общие с Python-реализацией: их адресует HOME и
      // только он (`platform/store.md`).
      expect(defaultStateDir()).toBe("/home/проба/.config/mpu");
      expect(defaultInvokeLogPath()).toBe("/home/проба/.config/mpu/mpu.log");
      expect(accessTokenPath(defaultStateDir())).toBe(
        "/home/проба/.config/mpu/token",
      );
      // А конфигурация — уводится: env-файл и выведенный из его кред
      // токен-кэш sl-back.
      expect(defaultCredsDir()).toBe("/подмена/mpu");
      expect(tokenCachePath(defaultCredsDir())).toBe(
        "/подмена/mpu/.api-token.json",
      );
    });
  });

  it("подменный HOME уводит всё — и состояние, и конфигурацию", () => {
    // Приём изоляции держится на этом: одна переменная уводит все файлы,
    // включая токен-кэш, пока XDG_CONFIG_HOME не задана.
    withEnv({ HOME: "/дом", XDG_CONFIG_HOME: undefined }, () => {
      expect(defaultStateDir()).toBe("/дом/.config/mpu");
      expect(defaultInvokeLogPath()).toBe("/дом/.config/mpu/mpu.log");
      expect(accessTokenPath(defaultStateDir())).toBe("/дом/.config/mpu/token");
      expect(defaultCredsDir()).toBe("/дом/.config/mpu");
      expect(tokenCachePath(defaultCredsDir())).toBe(
        "/дом/.config/mpu/.api-token.json",
      );
    });
  });

  it("пустая XDG_CONFIG_HOME равнозначна незаданной", () => {
    withEnv({ HOME: "/дом", XDG_CONFIG_HOME: "" }, () => {
      expect(defaultCredsDir()).toBe("/дом/.config/mpu");
    });
  });

  it("без HOME остаётся только уведённая конфигурация", () => {
    withEnv({ HOME: undefined, XDG_CONFIG_HOME: "/подмена" }, () => {
      expect(defaultStateDir()).toStrictEqual(undefined);
      expect(defaultInvokeLogPath()).toStrictEqual(undefined);
      expect(defaultCredsDir()).toBe("/подмена/mpu");
    });
    withEnv({ HOME: "", XDG_CONFIG_HOME: undefined }, () => {
      expect(defaultStateDir()).toStrictEqual(undefined);
      expect(defaultCredsDir()).toStrictEqual(undefined);
      expect(tokenCachePath(defaultCredsDir())).toStrictEqual(undefined);
    });
  });
});

it("токен-кэш sl-back ложится в каталог конфигурации, а токен доступа — в состояние", async () => {
  const state = await mkdtemp(join(tmpdir(), "mpu-"));
  const creds = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io = makeDenoIo(state, creds);
    await io.writeAccessToken("токен-доступа");
    await io.writeTokenCache('{"token":"из-кэша"}');
    expect(await readFile(`${creds}/.api-token.json`, "utf8")).toBe(
      '{"token":"из-кэша"}',
    );
    expect(await io.readTokenCache()).toBe('{"token":"из-кэша"}');
    // Кэш несёт живой токен доступа — права те же, что у прочих
    // секретов на диске (`platform/slback-http.md`, «Запись кэша»).
    const mode = (await stat(`${creds}/.api-token.json`)).mode;
    expect(mode & 0o777, "не те права у токен-кэша").toBe(0o600);
    // Файл состояния при этом остался в своём каталоге: каталоги разные.
    expect(await readFile(`${state}/token`, "utf8")).toBe("токен-доступа\n");
    expect(
      await readFile(`${creds}/token`, "utf8").catch(() => "нет файла"),
    ).toBe("нет файла");
  } finally {
    await rm(state, { recursive: true });
    await rm(creds, { recursive: true });
  }
});

it("вывод пишется целиком, даже когда поток берёт по куску", () => {
  // Приёмник пишет в реальные потоки, поэтому подменяем запись на
  // скупую: она принимает по три байта за раз — ровно тот случай, ради
  // которого в записи есть цикл.
  const written: Uint8Array[] = [];
  const fds = new Set<number>();
  const stingy = (fd: number, data: Uint8Array): number => {
    const chunk = data.subarray(0, 3);
    fds.add(fd);
    written.push(chunk.slice());
    return chunk.length;
  };
  const text = "строка с «кавычками»\n";
  // `as`: у `writeSync` перегрузки, подмена реализует ровно ту, которой
  // пишет приёмник (дескриптор и байты).
  const spy = vi
    .spyOn(fs, "writeSync")
    .mockImplementation(stingy as typeof fs.writeSync);
  try {
    makeDenoOutput().stdout(text);
  } finally {
    spy.mockRestore();
  }
  const joined = written.reduce<number[]>(
    (all, chunk) => [...all, ...chunk],
    [],
  );
  expect(new TextDecoder().decode(Uint8Array.from(joined))).toStrictEqual(text);
  expect([...fds], "запись не в stdout").toStrictEqual([1]);
});

it("отсутствующий файл переводится в NotFoundIoError", async () => {
  const io = makeDenoIo(undefined);
  await expect(io.readFile("/нет/такого")).rejects.toThrow(NotFoundIoError);
  await expect(io.readTextFile("/нет/такого")).rejects.toThrow(NotFoundIoError);
});

it("открыватель: нет бинаря — false, прочий сбой — исключение", async () => {
  const io = makeDenoIo(undefined);
  expect(io.launchOpener("такого-бинаря-нет-12345", "/tmp/x")).toBe(false);

  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Файл есть, но не исполняем: это не «нет открывателя», и глотать
    // такую ошибку нельзя — иначе команда молча соврёт про успех.
    const path = `${dir}/opener`;
    await writeFile(path, "#!/bin/sh\n", { mode: 0o600 });
    // Важно, что ошибка не проглочена и наружу не ушёл ложный успех.
    expect(() => io.launchOpener(path, "/tmp/x")).toThrow(Error);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("нечитаемое не выдаётся за пустое или отсутствующее", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io = makeDenoIo(dir);
    // Каталог вместо файла: ошибка чтения не NotFound и наружу проходит
    // как есть — ни `undefined`, ни NotFoundIoError.
    await mkdir(`${dir}/token`);
    await expect(io.readAccessToken()).rejects.toThrow();
    await expect(io.readFile(dir)).rejects.toThrow();
    await expect(io.readTextFile(dir)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("shell определяется по дереву предков, а не по SHELL", () => {
  const io = makeDenoIo(undefined);
  const shell = io.currentShell();
  // Из-под `deno test` предок — не shell, поэтому ожидается либо
  // неопределённость, либо одно из известных имён. Само определение по
  // дереву предков проверяет оператор: подменить дерево нечем.
  expect(
    shell === undefined || shell === "bash" || shell === "zsh",
    `неожиданный shell: ${shell}`,
  ).toBe(true);
  // SHELL при этом не участвует: подмена переменной ничего не меняет.
  const before = process.env.SHELL;
  try {
    process.env.SHELL = "/bin/nonexistent-shell";
    expect(io.currentShell()).toStrictEqual(shell);
  } finally {
    if (before === undefined) delete process.env.SHELL;
    else process.env.SHELL = before;
  }
});

it("дозапись в файл создаёт его и не затирает", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const io = makeDenoIo(undefined);
    const path = `${dir}/rc`;
    await io.appendFile(path, "первая\n");
    await io.appendFile(path, "вторая\n");
    expect(await readFile(path, "utf8")).toBe("первая\nвторая\n");
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("env-файл: атомарная запись создаёт каталог и права 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/cfg/mpu/.env`;
    const store = makeEnvFileStore(path);
    expect(store.readSync()).toStrictEqual(undefined);

    await store.write("A=1\n");
    expect(store.readSync()).toBe("A=1\n");
    const modeAfterFirst = (await stat(path)).mode;
    expect(modeAfterFirst & 0o777).toBe(0o600);

    await store.write("A=2\n");
    expect(store.readSync()).toBe("A=2\n");
    const modeAfterSecond = (await stat(path)).mode;
    expect(modeAfterSecond & 0o777).toBe(0o600);

    // Временных файлов не осталось: в каталоге только сам .env.
    const entries: string[] = [];
    for (const entry of await readdir(`${dir}/cfg/mpu`, {
      withFileTypes: true,
    })) {
      entries.push(entry.name);
    }
    expect(entries).toStrictEqual([".env"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("env-файл: сбой rename убирает временный файл, а не выдаёт его за успех", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/.env`;
    // Цель — каталог, а не файл: переименование поверх него не сработает,
    // и это единственный надёжный способ уронить именно последний шаг
    // записи (сам временный файл к этому моменту уже создан).
    await mkdir(path);
    const store = makeEnvFileStore(path);
    await expect(store.write("A=1\n")).rejects.toThrow();

    const entries: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      entries.push(entry.name);
    }
    // Только сам каталог-цель — временный файл убран, мусора нет.
    expect(entries).toStrictEqual([".env"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("makeDenoIo: envFile собран из настоящего пути, окружение процесса не читается", async () => {
  // Стык «путь → store → политика» (`envFilePath` → `makeEnvFileStore` →
  // `makeEnvFile` в `makeDenoIo`) ничем не проверен: мутация «всегда
  // передавать undefined вместо store» оставила бы все прочие тесты
  // зелёными, а `envFile` в тестах без этого теста нацелен на настоящий
  // `~/.config/mpu/.env` машины разработчика — подмена XDG_CONFIG_HOME
  // нужна и для изоляции, и как сама проверка стыка.
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousKey = process.env.MPU_TEST_ENV_KEY;
  try {
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.MPU_TEST_ENV_KEY;
    await mkdir(`${dir}/mpu`, { recursive: true });
    await writeFile(`${dir}/mpu/.env`, "MPU_TEST_ENV_KEY=from-file\n");

    // Без переменной окружения значение приходит из файла по временному
    // XDG_CONFIG_HOME — только так, если стык действительно собран.
    expect(makeDenoIo(undefined).envFile.get("MPU_TEST_ENV_KEY")).toBe(
      "from-file",
    );

    // Та же переменная теперь и в окружении процесса — окружение слоем
    // не читается (решение 2026-08-05, env-file.md): значение всё ещё
    // из файла, а не из окружения.
    process.env.MPU_TEST_ENV_KEY = "from-process-env";
    expect(makeDenoIo(undefined).envFile.get("MPU_TEST_ENV_KEY")).toBe(
      "from-file",
    );
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousKey === undefined) delete process.env.MPU_TEST_ENV_KEY;
    else process.env.MPU_TEST_ENV_KEY = previousKey;
    await rm(dir, { recursive: true });
  }
});

it("openCacheDb: путь — литеральный ${HOME}/.config/mpu/mpu.db, XDG_CONFIG_HOME не учитывается", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const home = process.env.HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.HOME = dir;
    // Нестандартный XDG_CONFIG_HOME не должен влиять на путь кэш-БД: файл
    // общий с Python-реализацией, путь — её контракт (`platform/store.md`).
    process.env.XDG_CONFIG_HOME = `${dir}/elsewhere`;
    using db = makeDenoIo(defaultStateDir()).openCacheDb();
    expect(db.path).toStrictEqual(`${dir}/.config/mpu/mpu.db`);
    db.bootstrap();
    expect((await stat(db.path)).isFile()).toBe(true);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
    await rm(dir, { recursive: true });
  }
});

it("openCacheDb: без HOME — DomainError с текстом спеки", () => {
  const home = process.env.HOME;
  try {
    delete process.env.HOME;
    thrown(
      () => makeDenoIo(defaultStateDir()).openCacheDb(),
      DomainError,
      "путь к кэш-БД не определён: HOME не задан",
    );
    process.env.HOME = "";
    thrown(
      () => makeDenoIo(defaultStateDir()).openCacheDb(),
      DomainError,
      "путь к кэш-БД не определён: HOME не задан",
    );
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

it("progress пишет строку с переводом строки в stderr", () => {
  const chunks: Uint8Array[] = [];
  const fds = new Set<number>();
  const stub = (fd: number, data: Uint8Array): number => {
    fds.add(fd);
    chunks.push(data.slice());
    return data.length;
  };
  // `as`: подмена реализует ту перегрузку `writeSync`, которой пишет
  // рантайм (дескриптор и байты).
  const spy = vi
    .spyOn(fs, "writeSync")
    .mockImplementation(stub as typeof fs.writeSync);
  try {
    makeDenoIo(undefined).progress("шаг 1: bootstrap готов");
  } finally {
    spy.mockRestore();
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  expect(new TextDecoder().decode(joined)).toBe("шаг 1: bootstrap готов\n");
  expect([...fds], "запись не в stderr").toStrictEqual([2]);
});

describe("разбор строки /proc/<pid>/stat", () => {
  it("обычная запись", () => {
    expect(parseProcStat("42 (bash) S 17 42 42 0 -1")).toStrictEqual({
      name: "bash",
      ppid: 17,
    });
  });

  it("имя со скобками и пробелом", () => {
    // Режем по последней скобке: имя процесса может содержать что угодно.
    expect(parseProcStat("7 (my (odd) proc) S 3 7")).toStrictEqual({
      name: "my (odd) proc",
      ppid: 3,
    });
  });

  it("испорченная строка — не запись", () => {
    expect(parseProcStat("мусор без скобок")).toStrictEqual(undefined);
    expect(parseProcStat(")42( S 1")).toStrictEqual(undefined);
  });

  it("нечитаемый ppid — считаем предком init", () => {
    expect(parseProcStat("42 (bash) S ?? 42")?.ppid).toBe(1);
  });
});

describe("поиск shell в цепочке предков", () => {
  const chain = (stats: Readonly<Record<number, ProcStat>>) => (pid: number) =>
    stats[pid];

  it("shell найден через промежуточные процессы", () => {
    const read = chain({
      10: { name: "deno", ppid: 9 },
      9: { name: "make", ppid: 8 },
      8: { name: "zsh", ppid: 1 },
    });
    expect(shellInAncestors(read, 10)).toBe("zsh");
  });

  it("login-shell с дефисом — тот же shell", () => {
    const read = chain({ 5: { name: "-bash", ppid: 1 } });
    expect(shellInAncestors(read, 5)).toBe("bash");
  });

  it("shell в цепочке нет", () => {
    const read = chain({
      4: { name: "deno", ppid: 3 },
      3: { name: "systemd", ppid: 1 },
    });
    expect(shellInAncestors(read, 4)).toStrictEqual(undefined);
  });

  it("цепочка не читается — неопределённость", () => {
    expect(shellInAncestors(() => undefined, 99)).toStrictEqual(undefined);
  });

  it("зацикленная цепочка обрывается по глубине", () => {
    // Испорченный procfs не должен вешать процесс.
    const read = (pid: number) => ({ name: "deno", ppid: pid });
    expect(shellInAncestors(read, 42)).toStrictEqual(undefined);
  });
});

it("readRegularFile: каталог и отсутствие — один ответ", async () => {
  const io = makeDenoIo(undefined);
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/artefact.md`;
    await writeFile(path, "# разбор\n");
    expect(new TextDecoder().decode(await io.readRegularFile(path))).toBe(
      "# разбор\n",
    );
    // Обычному файлу противопоставлены оба случая «читать нечего»:
    // вызывающему они неразличимы, и класс ошибки у них один.
    await expect(io.readRegularFile(dir)).rejects.toThrow(NotFoundIoError);
    await expect(io.readRegularFile(`${dir}/нет`)).rejects.toThrow(
      NotFoundIoError,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
