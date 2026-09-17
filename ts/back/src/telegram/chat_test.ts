import { assertEquals } from "@std/assert";
import {
  type ChatKind,
  dedupeById,
  dialogOf,
  markedId,
  type PeerType,
} from "./chat.ts";

const MARKED: readonly {
  readonly peerType: PeerType;
  readonly rawId: number;
  readonly id: number;
  readonly kind: ChatKind;
}[] = [
  { peerType: "user", rawId: 100000001, id: 100000001, kind: "user" },
  { peerType: "bot", rawId: 100000002, id: 100000002, kind: "bot" },
  // Базовая группа — минус сырой id.
  { peerType: "chat", rawId: 3, id: -3, kind: "group" },
  // Супергруппа и канал — минус (10¹² + сырой id), вид при этом разный.
  { peerType: "supergroup", rawId: 3, id: -1000000000003, kind: "group" },
  { peerType: "channel", rawId: 3, id: -1000000000003, kind: "channel" },
  { peerType: "unknown", rawId: 7, id: 7, kind: "unknown" },
];

Deno.test("маркировка идентификатора и вид чата", async (t) => {
  for (const item of MARKED) {
    await t.step(item.peerType, () => {
      assertEquals(markedId(item.peerType, item.rawId), item.id);
      assertEquals(
        dialogOf({
          peerType: item.peerType,
          rawId: item.rawId,
          title: "Чат",
          username: null,
        }),
        { id: item.id, title: "Чат", kind: item.kind, username: null },
      );
    });
  }
});

Deno.test("маркированный id пригоден как адресат: обратный ход", async (t) => {
  // Инвариант спеки проверяется в обе стороны: то, что напечатали,
  // обязано вернуться тем же чатом.
  for (const item of MARKED) {
    await t.step(item.peerType, () => {
      assertEquals(rawOf(item.id), item.rawId);
    });
  }
});

/** Сырой id из маркированного — как его читает клиентская конвенция. */
function rawOf(id: number): number {
  if (id >= 0) return id;
  const positive = -id;
  return positive > 1000000000000 ? positive - 1000000000000 : positive;
}

Deno.test("дедуп по id сохраняет порядок и первое вхождение", () => {
  const dialogs = [
    { id: 1, title: "Первый", kind: "user" as const, username: null },
    { id: 2, title: "Второй", kind: "user" as const, username: null },
    { id: 1, title: "Первый ещё раз", kind: "user" as const, username: null },
  ];
  assertEquals(dedupeById(dialogs).map((dialog) => dialog.title), [
    "Первый",
    "Второй",
  ]);
});

Deno.test("имя пользователя приходит без «@», его отсутствие — null", () => {
  assertEquals(
    dialogOf({
      peerType: "user",
      rawId: 1,
      title: "Иван Петров",
      username: "ipetrov",
    }).username,
    "ipetrov",
  );
});
