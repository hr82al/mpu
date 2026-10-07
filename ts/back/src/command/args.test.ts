import { describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { type InputSpec, parseArgv } from "./args.ts";
import { UsageError } from "./errors.ts";

/** Синтетический набор входов: от конкретных команд тест не зависит. */
const SPECS: readonly InputSpec[] = [
  { name: "file", kind: "string", form: { short: "f" } },
  { name: "from", kind: "strings", form: {} },
  { name: "long", kind: "boolean", form: { short: "l" } },
  { name: "name", kind: "string", form: { positional: "one" } },
  { name: "ranges", kind: "string", form: { positional: "rest" } },
];

const HINT = "mpu proba --help";

function parse(...argv: string[]) {
  return parseArgv(argv, SPECS, HINT);
}

it("parseArgv: длинные, короткие и запись через «=»", () => {
  expect(parse("--file", "a.xlsx").file).toBe("a.xlsx");
  expect(parse("-f", "b.xlsx").file).toBe("b.xlsx");
  expect(parse("--file=c.xlsx").file).toBe("c.xlsx");
  expect(parse("--long").long).toBe(true);
  expect(parse("-l").long).toBe(true);
  // Флаг, которого не было в argv, в сыром объекте отсутствует:
  // значение по умолчанию подставляет схема, а не разбор.
  expect("long" in parse()).toBe(false);
});

describe("parseArgv: «--no-<имя>» выключает булев вход", () => {
  it("выключает и не путается с включением", () => {
    expect(parse("--no-long").long).toBe(false);
    expect(parse("--long", "--no-long").long).toBe(false);
    expect(parse("--no-long", "--long").long).toBe(true);
  });

  it("отрицается только булев вход", () => {
    // У строкового входа отрицательной формы нет: выключать нечего.
    thrown(
      () => parse("--no-file"),
      UsageError,
      'unknown option "--no-file"',
    );
  });

  it("значения отрицательная форма не берёт", () => {
    thrown(
      () => parse("--no-long=1"),
      UsageError,
      "option --no-long does not take a value",
    );
  });
});

it("parseArgv: повторы накапливаются или побеждает последний", () => {
  expect(parse("--from", "a", "--from", "b").from).toStrictEqual(["a", "b"]);
  // Строковый вход не накапливается: «последний побеждает».
  expect(parse("-f", "a", "-f", "b").file).toBe("b");
});

it("parseArgv: позиционные по порядку объявления", () => {
  const parsed = parse("имя", "A1", "B2");
  expect(parsed.name).toBe("имя");
  expect(parsed.ranges).toStrictEqual(["A1", "B2"]);
});

it("parseArgv: «--» завершает флаги, одиночный «-» позиционный", () => {
  const dashed = parse("имя", "--", "--file", "-l");
  expect(dashed.ranges).toStrictEqual(["--file", "-l"]);
  expect("file" in dashed).toBe(false);
  // «-» — маркер stdin, а не флаг.
  expect(parse("имя", "-").ranges).toStrictEqual(["-"]);
});

describe("parseArgv: ошибки ввода — UsageError с подсказкой", () => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    ["неизвестный длинный", ["--nope"], `unknown option "--nope"`],
    ["неизвестный короткий", ["-z"], `unknown option "-z"`],
    ["склейка коротких", ["-lf"], `unknown option "-lf"`],
    ["строковый без значения", ["--file"], "option --file requires a value"],
    ["булев со значением", ["--long=1"], "option --long does not take a value"],
  ];
  for (const [title, argv, message] of cases) {
    it(title, () => {
      const err = thrown(
        () => parseArgv(argv, SPECS, HINT),
        UsageError,
        message,
      );
      expect(err.hint).toStrictEqual(HINT);
    });
  }
});

it("parseArgv: лишний позиционный без «rest» — ошибка", () => {
  const specs: readonly InputSpec[] = [
    { name: "name", kind: "string", form: { positional: "one" } },
  ];
  const err = thrown(
    () => parseArgv(["a", "b"], specs, HINT),
    UsageError,
    `unexpected argument "b"`,
  );
  expect(err.hint).toStrictEqual(HINT);
});

describe("parseArgv: неопознанные токены — в хвостовой вход", () => {
  // Хвост argv у `mpu ssh` — командная строка для контейнера: её флаги
  // разбирает удалённый шелл, а не мы.
  const specs: readonly InputSpec[] = [
    { name: "via", kind: "string", form: {} },
    { name: "selector", kind: "string", form: { positional: "one" } },
    {
      name: "command",
      kind: "string",
      form: { positional: "rest", keepsUnknown: true },
    },
  ];
  const keep = (...argv: string[]) => parseArgv(argv, specs, HINT);

  it("склейка коротких и необъявленный длинный", () => {
    const parsed = keep("sl-1", "ls", "-la", "--color=always");
    expect(parsed.selector).toBe("sl-1");
    expect(parsed.command).toStrictEqual(["ls", "-la", "--color=always"]);
  });

  it("объявленный флаг остаётся флагом и после селектора", () => {
    const parsed = keep("sl-1", "--via", "ssh", "env");
    expect(parsed.via).toBe("ssh");
    expect(parsed.command).toStrictEqual(["env"]);
  });

  it("без keepsUnknown правило прежнее", () => {
    thrown(() => parse("имя", "-la"), UsageError, 'unknown option "-la"');
  });
});

describe("числовой вход: из argv текст, в аргументах число", () => {
  const specs: readonly InputSpec[] = [
    { name: "jobs", kind: "number", form: { short: "j" } },
    { name: "name", kind: "string", form: { positional: "one" } },
  ];
  const parse = (...argv: string[]) => parseArgv(argv, specs, HINT);

  it("значение забирается как у строкового входа", () => {
    // Разбор argv числа не строит: приведение — работа слоя схемы,
    // которому известен объявленный тип
    // (`platform/command-contract.md`, «Ввод/вывод»).
    expect(parse("--jobs", "2").jobs).toBe("2");
    expect(parse("--jobs=2").jobs).toBe("2");
    expect(parse("-j", "2").jobs).toBe("2");
  });

  it("повтор не накапливается: последний побеждает", () => {
    expect(parse("--jobs", "2", "--jobs", "5").jobs).toBe("5");
  });

  it("значение обязательно", () => {
    thrown(
      () => parse("--jobs"),
      UsageError,
      "option --jobs requires a value",
    );
  });
});

describe("числом становится только десятичная запись", () => {
  const specs: readonly InputSpec[] = [
    { name: "tail", kind: "number", form: {} },
  ];
  const parsed = (value: string) =>
    parseArgv(["--tail", value], specs, HINT).tail;

  it("десятичная запись приводится", () => {
    // Само приведение делает слой схемы; здесь видно лишь то, что
    // разбор argv отдаёт значение как есть.
    expect(parsed("50")).toBe("50");
    expect(parsed("-5")).toBe("-5");
    expect(parsed("2.5")).toBe("2.5");
  });

  it("прочие записи числа остаются текстом", () => {
    // Командная строка — не выражение языка: `0x10` это ошибка ввода, а
    // не шестнадцать (`platform/command-contract.md`, «Ввод/вывод»).
    for (const value of ["0x10", "1e3", " 50", "50 ", "Infinity"]) {
      expect(parsed(value)).toStrictEqual(value);
    }
  });
});

describe("parseArgv: маскирование прячет ввод из текстов ошибок", () => {
  const specs: readonly InputSpec[] = [
    { name: "message", kind: "string", form: { positional: "one" } },
  ];
  const parseMasked = (...argv: string[]) =>
    parseArgv(argv, specs, HINT, { masked: true });
  const parseOpen = (...argv: string[]) => parseArgv(argv, specs, HINT);

  it("лишний позиционный назван REDACTED", () => {
    const err = thrown(
      () => parseMasked("деплой", "упал"),
      UsageError,
      "unexpected argument REDACTED",
    );
    expect(err.message.includes("упал")).toBe(false);
  });

  it("у неизвестной опции скрыто значение, не имя", () => {
    // Граница по виду токена, а не по команде: имя оператор набрал
    // руками и обязан увидеть свою опечатку, а значение после «=»
    // может оказаться секретом — потому и прячется.
    const err = thrown(
      () => parseMasked("--мой-секрет=пароль"),
      UsageError,
      'unknown option "--мой-секрет=REDACTED"',
    );
    expect(err.message.includes("пароль")).toBe(false);
  });

  it("значение прячется и у непомеченной команды", () => {
    // Опечатка в имени секретной опции проходит мимо любых списков
    // имён, и это самый обычный способ набрать секрет: `--pasword`.
    const err = thrown(
      () => parseOpen("--pasword=hunter2"),
      UsageError,
      'unknown option "--pasword=REDACTED"',
    );
    expect(err.message.includes("hunter2")).toBe(false);
  });
});

describe("parseArgv: помеченный once флаг повтора не принимает", () => {
  const specs: readonly InputSpec[] = [
    { name: "file", kind: "string", form: { short: "f", once: true } },
    { name: "message", kind: "string", form: { positional: "one" } },
  ];
  const parseOnce = (...argv: string[]) => parseArgv(argv, specs, HINT);

  it("один флаг — обычное значение", () => {
    expect(parseOnce("-f", "a.md", "текст")).toStrictEqual({
      file: "a.md",
      message: "текст",
    });
  });

  it("повтор в любой форме записи — ошибка ввода", () => {
    for (
      const argv of [
        ["-f", "a.md", "-f", "b.md"],
        ["--file=a.md", "--file", "b.md"],
        ["-f", "a.md", "--file=b.md"],
      ]
    ) {
      const err = thrown(
        () => parseOnce(...argv),
        UsageError,
        "option --file may be given only once",
      );
      // Не «unknown option»: флаг известен, лишний он второй раз.
      expect(err.message.includes("unknown")).toBe(false);
    }
  });

  it("без пометки правило прежнее — последний побеждает", () => {
    expect(parse("-f", "a.md", "-f", "b.md", "имя").file).toBe("b.md");
  });
});
