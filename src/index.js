const DATASET_URL = "https://data.ampmetropole.fr/api/explore/v2.1/catalog/datasets/ol-perturbation-la-mobilite/records?limit=100";
const GTFS_RT_URL = "https://www.data.gouv.fr/api/1/datasets/r/834199c7-2e4f-4ca5-8675-a78894601a77";
const CACHE_TTL = 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff"
    }
  });
}
function first(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}
function normalize(record) {
  const f = record.fields || record;
  const lines = first(f.lines_final_lname, f.lines_final, f.lines, f.line_names);
  return {
    id: String(first(f.id, record.id, f.uuid, "")),
    title: String(first(f.title, f.name, f.label, "Perturbation du réseau")),
    message: String(first(f.message, f.description, f.information, f.content, "")),
    category: String(first(f.category, f.subnetwork, f.network, "Transport")),
    criticity: String(first(f.criticity, f.level, f.severity, "")),
    level: String(first(f.level, f.criticity, "")),
    lines: Array.isArray(lines) ? lines.join(", ") : String(lines || ""),
    startValidity: first(f.startValidity, f.startvalidity, f.start_validity, f.start_date, null),
    endValidity: first(f.endfunctionalvalidity, f.endValidity, f.endvalidity, f.end_validity, f.end_date, null),
    updateDate: first(f.updateDate, f.updatedate, f.updated_at, f.updatedAt, null)
  };
}
function isActive(alert, now) {
  const start = alert.startValidity ? Date.parse(alert.startValidity) : NaN;
  const end = alert.endValidity ? Date.parse(alert.endValidity) : NaN;
  if (Number.isFinite(start) && start > now) return false;
  if (Number.isFinite(end) && end < now) return false;
  return true;
}

// Minimal Protocol Buffers reader for the public GTFS-Realtime Service Alerts feed.
function readVarint(bytes, state) {
  let value = 0, shift = 0;
  while (state.pos < bytes.length && shift < 56) {
    const b = bytes[state.pos++];
    value += (b & 127) * Math.pow(2, shift);
    if (!(b & 128)) return value;
    shift += 7;
  }
  throw new Error("Protobuf varint invalide");
}
function readFields(bytes) {
  const fields = [];
  const state = {pos: 0};
  while (state.pos < bytes.length) {
    const key = readVarint(bytes, state);
    const number = Math.floor(key / 8), wire = key & 7;
    if (!number) throw new Error("Champ protobuf invalide");
    if (wire === 0) fields.push([number, wire, readVarint(bytes, state)]);
    else if (wire === 2) {
      const length = readVarint(bytes, state), end = state.pos + length;
      if (end > bytes.length) throw new Error("Longueur protobuf invalide");
      fields.push([number, wire, bytes.subarray(state.pos, end)]);
      state.pos = end;
    } else if (wire === 1) { fields.push([number, wire, bytes.subarray(state.pos, state.pos + 8)]); state.pos += 8; }
    else if (wire === 5) { fields.push([number, wire, bytes.subarray(state.pos, state.pos + 4)]); state.pos += 4; }
    else throw new Error("Type protobuf non pris en charge");
  }
  return fields;
}
const values = (fields, n, wire) => fields.filter(f => f[0] === n && (wire === undefined || f[1] === wire)).map(f => f[2]);
const str = bytes => new TextDecoder().decode(bytes);
function translated(bytes) {
  const translations = readFields(bytes).filter(f => f[0] === 1 && f[1] === 2).map(f => str(f[2]));
  return translations[0] || "";
}
function decodeTimeRange(bytes) {
  const f = readFields(bytes);
  const start = values(f, 1, 0)[0], end = values(f, 2, 0)[0];
  return {start: start ? new Date(start * 1000).toISOString() : null, end: end ? new Date(end * 1000).toISOString() : null};
}
function decodeSelector(bytes) {
  const f = readFields(bytes);
  return String(values(f, 2, 2).map(str)[0] || values(f, 5, 2).map(str)[0] || "");
}
function decodeGtfsAlerts(buffer) {
  const bytes = new Uint8Array(buffer);
  const feed = readFields(bytes);
  const entities = values(feed, 2, 2);
  const result = [];
  for (const entityBytes of entities) {
    const entity = readFields(entityBytes);
    const alertBytes = values(entity, 5, 2)[0];
    if (!alertBytes) continue;
    const alert = readFields(alertBytes);
    const periods = values(alert, 1, 2).map(decodeTimeRange);
    const selectors = values(alert, 5, 2).map(decodeSelector).filter(Boolean);
    const header = values(alert, 10, 2)[0];
    const description = values(alert, 11, 2)[0];
    const cause = values(alert, 6, 0)[0];
    const effect = values(alert, 7, 0)[0];
    result.push({
      id: String(values(entity, 1, 2).map(str)[0] || result.length),
      title: header ? translated(header) : "Information trafic",
      message: description ? translated(description) : "",
      category: "Réseaux métropolitains",
      criticity: Number(effect) >= 7 ? "high" : "",
      lines: selectors.join(", "),
      startValidity: periods[0]?.start || null,
      endValidity: periods[0]?.end || null,
      cause: cause ?? null
    });
  }
  return result;
}
async function getTransportAlerts() {
  const response = await fetch(GTFS_RT_URL, {
    headers: { "accept": "application/octet-stream, application/x-protobuf, */*", "user-agent": "Vigie13/1.0" },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
  });
  if (!response.ok) throw new Error("Flux GTFS-RT HTTP " + response.status);
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/html") || type.includes("application/json")) throw new Error("Le téléchargement GTFS-RT n'a pas renvoyé de fichier protobuf");
  const alerts = decodeGtfsAlerts(await response.arrayBuffer());
  const now = Date.now();
  return alerts.filter(a => isActive(a, now));
}
async function getLegacyAlerts() {
  const upstream = await fetch(DATASET_URL, {
    headers: { "accept": "application/json", "user-agent": "Vigie13/1.0 (public mobility information)" },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
  });
  if (!upstream.ok) throw new Error("Source mobilité HTTP " + upstream.status);
  const payload = await upstream.json();
  const rows = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.records) ? payload.records : [];
  const now = Date.now();
  return rows.map(normalize).filter(a => isActive(a, now));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "vigie13-worker", checkedAt: new Date().toISOString() });
    }
    if (url.pathname === "/api/rtm-alerts") {
      try {
        let alerts, source;
        try {
          alerts = await getTransportAlerts();
          source = "Flux GTFS-RT · La Métropole Mobilité";
        } catch (feedError) {
          alerts = await getLegacyAlerts();
          source = "Métropole Aix-Marseille-Provence · flux de secours";
        }
        alerts.sort((a, b) => {
          const rank = x => /critical|major|high|élev|fort|important/i.test(x.criticity) ? 0 : 1;
          return rank(a) - rank(b) || a.title.localeCompare(b.title, "fr");
        });
        return json({ ok: true, source, fetchedAt: new Date().toISOString(), count: alerts.length, alerts });
      } catch (error) {
        return json({ ok: false, message: "Impossible de joindre les sources de mobilité", detail: String(error && error.message || error) }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
