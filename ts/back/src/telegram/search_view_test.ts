import { assertEquals } from "@std/assert";
import { foundMessage, type RawMessage } from "./message.ts";
import { renderMessagesJson, renderMessagesTable } from "./search_view.ts";
import { documentFile, noFile } from "./message_file.ts";

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-search/${name}`, import.meta.url),
  );
}

const FOUND: readonly RawMessage[] = [
  {
    id: 4821,
    chat: {
      peerType: "supergroup",
      rawId: 101,
      title: "Команда выгрузок",
      username: "team_uploads",
    },
    sender: {
      peerType: "user",
      rawId: 500001,
      title: "Иван Петров",
      username: "ipetrov",
    },
    date: new Date("2026-08-16T07:54:28.000Z"),
    text: "выгрузка за июль готова",
    file: noFile(4821),
    entities: [],
  },
  {
    id: 77,
    chat: {
      peerType: "channel",
      rawId: 202,
      title: "Канал релизов",
      username: null,
    },
    sender: null,
    date: new Date("2026-08-15T18:03:00.000Z"),
    text: "выгрузка отчётов включена в релиз",
    file: noFile(77),
    entities: [],
  },
  {
    id: 1503,
    chat: {
      peerType: "user",
      rawId: 100000001,
      title: "Мария Кузнецова",
      username: "mkuznetsova",
    },
    sender: {
      peerType: "user",
      rawId: 100000001,
      title: "Мария Кузнецова",
      username: "mkuznetsova",
    },
    date: new Date("2026-08-14T09:12:41.000Z"),
    text: "",
    // Форма — догадка по исходникам клиента: живьём не снята
    // (`telegram-file.md`, «Golden-примеры»).
    file: documentFile(1503, {
      name: "выгрузка-июль.xlsx",
      size: 48213,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }, () => {
      throw new Error("скачивание в выдаче поиска не ожидается");
    }),
    entities: [],
  },
  {
    id: 17694,
    chat: {
      peerType: "supergroup",
      rawId: 303,
      title: "Разработка",
      username: null,
    },
    sender: {
      peerType: "user",
      rawId: 500002,
      title: "Пётр Сидоров",
      username: "psidorov",
    },
    date: new Date("2026-10-02T06:11:14.000Z"),
    text:
      "@ivan_p Привет, сможешь сделать ревью?\n1. Ozon: сверка выкупа - готово к код-ревью",
    file: noFile(17694),
    entities: [
      { _: "messageEntityMention", offset: 0, length: 7 },
      {
        _: "messageEntityTextUrl",
        offset: 42,
        length: 19,
        url: "https://btlz.kaiten.ru/71300001",
      },
      { _: "messageEntityBold", offset: 64, length: 18 },
    ],
  },
];

Deno.test("JSON выдачи совпадает с голденом канала", async () => {
  assertEquals(
    renderMessagesJson(FOUND.map(foundMessage)),
    await golden("search-json-stdout.txt"),
  );
});

Deno.test("ничего не найдено: пустой массив, не ошибка", async () => {
  assertEquals(renderMessagesJson([]), await golden("search-empty-stdout.txt"));
});

Deno.test("ничего не найдено в таблице: без счётчика", async () => {
  assertEquals(
    renderMessagesTable([]),
    await golden("search-empty-table-stdout.txt"),
  );
});

Deno.test("таблица: порядок колонок, строк и итог", () => {
  // Три сообщения голдена в одну строку каждое: перевод строки внутри
  // текста четвёртого переносит клетку, а это оформление, не контракт.
  const lines = renderMessagesTable(FOUND.slice(0, 3).map(foundMessage))
    .split("\n");
  assertEquals(lines.at(-1), "", "вывод оканчивается одним переводом строки");
  assertEquals(lines.at(-2), "(3 messages)");
  assertEquals(
    lines[0].split(/\s{2,}/),
    ["DATE", "CHAT", "SENDER", "TEXT"],
  );
  assertEquals(
    lines[1].split(/\s{2,}/),
    [
      "2026-08-16T07:54:28+00:00",
      "Команда выгрузок",
      "Иван Петров",
      "выгрузка за июль готова",
    ],
  );
  // Отсутствие отправителя и пустой текст — пустые клетки, а не «null».
  assertEquals(lines[2].split(/\s{2,}/), [
    "2026-08-15T18:03:00+00:00",
    "Канал релизов",
    "выгрузка отчётов включена в релиз",
  ]);
  assertEquals(lines[3].split(/\s{2,}/), [
    "2026-08-14T09:12:41+00:00",
    "Мария Кузнецова",
    "Мария Кузнецова",
  ]);
  assertEquals(lines.length, 6);
});

Deno.test("TM12: в колонке TEXT та же Markdown-строка, что в JSON", () => {
  const message = foundMessage({
    ...FOUND[0],
    text: "1. Ozon: сверка выкупа - готово к код-ревью",
    file: noFile(17694),
    entities: [{
      _: "messageEntityTextUrl",
      offset: 3,
      length: 19,
      url: "https://btlz.kaiten.ru/71300001",
    }],
  });
  const row = renderMessagesTable([message]).split("\n")[1];
  assertEquals(
    row.split(/\s{2,}/).at(-1),
    "1. [Ozon: сверка выкупа](https://btlz.kaiten.ru/71300001) - готово к код-ревью",
  );
  assertEquals(
    JSON.parse(renderMessagesJson([message]))[0].text,
    row.split(/\s{2,}/).at(-1),
  );
});
