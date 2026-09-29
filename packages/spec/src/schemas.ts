/**
 * zod-схемы справочника data/*.yaml. Схемы строгие (`strict`): неизвестное поле в YAML —
 * ошибка сборки, чтобы опечатка в имени поля не терялась молча.
 *
 * Файл не импортирует других модулей пакета: его подключает генератор scripts/build-spec.ts.
 */
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата в формате ГГГГ-ММ-ДД");
const idList = z.array(z.string().min(1));

// ---------- sources.yaml ----------

export const SOURCE_LEVELS = [1, 2, 3, 4, 5] as const;
export const SOURCE_SCOPES = ["global", "project"] as const;

export const sourceSchema = z
  .object({
    id: z.string().regex(/^S_[A-Z0-9_]+$/, "ID источника: S_ВЕРХНИЙ_РЕГИСТР"),
    level: z.union(SOURCE_LEVELS.map((l) => z.literal(l))),
    /** global — общий источник справочника; project — тип проектного источника (документ хранится в проекте). */
    scope: z.enum(SOURCE_SCOPES),
    title: z.string().min(1),
    issuer: z.string().min(1),
    url: z.string().regex(/^https?:\/\//, "URL должен начинаться с http(s)://").nullable(),
    used_for: z.string().min(1),
    accessed: isoDate.nullable(),
    verified: z.boolean().nullable(),
    note: z.string().optional(),
  })
  .strict();

// ---------- parameters.yaml ----------

export const PARAMETER_KINDS = ["scalar", "series", "table", "enum", "date", "bool", "text"] as const;
export const PARAMETER_SCOPES = ["template", "region", "project"] as const;
export const PARAMETER_STATUSES = ["verified", "needs_verification", "project_input", "expert_allowed"] as const;

const legacyCellSchema = z
  .object({
    cell: z.string().nullable(),
    value: z.unknown().optional(),
    verdict: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

const tableColumnSchema = z
  .object({
    key: z.string().min(1),
    /** Заголовок колонки для интерфейса. */
    title: z.string().min(1).optional(),
    unit: z.string().min(1),
    options: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict();

export const parameterSchema = z
  .object({
    id: z.string().regex(/^[A-Z]+\.[A-Z0-9_]+$/, "ID параметра: МОДУЛЬ.ИМЯ"),
    name: z.string().min(1),
    unit: z.string().min(1),
    kind: z.enum(PARAMETER_KINDS),
    scope: z.enum(PARAMETER_SCOPES),
    default: z.unknown(),
    options: z.array(z.string()).optional(),
    columns: z.array(tableColumnSchema).optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
    source_ids: idList.min(1, "нужен хотя бы один источник"),
    basis: z.string().min(1, "нужно обоснование (basis)"),
    how_to_fill: z.string().optional(),
    /**
     * «Откуда» значение справочника простыми словами: текст и необязательная ссылка (решение владельца продукта
     * 27.09.2026). Задаётся, когда у значения нет документа-первоисточника; иначе «Откуда» — источники из source_ids.
     */
    from: z
      .object({
        text: z.string().min(1),
        url: z.string().regex(/^https?:\/\//, "URL должен начинаться с http(s)://").nullable(),
      })
      .strict()
      .optional(),
    status: z.enum(PARAMETER_STATUSES),
    legacy: z.array(legacyCellSchema).min(1, "нужна связь с исходником или 'new'"),
  })
  .strict();

// ---------- capex_items.yaml ----------

export const CAPEX_SCHEDULE_RULES = [
  "uniform",
  "s_curve",
  "at_milestone",
  "follow_smr",
  "follow_sales",
  "manual",
  "formula",
] as const;

export const MILESTONE_KEYS = [
  "land_acquired",
  "design_start",
  "expertise_done",
  "rns_date",
  "construction_start",
  "construction_end",
  "rnv_date",
  "handover_start",
  "handover_end",
  "sales_start",
  "vri_change_date",
] as const;

export const capexItemSchema = z
  .object({
    item_id: z.string().regex(/^[A-Z0-9_]+$/, "ID статьи: ВЕРХНИЙ_РЕГИСТР"),
    name: z.string().min(1),
    group: z.string().min(1),
    base: z.string().min(1),
    rate_param: z.string().optional(),
    formula: z.string().optional(),
    schedule_rule: z.enum(CAPEX_SCHEDULE_RULES),
    schedule_from: z.enum(MILESTONE_KEYS).nullable().optional(),
    schedule_to: z.enum(MILESTONE_KEYS).nullable().optional(),
    source_ids: idList.min(1, "нужен хотя бы один источник"),
    basis: z.string().min(1),
    /** Ставка НДС статьи: доля из TAX.VAT_RATE_OPTIONS или ID параметра (TAX.VAT_RATE). */
    vat_rate: z.union([z.number(), z.string().min(1)]),
    /** Условные ставки НДС: первое правило, у которого выполнены все условия when, заменяет vat_rate. */
    vat_rules: z
      .array(
        z
          .object({
            when: z.record(z.string().min(1), z.string().min(1)),
            vat_rate: z.union([z.number(), z.string().min(1)]),
            source_ids: idList.min(1),
            verified: z.boolean(),
            note: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Доля суммы статьи, облагаемая НДС (для смешанных статей): число 0..1 или ID параметра. По умолчанию 1. */
    vat_taxable_share: z.union([z.number(), z.string().min(1)]).optional(),
    vat_source_ids: idList.min(1, "нужен источник ставки НДС"),
    vat_basis: z.string().min(1),
    /** Индекс пересчёта цен: investment — дефлятор инвестиций (CAPEX.COST_INDEX), cpi — ИПЦ (CAPEX.OPEX_INDEX), none — не индексируется. */
    index_type: z.enum(["investment", "cpi", "none"]),
    legacy: z
      .object({
        budget_row: z.number().int().nullable(),
        cf_rows: z.array(z.number().int()).nullable(),
        amount: z.union([z.number(), z.string()]).nullable(),
        issue: z.string().optional(),
      })
      .strict(),
  })
  .strict();

// ---------- regions.yaml ----------

export const REGION_STATUSES = ["structure_only", "reference_partially_filled", "reference_filled"] as const;

const parkingNormSchema = z
  .object({
    source_ids: idList,
    rule: z.enum(["to_fill", "by_apartment_area"]),
    values: z
      .array(z.object({ max_area: z.number().positive().nullable(), per_apt: z.number().nonnegative() }).strict())
      .nullable(),
    status: z.enum(["to_fill", "needs_verification", "verified"]),
  })
  .strict();

export const regionSchema = z
  .object({
    code: z.string().regex(/^\d{2}$/, "код субъекта — две цифры"),
    name: z.string().min(1),
    fns_rates_url: z.string().regex(/^https?:\/\//),
    ncs_k_per: z.number().positive().nullable(),
    ncs_k_per_source_ids: idList,
    tariff_authority: z.string().nullable(),
    land_tax_level: z.string().min(1),
    land_tax_source_ids: idList,
    /**
     * Ставка земельного налога для участков под жилищное строительство, если она одна на весь субъект (Москва,
     * Санкт-Петербург, Севастополь — закон города). В остальных субъектах ставка — по ОКТМО, поля нет.
     */
    land_tax_rate_housing: z
      .object({
        value: z.number().nonnegative().nullable(),
        source_ids: idList,
        status: z.enum(["needs_verification", "verified"]),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
    land_rent_source_ids: idList,
    vri_fee: z
      .object({
        exists: z.boolean().nullable(),
        source_ids: idList,
        formula: z.string().nullable(),
        note: z.string().optional(),
      })
      .strict(),
    parking_norm: parkingNormSchema,
    /** Норматив машино-мест для объектов гостиничного назначения (апартаменты); единица — по акту региона. */
    parking_norm_apart: z
      .object({
        source_ids: idList,
        /** per_unit — машино-мест на единицу (апартамент); per_100_m2 — на 100 м² площади апартаментов. */
        rule: z.enum(["to_fill", "per_unit", "per_100_m2"]),
        values: z.array(z.record(z.string(), z.unknown())).nullable(),
        status: z.enum(["to_fill", "needs_verification", "verified"]),
      })
      .strict(),
    ngp_source_ids: idList,
    status: z.enum(REGION_STATUSES),
    /**
     * Регион доступен для новых проектов: как определить его по кадастровому номеру (номер кадастрового округа —
     * первая часть номера) и по адресу (названия региона в адресе). Нет поля — регион пока недоступен.
     */
    lookup: z
      .object({
        cadastral_districts: z.array(z.string().regex(/^\d{2}$/, "номер кадастрового округа — две цифры")),
        address_names: z.array(z.string().min(1)).min(1),
        source_ids: idList.min(1, "нужен хотя бы один источник"),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ---------- formulas.yaml ----------

export const FORMULA_MODULES = [
  "TIME",
  "TEP",
  "LAND",
  "CAPEX",
  "SALES",
  "ESCROW",
  "FIN",
  "TAX",
  "CF",
  "KPI",
  "CHECK",
  "BENCH",
] as const;
export const FORMULA_STATUSES = ["verified", "needs_verification"] as const;

export const formulaSchema = z
  .object({
    id: z.string().regex(/^F\.[A-Z]+\.[A-Z0-9_]+$/, "ID формулы: F.МОДУЛЬ.ИМЯ"),
    module: z.enum(FORMULA_MODULES),
    name: z.string().min(1),
    unit: z.string().min(1),
    dims: z.array(z.string()),
    expr: z.string().min(1),
    /** Пояснение словами: проверки, оговорки, ссылки на акты (expr — только формула). */
    note: z.string().min(1).optional(),
    /** Расшифровка промежуточных обозначений из expr: «need[t]» → что это. */
    terms: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * Панель «Как посчитано» для финансиста: название с единицами, пояснение простым языком в 1–3 предложениях
     * (без обозначений, кодов и английских слов) и пример на цифрах проекта одной строкой (шаблон с подстановкой
     * {ID} и {=} — результат). Предупреждения, разница с расчётом «как в исходном Excel» и поля ввода берутся из расчёта.
     */
    plain: z
      .object({
        title: z.string().min(1),
        how: z.string().min(1),
        example: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    depends_on: idList,
    /** Подмножество depends_on, для которого берётся значение прошлого месяца X[t-1]; разрывает цикл графа. */
    lag_depends_on: idList.optional(),
    rationale: z.string().min(1, "нужно обоснование (rationale)"),
    rejected: z.array(z.string()),
    source_ids: idList.min(1, "нужен хотя бы один источник"),
    legacy: z
      .object({
        cells: z.string().nullable(),
        verdict: z.string().min(1),
        issue: z.string().optional(),
      })
      .strict(),
    status: z.enum(FORMULA_STATUSES),
    example: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ---------- company_assumptions.yaml ----------

/** Раздел справочника допущений; порядок значений в версии задаёт номера вопросов к данным. */
export const ASSUMPTION_GROUPS = ["sales", "budget", "escrow", "fin"] as const;
/** unverified — «не проверено», check — «проверить …» (что именно — в поле check), approved — «утверждено». */
export const ASSUMPTION_STATUSES = ["unverified", "check", "approved"] as const;

export const assumptionItemSchema = z
  .object({
    param: z.string().min(1),
    group: z.enum(ASSUMPTION_GROUPS),
    /** null — стандарта нет, значение вводится в проекте. */
    value: z.unknown().refine((v) => v !== undefined, "нужно поле value (null — стандарта нет)"),
    status: z.enum(ASSUMPTION_STATUSES),
    /** Для статуса check: что проверить («условия банка»). */
    check: z.string().min(1).optional(),
    from: z
      .object({
        text: z.string().min(1),
        url: z.string().regex(/^https?:\/\//, "URL должен начинаться с http(s)://").nullable(),
      })
      .strict(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const assumptionVersionSchema = z
  .object({
    version: z.number().int().min(1),
    date: isoDate,
    author: z.string().min(1),
    note: z.string().min(1),
    items: z.array(assumptionItemSchema).min(1),
  })
  .strict();

// ---------- файлы целиком ----------

export const sourcesFileSchema = z.object({ sources: z.array(sourceSchema) }).strict();
export const parametersFileSchema = z.object({ parameters: z.array(parameterSchema) }).strict();
export const capexFileSchema = z.object({ items: z.array(capexItemSchema) }).strict();
export const regionsFileSchema = z.object({ regions: z.array(regionSchema) }).strict();
export const formulasFileSchema = z.object({ formulas: z.array(formulaSchema) }).strict();
export const assumptionsFileSchema = z.object({ versions: z.array(assumptionVersionSchema).min(1) }).strict();

export type Source = z.infer<typeof sourceSchema>;
export type Parameter = z.infer<typeof parameterSchema>;
export type CapexItem = z.infer<typeof capexItemSchema>;
export type Region = z.infer<typeof regionSchema>;
export type Formula = z.infer<typeof formulaSchema>;
export type AssumptionItem = z.infer<typeof assumptionItemSchema>;
export type AssumptionVersion = z.infer<typeof assumptionVersionSchema>;

/** Весь справочник после проверки схемами. */
export interface SpecData {
  sources: Source[];
  parameters: Parameter[];
  capexItems: CapexItem[];
  regions: Region[];
  formulas: Formula[];
  /** Справочник допущений компании по версиям (data/company_assumptions.yaml). */
  assumptions: AssumptionVersion[];
}
