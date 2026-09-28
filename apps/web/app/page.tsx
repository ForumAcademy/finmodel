import { spec } from "@fm/spec";

/** Главный экран «Проекты». Каркас интерфейса строится по макету на следующем этапе. */
export default function ProjectsPage() {
  return (
    <section className="empty">
      <h1>Проекты</h1>
      <p>Проектов пока нет. Создание проекта по кадастровому номеру появится в следующей версии.</p>
      <p className="muted">Справочник актуален на {spec.actualizedAt ? spec.actualizedAt.split("-").reverse().join(".") : "—"}.</p>
    </section>
  );
}
