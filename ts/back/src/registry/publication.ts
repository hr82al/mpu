/**
 * Закрытый список публикации тулов MCP (`platform/mcp-server.md`): какие
 * команды реестра становятся тулами и с какой политикой. Список читается
 * из канала спецификаций напрямую — копия рядом с кодом дала бы второй
 * источник истины (`docs/CLAUDE.md`); ядро сервера (`@mpu/cmd-mcp`)
 * получает его объектом, потому что перечисляет он команды приложения.
 */

import { Publication } from "@mpu/cmd-mcp";
import toolPolicies from "../../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};

/** Список канала объектом `Publication`. */
export const PUBLICATION = new Publication(toolPolicies);
