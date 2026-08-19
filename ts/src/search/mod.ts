/**
 * Команда `mpu search` (`docs/specs/search.md`): поиск по локальному
 * кэшу и доступ к web-клиенту 10X. Публичная поверхность модуля — этот
 * файл.
 */

export {
  runSearch,
  type SearchArgs,
  searchCommand,
  type SearchIo,
  type SearchOptions,
  type SearchResult,
} from "./cmd_search.ts";
