# Паспорт: выписка ЕГРН (packages/egrn-import)

**Что это.** Распознавание выписки ЕГРН об участке в поля проекта. Что не нашлось, финансист вводит вручную со ссылкой на документ.

## Файлы

| Файл | Что в нём |
|---|---|
| `packages/egrn-import/src/index.ts` | `parseEgrnXml` (электронная выписка Росреестра, в том числе ZIP с подписью), `parseEgrnText` (текст PDF), `readEgrnFile`, `foundSummary` |
| `packages/egrn-import/src/xml.ts` | Небольшой разбор XML без зависимостей |
| `apps/web/lib/egrn.ts` | Чтение файла в браузере: текст PDF достаёт pdf.js, поля распознаёт пакет |
| `packages/egrn-import/test/fixtures/` | Пример выписки в XML и текст PDF |

## Как устроено

- Результат — поля участка для `plot.ts` с меткой «из источника» и ссылкой на документ проекта.
- Сам документ хранится в проекте (проектный источник), в `data/sources.yaml` — только его тип.

## Тесты

`packages/egrn-import/test/egrn.test.ts`.
