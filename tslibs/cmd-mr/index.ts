/**
 * Семейство `mpu mr`: чтение (`docs/specs/mr-read.md`) и запись
 * (`docs/specs/mr-write.md`) merge request'ов GitLab.
 *
 * Наружу идут команды реестра и общее с `mpu glab-status` (пакет
 * `@mpu/cmd-glab`): доступ к GitLab по env-файлу (`gitlabAccess`, срез
 * порта `MrIo`) и перевод отказов `@mpu/gitlab` в ошибки команды с
 * подсказками (`asCommandError`) — одно знание домена на оба пакета.
 * Резолв адреса, формы тредов и построение позиции — внутренности
 * семейства. С переездом записи (`mr-write.md`) группа целиком на
 * маршруте `native`: в легаси её подкоманд не осталось.
 */

export { mrCommentCommand } from "./src/cmd_comment.ts";
export { mrCommentsCommand } from "./src/cmd_comments.ts";
export { mrCreateCommand } from "./src/cmd_create.ts";
export { mrDeleteCommand } from "./src/cmd_delete.ts";
export { mrDescribeCommand } from "./src/cmd_describe.ts";
export { mrDiffCommand } from "./src/cmd_diff.ts";
export { mrEditCommand } from "./src/cmd_edit.ts";
export { mrFilesCommand } from "./src/cmd_files.ts";
export { mrNoteCommand } from "./src/cmd_note.ts";
export { mrReplyCommand } from "./src/cmd_reply.ts";
export { mrResolveCommand, mrUnresolveCommand } from "./src/cmd_resolve.ts";
export { mrShowCommand } from "./src/cmd_show.ts";
export { mrViewCommand } from "./src/cmd_view.ts";
export { asCommandError, gitlabAccess, type MrIo } from "./src/common.ts";
