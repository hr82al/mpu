/**
 * Токен доступа MCP-сервера: единственный секрет, который система
 * хранит на диске (`platform/mcp-server.md`). Ключом конфига он не
 * является — это отдельный файл конфиг-каталога с правами 0600.
 */

import type { CommandIo } from "../command/mod.ts";

/** Срез порта исполнения: токену нужны только чтение и запись файла. */
type TokenIo = Pick<CommandIo, "readAccessToken" | "writeAccessToken">;

/** Байт случайности в токене: 256 бит, как у ключа сессии. */
const TOKEN_BYTES = 32;

/**
 * Токен доступа; файла нет — создаётся и записывается. Создание при
 * первой надобности, а не при установке: пока сервер не поднимали,
 * секрета на диске нет вовсе.
 */
export async function ensureAccessToken(io: TokenIo): Promise<string> {
  const existing = await io.readAccessToken();
  if (existing !== undefined && existing !== "") return existing;
  const created = generateToken();
  await io.writeAccessToken(created);
  return created;
}

/** Случайный токен в виде base64url без выравнивания. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
