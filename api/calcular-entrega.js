// api/calcular-entrega.js
const PRICE_RULES = [
  { kmMax: 1.5,   minMax: 10,  preco: 15,  nome: "0–1.5km / até 10min" },
  { kmMax: 3.0,   minMax: 20,  preco: 20,  nome: "1.501–3.0km / até 20min" },
  { kmMax: 4.5,   minMax: 30,  preco: 30,  nome: "3.01–4.5km / até 30min" },
  { kmMax: 6.99,  minMax: 45,  preco: 40,  nome: "4.5–6.99km / até 45min" },
  { kmMax: 9.99,  minMax: 60,  preco: 50,  nome: "7–9.99km / até 60min" },
  { kmMax: 15.0,  minMax: 90,  preco: 60,  nome: "10–15km / até 90min" },
];
const ISENCAO_NIVEIS = { 1:250, 2:250, 3:300, 4:400, 5:500, 6:500, 7:null };

const mem = new Map();
const memo = (k,v)=>{ mem.set(k,{v,t:Date.now()}); return v; };
const getMemo = (k,ttl=30*60*1000)=>{ const x=mem.get(k); if(!x) return null; if(Date.now()-x.t>ttl){mem.delete(k);return null;} return x.v; };

async function geocodeORS(text){
  const url = `https://api.openrouteservice.org/geocode/search?text=${encodeURIComponent(text)}&size=1`;
  const c = getMemo(url); if(c) return c;
  const r = await fetch(url, { headers:{ Authorization: process.env.ORS_API_KEY } });
  if(!r.ok) throw new Error(`Geocode ORS ${r.status}`);
  const j = await r.json(); const f = j.features?.[0];
  if(!f) throw new Error("Endereço não encontrado");
  const [lng,lat] = f.geometry.coordinates; return memo(url,{lat,lng});
}

async function routeORS(profile, origin, dest){
  const body = { coordinates:[[origin.lng,origin.lat],[dest.lng,dest.lat]] };
  const url  = `https://api.openrouteservice.org/v2/directions/${profile}`;
  const ck = url+JSON.stringify(body); const c = getMemo(ck); if(c) return c;
  const r = await fetch(url, {
    method:"POST",
    headers:{ Authorization:process.env.ORS_API_KEY, "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`Rota ORS ${r.status}`);
  const j = await r.json(); const s = j?.routes?.[0]?.summary;
  if(!s) throw new Error("Sem resumo de rota");
  const km = (s.distance||0)/1000, min = (s.duration||0)/60;
  return memo(ck,{km,min});
}

function aplicaTabela(km,min){
  for(const r of PRICE_RULES){ if(km<=r.kmMax && min<=r.minMax) return { valorBase:r.preco, tier:r.nome }; }
  return { valorBase:null, tier:"FORA_DA_AREA" };
}

export default async function handler(req,res){
  try{
    if(req.method!=="POST") return res.status(405).json({error:"Use POST"});
    const body = typeof req.body==="string" ? JSON.parse(req.body) : (req.body||{});
    const { enderecoTexto, totalItens } = body;
    if(!enderecoTexto) return res.status(400).json({error:"enderecoTexto obrigatório"});

    if((process.env.USE_PROVIDER||"ors").toLowerCase()!=="ors")
      return res.status(400).json({error:"Apenas ORS habilitado"});

    if(!process.env.ORS_API_KEY) throw new Error("ORS_API_KEY não configurado");
    const originAddress   = process.env.ORIGIN_ADDRESS;
    const transport       = process.env.TRANSPORT_PROFILE || "driving-car";
    const isencaoNivel    = parseInt(process.env.ISENCAO_NIVEL||"1",10);
    const isencaoMin      = ISENCAO_NIVEIS[isencaoNivel] ?? null;
    if(!originAddress) throw new Error("ORIGIN_ADDRESS não configurado");

    const [orig,dest] = await Promise.all([ geocodeORS(originAddress), geocodeORS(enderecoTexto) ]);
    const { km, min } = await routeORS(transport, orig, dest);
    const { valorBase, tier } = aplicaTabela(km,min);

    if(valorBase==null){
      return res.status(200).json({ status:"FORA_DA_AREA", km:+km.toFixed(2), min:Math.round(min),
        valorBase:null, valorCobravel:null, isento:false, labelIsencao:"VERIFICAR", tier });
    }

    const isento = (isencaoMin!=null) && (Number(totalItens)>=isencaoMin);
    const valorCobravel = isento ? 0 : valorBase;
    const labelIsencao  = isento ? "(ISENTO DE FRETE)" : "";

    return res.status(200).json({ status:"OK", km:+km.toFixed(2), min:Math.round(min),
      valorBase, valorCobravel, isento, labelIsencao, tier });
  }catch(e){
    console.error(e);
    return res.status(500).json({ status:"ERRO", error:String(e) });
  }
}
