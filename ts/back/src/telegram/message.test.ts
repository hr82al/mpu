import { describe, expect, it } from "vitest";
import { foundMessage, type RawMessage, senderId } from "./message.ts";
import { noFile } from "./message_file.ts";

const SUPERGROUP: RawMessage = {
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
};

it("сообщение супергруппы: маркированный id и ссылка по имени", () => {
  expect(foundMessage(SUPERGROUP)).toStrictEqual({
    id: 4821,
    chat_id: -1000000000101,
    chat_title: "Команда выгрузок",
    sender: "Иван Петров",
    date: "2026-08-16T07:54:28+00:00",
    text: "выгрузка за июль готова",
    file: null,
    link: "https://t.me/team_uploads/4821",
  });
});

it("сообщение канала без имени: ссылка на сырой id", () => {
  expect(
    foundMessage({
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
    }),
  ).toStrictEqual({
    id: 77,
    chat_id: -1000000000202,
    chat_title: "Канал релизов",
    sender: null,
    date: "2026-08-15T18:03:00+00:00",
    text: "выгрузка отчётов включена в релиз",
    file: null,
    link: "https://t.me/c/202/77",
  });
});

describe("у личной переписки и базовой группы ссылки нет", () => {
  const cases: readonly { readonly raw: RawMessage; readonly id: number }[] = [
    {
      raw: {
        id: 1503,
        chat: {
          peerType: "user",
          rawId: 100000001,
          title: "Мария Кузнецова",
          username: "mkuznetsova",
        },
        sender: null,
        date: null,
        text: "",
        file: noFile(1503),
        entities: [],
      },
      id: 100000001,
    },
    {
      raw: {
        id: 12,
        chat: {
          peerType: "chat",
          rawId: 3003,
          title: "Обеды",
          username: null,
        },
        sender: null,
        date: null,
        text: "",
        file: noFile(12),
        entities: [],
      },
      id: -3003,
    },
  ];
  for (const { raw, id } of cases) {
    it(raw.chat.peerType, () => {
      const found = foundMessage(raw);
      expect(found.link).toStrictEqual(null);
      expect(found.chat_id).toStrictEqual(id);
    });
  }
});

it("text — Markdown разметки сообщения (TM2)", () => {
  expect(
    foundMessage({
      ...SUPERGROUP,
      text: "1. Ozon: сверка выкупа - готово к код-ревью",
      entities: [
        {
          _: "messageEntityTextUrl",
          offset: 3,
          length: 19,
          url: "https://btlz.kaiten.ru/71300001",
        },
      ],
    }).text,
  ).toBe(
    "1. [Ozon: сверка выкупа](https://btlz.kaiten.ru/71300001) - готово к код-ревью",
  );
});

it("отсутствующее значение — null или пустая строка, не пропуск", () => {
  expect(
    foundMessage({
      id: 9,
      chat: { peerType: "unknown", rawId: 7, title: "", username: null },
      sender: null,
      date: null,
      text: "",
      file: noFile(9),
      entities: [],
    }),
  ).toStrictEqual({
    id: 9,
    chat_id: 7,
    chat_title: "",
    sender: null,
    date: null,
    text: "",
    file: null,
    link: null,
  });
});

describe("отправитель для клиентского фильтра — маркированный id", () => {
  it("пользователь", () => {
    expect(senderId(SUPERGROUP)).toBe(500001);
  });
  it("канал от своего имени", () => {
    expect(
      senderId({
        ...SUPERGROUP,
        sender: {
          peerType: "channel",
          rawId: 202,
          title: "Канал релизов",
          username: null,
        },
      }),
    ).toBe(-1000000000202);
  });
  it("отправителя нет", () => {
    expect(senderId({ ...SUPERGROUP, sender: null })).toStrictEqual(null);
  });
});
