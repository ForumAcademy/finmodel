"use client";

import { useEffect, useRef } from "react";
import type { Map as LMap, CircleMarker } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { plot } from "@fm/engine";

/** Центр карты по умолчанию — Москва; масштаб — город с областью рядом. */
const CENTER: [number, number] = [55.7558, 37.6173];
const ZOOM = 9;
const POINT_ZOOM = 15;

/** Точка на карте: клик ставит точку. readOnly — только показать. */
export function MapPicker({ value, onChange, readOnly }: { value: plot.GeoPoint | null; onChange?: (p: plot.GeoPoint) => void; readOnly?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const marker = useRef<CircleMarker | null>(null);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !box.current || map.current) return;
      const m = L.map(box.current, { attributionControl: true }).setView(value ? [value.lat, value.lon] : CENTER, value ? POINT_ZOOM : ZOOM);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© участники OpenStreetMap" }).addTo(m);
      const put = (lat: number, lon: number) => {
        marker.current ??= L.circleMarker([lat, lon], { radius: 8, color: "#1f4fd1", fillOpacity: 0.6 }).addTo(m);
        marker.current.setLatLng([lat, lon]);
      };
      if (value) put(value.lat, value.lon);
      if (!readOnly) {
        m.on("click", (e) => {
          put(e.latlng.lat, e.latlng.lng);
          change.current?.({ lat: e.latlng.lat, lon: e.latlng.lng });
        });
      }
      map.current = m;
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
    // карта создаётся один раз; точка дальше меняется кликом
  }, []);

  return <div ref={box} className="mapbox-pick" />;
}

const COORD = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 5, maximumFractionDigits: 5 });

/** «55,75580° с. ш., 37,61730° в. д.» */
export function pointText(p: plot.GeoPoint): string {
  return `${COORD.format(p.lat)}° с. ш., ${COORD.format(p.lon)}° в. д.`;
}
