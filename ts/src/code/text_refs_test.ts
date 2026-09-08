/**
 * `refs` в репозитории без единого проекта (`specs/code-refs.md`,
 * граница «Адрес в репозитории без единого проекта»).
 *
 * Ответ, а не отказ: «не знаю» подменённое на «нет» — ровно тот дефект,
 * ради которого семейство заводится. Гарантия при этом названа
 * пониженной в шапке, и именно это проверяется.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { parseAddress } from "./address.ts";
import type { Repo } from "./workspace.ts";

/** Дерево без `tsconfig.json`: разбирать его нечем, кроме текста. */
async function plainRepo(temp: string): Promise<Repo> {
  const root = `${temp}/plain`;
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/src/days.ts`,
    "export function addDays(day) {\n  return day;\n}\n",
  );
  await Deno.writeTextFile(
    `${root}/src/hidden.ts`,
    "const secret = 1;\nexport const two = secret + 1;\n",
  );
  await Deno.writeTextFile(
    `${root}/src/window.ts`,
    "import { addDays } from './days.js';\n\nexport const next = (d) => addDays(d);\n",
  );
  return {
    name: "plain",
    root,
    mark: () =>
      Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
  };
}

async function refs(repo: Repo, address: string): Promise<string> {
  return renderRefs(
    await runRefs({ address, limit: 200 }, { cwd: () => repo.root }, [repo]),
  );
}

Deno.test("репозиторий без проектов отвечает текстовым разбором", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await plainRepo(temp);

    await t.step(
      "гарантия названа пониженной, потребитель найден",
      async () => {
        assertEquals(
          await refs(repo, "plain:src/days.ts:1"),
          [
            "plain · вне git · текстовый разбор — ответ неполон",
            "",
            "addDays — сигнатуры нет: текстовый разбор",
            "  область видимости неизвестна: текстовый разбор",
            "",
            "потребители: 1 файл",
            "  src/window.ts:1",
            "",
            "не разрешено: 0",
            "",
          ].join("\n"),
        );
      },
    );

    await t.step("незнание называется у каждого объявления", async () => {
      // Приватное по тексту объявление приватным НЕ объявляется:
      // выяснить это текстовому разбору нечем, и правдоподобный ответ
      // здесь хуже названного незнания.
      const text = await refs(repo, "plain:src/hidden.ts:1");
      assertEquals(
        text.includes("secret — сигнатуры нет: текстовый разбор"),
        true,
        text,
      );
      assertEquals(
        text.includes("  область видимости неизвестна: текстовый разбор"),
        true,
        text,
      );
      assertEquals(text.includes("приватное в модуле"), false, text);
      assertEquals(text.includes("потребители: 0"), true, text);
    });

    await t.step("читатели модуля — тоже ответ", async () => {
      const text = await refs(repo, "plain:src/days.ts");
      assertEquals(text.includes("читатели: 1 файл"), true);
      assertEquals(text.includes("  src/window.ts:1"), true);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("адрес-каталог — ошибка ввода, а не сбой чтения", async () => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await plainRepo(temp);
    // `readTextFileSync` на каталоге бросает `IsADirectory`; без
    // проверки вида файла команда падала бы внутренней ошибкой.
    const err = await assertRejects(
      () => refs(repo, "plain:src"),
      UsageError,
    );
    assertEquals(err.message, "файла src нет в plain на вне git");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("адрес разбирается тремя формами", async (t) => {
  const cases: readonly (readonly [
    string,
    string | undefined,
    string,
    number | undefined,
  ])[] = [
    ["src/days.ts", undefined, "src/days.ts", undefined],
    ["src/days.ts:2", undefined, "src/days.ts", 2],
    ["mpu:ts/src/days.ts:2", "mpu", "ts/src/days.ts", 2],
    // Нормальная форма: `./` и повторные разделители — не часть пути.
    ["mpu:./ts//src/days.ts", "mpu", "ts/src/days.ts", undefined],
  ];
  for (const [raw, repo, path, line] of cases) {
    await t.step(raw, () => {
      assertEquals(parseAddress(raw), { repo, path, line });
    });
  }
});

Deno.test("адрес, который ничего не адресует, — ошибка ввода", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["пустой путь", ":2", "в адресе нет пути: ':2'"],
    [
      "пустое имя репозитория",
      ":src/a.ts",
      "в адресе пустое имя репозитория: ':src/a.ts'",
    ],
    [
      "нулевая строка",
      "src/a.ts:0",
      "строка адреса не может быть нулевой: 'src/a.ts:0'",
    ],
    ["лишний разделитель", "a:b:c", "адрес разобран неоднозначно: 'a:b:c'"],
    [
      "выход за корень репозитория",
      "p:../q/src/a.ts",
      "путь адреса выходит за корень репозитория: 'p:../q/src/a.ts'",
    ],
    [
      "абсолютный путь",
      "p:/etc/passwd",
      "путь адреса относителен корню репозитория: 'p:/etc/passwd'",
    ],
  ];
  for (const [title, raw, message] of cases) {
    await t.step(title, () => {
      const err = assertThrows(() => parseAddress(raw), UsageError);
      assertEquals(err.message, message);
    });
  }
});
