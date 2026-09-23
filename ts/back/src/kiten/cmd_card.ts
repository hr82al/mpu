/**
 * Команда `mpu kiten card` (`docs/specs/kiten-card.md`): прочитать одну
 * карточку Kaiten в одном из трёх видов — наглядном терминальном, чистом
 * GFM-markdown, сыром JSON. Только чтение.
 *
 * Здесь порядок шагов вызова и его аргументы; состав данных вывода —
 * `card_view.ts`, оформление трёх видов — `render.ts`. Граница «команда ↔
 * каталог» узкая намеренно: команда зовёт каталог (`../kaiten/mod.ts`) и
 * ничего не знает ни про HTTP, ни про форму ответов сервера.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import {
  getCard,
  type KaitenAccess,
  listCardComments,
  listCustomProperties,
  parseCardRef,
} from "../kaiten/mod.ts";
import { type AccessIo, asCommandError, kaitenAccess } from "./access.ts";
import { cardView, cardViewSchema } from "./card_view.ts";
import {
  type PropertyNames,
  renderJson,
  renderMarkdown,
  renderTerminal,
} from "./render.ts";

const argsSchema = z.object({
  selector: z.string({ error: "нужен id: id карточки или её URL" })
    .describe("id карточки либо её URL, короткий или глубокий"),
  md: z.boolean().default(false).describe("чистый GFM markdown"),
  json: z.boolean().default(false).describe(
    "сырой JSON: карточка и комментарии",
  ),
  images: z.boolean().default(true).describe(
    "вложения-картинки в наглядном виде; выключить — вариантом no-images",
  ),
  comments: z.boolean().default(true).describe(
    "комментарии карточки; не читать их — вариантом no-comments",
  ),
});

const resultSchema = z.object({
  view: z.enum(["json", "md", "pretty"]).describe(
    "вид вывода, выбранный флагами и терминальностью stdout",
  ),
  card: cardViewSchema,
  propertyNames: z.record(z.string(), z.string()).describe(
    "имена кастомных полей: id_NNN → имя; справочник не ответил — пусто",
  ),
});

/** Разобранные аргументы вызова. */
export type KitenCardArgs = z.infer<typeof argsSchema>;

/** Результат: карточка вывода и всё, что нужно её отрисовать. */
export type KitenCardResult = z.infer<typeof resultSchema>;

/** Вид вывода; выбор — `--json`, затем `--md` либо непечатающий stdout. */
type CardOutputView = KitenCardResult["view"];

/**
 * Срез порта исполнения: доступ к Kaiten плюс различение человека и
 * пайпа — по нему выбирается вид вывода.
 */
type CardIo = AccessIo & Pick<CommandIo, "stdoutIsTerminal">;

/**
 * Порядок шагов: карточка — первым вызовом, и только потом комментарии со
 * справочником имён. Последовательно, а не одним `Promise.all` на три
 * запроса: недоступная карточка обязана отвечать ошибкой именно по
 * `GET /cards/{id}` (`kiten-card.md`, «Граничные случаи»), а в гонке трёх
 * запросов в сообщение попал бы тот, что отказал первым.
 */
export async function runKitenCard(
  args: KitenCardArgs,
  io: CardIo,
): Promise<KitenCardResult> {
  const cardId = parseCardRef(args.selector);
  const view = viewOf(args, io);
  const access = kaitenAccess(io);
  try {
    const card = await getCard(access, cardId);
    const [comments, propertyNames] = await Promise.all([
      args.comments ? listCardComments(access, cardId) : [],
      // На `--json` имена полей не нужны, и запроса за ними нет:
      // JSON-вывод несёт сырые ключи (`kiten-card.md`, «Инварианты»).
      view === "json" ? {} : propertyNamesOf(access),
    ]);
    return {
      view,
      card: cardView(card, comments, access.baseUrl),
      propertyNames,
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

function viewOf(args: KitenCardArgs, io: CardIo): CardOutputView {
  if (args.json) return "json";
  if (args.md) return "md";
  // Пайп без флагов отдаёт markdown: потребитель у него — не человек.
  return io.stdoutIsTerminal() ? "pretty" : "md";
}

/**
 * Имена кастомных полей компании — best-effort (`kiten-card.md`, «Граничные
 * случаи»): справочник не ответил — в выводе остаются сырые ключи `id_NNN`,
 * и команда не падает. Отказ ловится любой — не-2xx, обрыв связи, предел
 * времени: для вывода они неразличимы.
 */
async function propertyNamesOf(access: KaitenAccess): Promise<PropertyNames> {
  try {
    const properties = await listCustomProperties(access);
    return Object.fromEntries(
      properties.map((property) => [`id_${property.id}`, property.name]),
    );
  } catch {
    return {};
  }
}

export const kitenCardCommand = defineCommand({
  path: ["kiten", "card"],
  // Отказ API называет команду полным путём: `mpu kiten card: kaiten
  // error: …` (`platform/kaiten-http.md`, «Retry и ошибки»).
  errorName: "kiten card",
  summary:
    "Одна карточка Kaiten целиком: шапка, свойства, описание, файлы, комментарии.",
  usage: `mpu kiten card [no-comments] [no-images] id: ID ` +
    `[${GRAMMAR.close} md|json]`,
  help: `Звать, когда нужна одна карточка Kaiten целиком: шапка, свойства,
описание, файлы, комментарии. Свои карточки списком — mpu kiten ls.

id: — id карточки (65634936) либо её URL, короткий
(https://btlz.kaiten.ru/65634936) или глубокий: id — последний полностью
числовой сегмент пути.

Форматы после ${GRAMMAR.close}: без формата — наглядный вид в терминале и markdown в
пайп; md — чистый GFM markdown; json — сырой JSON карточки и комментариев,
отступ 2.

no-comments не только убирает комментарии из вывода, но и отменяет их
запрос. no-images убирает вложения-картинки из наглядного вида; на md и
json не влияет.

Имена кастомных полей для markdown и наглядного вида — отдельный запрос
справочника компании; не ответил — печатаются сырые ключи id_NNN, вывод
не срывается. На json справочник не запрашивается: JSON несёт сырые
ключи всегда.

Чек-листы карточки эта команда не показывает ни в одном виде — их читает
mpu kiten checklist ls.

Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL (по
умолчанию https://btlz.kaiten.ru).

Exit: 0 — успех; 1 — ошибка API Kaiten (недоступная карточка приходит
как 403 с пустым телом); 2 — из id не извлекается номер карточки.`,
  examples: [
    "mpu kiten card id: 65634936",
    `mpu kiten card id: 65634936 ${GRAMMAR.close} md`,
    `mpu kiten card no-comments id: https://btlz.kaiten.ru/65634936 ${GRAMMAR.close} json`,
  ],
  keys: { id: "selector" },
  policy: "ro",
  argsSchema,
  formats: { md: ["--md"] },
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: runKitenCard,
  render: (result, args) => {
    switch (result.view) {
      case "json":
        return renderJson(result.card);
      case "md":
        return renderMarkdown(result.card, result.propertyNames);
      case "pretty":
        return renderTerminal(result.card, result.propertyNames, {
          images: args.images,
        });
      default: {
        const unknown: never = result.view;
        throw new TypeError(`неизвестный вид вывода: ${String(unknown)}`);
      }
    }
  },
});
