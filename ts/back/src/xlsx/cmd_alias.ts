/** Команды `mpu xlsx alias add|ls|rm` — алиасы путей к книгам. */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { aliases, aliasPath, removeAlias, setAlias } from "../config/mod.ts";

/** Разрешённые имена алиасов (контракт спеки). */
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

const nameSchema = z.string({
  error: "alias add ожидает два аргумента: NAME PATH",
}).refine((name) => NAME_RE.test(name), {
  error: (issue) => `invalid alias name "${String(issue.input)}"`,
});

export const aliasAddCommand = defineCommand({
  path: ["xlsx", "alias", "add"],
  summary: "добавить или заменить алиас",
  usage: "mpu xlsx alias add NAME PATH",
  help: `NAME — по [A-Za-z0-9_.-]+, иначе exit 2. PATH — непустой;
хранится как введён, существование файла не проверяется. Повторное
add того же имени заменяет путь (upsert). Успех молчалив.

Exit: 0 — успех; 2 — ошибка ввода; 1 — хранилище недоступно.

Пример: mpu xlsx alias add otchet ~/docs/report.xlsx`,
  policy: "rw",
  argsSchema: z.object({
    name: nameSchema.describe("имя алиаса по [A-Za-z0-9_.-]+"),
    path: z.string({ error: "alias add ожидает два аргумента: NAME PATH" })
      .min(1, { error: "alias path must not be empty" })
      .describe("путь к книге; хранится как введён"),
  }),
  forms: { name: { positional: "one" }, path: { positional: "one" } },
  resultSchema: z.object({
    name: z.string(),
    path: z.string(),
    /** Алиас с таким именем появился впервые (иначе путь заменён). */
    created: z.boolean(),
  }),
  run: (args, io) => {
    using db = io.openCacheDb();
    const created = aliasPath(db, args.name) === undefined;
    setAlias(db, args.name, args.path, Math.floor(Date.now() / 1000));
    return Promise.resolve({ name: args.name, path: args.path, created });
  },
  // Успех молчалив: контракт спеки, а не упущение рендера.
  render: () => "",
});

export const aliasLsCommand = defineCommand({
  path: ["xlsx", "alias", "ls"],
  summary: "список алиасов",
  usage: "mpu xlsx alias ls",
  help: `«имя<TAB>путь» на строку, сортировка по имени. Пустой список —
пустой вывод.

Exit: 0 — всегда при читаемом хранилище; 1 — хранилище битое.

Пример: mpu xlsx alias ls`,
  policy: "ro",
  argsSchema: z.object({}),
  resultSchema: z.object({
    aliases: z.array(z.object({ name: z.string(), path: z.string() })),
  }),
  run: (_args, io) => {
    using db = io.openCacheDb();
    return Promise.resolve({ aliases: [...aliases(db)] });
  },
  render: (result) =>
    result.aliases.map((alias) => `${alias.name}\t${alias.path}\n`).join(""),
});

export const aliasRmCommand = defineCommand({
  path: ["xlsx", "alias", "rm"],
  summary: "удалить алиас (идемпотентно)",
  usage: "mpu xlsx alias rm NAME",
  help: `Удаляет алиас NAME; отсутствие имени в хранилище — не ошибка,
exit 0 всегда. Успех молчалив.

Exit: 0 — всегда; 2 — NAME не передан; 1 — хранилище недоступно.

Пример: mpu xlsx alias rm otchet`,
  policy: "rw",
  argsSchema: z.object({
    name: z.string({ error: "alias rm ожидает один аргумент: NAME" })
      .describe("имя удаляемого алиаса"),
  }),
  forms: { name: { positional: "one" } },
  resultSchema: z.object({
    name: z.string(),
    /** Алиас существовал и удалён; отсутствие имени — не ошибка. */
    removed: z.boolean(),
  }),
  run: (args, io) => {
    using db = io.openCacheDb();
    return Promise.resolve({
      name: args.name,
      removed: removeAlias(db, args.name),
    });
  },
  // Успех молчалив: контракт спеки, а не упущение рендера.
  render: () => "",
});
