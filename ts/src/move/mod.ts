/**
 * Переносы клиента между серверами фермы (`move-client.md`,
 * `move-client-back.md`).
 *
 * Наружу идут только команды. Журнал ходов и постановка задачи —
 * внутренности семейства: журнал общий у обеих команд, и второго
 * источника направления быть не должно.
 */

export { moveClientCommand } from "./cmd_move_client.ts";
export { moveClientBackCommand } from "./cmd_move_client_back.ts";
