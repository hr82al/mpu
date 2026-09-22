# Описание v2 (sonnet), оценка
1 ✓ kiten card id: 123
2 ✓ kiten card id: 123 end md            (неявный do)
3 ✓ sql-ro target: Ромашка sql: -- "select …" end json   (`--` лишний, но верный)
4 ✓ ask sql target: sl-1 sql: -- "update …"
5 ✓ kiten comment help
6 ✗ kiten comment id: 55 text: -- end   — нет ask (отказ с готовой строкой поймает)
7 ✓ kiten ls end csv
8 ✓ process dry target: 54
9 ✓ kiten ls limit: 5 end table
10 ✓ logs portainer target: sl-1 since: 1h   (сначала хотел ключи раньше варианта — поправился по правилу)
11 ✓ search query: json
Итог: 10/11 с первой попытки (v1 — 5/10).
Сомнения: нужен ли `--` для многословного значения; `help kiten comment` или `kiten comment help`.
