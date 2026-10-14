/**
 * Команда `mpu code literals` (`specs/code-literals.md`): какие значения
 * данных в файле повторены литералом и какая величина записана в двух
 * формах.
 *
 * Адрес, `--base`, разбор и шапка без гарантии — общий прогон по
 * файлам (`file_survey.ts`); здесь — что считается в файле и как это
 * печатается.
 */

import { z } from "zod";
import { type CommandIo, defineCommand } from "@mpu/command";
import {
  ADDRESS_HELP,
  EXIT_HELP,
  LIMIT_HELP,
  partSchema,
  type Survey,
  type SurveyArgs,
  type SurveyDeps,
  surveyArgsSchema,
  surveyFiles,
  surveySchema,
} from "./file_survey.ts";
import { readLiterals } from "./literal_reading.ts";
import type { Pair, Repeat } from "./literals.ts";
import { block, renderSurvey } from "./survey_text.ts";

export { DEFAULT_LIMIT } from "./file_survey.ts";

const repeatSchema = z.object({
  value: z.string(),
  count: z.number().int().positive(),
  lines: z.array(z.number().int().positive()),
});

const pairSchema = z.object({
  first: z.string(),
  second: z.string(),
  lines: z.array(z.number().int().positive()),
});

const fileSchema = z.object({
  path: z.string(),
  repeats: partSchema(repeatSchema),
  pairs: partSchema(pairSchema),
});

const resultSchema = surveySchema(fileSchema);

/** Ответ `mpu code literals`: по разделу на репозиторий. */
export type LiteralsResult = z.infer<typeof resultSchema>;

type FileSection = z.infer<typeof fileSchema>;

export const codeLiteralsCommand = defineCommand({
  path: ["code", "literals"],
  keys: {
    address: {
      input: "addresses",
      why: "вход-список: ключ в единственном числе, повторяется",
    },
  },
  summary: "на приёмке теста: какие данные повторены литералом и в двух формах",
  usage: "mpu code literals address: АДРЕС... [base: REF] [limit: N]",
  help: `Спрашивают на приёмке и рецензии теста: какие значения данных
повторены литералом и какая величина записана в двух формах (правило
«данные теста — именованная константа»). Лучше грепа: отличает данные
от адресов экрана (data-testid, подписи, роли, названия тестов) и
видит одну величину в двух записях — '101' и 101, '2026-09-04' и
'04.09.2026'.

${ADDRESS_HELP}

  base: REF   только записи, задевшие строку, изменённую против
              merge-base REF HEAD в рабочем дереве (файл вне базы —
              целиком); запись печатается со всеми вхождениями
${LIMIT_HELP}

Разделов у файла два. «повторы» — значение, встреченное больше одного
раза: ЗНАЧЕНИЕ ×K и строки. «две формы» — число и его строка, дата
ГГГГ-ММ-ДД и тот же день ДД.ММ.ГГГГ, даже по одному вхождению. После
файлов — «не разрешено»: файлы с синтаксической ошибкой и её причина.

Литерал данных — строка, строка атрибута JSX, шаблон без подстановок,
число (минус перед ним — часть значения). Не считаются: названия
тестов (первый аргумент describe/it/test и их форм через точку, у
it.each(…) — второго вызова), все аргументы поисков экрана getBy…/
queryBy…/findBy… (кроме дат), спецификаторы модулей, имена свойств и
литеральные типы, значения '', 0, 1, -1. Даты ГГГГ-ММ-ДД и ДД.ММ.ГГГГ
считаются и внутри строки.

${EXIT_HELP}`,
  examples: [
    "mpu code literals address: sl-front:src/app/checklist/ChecklistClient.spec.tsx",
    "mpu code literals address: sl-front:src/app/checklist/ChecklistClient.spec.tsx base: main",
  ],
  policy: "ro",
  argsSchema: surveyArgsSchema,
  forms: { addresses: { positional: "rest" } },
  resultSchema,
  run: (args, io) => runLiterals(args, io),
  render: renderLiterals,
});

/**
 * Литералы разобранного файла. Запись печатается целиком или не
 * печатается: фильтр спрашивают о всех её строках, и вхождения вне
 * изменённых строк в ней остаются.
 */
const LITERALS: Survey<FileSection> = {
  wording: {
    example: "mpu code literals ПУТЬ.spec.tsx",
    measured: "литералы считаются",
  },
  measure: (ts, path, source, lines, limit) => {
    const tally = readLiterals(ts, source);
    return {
      path,
      repeats: limit.cut(tally.repeats().filter((r) => lines.touches(r.lines))),
      pairs: limit.cut(tally.pairs().filter((p) => lines.touches(p.lines))),
    };
  },
};

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура репозиторием по правилу «подкаталог с `.git`» не
 * является.
 */
export async function runLiterals(
  args: SurveyArgs,
  io: Pick<CommandIo, "cwd">,
  deps: SurveyDeps = {},
): Promise<LiteralsResult> {
  return await surveyFiles(args, io, LITERALS, deps);
}

/**
 * Текст ответа: по разделу на репозиторий, между ними пустая строка.
 * Внутри раздела — шапка без гарантии, файлы, «не разрешено».
 */
export function renderLiterals(result: LiteralsResult): string {
  return renderSurvey(result, (file) => [
    file.path,
    ...block("повторы", file.repeats, repeatLine),
    ...block("две формы", file.pairs, pairLine),
  ]);
}

function repeatLine(repeat: Repeat): string {
  return `${repeat.value} ×${repeat.count}  строки ${repeat.lines.join(", ")}`;
}

function pairLine(pair: Pair): string {
  return `${pair.first} ↔ ${pair.second}  строки ${pair.lines.join(", ")}`;
}
