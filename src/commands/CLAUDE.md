# src/commands/CLAUDE.md

Конвенции для команд CLI. Применяются при создании/правке файлов в `src/commands/`.

## Help у команд — только через `describe()`

Никаких многострочных `.description([...].join('\n'))` с рукописным блоком `Examples:`. Единая точка форматирования:

```ts
import { describe } from '../lib/help.js';

describe(cmd, {
  summary: 'Short one-liner for parent listing',
  description: 'Full paragraph for the command\'s own --help',  // optional — fallback to summary
  examples: [
    { cmd: 'mpu foo', note: 'what it does' },
    { cmd: 'mpu foo --bar 1' },                                 // note optional
  ],
});
```

`describe()` делает `.summary()` + `.description()` + `addHelpText('after', ...)`. Пример-блок сам выравнивается. Расширять help — расширять `HelpSpec`, команды не трогать.

## Completion — `setProvider()` на команде

Каждая команда с позиционными аргументами или выбором значения должна декларировать provider:

```ts
import { setProvider } from '../lib/completion.js';

setProvider(cmd, ({ args, cursor }) => {
  if (args.length === 0) return candidatesForFirstPositional();
  if (args.length === 1) return candidatesForSecondPositional(args[0]);
  return [];
});
```

Фильтрация по префиксу — автоматически в runtime `complete()`. Subcommand-кандидаты, `--options`, `--help`/`-h` — тоже автоматически. Provider отвечает только за уникальные для команды значения.
