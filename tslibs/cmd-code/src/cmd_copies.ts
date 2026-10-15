/**
 * Команда `mpu code copies` (`specs/code-copies.md`): какие куски кода в
 * файле скопированы и какая константа файла преобразуется по месту не
 * один раз.
 *
 * Адрес, `--base`, разбор и шапка без гарантии — общий прогон по
 * файлам (`file_survey.ts`); здесь — что считается в файле и как это
 * печатается.
 */

import { z } from "zod";
import { type CommandIo, defineCommand } from "@mpu/command";
import {
  type Conversion,
  type Copy,
  MIN_CONVERSIONS,
  MIN_COPIES,
  MAX_TEXT,
  MIN_TOKENS,
} from "./copies.ts";
import { readCopies } from "./copy_reading.ts";
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
import { block, renderSurvey } from "./survey_text.ts";

export { DEFAULT_LIMIT } from "./file_survey.ts";

/** Поля группы, общие у обоих разделов: число вхождений и их строки. */
const groupFields = {
  count: z.number().int().positive(),
  lines: z.array(z.number().int().positive()),
};

const copySchema = z.object({ text: z.string(), ...groupFields });

const conversionSchema = z.object({ call: z.string(), ...groupFields });

const fileSchema = z.object({
  path: z.string(),
  copies: partSchema(copySchema),
  conversions: partSchema(conversionSchema),
});

const resultSchema = surveySchema(fileSchema);

/** Ответ `mpu code copies`: по разделу на репозиторий. */
export type CopiesResult = z.infer<typeof resultSchema>;

type FileSection = z.infer<typeof fileSchema>;

export const codeCopiesCommand = defineCommand({
  path: ["code", "copies"],
  keys: {
    address: {
      input: "addresses",
      why: "вход-список: ключ в единственном числе, повторяется",
    },
  },
  summary:
    "на приёмке: какие куски кода в файле скопированы и какая константа преобразуется не раз",
  usage: "mpu code copies address: АДРЕС... [base: REF] [limit: N]",
  help: `Спрашивают на приёмке и рецензии файла, прежде всего теста: какие
куски кода в нём скопированы и какую константу файла по месту
преобразуют не один раз (правило «одно знание — одно место»).
Лучше грепа: сводит многострочную запись с однострочной, не печатает
кусок, вложенный в копию, и не путает String(input) двух функций с
одной величиной. Литералы видит code literals, копии из имён — эта
команда.

${ADDRESS_HELP}

  base: REF   только записи, у которых хоть одно вхождение стоит на
              строке, изменённой против merge-base REF HEAD в рабочем
              дереве (файл вне базы — целиком); запись печатается со
              всеми вхождениями
${LIMIT_HELP}

Фрагмент — вызов, new, объект, массив, стрелка, функциональное
выражение, объявление const/let/var целиком. Равенство — по лексемам:
пробелы, переводы строк и комментарии не считаются, лишняя запятая в
конце — считается. Разделов у файла два. «копии» — равные фрагменты,
не меньше ${MIN_COPIES} вхождений и не меньше ${MIN_TOKENS} лексем: ТЕКСТ ×K и
строки (текст первого вхождения, до ${MAX_TEXT} знаков). Кусок с тем же
числом вхождений внутри более длинной копии отдельно не печатается, с
большим — печатается. «преобразования» — Number/String/Boolean/BigInt
ровно с одним аргументом-именем константы верхнего уровня файла
(const/let/var, import), не меньше ${MIN_CONVERSIONS} раз. После файлов —
«не разрешено»: файлы с синтаксической ошибкой и её причина.

Не считаются: вызовы describe/it/test и их форм через точку и функция,
переданная им аргументом (контейнеры тестов; код внутри считается),
копии между файлами, преобразование литерала, выражения, свойства
(String(a.b)), параметра и имени, перекрытого в функции.

${EXIT_HELP}`,
  examples: [
    "mpu code copies address: ozon:apps/front/src/features/checklist/ui/ChecklistClient.spec.tsx",
    "mpu code copies address: ozon:apps/front/src/features/checklist/ui/ChecklistClient.spec.tsx base: main",
  ],
  policy: "ro",
  argsSchema: surveyArgsSchema,
  forms: { addresses: { positional: "rest" } },
  resultSchema,
  run: (args, io) => runCopies(args, io),
  render: renderCopies,
});

/**
 * Копии разобранного файла. Запись печатается целиком или не
 * печатается: фильтр спрашивают о всех её вхождениях.
 */
const COPIES: Survey<FileSection> = {
  wording: {
    example: "mpu code copies ПУТЬ.spec.tsx",
    measured: "копии ищутся",
  },
  measure: (ts, path, source, lines, limit) => {
    const copies = readCopies(ts, source);
    return {
      path,
      copies: limit.cut(copies.copies(lines)),
      conversions: limit.cut(copies.conversions(lines)),
    };
  },
};

/**
 * Прогон команды. Вынесен из объявления ради подмены рабочей области:
 * дерево-фикстура репозиторием по правилу «подкаталог с `.git`» не
 * является.
 */
export async function runCopies(
  args: SurveyArgs,
  io: Pick<CommandIo, "cwd">,
  deps: SurveyDeps = {},
): Promise<CopiesResult> {
  return await surveyFiles(args, io, COPIES, deps);
}

/**
 * Текст ответа: по разделу на репозиторий, между ними пустая строка.
 * Внутри раздела — шапка без гарантии, файлы, «не разрешено».
 */
export function renderCopies(result: CopiesResult): string {
  return renderSurvey(result, (file) => [
    file.path,
    ...block("копии", file.copies, copyLine),
    ...block("преобразования", file.conversions, conversionLine),
  ]);
}

function copyLine(copy: Copy): string {
  return groupLine(copy.text, copy);
}

function conversionLine(conversion: Conversion): string {
  return groupLine(conversion.call, conversion);
}

/** Запись обоих разделов: `ТЕКСТ ×K  строки A, B, …`. */
function groupLine(
  shown: string,
  { count, lines }: { readonly count: number; readonly lines: number[] },
): string {
  return `${shown} ×${count}  строки ${lines.join(", ")}`;
}
