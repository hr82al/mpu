/**
 * Команды `mpu sheet alias add|ls|rm` (`docs/specs/sheet-registry.md`):
 * короткие имена таблиц.
 *
 * Хранилище и его правила — `registry.ts`; резолв алиаса при вызове
 * прочих команд семейства идёт своим путём (`target.ts`) и об этих
 * командах не знает: заводить имя и пользоваться им — разные работы.
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError, UsageError } from "../command/mod.ts";
import { aliasRows, aliasSsId, removeAlias, setAlias } from "./registry.ts";
import { looksLikeSpreadsheetId, spreadsheetIdOf } from "./target.ts";

/** Допустимые имена алиасов (`sheet-registry.md`, «CLI-контракт»). */
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

const nameSchema = z.string({
  error: "alias ожидает ИМЯ",
}).refine((name) => NAME_RE.test(name), {
  error: (issue) =>
    `недопустимое имя алиаса '${String(issue.input)}': допустимы буквы, ` +
    "цифры, _, . и -",
});

const addResult = z.object({
  name: z.string(),
  ss_id: z.string().describe("идентификатор, закреплённый за именем"),
  previous: z.string().nullable().describe(
    "что было за именем до вызова; null — имени не было",
  ),
});

const rmResult = z.object({
  name: z.string(),
  ss_id: z.string().describe("идентификатор снятого имени"),
});

type AddResult = z.infer<typeof addResult>;

/**
 * `ТАБЛИЦА` — идентификатор или ссылка, и извлечённое обязано пройти
 * проверку формы: короткий хвост ссылки идентификатором не станет
 * (`sheet-registry.md`, «CLI-контракт»).
 */
function spreadsheetArg(value: string): string {
  const parsed = spreadsheetIdOf(value);
  if (parsed !== undefined && looksLikeSpreadsheetId(parsed.ssId)) {
    return parsed.ssId;
  }
  // Ни подсказки, ни совета: выбирать оператору не из чего, а готовой
  // команды, которая бы это починила, у нас нет — есть только то, чего
  // алиасу недостаёт, и оно названо в самом сообщении.
  throw new UsageError(
    `'${value}' не похоже на идентификатор таблицы или ссылку на неё; ` +
      "алиас заводится на идентификатор, а не на заголовок или номер " +
      "клиента: они резолвятся по содержимому реестра и завтра дадут " +
      "другую таблицу",
  );
}

export const sheetAliasAddCommand = defineCommand({
  path: ["sheet", "alias", "add"],
  errorName: "sheet alias add",
  summary: "Завести или переназначить короткое имя таблицы.",
  usage: "mpu sheet alias add ИМЯ ТАБЛИЦА",
  help: `ИМЯ — буквы, цифры, _, . и -; прочее отвергается кодом 2.
ТАБЛИЦА — идентификатор или ссылка на таблицу; из ссылки берётся
идентификатор. Заголовок и номер клиента алиасом не закрепляются:
резолв по ним зависит от содержимого реестра и завтра может дать
другую таблицу.

Заведение поверх существующего имени обновляет идентификатор, второй
строки не появляется. Вывод называет обе стороны замены.

Exit: 0 — успех; 2 — недопустимое имя или ТАБЛИЦА не похожа на
идентификатор; 1 — хранилище недоступно.

Пример: mpu sheet alias add otchet 1SyntheticSpreadsheetId0000`,
  policy: "rw",
  argsSchema: z.object({
    name: nameSchema.describe("имя алиаса по [A-Za-z0-9_.-]+"),
    spreadsheet: z.string({ error: "alias add ожидает ИМЯ и ТАБЛИЦА" })
      .describe("идентификатор таблицы или ссылка на неё"),
  }),
  forms: {
    name: { positional: "one" },
    spreadsheet: { positional: "one" },
  },
  resultSchema: addResult,
  run: (args, io) => {
    using db = io.openCacheDb();
    const ssId = spreadsheetArg(args.spreadsheet);
    const previous = aliasSsId(db, args.name) ?? null;
    setAlias(db, args.name, ssId, Math.floor(Date.now() / 1000));
    return Promise.resolve({ name: args.name, ss_id: ssId, previous });
  },
  // Замена называет обе стороны: «обновлён» без прежнего значения не
  // даёт оператору того единственного, что он мог сделать не так, —
  // заменить не ту таблицу.
  render: (result: AddResult) =>
    result.previous === null
      ? `alias '${result.name}' → ${result.ss_id}\n`
      : `alias '${result.name}': ${result.previous} → ${result.ss_id}\n`,
});

export const sheetAliasLsCommand = defineCommand({
  path: ["sheet", "alias", "ls"],
  errorName: "sheet alias ls",
  summary: "Показать заведённые имена таблиц.",
  usage: "mpu sheet alias ls",
  help: `«имя<TAB>идентификатор» на строку, сортировка по имени.
Пустой реестр — пустой вывод. Таблицы алиасов нет вовсе — тоже пустой
вывод и код 0: свежая БД, а не поломка.

Exit: 0 — успех; 1 — хранилище недоступно.

Пример: mpu sheet alias ls`,
  policy: "ro",
  argsSchema: z.object({}),
  resultSchema: z.object({
    aliases: z.array(z.object({ name: z.string(), ss_id: z.string() })),
  }),
  run: (_args, io) => {
    using db = io.openCacheDb();
    return Promise.resolve({ aliases: [...aliasRows(db)] });
  },
  render: (result) =>
    result.aliases.map((row) => `${row.name}\t${row.ss_id}\n`).join(""),
});

export const sheetAliasRmCommand = defineCommand({
  path: ["sheet", "alias", "rm"],
  errorName: "sheet alias rm",
  summary: "Снять короткое имя таблицы.",
  usage: "mpu sheet alias rm ИМЯ",
  help: `Снятие существующего имени — успех со строкой; снятие
отсутствующего — код 1 и сообщение, что имени нет. Идемпотентным
снятие не сделано намеренно: молчаливый успех на опечатке в имени
означал бы, что оператор считает алиас снятым, а он остался.

Exit: 0 — успех; 1 — имени нет либо хранилище недоступно; 2 — ИМЯ не
передано.

Пример: mpu sheet alias rm otchet`,
  policy: "rw",
  argsSchema: z.object({
    name: z.string({ error: "alias rm ожидает ИМЯ" })
      .describe("снимаемое имя"),
  }),
  forms: { name: { positional: "one" } },
  resultSchema: rmResult,
  run: (args, io) => {
    using db = io.openCacheDb();
    // Идентификатор читается до снятия — назвать в выводе после
    // удаления его уже неоткуда, а сказать, что именно снято, надо.
    const ssId = aliasSsId(db, args.name);
    const removed = removeAlias(db, args.name);
    if (!removed) {
      throw new DomainError(`алиаса '${args.name}' нет`, {
        hint: "mpu sheet alias ls",
      });
    }
    return Promise.resolve({ name: args.name, ss_id: ssId ?? "" });
  },
  render: (result) => `alias '${result.name}' снят (был ${result.ss_id})\n`,
});
