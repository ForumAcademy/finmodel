# Паспорт: интерфейс (apps/web)

**Что это.** Next.js (App Router). **Расчётов нет**: экраны вызывают ядро и показывают результат; любая арифметика — в ядре с тестом. Тексты — по `docs/06_zadanie.md` §7.

## Адреса

| Адрес | Экран | Компонент |
|---|---|---|
| `/` | Проекты | `components/ProjectsScreen.tsx`, `NewProjectModal.tsx` |
| `/projects/[id]?sec=…&tab=…` | Проект: Участок, Ограничения, Рынок, Варианты, Сравнение, Документы | `ProjectScreen.tsx`, `AnalysisScreens.tsx`, `MapPicker.tsx` |
| `/reference/[section]` | Справочник: стандартные значения, нормативы регионов, формулы, источники, где взять данные, история версий | `ReferenceScreen.tsx`, `lib/reference-sections.ts` |
| `/api/zcyc` | Кривая ОФЗ через сервис, если браузер не пускает на биржу | `app/api/zcyc/route.ts` |

## Прочее

- `components/ui.tsx` — метка происхождения (`OriginTag`), поля экспертного значения, окна, уведомления, пометка «Где взять данные» (`WhereToFind`).
- «Где взять данные» обязательна у каждого поля ручного ввода участка и ограничений: тексты — `where` в `PLOT_FIELDS` (`engine/src/plot.ts`), `hint` в `SITE_FIELDS` и `ZOUIT_WHERE` (`engine/src/site.ts`). Показывается в окне изменения поля, при создании проекта и под пустым полем. Раздел Справочника «Где взять данные» (что даёт источник, как получить и внести) — `engine/src/where.ts`, ссылки — из `data/sources.yaml`.
- `lib/store.ts`, `lib/files.ts` — хранение в браузере и файлы ([project](project.md)); `lib/egrn.ts` — выписка ЕГРН ([egrn](egrn.md)); `lib/zcyc.ts` — кривая ОФЗ.
- Сборка: `pnpm build` (перед `next build` собирается справочник `packages/spec`). Vercel: корень `apps/web`.
- Целевые вкладки проекта (ТЭП, Бюджет, План продаж, … Дашборд) — `docs/06_zadanie.md` §6.

## Проверка

После изменения экранов или текстов — быстрая проверка скиллом `finmodel-cleanup-loop`.
