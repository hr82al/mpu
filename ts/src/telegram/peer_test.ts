import { assertEquals } from "@std/assert";
import { parsePeer, type Peer } from "./peer.ts";

const CASES: readonly { readonly input: string; readonly peer: Peer }[] = [
  { input: "me", peer: { kind: "me" } },
  { input: "@durov", peer: { kind: "name", name: "durov" } },
  { input: "durov", peer: { kind: "name", name: "durov" } },
  { input: "https://t.me/durov", peer: { kind: "name", name: "durov" } },
  { input: "http://t.me/durov/", peer: { kind: "name", name: "durov" } },
  { input: "t.me/durov", peer: { kind: "name", name: "durov" } },
  { input: "t.me/@durov", peer: { kind: "name", name: "durov" } },
  { input: "12345", peer: { kind: "id", id: 12345 } },
  { input: "-1001000000001", peer: { kind: "id", id: -1001000000001 } },
  { input: "https://t.me/12345", peer: { kind: "id", id: 12345 } },
  { input: "+79990000000", peer: { kind: "name", name: "+79990000000" } },
  // Хвоста после «t.me» нет — строка берётся целиком, а не превращается
  // в пустого адресата.
  { input: "t.me/", peer: { kind: "name", name: "t.me/" } },
  // Цифр больше, чем помещается в безопасное целое: id из такой строки
  // не собрать без округления, поэтому она идёт именем.
  {
    input: "9999999999999999999",
    peer: { kind: "name", name: "9999999999999999999" },
  },
];

Deno.test("приведение адресата", async (t) => {
  for (const { input, peer } of CASES) {
    await t.step(input, () => assertEquals(parsePeer(input), peer));
  }
});
