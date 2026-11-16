const DATASET_URL = "https://data.ampmetropole.fr/api/explore/v2.1/catalog/datasets/ol-perturbation-la-mobilite/records?limit=100";
const GTFS_RT_URL = "https://api-mobilite.rbgl.fr/api/v1/mamp/getServiceAlerts";
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
  const entries = values(readFields(bytes), 1, 2);
  const translations = entries.map(entry => {
    const fields = readFields(entry);
    return { text: values(fields, 1, 2).map(str)[0] || "", language: values(fields, 2, 2).map(str)[0] || "" };
  }).filter(item => item.text);
  return (translations.find(item => item.language.toLowerCase().startsWith("fr")) || translations[0] || {}).text || "";
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


function decodeXml(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'");
}
async function getPrefectureNews() {
  const feedUrl = "https://www.bouches-du-rhone.gouv.fr/syndication/flux/rss_feed_69";
  const response = await fetch(feedUrl, {
    headers: { "user-agent": "Vigie13/1.0", "accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    cf: { cacheTtl: 900, cacheEverything: true }
  });
  if (!response.ok) throw new Error("Flux RSS préfecture HTTP " + response.status);
  const xml = await response.text();
  const items = [...xml.matchAll(/<(item|entry)\\b[^>]*>([\\s\\S]*?)<\\/\\1>/gi)].slice(0,12).map((match,index) => {
    const block = match[2];
    const get = tag => {
      const found = block.match(new RegExp("<" + tag + "\\\\b[^>]*>([\\\\s\\\\S]*?)<\\\\/" + tag + ">", "i"));
      return found ? decodeXml(found[1].replace(/<[^>]+>/g," ").replace(/\\s+/g," ").trim()) : "";
    };
    const linkTag = block.match(/<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?\\s*>/i);
    const link = linkTag ? linkTag[1] : get("link");
    return {id:String(index),title:get("title") || "Actualité de la préfecture",message:get("description") || get("summary") || get("content"),publishedAt:get("pubDate") || get("published") || get("updated"),url:link ? new URL(link,"https://www.bouches-du-rhone.gouv.fr").href : "https://www.bouches-du-rhone.gouv.fr/Actualites",category:"Préfecture"};
  }).filter(item => item.title);
  return items;
}

async function getRailAlerts() {
  const endpoint = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-service-alerts";
  const response = await fetch(endpoint, {
    headers: { "accept": "application/octet-stream, application/x-protobuf, */*", "user-agent": "Vigie13/1.0" },
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  if (!response.ok) throw new Error("Flux SNCF HTTP " + response.status);
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/html") || type.includes("application/json")) throw new Error("La source SNCF n'a pas renvoyé de fichier protobuf");
  const localTerms = /marseille|aix[- ]en[- ]provence|arles|aubagne|salon[- ]de[- ]provence|miramas|istres|martigues|vitrolles|marignane|cassis|la ciotat|tarascon|port[- ]de[- ]bouc|bouches[- ]du[- ]rh[oô]ne|ter sud|provence[- ]alpes[- ]c[oô]te d'azur|paca/i;
  return decodeGtfsAlerts(await response.arrayBuffer()).filter(alert => {
    const text = [alert.title, alert.message, alert.lines].join(" ");
    return localTerms.test(text) && isActive(alert, Date.now());
  }).map(alert => ({...alert, category:"TER / SNCF", source:"SNCF Open Data"}));
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
    if (url.pathname === "/api/weather") {
      try {
        const endpoint = "https://api.open-meteo.com/v1/forecast?latitude=43.2965&longitude=5.3698&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&hourly=precipitation_probability,temperature_2m&forecast_days=1&timezone=Europe%2FParis";
        const upstream = await fetch(endpoint, { headers: { "accept": "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
        if (!upstream.ok) return json({ ok: false, message: "Source météo HTTP " + upstream.status }, 502);
        const data = await upstream.json();
        return json({ ok: true, source: "Open-Meteo · coordonnées de Marseille", fetchedAt: new Date().toISOString(), data });
      } catch (error) {
        return json({ ok: false, message: "Météo momentanément indisponible", detail: String(error && error.message || error) }, 502);
      }
    }
    if (url.pathname === "/api/prefecture-news") {
      try {
        const items = await getPrefectureNews();
        return json({ ok: true, source: "Préfecture des Bouches-du-Rhône · flux RSS officiel", fetchedAt: new Date().toISOString(), count: items.length, items });
      } catch (error) {
        return json({ ok: false, message: "Actualités de la préfecture momentanément indisponibles", detail: String(error && error.message || error) }, 502);
      }
    }
    if (url.pathname === "/api/rail-alerts") {
      try {
        const alerts = await getRailAlerts();
        return json({ ok: true, source: "SNCF Open Data · GTFS-RT Service Alerts", fetchedAt: new Date().toISOString(), count: alerts.length, alerts });
      } catch (error) {
        return json({ ok: false, message: "Flux ferroviaire momentanément indisponible", detail: String(error && error.message || error) }, 502);
      }
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
