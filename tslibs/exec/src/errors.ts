/**
 * Отказ транспорта удалённого исполнения (`platform/exec-transport.md`):
 * рукопожатие WebSocket, сокет, ответ Portainer. Свой класс, а не класс
 * потребителя: библиотека слоя команд не знает, и код выхода назначает тот,
 * кто ловит (`platform/tslibs-exec.md`).
 */

/** Сбой внешней системы на пути команды до контейнера и обратно. */
export class ExecError extends Error {
  override name = "ExecError";
}
