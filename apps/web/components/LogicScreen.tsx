import { logic, plot } from "@fm/engine";

type Item = logic.LogicItem;

function Links({ item }: { item: Item }) {
  const links = logic.logicLinks(item);
  if (!links.length) return null;
  return (
    <span className="lg-src">
      {links.map((l, i) => (
        <span key={l.id + i}>
          {i > 0 && " · "}
          {l.url ? (
            <a href={l.url} target="_blank" rel="noopener" title={l.verified ? undefined : "Ссылка есть, текст документа ещё не сверен"}>
              {l.label} ↗{!l.verified && " *"}
            </a>
          ) : (
            l.label
          )}
        </span>
      ))}
    </span>
  );
}

function Items({ items }: { items: readonly Item[] }) {
  return (
    <ul>
      {items.map((it) => (
        <li key={it.text} className={it.gap ? "gap" : undefined}>
          {it.text}
          {it.note && <span className="lg-note">{it.note}</span>}
          <Links item={it} />
        </li>
      ))}
    </ul>
  );
}

/** Карта сервиса: шаги — колонки, «кто даёт значение» — строки. На узком экране — шаг за шагом. */
export function LogicScreen() {
  const lanes = logic.LOGIC_LANES;
  const last = logic.LOGIC_STEPS.length + 2;
  return (
    <div className="page lg-page">
      <h1 className="lg-h1">Логика сервиса</h1>
      <p className="lg-sub">
        Пять шагов от адреса участка до ответа «покупать или нет». По каждому шагу: что вносите вы, что сервис находит сам и где, что берётся из законов и нормативов и что пока принято экспертно. Названия
        документов — ссылки на сами документы.
      </p>
      <div className="lg-chain">
        <span className="lg-chip in">Адрес + площадь</span>
        {logic.LOGIC_STEPS.map((s) => (
          <span key={s.n}>
            <i>→</i>
            <span className="lg-chip">
              {s.n} {s.title}
            </span>
          </span>
        ))}
        <i>→</i>
        <span className="lg-chip res">★ Итог: выгодно ли и максимальная цена участка</span>
      </div>

      <div className="lg-grid">
        {lanes.map((l, r) => (
          <div key={l.id} className={`lg-lane ${l.id}`} style={{ gridColumn: 1, gridRow: r + 2 }}>
            <b>{l.title}</b>
            <small>{l.hint}</small>
          </div>
        ))}
        {logic.LOGIC_STEPS.map((s) => (
          <section key={s.n} className="lg-step">
            <div className="lg-hd" style={{ gridColumn: s.n + 1, gridRow: 1 }}>
              <b>
                {s.n} {s.title}
              </b>
              <span>{s.question}</span>
            </div>
            {lanes.map((l, r) => (
              <div key={l.id} className={`lg-cell ${l.id}`} style={{ gridColumn: s.n + 1, gridRow: r + 2 }}>
                <span className="lg-cap">{l.title}</span>
                <Items items={s.lanes[l.id]} />
              </div>
            ))}
          </section>
        ))}
        <div className="lg-hd res" style={{ gridColumn: last, gridRow: 1 }}>
          <b>★ Итог</b>
          <span>ответ для решения</span>
        </div>
        <div className="lg-res" style={{ gridColumn: last, gridRow: `2 / span ${lanes.length}` }}>
          <b>Что получаете</b>
          <Items items={logic.LOGIC_RESULT} />
          <p>
            У каждого значения в проекте есть метка, откуда оно: {Object.values(plot.ORIGIN_LABEL).map((t) => `«${t.toLowerCase()}»`).join(", ")}. Как считается каждое число, словами и со ссылками, — в{" "}
            <a href="/reference/formulas">Справочнике «Формулы»</a>.
          </p>
        </div>
      </div>

      <div className="lg-bottom">
        <div className="card lg-box">
          <h3 className="gapt">Что пока вносится вручную и как это убрать</h3>
          <ul>
            {logic.LOGIC_GAPS.map((g) => (
              <li key={g.title}>
                <b>{g.title}</b> — {g.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="card lg-box">
          <h3>Как читать</h3>
          <ul>
            <li>
              <b className="c-in">Синее</b> вносите вы. <b className="c-auto">Зелёное</b> сервис берёт сам. <b className="c-norm">Фиолетовое</b> — закон или норматив со ссылкой. <b className="c-exp">Оранжевое</b> —
              экспертное допущение, его стоит проверить.
            </li>
            <li>
              Оранжевые значения не спрятаны: они в <a href="/reference/values">Справочнике</a>, у каждого указано основание, их можно поменять сразу для всех проектов. Все документы —{" "}
              <a href="/reference/sources">Справочник «Источники»</a>.
            </li>
            <li>* — ссылка на документ есть, но его текст ещё не сверен с тем, как значение записано в сервисе.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
