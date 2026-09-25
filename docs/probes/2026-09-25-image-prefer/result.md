# Замер синтаксиса `image sync`: конфликт по методу (2026-09-25)

Генерация — два агента sonnet (ru/en), кандидаты A (`base:`/`files:`, `получатель.имя`), B (`keepDb:`/`keepFiles:`), C (`получатель>>имя`); слепой замер — 10/10 у всех трёх (`raw.json`).

**Замер не различил кандидатов и мерил не то:** во всех эталонах адрес с хвостовым двоеточием (`kiten.cardsIn:`), а такое слово грамматика читает ключом (снято: `mpu log cmd: zzqq: limit: 1` → `у ключа cmd нет значения`, код 2). Спека 169 приняла A без хвостового `:` (`kiten.cardsIn`, `sheet.sum:with`) — это НЕ замерено.

Перемер 2026-09-25: слепой sonnet на правиле A «имя без последнего двоеточия» (`kiten.cardsIn`, `sheet.sum:with`, `kiten.ls.column`), 10 задач — **10/10**, ни одного хвостового `:`. Сомнения: порядок повторяемых ключей (по порядку упоминания); `kiten mine:` в задаче 5 записан `kiten.mine` — по спеке адрес называет и `mine`, и `mine:`, верно. Ответы:
```
1 ["ask","image","sync","dir:","/home/u/img"]
2 ["ask","image","sync","base:","kiten.cardsIn"]
3 ["ask","image","sync","files:","kiten.cardsIn"]
4 ["ask","image","sync","base:","kiten.cardsIn","files:","kiten.mine"]
5 ["ask","image","sync","files:","kiten.mine","files:","kiten.ready"]
6 ["ask","image","sync","dir:","/home/u/img","base:","telegram.digest","deletes:","allow"]
7 ["ask","image","sync","dry","files:","kiten.cardsIn"]
8 ["ask","image","sync","base:","kiten.cardsIn"]
9 ["ask","image","sync","files:","sheet.sum:with"]
10 ["ask","image","sync","dry","base:","kiten.ls.column"]
```
Решение: адрес `<звенья получателя через .>.<имя без последнего :>`, ключи `base:`/`files:` — принято замером.
