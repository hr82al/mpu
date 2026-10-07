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

import { describe, expect, it } from "vitest";
import {
  type ClipboardPorts,
  COPY_UTILITIES,
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

describe("первая удавшаяся попытка — последняя", () => {
  it("терминал взял текст — утилиты не запускаются", async () => {
    const { io, utilities } = ports({ terminal: true });
    expect(await copyToClipboard(TEXT, io)).toBe(true);
    expect(utilities).toStrictEqual([]);
  });

  it("терминала нет — идут утилиты по порядку", async () => {
    const { io, utilities } = ports({
      utility: (bin) => bin === "/usr/bin/xclip",
    });
    expect(await copyToClipboard(TEXT, io)).toBe(true);
    // `xsel` не запускался: список кончается на первой удавшейся.
    expect(utilities).toStrictEqual([
      "/usr/bin/wl-copy",
      "/usr/bin/xclip -selection clipboard",
    ]);
  });

  it("не удалось ничем — ответ «нет», без ошибки", async () => {
    const { io, utilities } = ports({});
    expect(await copyToClipboard(TEXT, io)).toBe(false);
    expect(utilities).toStrictEqual([
      "/usr/bin/wl-copy",
      "/usr/bin/xclip -selection clipboard",
      "/usr/bin/xsel --clipboard --input",
    ]);
  });
});

it("последовательность уходит в stderr, а не в stdout", async () => {
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
    expect(await copyToClipboard(TEXT, io)).toBe(true);
    expect(written.length).toBe(1);
    expect(written[0]).toStrictEqual(osc52(TEXT, "сессия"));
  } finally {
    Deno.stdout.write = write;
  }
  expect(stdout, `в stdout ушли байты: ${JSON.stringify(stdout)}`)
    .toStrictEqual([]);
});

describe("OSC 52: форма последовательности", () => {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(TEXT)));

  it("без tmux — ESC ] 5 2 ; c ; <base64> BEL", () => {
    const bytes = osc52(TEXT, undefined);
    expect(bytes[0]).toBe(0x1b);
    expect(decoder.decode(bytes.subarray(1, 7))).toBe("]52;c;");
    expect(bytes[bytes.length - 1]).toBe(0x07);
    expect(decoder.decode(bytes.subarray(7, bytes.length - 1))).toStrictEqual(
      base64,
    );
  });

  it("под tmux — passthrough вокруг неё", () => {
    const bytes = osc52(TEXT, "/tmp/tmux-1000/default,123,0");
    expect(decoder.decode(bytes.subarray(0, 7))).toBe("\x1bPtmux;");
    // Спека: `… ESC <последовательность>`, а сама последовательность
    // начинается с ESC — отсюда удвоение, которого требует passthrough
    // tmux.
    expect(bytes[7]).toBe(0x1b);
    expect(bytes.subarray(8, bytes.length - 2)).toStrictEqual(
      osc52(TEXT, undefined),
    );
    expect(decoder.decode(bytes.subarray(bytes.length - 2))).toBe("\x1b\\");
  });

  it("пустой TMUX равнозначен отсутствию", () => {
    expect(osc52(TEXT, "")).toStrictEqual(osc52(TEXT, undefined));
  });

  it("текст уходит как есть, без обрезки", () => {
    const bytes = osc52("хвост\n\n", undefined);
    const encoded = decoder.decode(bytes.subarray(7, bytes.length - 1));
    expect(new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)),
    )).toBe("хвост\n\n");
  });
});

it("предел ожидания передаётся утилите", async () => {
  let seen = 0;
  await copyToClipboard(TEXT, {
    writeTerminal: () => Promise.resolve(false),
    env: () => undefined,
    runUtility: (_bin, _args, _stdin, timeoutMs) => {
      seen = timeoutMs;
      return Promise.resolve(true);
    },
  });
  expect(seen).toBe(2_000);
});

describe("настоящие порты: утилита, её код выхода и отсутствие в PATH", () => {
  const io = denoPorts();
  const bytes = new TextEncoder().encode(TEXT);

  it("нулевой код — попытка удалась", async () => {
    // От утилиты буфера здесь нужен ровно её код выхода.
    expect(await io.runUtility("/bin/echo", [], bytes, 2_000)).toBe(true);
  });

  it("ненулевой код — попытка неуспешна", async () => {
    expect(await io.runUtility("/bin/false", [], bytes, 2_000)).toBe(false);
  });

  it("под терминалом байты уходят в stderr, stdout не тронут", async () => {
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
      expect(await io.writeTerminal(osc52(TEXT, undefined))).toBe(true);
    } finally {
      Deno.stdout.write = stdoutWrite;
      Deno.stderr.write = stderrWrite;
      Deno.stderr.isTerminal = isTerminal;
    }
    expect(Uint8Array.from(toStderr)).toStrictEqual(osc52(TEXT, undefined));
    expect(toStdout, "байты ушли в stdout — конвейер испорчен").toStrictEqual(
      [],
    );
  });

  it("stderr не терминал — попытка 1 честно неуспешна", async () => {
    // В прогоне тестов stderr перехвачен, то есть терминалом не
    // является; настоящая реализация обязана это заметить и уступить
    // утилите, иначе в конвейере буфер остался бы пустым.
    expect(await io.writeTerminal(osc52(TEXT, undefined))).toBe(false);
  });

  it("бинаря нет — тоже неуспешна, без ошибки наружу", async () => {
    expect(await io.runUtility("/bin/net-takogo-binarya", [], bytes, 2_000))
      .toBe(false);
  });
});

it("пути программ копирования — те же, что в порядке попыток", () => {
  // Список путей отдан наружу (права задач `cli` сверяются с ним), а
  // порядок попыток живёт таблицей рядом: разъедутся — тест краснеет.
  // Пути, а не имена: имя в `--allow-run` Deno разрешает по `PATH`, и
  // с пустым `PATH` клиент не стартует вовсе (`cli-client.md`).
  expect([...COPY_UTILITIES]).toStrictEqual([
    "/usr/bin/wl-copy",
    "/usr/bin/xclip",
    "/usr/bin/xsel",
  ]);
});
