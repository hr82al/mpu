# tests/CLAUDE.md

Конвенции для тестов. Применяются при создании/правке файлов в `tests/`.

## Тесты — `@jest/globals` + `:memory:` SQLite

```ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { openDb } from '../src/lib/db.js';

beforeEach(() => {
  db = openDb(':memory:');  // изолированная БД на каждый тест
});
```

Не полагаться на `os.homedir()` в тестах — в Jest VM-контексте `HOME` нестабилен. Использовать `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `MPU_DB` для подмены путей.

Описания `describe`/`it` — по-русски, префикс `Проверяет: ...` (конвенция из соседнего mp-монорепо).
