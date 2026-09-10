# Спеки новых команд по итогам сессии «Чек-лист Ozon» + реестр нереализованных спек + статусы

Журнал прогресса. После сжатия контекста или `/clear` — прочитать этот файл и `git log`, продолжить
с первой незакрытой строки; закрытые не переделывать. Коммит — вместе со спекой, прямо в `main`,
пути поимённо; выгрузка после каждого коммита.

| # | Работа | Файл | Статус |
| --- | --- | --- | --- |
| 1 | `mpu mr matrix` | `ts/docs/specs/mr-matrix.md` | закоммичена `c0f7ef0` |
| 2 | `mpu wt doctor` | `ts/docs/specs/wt-doctor.md` | готова (черновик спеки), коммит ниже |
| 3 | `mpu registry verify` / `publish --verify-lock` | `ts/docs/specs/registry-publish.md` | не начата |
| 4 | `mpu gate style` | `ts/docs/specs/gate-style.md` | не начата |
| 5 | `mpu gate private` | `ts/docs/specs/gate-private.md` | не начата |
| 6 | `mpu stand check --shell` | `ts/docs/specs/stand-check.md` | не начата |
| 7 | Статусы всех спек `ts/docs/specs/*.md` приведены к `--help` | строки «Статус:» | не начата |
| 8 | Реестр нереализованных спек | `docs/specs-backlog.md` | не начата |

Правило read/write — навык разделения read-only/мутирующих команд: читающая форма → allow,
пишущая → ask, различие — в имени команды или подкоманды.
