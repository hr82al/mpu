/**
 * Платформенный резолв селектора (`docs/specs/platform/selector.md`):
 * единая для всех native-команд трактовка строки адресации. Публичная
 * поверхность модуля — этот файл.
 */

export { type Candidate, formatCandidates } from "./candidate.ts";
export type { CacheReader } from "./cache.ts";
export { SelectorError } from "./error.ts";
export {
  isServerAddressLike,
  isSidLike,
  requireSingleClient,
  type Resolved,
  type ResolveOptions,
  resolveSelector,
  searchCandidates,
  type SelectorSources,
  type ServerAddresses,
} from "./resolve.ts";
