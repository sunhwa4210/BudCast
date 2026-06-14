"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useState } from "react";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Layer } from "leaflet";
import { DistrictRisk, scoreColor } from "../app/lib";

interface Props {
  riskByGu: Record<string, DistrictRisk>;
  selected: string | null;
  onSelect: (gu: string) => void;
}

export default function MapView({ riskByGu, selected, onSelect }: Props) {
  const [geo, setGeo] = useState<FeatureCollection | null>(null);

  useEffect(() => {
    fetch("/seoul.geojson")
      .then((r) => r.json())
      .then(setGeo)
      .catch(() => setGeo(null));
  }, []);

  const guName = (f: Feature) => (f.properties as any)?.name as string;

  const style = (feature?: Feature) => {
    if (!feature) return {};
    const name = guName(feature);
    const risk = riskByGu[name];
    const isSel = selected === name;
    return {
      fillColor: risk ? scoreColor(risk.score) : "#33415c",
      weight: isSel ? 3 : 1,
      color: isSel ? "#ffffff" : "#0b1220",
      fillOpacity: risk ? 0.78 : 0.4,
    };
  };

  const onEachFeature = (feature: Feature<Geometry>, layer: Layer) => {
    const name = guName(feature);
    layer.on({ click: () => onSelect(name) });
    const risk = riskByGu[name];
    layer.bindTooltip(
      `<b>${name}</b>${risk ? ` · ${risk.score.toFixed(0)}점 (${risk.level})` : ""}`,
      { sticky: true }
    );
  };

  return (
    <MapContainer
      center={[37.5642, 126.997]}
      zoom={11}
      style={{ height: "100%", width: "100%" }}
      zoomControl={true}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; OpenStreetMap &copy; CARTO'
      />
      {geo && (
        <GeoJSON
          key={
            selected +
            "|" +
            Object.values(riskByGu)
              .map((r) => r.score)
              .join(",")
          }
          data={geo}
          style={style as any}
          onEachFeature={onEachFeature}
        />
      )}
    </MapContainer>
  );
}
