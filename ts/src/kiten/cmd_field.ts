/**
 * Команды `mpu kiten field` (`docs/specs/kiten-field.md`): кастомные поля
 * карточки Kaiten — скалярные (`set`) и файловое «9. AI-артефакт»
 * (`artefact set` / `artefact rm`).
 *
 * Три листа лежат вместе, потому что делят одну таблицу «вид поля → id
 * поля инстанса»: она и есть предмет спеки, а разложенная по трём файлам
 * распалась бы на три места правки. Про HTTP и форму ответов сервера
 * здесь не знают — только про каталог (`../kaiten/mod.ts`).
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import {
  deleteCardFile,
  getCard,
  type KaitenAccess,
  parseCardRef,
  updateCardProperties,
  uploadCustomPropertyFile,
} from "../kaiten/mod.ts";
import { asCommandError, baseName, kaitenAccess } from "./access.ts";

/** Скалярные поля карточки; закрытый список — контракт CLI. */
const FIELD_KINDS = ["mr", "hypothesis", "done", "result"] as const;

/** Вид поля — `FieldKind` глоссария. */
type FieldKind = typeof FIELD_KINDS[number];

/** Вид поля → id кастомного поля инстанса Kaiten (таблица спеки). */
const PROPERTY_IDS: Readonly<Record<FieldKind, number>> = {
  mr: 398965,
  hypothesis: 291984,
  done: 291985,
  result: 291990,
};

/** Файловое поле «9. AI-артефакт»: единственное, куда грузится md. */
const ARTEFACT_PROPERTY_ID = 610303;

/** Имя поля в выводе `artefact`: короткое, как у прежней реализации. */
const ARTEFACT_TITLE = "AI-артефакт";

const selector = z.string({ error: "нужен SELECTOR: id карточки или её URL" })
  .describe("id карточки либо её URL, короткий или глубокий");

const setArgsSchema = z.object({
  selector,
  kind: z.enum(FIELD_KINDS, {
    error: `KIND — одно из: ${FIELD_KINDS.join(", ")}`,
  }).describe("какое поле карточки писать"),
  value: z.string({ error: "нужен VALUE: значение поля" })
    .describe("значение поля: пишется ровно как передано"),
});

const setResultSchema = z.object({
  kind: z.enum(FIELD_KINDS).describe("вид поля, как передан в аргументе"),
  value: z.string().describe("записанное значение"),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

const artefactSetArgsSchema = z.object({
  selector,
  path: z.string({ error: "нужен PATH: путь к md-файлу" })
    .describe("md-файл артефакта; имя обязано оканчиваться на .md"),
});

const artefactSetResultSchema = z.object({
  name: z.string().describe("имя файла из ответа загрузки"),
  fileUrl: z.string().describe(
    "url файла из ответа загрузки: приходит без доменного имени и не открывается",
  ),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

const artefactRmArgsSchema = z.object({ selector });

const artefactRmResultSchema = z.object({
  removed: z.array(z.string()).describe(
    "имена удалённых файлов в порядке files[] карточки; пусто — поле было пусто",
  ),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

/** Разобранные аргументы `field set`. */
type KitenFieldSetArgs = z.infer<typeof setArgsSchema>;

/** Результат `field set`: что записано и куда. */
type KitenFieldSetResult = z.infer<typeof setResultSchema>;

/** Разобранные аргументы `field artefact set`. */
type KitenArtefactSetArgs = z.infer<typeof artefactSetArgsSchema>;

/** Результат `field artefact set`: загруженный файл и адрес карточки. */
type KitenArtefactSetResult = z.infer<typeof artefactSetResultSchema>;

/** Разобранные аргументы `field artefact rm`. */
type KitenArtefactRmArgs = z.infer<typeof artefactRmArgsSchema>;

/** Результат `field artefact rm`: имена удалённых файлов. */
type KitenArtefactRmResult = z.infer<typeof artefactRmResultSchema>;

/**
 * Записывает поле переданным значением: прежнее заменяется без чтения и
 * без слияния (`kiten-field.md`, «Инварианты»).
 */
async function runKitenFieldSet(
  args: KitenFieldSetArgs,
  io: CommandIo,
): Promise<KitenFieldSetResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  try {
    await updateCardProperties(access, cardId, {
      [`id_${PROPERTY_IDS[args.kind]}`]: args.value,
    });
  } catch (err) {
    throw asCommandError(err);
  }
  return {
    kind: args.kind,
    value: args.value,
    cardUrl: cardUrl(access, cardId),
  };
}

/**
 * Грузит md-файл в поле артефакта. Проверка имени — до всякого чтения и
 * до сети: расширение решается по имени, не по содержимому
 * (`kiten-field.md`, «Инварианты»).
 */
async function runKitenArtefactSet(
  args: KitenArtefactSetArgs,
  io: CommandIo,
): Promise<KitenArtefactSetResult> {
  const cardId = parseCardRef(args.selector);
  const name = baseName(args.path);
  if (!/\.md$/i.test(name)) {
    throw new UsageError(
      `артефакт должен быть .md-файлом, получен '${name}'`,
    );
  }
  const access = kaitenAccess(io);
  const bytes = await readArtefact(io, args.path);
  try {
    const file = await uploadCustomPropertyFile(
      access,
      cardId,
      ARTEFACT_PROPERTY_ID,
      { name, bytes },
    );
    // `url` печатается как пришёл: ответ загрузки отдаёт его без
    // доменного имени файлового хоста, и достроить его команде нечем
    // (`platform/kaiten-api-cards.md`, форма «Файл»).
    return {
      name: file.name,
      fileUrl: file.url,
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Удаляет все файлы поля артефакта. Значение поля чистится сервером само
 * — отдельного запроса нет (`platform/kaiten-api-cards.md`, «Инварианты»).
 * Файлы удаляются по одному и по порядку: сбой в середине оставляет уже
 * удалённые удалёнными (`kiten-field.md`, «Граничные случаи»), и в гонке
 * запросов этого было бы не сказать.
 */
async function runKitenArtefactRm(
  args: KitenArtefactRmArgs,
  io: CommandIo,
): Promise<KitenArtefactRmResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  try {
    const card = await getCard(access, cardId);
    const files = card.files.filter(
      (file) => file.customPropertyId === ARTEFACT_PROPERTY_ID,
    );
    for (const file of files) {
      await deleteCardFile(access, cardId, file.id);
    }
    return {
      removed: files.map((file) => file.name),
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Адрес карточки для человека: базовый URL API и id, не ответ сервера. */
function cardUrl(access: KaitenAccess, cardId: number): string {
  return `${access.baseUrl}/${cardId}`;
}

/**
 * Байты артефакта. Нет пути либо это не обычный файл — ошибка ВВОДА
 * (exit 2, до сети), как и всякий отказ чтения: сеть тут ни при чём.
 */
async function readArtefact(
  io: CommandIo,
  path: string,
): Promise<Uint8Array> {
  try {
    return await io.readRegularFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new UsageError(`артефакт не найден: ${path}`, { cause: err });
    }
    throw new UsageError(
      `не удалось прочитать артефакт ${path}: ${reason(err)}`,
      { cause: err },
    );
  }
}

/** Причина отказа одной строкой: для текста ошибки ввода. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ENV_KEYS = `Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL
(по умолчанию https://btlz.kaiten.ru).`;

export const kitenFieldSetCommand = defineCommand({
  path: ["kiten", "field", "set"],
  errorName: "kiten field set",
  summary: "Записать скалярное кастомное поле карточки Kaiten.",
  usage: "mpu kiten field set SELECTOR KIND VALUE",
  help: `SELECTOR — id карточки (65634936) либо её URL: id — последний
полностью числовой сегмент пути.

KIND — одно из: mr (ссылка на merge request), hypothesis
(«6. Причина/гипотеза»), done («7. Что сделано»), result
(«8. Результат»). Иное значение — ошибка ввода, запроса не будет.

VALUE записывается ровно как передан: прежнее значение заменяется целиком,
без чтения и без слияния. Пробелы внутри — обычный текст, значение с
пробелами берётся в кавычки shell'а.

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (KIND, селектор,
ненастроенный KITEN_API_KEY).

Пример: mpu kiten field set 65634936 mr https://gitlab/team/repo/-/merge_requests/999`,
  policy: "rw",
  argsSchema: setArgsSchema,
  forms: {
    selector: { positional: "one" },
    kind: { positional: "one" },
    value: { positional: "one" },
  },
  resultSchema: setResultSchema,
  run: runKitenFieldSet,
  render: (result) =>
    `ok: ${result.kind} → ${result.value} · ${result.cardUrl}\n`,
});

export const kitenArtefactSetCommand = defineCommand({
  path: ["kiten", "field", "artefact", "set"],
  errorName: "kiten field artefact set",
  summary: "Загрузить md-файл в поле карточки «9. AI-артефакт».",
  usage: "mpu kiten field artefact set SELECTOR PATH",
  help: `SELECTOR — id карточки либо её URL.

PATH — существующий обычный файл, имя которого оканчивается на .md
(регистр не значим: .MD проходит). Проверяется имя, не содержимое, и
проверяется до запроса. Прикрепляется сам файл; имя в Kaiten — базовое имя
пути, без каталога.

В выводе печатается url файла из ответа загрузки. Он приходит без
доменного имени файлового хоста и не открывается — абсолютную ссылку несёт
только карточка (mpu kiten card).

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (не .md, пути
нет либо он не обычный файл, селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten field artefact set 65634936 razbor.md`,
  policy: "rw",
  argsSchema: artefactSetArgsSchema,
  forms: {
    selector: { positional: "one" },
    path: { positional: "one" },
  },
  resultSchema: artefactSetResultSchema,
  run: runKitenArtefactSet,
  render: (result) =>
    `ok: артефакт ${result.name} → ${result.cardUrl} (файл ${result.fileUrl})\n`,
});

export const kitenArtefactRmCommand = defineCommand({
  path: ["kiten", "field", "artefact", "rm"],
  errorName: "kiten field artefact rm",
  summary: "Удалить файлы карточки, привязанные к полю «9. AI-артефакт».",
  usage: "mpu kiten field artefact rm SELECTOR",
  help: `SELECTOR — id карточки либо её URL.

Удаляет ВСЕ файлы карточки, привязанные к полю «9. AI-артефакт»; значение
поля сервер чистит сам. Файлы комментариев и файлы карточки вне поля не
трогаются. Поле уже пусто — успех и сообщение об этом: повторный вызов
безопасен.

Сбой удаления в середине списка не откатывает уже удалённое.

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (селектор,
ненастроенный KITEN_API_KEY).

Пример: mpu kiten field artefact rm 65634936`,
  policy: "rw",
  argsSchema: artefactRmArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema: artefactRmResultSchema,
  run: runKitenArtefactRm,
  render: (result) =>
    result.removed.length === 0
      ? `ok: поле «${ARTEFACT_TITLE}» уже пусто · ${result.cardUrl}\n`
      : `ok: удалено из «${ARTEFACT_TITLE}»: ${
        result.removed.join(", ")
      } · ${result.cardUrl}\n`,
});
