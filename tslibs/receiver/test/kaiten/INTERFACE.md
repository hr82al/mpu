# Интерфейс kaiten

Собран из `about` командой `bun run interface`; руками не правится.

## Kaiten — `kaiten`

Доска Kaiten.

### card

эффект: read · возвращает: Card

```text
kaiten card — Карточка по номеру.
Зови, чтобы работать с одной карточкой.
ключи: id — целое, обязательный — номер карточки
пример: kaiten card id: 123 → Card 123
```

### login

эффект: send · возвращает: data

```text
kaiten login — Войти на доску.
Зови, когда доска отвечает отказом входа.
ключи: user — строка, обязательный — почта; password — строка, обязательный — пароль
пример: kaiten login user: a@b.c password: *** → {"user":"a@b.c"}
```

## Card — `kaiten card`

Карточка Kaiten.

### show

эффект: read · возвращает: data

```text
kaiten card show — Номер и заголовок карточки.
Зови, чтобы узнать, о чём карточка.
ошибка: нет карточки — номер не найден на доске
пример: kaiten card show → {"id":123,"title":"Сборка"}
```

### comment

эффект: write · возвращает: data

```text
kaiten card comment — Оставить комментарий.
Зови, когда нужно ответить в карточке.
ключи: text — строка, обязательный — текст комментария
пример: kaiten card comment text: ок → {"ok":true}
```

### checklist

эффект: read · возвращает: Checklist

```text
kaiten card checklist — Чек-лист карточки.
Зови, чтобы работать с пунктами.
пример: kaiten card checklist → Checklist 123
```

## Checklist — `kaiten card checklist`

Чек-лист карточки.

### items

эффект: read · возвращает: data

```text
kaiten card checklist items — Пункты чек-листа.
Зови, чтобы узнать, что осталось сделать.
пример: kaiten card checklist items → [{"text":"собрать","done":false}]
```

### check

эффект: write · возвращает: data

```text
kaiten card checklist check — Отметить пункт сделанным.
Зови, когда пункт выполнен.
ключи: item — целое, обязательный — номер пункта с 0
пример: kaiten card checklist check item: 0 → {"ok":true}
```

### tick

эффект: write · возвращает: data

```text
kaiten card checklist tick — Отметить пункт (прежнее имя check).
Не зови: устарел, зови check.
ключи: item — целое, обязательный — номер пункта с 0
устарел с 0.1.0 — зови check
```
