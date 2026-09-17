import { assertEquals } from "@std/assert";
import { foundMessage, type RawMessage } from "./message.ts";
import { renderMessagesJson, renderMessagesTable } from "./search_view.ts";

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
  const lines = renderMessagesTable(FOUND.map(foundMessage)).split("\n");
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
