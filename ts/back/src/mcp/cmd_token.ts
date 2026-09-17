/** Команда `mpu mcp token` — заголовки авторизации MCP-сервера. */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { ensureAccessToken } from "./token.ts";

const resultSchema = z.object({
  headers: z.object({
    Authorization: z.string(),
  }),
});

export const mcpTokenCommand = defineCommand({
  path: ["mcp", "token"],
  summary: "заголовки авторизации для подключения к серверу",
  usage: "mpu mcp token",
  help: `Печатает одной строкой JSON-объект заголовков:
{"Authorization":"Bearer <токен доступа>"} — в той форме, которую
ожидает клиент, подставляющий заголовки при подключении.

Токена нет — он создаётся и записывается в отдельный файл
конфиг-каталога с правами 0600; ключом конфига токен не является и в
вывод «mpu config» не входит.

Единственная поверхность, печатающая токен. Тулом эта команда не
публикуется: закрытый список публикации её не содержит, иначе агент
прочитал бы секрет своим же вызовом.

Exit: 0 — успех; 1 — конфиг-каталог недоступен.

Пример: mpu mcp token`,
  // Мутирующая: при первом вызове создаёт файл токена.
  policy: "rw",
  // Вывод в журнал вызовов не пишется: он и есть токен, а тот не
  // появляется ни в каком другом выводе, логе, ответе сервера или
  // сообщении об ошибке (инвариант `platform/mcp-server.md`).
  logsOutput: false,
  argsSchema: z.object({}),
  resultSchema,
  run: async (_args, io) => ({
    headers: { Authorization: `Bearer ${await ensureAccessToken(io)}` },
  }),
  render: (result) => `${JSON.stringify(result.headers)}\n`,
});
