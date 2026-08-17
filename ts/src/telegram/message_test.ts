import { assertEquals } from "@std/assert";
import { foundMessage, type RawMessage, senderId } from "./message.ts";

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
};

Deno.test("сообщение супергруппы: маркированный id и ссылка по имени", () => {
  assertEquals(foundMessage(SUPERGROUP), {
    id: 4821,
    chat_id: -1000000000101,
    chat_title: "Команда выгрузок",
    sender: "Иван Петров",
    date: "2026-08-16T07:54:28+00:00",
    text: "выгрузка за июль готова",
    link: "https://t.me/team_uploads/4821",
  });
});

Deno.test("сообщение канала без имени: ссылка на сырой id", () => {
  assertEquals(
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
    }),
    {
      id: 77,
      chat_id: -1000000000202,
      chat_title: "Канал релизов",
      sender: null,
      date: "2026-08-15T18:03:00+00:00",
      text: "выгрузка отчётов включена в релиз",
      link: "https://t.me/c/202/77",
    },
  );
});

Deno.test("у личной переписки и базовой группы ссылки нет", async (t) => {
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
      },
      id: -3003,
    },
  ];
  for (const { raw, id } of cases) {
    await t.step(raw.chat.peerType, () => {
      const found = foundMessage(raw);
      assertEquals(found.link, null);
      assertEquals(found.chat_id, id);
    });
  }
});

Deno.test("отсутствующее значение — null или пустая строка, не пропуск", () => {
  assertEquals(
    foundMessage({
      id: 9,
      chat: { peerType: "unknown", rawId: 7, title: "", username: null },
      sender: null,
      date: null,
      text: "",
    }),
    {
      id: 9,
      chat_id: 7,
      chat_title: "",
      sender: null,
      date: null,
      text: "",
      link: null,
    },
  );
});

Deno.test("отправитель для клиентского фильтра — маркированный id", async (t) => {
  await t.step("пользователь", () => {
    assertEquals(senderId(SUPERGROUP), 500001);
  });
  await t.step("канал от своего имени", () => {
    assertEquals(
      senderId({
        ...SUPERGROUP,
        sender: {
          peerType: "channel",
          rawId: 202,
          title: "Канал релизов",
          username: null,
        },
      }),
      -1000000000202,
    );
  });
  await t.step("отправителя нет", () => {
    assertEquals(senderId({ ...SUPERGROUP, sender: null }), null);
  });
});
