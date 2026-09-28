import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { getFormula, type FormulaId } from "@fm/spec";
import { calculate, Engine, FORMULAS, sinkFormulas, stepGroups, stepwise, type FormulaFn } from "../src";
import { legacyInput, loadCase } from "./support/cases";

const ZERO = new Decimal(0);
const sum = (xs: Decimal[] | undefined) => (xs ?? []).reduce((s, x) => s.add(x), ZERO);
const HORIZON = 121;

interface Fin {
  draw: Decimal[];
  interest: Decimal[];
  rate: Decimal[];
  fees: Decimal[];
  coverage: (Decimal | null)[];
  equity: { total: Decimal[]; gap: Decimal[] };
  need: { need: Decimal[]; cash_bop: (Decimal | null)[] };
  rep: { interest_paid: Decimal[]; principal: Decimal[]; from_escrow: Decimal[]; from_dkp: Decimal[] };
  debt: { debt: Decimal[]; accrued: Decimal[] };
}

function fin(r: ReturnType<typeof calculate>): Fin {
  const v = (id: FormulaId) => r.formulas[id]?.value as never;
  return {
    draw: v("F.FIN.DRAW"),
    interest: v("F.FIN.INTEREST"),
    rate: v("F.FIN.RATE"),
    fees: v("F.FIN.FEES"),
    coverage: v("F.ESC.COVERAGE"),
    equity: v("F.FIN.EQUITY_IN"),
    need: v("F.FIN.FUNDING_NEED"),
    rep: v("F.FIN.REPAYMENT"),
    debt: v("F.FIN.DEBT"),
  };
}

describe("ядро: формулы, связанные через прошлый месяц, считаются помесячно", () => {
  it("кредит и покрытие эскроу — одна группа; внутри месяца зависимости без циклов", () => {
    const groups = stepGroups(Object.keys(FORMULAS) as FormulaId[]);
    const g = groups.get("F.FIN.RATE") ?? [];
    expect(new Set(g)).toEqual(
      new Set(["F.FIN.FEES", "F.FIN.FUNDING_NEED", "F.FIN.EQUITY_IN", "F.FIN.DRAW", "F.FIN.RATE", "F.FIN.INTEREST", "F.FIN.REPAYMENT", "F.FIN.DEBT", "F.ESC.COVERAGE"]),
    );
    // порядок: каждая формула после всех своих зависимостей того же месяца
    g.forEach((id, i) => {
      const lag = new Set(getFormula(id).lag_depends_on ?? []);
      for (const d of getFormula(id).depends_on) if (g.includes(d as FormulaId) && !lag.has(d as FormulaId)) expect(g.indexOf(d as FormulaId), `${id} ← ${d}`).toBeLessThan(i);
    });
  });

  it("пример F.FIN.RATE: льготная 5%, ключевая 14% + спред 5,75 п.п., покрытие 0,4 → 13,85%", () => {
    const ex = getFormula("F.FIN.RATE").example as { input: { key: number; spread: number; pref: number; min: number; coverage: number }; output: number };
    const e = new Engine(
      {
        values: {
          "GEN.MODEL_START_DATE": "2025-12-31",
          "FIN.KEY_RATE_PATH": { current: ex.input.key },
          "FIN.RATE_BASE_SPREAD": ex.input.spread,
          "FIN.RATE_PREFERENTIAL": ex.input.pref,
          "FIN.RATE_MIN": ex.input.min,
        },
      },
      {
        "F.TIME.DATE": FORMULAS["F.TIME.DATE"] as FormulaFn,
        "F.ESC.COVERAGE": stepwise(function F_ESC_COVERAGE() {
          return new Decimal(ex.input.coverage);
        }),
        "F.FIN.RATE": FORMULAS["F.FIN.RATE"] as FormulaFn,
      },
      { horizonMonths: 2 },
    );
    const rate = e.run(["F.FIN.RATE"]).formulas["F.FIN.RATE"]?.value as Decimal[];
    // первый месяц: покрытия за прошлый месяц нет — базовая ставка; второй — по покрытию первого
    expect(rate[0]?.toNumber()).toBeCloseTo(ex.input.key + ex.input.spread, 12);
    expect(rate[1]?.toNumber()).toBeCloseTo(ex.output, 12);
  });
});

describe("FIN «как в исходном Excel»: кредит повторяет CF1 по кварталам (строки 98–132)", () => {
  const c = loadCase("derbenevskaya_legacy");
  const r = calculate(legacyInput(c), { horizonMonths: HORIZON }, sinkFormulas(Object.keys(FORMULAS) as FormulaId[]));
  const f = fin(r);
  const x = c.legacy_checks?.fin;
  // квартал q (столбец F + q) — месяц 3 × (q + 1) от начала модели 31.12.2025
  const q = (series: (Decimal | null)[], i: number) => series[3 * (i + 1)] ?? null;
  const cols = Array.from({ length: 40 }, (_, i) => i);

  it("нет ошибок расчёта в модуле FIN", () => {
    expect(r.messages.filter((m) => m.severity === "error" && /^F\.(FIN|ESC)\./.test(m.formulaId))).toEqual([]);
  });

  it("выдача, погашение, долг — строки 98, 100, 106 с точностью 1 руб", () => {
    for (const i of cols) {
      expect(q(f.draw, i)?.neg().sub(x!.draw_row98[i]!).abs().lt(1), `F98 +${i}`).toBe(true);
      expect(q(f.rep.principal, i)?.sub(x!.repaid_escrow_row100[i]!).abs().lt(1), `F100 +${i}`).toBe(true);
      expect(q(f.debt.debt, i)?.neg().sub(x!.debt_row106[i]!).abs().lt(1), `F106 +${i}`).toBe(true);
    }
  });

  it("проценты, «оплата» процентов, неоплаченные проценты — строки 107, 108, 110", () => {
    for (const i of cols) {
      expect(q(f.interest, i)?.neg().sub(x!.interest_row107[i]!).abs().lt(1), `F107 +${i}`).toBe(true);
      expect(q(f.rep.interest_paid, i)?.neg().sub(x!.pik_paid_row108[i]!).abs().lt(1), `F108 +${i}`).toBe(true);
      expect(q(f.debt.accrued, i)?.neg().sub(x!.accrued_row110[i]!).abs().lt(1), `F110 +${i}`).toBe(true);
    }
    expect(sum(f.interest).toNumber()).toBeCloseTo(14386244380.86, 1);
  });

  it("ставка и покрытие — строки 122 и 125, до 465,25% годовых", () => {
    for (const i of cols) {
      expect(q(f.rate, i)?.sub(x!.rate_row125[i]!).abs().lt(1e-6), `F125 +${i}`).toBe(true);
      // К1 квартала = MIN(покрытие прошлого квартала; 1), 0 — если покрытия нет
      const prev = i === 0 ? null : q(f.coverage, i - 1);
      const k1 = prev === null ? ZERO : Decimal.min(prev, 1);
      expect(k1.sub(x!.k1_row122[i]!).abs().lt(1e-6), `F122 +${i}`).toBe(true);
    }
    expect(q(f.rate, 1)?.toNumber()).toBeCloseTo(4.6524572, 6);
  });

  it("комиссия за выдачу 1% от Бюджет!F67 в первом квартале и собственные средства — строки 111, 132", () => {
    for (const i of cols) {
      expect(q(f.fees, i)?.sub(x!.fee_row111[i]!).abs().lt(1), `F111 +${i}`).toBe(true);
      expect(q(f.equity.total, i)?.sub(x!.equity_row132[i]!).abs().lt(1), `F132 +${i}`).toBe(true);
    }
  });

  it("поток по кредиту (строка 113): выдачи и погашения гасят друг друга, при раскрытии — +14,38 млрд", () => {
    for (const i of cols) {
      const flow = q(f.draw, i)!.neg().add(q(f.rep.principal, i)!).add(q(f.rep.interest_paid, i)!);
      expect(flow.sub(x!.flow_row113[i]!).abs().lt(1), `F113 +${i}`).toBe(true);
    }
  });

  it("эффективная ставка не считается, как в исходнике (#NUM!)", () => {
    expect(x!.eff_rate_D128).toBe("#NUM!");
    expect(r.formulas["F.FIN.EFFECTIVE_RATE"]?.value).toBeNull();
  });

  it("расхождения с исходником — предупреждения с постоянными ключами", () => {
    const keys = r.messages.filter((m) => m.severity === "warning" && m.key?.startsWith("LEGACY.FIN")).map((m) => m.key);
    expect(new Set(keys)).toEqual(
      new Set(["LEGACY.FIN_DRAW_REPAID", "LEGACY.FIN_INTEREST", "LEGACY.FIN_RATE", "LEGACY.FIN_PIK_SIGN", "LEGACY.FIN_EQUITY", "LEGACY.FIN_FEE_BASE", "LEGACY.FIN_EFF_RATE"]),
    );
  });
});

describe("FIN в расчёте сервиса: Дербеневская", () => {
  const c = loadCase("derbenevskaya_legacy");
  const base = legacyInput(c);
  const r = calculate(
    {
      mode: "normal",
      values: {
        ...base.values,
        "SALES.PRICE_MARKET_GROWTH": { by_year: { 2026: 0.05 }, after_last: "last" },
        "SALES.PRICE_STAGE_UPLIFT": [{ stage: "РНВ", uplift: 0.05 }],
        "TEP.PARKING_NORM": null,
        "TIME.ESCROW_RELEASE_LAG_M": 3,
      },
    },
    { horizonMonths: HORIZON },
    ["F.FIN.EFFECTIVE_RATE", "F.ESC.COVERAGE", "F.FIN.DEBT"],
  );
  const f = fin(r);
  const limit = r.formulas["F.FIN.LIMIT"]?.value as Decimal;
  const req = r.formulas["F.FIN.EQUITY_REQUIRED"]?.value as Decimal;

  it("считается без ошибок", () => {
    expect(r.messages.filter((m) => m.severity === "error" && /^F\.(FIN|ESC)\./.test(m.formulaId))).toEqual([]);
    expect(f.debt).toBeDefined();
  });

  it("долг и проценты на конец расчёта = 0 (приёмка этапа 5)", () => {
    expect(f.debt.debt.at(-1)?.abs().lt(1)).toBe(true);
    expect(f.debt.accrued.at(-1)?.abs().lt(1)).toBe(true);
    expect(sum(f.draw).sub(sum(f.rep.principal)).abs().lt(1)).toBe(true);
    expect(sum(f.interest).sub(sum(f.rep.interest_paid)).abs().lt(1)).toBe(true);
  });

  it("кредит выдаётся только после собственного участия и в пределах лимита", () => {
    const first = f.draw.findIndex((x) => x.gt(0));
    expect(first).toBeGreaterThan(0);
    expect(sum(f.equity.total.slice(0, first + 1)).gte(req.sub(1))).toBe(true);
    expect(sum(f.draw).lte(limit.add(1))).toBe(true);
  });

  it("выдача + взнос = потребность; свободные деньги не бывают отрицательными", () => {
    f.need.need.forEach((n, t) => expect(n.sub(f.draw[t]!).sub(f.equity.total[t]!).abs().lt(1e-6)).toBe(true));
    for (const c of f.need.cash_bop) expect(c!.gte(-1)).toBe(true);
  });

  it("ставка — между минимальной и базовой; покрытие считается, пока есть долг", () => {
    const max = f.rate.reduce((m, x) => Decimal.max(m, x), ZERO);
    expect(max.lte(0.14 + 0.0575 + 1e-12)).toBe(true);
    expect(f.coverage.some((x) => x !== null && x.gt(0))).toBe(true);
    expect(sum(f.interest).gt(0)).toBe(true);
  });

  it("полная стоимость кредита — годовая ставка выше средней ставки из-за комиссии", () => {
    const eff = r.formulas["F.FIN.EFFECTIVE_RATE"]?.value as Decimal;
    expect(eff.gt(0)).toBe(true);
    expect(eff.lt(0.3)).toBe(true);
  });
});
