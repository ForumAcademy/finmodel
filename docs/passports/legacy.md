# Паспорт: исходный Excel

**Что это.** Исходная финмодель «Кальк Саевой привязка КОД.xlsx», полная карта её ячеек, загрузка готовой модели из Excel и регрессия по Дербеневской. Разбор отличий — `docs/02_legacy_audit.md`.

## Файлы

| Файл | Что в нём |
|---|---|
| `legacy/legacy_values_map.csv` | Каждое значение исходника → ID параметра и вердикт (в том числе `remove`) |
| `legacy/legacy_formulas_map.csv` | Формулы исходника → ID формул |
| `legacy/legacy_text_cells.csv` | Текстовые ячейки |
| `scripts/build_legacy_map.py` | Пересборка карты; код выхода 0 — всё сопоставлено |
| `scripts/build_legacy_case.py` | Пересборка `tests/cases/derbenevskaya_legacy.yaml` |
| `tests/cases/derbenevskaya_legacy.yaml` | Вводные исходника, итоги исходника, `reconciliation_targets` |
| `packages/engine/src/legacy.ts` | Кейс → `ProjectInput` для расчёта «как в исходном Excel» |
| `packages/engine/src/legacy-checks.ts` | Расхождения внутри исходника, видимые по его ячейкам, — предупреждения с постоянным ключом |
| `packages/engine/src/legacy-questions.ts` | Предупреждения → вопросы к авторам исходника: что смутило, влияние в рублях, рекомендация |
| `packages/excel-import` | Загрузка финмодели из Excel по карте (`scripts/build-map.mjs` → `src/generated/legacy-map.json`) |

## Как устроено

- Расчёт «как в исходном Excel» (`mode: legacy`) воспроизводит исходник один в один; расхождения выводятся предупреждениями, а не исправляются.
- Проект из кейса — `legacyProject` в `src/project.ts`; пара режимов — `modePair`.
- CSV читать только по ячейке или ID (`grep -n`), целиком не читать.

## Ловушки

- Ни одно значение исходника не удалять молча (CLAUDE.md, правило 5).
- Список ожидаемых расхождений с суммами согласуется с пользователем до фиксации в тесте (правило 10).
- Итоги исходника — для сверки, не эталон: многие неверны (`docs/02`).

## Тесты

`packages/engine/test/`: `tep.derbenevskaya`, `legacy-checks`, `legacy-questions`, `project`; `packages/excel-import/test/`.
