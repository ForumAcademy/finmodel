import Link from "next/link";
import { passport, plot, text } from "@fm/engine";

function Source({
  basis,
  origin,
}: {
  basis: plot.ValueBasis | null;
  origin?: plot.Origin | null;
}) {
  if (!basis) return <span className="po-source">Источник не указан</span>;
  const label = `${basis.title}${basis.date ? ` · ${text.date(basis.date)}` : ""}`;
  return (
    <div className="po-source">
      {origin === "expert" ? "Введено пользователем · " : ""}
      {basis.url && /^https?:\/\//.test(basis.url) ? (
        <a href={basis.url} target="_blank" rel="noopener noreferrer">
          {label} ↗
        </a>
      ) : (
        label
      )}
      {basis.note && (
        <details className="po-source-note">
          <summary>Подробнее об основании</summary>
          <p>{basis.note}</p>
        </details>
      )}
    </div>
  );
}

export function ParcelOverview({
  project: p,
  context,
  demo = false,
}: {
  project: plot.LandProject;
  context?: passport.PassportContext;
  demo?: boolean;
}) {
  const view = passport.passportView(p, context);
  const href = (sec: string) => `/projects/${p.id}?sec=${sec}`;
  return (
    <div className="po">
      {demo ? (
        <div className="po-demo">
          <span>Демонстрационный паспорт · Москва</span>
          <p>
            По материалам пользователя; сведения не обновляются автоматически.
            Этот пример не сохраняется в ваших проектах.
          </p>
        </div>
      ) : (
        <nav className="po-nav" aria-label="Разделы проекта">
          <span aria-current="page">Обзор участка</span>
          <Link href={href("plot")}>Исходные данные</Link>
          <Link href={href("site")}>Подробный анализ</Link>
          <Link href={href("docs")}>Документы</Link>
        </nav>
      )}
      <header className="po-heading">
        <div>
          <div className="po-eyebrow">ПАСПОРТ УЧАСТКА</div>
          <h2>{p.plot.address.value || plot.projectTitle(p)}</h2>
          <p>Жилой проект · без изменения разрешённого использования</p>
        </div>
        <span className="po-state">
          <span aria-hidden="true">◷</span> Проверка оснований
        </span>
      </header>
      <section className="po-decision" aria-labelledby="po-decision-title">
        <div className="po-decision-icon" aria-hidden="true">
          !
        </div>
        <div>
          <span className="po-eyebrow">ЧТО ИЗВЕСТНО СЕЙЧАС</span>
          <h3 id="po-decision-title">{view.title}</h3>
          <p>{view.explanation}</p>
          <div className="po-next">
            <b>Следующий шаг</b>
            <span>
              Установить действующий градостроительный регламент для конкретного
              участка.
            </span>
          </div>
          {!demo && (
            <Link className="btn pri" href={href("site")}>
              Открыть ограничения участка →
            </Link>
          )}
        </div>
      </section>
      <div className="po-columns">
        <section className="po-panel" aria-labelledby="po-facts">
          <div className="po-section-head">
            <h3 id="po-facts">Что известно об участке</h3>
            {!demo && <Link href={href("plot")}>Уточнить данные ↗</Link>}
          </div>
          <div className="po-facts">
            {view.facts.map((f) => (
              <div
                className={`po-fact ${f.key === "area" || f.key === "vri" ? "po-fact-lead" : ""}`}
                key={f.key}
              >
                <span className="po-label">{f.label}</span>
                <div className="po-value">
                  {f.value}
                  {f.unit && <small> {f.unit}</small>}
                </div>
                {f.entry.value !== null && (
                  <Source basis={f.entry.basis} origin={f.entry.origin} />
                )}
              </div>
            ))}
          </div>
          {context?.rightsNote && (
            <div className="po-note">
              <b>Права и обременения</b>
              <p>{context.rightsNote}</p>
            </div>
          )}
          {context?.boundaryNote && (
            <div className="po-note">
              <b>Граница и существующая застройка</b>
              <p>{context.boundaryNote}</p>
            </div>
          )}
        </section>
        <section className="po-panel po-checklist" aria-labelledby="po-checks">
          <h3 id="po-checks">Путь к инвестиционному решению</h3>
          <p className="po-muted">
            Видно, на каком основании можно перейти к следующему шагу.
          </p>
          <ol>
            {view.steps.map((step) => (
              <li key={step.title}>
                <div className="po-step-head">
                  <b>{step.title}</b>
                  <span>{step.state}</span>
                </div>
                <p>{step.detail}</p>
                {!demo && (
                  <Link href={href(step.target)}>Открыть раздел →</Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      </div>
      {view.areaConflict && (
        <section className="po-conflict" aria-labelledby="po-conflict">
          <div className="po-section-head">
            <h3 id="po-conflict">Площадь в источниках различается</h3>
            <span className="po-state">Перепроверить</span>
          </div>
          <div className="po-compare">
            <div>
              <b>{view.areaConflict.current} м²</b>
              <Source
                basis={view.areaConflict.currentEntry.basis}
                origin={view.areaConflict.currentEntry.origin}
              />
            </div>
            <span className="po-versus">и</span>
            <div>
              <b>{view.areaConflict.other} м²</b>
              <Source basis={view.areaConflict.otherBasis} />
            </div>
          </div>
          <p>
            Расхождение — <strong>{view.areaConflict.difference} м²</strong>.
            Нужно сверить границы и состав оцениваемой территории. Ни одно
            значение не заменено автоматически.
          </p>
        </section>
      )}
      <section className="po-panel" aria-labelledby="po-economics">
        <div className="po-section-head">
          <h3 id="po-economics">Варианты и экономика</h3>
          <span className="po-muted">После проверки оснований</span>
        </div>
        <div className="po-economic-grid">
          {[
            "Что можно построить",
            "Сколько потребуется вложить",
            "Сколько можно заработать",
            "Сколько можно заплатить за землю",
          ].map((title) => (
            <div key={title}>
              <h4>{title}</h4>
              <span>Нужны обоснованные вводные</span>
            </div>
          ))}
        </div>
        <p className="po-muted">
          Расчёт вариантов доступен в подробном анализе. Наличие расчёта само по
          себе не подтверждает разрешённость строительства или полноту затрат.
        </p>
        {!demo && (
          <Link className="btn" href={href("compare")}>
            Посмотреть имеющиеся расчёты →
          </Link>
        )}
      </section>
      <section className="po-panel" aria-labelledby="po-sources">
        <h3 id="po-sources">Источники и основания</h3>
        {context?.sources?.length ? (
          <div className="po-sources">
            {context.sources.map((s) => (
              <article key={s.url}>
                <div>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.title} ↗
                  </a>
                  <p>{s.note}</p>
                </div>
                <div>
                  <span className="po-source-tag">{s.status}</span>
                  <small>{text.date(s.date)}</small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="po-muted">
            Основание каждого значения указано в карточке выше. Добавленные
            файлы доступны в документах проекта; их наличие ещё не означает
            проверку содержания.
          </p>
        )}
      </section>
      <footer className="po-footer">
        Сведения из источника, экспертные оценки и неизвестные значения
        рассматриваются отдельно. Паспорт помогает определить следующий шаг
        проверки.
      </footer>
    </div>
  );
}
