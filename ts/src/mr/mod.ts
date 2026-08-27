/**
 * Семейство `mpu mr`: чтение (`docs/specs/mr-read.md`) и запись
 * (`docs/specs/mr-write.md`) merge request'ов GitLab.
 *
 * Наружу идут только команды реестра: доступ, резолв адреса, формы
 * тредов и построение позиции — внутренности семейства. С переездом
 * записи (`mr-write.md`) группа целиком на маршруте `native`: в легаси
 * её подкоманд не осталось.
 */

export { mrCommentCommand } from "./cmd_comment.ts";
export { mrCommentsCommand } from "./cmd_comments.ts";
export { mrCreateCommand } from "./cmd_create.ts";
export { mrDeleteCommand } from "./cmd_delete.ts";
export { mrDescribeCommand } from "./cmd_describe.ts";
export { mrDiffCommand } from "./cmd_diff.ts";
export { mrEditCommand } from "./cmd_edit.ts";
export { mrFilesCommand } from "./cmd_files.ts";
export { mrNoteCommand } from "./cmd_note.ts";
export { mrReplyCommand } from "./cmd_reply.ts";
export { mrResolveCommand, mrUnresolveCommand } from "./cmd_resolve.ts";
export { mrShowCommand } from "./cmd_show.ts";
export { mrViewCommand } from "./cmd_view.ts";
