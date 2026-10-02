import { assertEquals } from "@std/assert";
import type { tl } from "@mtcute/deno";
import { md } from "@mtcute/markdown-parser";
import { markdown } from "./markdown.ts";

/** Сообщение Telegram: видимый текст и разметка протокола. */
interface Case {
  readonly name: string;
  readonly text: string;
  readonly entities: readonly tl.TypeMessageEntity[];
}

function url(offset: number, length: number, address: string) {
  return {
    _: "messageEntityTextUrl",
    offset,
    length,
    url: address,
  } as const;
}

function bold(offset: number, length: number) {
  return { _: "messageEntityBold", offset, length } as const;
}

const TM2: Case = {
  name: "TM2 ссылка под словами",
  text: "1. Ozon: сверка выкупа - готово к код-ревью",
  entities: [url(3, 19, "https://btlz.kaiten.ru/71300001")],
};

const TM3: Case = {
  name: "TM3 упоминание и две ссылки",
  text: "@hr82al Привет\n1. A\n2. B",
  entities: [
    { _: "messageEntityMention", offset: 0, length: 7 },
    url(18, 1, "https://btlz.kaiten.ru/1"),
    url(23, 1, "https://btlz.kaiten.ru/2"),
  ],
};

const TM8: Case = {
  name: "TM8 жирный внутри ссылки",
  text: "важно: срок",
  entities: [url(0, 11, "https://e.x/a"), bold(0, 5)],
};

const TM9: Case = {
  name: "TM9 служебное в тексте",
  text: "a**b",
  entities: [],
};

const GOLDEN: Case = {
  name: "голден: упоминание, ссылка, жирный",
  text:
    "@ivan_p Привет, сможешь сделать ревью?\n1. Ozon: сверка выкупа - готово к код-ревью",
  entities: [
    { _: "messageEntityMention", offset: 0, length: 7 },
    url(42, 19, "https://btlz.kaiten.ru/71300001"),
    bold(64, 18),
  ],
};

/** Сценарии TM1–TM13 (кроме таблицы TM12 — она в `search_view_test.ts`). */
const SCENARIOS: readonly (Case & { readonly markdown: string })[] = [
  {
    name: "TM1 без разметки",
    text: "выгрузка за июль готова",
    entities: [],
    markdown: "выгрузка за июль готова",
  },
  {
    ...TM2,
    markdown:
      "1. [Ozon: сверка выкупа](https://btlz.kaiten.ru/71300001) - готово к код-ревью",
  },
  {
    ...TM3,
    markdown:
      "@hr82al Привет\n1. [A](https://btlz.kaiten.ru/1)\n2. [B](https://btlz.kaiten.ru/2)",
  },
  {
    name: "TM4 смещения в единицах UTF-16",
    text: "🔥 карточка",
    entities: [url(3, 8, "https://btlz.kaiten.ru/3")],
    markdown: "🔥 [карточка](https://btlz.kaiten.ru/3)",
  },
  {
    name: "TM5 жирный",
    text: "итог: готово",
    entities: [bold(6, 6)],
    markdown: "итог: **готово**",
  },
  {
    name: "TM6 голый адрес",
    text: "см. https://btlz.kaiten.ru/4",
    entities: [{ _: "messageEntityUrl", offset: 4, length: 24 }],
    markdown: "см. https://btlz.kaiten.ru/4",
  },
  {
    name: "TM7 упоминание без имени",
    text: "Руслан, глянь",
    entities: [
      { _: "messageEntityMentionName", offset: 0, length: 6, userId: 5551 },
    ],
    markdown: "[Руслан](tg://user?id=5551), глянь",
  },
  { ...TM8, markdown: "[**важно**: срок](https://e.x/a)" },
  { ...TM9, markdown: "a\\**b" },
  {
    name: "TM10 подпись файла со ссылкой",
    text: "отчёт",
    entities: [url(0, 5, "https://e.x/r")],
    markdown: "[отчёт](https://e.x/r)",
  },
  { name: "TM11 файл без подписи", text: "", entities: [], markdown: "" },
  {
    name: "TM13 хэштег",
    text: "#релиз в 18:00",
    entities: [{ _: "messageEntityHashtag", offset: 0, length: 6 }],
    markdown: "#релиз в 18:00",
  },
  {
    ...GOLDEN,
    markdown:
      "@ivan_p Привет, сможешь сделать ревью?\n1. [Ozon: сверка выкупа](https://btlz.kaiten.ru/71300001) - **готово к код-ревью**",
  },
];

/** Стыки, на которых разбор `send --md` толкует текст как разметку. */
const JOINTS: readonly Case[] = [
  {
    name: "сущность перед экранируемым",
    text: "a-b c",
    entities: [bold(0, 1)],
  },
  { name: "одиночный перед закрытием", text: "a*", entities: [bold(0, 2)] },
  { name: "одиночный перед открытием", text: "*a", entities: [bold(1, 1)] },
  { name: "одиночный после закрытия", text: "a*b", entities: [bold(0, 1)] },
  {
    name: "вид без формы между парой",
    text: "**x**",
    entities: [
      { _: "messageEntityUrl", offset: 1, length: 1 },
      { _: "messageEntityUrl", offset: 4, length: 1 },
    ],
  },
  { name: "серия парных", text: "--- ** __ ~~ || ***", entities: [] },
  { name: "цитата в начале строки", text: "> q\n> r", entities: [] },
  { name: "цитата после тега", text: "> q", entities: [bold(0, 3)] },
  { name: "отступ после перевода строки", text: "a\n  b\n\tc", entities: [] },
  {
    name: "отступ внутри жирного",
    text: "a\n  b",
    entities: [bold(2, 3)],
  },
  { name: "обратная косая и кавычка", text: "a\\b `c` [d](e)", entities: [] },
  { name: "закрывающая скобка вне ссылки", text: "a]b", entities: [] },
  { name: "скобка в словах ссылки", text: "a]b", entities: [url(0, 3, "u")] },
  {
    name: "скобка в адресе",
    text: "w",
    entities: [url(0, 1, "https://e.x/a)b")],
  },
  {
    name: "код: только косая и кавычка",
    text: "x **a** [b] `c` \\d",
    entities: [{ _: "messageEntityCode", offset: 2, length: 16 }],
  },
  {
    name: "блок кода с языком",
    text: "const a = `x`;\n  b ** c",
    entities: [{
      _: "messageEntityPre",
      offset: 0,
      length: 23,
      language: "ts",
    }],
  },
  {
    name: "блок кода без языка",
    text: "x\ny",
    entities: [{ _: "messageEntityPre", offset: 0, length: 3, language: "" }],
  },
  {
    name: "прочие парные",
    text: "a b c d",
    entities: [
      { _: "messageEntityItalic", offset: 0, length: 1 },
      { _: "messageEntityUnderline", offset: 2, length: 1 },
      { _: "messageEntityStrike", offset: 4, length: 1 },
      { _: "messageEntitySpoiler", offset: 6, length: 1 },
    ],
  },
  {
    name: "перекрытие без вложенности",
    text: "abcde",
    entities: [bold(0, 3), { _: "messageEntityItalic", offset: 2, length: 3 }],
  },
  {
    name: "код внутри ссылки",
    text: "a]b",
    entities: [url(0, 3, "u"), {
      _: "messageEntityCode",
      offset: 0,
      length: 3,
    }],
  },
];

/** Виды, у которых в диалекте нет формы: разбор их не производит. */
const AS_IS: ReadonlySet<string> = new Set([
  "messageEntityMention",
  "messageEntityUrl",
  "messageEntityHashtag",
]);

/** Сущности в сравнимом виде: порядок разбора — порядок закрытия тегов. */
function comparable(entities: readonly tl.TypeMessageEntity[]) {
  return entities
    .filter((entity) => !AS_IS.has(entity._))
    .map((entity) => ({ ...entity }))
    .sort((a, b) =>
      a.offset - b.offset || a.length - b.length || a._.localeCompare(b._)
    );
}

Deno.test("сценарии TM1: Markdown-строка выдачи", async (t) => {
  for (const scenario of SCENARIOS) {
    await t.step(scenario.name, () => {
      assertEquals(
        markdown(scenario.text, scenario.entities),
        scenario.markdown,
      );
    });
  }
});

Deno.test("обратимость: разбор `send --md` даёт исходные текст и разметку", async (t) => {
  for (const sample of [...SCENARIOS, ...JOINTS]) {
    await t.step(sample.name, () => {
      const parsed = md(markdown(sample.text, sample.entities));
      assertEquals(
        { text: parsed.text, entities: comparable(parsed.entities ?? []) },
        { text: sample.text, entities: comparable(sample.entities) },
      );
    });
  }
});

Deno.test("сущность нулевой длины разметки не даёт", () => {
  assertEquals(markdown("ab", [bold(1, 0)]), "ab");
});

Deno.test("код: экранируются только косая и кавычка", () => {
  assertEquals(
    markdown("x **a** [b] `c` \\d > e", [
      { _: "messageEntityCode", offset: 2, length: 20 },
    ]),
    "x `**a** [b] \\`c\\` \\\\d > e`",
  );
});
