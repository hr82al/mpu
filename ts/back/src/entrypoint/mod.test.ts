import { describe, expect, it } from "vitest";
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

it("корень: bare печатает индекс и падает, --help — тот же с 0", async () => {
  const bare = makeCli();
  expect(await bare.run()).toBe(2);
  const help = makeCli();
  expect(await help.run("--help")).toBe(0);
  expect(bare.stdout()).toStrictEqual(help.stdout());
  expect(help.stdout()).toContain("Подкоманды:");
  // Индекс собирается из реестра: группа верхнего уровня видна.
  expect(help.stdout()).toContain("xlsx");
});

it("корень: справка называет, какая переменная какие файлы уводит", async () => {
  const cli = makeCli();
  expect(await cli.run("--help")).toBe(0);
  const help = cli.stdout();
  // Переменных две, и уводят они разное: без этого текста оператор
  // подменяет XDG_CONFIG_HOME и получает чужой env-файл при своей
  // кэш-БД (`platform/store.md`).
  expect(help).toContain("Окружение:");
  expect(help).toContain("HOME");
  expect(help).toContain("mpu.db");
  expect(help).toContain("mpu.log");
  expect(help).toContain("XDG_CONFIG_HOME");
  expect(help).toContain(".env");
  expect(help).toContain(".api-token.json");
  // Полный приём изоляции назван: подмена HOME, а не XDG_CONFIG_HOME.
  expect(help).toContain(
    "Изолировать разом и состояние, и конфигурацию можно только подменой HOME.",
  );
  // У промежуточного уровня хвоста нет: правило — корневое.
  const group = makeCli();
  expect(await group.run("xlsx", "--help")).toBe(0);
  expect(group.stdout().includes("Окружение:")).toBe(false);
});

describe("корень: неизвестные имя и опция — exit 2", () => {
  it("неизвестная команда", async () => {
    const cli = makeCli();
    expect(await cli.run("wat")).toBe(2);
    expect(cli.stderr()).toBe(
      "No such command 'wat'.\nTry 'mpu -h' for help.\n",
    );
  });
  it("неизвестная опция", async () => {
    const cli = makeCli();
    expect(await cli.run("--version")).toBe(2);
    expect(cli.stderr()).toBe(`No such option "--version"\n`);
  });
});

describe("--json: общий параметр на любом уровне вложенности", () => {
  it("структурный результат вместо текста", async () => {
    const cli = makeCli();
    const code = await cli.run("xlsx", "alias", "ls", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(cli.stdout())).toStrictEqual({ aliases: [] });
  });
  it("текстовая форма того же вызова", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "alias", "ls")).toBe(0);
    expect(cli.stdout()).toBe("");
  });
  it("флаг снимается до разбора аргументов команды", async () => {
    // Команда о существовании --json не знает: в её схеме его нет, и
    // «unknown option» она не увидит.
    const cli = makeCli();
    expect(await cli.run("xlsx", "--json", "alias", "ls")).toBe(0);
    expect(JSON.parse(cli.stdout())).toStrictEqual({ aliases: [] });
  });
  it("после «--» флаг остаётся аргументом команды", async () => {
    const cli = makeCli();
    const code = await cli.run("xlsx", "get", "--", "--json");
    // «--json» ушёл в позиционные диапазоны (голое имя листа), поэтому
    // разбор дошёл до резолва пути, а формы вывода не запрашивал:
    // stdout пуст, ошибка — про незаданный путь.
    expect(code).toBe(2);
    expect(cli.stdout()).toBe("");
    expect(cli.stderr()).toContain("путь к .xlsx не задан");
  });
});

describe("группа: индекс уровня и неизвестная подкоманда", () => {
  it("bare группа — индекс и exit 2", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "alias")).toBe(2);
    expect(cli.stdout()).toContain("add");
    expect(cli.stdout()).toContain("rm");
  });
  it("--help группы — тот же индекс и exit 0", async () => {
    const bare = makeCli();
    await bare.run("xlsx", "alias");
    const help = makeCli();
    expect(await help.run("xlsx", "alias", "--help")).toBe(0);
    expect(help.stdout()).toStrictEqual(bare.stdout());
  });
  it("неизвестная подкоманда группы — exit 2", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "alias", "wat")).toBe(2);
    expect(cli.stderr()).toBe(
      "No such command 'xlsx alias wat'.\nTry 'mpu -h' for help.\n",
    );
  });
});

it("листовая справка печатается вместо исполнения", async () => {
  const cli = makeCli();
  expect(await cli.run("xlsx", "get", "--help")).toBe(0);
  expect(cli.stdout()).toContain("Использование: mpu xlsx get");
  expect(cli.stdout()).toContain("значения диапазонов книги");
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

describe("перечень входов справки собирается из схемы", () => {
  it("флаги: обе формы записи, место значения, умолчание", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "get", "--help")).toBe(0);
    const flags = sectionOf(cli.stdout(), "Флаги");
    expect(flags).toContain("-f, --file FILE");
    // Вход без короткой формы выравнивается по длинным именам.
    expect(flags).toContain("      --from FROM");
    // Ограниченный набор значений виден на месте значения, а не в тексте.
    expect(flags).toContain("--render both|values|formulas");
    // Умолчание берётся из схемы; перенос строки может разорвать
    // скобку, поэтому сверяется хвост.
    expect(flags).toContain("умолчанию: both)");
    // Описание входа приходит из схемы, а не из текста справки.
    expect(flags).toContain("что попадает в ячейку результата");
  });

  it("позиционные входы — отдельной секцией", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "alias", "add", "--help")).toBe(0);
    const args = sectionOf(cli.stdout(), "Аргументы");
    expect(args).toContain("NAME");
    expect(args).toContain("имя алиаса");
    expect(args).toContain("(обязателен)");
    // Флагов у команды нет — пустой секции тоже.
    expect(cli.stdout().includes("Флаги:")).toBe(false);
  });

  it("вход, забирающий остаток argv, помечен многоточием", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "get", "--help")).toBe(0);
    expect(sectionOf(cli.stdout(), "Аргументы")).toContain("RANGES...");
  });

  it("команда без входов обходится без секций", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "alias", "ls", "--help")).toBe(0);
    expect(cli.stdout().includes("Флаги:")).toBe(false);
    expect(cli.stdout().includes("Аргументы:")).toBe(false);
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
    out: () => Promise.resolve(),
    err: () => Promise.resolve(),
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

describe("--json не перехватывается у команды с хвостовым входом", () => {
  // `mpu ssh sl-1 mycli --json` — флаг чужой командной строки
  // (`platform/registry.md`). Различить перехват и его отсутствие можно
  // по тому, осталась ли команда непустой: съеденный флаг оставил бы её
  // пустой, и отказ был бы другой.
  it("флаг доезжает удалённой командой", async () => {
    const cli = makeCli(SSH_IO);
    expect(await cli.run("ssh", "sl-1", "--json")).toBe(2);
    expect(cli.stderr()).toContain("для sl-1 не задано ни sl_1");
    expect(cli.stdout()).toBe("");
  });

  it("после `--` — так же", async () => {
    const cli = makeCli(SSH_IO);
    expect(await cli.run("ssh", "sl-1", "--", "--json")).toBe(2);
    expect(cli.stderr()).toContain("для sl-1 не задано ни sl_1");
  });

  it("до имени команды — ошибка ввода, а не молчание", async () => {
    // До имени команды чужой командной строки ещё нет, поэтому параметр
    // снят обычным порядком; применить его не к чему
    // (`platform/registry.md`).
    const cli = makeCli(SSH_IO);
    expect(await cli.run("--json", "ssh", "sl-1", "ls")).toBe(2);
    expect(cli.stderr()).toBe("mpu: --json не применяется к команде 'ssh'\n");
    expect(cli.stdout()).toBe("");
  });

  it("у команды со своим --json до имени — он общий", async () => {
    // Исключения второго рода у неё нет: структурная форма вывода есть,
    // и снятый до имени параметр применяется генерически, а не
    // отказывает (`platform/registry.md`).
    const cli = makeCli(SQL_IO);
    expect(await cli.run("--json", "sql-ro", "sl-1", "SELECT 1", "--dry")).toBe(
      0,
    );
    expect(cli.stdout()).toContain('"dry": true');
    // Мета-блок `--dry` идёт в stderr своим порядком — форма вывода на
    // него не влияет.
    expect(cli.stderr()).toContain("server: sl-1");
  });

  it("у обычной команды флаг по-прежнему общий", async () => {
    const cli = makeCli();
    expect(await cli.run("xlsx", "alias", "ls", "--json")).toBe(0);
    expect(cli.stdout()).toContain("{");
  });
});

it("голый вызов обёртки печатает справку, а не сообщение схемы", async () => {
  // Признак объявляет команда: у соседей с обязательным входом текст
  // отказа свой и закреплён их спеками (`specs/sql-ro.md`).
  const cli = makeCli();
  expect(await cli.run("ss-update")).toBe(2);
  expect(cli.stdout()).toContain("mpu ss-update");
  expect(cli.stdout()).toContain("[print [local]]");
  expect(cli.stderr()).toBe("");
});

describe("раскладка selector-first: селектор до имени подкоманды", () => {
  it("подкоманда опознаётся за селектором", async () => {
    const cli = makeCli();
    // Разбор argv листа доказывает, что путь опознан целиком: отказ
    // приходит от схемы подкоманды и подсказкой называет её полный
    // путь. До io и до сети вызов при этом не доходит.
    expect(await cli.run("ozon-jobs", "sl-2", "show", "--нет-флага")).toBe(2);
    expect(cli.stderr()).toContain("mpu ozon-jobs: unknown option");
    expect(cli.stderr()).toContain("mpu ozon-jobs show --help");
  });

  it("режимы печати перед селектором не мешают", async () => {
    const cli = makeCli();
    expect(await cli.run("ozon-jobs", "-p", "sl-2", "show", "--нет-флага"))
      .toBe(2);
    expect(cli.stderr()).toContain("mpu ozon-jobs show --help");
  });

  it("селектор после подкоманды — ошибка ввода", async () => {
    const cli = makeCli();
    expect(await cli.run("ozon-jobs", "show", "sl-2")).toBe(2);
    expect(cli.stderr()).toBe(
      "mpu ozon-jobs: селектор ставится перед именем подкоманды\n",
    );
    expect(cli.stdout()).toBe("");
  });

  it("голая подкоманда — справка листа, exit 2", async () => {
    const cli = makeCli();
    expect(await cli.run("ozon-jobs", "show")).toBe(2);
    expect(cli.stdout()).toContain(
      "mpu ozon-jobs show [print [local]] target: СЕЛЕКТОР",
    );
  });

  it("справка подкоманды доступна за её именем", async () => {
    const cli = makeCli();
    expect(await cli.run("ozon-jobs", "show", "--help")).toBe(0);
    expect(cli.stdout()).toContain("service:ozonJobs showJobs");
  });

  it("подкоманда не названа — индекс группы, exit 2", async () => {
    const cli = makeCli();
    expect(await cli.run("ozon-jobs", "sl-2")).toBe(2);
    expect(cli.stdout()).toContain("prune");
    expect(cli.stderr()).toBe("");
  });

  it("--help уровня группы печатает индекс", async () => {
    const cli = makeCli();
    expect(await cli.run("ozon-jobs", "--help")).toBe(0);
    expect(cli.stdout()).toContain("show");
  });

  it("значение флага подкомандой не считается", async () => {
    // `--pattern prune` — образец у подкоманды `show`, а не вызов
    // `prune`: спутай их, и вместо показа очереди она была бы
    // вычищена, молча и в проде.
    const cli = makeCli();
    expect(
      await cli.run("ozon-jobs", "sl-2", "--pattern", "prune", "show", "--нет"),
    ).toBe(2);
    expect(cli.stderr()).toContain("mpu ozon-jobs show --help");
    expect(cli.stderr().includes("prune --help")).toBe(false);
  });

  it("образец после подкоманды не ломает опознание", async () => {
    const cli = makeCli();
    expect(
      await cli.run("ozon-jobs", "sl-2", "prune", "--pattern", "show", "--нет"),
    ).toBe(2);
    expect(cli.stderr()).toContain("mpu ozon-jobs prune --help");
  });

  it("у обычной группы порядок прежний", async () => {
    // `wb-loader` раскладки не объявляет: селектор идёт после имени
    // подкоманды, и токен перед ним подкомандой не считается.
    const cli = makeCli();
    expect(await cli.run("wb-loader", "777", "cards")).toBe(2);
    expect(cli.stderr()).toBe(
      "No such command 'wb-loader 777'.\nTry 'mpu -h' for help.\n",
    );
  });
});
