/**
 * Аргументы вызова (`docs/specs/call.md`, «CLI-контракт»): общая часть
 * всех получателей и ключ адреса — `path:` у Ozon, `url:` у WB. Какой из
 * двух читать, знает адрес получателя (`address.ts`).
 */

import { z } from "zod";

/** Предел ожидания по умолчанию и наибольший, секунды. */
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 300;

/** Клиент — первым ключом; за ним кабинет и адрес — порядок справки. */
const selector = z
  .string({ error: "нужен target: клиент" })
  .describe("клиент: client_id, имя или часть, dev:<client_id>");

const tail = {
  body: z.string().optional().describe("JSON-текст тела"),
  method: z.enum(["GET", "POST"]).optional().describe("метод запроса"),
  timeout: z
    .number()
    .int()
    .optional()
    .describe(
      `предел ожидания ответа, секунды: 1…${MAX_TIMEOUT_S}, по умолчанию ` +
        DEFAULT_TIMEOUT_S,
    ),
  dry: z
    .boolean()
    .default(false)
    .describe("напечатать запрос с ключом *** — без сети"),
};

/** Аргументы получателя с заданным хостом: адрес — путь ручки. */
export const pathArgs = z.object({
  selector,
  cabinet: z
    .string()
    .optional()
    .describe(
      "кабинет: у Ozon — Client-Id; один кабинет у клиента — можно опустить",
    ),
  path: z
    .string({ error: "нужен path: путь ручки, начинается с /" })
    .describe("путь ручки, начинается с /"),
  ...tail,
});

/** Аргументы получателя без заданного хоста: адрес — полный URL. */
export const urlArgs = z.object({
  selector,
  cabinet: z
    .string()
    .optional()
    .describe(
      "кабинет: sid кабинета WB; один кабинет у клиента — можно опустить",
    ),
  url: z
    .string({ error: "нужен url: полный адрес https://…" })
    .describe("полный адрес ручки с запросом: https://<хост><путь>"),
  ...tail,
});

/** Разобранные аргументы вызова; ключ адреса — один из двух. */
export type CallArgs = Omit<z.infer<typeof pathArgs>, "path"> & {
  readonly path?: string;
  readonly url?: string;
};
