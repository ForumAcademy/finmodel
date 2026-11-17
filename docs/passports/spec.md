# Паспорт: справочник (data и packages/spec)

**Что это.** Единственный источник правды: источники, параметры, формулы, статьи бюджета, регионы, стандартные значения компании. Код ссылается только на ID отсюда. Принципы и шкала источников — `docs/00_principles.md` §1–§3, §6.

## Файлы

| Файл | Что в нём |
|---|---|
| `data/sources.yaml` | Источники: уровень 1–5, `scope: global` (URL, дата проверки `accessed`, `verified`) или `project` (тип проектного документа) |
| `data/parameters.yaml` | Параметры: `unit`, `kind`, `scope`, `source_ids`, `basis`, `status`, `legacy` |
| `data/formulas.yaml` | Формулы: `expr`, `depends_on`, `lag_depends_on`, `rationale`, `rejected`, `source_ids`, `example` |
| `data/capex_items.yaml` | Статьи бюджета: ставка, база, правило графика |
| `data/regions.yaml` | 89 субъектов РФ, региональные нормативы и ставки (`null` — не заполнено); у Москвы также `demolition` (ставка сноса) и `social_obligations` (зоны районов, места на 1000 жителей, стоимость места) |
| `data/msk_upks_2024_quarters.csv` | Москва, распоряжение ДГИ № 214856, таблица 1: средний УПКС по кадастровому кварталу для 11 групп видов использования, страница акта. Распознано со скана (значение — только если совпало в нескольких прочтениях); подключается из `regions.yaml` (`cadastral_value_estimate.quarters_file`), таблица 2 по районам — там же (`districts`) |
| `data/msk_rent_273pp_quarters.csv` | Москва, 273-ПП, приложение 8: по кадастровому кварталу — стоимостные показатели Pi по назначениям и коэффициент ренты k. Подключается из `regions.yaml` (`land_rent.first_year.quarters_file`); в справочник при сборке попадают Pi «жильё», «временное проживание» и k |
| `data/company_assumptions.yaml` | Справочник допущений компании по версиям |
| `packages/spec/src/schemas.ts` | zod-схемы, строгие: неизвестное поле в YAML — ошибка |
| `packages/spec/src/checks.ts` | Перекрёстные проверки (повторяют `validate_spec.py`, чтобы сборка не зависела от Python) |
| `packages/spec/src/index.ts` | `spec`, `getParameter`, `getFormula`, `getSource`, `formulaFnName` и типы |
| `packages/spec/scripts/build-spec.ts` | `data/*.yaml` → `src/generated/spec.json` и `ids.ts` (union-типы ID) |
| `scripts/validate_spec.py` | Полная проверка реестров, графа формул, карты исходного Excel, примеров формул |
| `scripts/render_docs.py` | Каталоги `docs/03–05` |

## Как работать

- Искать по ID: `grep -n "id: F.FIN.RATE" data/formulas.yaml`, читать ±40 строк. Файлы целиком не читать (≈700 КБ).
- После любого изменения `data/` — `pnpm spec:build` (он же запускается при `pnpm install`), затем `python scripts/validate_spec.py`.
- Ссылка на несуществующий ID в TypeScript — ошибка компиляции (union-типы в `ids.ts`).
- `src/generated/` не хранится в git и не читается: смотреть исходные YAML.

## Ловушки

- Новый параметр — со всеми полями (CLAUDE.md, правило 3); новый общий источник уровня 1–3 — только с URL на первичный документ (правило 4).
- Неизвестное значение — `null` и `status: needs_verification`, не выдумывать (правило 7).
- Изменение логики — сначала `formulas.yaml` (`expr`, `rationale`, `rejected`, `example`), потом код.

## Тесты

`packages/spec/test/`: схемы и проверки, ID, актуальность `generated`.
