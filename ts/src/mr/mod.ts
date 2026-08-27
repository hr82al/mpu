/**
 * Read-подкоманды `mpu mr` (`docs/specs/mr-read.md`): чтение merge
 * request'ов GitLab.
 *
 * Наружу идут только команды реестра: доступ, резолв адреса и формы
 * тредов — внутренности семейства. Пишущие подкоманды (`comment`,
 * `reply`, `resolve`, `note`, `describe`, `create`, `edit`) остаются на
 * маршруте `legacy` — группа смешанная по построению.
 */

export { mrCommentsCommand } from "./cmd_comments.ts";
export { mrDiffCommand } from "./cmd_diff.ts";
export { mrFilesCommand } from "./cmd_files.ts";
export { mrShowCommand } from "./cmd_show.ts";
export { mrViewCommand } from "./cmd_view.ts";
