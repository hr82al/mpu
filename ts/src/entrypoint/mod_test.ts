import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { CommandIo } from "../command/mod.ts";

/**
 * Точка входа маршрутизирует и печатает; io при этом почти не нужен —
 * подстановки принимаются для команд, которые до отказа успевают
 * тронуть окружение.
 */
function makeCli(overrides: Partial<CommandIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io = makeFakeIo(overrides);
  const output = {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  };
  return {
    run: (...args: string[]) => runCli(args, io, output),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

Deno.test("корень: bare печатает индекс и падает, --help — тот же с 0", async () => {
  const bare = makeCli();
  assertEquals(await bare.run(), 2);
  const help = makeCli();
  assertEquals(await help.run("--help"), 0);
  assertEquals(bare.stdout(), help.stdout());
  assertStringIncludes(help.stdout(), "Подкоманды:");
  // Индекс собирается из реестра: группа верхнего уровня видна.
  assertStringIncludes(help.stdout(), "xlsx");
});

Deno.test("корень: справка называет, какая переменная какие файлы уводит", async () => {
  const cli = makeCli();
  assertEquals(await cli.run("--help"), 0);
  const help = cli.stdout();
  // Переменных две, и уводят они разное: без этого текста оператор
  // подменяет XDG_CONFIG_HOME и получает чужой env-файл при своей
  // кэш-БД (`platform/store.md`).
  assertStringIncludes(help, "Окружение:");
  assertStringIncludes(help, "HOME");
  assertStringIncludes(help, "mpu.db");
  assertStringIncludes(help, "mpu.log");
  assertStringIncludes(help, "XDG_CONFIG_HOME");
  assertStringIncludes(help, ".env");
  assertStringIncludes(help, ".api-token.json");
  // Полный приём изоляции назван: подмена HOME, а не XDG_CONFIG_HOME.
  assertStringIncludes(
    help,
    "Изолировать разом и состояние, и конфигурацию можно только подменой HOME.",
  );
  // У промежуточного уровня хвоста нет: правило — корневое.
  const group = makeCli();
  assertEquals(await group.run("xlsx", "--help"), 0);
  assertEquals(group.stdout().includes("Окружение:"), false);
});

Deno.test("корень: неизвестные имя и опция — exit 2", async (t) => {
  await t.step("неизвестная команда", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("wat"), 2);
    assertEquals(
      cli.stderr(),
      "No such command 'wat'.\nTry 'mpu -h' for help.\n",
    );
  });
  await t.step("неизвестная опция", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("--version"), 2);
    assertEquals(cli.stderr(), `No such option "--version"\n`);
  });
});

Deno.test("--json: общий параметр на любом уровне вложенности", async (t) => {
  await t.step("структурный результат вместо текста", async () => {
    const cli = makeCli();
    const code = await cli.run("xlsx", "alias", "ls", "--json");
    assertEquals(code, 0);
    assertEquals(JSON.parse(cli.stdout()), { aliases: [] });
  });
  await t.step("текстовая форма того же вызова", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "ls"), 0);
    assertEquals(cli.stdout(), "");
  });
  await t.step("флаг снимается до разбора аргументов команды", async () => {
    // Команда о существовании --json не знает: в её схеме его нет, и
    // «unknown option» она не увидит.
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "--json", "alias", "ls"), 0);
    assertEquals(JSON.parse(cli.stdout()), { aliases: [] });
  });
  await t.step("после «--» флаг остаётся аргументом команды", async () => {
    const cli = makeCli();
    const code = await cli.run("xlsx", "get", "--", "--json");
    // «--json» ушёл в позиционные диапазоны (голое имя листа), поэтому
    // разбор дошёл до резолва пути, а формы вывода не запрашивал:
    // stdout пуст, ошибка — про незаданный путь.
    assertEquals(code, 2);
    assertEquals(cli.stdout(), "");
    assertStringIncludes(cli.stderr(), "путь к .xlsx не задан");
  });
});

Deno.test("группа: индекс уровня и неизвестная подкоманда", async (t) => {
  await t.step("bare группа — индекс и exit 2", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias"), 2);
    assertStringIncludes(cli.stdout(), "add");
    assertStringIncludes(cli.stdout(), "rm");
  });
  await t.step("--help группы — тот же индекс и exit 0", async () => {
    const bare = makeCli();
    await bare.run("xlsx", "alias");
    const help = makeCli();
    assertEquals(await help.run("xlsx", "alias", "--help"), 0);
    assertEquals(help.stdout(), bare.stdout());
  });
  await t.step("неизвестная подкоманда группы — exit 2", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "wat"), 2);
    assertEquals(
      cli.stderr(),
      "No such command 'xlsx alias wat'.\nTry 'mpu -h' for help.\n",
    );
  });
});

Deno.test("листовая справка печатается вместо исполнения", async () => {
  const cli = makeCli();
  assertEquals(await cli.run("xlsx", "get", "--help"), 0);
  assertStringIncludes(cli.stdout(), "Использование: mpu xlsx get");
  assertStringIncludes(cli.stdout(), "значения диапазонов книги");
});

/**
 * Тело секции справки без заголовка. Сверять по всему тексту нельзя:
 * те же слова есть в строке использования, и тест прошёл бы, даже если
 * секция не печатается вовсе.
 */
function sectionOf(help: string, title: string): string {
  const start = help.indexOf(`${title}:\n`);
  if (start < 0) throw new Error(`в справке нет секции «${title}»`);
  const body = help.slice(start + title.length + 2);
  return body.slice(0, body.indexOf("\n\n"));
}

Deno.test("перечень входов справки собирается из схемы", async (t) => {
  await t.step(
    "флаги: обе формы записи, место значения, умолчание",
    async () => {
      const cli = makeCli();
      assertEquals(await cli.run("xlsx", "get", "--help"), 0);
      const flags = sectionOf(cli.stdout(), "Флаги");
      assertStringIncludes(flags, "-f, --file FILE");
      // Вход без короткой формы выравнивается по длинным именам.
      assertStringIncludes(flags, "      --from FROM");
      // Ограниченный набор значений виден на месте значения, а не в тексте.
      assertStringIncludes(flags, "--render both|values|formulas");
      // Умолчание берётся из схемы; перенос строки может разорвать
      // скобку, поэтому сверяется хвост.
      assertStringIncludes(flags, "умолчанию: both)");
      // Описание входа приходит из схемы, а не из текста справки.
      assertStringIncludes(flags, "что попадает в ячейку результата");
    },
  );

  await t.step("позиционные входы — отдельной секцией", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "add", "--help"), 0);
    const args = sectionOf(cli.stdout(), "Аргументы");
    assertStringIncludes(args, "NAME");
    assertStringIncludes(args, "имя алиаса");
    assertStringIncludes(args, "(обязателен)");
    // Флагов у команды нет — пустой секции тоже.
    assertEquals(cli.stdout().includes("Флаги:"), false);
  });

  await t.step(
    "вход, забирающий остаток argv, помечен многоточием",
    async () => {
      const cli = makeCli();
      assertEquals(await cli.run("xlsx", "get", "--help"), 0);
      assertStringIncludes(sectionOf(cli.stdout(), "Аргументы"), "RANGES...");
    },
  );

  await t.step("команда без входов обходится без секций", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "ls", "--help"), 0);
    assertEquals(cli.stdout().includes("Флаги:"), false);
    assertEquals(cli.stdout().includes("Аргументы:"), false);
  });
});

/**
 * Окружение, которого хватает `mpu ssh` до отказа выбора транспорта:
 * stdin с терминала (пустой) и приёмник вывода, к которому дело не
 * дойдёт.
 */
const SSH_IO: Partial<CommandIo> = {
  stdinIsTerminal: () => true,
  openRemoteOutput: () => ({
    out: () => {},
    err: () => {},
    captured: () => "",
  }),
};

/** Окружение, которого хватает `mpu sql-ro --dry`: адрес и креды. */
const SQL_IO: Partial<CommandIo> = {
  envFile: {
    get: (name) => SQL_ENV[name],
    values: () => ({ ...SQL_ENV }),
    require: (name) => SQL_ENV[name] ?? "",
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  },
};

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

Deno.test("--json не перехватывается у команды с хвостовым входом", async (t) => {
  // `mpu ssh sl-1 mycli --json` — флаг чужой командной строки
  // (`platform/registry.md`). Различить перехват и его отсутствие можно
  // по тому, осталась ли команда непустой: съеденный флаг оставил бы её
  // пустой, и отказ был бы другой.
  await t.step("флаг доезжает удалённой командой", async () => {
    const cli = makeCli(SSH_IO);
    assertEquals(await cli.run("ssh", "sl-1", "--json"), 2);
    assertStringIncludes(cli.stderr(), "для sl-1 не задано ни sl_1");
    assertEquals(cli.stdout(), "");
  });

  await t.step("после `--` — так же", async () => {
    const cli = makeCli(SSH_IO);
    assertEquals(await cli.run("ssh", "sl-1", "--", "--json"), 2);
    assertStringIncludes(cli.stderr(), "для sl-1 не задано ни sl_1");
  });

  await t.step("до имени команды — ошибка ввода, а не молчание", async () => {
    // До имени команды чужой командной строки ещё нет, поэтому параметр
    // снят обычным порядком; применить его не к чему
    // (`platform/registry.md`).
    const cli = makeCli(SSH_IO);
    assertEquals(await cli.run("--json", "ssh", "sl-1", "ls"), 2);
    assertEquals(
      cli.stderr(),
      "mpu: --json не применяется к команде 'ssh'\n",
    );
    assertEquals(cli.stdout(), "");
  });

  await t.step("у команды со своим --json до имени — он общий", async () => {
    // Исключения второго рода у неё нет: структурная форма вывода есть,
    // и снятый до имени параметр применяется генерически, а не
    // отказывает (`platform/registry.md`).
    const cli = makeCli(SQL_IO);
    assertEquals(
      await cli.run("--json", "sql-ro", "sl-1", "SELECT 1", "--dry"),
      0,
    );
    assertStringIncludes(cli.stdout(), '"dry": true');
    // Мета-блок `--dry` идёт в stderr своим порядком — форма вывода на
    // него не влияет.
    assertStringIncludes(cli.stderr(), "server: sl-1");
  });

  await t.step("у обычной команды флаг по-прежнему общий", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "ls", "--json"), 0);
    assertStringIncludes(cli.stdout(), "{");
  });
});

Deno.test("голый вызов обёртки печатает справку, а не сообщение схемы", async () => {
  // Признак объявляет команда: у соседей с обязательным входом текст
  // отказа свой и закреплён их спеками (`specs/sql-ro.md`).
  const cli = makeCli();
  assertEquals(await cli.run("ss-update"), 2);
  assertStringIncludes(cli.stdout(), "mpu ss-update");
  assertStringIncludes(cli.stdout(), "--print");
  assertEquals(cli.stderr(), "");
});

Deno.test("раскладка selector-first: селектор до имени подкоманды", async (t) => {
  await t.step("подкоманда опознаётся за селектором", async () => {
    const cli = makeCli();
    // Разбор argv листа доказывает, что путь опознан целиком: отказ
    // приходит от схемы подкоманды и подсказкой называет её полный
    // путь. До io и до сети вызов при этом не доходит.
    assertEquals(await cli.run("ozon-jobs", "sl-2", "show", "--нет-флага"), 2);
    assertStringIncludes(cli.stderr(), "mpu ozon-jobs: unknown option");
    assertStringIncludes(cli.stderr(), "mpu ozon-jobs show --help");
  });

  await t.step("режимы печати перед селектором не мешают", async () => {
    const cli = makeCli();
    assertEquals(
      await cli.run("ozon-jobs", "-p", "sl-2", "show", "--нет-флага"),
      2,
    );
    assertStringIncludes(cli.stderr(), "mpu ozon-jobs show --help");
  });

  await t.step("селектор после подкоманды — ошибка ввода", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("ozon-jobs", "show", "sl-2"), 2);
    assertEquals(
      cli.stderr(),
      "mpu ozon-jobs: селектор ставится перед именем подкоманды\n",
    );
    assertEquals(cli.stdout(), "");
  });

  await t.step("голая подкоманда — справка листа, exit 2", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("ozon-jobs", "show"), 2);
    assertStringIncludes(cli.stdout(), "mpu ozon-jobs [-p [--local]] SELECTOR");
  });

  await t.step("справка подкоманды доступна за её именем", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("ozon-jobs", "show", "--help"), 0);
    assertStringIncludes(cli.stdout(), "service:ozonJobs showJobs");
  });

  await t.step("подкоманда не названа — индекс группы, exit 2", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("ozon-jobs", "sl-2"), 2);
    assertStringIncludes(cli.stdout(), "prune");
    assertEquals(cli.stderr(), "");
  });

  await t.step("--help уровня группы печатает индекс", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("ozon-jobs", "--help"), 0);
    assertStringIncludes(cli.stdout(), "show");
  });

  await t.step("значение флага подкомандой не считается", async () => {
    // `--pattern prune` — образец у подкоманды `show`, а не вызов
    // `prune`: спутай их, и вместо показа очереди она была бы
    // вычищена, молча и в проде.
    const cli = makeCli();
    assertEquals(
      await cli.run("ozon-jobs", "sl-2", "--pattern", "prune", "show", "--нет"),
      2,
    );
    assertStringIncludes(cli.stderr(), "mpu ozon-jobs show --help");
    assertEquals(cli.stderr().includes("prune --help"), false);
  });

  await t.step("образец после подкоманды не ломает опознание", async () => {
    const cli = makeCli();
    assertEquals(
      await cli.run("ozon-jobs", "sl-2", "prune", "--pattern", "show", "--нет"),
      2,
    );
    assertStringIncludes(cli.stderr(), "mpu ozon-jobs prune --help");
  });

  await t.step("у обычной группы порядок прежний", async () => {
    // `wb-loader` раскладки не объявляет: селектор идёт после имени
    // подкоманды, и токен перед ним подкомандой не считается.
    const cli = makeCli();
    assertEquals(await cli.run("wb-loader", "777", "cards"), 2);
    assertEquals(
      cli.stderr(),
      "No such command 'wb-loader 777'.\nTry 'mpu -h' for help.\n",
    );
  });
});
