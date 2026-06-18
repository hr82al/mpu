# `mpu sheet batch-update` / `batch-get` — декларативный мини-язык для Google Sheets

Две команды для пакетной работы с Google-таблицами кратким декларативным языком:

- **`mpu sheet batch-update`** — ЗАПИСЬ. Весь скрипт компилируется в **один атомарный**
  Google Sheets `spreadsheets.batchUpdate` (много `requests` за раз). Полное покрытие всех ~70
  типов запросов batchUpdate.
- **`mpu sheet batch-get`** — ЧТЕНИЕ. Значения (все render-опции) + sheet-level структура
  (merges, условное форматирование, защищённые диапазоны, charts, named ranges, и т.д.).

Заменяет разовые JS-скрипты `mp-support-scripts/src/spreadsheets_*.js`: вместо правки кода —
одна команда с понятным скриптом.

## Как это работает

Команды ходят через Apps Script **webApp** (env `WB_PLUS_WEB_APP_URL`), а не напрямую в Google
REST API. Отличие webApp — только конверт транспорта (`{action, ssId, requestBody}`); **JSON
внутри** (`requests[]`, value-ranges) — **ровно как в [документации Google][gdoc]**. Поэтому в
generic-формах `@kind`/`raw` можно писать тела прямо по докам Google.

[gdoc]: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request

## Общий синтаксис

- **Одна инструкция на строку** (или через `;` вне кавычек и скобок). `#` — комментарий до конца
  строки (но `#` в hex-цвете `bg=#EA4335` — это не комментарий).
- Многострочные `py{ … }` и `@kind { json }`, а также формулы с `;` внутри `( … )` остаются цельными.
- Источник скрипта: `-e "…"` (повторяемо), `--from FILE` (`-` = stdin) или через pipe.
- `-s/--spreadsheet` — селектор таблицы (ID/URL/alias/client_id/подстрока названия).
- `-n/--sheet` — лист по умолчанию для диапазонов без префикса `'Tab'!`.
- `--dry-run` — скомпилировать и напечатать (`requests[]` или план чтения) без обращения к сети.

### Диапазоны и автопреобразование форматов

Что бы вы ни написали — компилятор нормализует к канонической форме Sheets API
(`GridRange` 0-based, полуоткрытый; `DimensionRange` для колонок/строк):

| Пишете | Значит |
|---|---|
| `H` или `8` | столбец H (буквы ≡ номер) |
| `H:J` или `8:10` | столбцы H..J |
| `H5` или `r5c8` | ячейка (A1 или R1C1) |
| `H2:J10` | прямоугольник |
| `H:H`, `H2:H` | весь столбец / столбец с строки 2 (без нижней границы) |
| `4:4`, `4` | вся строка |
| `'Чек-лист'!H2:H` | с явным листом (кавычки для имён с дефисом/пробелом) |

### Очевидные defaults (можно не писать)

| Контекст | Default (переопределяется флагом-словом) |
|---|---|
| лист для range без `!` | `-n/--sheet` |
| `set` значение | `=…`→формула; число→число; `true/false`→bool; иначе строка |
| value input | USER_ENTERED (флаг `-l/--literal` → RAW, как строки) |
| `cols/rows insert` | `inheritFromBefore=true` (иначе `inherit=after`) |
| `merge` | MERGE_ALL (иначе `rows`/`cols`) |
| `find-replace` | matchCase=false, текущий лист, `/…/`→regex (иначе `case`/`allsheets`) |
| `validate` | strict=false (иначе `strict`) |
| `get` | FORMATTED_VALUE, ROWS, SERIAL_NUMBER |
| `sheet add` | rows=1000, cols=26 |
| `border` | style=SOLID, color=#000 |

### Цвет и стиль

- Цвет: `#RRGGBB`, `#RGB`, `#AARRGGBB` (с alpha). Пример: `#EA4335`, `#fff`.
- Стиль-флаги (там, где есть формат — `label`, `style`, `cond`): `bold`, `italic`, `strike`,
  `underline`, `center`/`left`/`right`, `middle`/`top`/`bottom`, `wrap`/`clip`/`overflow`,
  `bg=#..`, `fg=#..`, `size=N`, `font=Arial`, `fmt="0.00%"` (числовой формат).

## `batch-update` — запись: глаголы

| Глагол | Пример | Sheets request |
|---|---|---|
| `set` | `set 'Чек-лист'!M2 = =LET(...)` · `set A1 "текст"` · `set A1 42` | updateCells |
| `label` | `label H1 "Заголовок" bg=#EA4335 fg=#fff bold center` | updateCells (значение+формат) |
| `style` | `style F5:F bg=#FCE8E6 fmt="0.00%"` | repeatCell |
| `clear` | `clear A2:A all` (или `values`/`formats`) | updateCells |
| `note` | `note H1 "комментарий"` | updateCells (note) |
| `cols insert` / `rows insert` | `cols insert H +10 inherit=before` | insertDimension |
| `cols delete` / `rows delete` | `cols delete M:Q` | deleteDimension |
| `cols move` / `rows move` | `cols move B:D after H` | moveDimension |
| `cols resize` | `cols resize H:J px=120` · `cols autosize H:J` | updateDimensionProperties / autoResizeDimensions |
| `append` | `append cols 5` · `append rows 100 on 'Чек-лист'` | appendDimension |
| `cols hide` / `cols show` | `cols hide M:Q` | updateDimensionProperties |
| `freeze` | `freeze rows=4 cols=7` (лист из `-n`) · `freeze 'Чек-лист' rows=4` | updateSheetProperties |
| `merge` / `unmerge` | `merge A1:C1` (или `rows`/`cols`) | mergeCells / unmergeCells |
| `border` | `border A1:C3 all style=SOLID color=#000` | updateBorders |
| `find-replace` | `find-replace /\bfoo\b/ bar formulas allsheets case` | findReplace |
| `validate` | `validate AJ18:AJ81 num>=0 strict msg="≥0"` | setDataValidation |
| `cond add` / `cond clear` | `cond add F5:F custom='=AND(E5<>"";G5="")' bg=#EA4335` · `cond clear 'Чек-лист' index=0` | add/deleteConditionalFormatRule |
| `protect` / `unprotect` | `protect 4:4 editors=a@b.com warn desc="..."` · `unprotect id=123` | add/deleteProtectedRange |
| `sheet add` | `sheet add "Новый" rows=1000 cols=26 index=2` | addSheet |
| `sheet delete` | `sheet delete 'Старый'` | deleteSheet |
| `sheet dup` | `sheet dup 'Чек-лист' as "Копия"` | duplicateSheet |
| `sheet rename` | `sheet rename 'Старый' "Новый"` | updateSheetProperties |
| `sheet tab` | `sheet tab 'Чек-лист' color=#EA4335` | updateSheetProperties (tabColor) |
| `name add` / `name del` | `name add my_rng 'Чек-лист'!A1:B2` · `name del id=123` | add/deleteNamedRange |
| `sort` | `sort A2:F by=A,C:desc` | sortRange |
| `autofill` | `autofill A2:A3 -> A2:A100` | autoFill |
| `copy` / `cut` | `copy A1:B2 -> C1 type=FORMAT` | copyPaste / cutPaste |
| `dedupe` / `trim` | `dedupe A2:F cols=A,B` · `trim A2:F` | deleteDuplicates / trimWhitespace |
| `group` / `ungroup` | `group cols H:M` | add/deleteDimensionGroup |

Условия (для `validate` / `cond add`): `num>=0` `num>0` `num<=N` `num<N` `num=N` `num!=N`,
`one-of=a,b,c`, `text-contains=…`, `text-eq=…`, `custom='=ФОРМУЛА'` (или просто `=ФОРМУЛА`),
`blank` / `not-blank`, `checkbox`.

### Generic: полное покрытие всех ~70 типов

Для типов, у которых нет своего глагола (charts, slicers, data sources, developer metadata,
tables, filter views, pasteData, textToColumns, banding-update, …):

- **`@kind { json }`** — любой Request по имени; тело — как в доках Google, плюс сахар:
  строки `@'Tab'!A1` → GridRange, `sheetId: "@'Tab'"` → id, ключи `*Color` со значением `#hex` → rgb.

  ```
  @autoResizeDimensions {"dimensions": {"sheetId": "@'Чек-лист'", "dimension": "COLUMNS", "startIndex": 7, "endIndex": 17}}
  @repeatCell {"range": "@'Чек-лист'!A1:B2", "cell": {"userEnteredFormat": {"backgroundColor": "#000000"}}, "fields": "userEnteredFormat"}
  ```

- **`raw { json }`** — дословный Request (без сахара), 100% покрытие, в т.ч. будущие типы:

  ```
  raw {"deleteSheet": {"sheetId": 12345}}
  ```

### Встроенный Python (флаг `--allow-py`)

Для логики: генерация повторяющихся запросов, вычисление индексов, чтение текущего состояния.
`py{ … }` — блок, исполняемый на этапе компиляции (operator-trusted exec, как `mpu run-js`).
Доступные функции: `emit("<инструкция>")`, `request({...})`, `col(i)`, `rgb("#..")`,
`gridrange("'T'!A1")`, `sheetid("T")`, `read("'T'!A1")`.

Пример (порт `setFormating.js` — три почти одинаковых cond-правила циклом):

```sh
mpu sheet batch-update --allow-py -s <ss> --from - <<'EOF'
py{
  for i in (5, 6, 7):
    others = [c for c in (5, 6, 7) if c != i]
    cond = '=AND(' + ';'.join(f'{col(c)}5<>""' for c in others) + f';{col(i)}5="")'
    emit(f'cond add \'Чек-лист\'!{col(i)}5:{col(i)} custom="{cond}" bg=#EA4335')
}
EOF
```

## `batch-get` — чтение

```
get RANGE [values|formula|unformatted|formatted] [rows|cols] [serial|datestr]
read [SHEET] ASPECT...
```

- **`get`** → `spreadsheets/values/batchGet`. Полный контроль render-опций и ориентации.
- **`read`** → `spreadsheets/get`, фильтр по листу/аспекту локально. Аспекты:
  `merges`, `cond` (conditionalFormats), `protected`, `charts`, `banding`, `filters`,
  `named`, `props`, `meta` (developerMetadata), `dims`.

```sh
mpu sheet batch-get -s <ss> -e "get 'Чек-лист'!A1:F formula"
mpu sheet batch-get -s <ss> -e "get 'Чек-лист'!H2:H unformatted cols"
mpu sheet batch-get -s <ss> -e "read 'Чек-лист' merges cond protected"
mpu sheet batch-get -s <ss> -e "read named"
```

**Ограничение:** per-cell аспекты (`formats`/`userformat`/`note`/`validation`/`hyperlink`/
`textruns`/`everything`) **недоступны** — текущий webApp не отдаёт `gridData` (игнорирует
`ranges`/`fields`/`includeGridData` у `spreadsheets/get`). Язык их распознаёт и даёт явную ошибку;
поддержка включится автоматически, если webApp доработают.

## Рецепты — порты `mp-support-scripts`

```sh
# insertColumns.js
mpu sheet batch-update -s <ss> -n 'Чек-лист' -e "cols insert H +10 inherit=before"
# deleteColumns.js
mpu sheet batch-update -s <ss> -n 'Чек-лист' -e "cols delete M:Q"
# setFormula.js
mpu sheet batch-update -s <ss> -e "set 'Чек-лист'!M2 = =LET(err; IFNA(ERROR.TYPE(B4);\"\"); IF(err=\"\";\"\";err))"
# findReplace.js
mpu sheet batch-update -s <ss> -e "find-replace /\bexpected_buyout_sum_rub\b/ expected_buyouts_sum_rub formulas allsheets case"
# setDataValidationSeasonPlan.js
mpu sheet batch-update -s <ss> -n 'План сезона' -e "validate AJ18:AJ81 num>=0 strict msg='Введите число ≥ 0'; validate AR18:AR81 num>=0 strict"
```

`copySheetPasteCell.js` и `setProtections.js` частично вне scope одного batchUpdate
(кросс-табличный `spreadsheetCopyTo` и диффующая защита — отдельные webApp-экшены); внутрибатчевые
части (`copy …`, `protect …`) выразимы.

## Тестирование и откат

- Юнит-тесты компилятора (offline): `tests/test_sheet_batch.py`.
- При проверке записи на боевой таблице — заводи временный лист, прогоняй там write-глаголы и
  удаляй его в конце (`sheet add "mpu_selftest_*"` → … → `sheet delete '…'`): таблица остаётся
  байт-в-байт. Где глагол обязан трогать существующие листы — snapshot через `batch-get` →
  применить → восстановить.

## Справка команд

`mpu sheet batch-update --help`, `mpu sheet batch-get --help`.
