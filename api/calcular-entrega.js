// api/calcular-entrega.js
/* eslint-disable */

// ======================== TABELAS ========================
const PRICE_RULES = [
  { kmMax: 1.5,   minMax: 10,  preco: 15,  nome: "0–1.5km / até 10min" },
  { kmMax: 3.0,   minMax: 20,  preco: 20,  nome: "1.5–3.0km / até 20min" },
  { kmMax: 4.5,   minMax: 30,  preco: 30,  nome: "3.0–4.5km / até 30min" },
  { kmMax: 6.99,  minMax: 45,  preco: 40,  nome: "4.5–6.99km / até 45min" },
  { kmMax: 9.99,  minMax: 60,  preco: 50,  nome: "7.0–9.99km / até 60min" },
  { kmMax: 15.0,  minMax: 90,  preco: 60,  nome: "10–15km / até 90min" },
];

// Nível de isenção por env (1=R$250, 2=R$250, 3=R$300, 4=R$400, 5=R$500, 6=R$500, 7=null)
const ISENCAO_NIVEIS = { 1:250, 2:250, 3:300, 4:400, 5:500, 6:500, 7:null };

// ======================== CORS / JSON ========================
function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ======================== CACHE EM MEMÓRIA ========================
const mem = new Map();
const now = () => Date.now();
function memoSet(k, v) { mem.set(k, { v, t: now() }); return v; }
function memoGet(k, ttlMs = 30 * 60 * 1000) {
  const x = mem.get(k);
  if (!x) return null;
  if (now() - x.t > ttlMs) { mem.delete(k); return null; }
  return x.v;
}

// ======================== POA COMO PADRÃO DE CIDADE ========================
function normalizaEnderecoComCidade(text) {
  const raw = String(text || "").trim();
  if (!raw) return "Porto Alegre - RS, Brasil";
  const t = raw.replace(/\s+/g, " ");

  // Se já menciona POA
  if (/porto\s*alegre/i.test(t)) {
    return /(RS|Rio Grande do Sul)/i.test(t) ? t : `${t}, RS, Brasil`;
  }

  // Tem cidade explícita no final?
  const TEM_CIDADE = /,\s*([A-Za-zÀ-ÿ'.\-\s]{2,})(?:\s*-\s*[A-Za-z]{2})?(?:\s*,\s*Brasil)?\s*$/i;
  if (TEM_CIDADE.test(t)) return t;

  // Sem cidade → POA padrão
  return `${t}, Porto Alegre - RS, Brasil`;
}

// ======================== ORIGEM (LAT/LNG) ========================
function resolveOriginLatLng() {
  // teus valores fixos como fallback
  const defLat = -30.00629069583669;
  const defLng = -51.09454642678367;

  const lat = Number(process.env.ORIGIN_LAT ?? defLat);
  const lng = Number(process.env.ORIGIN_LNG ?? defLng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return { lat: defLat, lng: defLng };
}

// ======================== Haversine (fallback sem rota) ========================
function haversineKm(a, b) {
  const R = 6371; // km
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s1 = Math.sin(dLat/2) ** 2;
  const s2 = Math.cos(a.lat * Math.PI/180) * Math.cos(b.lat * Math.PI/180) * Math.sin(dLng/2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(s1 + s2));
  return R * c;
}

// Estimativa simples de minutos se cairmos no Haversine:
// 22 km/h média urbana → 1 km ≈ 2.73 min, +5 min de overhead
function estimaMinutosPorKm(km) {
  return Math.max(1, Math.round(km * 2.73 + 5));
}

// ======================== PRECIFICAÇÃO ========================
function aplicaTabela(km, min) {
  for (const r of PRICE_RULES) {
    if (km <= r.kmMax && min <= r.minMax) return { valorBase: r.preco, tier: r.nome };
  }
  return { valorBase: null, tier: "FORA_DA_AREA" };
}

// ======================== PROVEDOR: ORS ========================
async function geocodeORS(text) {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new Error("CONFIG: Defina ORS_API_KEY nas variáveis do Vercel.");
  const cacheKey = "geo:ors:" + text.toLowerCase();
  const c = memoGet(cacheKey);
  if (c) return c;

  const url = "https://api.openrouteservice.org/geocode/search";
  const r = await fetch(`${url}?text=${encodeURIComponent(text)}&size=1&lang=pt`, {
    headers: { Authorization: key }
  });
  if (!r.ok) throw new Error("GEOCODE_FAIL: " + r.status + " " + (await r.text()));
  const data = await r.json();
  const feat = data?.features?.[0];
  if (!feat) throw new Error("GEOCODE_EMPTY");
  const [lng, lat] = feat.geometry.coordinates;
  return memoSet(cacheKey, { lat, lng });
}

async function orsRouteKmMin(origin, dest) {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new Error("CONFIG: Defina ORS_API_KEY nas variáveis do Vercel.");
  const prof = process.env.TRANSPORT_PROFILE || "driving-car";
  const cacheKey = `route:ors:${prof}:${origin.lat},${origin.lng}->${dest.lat},${dest.lng}`;
  const cached = memoGet(cacheKey, 15 * 60 * 1000);
  if (cached) return cached;

  const url = `https://api.openrouteservice.org/v2/directions/${prof}`;
  const body = { coordinates: [[origin.lng, origin.lat], [dest.lng, dest.lat]], language: "pt" };

  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error("ROUTE_FAIL: " + r.status + " " + (await r.text()));
  const data = await r.json();
  const seg = data?.features?.[0]?.properties?.segments?.[0];
  if (typeof seg?.distance !== "number" || typeof seg?.duration !== "number") {
    throw new Error("ROUTE_EMPTY");
  }
  const km = Math.max(0, seg.distance / 1000);
  const min = Math.max(1, Math.ceil(seg.duration / 60));
  return memoSet(cacheKey, { km, min });
}

// ======================== PROVEDOR: NOMINATIM (grátis) ========================
async function geocodeNominatim(text) {
  const cacheKey = "geo:nominatim:" + text.toLowerCase();
  const c = memoGet(cacheKey);
  if (c) return c;

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text)}&accept-language=pt-BR`;
  const r = await fetch(url, {
    headers: {
      // User-Agent é recomendado pelo Nominatim
      "User-Agent": "SerraNobrePedidos/1.0 (+contato@serranobre.example)"
    }
  });
  if (!r.ok) throw new Error("NOMINATIM_FAIL: " + r.status + " " + (await r.text()));
  const data = await r.json();
  const f = data?.[0];
  if (!f) throw new Error("NOMINATIM_EMPTY");
  const lat = Number(f.lat), lng = Number(f.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("NOMINATIM_COORDS_INVALID");
  return memoSet(cacheKey, { lat, lng });
}

// ======================== PROVEDOR: OSRM (público) ========================
async function osrmRouteKmMin(origin, dest) {
  const cacheKey = `route:osrm:car:${origin.lat},${origin.lng}->${dest.lat},${dest.lng}`;
  const cached = memoGet(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  const base = "https://router.project-osrm.org/route/v1/driving";
  const url = `${base}/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=false&alternatives=false&steps=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("OSRM_FAIL: " + r.status + " " + (await r.text()));
  const data = await r.json();
  const rt = data?.routes?.[0];
  if (typeof rt?.distance !== "number" || typeof rt?.duration !== "number") {
    throw new Error("OSRM_EMPTY");
  }
  const km = Math.max(0, rt.distance / 1000);
  const min = Math.max(1, Math.ceil(rt.duration / 60));
  return memoSet(cacheKey, { km, min });
}

// ======================== HANDLER ========================
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { setJsonHeaders(res); res.status(200).end(); return; }
  setJsonHeaders(res);

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // Parse body com tolerância
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
    body = body || {};

    const debug = String(req.query?.debug || "").trim() === "1";
    const { enderecoTexto, totalItens } = body;
    if (!enderecoTexto) return res.status(400).json({ error: "enderecoTexto obrigatório" });

    const origin = resolveOriginLatLng();
    const enderecoNormalizado = normalizaEnderecoComCidade(enderecoTexto);

    let dest = null;
    let km = null, min = null;
    let tier = "—", valorBase = null;
    const steps = [];

    // ==== CAMADA 1: ORS (se chave existir e USE_PROVIDER=ors) ====
    const provider = (process.env.USE_PROVIDER || "ors").toLowerCase();
    const haveORSKey = !!process.env.ORS_API_KEY;
    if (provider === "ors" && haveORSKey) {
      try {
        steps.push("try:ORS_geocode");
        dest = await geocodeORS(enderecoNormalizado);

        steps.push("try:ORS_route");
        const rotaORS = await orsRouteKmMin(origin, dest);
        km = rotaORS.km; min = rotaORS.min;

      } catch (e) {
        steps.push("ORS_fail:" + String(e?.message || e));
        dest = null;
        km = null; min = null;
      }
    } else {
      steps.push("skip:ORS");
    }

    // ==== CAMADA 2: Nominatim + OSRM ====
    if (km == null || min == null) {
      try {
        if (!dest) {
          steps.push("try:NOMINATIM_geocode");
          dest = await geocodeNominatim(enderecoNormalizado);
        }

        steps.push("try:OSRM_route");
        const rotaOSRM = await osrmRouteKmMin(origin, dest);
        km = rotaOSRM.km; min = rotaOSRM.min;

      } catch (e) {
        steps.push("NOMINATIM/OSRM_fail:" + String(e?.message || e));
        km = null; min = null;
      }
    }

    // ==== CAMADA 3: Haversine (último recurso) ====
    if (km == null || min == null) {
      try {
        if (!dest) {
          steps.push("try:NOMINATIM_geocode_for_haversine");
          dest = await geocodeNominatim(enderecoNormalizado);
        }
        steps.push("fallback:HAVERSINE");
        km = haversineKm(origin, dest);
        min = estimaMinutosPorKm(km);
      } catch (e) {
        steps.push("Haversine_fail:" + String(e?.message || e));
        return res.status(500).json({ status: "ERRO", step: steps.join(" > "), error: "Falha geral de geocodificação/rota" });
      }
    }

    const prec = aplicaTabela(km, min);
    valorBase = prec.valorBase;
    tier = prec.tier;

    // Fora da área (sem faixa correspondente)
    if (valorBase == null) {
      const payloadFA = {
        status: "FORA_DA_AREA",
        km: +km.toFixed(2),
        min: Math.round(min),
        tier,
        mensagem: "Endereço fora da área de entrega."
      };
      if (debug) payloadFA.debug = { origin, dest, enderecoNormalizado, steps };
      return res.status(422).json(payloadFA);
    }

    // Isenção
    const nivel = Number(process.env.ISENCAO_NIVEL || "1");
    const isencaoMin = ISENCAO_NIVEIS[nivel] ?? null;
    const isento = (isencaoMin != null) && (Number(totalItens) >= isencaoMin);
    const valorCobravel = isento ? 0 : valorBase;
    const labelIsencao = isento ? `(ISENTO de frete – pedido ≥ R$ ${Number(isencaoMin).toFixed(2)})` : "";

    const out = {
      status: "OK",
      km: +km.toFixed(2),
      min: Math.round(min),
      valorBase,
      valorCobravel,
      isento,
      labelIsencao,
      tier
    };
    if (debug) out.debug = { origin, dest, enderecoNormalizado, steps };
    return res.status(200).json(out);

  } catch (e) {
    console.error("ERRO FRETE:", e);
    const msg = String(e?.message || e);
    return res.status(500).json({ status: "ERRO", error: msg });
  }
}