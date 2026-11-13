# Карта репозитория

Сначала эта карта, затем паспорт нужного модуля. Данные читать по ID (CLAUDE.md, «Работа агента»).

| Модуль | Что это | Файлы | Паспорт |
|---|---|---|---|
| Справочник | Источники, параметры, формулы, статьи бюджета, регионы, допущения компании | `data/*.yaml`, `packages/spec`, `scripts/` | [spec](passports/spec.md) |
| Ядро расчёта | Формулы по модулям, расчёт проекта, режимы, пояснения | `packages/engine/src/{modules,project,context,explain,lib}` | [engine](passports/engine.md) |
| Анализ участка | Ограничения, рынок, варианты, выбор лучшего | `engine/src/{analysis,site,zcyc}.ts`, `modules/{site,market,variant}.ts` | [site-analysis](passports/site-analysis.md) |
| Проект и хранение | Участок, файл проекта, справочник в браузере | `engine/src/{plot,projectfile,book,reference}.ts`, `apps/web/lib/{store,files}.ts` | [project](passports/project.md) |
| Исходный Excel | Карта ячеек, загрузка из Excel, регрессия | `legacy/`, `packages/excel-import`, `engine/src/legacy*.ts`, `tests/cases/` | [legacy](passports/legacy.md) |
| Выписка ЕГРН | XML, ZIP, PDF → поля участка | `packages/egrn-import`, `apps/web/lib/egrn.ts` | [egrn](passports/egrn.md) |
| Интерфейс | Экраны Next.js, без расчётов | `apps/web` | [web](passports/web.md) |

Стек: Next.js + TypeScript, монорепо pnpm, `decimal.js`, Vitest, GitHub Actions, Vercel (корень `apps/web`).

## Где какое правило (одно место на тему)

| Тема | Где |
|---|---|
| Запреты и порядок работы | `CLAUDE.md` |
| Метки происхождения, паспорт показателя | `docs/00_principles.md` §5 |
| Шкала и типы источников | `docs/00_principles.md` §2, §6 |
| Тексты интерфейса | `docs/06_zadanie.md` §7 |
| Порядок этапов, открытые вопросы | `docs/06_zadanie.md` §8, §10 |
| Отличия от исходного Excel | `docs/02_legacy_audit.md` |
| Целевая схема (БД, роли, выгрузка) | `docs/01_architecture.md` |
| Как проверять тексты | скилл `finmodel-cleanup-loop` |

## Сгенерированное — не читать и не коммитить

`packages/spec/src/generated`, `packages/excel-import/src/generated` — собираются при `pnpm install` и сборке. `docs/03–05` — в CI (файл `docs-03-05`), локально `python scripts/render_docs.py`.

Изменил модуль — обнови его паспорт в том же PR.
