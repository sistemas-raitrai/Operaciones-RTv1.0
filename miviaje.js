// miviaje.js — Visor público SOLO LECTURA (sin auth)
// - Busca grupo por ?id=<docId> o ?numeroNegocio= (acepta compuestos: 1475/1411, 1475-1411, "1475 y 1411"...)
// - Si hay varios, muestra selector con links ?id=
// - Botones: Copiar enlace / Imprimir. Flag &notas=0 oculta notas de actividades.
// - Hoja Resumen tipo documento (como la foto): Presentación, Vuelos (vía {aerolínea}),
//   Hotelería (con DIRECCIÓN), Documentos, Equipaje y Recomendaciones.
// - Vuelos y Hoteles se leen con los MISMO esquemas/colecciones que el portal de coordinadores.

import { app, db } from './firebase-core.js';
import {
  collection, doc, getDoc, getDocs, query, where, limit, orderBy, startAfter
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ──────────────────────────────────────────────────────────────────────────
   URL / Parámetros
────────────────────────────────────────────────────────────────────────── */
function getParamsFromURL() {
  const parts = location.pathname.split('/').filter(Boolean);
  const i = parts.findIndex(p => p.toLowerCase().includes('miviaje'));
  const seg = (i >= 0 && parts[i + 1]) ? decodeURIComponent(parts[i + 1]) : null;
  const qs = new URLSearchParams(location.search);
  const numeroKey = [...qs.keys()].find(k => k.toLowerCase() === 'numeronegocio');
  const numeroNegocio = (seg || (numeroKey ? qs.get(numeroKey) : '') || '').trim();
  const idKey = [...qs.keys()].find(k => k.toLowerCase() === 'id');
  const id = idKey ? (qs.get(idKey) || '').trim() : '';
  const hideNotes = qs.get('notas') === '0';
  return { numeroNegocio, id, hideNotes };
}
function splitNumeroCompuesto(v) {
  if (!v) return [];
  return String(v).split(/(?:\s*[\/,\-]\s*|\s+y\s+)/i).map(s => s.trim()).filter(Boolean);
}
function buildCompositeVariants(v) {
  const p = splitNumeroCompuesto(v); if (p.length < 2) return [];
  const seps = ['/', '-', ',']; const out = new Set();
  for (const s of seps){ out.add(p.join(s)); out.add(p.join(` ${s} `)); out.add(p.join(` ${s}`)); out.add(p.join(`${s} `)); }
  return [...out];
}

/* ──────────────────────────────────────────────────────────────────────────
   Utils de texto/fecha (compat con portal)
────────────────────────────────────────────────────────────────────────── */
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const safe = (v, fb='—') => (v===0||v)?v:fb;

function toISO(x){
  if (!x) return '';
  if (typeof x === 'string'){
    const t = x.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;          // YYYY-MM-DD
    if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {                  // DD-MM-AAAA
      const [dd, mm, yy] = t.split('-'); return `${yy}-${mm}-${dd}`;
    }
    const d = new Date(t); return isNaN(d) ? '' : d.toISOString().slice(0,10);
  }
  if (x && typeof x === 'object' && 'seconds' in x) return new Date(x.seconds*1000).toISOString().slice(0,10);
  if (x instanceof Date) return x.toISOString().slice(0,10);
  return '';
}
function normTime(t){
  if(!t) return '';
  const s=String(t).trim();
  if(/^\d{1,2}$/.test(s)) return s.padStart(2,'0')+':00';
  const m=s.match(/(\d{1,2})[:hH\.](\d{2})/); if(!m) return '';
  const h=String(Math.max(0,Math.min(23,parseInt(m[1],10)))).padStart(2,'0');
  const mi=String(Math.max(0,Math.min(59,parseInt(m[2],10)))).padStart(2,'0');
  return `${h}:${mi}`;
}
function formatShortDate(iso){ // 25 de septiembre 2025
  if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number);
  const dt=new Date(y,m-1,d); const mes=dt.toLocaleDateString('es-CL',{month:'long'});
  return `${d} de ${mes} ${y}`;
}
function formatDateReadable(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number); const dt=new Date(y,m-1,d); const wd=dt.toLocaleDateString('es-CL',{weekday:'long'}); const name=wd.charAt(0).toUpperCase()+wd.slice(1); return `${name} ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`; }
function formatDateRange(ini,fin){ if(!ini||!fin) return '—'; return `${formatShortDate(toISO(ini))} — ${formatShortDate(toISO(fin))}`; }
function getDateRange(s,e){ const out=[]; const A=toISO(s), B=toISO(e); if(!A||!B) return out; const a=new Date(A), b=new Date(B); for(let d=new Date(a); d<=b; d.setDate(d.getDate()+1)){ out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);} return out; }

/* ──────────────────────────────────────────────────────────────────────────
   Firestore: Grupo por id/numero
────────────────────────────────────────────────────────────────────────── */
async function fetchGrupoById(id) {
  if (!id) return null;
  const s = await getDoc(doc(db, 'grupos', id));
  return s.exists() ? { id:s.id, ...s.data() } : null;
}
async function buscarGruposPorNumero(numeroNegocio) {
  if (!numeroNegocio) return [];
  const vistos = new Map(); const push = snap => snap.forEach(d => vistos.set(d.id, { id:d.id, ...d.data() }));
  let snap = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',numeroNegocio), limit(10))); push(snap);
  for (const v of buildCompositeVariants(numeroNegocio)) {
    const s = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',v), limit(10))); push(s);
  }
  const asNum = Number(numeroNegocio);
  if (!Number.isNaN(asNum)) { snap = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',asNum), limit(10))); push(snap); }
  for (const p of splitNumeroCompuesto(numeroNegocio)) {
    const s1 = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',p), limit(10))); push(s1);
    const pn = Number(p); if (!Number.isNaN(pn)) {
      const s2 = await getDocs(query(collection(db,'grupos'), where('numeroNegocio','==',pn), limit(10))); push(s2);
    }
  }
  return [...vistos.values()];
}

/* ──────────────────────────────────────────────────────────────────────────
   CACHES ligeros para este visor
────────────────────────────────────────────────────────────────────────── */
const cache = {
  hotelesIndex: null,              // { loaded, byId:Map, bySlug:Map, all:[] }
  hotelesByGroup: new Map(),       // key → [assignments…]
  vuelosByGroup: new Map()         // key → [docs…]
};

/* ───────────────── HOTELS (igual lógica que portal) ──────────────────── */
async function ensureHotelesIndex(){
  if (cache.hotelesIndex) return cache.hotelesIndex;
  const byId=new Map(), bySlug=new Map(), all=[];
  const snap = await getDocs(collection(db,'hoteles'));
  snap.forEach(d=>{
    const x=d.data()||{};
    const docu={ id:d.id, ...x };
    const slug = norm(x.slug || x.nombre || d.id);
    byId.set(String(d.id), docu);
    if (slug) bySlug.set(slug, docu);
    all.push(docu);
  });
  cache.hotelesIndex = { loaded:true, byId, bySlug, all };
  return cache.hotelesIndex;
}
async function loadHotelesInfo(g){
  const groupDocId = String(g.id||'').trim();
  const groupNum   = String(g.numeroNegocio||'').trim();
  const key = `hoteles:${groupDocId||groupNum}`;
  if (cache.hotelesByGroup.has(key)) return cache.hotelesByGroup.get(key);

  let cand=[];
  try{
    if (groupDocId){
      const q1 = await getDocs(query(collection(db,'hotelAssignments'), where('grupoId','==',groupDocId)));
      q1.forEach(d=> cand.push({ id:d.id, ...(d.data()||{}) }));
    }
  }catch(_){}
  try{
    if (!cand.length && groupDocId){
      const q2 = await getDocs(query(collection(db,'hotelAssignments'), where('grupoDocId','==',groupDocId)));
      q2.forEach(d=> cand.push({ id:d.id, ...(d.data()||{}) }));
    }
  }catch(_){}
  try{
    if (!cand.length && groupNum){
      const q3 = await getDocs(query(collection(db,'hotelAssignments'), where('grupoNumero','==',groupNum)));
      q3.forEach(d=> cand.push({ id:d.id, ...(d.data()||{}) }));
    }
  }catch(_){}

  cand.sort((a,b)=> (toISO(a.checkIn)||'').localeCompare(toISO(b.checkIn)||''));

  const { byId, bySlug, all } = await ensureHotelesIndex();
  const pickHotelDoc = (asig)=>{
    const tryIds=[];
    if (asig?.hotelId) tryIds.push(String(asig.hotelId));
    if (asig?.hotelDocId) tryIds.push(String(asig.hotelDocId));
    if (asig?.hotel?.id) tryIds.push(String(asig.hotel.id));
    if (asig?.hotelRef && typeof asig.hotelRef==='object' && 'id' in asig.hotelRef) tryIds.push(String(asig.hotelRef.id));
    if (asig?.hotelPath && typeof asig.hotelPath==='string'){ const m=asig.hotelPath.match(/hoteles\/([^/]+)/i); if(m) tryIds.push(m[1]); }
    for (const id of tryIds){ if (byId.has(id)) return byId.get(id); }

    const s = norm(asig?.nombre || asig?.hotelNombre || '');
    const dest = norm(g.destino||'');
    if (s && bySlug.has(s)) return bySlug.get(s);
    if (s){
      const cands=[]; for (const [slug,docu] of bySlug){ if (slug.includes(s)||s.includes(slug)) cands.push(docu); }
      if (cands.length === 1) return cands[0];
      return cands.find(d => norm(d.destino||d.ciudad||'')===dest) || cands[0] || null;
    }
    // fallback por destino
    const cands2 = all.filter(h => norm(h.destino||h.ciudad||'')===dest);
    return cands2[0] || null;
  };

  const out = cand.map(a=>{
    const H = pickHotelDoc(a);
    const ci = toISO(a.checkIn), co = toISO(a.checkOut);
    let noches = a.noches;
    if (noches==null && ci && co){
      noches = Math.max(0, (new Date(co)-new Date(ci))/86400000);
    }
    return {
      ...a,
      hotel:H,
      hotelNombre:a?.hotelNombre || a?.nombre || H?.nombre || '',
      checkIn:ci, checkOut:co, noches
    };
  });

  cache.hotelesByGroup.set(key,out);
  return out;
}

/* ───────────────── FLIGHTS (igual lógica que portal) ──────────────── */
function normalizeVuelo(v){
  const get=(...keys)=>{ for(const k of keys){ const val=k.split('.').reduce((acc,part)=> (acc && acc[part]!==undefined)? acc[part] : undefined, v); if(val!==undefined && val!==null && val!=='') return val; } return ''; };
  const numero    = get('numero','nro','numVuelo','vuelo','flightNumber','codigo','code');
  const proveedor = get('proveedor','empresa','aerolinea','compania');
  const tipoTransporte = (String(get('tipoTransporte')) || 'aereo').toLowerCase() || 'aereo';
  const tipoVuelo = (tipoTransporte==='aereo') ? (String(get('tipoVuelo')||'charter').toLowerCase()) : '';
  const presentacionIdaHora    = normTime(get('presentacionIdaHora'));
  const vueloIdaHora           = normTime(get('vueloIdaHora'));
  const presentacionVueltaHora = normTime(get('presentacionVueltaHora'));
  const vueloVueltaHora        = normTime(get('vueloVueltaHora'));
  const idaHora    = normTime(get('idaHora'));
  const vueltaHora = normTime(get('vueltaHora'));
  const origen      = get('origen','desde','from','salida.origen','salida.iata','origenIATA','origenSigla','origenCiudad');
  const destino     = get('destino','hasta','to','llegada.destino','llegada.iata','destinoIATA','destinoSigla','destinoCiudad');
  const fechaIda    = toISO(get('fechaIda','ida','salida.fecha','fechaSalida','fecha_ida','fecha'));
  const fechaVuelta = toISO(get('fechaVuelta','vuelta','regreso.fecha','fechaRegreso','fecha_vuelta'));

  const tr = Array.isArray(v.tramos) ? v.tramos : [];
  const tramos = tr.map(t=>({
    aerolinea: String(t.aerolinea||'').toUpperCase(),
    numero:    String(t.numero||'').toUpperCase(),
    origen:    String(t.origen||'').toUpperCase(),
    destino:   String(t.destino||'').toUpperCase(),
    fechaIda:  toISO(t.fechaIda||''),
    fechaVuelta: toISO(t.fechaVuelta||''),
    presentacionIdaHora:    normTime(t.presentacionIdaHora||''),
    vueloIdaHora:           normTime(t.vueloIdaHora||''),
    presentacionVueltaHora: normTime(t.presentacionVueltaHora||''),
    vueloVueltaHora:        normTime(t.vueloVueltaHora||''),
  }));

  return {
    numero, proveedor, tipoTransporte, tipoVuelo,
    origen, destino, fechaIda, fechaVuelta,
    presentacionIdaHora, vueloIdaHora, presentacionVueltaHora, vueloVueltaHora,
    idaHora, vueltaHora, tramos
  };
}

// === Helper: particiona vuelos en IDA/VUELTA (aéreos) y TERRESTRES ===
function particionarVuelos(vuelosNorm) {
  const aereos = [];
  const terrestres = [];

  const esTerrestre = (v) => (String(v.tipoTransporte || '').toLowerCase() !== 'aereo');

  const legFrom = (v, t = {}) => {
    const aerolinea = String(t.aerolinea || v.proveedor || '').toUpperCase();
    const numero    = String(t.numero    || v.numero    || '').toUpperCase();
    const desde     = String(t.origen    || v.origen    || '').toUpperCase();
    const hasta     = String(t.destino   || v.destino   || '').toUpperCase();

    const fechaIda       = toISO(t.fechaIda       || v.fechaIda       || '');
    const fechaVuelta    = toISO(t.fechaVuelta    || v.fechaVuelta    || '');
    const presentacionIda    = normTime(t.presentacionIdaHora    || v.presentacionIdaHora    || '');
    const presentacionVuelta = normTime(t.presentacionVueltaHora || v.presentacionVueltaHora || '');
    const salidaIda          = normTime(t.vueloIdaHora           || v.vueloIdaHora           || '');
    const salidaVuelta       = normTime(t.vueloVueltaHora        || v.vueloVueltaHora        || '');

    const fecha = toISO(fechaIda || fechaVuelta || '');

    return {
      fecha, fechaIda, fechaVuelta,
      aerolinea, numero, desde, hasta,
      presentacionIda, presentacionVuelta,
      salidaIda, salidaVuelta,
      tipoTransporte: v.tipoTransporte || 'aereo'
    };
  };

  for (const v of (vuelosNorm || [])) {
    if (esTerrestre(v)) {
      if (Array.isArray(v.tramos) && v.tramos.length) v.tramos.forEach(t => terrestres.push(legFrom(v, t)));
      else terrestres.push(legFrom(v, {}));
    } else {
      if (Array.isArray(v.tramos) && v.tramos.length) v.tramos.forEach(t => aereos.push(legFrom(v, t)));
      else aereos.push(legFrom(v));
    }
  }

  aereos.sort((x, y) => (x.fecha || '').localeCompare(y.fecha || ''));

  const fechasA = aereos.map(l => l.fecha).filter(Boolean).sort();
  const idaDate = fechasA[0] || '';
  const vueltaDate = fechasA[fechasA.length - 1] || '';

  const idaLegs    = idaDate    ? aereos.filter(l => (l.fechaIda || l.fecha)    === idaDate)    : [];
  const vueltaLegs = vueltaDate ? aereos.filter(l => (l.fechaVuelta || l.fecha) === vueltaDate) : [];

  const U = s => String(s||'').toUpperCase();
  const hasColegioToAeropuerto = terrestres.some(t => U(t.desde).includes('COLEGIO') && U(t.hasta).includes('AEROPUERTO'));
  const hasAeropuertoToColegio = terrestres.some(t => U(t.desde).includes('AEROPUERTO') && U(t.hasta).includes('COLEGIO'));

  return { idaLegs, vueltaLegs, terrestres, hasColegioToAeropuerto, hasAeropuertoToColegio };
}

async function loadVuelosInfo(g){
  const docId=String(g.id||'').trim(); const num=String(g.numeroNegocio||'').trim();
  const key=`vuelos:${docId||num}`; if(cache.vuelosByGroup.has(key)) return cache.vuelosByGroup.get(key);
  let found=[];
  try{ if(docId){ const qs1=await getDocs(query(collection(db,'vuelos'), where('grupoIds','array-contains',docId))); qs1.forEach(d=>found.push({id:d.id,...(d.data()||{})})); } }catch(_){}
  try{ if(!found.length && num){ const qs2=await getDocs(query(collection(db,'vuelos'), where('grupoIds','array-contains',num))); qs2.forEach(d=>found.push({id:d.id,...(d.data()||{})})); } }catch(_){}
  if(!found.length){
    // Fallback general (evita paginar infinito: trae primeras 200 por fecha desc)
    let last=null, loops=0; const base=collection(db,'vuelos');
    while(loops++<4){ const q = last ? query(base, orderBy('fechaIda','desc'), startAfter(last), limit(50)) : query(base, orderBy('fechaIda','desc'), limit(50));
      const snap=await getDocs(q); if(!snap.size) break; snap.forEach(d=>{
        const v=d.data()||{}; let match=false;
        if(Array.isArray(v.grupos)){
          match = v.grupos.some(x=>{
            if(typeof x==='string') return (docId && x===docId)||(num && x===num);
            if(x && typeof x==='object'){ const xid=String(x.id||x.grupoId||'').trim(); const xnum=String(x.numeroNegocio||x.numNegocio||'').trim(); return (docId && xid===docId)||(num && xnum===num); }
            return false;
          });
        }
        if(!match){
          const rootId=String(v.grupoId||'').trim();
          const rootNum=String(v.grupoNumero||v.numeroNegocio||'').trim();
          match = (docId && rootId===docId) || (num && rootNum===num);
        }
        if(match) found.push({id:d.id,...v});
      });
      last=snap.docs[snap.docs.length-1];
    }
  }
  found.sort((a,b)=>(toISO(a.fechaIda)||'').localeCompare(toISO(b.fechaIda)||''));
  cache.vuelosByGroup.set(key,found);
  return found;
}

/* ──────────────────────────────────────────────────────────────────────────
   UI: selector si hay múltiples grupos
────────────────────────────────────────────────────────────────────────── */
function renderSelector(lista, cont, hideNotes){
  cont.innerHTML = `
    <div style="padding:1rem;">
      <h3>Selecciona tu grupo (${lista.length} encontrados):</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:8px;">
        ${lista.map(g=>`
          <a class="activity-card" style="display:block;padding:12px;text-decoration:none;border:1px solid #ddd;border-radius:12px"
             href="?id=${encodeURIComponent(g.id)}${hideNotes?'&notas=0':''}">
            <div style="font-weight:700;margin-bottom:4px;">${(g.nombreGrupo||'—')}</div>
            <div>Programa: ${(g.programa||'—')}</div>
            <div>N° Negocio: ${(g.numeroNegocio??g.id)}</div>
            <div>Fechas: ${(g.fechaInicio||'—')} — ${(g.fechaFin||'—')}</div>
          </a>
        `).join('')}
      </div>
    </div>`;
}

/* ──────────────────────────────────────────────────────────────────────────
   Hoja estilo “foto” (usa datos reales del portal)
────────────────────────────────────────────────────────────────────────── */
function extractPresentacion(grupo, vuelosNorm){
  const { idaLegs, hasColegioToAeropuerto } = particionarVuelos(vuelosNorm);

  let lugar = grupo.presentacionLugar || '';
  let hora  = normTime(grupo.presentacionHora || grupo.horaPresentacion || '');

  const primeraIda = idaLegs[0];
  let aeropuerto = grupo.presentacionAeropuerto || (primeraIda ? primeraIda.desde : '');

  if (!lugar) {
    lugar = hasColegioToAeropuerto
      ? 'En las puertas del Colegio'
      : (primeraIda ? 'En el aeropuerto' : 'Punto de encuentro');
  }

  // Si no hay hora explícita en el grupo, usa la HORA DE PRESENTACIÓN de la IDA (no la salida del vuelo)
  if (!hora && primeraIda) {
    hora = primeraIda.presentacionIda || primeraIda.salidaIda || '';
  }

  return { lugar, aeropuerto, hora };
}

// === Textos DOCUMENTOS / EQUIPAJE / RECOMENDACIONES según programa ===
function getDERTextos(programa, overrides = {}) {
  // Normaliza: sin tildes, minúsculas
  const P = norm(programa || '');

  // Base equipaje (común a todos)
  const equipajeText1 =
    overrides.equipaje1 ||
    'Equipaje en bodega 01 Maleta (peso máximo 23 kg.) el cual debe tener como medidas máximo 158 cm lineales (largo, ancho, alto), más un bolso de mano. (peso máximo 5 Kg.)';
  const equipajeText2 =
    overrides.equipaje2 ||
    'Está prohibido transportar líquidos, elementos corto-punzantes o de aseo en el bolso de mano.';

    // ====== BARILOCHE / BRASIL ======
  if (/(^|[\W])(bariloche|brasil)(?=$|[\W])/.test(P)) {
    const docsText =
      overrides.documentos ||
      [
        {
          title: 'NACIONALES',
          items: [
            'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).',
            'Verificar que la autorización notarial esté con los datos correctos de Nombres / Rut, la cédula de identidad debe estar en óptimas condiciones para que los pasajeros no tengan problemas para salir del país (según detalle de normativa entregada con anticipación a los encargados del grupo).'
          ]
        },
        {
          title: 'EXTRANJEROS',
          items: [
            'Verificar que Cédula de Identidad Chilena y Pasaporte de origen, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).',
            'Verificar con consulado de país de destino detalle de requerimientos para el ingreso y salida del país para menores no acompañados desde Chile. Es de absoluta responsabilidad de los tutores del menor encargarse de la correcta documentación para el viaje.'
          ]
        }
      ];
    const recs =
      overrides.recomendaciones || [
        'Llevar ropa y calzado, cómodo, adecuado a Clima del Destino. Llevar protector solar',
        'Llevar una botella reutilizable para el consumo de agua',
        'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida',
        'Las pertenencias personales son de responsabilidad exclusiva de cada persona, se recomienda que los elementos de valor queden en sus domicilios',
        'Se recomienda que los adultos acompañantes tengan una fotocopia de las Cédulas de Identidad de todos los pasajeros o documento que corresponda.'
      ];
    return { docsText, equipajeText1, equipajeText2, recs };
  }


  // ====== HUILO HUILO ======
  // Tolera "huilo-huilo", "huilo  huilo", etc.
  if (/huilo\W*huilo/.test(P)) {
    const docsText =
      overrides.documentos ||
      'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).';
    const recs =
      overrides.recomendaciones || [
        'Llevar ropa y calzado, cómodo, adecuado a Clima del Destino. Llevar protector solar',
        'Llevar una botella reutilizable para el consumo de agua',
        'Llevar Saco de Dormir',
        'Llevar toalla, Shampoo y Jabón (Huilo Huilo NO INCLUYE TOALLAS NI AMENIDADES)',
        'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida',
        'Las pertenencias personales son de responsabilidad exclusiva de cada persona, se recomienda que los elementos de valor queden en sus domicilios',
        'Se recomienda que los adultos acompañantes tengan una fotocopia de las Cédulas de Identidad de todos los pasajeros.'
      ];
    return { docsText, equipajeText1, equipajeText2, recs };
  }

  // ====== SUR / NORTE DE CHILE (y fallback) ======
  if (/(sur\W*de\W*chile|norte\W*de\W*chile)/.test(P) || true) {
    const docsText =
      overrides.documentos ||
      'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).';
    const recs =
      overrides.recomendaciones || [
        'Llevar ropa y calzado, cómodo, adecuado a Clima del Destino. Llevar protector solar',
        'Llevar una botella reutilizable para el consumo de agua',
        'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida',
        'Las pertenencias personales son de responsabilidad exclusiva de cada persona, se recomienda que los elementos de valor queden en sus domicilios',
        'Se recomienda que los adultos acompañantes tengan una fotocopia de las Cédulas de Identidad de todos los pasajeros.'
      ];
    return { docsText, equipajeText1, equipajeText2, recs };
  }
}

function renderDocsList(docsText) {
  if (Array.isArray(docsText)) {
    // ¿Array de secciones {title, items[]}?
    if (docsText.length && typeof docsText[0] === 'object' && Array.isArray(docsText[0].items)) {
      return docsText.map(sec => `
        <li>
          <div><strong>${sec.title}:</strong></div>
          <ul style="margin:4px 0 0 18px;list-style:disc;">
            ${sec.items.map(it => `<li>${it}</li>`).join('')}
          </ul>
        </li>`).join('');
    }
    // Si es array de strings, cada uno es un bullet simple
    return docsText.map(t => `<li>${t}</li>`).join('');
  }
  // String plano
  return `<li>${docsText}</li>`;
}

function renderHojaResumen(grupo, vuelosNorm, hoteles){
  let hoja = document.getElementById('hoja-resumen');
  if(!hoja){
    hoja = document.createElement('section');
    hoja.id = 'hoja-resumen';
    hoja.style.cssText='background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:14px;margin:12px 0;';
    const cont = document.getElementById('itin-slot') || document.getElementById('mi-itin');
    cont?.parentNode?.insertBefore(hoja, cont);
  }

  const colegio = grupo.colegio || grupo.cliente || '';
  const curso   = grupo.curso || grupo.subgrupo || grupo.nombreGrupo || '';
  const titulo  = (colegio || curso)
    ? `Viaje de Estudios ${colegio ? colegio : ''} ${curso ? curso : ''}`.trim()
    : `Viaje de Estudios ${grupo.programa||''}`.trim();
  const fechaViaje = grupo.fechaInicio ? formatShortDate(grupo.fechaInicio) : (grupo.fecha || '');

  // Presentación (con fallback a horarios del vuelo)
  const pres = extractPresentacion(grupo, vuelosNorm);
  const presLine = `${pres.lugar}${pres.hora ? ` a las ${pres.hora} hrs.` : ''} ${pres.aeropuerto ? `para salir con destino al aeropuerto ${pres.aeropuerto}.` : ''}`;

  // Tabla de vuelos (IDA/VUELTA + TRAMO TERRESTRE) — muestra TODOS los tramos
  const { idaLegs, vueltaLegs, hasColegioToAeropuerto, hasAeropuertoToColegio } = particionarVuelos(vuelosNorm);
  
  const makeRows = (legs, modo) => legs.map(r => {
  const fecha = (modo === 'ida') ? (r.fechaIda || r.fecha) : (r.fechaVuelta || r.fecha);
  const presentacion = (modo === 'ida') ? r.presentacionIda : r.presentacionVuelta;
  const salida       = (modo === 'ida') ? r.salidaIda       : r.salidaVuelta;

  return `
    <tr>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">
        ${fecha ? formatShortDate(fecha) : '—'}
        ${r.aerolinea ? `<div style="font-size:.85em;color:#374151;">vía ${r.aerolinea}</div>` : ''}
      </td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(r.numero)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(r.desde)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(presentacion)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(salida)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(r.hasta)}</td>
    </tr>`;
}).join('');

const leyendas = [];
if (hasColegioToAeropuerto) leyendas.push('Este grupo contempla traslado COLEGIO → AEROPUERTO.');
if (hasAeropuertoToColegio) leyendas.push('Este grupo contempla traslado AEROPUERTO → COLEGIO.');
const terrestreNote = leyendas.length ? `<div style="margin-top:6px;font-size:.9em;opacity:.8;">${leyendas.join(' ')}</div>` : '';

const hasAereos = idaLegs.length || vueltaLegs.length;
const vuelosHTML = (hasAereos) ? `
  <div style="overflow:auto;margin-top:6px;">
    <table style="border-collapse:collapse;min-width:560px;">
      <thead>
        <tr>
          <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
          <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">N° de Vuelo</th>
          <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Desde</th>
          <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Presentación</th>
          <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de Salida</th>
          <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hasta</th>
        </tr>
      </thead>
      <tbody>
        ${ idaLegs.length ? `
          <tr><td colspan="6" style="padding:6px 8px;border:1px solid #d1d5db;background:#fafafa;font-weight:700;">IDA (aéreo)</td></tr>
          ${makeRows(idaLegs, 'ida')}
        ` : ''}

        ${ vueltaLegs.length ? `
          <tr><td colspan="6" style="padding:6px 8px;border:1px solid #d1d5db;background:#fafafa;font-weight:700;">VUELTA (aéreo)</td></tr>
          ${makeRows(vueltaLegs, 'vuelta')}
        ` : ''}
      </tbody>
    </table>
    ${terrestreNote}
  </div>
` : `<div style="opacity:.7;">— Sin información de vuelos —</div>`;




  // Hotelería (incluye DIRECCIÓN)
  const hotelesHtml = (hoteles||[]).map(h=>{
    const H = h.hotel || {};
    const ciudad = (H.ciudad || H.destino || h.ciudad || '').toString().toUpperCase();
    const dir    = (H.direccion || h.direccion || '').toString();
    return `
      <div style="display:flex;gap:16px;align-items:flex-start;">
        <div style="width:120px;font-weight:700;">${safe(ciudad,'—')}</div>
        <div>
          <div style="font-weight:700;">${safe(h.hotelNombre || H.nombre || '')}</div>
          <div>In : ${safe(h.checkIn)}</div>
          <div>Out: ${safe(h.checkOut)}</div>
          ${dir ? `<div>Dirección: ${dir}</div>` : ''}
          ${H.contactoTelefono?`<div>Fono: <a href="tel:${H.contactoTelefono}">${H.contactoTelefono}</a></div>`:''}
          ${H.web?`<div>Web: <a href="${H.web}" target="_blank" rel="noopener">${H.web}</a></div>`:''}
        </div>
      </div>`;
  }).join('<hr style="border:none;border-top:1px dashed #e5e7eb;margin:6px 0;">');

  // Textos por defecto (pueden venir desde grupo.textos)
  // Textos por PROGRAMA (con override si vienen en grupo.textos)
  const { docsText, equipajeText1, equipajeText2, recs } =
    getDERTextos(`${grupo.programa || ''} ${grupo.destino || ''}`, grupo.textos || {});


  console.debug('Programa normalizado:', norm(`${grupo.programa || ''} ${grupo.destino || ''}`));


  hoja.innerHTML = `
    <div style="text-align:center;margin-bottom:10px;">
      <div style="font-size:20px;font-weight:800;">${titulo}</div>
      <div style="font-size:14px;margin-top:2px;">Fecha Viaje: ${fechaViaje}</div>
    </div>

    <ol style="padding-left:18px;margin:0;">
      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">CONFIRMACIÓN DE HORARIO DE SALIDA</div>
        <div>Presentación: ${presLine}</div>
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">INFORMACIÓN DE VUELOS CONFIRMADOS</div>
        ${vuelosHTML}
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">HOTELERÍA CONFIRMADA</div>
        ${hoteles && hoteles.length ? `<div style="margin-top:6px;display:grid;gap:8px;">${hotelesHtml}</div>` : `<div style="opacity:.7;">— Sin hotelería cargada —</div>`}
      </li>

      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">DOCUMENTOS PARA EL VIAJE</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          ${renderDocsList(docsText)}
        </ul>
      </li>


      <li style="margin-bottom:10px;">
        <div style="font-weight:700;">EQUIPAJE</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          <li>${equipajeText1}</li>
          <li>${equipajeText2}</li>
        </ul>
      </li>

      <li style="margin-bottom:6px;">
        <div style="font-weight:700;">RECOMENDACIONES GENERALES</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          ${Array.isArray(recs) ? recs.map(r=>`<li>${r}</li>`).join('') : `<li>${recs}</li>`}
        </ul>
      </li>

      <!-- ITINERARIO DE VIAJE -->
      <li style="margin-bottom:6px;">
        <div style="font-weight:700;">ITINERARIO DE VIAJE</div>
        <div id="itin-slot" style="margin-top:6px;"></div>
      </li>
    </ol>

    <div style="text-align:center;font-weight:800;margin-top:12px;">
      ¡¡ TURISMO RAITRAI LES DESEA UN VIAJE INOLVIDABLE !!
   </div>
  `;
}

/* ──────────────────────────────────────────────────────────────────────────
   Impresión (texto plano) – mismo formato que ya ocupabas
────────────────────────────────────────────────────────────────────────── */
function buildPrintText(grupo, fechas){
  let out='';
  out += `PROGRAMA: ${(grupo.programa||'—').toString().toUpperCase()}\n`;
  out += `GRUPO: ${grupo.nombreGrupo||'—'}\n`;
  out += `N° NEGOCIO: ${grupo.numeroNegocio??grupo.id??'—'}\n`;
  out += `DESTINO: ${grupo.destino||'—'}\n`;
  out += `FECHAS: ${formatDateRange(grupo.fechaInicio, grupo.fechaFin)}\n\n`;

  fechas.forEach((f,i)=>{
    out+=`Día ${i+1} – ${formatDateReadable(f)}\n`;
    const src = grupo.itinerario?.[f];
    const arr = (Array.isArray(src)?src:(src && typeof src==='object'?Object.values(src):[]))
      .sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));
    if(!arr.length){ out+='— Sin actividades —\n\n'; return; }
    arr.forEach(act=>{
      const hi=normTime(act.horaInicio)||'--:--', hf=normTime(act.horaFin), rango=hf?` – ${hf}`:'';
      const name=(act.actividad||'').toString().toUpperCase();
      const a=parseInt(act.adultos,10)||0, e=parseInt(act.estudiantes,10)||0, pax=(a+e)||act.pasajeros||0;
      out+=`${hi}${rango}  ${name}${pax?` 👥 ${pax} pax`:''}\n\n`;
    });
    out+='\n';
  });
  return out.trimEnd();
}

/* ──────────────────────────────────────────────────────────────────────────
   Render del itinerario visual (tarjetas)
────────────────────────────────────────────────────────────────────────── */
function renderItin(grupo, fechas, hideNotes, targetEl){
  // 1) Construimos todas las tarjetas de día en memoria
  const diasSecs = [];
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.style.minWidth = '0';
    sec.style.maxWidth = 'unset';
    sec.style.flex = 'unset';
    sec.dataset.fecha = fecha;

    const ulId = `acts-${idx}`;
    sec.innerHTML = `
      <h3 class="dia-titulo">
        <span class="dia-label">Día ${idx+1}</span> – 
        <span class="dia-fecha">${formatDateReadable(fecha)}</span>
      </h3>
      <ul id="${ulId}" class="activity-list"></ul>
    `;

    const ul = sec.querySelector('#'+ulId);
    const src = grupo.itinerario?.[fecha];
    const arr = (Array.isArray(src)?src:(src && typeof src==='object'?Object.values(src):[]))
      .sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach(act=>{
        const li=document.createElement('li');
        li.className='activity-card';
        const notesHtml = (!hideNotes && act.notas) ? `<p style="opacity:.85;">📝 ${act.notas}</p>` : '';
        li.innerHTML = `<p><strong>${(act.actividad||'').toString().toUpperCase()}</strong></p>${notesHtml}`;
        ul.appendChild(li);
      });
    }
    diasSecs.push(sec);
  });

  // 2) Preparamos el contenedor 2 filas (4 arriba + resto abajo)
  const wrap = document.createElement('div'); 
  wrap.className = 'dias-embebidas';

  const filaTop = document.createElement('div'); 
  filaTop.className = 'fila fila-top';

  const filaBottom = document.createElement('div'); 
  filaBottom.className = 'fila fila-bottom';

  wrap.appendChild(filaTop); 
  wrap.appendChild(filaBottom);

  const n = diasSecs.length;
  const topCount = Math.min(4, n);
  const bottomCount = Math.max(0, n - topCount);

  filaTop.style.display = filaBottom.style.display = 'grid';
  filaTop.style.gap = filaBottom.style.gap = '12px';
  filaTop.style.gridTemplateColumns    = `repeat(${Math.max(1, topCount)}, minmax(220px, 1fr))`;
  filaBottom.style.gridTemplateColumns = `repeat(${Math.max(1, bottomCount)}, minmax(220px, 1fr))`;
  if (!bottomCount) filaBottom.style.display = 'none';

  diasSecs.forEach((sec, i)=> (i < topCount ? filaTop : filaBottom).appendChild(sec));

  // 3) Insertamos ANTES de “¡¡ TURISMO RAITRAI… !!” si existe, o reemplazamos el slot
  const caja = document.getElementById('hoja-resumen');
  let ancla = null;
  if (caja){
    ancla = Array.from(caja.querySelectorAll('*'))
      .find(n => /TURISMO\s+RAITRAI\s+LES\s+DESEA/i.test(n.textContent || ''));
  }

  // limpio cualquier carrusel/overflow previo del target
  const cont = targetEl || document.getElementById('mi-itin');
  if (cont){
    cont.innerHTML = '';
    cont.style.overflow = 'visible';
    cont.style.overflowX = 'visible';
    cont.querySelectorAll('input[type="range"], [role="scrollbar"], .scrollbar, .x-scroll, .slider, .scroll-track, .scroll-thumb')
        .forEach(el => el.remove());
  }

  if (caja && ancla && ancla.parentElement){
    ancla.parentElement.insertBefore(wrap, ancla);
    // si había #itin-slot, lo quitamos para que no duplique
    if (targetEl) targetEl.remove();
  } else if (cont) {
    cont.appendChild(wrap); // fallback: lo mostramos en #mi-itin
  } else {
    // última red: lo metemos al body
    document.body.appendChild(wrap);
  }
}


function embedItinIntoResumen(){
  const caja = document.getElementById('hoja-resumen');
  const slot = document.getElementById('itin-slot') || document.getElementById('mi-itin');
  if (!caja || !slot) return;

  const dias = Array.from(slot.querySelectorAll('.dia-seccion'));
  if (!dias.length) return;

  // 🔧 desactivar carrusel/slider heredado
  slot.querySelectorAll('input[type="range"], [role="scrollbar"], .scrollbar, .x-scroll, .slider, .scroll-track, .scroll-thumb')
      .forEach(el => el.remove());
  slot.style.overflow = 'visible';
  slot.style.overflowX = 'visible';

  // contenedor embebido
  caja.querySelector('.dias-embebidas')?.remove();
  const wrap = document.createElement('div'); wrap.className = 'dias-embebidas';
  const filaTop = document.createElement('div'); filaTop.className = 'fila fila-top';
  const filaBottom = document.createElement('div'); filaBottom.className = 'fila fila-bottom';
  wrap.appendChild(filaTop); wrap.appendChild(filaBottom);

  // 📐 Distribución: SIEMPRE 4 arriba, resto abajo
  const n = dias.length;
  const topCount = Math.min(4, n);
  const bottomCount = Math.max(0, n - topCount);

  filaTop.style.display = filaBottom.style.display = 'grid';
  filaTop.style.gap = filaBottom.style.gap = '12px';
  filaTop.style.gridTemplateColumns    = `repeat(${topCount}, minmax(220px, 1fr))`;
  filaBottom.style.gridTemplateColumns = `repeat(${Math.max(1, bottomCount)}, minmax(220px, 1fr))`;
  if (!bottomCount) filaBottom.style.display = 'none';

  dias.forEach((d, i) => (i < topCount ? filaTop : filaBottom).appendChild(d));

  // Insertar antes del “¡¡ TURISMO RAITRAI … !!”
  const ancla = Array.from(caja.querySelectorAll('*'))
    .find(n => /TURISMO\s+RAITRAI\s+LES\s+DESEA/i.test(n.textContent || ''));
  (ancla?.parentElement || caja).insertBefore(wrap, ancla || null);

  // Vacía el slot original
  slot.innerHTML = '';
}

/* ──────────────────────────────────────────────────────────────────────────
   MAIN
────────────────────────────────────────────────────────────────────────── */
async function main(){
  const { numeroNegocio, id, hideNotes } = getParamsFromURL();

  const titleEl   = document.getElementById('grupo-title');
  const nombreEl  = document.getElementById('grupo-nombre');
  const numEl     = document.getElementById('grupo-numero');
  const destinoEl = document.getElementById('grupo-destino');
  const fechasEl  = document.getElementById('grupo-fechas');
  const resumenPax= document.getElementById('resumen-pax');
  const cont      = document.getElementById('mi-itin');
  const printEl   = document.getElementById('print-block');
  const btnPrint  = document.getElementById('btnPrint');
  const btnShare  = document.getElementById('btnShare');

  btnPrint?.addEventListener('click', ()=> window.print());

  if(!numeroNegocio && !id){
    cont.innerHTML = `<p style="padding:1rem;">Falta <code>numeroNegocio</code> o <code>id</code> en la URL.</p>`;
    if (printEl) printEl.textContent = '';
    return;
  }

  // 1) Preferir ID único
  let g = await fetchGrupoById(id);

  // 2) Si no, buscar por número (con compuestos)
  if(!g){
    const lista = await buscarGruposPorNumero(numeroNegocio);
    if (!lista.length){ cont.innerHTML = `<p style="padding:1rem;">No se encontró el grupo ${numeroNegocio}.</p>`; if(printEl) printEl.textContent=''; return; }
    if (lista.length > 1){
      renderSelector(lista, cont, hideNotes);
      const shareUrl = `${location.origin}${location.pathname}?numeroNegocio=${encodeURIComponent(numeroNegocio)}${hideNotes?'&notas=0':''}`;
      btnShare?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(shareUrl); alert('Enlace copiado'); }catch{ const i=document.createElement('input'); i.value=shareUrl; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); alert('Enlace copiado'); }});
      if (printEl) printEl.textContent='';
      return;
    }
    g = lista[0];
  }

  const idLink = g?.id ? `?id=${encodeURIComponent(g.id)}` : `?numeroNegocio=${encodeURIComponent(numeroNegocio||'')}`;
  const shareUrl = `${location.origin}${location.pathname}${idLink}${hideNotes?'&notas=0':''}`;
  btnShare?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(shareUrl); alert('Enlace copiado'); }catch{ const i=document.createElement('input'); i.value=shareUrl; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); alert('Enlace copiado'); } });

  // Cabecera
  titleEl.textContent   = ` ${(g.programa || '—').toString().toUpperCase()}`;
  nombreEl.textContent  = g.nombreGrupo || '—';
  numEl.textContent     = g.numeroNegocio ?? g.id ?? '—';
  destinoEl.textContent = g.destino || '—';
  fechasEl.textContent  = formatDateRange(g.fechaInicio, g.fechaFin);
  const totalA = parseInt(g.adultos,10)||0, totalE=parseInt(g.estudiantes,10)||0;
  const total = (totalA + totalE) || g.pax || g.cantidadgrupo || '';
  resumenPax.textContent = total ? `👥 Total pax: ${total}${(totalA||totalE)?` (A:${totalA} · E:${totalE})`:''}` : '';

  // Fechas del itinerario
  let fechas=[];
  if (g.itinerario && typeof g.itinerario==='object') fechas = Object.keys(g.itinerario).sort((a,b)=> new Date(a)-new Date(b));
  else if (g.fechaInicio && g.fechaFin) fechas = getDateRange(g.fechaInicio, g.fechaFin);

  // === NUEVO: Traer VUELOS y HOTELES con las mismas reglas del portal ===
  const vuelosDocs = await loadVuelosInfo(g);
  const vuelosNorm = vuelosDocs.map(normalizeVuelo);
  const hoteles    = await loadHotelesInfo(g); // incluye dirección, web, fono, check in/out

  // Hoja tipo documento (como la foto)
  renderHojaResumen(g, vuelosNorm, hoteles);

  // Itinerario visual
  // Itinerario visual
  if (!fechas.length) {
    cont.innerHTML = `<p style="padding:1rem;">No hay itinerario disponible.</p>`;
    if (printEl) printEl.textContent = buildPrintText(g, []);
  } else {
    const slot = document.getElementById('itin-slot');
    renderItin(g, fechas, hideNotes, slot || cont); // 👈 renderiza y ya parte 4 + resto
    if (printEl) printEl.textContent = buildPrintText(g, fechas);
  }
}
main().catch(err => {
  console.error('Firestore error:', err?.code || err?.message, err);

  const el = document.getElementById('mi-itin') || document.getElementById('itin-slot');
  if (el) {
    el.innerHTML = '<p style="padding:1rem;color:#b00;">Error cargando el itinerario.</p>';
  }

  const printEl = document.getElementById('print-block');
  if (printEl) printEl.textContent = '';
});

// Debug helper visible en consola aunque el archivo sea módulo
window.__itinDebug = function () {
  const c = document.getElementById('itin-slot') || document.getElementById('mi-itin');
  if (!c) { console.log('[itin dbg] sin contenedor'); return; }
  const cols = getComputedStyle(c).gridTemplateColumns.split(' ').length;
  console.log('[itin dbg]', {
    contW: c.clientWidth,
    scrollW: c.scrollWidth,
    cols,
    dias: c.querySelectorAll('.dia-seccion').length,
    hasSplit: !!document.querySelector('.dias-embebidas')
  });
};

globalThis.__itinDebug = function () {
  const c = document.getElementById('itin-slot') || document.getElementById('mi-itin');
  if (!c) { console.log('[itin dbg] sin contenedor'); return; }
  const cols = (getComputedStyle(c).gridTemplateColumns || '')
                .split(/\s+/).filter(Boolean).length;
  console.log('[itin dbg]', {
    contW: c.clientWidth,
    scrollW: c.scrollWidth,
    cols,
    dias: c.querySelectorAll('.dia-seccion').length,
    hasSplit: !!document.querySelector('.dias-embebidas')
  });
};
