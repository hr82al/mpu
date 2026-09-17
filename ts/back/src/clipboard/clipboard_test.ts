/**
 * Буфер обмена (`platform/clipboard.md`): порядок попыток, форма
 * последовательности, подавление потоков и предел ожидания.
 *
 * Проверяется форма и адресат байтов, а не действие: сработает ли
 * последовательность в настоящем эмуляторе терминала, отсюда не видно
 * — этот замер за владельцем терминала (`mod.ts`, шапка). Голденов у
 * возможности нет: наблюдаемой поверхности stdout она не имеет — и
 * это утверждается отдельно, потому что байты в stdout испортили бы
 * вывод команды-потребителя.
 */

import { assertEquals } from "@std/assert";
import {
  type ClipboardPorts,
  copyToClipboard,
  denoPorts,
  osc52,
} from "./mod.ts";

const decoder = new TextDecoder();

/** Журнал запусков: какие утилиты запускались и с чем. */
function ports(answers: {
  readonly terminal?: boolean;
  readonly utility?: (bin: string) => boolean;
  readonly tmux?: string;
}) {
  const written: Uint8Array[] = [];
  const utilities: string[] = [];
  const io: ClipboardPorts = {
    writeTerminal: (bytes) => {
      written.push(bytes);
      return Promise.resolve(answers.terminal ?? false);
    },
    env: (name) => name === "TMUX" ? answers.tmux : undefined,
    runUtility: (bin, args, stdin) => {
      utilities.push([bin, ...args].join(" "));
      return Promise.resolve(
        answers.utility === undefined ? false : answers.utility(bin) &&
          decoder.decode(stdin) === TEXT,
      );
    },
  };
  return { io, written, utilities };
}

const TEXT = "mpu ssh sl-1 -- node\n";

Deno.test("первая удавшаяся попытка — последняя", async (t) => {
  await t.step("терминал взял текст — утилиты не запускаются", async () => {
    const { io, utilities } = ports({ terminal: true });
    assertEquals(await copyToClipboard(TEXT, io), true);
    assertEquals(utilities, []);
  });

  await t.step("терминала нет — идут утилиты по порядку", async () => {
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

Deno.test("последовательность уходит в stderr, а не в stdout", async () => {
  // Байты в stdout попали бы в конвейер и испортили вывод
  // команды-потребителя (спека). Поэтому наблюдаемое здесь двойное:
  // терминалу байты ушли, а stdout не тронут ни одним.
  const stdout: string[] = [];
  const write = Deno.stdout.write.bind(Deno.stdout);
  Deno.stdout.write = (bytes: Uint8Array) => {
    stdout.push(new TextDecoder().decode(bytes));
    return write(new Uint8Array());
  };
  try {
    const { io, written } = ports({ terminal: true, tmux: "сессия" });
    assertEquals(await copyToClipboard(TEXT, io), true);
    assertEquals(written.length, 1);
    assertEquals(written[0], osc52(TEXT, "сессия"));
  } finally {
    Deno.stdout.write = write;
  }
  assertEquals(stdout, [], `в stdout ушли байты: ${JSON.stringify(stdout)}`);
});

Deno.test("OSC 52: форма последовательности", async (t) => {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(TEXT)));

  await t.step("без tmux — ESC ] 5 2 ; c ; <base64> BEL", () => {
    const bytes = osc52(TEXT, undefined);
    assertEquals(bytes[0], 0x1b);
    assertEquals(decoder.decode(bytes.subarray(1, 7)), "]52;c;");
    assertEquals(bytes[bytes.length - 1], 0x07);
    assertEquals(decoder.decode(bytes.subarray(7, bytes.length - 1)), base64);
  });

  await t.step("под tmux — passthrough вокруг неё", () => {
    const bytes = osc52(TEXT, "/tmp/tmux-1000/default,123,0");
    assertEquals(decoder.decode(bytes.subarray(0, 7)), "\x1bPtmux;");
    // Спека: `… ESC <последовательность>`, а сама последовательность
    // начинается с ESC — отсюда удвоение, которого требует passthrough
    // tmux.
    assertEquals(bytes[7], 0x1b);
    assertEquals(bytes.subarray(8, bytes.length - 2), osc52(TEXT, undefined));
    assertEquals(decoder.decode(bytes.subarray(bytes.length - 2)), "\x1b\\");
  });

  await t.step("пустой TMUX равнозначен отсутствию", () => {
    assertEquals(osc52(TEXT, ""), osc52(TEXT, undefined));
  });

  await t.step("текст уходит как есть, без обрезки", () => {
    const bytes = osc52("хвост\n\n", undefined);
    const encoded = decoder.decode(bytes.subarray(7, bytes.length - 1));
    assertEquals(
      new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)),
      ),
      "хвост\n\n",
    );
  });
});

Deno.test("предел ожидания передаётся утилите", async () => {
  let seen = 0;
  await copyToClipboard(TEXT, {
    writeTerminal: () => Promise.resolve(false),
    env: () => undefined,
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

  await t.step(
    "под терминалом байты уходят в stderr, stdout не тронут",
    async () => {
      // Настоящий порт, а не подстановка: мутация «писать в stdout»
      // краснеет только здесь — у фейка адресата нет вовсе. Терминал
      // подменяется признаком: в прогоне тестов stderr перехвачен.
      const toStdout: number[] = [];
      const toStderr: number[] = [];
      const stdoutWrite = Deno.stdout.write.bind(Deno.stdout);
      const stderrWrite = Deno.stderr.write.bind(Deno.stderr);
      const isTerminal = Deno.stderr.isTerminal.bind(Deno.stderr);
      Deno.stdout.write = (chunk: Uint8Array) => {
        toStdout.push(...chunk);
        return Promise.resolve(chunk.length);
      };
      Deno.stderr.write = (chunk: Uint8Array) => {
        toStderr.push(...chunk);
        return Promise.resolve(chunk.length);
      };
      Deno.stderr.isTerminal = () => true;
      try {
        assertEquals(await io.writeTerminal(osc52(TEXT, undefined)), true);
      } finally {
        Deno.stdout.write = stdoutWrite;
        Deno.stderr.write = stderrWrite;
        Deno.stderr.isTerminal = isTerminal;
      }
      assertEquals(Uint8Array.from(toStderr), osc52(TEXT, undefined));
      assertEquals(toStdout, [], "байты ушли в stdout — конвейер испорчен");
    },
  );

  await t.step("stderr не терминал — попытка 1 честно неуспешна", async () => {
    // В прогоне тестов stderr перехвачен, то есть терминалом не
    // является; настоящая реализация обязана это заметить и уступить
    // утилите, иначе в конвейере буфер остался бы пустым.
    assertEquals(await io.writeTerminal(osc52(TEXT, undefined)), false);
  });

  await t.step("бинаря нет — тоже неуспешна, без ошибки наружу", async () => {
    assertEquals(
      await io.runUtility("/bin/net-takogo-binarya", [], bytes, 2_000),
      false,
    );
  });
});
