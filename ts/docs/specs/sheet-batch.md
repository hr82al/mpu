# mpu sheet batch-update / batch-get

Статус: к реализации (заморожена 2026-08-27; язык записи покрыт голденом
всех глаголов, формы ответов и границы сняты живьём)

Пара подкоманд — один файл осознанно: общая грамматика мини-языка и общая порция реализации.

## Назначение

Пакетные операции над Google-таблицей декларативным мини-языком: скрипт компилируется целиком
и уходит одним вызовом — `batch-update` (запись: весь скрипт → один `spreadsheets/batchUpdate`,
атомарно), `batch-get` (чтение: значения ячеек и структура листов). Подкоманды семейства
`mpu sheet`; транспорт — `platform/webapp-http.md`.

## CLI-контракт

`mpu sheet batch-update [-e ВЫРАЖЕНИЕ]… [--from FILE|-] [-s ТАБЛИЦА] [-n ЛИСТ] [--dry-run]
[-l/--literal]`; `batch-get` — те же флаги без `-l`. Скрипт = все
`-e` + содержимое `--from` (`-` — stdin), склейка через `\n`; нет ни `-e`, ни `--from`, stdin
не терминал → скрипт из stdin. Итог пуст (после trim) → exit 2: `mpu sheet batch-update:
пустой скрипт (-e / --from / stdin)`; у batch-get — свой префикс. `-n/--sheet` — лист по
умолчанию для диапазонов без `'Лист'!`. Резолв таблицы (`-s` → конфиг
`sheet.default`; ID/URL/алиас/client_id/подстрока названия) — общий для семейства, тексты —
`sheet.md`; его ошибка → exit 2. Примеры (обезличены): `batch-update -s <ss-id> -n
'Лист1' -e "cols insert H +10; label H1 'Итого' bg=#EA4335 bold; set H2 = =SUM(A2:G2)"` и
`batch-get -s <ss-id> -e "get 'Лист1'!A1:F formula"`.

**Инструкции.** Разделители — перевод строки или `;` на глубине скобок 0 вне кавычек;
`(`/`[`/`{` наращивают глубину (лишняя закрывающая не уводит ниже 0) — `py{…}`, `@kind {…}`,
формулы с `;` внутри `(…)` цельны; `#` на границе токена на глубине 0 — комментарий до конца
строки; пустые инструкции отбрасываются **до** нумерации, поэтому `a;;b` и
`a;\n;b` одинаково дают `b` строкой 2 (`bg=#fff` — не комментарий); кавычки `'`/`"` защищают `;`, `#` и переводы строк, `\x`
в кавычках — экранированный символ; пустые инструкции отбрасываются. Токены — по пробелам;
кавычки защищают пробелы и остаются в токене (снимаются, где ожидается строка); токен, начатый
`{`, — цельный сбалансированный `{…}`-блок. Глагол — первые два токена, если такая пара есть
в языке, иначе первый; неизвестный → `неизвестный глагол '<токен>'`.

**Диапазон (RANGE).** Спан: `A1`, `A1:C3`, `H` (весь столбец), `4` (вся строка), `H:J`, `2:5`,
открытые границы (`H2:H`), `r5c8` (R1C1, только одиночная ячейка, регистр любой). Лист:
`'Имя'!СПАН` (`''` — литеральный апостроф; без кавычек — имя без пробелов). Токен без `!`:
задан `-n` → спан на этом листе; не задан → спан-подобный токен (`:` либо
`^[A-Za-z]{1,3}\d*$`/`^\d+$`) — ошибка «нет имени листа», иначе весь лист с таким именем;
`'Имя'!` (пустой спан) — весь лист. Наружу — GridRange `{sheetId, startRowIndex, endRowIndex,
startColumnIndex, endColumnIndex}`, 0-based полуоткрытый, открытая граница опускается. DIM (в
`cols`/`rows`-инструкциях): `H`/`H:J` (буквы — только столбцы) или `8`/`8:10` (1-based
номера — обе размерности), опционально `'Лист'!` → DimensionRange `{sheetId, dimension:
COLUMNS|ROWS, startIndex, endIndex}`; буква для строк → `плохой индекс 'H' для ROWS`.
Неизвестный лист где угодно → `лист 'Имя' не найден в таблице`.

**Инструкции записи → запрос** (точные формы запросов — golden `update-all-verbs`);
`set`/`label`/`note` пишут только верхне-левую ячейку RANGE (открытая граница → 0),
остальные — весь диапазон:

| Инструкция | Запрос Sheets API |
| --- | --- |
| `set RANGE = ХВОСТ` / `set RANGE ЗНАЧЕНИЕ` | updateCells `userEnteredValue`; хвост после первого `=` — дословно, без токенизации (формула: `set A1 = =SUM(B:B)`) |
| `label RANGE ТЕКСТ [стиль-флаги]` · `note RANGE ТЕКСТ` | updateCells (label: текст всегда строка, fields — значение + затронутые пути стиля; note: fields `note`) |
| `style RANGE ФЛАГИ` | repeatCell; без флагов — ошибка |
| `clear RANGE [values\|formats\|all]` | updateCells; fields `userEnteredValue` / `userEnteredFormat` / оба + `note`; дефолт values |
| `merge RANGE [all\|rows\|cols]` · `unmerge RANGE` | mergeCells MERGE_ALL/ROWS/COLUMNS · unmergeCells |
| `border RANGE [all\|top\|bottom\|left\|right\|inner\|around] [style=ИМЯ] [color=#hex]` | updateBorders; дефолты all/SOLID/чёрный; all = 4 стороны + внутренние, around — без внутренних |
| `sort RANGE by=COL[:desc][,…]` · `dedupe RANGE [cols=A,B]` · `trim RANGE` | sortRange (без `by=` — ошибка) · deleteDuplicates · trimWhitespace |
| `validate RANGE УСЛОВИЕ [strict] [msg=Т] [showdrop]` | setDataValidation |
| `cond add RANGE УСЛОВИЕ [стиль-флаги]` · `cond clear ЛИСТ [index=N]` | addConditionalFormatRule (index 0; дефолт-фон `#ffeb3b`) · deleteConditionalFormatRule (дефолт 0) |
| `protect RANGE [editors=a@x.test,…] [warn] [desc=Т]` · `unprotect id=N` | addProtectedRange · deleteProtectedRange |
| `autofill СПАН -> DEST` | autoFill `{range: DEST, useAlternateSeries: false}`; первый спан в запрос не входит |
| `copy SRC -> DEST [type=X]` · `cut SRC -> DEST` | copyPaste `PASTE_<X>` (дефолт NORMAL) · cutPaste |
| `cols\|rows insert DIM [+N] [inherit[=before\|after]]` | insertDimension; `+N` — количество; inheritFromBefore true, кроме after |
| `cols\|rows delete DIM` · `… move DIM after ИНДЕКС` · `… autosize DIM` | deleteDimension · moveDimension (вставка после) · autoResizeDimensions |
| `cols\|rows resize DIM px=N` · `… hide DIM` · `… show DIM` | updateDimensionProperties: pixelSize (без `px=` — ошибка) / hiddenByUser true/false |
| `append cols\|rows N [on ЛИСТ]` | appendDimension; лист — `on` либо `-n`, иначе ошибка |
| `group cols\|rows DIM` · `ungroup cols\|rows DIM` | addDimensionGroup · deleteDimensionGroup |
| `freeze [ЛИСТ] rows=N cols=M` | updateSheetProperties frozenRow/ColumnCount; лист — первый токен, не начатый `rows=`/`cols=`, иначе `-n`; без листа или без ключей — ошибка |
| `sheet add ИМЯ [rows=N] [cols=N] [index=I]` | addSheet; дефолт 1000×26 |
| `sheet delete ЛИСТ` · `sheet rename СТАРОЕ НОВОЕ` · `sheet dup ЛИСТ [as ИМЯ]` · `sheet tab ЛИСТ color=#hex` | deleteSheet · updateSheetProperties title · duplicateSheet · updateSheetProperties tabColor |
| `find-replace НАЙТИ ЗАМЕНА [regex] [case] [formulas] [allsheets \| RANGE-с-!]` | findReplace; `/…/` — регэксп; область: RANGE / allsheets / `-n` (см. отклонения); searchByRegex — истина при слове `regex` **или** при обрамлении шаблона
слэшами `/…/` (слэши снимаются); в остальных случаях `false` (замеры
2026-08-28: `find-replace старое новое` → `false`, `find-replace /ab.*/ x` →
`true` с `find: ab.*`) |
| `name add ИМЯ RANGE` · `name del id=ID` | addNamedRange · deleteNamedRange |

**Значения.** Токен в кавычках → строка (кавычки сняты); `true`/`false` (регистр любой) →
boolValue; парсится числом → numberValue; начинается с `=` → formulaValue; иначе stringValue;
`-l/--literal` — всегда stringValue. **Стиль-флаги**: словарные `bold italic strike underline`,
`left center right`, `top middle bottom`, `wrap clip overflow`; ключевые `bg=#hex fg=#hex
size=N font=Имя fmt=ШАБЛОН` (тип PERCENT при `%`, DATE при y/m/d в любом регистре, иначе
NUMBER) → `userEnteredFormat` + fields-маска затронутых путей без дублей; неизвестный флаг →
`неизвестный стиль-флаг '<т>'`. Цвет: `#RGB`/`#RRGGBB`/`#AARRGGBB` →
`{red,green,blue[,alpha]}` в долях 0..1, иначе `плохой цвет: '<текст>'`. **Условия**: `num>=N
num>N num<=N num<N num=N num!=N` → NUMBER_GREATER_THAN_EQ/GREATER/LESS_THAN_EQ/LESS/EQ/NOT_EQ;
`custom==Ф` и голый `=Ф` → CUSTOM_FORMULA; `one-of=a,b,c` → ONE_OF_LIST (по запятой,
экранирования нет); `text-contains=Т` / `text-eq=Т`; `blank`/`not-blank`; `checkbox`/`bool` →
BOOLEAN; форма `{type, values: [{userEnteredValue}…]}`; иначе `непонятное условие '<токен>'`.

**Generic.** `@kind { json }` → запрос `{kind: json}` с сахаром по всему объекту: строка
`@RANGE` → GridRange, `"sheetId": "@'Лист'"` → id листа, ключ `*Color` со строкой `#…` → цвет;
`raw { json }` — дословно, без сахара. Не-объект → `ожидался JSON-объект`; невалидный JSON →
`плохой JSON: <детали>`. **py**: `py{ … }` — выполнение Python-тела при компиляции **не поддерживается**: отказ `py{…} не поддерживается; собери инструкции сами
и передай готовым скриптом`, exit 2, до сети. Флага `--allow-py` не существует —
неизвестная опция; функции
`emit("инструкция")` (компилируется рекурсивно), `request({…})` (запрос как есть), `col(i)`,
`rgb("#…")`, `sheetid("Лист")`, `gridrange("RANGE")`, `read("RANGE")` — значения диапазона
отдельным `values/batchGet` при компиляции; запросы `request` — раньше `emit`-инструкций
блока. Судьба в новой реализации — открытый вопрос.

**batch-get.** Глаголы только `get` и `read` (иначе `read-глагол должен быть get|read,
получено '<глагол>'`); все инструкции сливаются в один план (общие диапазоны + опции,
последнее слово побеждает). `get [RANGE|СЛОВО]…` — значения; слова: `values`/`formatted` →
FORMATTED_VALUE (дефолт), `formula` → FORMULA, `unformatted` → UNFORMATTED_VALUE;
`rows`/`cols` → majorDimension (дефолт ROWS); `serial` (дефолт) / `datestr` →
dateTimeRenderOption SERIAL_NUMBER / FORMATTED_STRING; диапазон без `!` при `-n` префиксуется
(имя кавычится, если не из букв/цифр/`_`), без `-n` уходит как есть — существование листов на
компиляции не проверяется. `read [АСПЕКТ|ЛИСТ]…` — структура; аспекты `merges cond protected
charts banding filters named props meta dims` (дедуп), прочий токен — имя листа-фильтра;
per-cell аспект (`formats userformat note validation hyperlink textruns everything value
effective userentered formatted`) → ошибка `аспект '<имя>' (per-cell) недоступен: webApp не
отдаёт gridData. Доступны: banding, charts, cond, dims, filters, merges, meta, named, props,
protected`. Ни диапазонов, ни аспектов/листов → `пустой скрипт чтения`.

## Ввод/вывод

stdout — данные; stderr — `mpu sheet batch-update: <причина>` / `mpu sheet batch-get:
<причина>`, без трейсбеков; ошибка компиляции batch-update — с префиксом `строка N: ` (N —
порядковый номер инструкции). Exit: 0 — успех (включая `нет операций` и `--dry-run`); 2 —
ошибки скрипта/ввода/резолва `-s`; 1 — ошибки webapp/сети. JSON — indent 2, unicode как есть:
- batch-update `--dry-run`: `{"requests": […]}`; пустая компиляция (скрипт из комментариев) →
  строка `нет операций` вместо JSON — и без `--dry-run` тоже, до всякой отправки;
- batch-update: ответ `spreadsheets/batchUpdate` как есть (`{"spreadsheetId": …, "replies": […]}`);
- batch-get `--dry-run`: `{"values": <поля вызова values/batchGet>|null, "meta": {"aspects", "sheets"}|null}` (оба ключа всегда);
- batch-get: `{"spreadsheetId": …}` + `valueRanges: […]` (если были диапазоны) + `meta` (если
  были аспекты/листы): `named` → верхнеуровневый `namedRanges`; остальные — `sheets:
  [{"title", <пути>…}]` по карте merges→merges, cond→conditionalFormats,
  protected→protectedRanges, charts→charts, banding→bandedRanges,
  filters→basicFilter+filterViews, props→properties, meta→developerMetadata,
  dims→rowGroups+columnGroups; фильтр листов по точному имени (пустой список = все); путь
  копируется, только если есть в ответе.

## Побочные эффекты

batch-update: 1× `spreadsheets/get {ssId}` — свежие метаданные (`sheets[].properties`:
sheetId, title; обновляет строку метаданных локального кэша) до компиляции, в том числе при
`--dry-run`; затем (не dry-run, непустая компиляция) ровно 1× `spreadsheets/batchUpdate {ssId,
requestBody: {"requests": […]}}` — весь скрипт одним вызовом, без чанкования и
переупорядочивания; при успехе — инвалидация whole-tab кэша каждого листа, чей sheetId
встречается в отправленных запросах (контракт кэша — `platform/webapp-http.md`). `read()` в `py{}`
— дополнительный `spreadsheets/values/batchGet` на каждый вызов, вне атомарности. batch-get:
до двух независимых вызовов — `spreadsheets/values/batchGet {ssId, ranges, majorDimension,
valueRenderOption, dateTimeRenderOption}` и/или `spreadsheets/get {ssId}`; кэш не читается и
не пишется; `--dry-run` batch-get — ноль сети (конверт вызова и ретраи — `platform/webapp-http.md`).

## Конфигурация

Env `WB_PLUS_WEB_APP_URL` — `platform/webapp-http.md`; резолв `-s`, конфиг-ключ
`sheet.default` — `sheet.md`. Собственных ключей у мини-языка нет.

## Инварианты

- Компиляция детерминирована и без сети (исключение — `read()` в `py{}`): один скрипт + одни
  метаданные → те же запросы; порядок запросов = порядок инструкций.
- Непустая компиляция → ровно один вызов `spreadsheets/batchUpdate`; координаты наружу всегда
  0-based полуоткрытые.
- `set`/`label`/`note` меняют ровно одну ячейку; остальные range-инструкции — весь диапазон.
- batch-get не мутирует ни таблицу, ни локальный кэш; повторный вызов всегда идёт в сеть.
- Инвалидация кэша — только при успешном batchUpdate и только для листов из отправленных
  запросов; `--dry-run` не вызывает batchUpdate и не инвалидирует (но резолвит `-s` и метаданные).

## Граничные случаи и ошибки

- Лист, создаваемый тем же скриптом, на компиляции **не существует**: имена
  листов резолвятся по текущему состоянию таблицы до отправки, поэтому
  `sheet add Врем; sheet rename Врем Врем2` отбивается на второй инструкции —
  `mpu sheet batch-update: строка 2: лист 'Врем' не найден в таблице`, exit 2,
  до сети. Ссылаться на новый лист можно только следующим вызовом (снято живьём
  2026-08-27).

- `set 'Лист1'!A1:C3 5` → пишется только A1; `set 'Лист1'!H:H 5` → открытые границы → 0 → H1.
- `''!A1` (пустое имя в кавычках) → «нет имени листа»; `'Лист ''X'''!A1` → лист `Лист 'X'`.
- `cols insert 8` ≡ `cols insert H`; значение `one-of` с запятой внутри невыразимо
  (ограничение языка).
- `py{pass}` → отказ `py{…} не поддерживается; собери инструкции сами и передай
  готовым скриптом`, exit 2, тело не выполняется; batch-get не проверяет
  листы/диапазоны на компиляции — ошибка придёт из webapp, exit 1.
- Скрипт из одних комментариев/пустых строк: batch-update → `нет операций`, exit 0;
  batch-get → `пустой скрипт чтения`, exit 2.

## Golden-примеры

Сняты 2026-08-27 с рабочей версии на служебной тестовой таблице; идентификатор
заменён синтетическим, клиентских данных нет.

- `fixtures/sheet-batch/update-all-verbs.script` — скрипт из 34 инструкций,
  покрывающий весь язык записи, и `…/update-all-verbs.stdout` — вывод
  `batch-update --dry-run -n Sheet1` на нём: 34 запроса, 28 различных видов
  (`updateCells`, `repeatCell`, `mergeCells`, `updateBorders`, `sortRange`,
  `deleteDuplicates`, `trimWhitespace`, `setDataValidation`,
  `addConditionalFormatRule`, `deleteConditionalFormatRule`,
  `addProtectedRange`, `autoFill`, `copyPaste`, `cutPaste`, `insertDimension`,
  `deleteDimension`, `moveDimension`, `autoResizeDimensions`,
  `updateDimensionProperties`, `appendDimension`, `addDimensionGroup`,
  `deleteDimensionGroup`, `updateSheetProperties`, `addSheet`,
  `duplicateSheet`, `findReplace`, `addNamedRange`). Это эталон таблицы
  «Инструкция → запрос»: расходится реализация с ним — расходится с контрактом.
- `fixtures/sheet-batch/get-values-and-meta.stdout` — `batch-get -n Sheet1 -e
  "get A1:B2 formula; read Sheet1 merges props"`: единый ответ с `valueRanges`
  (плюс `majorDimension`) и `meta.sheets`.
- `fixtures/sheet-batch/err-sheet-created-in-same-script.stderr` — отказ
  компиляции на листе, который создаётся тем же скриптом (см. «Граничные
  случаи»).

Ответ живого `batch-update` — `{"replies": [{}], "spreadsheetId": "<ss_id>"}`,
по элементу на запрос; у `updateCells` элемент пустой.

## Известные отклонения

- **fix** — ошибки вне разбора мини-языка в оригинале — необработанный трейсбек, exit 1:
  несуществующий файл `--from`, невалидный A1-спан, нечисловое значение
  `+N`/`px=`/`size=`/`rows=`/`index=`, спан без листа на RANGE-пути (английское «Range … has
  no tab name…»). Правильно — обычная ошибка скрипта (`строка N: <причина>`; для спана без
  листа — `нет имени листа в '<токен>' и не задан -n/--sheet`), exit 2.
- **fix** — неопознанное слово-опция в инструкции молча игнорируется (`merge A1:B2 колонки` →
  MERGE_ALL; `cond add … center`; `inherit=befor`); правильно — ошибка компиляции.
- **fix** — `find-replace` без области и без `-n` молча получает `allSheets: true` (замена по
  всей таблице); правильно — ошибка «нет области — задай -n, allsheets или 'Лист'!span».
- **fix** — при опечатке во втором слове двухсловного глагола ошибка называет только первый
  токен (`неизвестный глагол 'cols'`); правильно — называть пару целиком для первых слов
  `cols/rows/sheet/cond/name`.
- **fix** — `cols|rows insert` без слова `inherit` шлёт
  `inheritFromBefore: true` при любом индексе, и на вставке в самое начало
  (`startIndex: 0`) Google отвергает **всю пачку**: `range.startIndex must not
  be 0 if inheritFromBefore is true` (наблюдено живьём 2026-08-28 на служебной
  таблице). Правильно — `inheritFromBefore` истинно по умолчанию и при
  `inherit`/`inherit=before`, ложно при `inherit=after`, и **всегда ложно при
  `startIndex: 0`**: слева от первой полосы наследовать нечего, а падение всей
  пачки из-за одной инструкции хуже, чем ненаследованный формат.

## Открытые вопросы

- `py{…}` — компайл-тайм выполнение Python; аналога в новой реализации нет.
  Решено 2026-08-27: **не поддерживать**, `py{…}` отбивается понятной ошибкой
  ввода. Основание — журнал вызовов: за всё время ни одного вызова с `py{`
  (проверено по всему журналу, не по окну). Генерация скриптов остаётся на
  вызывающем.
- Форма ответа `batchUpdate` снята живьём 2026-08-27 на черновой таблице:
  `{"replies": [{}], "spreadsheetId": "<ss_id>"}` — по одному элементу на
  запрос, у `updateCells` элемент пустой. Одиночный `sheet set` отвечает
  иначе: `{"value": "data batchUpdate succesfull"}` — опечатка в слове
  принадлежит webapp и воспроизводится дословно (`preserve`).
