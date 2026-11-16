const DATASET_URL = "https://data.ampmetropole.fr/api/explore/v2.1/catalog/datasets/ol-perturbation-la-mobilite/records?limit=100";
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
    startValidity: first(f.startValidity, f.start_validity, f.start_date, null),
    endValidity: first(f.endValidity, f.end_validity, f.end_date, null),
    updateDate: first(f.updateDate, f.updated_at, f.updatedAt, null)
  };
}

function isActive(alert, now) {
  const start = alert.startValidity ? Date.parse(alert.startValidity) : NaN;
  const end = alert.endValidity ? Date.parse(alert.endValidity) : NaN;
  if (Number.isFinite(start) && start > now) return false;
  if (Number.isFinite(end) && end < now) return false;
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "vigie13-worker", checkedAt: new Date().toISOString() });
    }
    if (url.pathname === "/api/rtm-alerts") {
      try {
        const upstream = await fetch(DATASET_URL, {
          headers: { "accept": "application/json", "user-agent": "Vigie13/1.0 (public mobility information)" },
          cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
        });
        if (!upstream.ok) return json({ ok: false, message: "La source mobilité a répondu HTTP " + upstream.status }, 502);
        const payload = await upstream.json();
        const rows = Array.isArray(payload.results) ? payload.results : Array.isArray(payload.records) ? payload.records : [];
        const now = Date.now();
        const alerts = rows.map(normalize).filter(a => isActive(a, now));
        alerts.sort((a, b) => {
          const rank = x => /critical|major|high|élev|fort|important/i.test(x.criticity) ? 0 : 1;
          return rank(a) - rank(b) || a.title.localeCompare(b.title, "fr");
        });
        return json({ ok: true, source: "Métropole Aix-Marseille-Provence · ol-perturbation-la-mobilite", fetchedAt: new Date().toISOString(), count: alerts.length, alerts });
      } catch (error) {
        return json({ ok: false, message: "Impossible de joindre la source mobilité", detail: String(error && error.message || error) }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
