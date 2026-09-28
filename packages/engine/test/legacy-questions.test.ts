import { describe, expect, it } from "vitest";
import type { FormulaId } from "@fm/spec";
import { calculate, dataQuestions, FORMULAS, legacyChecks, sinkFormulas } from "../src";
import { legacyInput, loadCase } from "./support/cases";

describe("Вопросы к данным из предупреждений расчёта «как в исходном Excel»", () => {
  const c = loadCase("derbenevskaya_legacy");
  const input = legacyInput(c);
  const r = calculate(input, { horizonMonths: 121 }, [...sinkFormulas(Object.keys(FORMULAS) as FormulaId[]), "F.SALES.REVENUE_TOTAL", "F.SALES.WAVG_PRICE"]);
  const q = dataQuestions(c, input, { ...r, messages: [...r.messages, ...legacyChecks(c)] });
  const by = (no: number) => q.find((x) => x.no === no);

  it("19 пунктов с постоянными номерами 1–19, у каждого вопрос, пояснение, влияние и рекомендация", () => {
    expect(q.map((x) => x.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    for (const x of q) {
      expect(x.question.endsWith("?"), x.key).toBe(true);
      expect(x.explanation).toMatch(/\)\.$/);
      expect(x.recommendation.length).toBeGreaterThan(0);
    }
  });

  it("пояснение: что сравнили и где, чем грозит, что уточнить — 2–3 предложения, заканчивается вопросом", () => {
    for (const x of q) {
      expect(x.summary, x.key).toBe(`${x.compared} ${x.threat} ${x.question}`);
      expect(x.compared, x.key).toMatch(/\([^)]*(!|строк)[^)]*\)\.$/);
      expect(x.summary, x.key).not.toMatch(/[=×*]/);
    }
    expect(by(1)?.summary).toBe(
      "По плану продаж продаётся 10\u00a0888 м² ПСН, а построено 10\u00a0322 м² — на 566 м² больше (План продаж!E43:AM43, ТЭПы!C23). " +
        "Выручка в Excel может быть завышена на ~531,1 млн ₽. Сколько ПСН построено и откуда взят темп продаж?",
    );
    expect(by(6)?.threat).toBe("В денежном потоке Excel не хватает ~535,6 млн ₽ расходов, и он выглядит лучше, чем есть.");
    expect(by(12)?.compared).toMatch(/«2 кв 2032», а в CF1 раскрытие стоит вручную в 3 кв 2031 — на 9 мес\. раньше/);
  });

  it("№4 резерв: сложены площадь и ставка, расходы занижены на ~7,53 млрд", () => {
    expect(by(4)?.question).toBe("Правильно ли посчитан резерв на непредвиденные расходы?");
    expect(by(4)?.explanation).toMatch(/153\s882 \+ 48\s958 = 202\s840 ₽\. При умножении получается 7,53 млрд ₽ \(Бюджет!F42\)\./);
    expect(by(4)?.impact.text).toBe("расходы: занижены на ~7,53 млрд ₽");
    expect(by(4)?.impact.amount?.toNumber()).toBeCloseTo(202839.892889 - 153882 * 48957.892889, 0);
  });

  it("№12 эскроу: 3 кв 2031 или 2 кв 2032, сдвиг на 9 месяцев", () => {
    expect(by(12)?.question).toBe("Когда раскрывается эскроу — 3 кв 2031 или 2 кв 2032?");
    expect(by(12)?.impact.text).toMatch(/раскрываются на ~9 мес\. раньше срока в ТЭПах/);
  });

  it("№1 ПСН: продано на 566 м² больше запаса, выручка завышена", () => {
    expect(by(1)?.explanation).toMatch(/на 566 м² больше.*\(План продаж!E43:AM43, ТЭПы!C23\)\./);
    expect(by(1)?.recommendation).toBe(
      "По плану продаж ПСН получается 10\u00a0888 м², а построено 10\u00a0322 м². Лишние 566 м² в расчёт не попадают. Уменьшите темп или проверьте площадь ПСН в ТЭПах.",
    );
    expect(by(1)?.impact.amount?.gt(0)).toBe(true);
    expect(by(1)?.impact.text).toMatch(/^выручка: завышена на ~/);
  });

  it("№7 резерв 124,6% в CF ссылается на №4; №10 обрезка — поступления занижены на ~616,2 млн", () => {
    expect(by(7)?.explanation).toMatch(/124,6%.*см\. №4/);
    expect(by(10)?.impact.text).toBe("поступления: занижены на ~616,2 млн ₽");
    expect(by(6)?.impact.text).toBe("расходы в CF: занижены на ~535,6 млн ₽");
  });
});
