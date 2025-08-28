// api/calcular-entrega.js
/* eslint-disable */

// ------------------------ TABELAS ------------------------
const PRICE_RULES = [
  { kmMax: 1.5,   minMax: 10,  preco: 15,  nome: "0–1.5km / até 10min" },
  { kmMax: 3.0,   minMax: 20,  preco: 20,  nome: "1.501–3.0km / até 20min" },
  { kmMax: 4.5,   minMax: 30,  preco: 30,  nome: "3.01–4.5km / até 30min" },
  { kmMax: 6.99,  minMax: 45,  preco: 40,  nome: "4.5–6.99km / até 45min" },
  { kmMax: 9.99,  minMax: 60,  preco: 50,  nome: "7–9.99km / até 60min" },
  { kmMax: 15.0,  minMax: 90,  preco: 60,  nome: "10–15km / até 90min" },
];

// Nível de isenção (pelo env ISENCAO_NIVEL): 1=R$250, 2=R$250, 3=R$300, 4=R$400, 5=R$500, 6=R$500, 7=null (sem isenção)
const ISENCAO_NIVEIS = { 1:250, 2:250, 3:300, 4:400, 5:500, 6:500, 7:null };

// ------------------------ CORS ------------------------
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ------------------------ CACHE SIMPLES ------------------------
const mem = new Map();
const memo = (k,v)=>{ mem.set(k,{v,t:Date.now()}); return v; };
const getMemo = (k,ttl=30*60*1000)=>{
  const x=mem.get(k); if(!x) return null;
  if(Date.now()-x.t>ttl){ mem.delete(k); return null; }
  return x.v;
};

// ------------------------ NORMALIZAÇÃO DE ENDEREÇO ------------------------
/**
 * Regra solicitada:
 * - Se NÃO houver cidade explícita no texto, assume "Porto Alegre - RS, Brasil".
 * - Se houver cidade (ex.: ", Canoas", ", Gravataí", ", Novo Hamburgo"), usa a informada.
 * - Se mencionar Porto Alegre sem estado, completa com ", RS, Brasil".
 */
function normalizaEnderecoComCidade(text) {
  const raw = String(text||"").trim();
  if (!raw) return "Porto Alegre - RS, Brasil";

  const t = raw.replace(/\s+/g, " ");

  // já menciona Porto Alegre?
  if (/porto\s*alegre/i.test(t)) {
    return /(RS|Rio Grande do Sul)/i.test(t) ? t : `${t}, RS, Brasil`;
  }

  // heurística: existe uma "cidade" após vírgula no fim?
  // aceita: "..., Canoas", "..., Cachoeirinha - RS", "..., Novo Hamburgo, RS"
  const TEM_CIDADE = /,\s*([A-Za-zÀ-ÿ'.\-\s]{2,})(?:\s*-\s*[A-Za-z]{2})?(?:\s*,\s*Brasil)?\s*$/i;
  if (TEM_CIDADE.test(t)) return t;

  // sem cidade -> força Porto Alegre
  return `${t}, Porto Alegre - RS, Brasil`;
}

// ------------------------ ORS: GEOCODE ------------------------
async function geocodeORS(text){
  const key = process.env.ORS_API_KEY;
  if(!key) throw new Error("CONFIG: Defina ORS_API_KEY nas variáveis do Vercel.");
  const cacheKey = "geo:"+text.toLowerCase();
  const c = getMemo(cacheKey); if(c) return c;

  const url = "https://api.openrouteservice.org/geocode/search";
  const r = await fetch(`${url}?text=${encodeURIComponent(text)}&size=1&lang=pt`, {
    headers: { "Authorization": key }
  });
  if(!r.ok) throw new Error("GEOCODE_FAIL: "+r.status+" "+(await r.text()));
  const data = await r.json();
  const feat = data?.features?.[0];
  if(!feat) throw new Error("GEOCODE_EMPTY");
  const [lng,lat] = feat.geometry.coordinates;
  return memo(cacheKey, { lat, lng });
}

// ------------------------ ORS: ROUTE (HOTFIX) ------------------------
/**
 * HOTFIX: em rotas muito curtas, a duration em segundos pode ser tão baixa
 * que arredondar para baixo daria 0. Aqui usamos Math.ceil e forçamos min>=1.
 * Também validamos por tipo (number) em vez de checagem "truthy".
 */
async function orsRouteKmMin(origin, dest){
  const key = process.env.ORS_API_KEY;
  if(!key) throw new Error("CONFIG: Defina ORS_API_KEY nas variáveis do Vercel.");
  const prof = process.env.TRANSPORT_PROFILE || "driving-car";
  const url = `https://api.openrouteservice.org/v2/directions/${prof}`;
  const body = { coordinates: [[origin.lng, origin.lat], [dest.lng, dest.lat]], language:"pt" };

  const r = await fetch(url, {
    method:"POST",
    headers:{ "Authorization": key, "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });

  if(!r.ok) throw new Error("ROUTE_FAIL: "+r.status+" "+(await r.text()));
  const data = await r.json();
  const seg = data?.features?.[0]?.properties?.segments?.[0];

  if (typeof seg?.distance !== "number" || typeof seg?.duration !== "number") {
    throw new Error("ROUTE_EMPTY");
  }

  const km  = seg.distance / 1000;
  const min = Math.max(1, Math.ceil(seg.duration / 60)); // nunca 0

  return { km, min };
}

// ------------------------ PRECIFICAÇÃO ------------------------
function aplicaTabela(km,min){
  for(const r of PRICE_RULES){ if(km<=r.kmMax && min<=r.minMax) return { valorBase:r.preco, tier:r.nome }; }
  return { valorBase:null, tier:"FORA_DA_AREA" };
}

// ------------------------ HANDLER VERCEL ------------------------
export default async function handler(req,res){
  cors(res);
  if(req.method==="OPTIONS"){ res.status(200).end(); return; }

  try{
    if(req.method!=="POST") return res.status(405).json({error:"Use POST"});

    const body = typeof req.body==="string" ? JSON.parse(req.body) : (req.body||{});
    const { enderecoTexto, totalItens } = body;
    if(!enderecoTexto) return res.status(400).json({error:"enderecoTexto obrigatório"});

    const provider = (process.env.USE_PROVIDER||"ors").toLowerCase();
    if(provider!=="ors") return res.status(400).json({error:"Apenas ORS habilitado. Defina USE_PROVIDER=ors"});

    // Normalização de cidade (POA como default quando ausente)
    const enderecoNormalizado = normalizaEnderecoComCidade(enderecoTexto);

    // Origem (endereço da loja)
    const originAddress = process.env.ORIGIN_ADDRESS || "Porto Alegre - RS, Brasil";

    let origin, dest, rota;
    try { origin = await geocodeORS(originAddress); }
    catch(e){ return res.status(500).json({ status:"ERRO", step:"geocode_origin", error:String(e?.message||e) }); }

    try { dest = await geocodeORS(enderecoNormalizado); }
    catch(e){ return res.status(500).json({ status:"ERRO", step:"geocode_dest", error:String(e?.message||e) }); }

    try { rota = await orsRouteKmMin(origin, dest); }
    catch(e){ return res.status(500).json({ status:"ERRO", step:"route", error:String(e?.message||e) }); }

    const { km, min } = rota;
    const { valorBase, tier } = aplicaTabela(km, min);

    const nivel = Number(process.env.ISENCAO_NIVEL||"1");
    const isencaoMin = ISENCAO_NIVEIS[nivel] ?? null;
    const isento = (isencaoMin!=null) && (Number(totalItens)>=isencaoMin);
    const valorCobravel = isento ? 0 : valorBase;
    const labelIsencao  = isento ? `(ISENTO de frete – pedido ≥ R$ ${Number(isencaoMin).toFixed(2)})` : "";

    return res.status(200).json({
      status:"OK",
      km:+km.toFixed(2),
      min:Math.round(min),
      valorBase,
      valorCobravel,
      isento,
      labelIsencao,
      tier
    });
  }catch(e){
    console.error("ERRO FRETE:", e);
    const msg = String(e?.message || e);
    return res.status(500).json({ status:"ERRO", error: msg });
  }
}