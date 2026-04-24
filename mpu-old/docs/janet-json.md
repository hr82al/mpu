# JSON в Janet REPL

`mpu` встраивает JSON-библиотеку spork/json прямо в Janet-амальгамацию. Вся
работа с JSON идёт через две нативные C-функции без cgo-оверхеда — можно
читать/писать сотни мегабайт JSON на скорости ядра.

## Что даёт

| Форма | Описание |
|-------|----------|
| `(json/decode src)` | JSON-строка → Janet-значение |
| `(json/decode src keywords)` | ключи объектов становятся keywords (`:name`), а не строками |
| `(json/decode src keywords nulls)` | `null` → `:null` вместо `nil` (разбивает `nil` и отсутствие ключа) |
| `(json/encode x)` | Janet-значение → компактный JSON |
| `(json/encode x tab)` | Pretty-print с отступом `tab` (например `"  "`) |
| `(json/encode x tab newline buf)` | Аппендим в существующий buffer — zero-alloc стрим |

## Таблица соответствия типов

| JSON | Janet (decode) | Janet (encode принимает) |
|------|----------------|--------------------------|
| `null` | `nil` (или `:null` с флагом) | `nil` |
| `true`/`false` | `boolean` | `boolean` |
| число | `number` | `number` |
| строка | `string` | `string`, `keyword`, `symbol`, `buffer` |
| массив | `array` | `array`, `tuple` |
| объект | `table` | `table`, `struct` |

## Lisp-way: композиция через core

Главная идея — **не оборачивать JSON в собственную DSL**. Декодирование
возвращает обычный Janet-массив или таблицу, а значит вся стандартная
библиотека Janet работает напрямую: `get`, `get-in`, `put`, `put-in`,
`update`, `update-in`, `walk`, `postwalk`, `map`, `filter`, `reduce`,
`from-pairs`, `seq`, `->`, `->>`.

### Получение вложенных значений

```janet
# Threading → читается сверху вниз: декодируем, лезем вглубь.
(-> response-body
    json/decode
    (get-in ["users" 0 "name"]))

# С keyword-ключами (аккуратнее и быстрее на доступе):
(-> response-body
    (json/decode true)
    (get-in [:users 0 :name]))
```

### Преобразование списков

```janet
# Возвести в квадрат все элементы массива.
(->> "[1,2,3,4]"
     json/decode
     (map |(* $ $))
     json/encode)
# → "[1,4,9,16]"

# Отфильтровать объекты по полю.
(->> response-body
     json/decode
     (filter |(> ($ "score") 100))
     (map |($ "name")))
```

### Глубокая трансформация дерева

Для рекурсивной замены всех значений определённого типа — `postwalk`:

```janet
# Увеличить каждое число в дереве на 1.
(->> "{\"stats\":{\"views\":99,\"likes\":[10,20,30]}}"
     json/decode
     (postwalk |(if (number? $) (inc $) $))
     json/encode)
```

`postwalk` обходит структуру снизу вверх, `prewalk` — сверху вниз.

### Точечное обновление

```janet
# Immutable-style: put-in на копии.
(def orig (json/decode body))
(def patched (put-in (freeze orig) ["user" "name"] "turing"))

# Mutable-style: put-in прямо на исходнике.
(put-in (json/decode body) ["user" "name"] "turing")

# update-in с функцией.
(update-in obj ["counters" "hits"] inc)
```

### Выбор подмножества ключей

```janet
# Аналог select-keys из Clojure через from-pairs + seq.
(defn select-keys [tbl ks]
  (from-pairs (seq [k :in ks :when (has-key? tbl k)] [k (tbl k)])))

(-> body json/decode (select-keys ["id" "name" "email"]) json/encode)
```

### Свой DSL из примитивов

Для повторяющихся паттернов — макросы. Пример: аналог `get-or`:

```janet
(defmacro get-or [obj path default]
  ~(or (get-in ,obj ,path) ,default))

(get-or (json/decode body) ["user" "role"] "guest")
```

## Pretty-print

```janet
(json/encode data "  ")
# {
#   "name": "ada",
#   "age": 36
# }

# Табуляция вместо пробелов:
(json/encode data "\t")

# Аппенд в существующий buffer (zero-alloc):
(def out @"")
(json/encode data "  " "\n" out)
```

## Типичный сценарий в mpu

```janet
# Прочитать cache-ответ PG, достать список, отдать обратно JSON-строкой.
(defn top-clients [raw]
  (->> raw
       json/decode
       (filter |(= ($ "active") true))
       (sort-by |($ "revenue"))
       (take 10)
       (map |(select-keys $ ["id" "name" "revenue"]))
       (json/encode)))
```

## Производительность

Замеры на Intel i5-8350U (`go test ./internal/janet -bench BenchmarkJSON`):

| Операция | Время | Аллокации |
|----------|-------|-----------|
| `json/decode` малый объект (~40 B) | ~8 μs | 2 |
| `json/encode` малый объект | ~7 μs | 2 |
| Round-trip 400 B JSON | ~19 μs | 2 |

Бóльшая часть времени — разбор самой Janet-формы (`eval`). Для горячих
циклов внутри Janet (без повторной компиляции) чистый JSON-парсинг
измеряется в долях микросекунды на килобайт.

- `(json/encode x tab newline buf)` с переиспользуемым буфером избегает
  аллокаций для hot loops.
- cgo-пересечений нет: `json/decode` и `json/encode` — нативные C-функции
  в том же бинарнике.

## Ошибки

`json/decode` на невалидном JSON бросает Janet-error со смыслом. В Janet
ловим стандартно через `try`/`protect`:

```janet
(try
  (json/decode maybe-json)
  ([err] (printf "parse error: %s" err) nil))

# или:
(def [ok? val] (protect (json/decode maybe-json)))
(if ok? val nil)
```

## Почему не своя DSL-обёртка

Канонический Lisp-подход: маленькие компонуемые примитивы + стандартная
библиотека. JSON-декод возвращает те же `table`/`array`, что и любой
Janet-код, поэтому `get-in`, `postwalk`, `map`, `->` работают без адаптеров.
Добавлять `json/get-in` поверх core `get-in` — это реинвентинг велосипеда
и фрагментация API.
