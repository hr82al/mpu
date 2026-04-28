# src/lib/CLAUDE.md

Конвенции для общих библиотек. Применяются при создании/правке файлов в `src/lib/`.

## Config и Cache используются из любого места через default-инстансы

```ts
import { getDefaultCache } from './lib/cache.js';

const cache = getDefaultCache();
const data = await cache.wrapAsync('k', fetchData, { ttl: 600 });    // cache-aside
cache.wrap('cheap', compute);                                         // sync variant
cache.set('k', v, { ttl: Infinity });                                 // never expires
cache.set('k', v, { ttl: 0 });                                        // no-op (don't cache this call)
// без ttl → берётся config.get('cache.ttl')
```

Новые ключи конфига — добавлять в `CONFIG_REGISTRY` в `src/lib/config.ts`. Они сразу получают тип-проверку, валидацию, автодополнение в `mpu config <TAB>`, и видимы в `mpu config` (list).
