/**
 * Буфер обмена (`platform/clipboard.md`): порядок утилит, подавление
 * потоков и предел ожидания. Голденов у возможности нет — наблюдаемой
 * поверхности stdout она не имеет.
 *
 * Проверок управляющей последовательности здесь больше нет: попытка
 * убрана порцией 91 как недостижимая (`mod.ts`, шапка).
 */

import { assertEquals } from "@std/assert";
import { type ClipboardPorts, copyToClipboard, denoPorts } from "./mod.ts";

const decoder = new TextDecoder();

/** Журнал запусков: какие утилиты запускались и с чем. */
function ports(answers: {
  readonly utility?: (bin: string) => boolean;
}) {
  const utilities: string[] = [];
  const io: ClipboardPorts = {
    runUtility: (bin, args, stdin) => {
      utilities.push([bin, ...args].join(" "));
      return Promise.resolve(
        answers.utility === undefined ? false : answers.utility(bin) &&
          decoder.decode(stdin) === TEXT,
      );
    },
  };
  return { io, utilities };
}

const TEXT = "mpu ssh sl-1 -- node\n";

Deno.test("первая удавшаяся утилита — последняя", async (t) => {
  await t.step("утилиты идут по порядку", async () => {
    const { io, utilities } = ports({ utility: (bin) => bin === "xclip" });
    assertEquals(await copyToClipboard(TEXT, io), true);
    // `xsel` не запускался: список кончается на первой удавшейся.
    assertEquals(utilities, ["wl-copy", "xclip -selection clipboard"]);
  });

  await t.step("не удалось ничем — ответ «нет», без ошибки", async () => {
    const { io, utilities } = ports({});
    assertEquals(await copyToClipboard(TEXT, io), false);
    assertEquals(utilities, [
      "wl-copy",
      "xclip -selection clipboard",
      "xsel --clipboard --input",
    ]);
  });
});

Deno.test("предел ожидания передаётся утилите", async () => {
  let seen = 0;
  await copyToClipboard(TEXT, {
    runUtility: (_bin, _args, _stdin, timeoutMs) => {
      seen = timeoutMs;
      return Promise.resolve(true);
    },
  });
  assertEquals(seen, 2_000);
});

Deno.test("настоящие порты: утилита, её код выхода и отсутствие в PATH", async (t) => {
  const io = denoPorts();
  const bytes = new TextEncoder().encode(TEXT);

  await t.step("нулевой код — попытка удалась", async () => {
    // Права тестов допускают только эти два бинаря (`deno.jsonc`); от
    // утилиты буфера здесь нужен ровно её код выхода.
    assertEquals(await io.runUtility("/bin/echo", [], bytes, 2_000), true);
  });

  await t.step("ненулевой код — попытка неуспешна", async () => {
    assertEquals(await io.runUtility("/bin/false", [], bytes, 2_000), false);
  });

  await t.step("бинаря нет — тоже неуспешна, без ошибки наружу", async () => {
    assertEquals(
      await io.runUtility("/bin/net-takogo-binarya", [], bytes, 2_000),
      false,
    );
  });
});
