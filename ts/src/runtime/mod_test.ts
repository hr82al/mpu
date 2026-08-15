import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DomainError, NotFoundIoError } from "../command/mod.ts";
import {
  accessTokenPath,
  defaultConfigStorePath,
  makeDenoIo,
  makeDenoOutput,
  makeEnvFileStore,
  parseProcStat,
  type ProcStat,
  shellInAncestors,
} from "./mod.ts";

Deno.test("файл токена — сосед хранилища конфига", () => {
  assertEquals(
    accessTokenPath("/home/u/.config/mpu/config.json"),
    "/home/u/.config/mpu/token",
  );
  // Без HOME хранилища нет, а значит негде держать и токен.
  assertEquals(accessTokenPath(undefined), undefined);
});

Deno.test("без конфиг-каталога хранилище не читается и не пишется", async () => {
  const io = makeDenoIo(undefined);
  assertEquals(await io.readConfigStore(), undefined);
  await assertRejects(
    () => io.writeConfigStore("{}"),
    DomainError,
    "config store is unavailable",
  );
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

Deno.test("нечитаемое не выдаётся за пустое или отсутствующее", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeDenoIo(`${dir}/config.json`);
    // Каталог вместо файла: ошибка чтения не NotFound и наружу проходит
    // как есть — ни `undefined`, ни NotFoundIoError.
    await Deno.mkdir(`${dir}/config.json`);
    await Deno.mkdir(`${dir}/token`);
    await assertRejects(() => io.readConfigStore());
    await assertRejects(() => io.readAccessToken());
    await assertRejects(() => io.readFile(dir));
    await assertRejects(() => io.readTextFile(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("подпроцесс legacy: потоки и код возврата собираются", async (t) => {
  const io = makeDenoIo(undefined);

  await t.step("stdout и код 0", async () => {
    const outcome = await io.runLegacy("/bin/echo", ["строка", "вторая"]);
    assertEquals(outcome, {
      code: 0,
      stdout: "строка вторая\n",
      stderr: "",
    });
  });

  await t.step("ненулевой код проходит как есть", async () => {
    const outcome = await io.runLegacy("/bin/false", []);
    assertEquals(outcome.code, 1);
    assertEquals(outcome.stdout, "");
  });

  await t.step("нет бинаря — NotFoundIoError, а не сырая ошибка", async () => {
    await assertRejects(
      () => io.runLegacy("/bin/net-takogo-binarya", []),
      NotFoundIoError,
      "cannot run",
    );
  });

  await t.step("не исполняем — тот же класс ошибки", async () => {
    // Исполнимость проверяется до запуска, поэтому права на запуск
    // этого пути не нужно — можно взять обычный временный каталог.
    const dir = await Deno.makeTempDir();
    try {
      const path = `${dir}/not-executable`;
      await Deno.writeTextFile(path, "#!/bin/sh\n", { mode: 0o600 });
      await assertRejects(
        () => io.runLegacy(path, []),
        NotFoundIoError,
        "not executable",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("подпроцесс с проброшенным терминалом: только код возврата", async (t) => {
  // Шаг 5 `mpu init` отдаёт терминал подпроцессу целиком, поэтому здесь
  // проверяется ровно то, что видит вызывающий: код возврата и класс
  // ошибки несостоявшегося запуска. Вывод подпроцесса не собирается —
  // он идёт пользователю мимо нас.
  const io = makeDenoIo(undefined);

  await t.step("нулевой код", async () => {
    assertEquals(await io.runLegacyInteractive("/bin/echo", []), 0);
  });

  await t.step("ненулевой код проходит как есть", async () => {
    assertEquals(await io.runLegacyInteractive("/bin/false", []), 1);
  });

  await t.step("нет бинаря — NotFoundIoError, а не сырая ошибка", async () => {
    await assertRejects(
      () => io.runLegacyInteractive("/bin/net-takogo-binarya", []),
      NotFoundIoError,
      "cannot run",
    );
  });
});

Deno.test("shell определяется по дереву предков, а не по SHELL", () => {
  const io = makeDenoIo(undefined);
  const shell = io.currentShell();
  // Из-под `deno test` предок — не shell, поэтому ожидается либо
  // неопределённость, либо одно из известных имён. Само определение по
  // дереву предков проверяет оператор: подменить дерево нечем.
  assertEquals(
    shell === undefined || shell === "bash" || shell === "zsh",
    true,
    `неожиданный shell: ${shell}`,
  );
  // SHELL при этом не участвует: подмена переменной ничего не меняет.
  const before = Deno.env.get("SHELL");
  try {
    Deno.env.set("SHELL", "/bin/nonexistent-shell");
    assertEquals(io.currentShell(), shell);
  } finally {
    if (before === undefined) Deno.env.delete("SHELL");
    else Deno.env.set("SHELL", before);
  }
});

Deno.test("дозапись в файл создаёт его и не затирает", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeDenoIo(undefined);
    const path = `${dir}/rc`;
    await io.appendFile(path, "первая\n");
    await io.appendFile(path, "вторая\n");
    assertEquals(await Deno.readTextFile(path), "первая\nвторая\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-файл: атомарная запись создаёт каталог и права 0600", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/cfg/mpu/.env`;
    const store = makeEnvFileStore(path);
    assertEquals(store.readSync(), undefined);

    await store.write("A=1\n");
    assertEquals(store.readSync(), "A=1\n");
    const modeAfterFirst = (await Deno.stat(path)).mode;
    assertEquals(
      modeAfterFirst === null ? null : modeAfterFirst & 0o777,
      0o600,
    );

    await store.write("A=2\n");
    assertEquals(store.readSync(), "A=2\n");
    const modeAfterSecond = (await Deno.stat(path)).mode;
    assertEquals(
      modeAfterSecond === null ? null : modeAfterSecond & 0o777,
      0o600,
    );

    // Временных файлов не осталось: в каталоге только сам .env.
    const entries: string[] = [];
    for await (const entry of Deno.readDir(`${dir}/cfg/mpu`)) {
      entries.push(entry.name);
    }
    assertEquals(entries, [".env"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-файл: сбой rename убирает временный файл, а не выдаёт его за успех", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.env`;
    // Цель — каталог, а не файл: Deno.rename поверх него не сработает,
    // и это единственный надёжный способ уронить именно последний шаг
    // записи (сам временный файл к этому моменту уже создан).
    await Deno.mkdir(path);
    const store = makeEnvFileStore(path);
    await assertRejects(() => store.write("A=1\n"));

    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    // Только сам каталог-цель — временный файл убран, мусора нет.
    assertEquals(entries, [".env"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("makeDenoIo: envFile собран из настоящего пути, окружение процесса не читается", async () => {
  // Стык «путь → store → политика» (`envFilePath` → `makeEnvFileStore` →
  // `makeEnvFile` в `makeDenoIo`) ничем не проверен: мутация «всегда
  // передавать undefined вместо store» оставила бы все прочие тесты
  // зелёными, а `envFile` в тестах без этого теста нацелен на настоящий
  // `~/.config/mpu/.env` машины разработчика — подмена XDG_CONFIG_HOME
  // нужна и для изоляции, и как сама проверка стыка.
  const dir = await Deno.makeTempDir();
  const previousXdg = Deno.env.get("XDG_CONFIG_HOME");
  const previousKey = Deno.env.get("MPU_TEST_ENV_KEY");
  try {
    Deno.env.set("XDG_CONFIG_HOME", dir);
    Deno.env.delete("MPU_TEST_ENV_KEY");
    await Deno.mkdir(`${dir}/mpu`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/mpu/.env`,
      "MPU_TEST_ENV_KEY=from-file\n",
    );

    // Без переменной окружения значение приходит из файла по временному
    // XDG_CONFIG_HOME — только так, если стык действительно собран.
    assertEquals(
      makeDenoIo(undefined).envFile.get("MPU_TEST_ENV_KEY"),
      "from-file",
    );

    // Та же переменная теперь и в окружении процесса — окружение слоем
    // не читается (решение 2026-08-05, env-file.md): значение всё ещё
    // из файла, а не из окружения.
    Deno.env.set("MPU_TEST_ENV_KEY", "from-process-env");
    assertEquals(
      makeDenoIo(undefined).envFile.get("MPU_TEST_ENV_KEY"),
      "from-file",
    );
  } finally {
    if (previousXdg === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previousXdg);
    if (previousKey === undefined) Deno.env.delete("MPU_TEST_ENV_KEY");
    else Deno.env.set("MPU_TEST_ENV_KEY", previousKey);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCacheDb: путь — литеральный ${HOME}/.config/mpu/mpu.db, XDG_CONFIG_HOME не учитывается", async () => {
  const dir = await Deno.makeTempDir();
  const home = Deno.env.get("HOME");
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("HOME", dir);
    // Нестандартный XDG_CONFIG_HOME не должен влиять на путь кэш-БД: файл
    // общий с Python-реализацией, путь — её контракт (`platform/store.md`).
    Deno.env.set("XDG_CONFIG_HOME", `${dir}/elsewhere`);
    using db = makeDenoIo(undefined).openCacheDb();
    assertEquals(db.path, `${dir}/.config/mpu/mpu.db`);
    db.bootstrap();
    assertEquals((await Deno.stat(db.path)).isFile, true);
  } finally {
    if (home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", home);
    if (xdg === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", xdg);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCacheDb: без HOME — DomainError с текстом спеки", () => {
  const home = Deno.env.get("HOME");
  try {
    Deno.env.delete("HOME");
    assertThrows(
      () => makeDenoIo(undefined).openCacheDb(),
      DomainError,
      "путь к кэш-БД не определён: HOME не задан",
    );
    Deno.env.set("HOME", "");
    assertThrows(
      () => makeDenoIo(undefined).openCacheDb(),
      DomainError,
      "путь к кэш-БД не определён: HOME не задан",
    );
  } finally {
    if (home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", home);
  }
});

Deno.test("progress пишет строку с переводом строки в stderr", () => {
  const chunks: Uint8Array[] = [];
  const stub = {
    writeSync(data: Uint8Array): number {
      chunks.push(data.slice());
      return data.length;
    },
  };
  const real = Deno.stderr;
  Object.defineProperty(Deno, "stderr", { value: stub, configurable: true });
  try {
    makeDenoIo(undefined).progress("шаг 1: bootstrap готов");
  } finally {
    Object.defineProperty(Deno, "stderr", { value: real, configurable: true });
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  assertEquals(new TextDecoder().decode(joined), "шаг 1: bootstrap готов\n");
});

Deno.test("разбор строки /proc/<pid>/stat", async (t) => {
  await t.step("обычная запись", () => {
    assertEquals(parseProcStat("42 (bash) S 17 42 42 0 -1"), {
      name: "bash",
      ppid: 17,
    });
  });

  await t.step("имя со скобками и пробелом", () => {
    // Режем по последней скобке: имя процесса может содержать что угодно.
    assertEquals(parseProcStat("7 (my (odd) proc) S 3 7"), {
      name: "my (odd) proc",
      ppid: 3,
    });
  });

  await t.step("испорченная строка — не запись", () => {
    assertEquals(parseProcStat("мусор без скобок"), undefined);
    assertEquals(parseProcStat(")42( S 1"), undefined);
  });

  await t.step("нечитаемый ppid — считаем предком init", () => {
    assertEquals(parseProcStat("42 (bash) S ?? 42")?.ppid, 1);
  });
});

Deno.test("поиск shell в цепочке предков", async (t) => {
  const chain = (stats: Readonly<Record<number, ProcStat>>) => (pid: number) =>
    stats[pid];

  await t.step("shell найден через промежуточные процессы", () => {
    const read = chain({
      10: { name: "deno", ppid: 9 },
      9: { name: "make", ppid: 8 },
      8: { name: "zsh", ppid: 1 },
    });
    assertEquals(shellInAncestors(read, 10), "zsh");
  });

  await t.step("login-shell с дефисом — тот же shell", () => {
    const read = chain({ 5: { name: "-bash", ppid: 1 } });
    assertEquals(shellInAncestors(read, 5), "bash");
  });

  await t.step("shell в цепочке нет", () => {
    const read = chain({
      4: { name: "deno", ppid: 3 },
      3: { name: "systemd", ppid: 1 },
    });
    assertEquals(shellInAncestors(read, 4), undefined);
  });

  await t.step("цепочка не читается — неопределённость", () => {
    assertEquals(shellInAncestors(() => undefined, 99), undefined);
  });

  await t.step("зацикленная цепочка обрывается по глубине", () => {
    // Испорченный procfs не должен вешать процесс.
    const read = (pid: number) => ({ name: "deno", ppid: pid });
    assertEquals(shellInAncestors(read, 42), undefined);
  });
});

Deno.test("readRegularFile: каталог и отсутствие — один ответ", async () => {
  const io = makeDenoIo(undefined);
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/artefact.md`;
    await Deno.writeTextFile(path, "# разбор\n");
    assertEquals(
      new TextDecoder().decode(await io.readRegularFile(path)),
      "# разбор\n",
    );
    // Обычному файлу противопоставлены оба случая «читать нечего»:
    // вызывающему они неразличимы, и класс ошибки у них один.
    await assertRejects(() => io.readRegularFile(dir), NotFoundIoError);
    await assertRejects(
      () => io.readRegularFile(`${dir}/нет`),
      NotFoundIoError,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
