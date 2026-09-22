# С описанием грамматики (sonnet), оценка
1 ✓ ["kiten","card","id:","123"]
2 ✗ ["kiten","card","id:","123","end","md"]            — нет do
3 ✗ ["sql-ro","target:","Ромашка","sql:","…","end","json"] — нет do
4 ✓ ["ask","sql","target:","sl-1","sql:","update t set x = 1"]
5 ✓ ["kiten","comment","help"]
6 ✓ ["ask","kiten","comment","id:","55","text:","--","end"]
7 ✗ ["kiten","ls","end","csv"]                         — нет do
8 ✓ ["process","dry","target:","54"]
9 — ["ask","do","kiten","ls","end","kiten","comment","text:","готово"] — нужны 159/160, в описании их нет
10 ✗ ["logs","target:","sl-1","portainer","since:","1h"] — вариант после ключа
11 ? ["search","query:","json"]                         — словаря ключей нет
Итог: 5/10 (9 не в счёт); три из пяти промахов — один: `end` без `do`.
