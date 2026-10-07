/**
 * Картинка в ответе строки на странице (`platform/picture-frame.md`, P18,
 * [D.4]): страница берёт из собранного ответа только потоки, код и отказ —
 * поле `pictures` до неё не доходит.
 */

import { expect, test } from "vitest";
import { sendLine, type Transport } from "./api.ts";
import { json } from "./testkit.tsx";

const S43 =
  '{"path": "/tmp/mpu-telegram/-1000000000101-43-photo-43.jpg", ' +
  '"name": "photo-43.jpg", "size": 10, "mime": "image/jpeg"}\n';

test("P18: ответ с картинкой — вывод как у CLI, картинки нет", async () => {
  const transport: Transport = {
    base: "http://mpu.localhost",
    fetch: () =>
      Promise.resolve(
        json({
          stdout: S43,
          stderr: "",
          exit: 0,
          pictures: [{ mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" }],
        }),
      ),
  };
  const reply = await sendLine(transport, [
    "telegram",
    "file",
    "chat:",
    "-1000000000101",
    "id:",
    "43",
  ]);
  expect(reply).toEqual({
    kind: "loaded",
    value: {
      kind: "outcome",
      outcome: { stdout: S43, stderr: "", exit: 0 },
    },
  });
});
