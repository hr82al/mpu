/**
 * Команда `mpu code shape` (`specs/code-shape.md`): какие функции файла
 * длиннее предела, глубже предела по вложенности и где флаг поведения
 * передан голым булевым литералом.
 *
 * Адрес, `--base`, разбор и шапка без гарантии — общий прогон по
 * файлам (`file_survey.ts`); здесь — что меряется в файле и как это
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
import {
  type Deep,
  type Flag,
  type Long,
  MAX_DEPTH,
  MAX_LENGTH,
} from "./shape.ts";
import { readShape } from "./shape_reading.ts";
import { block, renderSurvey } from "./survey_text.ts";

const line = z.number().int().positive();

const longSchema = z.object({
  line,
  name: z.string(),
  length: z.number().int().positive(),
});

const deepSchema = z.object({
  line,
  name: z.string(),
  depth: z.number().int().positive(),
});

const flagSchema = z.object({
  line,
  call: z.string(),
  argument: z.number().int().positive(),
});

const fileSchema = z.object({
  path: z.string(),
  long: partSchema(longSchema),
  deep: partSchema(deepSchema),
  flags: partSchema(flagSchema),
});

const resultSchema = surveySchema(fileSchema);

/** Ответ `mpu code shape`: по разделу на репозиторий. */
export type ShapeResult = z.infer<typeof resultSchema>;

type FileSection = z.infer<typeof fileSchema>;

export const codeShapeCommand = defineCommand({
  path: ["code", "shape"],
  keys: {
    address: {
      input: "addresses",
      why: "вход-список: ключ в единственном числе, повторяется",
    },
  },
  summary: "на приёмке: какие функции длинные, глубокие и где флаг true/false",
  usage: "mpu code shape address: АДРЕС... [base: REF] [limit: N]",
  help: `Спрашивают на приёмке и рецензии диффа: какие функции файла
длиннее ${MAX_LENGTH} строк, глубже ${MAX_DEPTH} уровней вложенности и где
флаг поведения передан голым true/false. Лучше грепа: греп не видит
ни длины функции, ни глубины, а булев литерал в ассерте теста от
флага поведения не отличает.

${ADDRESS_HELP}

  base: REF   только записи, у которых хоть одна строка функции (у
              флага — вызова) изменена против merge-base REF HEAD в
              рабочем дереве (файл вне базы — целиком)
${LIMIT_HELP}

Функция — объявление, метод, стрелка, функциональное выражение.
Разделов у файла три, пределы включительные (ровно ${MAX_LENGTH} и ${MAX_DEPTH} — норма):
«длинные» — от строки { тела до строки } больше ${MAX_LENGTH} строк (у
стрелки-выражения — от => до конца); вложенная функция входит в длину
внешней. «глубокие» — цепочка вложенных if/for/while/do/switch/try
длиннее ${MAX_DEPTH}; else и else if — уровень своего if, catch и
finally — своего try; тело вложенной функции считается с нуля своей
записью. «флаги» — литерал true/false позиционным аргументом вызова
с двумя аргументами и больше, аргумент: M — его номер с единицы.
Безымянная функция называется по переменной или свойству, иначе
(анонимная). После файлов — «не разрешено»: файлы с синтаксической
ошибкой и её причина.

Не меряются: обратный вызов describe и его форм через точку
(контейнер тестов; it и test внутри меряются), вызов с одним
аргументом (setOpen(true), toBe(true)), матчер в цепочке от
expect(…) (toHaveBeenCalledWith(54, true)).

${EXIT_HELP}`,
  examples: [
    "mpu code shape address: sl-front:src/app/checklist/ChecklistClient.tsx",
    "mpu code shape address: sl-front:src/app/checklist/ChecklistClient.tsx base: main",
  ],
  policy: "ro",
  argsSchema: surveyArgsSchema,
  forms: { addresses: { positional: "rest" } },
  resultSchema,
  run: (args, io) => runShape(args, io),
  render: renderShape,
});

/** Форма разобранного файла: три раздела, задетые фильтром строк. */
const SHAPE: Survey<FileSection> = {
  wording: {
    example: "mpu code shape ПУТЬ.ts",
    measured: "функции меряются",
  },
  measure: (ts, path, source, lines, limit) => {
    const shape = readShape(ts, source);
    return {
      path,
      long: limit.cut(shape.long(lines)),
      deep: limit.cut(shape.deep(lines)),
      flags: limit.cut(shape.flags(lines)),
    };
  },
};

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура репозиторием по правилу «подкаталог с `.git`» не
 * является.
 */
export async function runShape(
  args: SurveyArgs,
  io: Pick<CommandIo, "cwd">,
  deps: SurveyDeps = {},
): Promise<ShapeResult> {
  return await surveyFiles(args, io, SHAPE, deps);
}

/**
 * Текст ответа: по разделу на репозиторий, между ними пустая строка.
 * Внутри раздела — шапка без гарантии, файлы, «не разрешено».
 */
export function renderShape(result: ShapeResult): string {
  return renderSurvey(result, (file) => [
    file.path,
    ...block("длинные", file.long, longLine),
    ...block("глубокие", file.deep, deepLine),
    ...block("флаги", file.flags, flagLine),
  ]);
}

function longLine(item: Long): string {
  return `${item.line}  ${item.name}  строк: ${item.length}`;
}

function deepLine(item: Deep): string {
  return `${item.line}  ${item.name}  глубина: ${item.depth}`;
}

function flagLine(item: Flag): string {
  return `${item.line}  ${item.call}(…)  аргумент: ${item.argument}`;
}
