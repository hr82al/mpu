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
import {
  type CommandIo,
  defineCommand,
  VerbatimError,
} from "../command/mod.ts";
import {
  getCard,
  type KaitenAccess,
  KaitenError,
  listCardComments,
  listCustomProperties,
  parseCardRef,
  requireKaitenAccess,
} from "../kaiten/mod.ts";
import { cardView, cardViewSchema } from "./card_view.ts";
import {
  type PropertyNames,
  renderJson,
  renderMarkdown,
  renderTerminal,
} from "./render.ts";

const argsSchema = z.object({
  selector: z.string({ error: "нужен SELECTOR: id карточки или её URL" })
    .describe("id карточки либо её URL, короткий или глубокий"),
  md: z.boolean().default(false).describe("чистый GFM markdown"),
  json: z.boolean().default(false).describe(
    "сырой JSON: карточка и комментарии",
  ),
  images: z.boolean().default(true).describe(
    "вложения-картинки в наглядном виде; выключить — флагом --no-images",
  ),
  comments: z.boolean().default(true).describe(
    "комментарии карточки; не читать их — флагом --no-comments",
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
export type CardOutputView = KitenCardResult["view"];

/**
 * Порядок шагов: карточка — первым вызовом, и только потом комментарии со
 * справочником имён. Последовательно, а не одним `Promise.all` на три
 * запроса: недоступная карточка обязана отвечать ошибкой именно по
 * `GET /cards/{id}` (`kiten-card.md`, «Граничные случаи»), а в гонке трёх
 * запросов в сообщение попал бы тот, что отказал первым.
 */
export async function runKitenCard(
  args: KitenCardArgs,
  io: CommandIo,
): Promise<KitenCardResult> {
  const cardId = parseCardRef(args.selector);
  const view = viewOf(args, io);
  try {
    const access = requireKaitenAccess(io.envFile);
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

function viewOf(args: KitenCardArgs, io: CommandIo): CardOutputView {
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

/** Путь команды; он же — имя в строке отказа Kaiten. */
const PATH: readonly string[] = ["kiten", "card"];

/**
 * Отказ Kaiten — доменная ошибка команды (exit 1). Строка собирается
 * целиком здесь: спека транспорта требует префикса с подкомандой —
 * `mpu kiten <sub>: kaiten error: …` (`platform/kaiten-http.md`, «Retry и
 * ошибки»), тогда как общий формат ошибок называет командой первый сегмент
 * пути. Поэтому `VerbatimError`: он печатается без общего префикса.
 */
function asCommandError(err: unknown): unknown {
  return err instanceof KaitenError
    ? new VerbatimError(
      `mpu ${PATH.join(" ")}: kaiten error: ${err.message}`,
      { cause: err },
    )
    : err;
}

export const kitenCardCommand = defineCommand({
  path: PATH,
  summary:
    "Одна карточка Kaiten целиком: шапка, свойства, описание, файлы, комментарии.",
  usage:
    "mpu kiten card SELECTOR [--md] [--json] [--no-images] [--no-comments]",
  help: `SELECTOR — id карточки (65634936) либо её URL, короткий
(https://btlz.kaiten.ru/65634936) или глубокий: id — последний полностью
числовой сегмент пути.

Вид вывода, по убыванию приоритета: --json (сырой JSON карточки и
комментариев, отступ 2) → --md (чистый GFM markdown) ЛИБО stdout не
терминал → наглядный терминальный рендер. Пайп без флагов отдаёт
markdown: mpu kiten card 123 | <потребитель>.

--no-comments не только убирает комментарии из вывода, но и отменяет их
запрос. --no-images убирает вложения-картинки из наглядного вида; на
--md и --json не влияет.

Имена кастомных полей для markdown и наглядного вида — отдельный запрос
справочника компании; не ответил — печатаются сырые ключи id_NNN, вывод
не срывается. На --json справочник не запрашивается: JSON несёт сырые
ключи всегда.

Чек-листы карточки эта команда не показывает ни в одном виде — их читает
mpu kiten checklist ls.

Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL (по
умолчанию https://btlz.kaiten.ru).

Exit: 0 — успех; 1 — ошибка API Kaiten (недоступная карточка приходит
как 403 с пустым телом); 2 — из селектора не извлекается id.

Пример: mpu kiten card 65634936 --md`,
  policy: "ro",
  argsSchema,
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
