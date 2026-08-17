/**
 * Буфер обмена (`platform/clipboard.md`): порядок попыток, форма
 * последовательности, подавление потоков и предел ожидания. Голденов у
 * возможности нет — наблюдаемой поверхности stdout она не имеет.
 */

import { assertEquals } from "@std/assert";
import {
  type ClipboardPorts,
  copyToClipboard,
  denoPorts,
  osc52,
} from "./mod.ts";

const decoder = new TextDecoder();

/** Журнал попыток: что писалось в tty и какие утилиты запускались. */
function ports(answers: {
  readonly tty?: boolean;
  readonly utility?: (bin: string) => boolean;
  readonly tmux?: string;
}) {
  const tty: Uint8Array[] = [];
  const utilities: string[] = [];
  const io: ClipboardPorts = {
    writeTty: (bytes) => {
      tty.push(bytes);
      return Promise.resolve(answers.tty ?? false);
    },
    runUtility: (bin, args, stdin) => {
      utilities.push([bin, ...args].join(" "));
      return Promise.resolve(
        answers.utility === undefined ? false : answers.utility(bin) &&
          decoder.decode(stdin) === TEXT,
      );
    },
    env: (name) => name === "TMUX" ? answers.tmux : undefined,
  };
  return { io, tty, utilities };
}

const TEXT = "mpu ssh sl-1 -- node\n";

Deno.test("первая удавшаяся попытка — последняя", async (t) => {
  await t.step("терминал взял текст — утилиты не запускаются", async () => {
    const { io, utilities } = ports({ tty: true });
    assertEquals(await copyToClipboard(TEXT, io), true);
    assertEquals(utilities, []);
  });

  await t.step("терминал отказал — идут утилиты по порядку", async () => {
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

Deno.test("OSC 52: форма последовательности", async (t) => {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(TEXT)));

  await t.step("без tmux — ESC ] 5 2 ; c ; <base64> BEL", () => {
    const bytes = osc52(TEXT, undefined);
    assertEquals(bytes[0], 0x1b);
    assertEquals(decoder.decode(bytes.subarray(1, 7)), "]52;c;");
    assertEquals(bytes[bytes.length - 1], 0x07);
    assertEquals(
      decoder.decode(bytes.subarray(7, bytes.length - 1)),
      base64,
    );
  });

  await t.step("под tmux — passthrough вокруг неё", () => {
    const bytes = osc52(TEXT, "/tmp/tmux-1000/default,123,0");
    assertEquals(decoder.decode(bytes.subarray(0, 7)), "\x1bPtmux;");
    // Спека: `… ESC <последовательность>`, а сама последовательность
    // начинается с ESC — отсюда удвоение, которого требует passthrough
    // tmux.
    assertEquals(bytes[7], 0x1b);
    assertEquals(
      bytes.subarray(8, bytes.length - 2),
      osc52(TEXT, undefined),
    );
    assertEquals(decoder.decode(bytes.subarray(bytes.length - 2)), "\x1b\\");
  });

  await t.step("пустой TMUX равнозначен отсутствию", () => {
    assertEquals(osc52(TEXT, ""), osc52(TEXT, undefined));
  });

  await t.step("текст уходит как есть, без обрезки", () => {
    const bytes = osc52("хвост\n\n", undefined);
    const encoded = decoder.decode(bytes.subarray(7, bytes.length - 1));
    assertEquals(new TextDecoder().decode(base64ToBytes(encoded)), "хвост\n\n");
  });
});

Deno.test("в терминал уходит именно последовательность", async () => {
  const { io, tty } = ports({ tty: true, tmux: "сессия" });
  await copyToClipboard(TEXT, io);
  assertEquals(tty.length, 1);
  assertEquals(tty[0], osc52(TEXT, "сессия"));
});

Deno.test("предел ожидания передаётся утилите", async () => {
  let seen = 0;
  await copyToClipboard(TEXT, {
    writeTty: () => Promise.resolve(false),
    runUtility: (_bin, _args, _stdin, timeoutMs) => {
      seen = timeoutMs;
      return Promise.resolve(true);
    },
    env: () => undefined,
  });
  assertEquals(seen, 2_000);
});

function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

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

  await t.step("попытка 1 отвечает да/нет и не бросает наружу", async () => {
    // Утверждать здесь `false` нельзя: `/dev/tty` открывается по
    // управляющему терминалу процесса, а он у прогона то есть, то нет.
    // Наблюдаемое, зависящее от кода, — что ошибка наружу не всплывает,
    // а исход выражен булевым (спека: «ошибка наружу не идёт»).
    assertEquals(typeof await io.writeTty(new Uint8Array()), "boolean");
  });
});
