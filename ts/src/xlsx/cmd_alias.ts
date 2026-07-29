/** Группа `mpu xlsx alias` — именованные алиасы путей к книгам. */

import {
  loadStore,
  saveStore,
  type Subcommand,
  type XlsxIo,
} from "./command.ts";
import { parseOptions } from "./cli.ts";
import { renderGroupHelp, renderLeafHelp } from "./help.ts";
import { UsageError } from "./errors.ts";
import { withAlias, withoutAlias } from "../config/mod.ts";

/** Разрешённые имена алиасов (контракт спеки). */
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

const addCommand: Subcommand = {
  name: "add",
  help: {
    usage: "mpu xlsx alias add NAME PATH",
    summary: "добавить или заменить алиас",
    body: `NAME — по [A-Za-z0-9_.-]+, иначе exit 2. PATH — непустой;
хранится как введён, существование файла не проверяется. Повторное
add того же имени заменяет путь (upsert). Успех молчалив.

Exit: 0 — успех; 2 — ошибка ввода; 1 — хранилище недоступно.

Пример: mpu xlsx alias add otchet ~/docs/report.xlsx`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(addCommand.help));
      return 0;
    }
    if (opts.positional.length !== 2) {
      throw new UsageError("alias add ожидает два аргумента: NAME PATH", {
        hint: "mpu xlsx alias add --help",
      });
    }
    const [name, path] = opts.positional;
    if (!NAME_RE.test(name)) {
      throw new UsageError(`invalid alias name "${name}"`, {
        hint: "имя по [A-Za-z0-9_.-]+",
      });
    }
    if (path === "") {
      throw new UsageError("alias path must not be empty");
    }
    await saveStore(io, withAlias(await loadStore(io), name, path));
    return 0;
  },
};

const listCommand: Subcommand = {
  name: "ls",
  help: {
    usage: "mpu xlsx alias ls [--json]",
    summary: "список алиасов",
    body: `Без флагов: «имя<TAB>путь» на строку, сортировка по имени.
--json: объект {"имя": "путь"}, indent 2, без финального перевода
строки. Пустой список — пустой вывод (или {}).

Exit: 0 — всегда при читаемом хранилище; 1 — хранилище битое.

Пример: mpu xlsx alias ls --json`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
      { long: "json", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(listCommand.help));
      return 0;
    }
    if (opts.positional.length > 0) {
      throw new UsageError(
        `unexpected argument "${opts.positional[0]}"`,
        { hint: "mpu xlsx alias ls --help" },
      );
    }
    const store = await loadStore(io);
    const names = Object.keys(store.aliases).sort();
    if (opts.flags.has("json")) {
      const sorted: Record<string, string> = {};
      for (const name of names) sorted[name] = store.aliases[name];
      io.stdout(JSON.stringify(sorted, null, 2));
      return 0;
    }
    io.stdout(names.map((n) => `${n}\t${store.aliases[n]}\n`).join(""));
    return 0;
  },
};

const removeCommand: Subcommand = {
  name: "rm",
  help: {
    usage: "mpu xlsx alias rm NAME",
    summary: "удалить алиас (идемпотентно)",
    body: `Удаляет алиас NAME; отсутствие имени в хранилище — не
ошибка, exit 0 всегда. Успех молчалив.

Exit: 0 — всегда; 2 — NAME не передан; 1 — хранилище недоступно.

Пример: mpu xlsx alias rm otchet`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(removeCommand.help));
      return 0;
    }
    if (opts.positional.length !== 1) {
      throw new UsageError("alias rm ожидает один аргумент: NAME", {
        hint: "mpu xlsx alias rm --help",
      });
    }
    const name = opts.positional[0];
    const store = await loadStore(io);
    if (name in store.aliases) {
      await saveStore(io, withoutAlias(store, name));
    }
    return 0;
  },
};

const SUBCOMMANDS: readonly Subcommand[] = [
  addCommand,
  listCommand,
  removeCommand,
];

function groupHelpText(): string {
  return renderGroupHelp(
    "mpu xlsx alias <подкоманда> [аргументы]",
    "Именованные алиасы путей к книгам (живут в локальном конфиге CLI).",
    SUBCOMMANDS.map((sub) => ({ name: sub.name, summary: sub.help.summary })),
  );
}

export const aliasCommand: Subcommand = {
  name: "alias",
  help: {
    usage: "mpu xlsx alias add|ls|rm …",
    summary: "алиасы путей: add | ls | rm",
    // Групповой уровень: тело собирается из реестра и не устаревает.
    body: `Подкоманды: ${SUBCOMMANDS.map((sub) => sub.name).join(", ")}; ` +
      "подробнее — mpu xlsx alias <подкоманда> --help.",
  },
  run: (args, io) => runAliasGroup(args, io),
};

async function runAliasGroup(
  args: readonly string[],
  io: XlsxIo,
): Promise<number> {
  const [first, ...rest] = args;
  if (first === undefined) {
    io.stdout(groupHelpText());
    return 2;
  }
  if (first === "-h" || first === "--help") {
    io.stdout(groupHelpText());
    return 0;
  }
  const sub = SUBCOMMANDS.find((s) => s.name === first);
  if (sub === undefined) {
    throw new UsageError(`unknown alias subcommand "${first}"`, {
      hint: "mpu xlsx alias --help",
    });
  }
  return await sub.run(rest, io);
}
