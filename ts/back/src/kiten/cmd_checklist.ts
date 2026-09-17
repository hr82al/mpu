/**
 * Команды `mpu kiten checklist` (`docs/specs/kiten-checklist.md`):
 * чек-листы карточки Kaiten — единственные интерактивные чекбоксы
 * системы. `ls` читает, `add` создаёт чек-лист и дописывает пункты,
 * `check`/`uncheck` ставят и снимают отметку.
 *
 * Четыре листа лежат вместе, потому что делят одну ссылку на пункт:
 * `ITEM` — id либо подстрока текста, и резолв у обеих отметок общий, а
 * `ls` печатает ровно тот список, по которому ссылку и составляют.
 * Порядок пунктов и оформление — `checklist_view.ts`; про HTTP и форму
 * ответов сервера здесь не знают — только про каталог (`../kaiten/mod.ts`).
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError, UsageError } from "../command/mod.ts";
import {
  type Checklist,
  createCardChecklist,
  createChecklistItem,
  getCard,
  type KaitenAccess,
  parseCardRef,
  updateChecklistItem,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import {
  candidateList,
  type CardChecklistItem,
  cardItems,
  checklistViews,
  checklistViewSchema,
  orderedChecklists,
  renderChecklists,
  renderChecklistsJson,
} from "./checklist_view.ts";

const selector = z.string({ error: "нужен SELECTOR: id карточки или её URL" })
  .describe("id карточки либо её URL, короткий или глубокий");

const itemRef = z.string({
  error: "нужен ITEM: id пункта либо подстрока его текста",
}).describe("ссылка на пункт: id из вывода ls либо подстрока текста");

const lsArgsSchema = z.object({
  selector,
  json: z.boolean().default(false).describe("вывод массивом, а не таблицей"),
});

const lsResultSchema = z.object({
  checklists: z.array(checklistViewSchema).describe(
    "чек-листы по возрастанию id; пункты внутри — отсортированы",
  ),
});

const addArgsSchema = z.object({
  selector,
  name: z.string({ error: "нужен --name: название чек-листа" })
    .describe("название чек-листа; совпадение с существующим точное"),
  item: z.array(z.string()).default([]).describe(
    "текст пункта; флаг повторяется, пункты добавляются в порядке флагов",
  ),
});

const addResultSchema = z.object({
  name: z.string().describe("название чек-листа, как его вернул сервер"),
  checklistId: z.number().int().describe(
    "id чек-листа: созданного либо его же",
  ),
  created: z.boolean().describe("создан ли чек-лист этим вызовом"),
  added: z.number().int().describe(
    "сколько пунктов создано: уже имевшиеся тексты не в счёт",
  ),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

const markArgsSchema = z.object({ selector, item: itemRef });

const markResultSchema = z.object({
  checked: z.boolean().describe("отметка пункта из ответа сервера"),
  text: z.string().describe("текст пункта из ответа сервера"),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

/** Разобранные аргументы `checklist ls`. */
type KitenChecklistLsArgs = z.infer<typeof lsArgsSchema>;

/** Результат `checklist ls`: чек-листы карточки в форме вывода. */
type KitenChecklistLsResult = z.infer<typeof lsResultSchema>;

/** Разобранные аргументы `checklist add`. */
type KitenChecklistAddArgs = z.infer<typeof addArgsSchema>;

/** Результат `checklist add`: чек-лист и число созданных пунктов. */
type KitenChecklistAddResult = z.infer<typeof addResultSchema>;

/** Разобранные аргументы `checklist check` и `checklist uncheck`. */
type KitenChecklistMarkArgs = z.infer<typeof markArgsSchema>;

/** Результат отметки: пункт, каким его вернул сервер. */
type KitenChecklistMarkResult = z.infer<typeof markResultSchema>;

/** Чек-лист, найденный на карточке либо созданный этим вызовом. */
interface ChecklistTarget {
  readonly checklist: Checklist;
  readonly created: boolean;
}

/** Читает чек-листы карточки; сортировка пунктов — в форме вывода. */
async function runKitenChecklistLs(
  args: KitenChecklistLsArgs,
  io: AccessIo,
): Promise<KitenChecklistLsResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  try {
    const card = await getCard(access, cardId);
    return { checklists: checklistViews(card.checklists) };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Создаёт чек-лист (или берёт существующий по точному имени) и
 * дописывает недостающие пункты. Идемпотентна: второй чек-лист с тем же
 * именем не появляется, а текст, который уже есть, пропускается.
 */
async function runKitenChecklistAdd(
  args: KitenChecklistAddArgs,
  io: AccessIo,
): Promise<KitenChecklistAddResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  const target = await resolveChecklist(access, cardId, args.name);
  const added = await appendItems(access, cardId, target.checklist, args.item);
  return {
    name: target.checklist.name,
    checklistId: target.checklist.id,
    created: target.created,
    added,
    cardUrl: cardUrl(access, cardId),
  };
}

/**
 * Ставит или снимает отметку пункта. Ссылка резолвится по прочитанной
 * карточке ДО запроса: ненайденная и неоднозначная не приводят ни к
 * одному мутирующему вызову (`kiten-checklist.md`, «Инварианты»).
 */
async function runKitenChecklistMark(
  args: KitenChecklistMarkArgs,
  io: AccessIo,
  checked: boolean,
): Promise<KitenChecklistMarkResult> {
  const cardId = parseCardRef(args.selector);
  requireItemRef(args.item);
  const access = kaitenAccess(io);
  const found = locateItem(await readItems(access, cardId), args.item);
  try {
    const updated = await updateChecklistItem(
      access,
      cardId,
      found.checklistId,
      found.item.id,
      { checked },
    );
    return {
      checked: updated.checked,
      text: updated.text,
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Все пункты карточки в порядке показа: по ним и резолвится ссылка. */
async function readItems(
  access: KaitenAccess,
  cardId: number,
): Promise<readonly CardChecklistItem[]> {
  try {
    return cardItems((await getCard(access, cardId)).checklists);
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Ссылка на пункт, которую есть смысл искать. Пустая подстрока совпала
 * бы со всем: на карточке с единственным пунктом это ровно одно
 * совпадение, то есть мутация по мусорному входу, — поэтому отказ до
 * первого запроса (`kiten-checklist.md`, «Граничные случаи»).
 */
function requireItemRef(ref: string): void {
  if (ref.trim() !== "") return;
  throw new UsageError(
    "пустая ссылка на пункт; ожидается id пункта или подстрока его текста",
  );
}

/**
 * Пункт по ссылке `ITEM`. Числовая ссылка, совпавшая с `id`, побеждает
 * подстрочный поиск всегда — сравнение с `String(id)` и есть «строка из
 * одних цифр»: другая строка ему равной не будет. Подстрока сравнивается
 * без учёта регистра и годится ровно одна.
 */
function locateItem(
  items: readonly CardChecklistItem[],
  ref: string,
): CardChecklistItem {
  const byId = items.find(({ item }) => String(item.id) === ref);
  if (byId !== undefined) return byId;

  const needle = ref.toLowerCase();
  const hits = items.filter(({ item }) =>
    item.text.toLowerCase().includes(needle)
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new UsageError(
      `пункт '${ref}' неоднозначен, кандидаты: ${candidateList(hits)}`,
    );
  }
  const known = items.length === 0 ? "(пунктов нет)" : candidateList(items);
  throw new UsageError(`пункт '${ref}' не найден; есть: ${known}`);
}

/**
 * Чек-лист с этим именем: найденный на карточке либо созданный. Имён
 * сервер не различает, поэтому одноимённые разводятся тем же порядком,
 * каким их показывает `ls`, — побеждает меньший `id`
 * (`kiten-checklist.md`, «Граничные случаи»).
 */
async function resolveChecklist(
  access: KaitenAccess,
  cardId: number,
  name: string,
): Promise<ChecklistTarget> {
  try {
    const card = await getCard(access, cardId);
    const existing = orderedChecklists(card.checklists).find((checklist) =>
      checklist.name === name
    );
    if (existing !== undefined) return { checklist: existing, created: false };
    return {
      checklist: await createCardChecklist(access, cardId, name),
      created: true,
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Дописывает пункты по одному запросу на пункт и возвращает число
 * созданных. `sort_order` нового пункта — максимум весов чек-листа на
 * момент чтения плюс порядковый номер флага `-i`: пропущенный текст
 * номер всё равно занимает, поэтому порядок добавленных совпадает с
 * порядком флагов.
 */
async function appendItems(
  access: KaitenAccess,
  cardId: number,
  checklist: Checklist,
  texts: readonly string[],
): Promise<number> {
  const present = new Set(checklist.items.map((item) => item.text));
  const base = maxSortOrder(checklist);
  let added = 0;
  for (const [index, text] of texts.entries()) {
    // Повтор текста внутри одного вызова — тоже повтор: дубль не
    // создаётся ни между вызовами, ни внутри списка флагов.
    if (present.has(text)) continue;
    present.add(text);
    try {
      await createChecklistItem(access, cardId, checklist.id, {
        text,
        checked: false,
        sortOrder: base + index + 1,
      });
    } catch (err) {
      throw addFailure(err, added);
    }
    added++;
  }
  return added;
}

/** Максимум весов пунктов чек-листа; пунктов и весов нет — ноль. */
function maxSortOrder(checklist: Checklist): number {
  const orders = checklist.items.map((item) => item.sortOrder ?? 0);
  return orders.length === 0 ? 0 : Math.max(...orders);
}

/**
 * Отказ на середине списка `-i`: сколько пунктов успело добавиться.
 * Уже созданные остаются на карточке, и без числа повтор команды был бы
 * вслепую (`kiten-checklist.md`, «Известные отклонения»).
 */
function addFailure(err: unknown, added: number): unknown {
  const failure = asCommandError(err);
  if (!(failure instanceof DomainError)) return failure;
  // Пересобирается только текст: подсказки и подробности переносятся
  // как есть — терять их по дороге ошибка не обязана.
  return new DomainError(`${failure.message}; добавлено пунктов: ${added}`, {
    hint: failure.hint,
    advice: failure.advice,
    details: failure.details,
    cause: failure.cause,
  });
}

const ENV_KEYS = `Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL
(по умолчанию https://btlz.kaiten.ru).`;

const ITEM_HELP = `ITEM — ссылка на пункт: id из вывода ls либо подстрока
его текста. Строка из одних цифр сначала пробуется как id: совпал — он и
побеждает, не совпал — та же строка ищется подстрокой. Подстрока
сравнивается без учёта регистра и ищется по ВСЕМ чек-листам карточки;
годится ровно одно совпадение. Ни одного совпадения либо несколько —
ошибка ввода с перечнем пунктов, и ни одного запроса на изменение при
этом не уходит. Пустая ссылка и ссылка из одних пробелов отвергаются до
сети: пустая подстрока совпадает со всем.`;

const MARK_EXIT = `Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода
(селектор, ненайденная или неоднозначная ссылка на пункт, ненастроенный
KITEN_API_KEY).`;

export const kitenChecklistLsCommand = defineCommand({
  path: ["kiten", "checklist", "ls"],
  errorName: "kiten checklist ls",
  summary: "Показать чек-листы карточки Kaiten с пунктами.",
  usage: "mpu kiten checklist ls SELECTOR [--json]",
  help: `SELECTOR — id карточки либо её URL.

Печатает по блоку на чек-лист: заголовок «название · отмечено/всего
(checklist id N)» и таблицу пунктов — id, отметка ([x] или [ ]) и текст.
Пункты идут по возрастанию sort_order, при равенстве по id, а сами
чек-листы — по возрастанию id: сервер отдаёт и то и другое в
произвольном порядке, и без сортировки список расходился бы с
веб-карточкой. Текст пункта печатается одной строкой целиком — его же
копируют в check/uncheck. Чек-листов нет — строка «(чек-листов нет)».

--json печатает массив чек-листов: id, name, items[] с полями id,
checked, text — в том же порядке пунктов. Чек-листов нет — [].

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (селектор,
ненастроенный KITEN_API_KEY).

Пример: mpu kiten checklist ls 10000001 --json`,
  policy: "ro",
  argsSchema: lsArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema: lsResultSchema,
  run: runKitenChecklistLs,
  render: (result, args) =>
    args.json
      ? renderChecklistsJson(result.checklists)
      : renderChecklists(result.checklists),
});

export const kitenChecklistAddCommand = defineCommand({
  path: ["kiten", "checklist", "add"],
  errorName: "kiten checklist add",
  summary: "Создать чек-лист карточки Kaiten и дописать в него пункты.",
  usage: "mpu kiten checklist add SELECTOR -n NAME [-i TEXT]...",
  help: `SELECTOR — id карточки либо её URL.

-n/--name NAME (обязателен) — название чек-листа. Совпадение с уже
существующим точное: регистр и пробелы значимы. Совпал — пункты идут в
него, чек-лист не создаётся.

-i/--item TEXT (повторяется, необязателен) — текст пункта. Пункты
добавляются в порядке флагов; текст, который на этом чек-листе уже есть,
пропускается — дубль не создаётся ни повтором команды, ни повтором флага.
Без -i чек-лист просто создаётся, «добавлено пунктов: 0».

Ничего не удаляется и не переписывается: команда только создаёт.
Отказ на середине списка не откатывает уже созданные пункты — их число
названо в сообщении об ошибке, повтор команды безопасен.

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (селектор,
отсутствие --name, ненастроенный KITEN_API_KEY).

Пример: mpu kiten checklist add 10000001 -n 'Подзадачи' -i 'Спека — 1 ч'`,
  policy: "rw",
  argsSchema: addArgsSchema,
  forms: {
    selector: { positional: "one" },
    name: { short: "n" },
    item: { short: "i" },
  },
  resultSchema: addResultSchema,
  run: runKitenChecklistAdd,
  render: (result) =>
    `ok: чек-лист «${result.name}» (${
      result.created ? "создан" : "существующий"
    }, id ${result.checklistId}), добавлено пунктов: ${result.added} · ${result.cardUrl}\n`,
});

export const kitenChecklistCheckCommand = defineCommand({
  path: ["kiten", "checklist", "check"],
  errorName: "kiten checklist check",
  summary: "Отметить пункт чек-листа карточки Kaiten.",
  usage: "mpu kiten checklist check SELECTOR ITEM",
  help: `SELECTOR — id карточки либо её URL.

${ITEM_HELP}

Отметка — общее состояние с интерфейсом Kaiten, а не отдельная сущность
команды: отмеченное здесь видно в веб-карточке и наоборот. Повторный
вызов на уже отмеченном пункте безопасен и печатает ту же строку.

${ENV_KEYS}

${MARK_EXIT}

Пример: mpu kiten checklist check 10000001 'Ревью'`,
  policy: "rw",
  argsSchema: markArgsSchema,
  forms: {
    selector: { positional: "one" },
    item: { positional: "one" },
  },
  resultSchema: markResultSchema,
  run: (args, io) => runKitenChecklistMark(args, io, true),
  render: markLine,
});

export const kitenChecklistUncheckCommand = defineCommand({
  path: ["kiten", "checklist", "uncheck"],
  errorName: "kiten checklist uncheck",
  summary: "Снять отметку пункта чек-листа карточки Kaiten.",
  usage: "mpu kiten checklist uncheck SELECTOR ITEM",
  help: `SELECTOR — id карточки либо её URL.

${ITEM_HELP}

Снятая здесь отметка снята и в веб-карточке. Повторный вызов на
неотмеченном пункте безопасен и печатает ту же строку.

${ENV_KEYS}

${MARK_EXIT}

Пример: mpu kiten checklist uncheck 10000001 66470402`,
  policy: "rw",
  argsSchema: markArgsSchema,
  forms: {
    selector: { positional: "one" },
    item: { positional: "one" },
  },
  resultSchema: markResultSchema,
  run: (args, io) => runKitenChecklistMark(args, io, false),
  render: markLine,
});

/** Строка успеха отметки: состояние и текст пункта — из ответа сервера. */
function markLine(result: KitenChecklistMarkResult): string {
  const mark = result.checked ? "[x]" : "[ ]";
  return `ok: ${mark} ${result.text} · ${result.cardUrl}\n`;
}
