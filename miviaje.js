// miviaje.js 

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
// Suma minutos a un "HH:MM" (devuelve "HH:MM")
function addMinutesHM(hm, mins = 0){
  const t = normTime(hm);
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date(2000,0,1,h,m);
  d.setMinutes(d.getMinutes() + mins);
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${hh}:${mm}`;
}

function formatShortDate(iso){ // 25 de septiembre 2025
  if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number);
  const dt=new Date(y,m-1,d); const mes=dt.toLocaleDateString('es-CL',{month:'long'});
  return `${d} de ${mes} ${y}`;
}
function formatDateReadable(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number); const dt=new Date(y,m-1,d); const wd=dt.toLocaleDateString('es-CL',{weekday:'long'}); const name=wd.charAt(0).toUpperCase()+wd.slice(1); return `${name} ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`; }
function formatDM(iso){ // 06/12
  if(!iso) return '';
  const [y,m,d] = iso.split('-').map(Number);
  return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`;
}
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

  // Mapear y normalizar
  const mapped = cand.map((a, idx)=>{
    const H = pickHotelDoc(a);
    const ci = toISO(a.checkIn), co = toISO(a.checkOut);
    let noches = a.noches;
    if (noches==null && ci && co){
      noches = Math.max(0, (new Date(co)-new Date(ci))/86400000);
    }
    const ts = (a.updatedAt?.seconds || a.createdAt?.seconds || 0);
    return {
      ...a,
      __ord: idx, // fallback de desempate
      __ts: ts,
      hotel:H,
      hotelNombre:a?.hotelNombre || a?.nombre || H?.nombre || '',
      checkIn:ci, checkOut:co, noches
    };
  });

  // DEDUPE por (checkIn, checkOut): quedarse con el "último" guardado
  const byRange = new Map();
  for (const h of mapped){
    const k = `${h.checkIn||''}__${h.checkOut||''}`;
    const prev = byRange.get(k);
    if (!prev) byRange.set(k, h);
    else {
      const takeThis = (h.__ts > prev.__ts) || (h.__ts === prev.__ts && h.__ord > prev.__ord);
      if (takeThis) byRange.set(k, h);
    }
  }

  // Resultado ordenado por checkIn asc
  const out = [...byRange.values()].sort((a,b)=>(a.checkIn||'').localeCompare(b.checkIn||''));

  cache.hotelesByGroup.set(key,out);
  return out;
}

/* ───────────────── VUELOS (mismas reglas que el portal) ────────────────── */
async function loadVuelosInfo(g){
  if (!cache.vuelosByGroup) cache.vuelosByGroup = new Map();

  const groupDocId = String(g.id || '').trim();
  const groupNum   = String(g.numeroNegocio || '').trim();
  const key = `vuelos:${groupDocId || groupNum}`;
  if (cache.vuelosByGroup.has(key)) return cache.vuelosByGroup.get(key);

  const vistos = new Map();
  const pushSnap = (snap) => {
    if (!snap) return;
    snap.forEach(d => {
      const data = d.data() || {};
      const nuevo = { id: d.id, ...data };
      const prev  = vistos.get(d.id);
      if (!prev) { vistos.set(d.id, nuevo); return; }
      const tNew = (data.updatedAt?.seconds || data.createdAt?.seconds || 0);
      const tOld = (prev.updatedAt?.seconds || prev.createdAt?.seconds || 0);
      if (tNew >= tOld) vistos.set(d.id, nuevo);
    });
  };
  const runQs = async (qs) => {
    const snaps = await Promise.all(qs.map(q => {
      if (!q) return Promise.resolve(null);
      return getDocs(q).catch(() => null);
    }));
    snaps.forEach(pushSnap);
  };
  const coll = (name) => collection(db, name);

  /* ───────────── FASE 0: documentos antiguos (grupoIds) ───────────── */
  const numAsNumber = Number(groupNum);
  await runQs([
    groupDocId ? query(coll('vuelos'), where('grupoIds','array-contains', groupDocId)) : null,
    groupNum   ? query(coll('vuelos'), where('grupoIds','array-contains', groupNum))   : null,
    (groupNum && !Number.isNaN(numAsNumber))
      ? query(coll('vuelos'), where('grupoIds','array-contains', numAsNumber)) : null
  ]);

  /* ───────────── FASE 1: más probable (rápida) ───────────── */
  if (vistos.size === 0) {
    await runQs([
      groupDocId ? query(coll('vuelos'), where('grupoId','==',groupDocId))   : null,
      groupDocId ? query(coll('vuelos'), where('grupoDocId','==',groupDocId)): null,
      groupDocId ? collection(db, 'grupos', groupDocId, 'vuelos')            : null
    ]);
  }

  /* variantes por número */
  if (vistos.size === 0 && groupNum) {
    const variants = new Set([groupNum, ...buildCompositeVariants(groupNum), ...splitNumeroCompuesto(groupNum)]);
    const qs = [];
    variants.forEach(v => {
      qs.push(query(coll('vuelos'), where('grupoNumero','==',v)));
      const n = Number(v);
      if (!Number.isNaN(n)) qs.push(query(coll('vuelos'), where('grupoNumero','==',n)));
    });
    await runQs(qs);
  }

  /* ───────────── FASE 2: asignaciones alternativas ───────────── */
  if (vistos.size === 0) {
    await runQs([
      groupDocId ? query(coll('flightAssignments'), where('grupoId','==',groupDocId))  : null,
      groupDocId ? query(coll('vuelosAssignments'), where('grupoId','==',groupDocId))  : null
    ]);

    if (vistos.size === 0 && groupNum) {
      const variants = new Set([groupNum, ...buildCompositeVariants(groupNum), ...splitNumeroCompuesto(groupNum)]);
      const qs = [];
      ['flightAssignments','vuelosAssignments'].forEach(cn => {
        variants.forEach(v => {
          qs.push(query(coll(cn), where('grupoNumero','==',v)));
          const n = Number(v);
          if (!Number.isNaN(n)) qs.push(query(coll(cn), where('grupoNumero','==',n)));
        });
      });
      await runQs(qs);
    }
  }

  /* ───────────── FASE 3: traslados terrestres (fallback) ───────────── */
  if (vistos.size === 0) {
    await runQs([
      groupDocId ? query(coll('transportes'), where('grupoId','==',groupDocId)) : null,
      groupDocId ? query(coll('transfers'),    where('grupoId','==',groupDocId)) : null,
      groupDocId ? query(coll('buses'),        where('grupoId','==',groupDocId)) : null,
      groupDocId ? collection(db,'grupos', groupDocId, 'transportes') : null,
      groupDocId ? collection(db,'grupos', groupDocId, 'transfers')   : null,
      groupDocId ? collection(db,'grupos', groupDocId, 'buses')       : null
    ]);

    if (vistos.size === 0 && groupNum) {
      const variants = new Set([groupNum, ...buildCompositeVariants(groupNum), ...splitNumeroCompuesto(groupNum)]);
      const qs = [];
      ['transportes','transfers','buses'].forEach(cn => {
        variants.forEach(v => {
          qs.push(query(coll(cn), where('grupoNumero','==',v)));
          const n = Number(v);
          if (!Number.isNaN(n)) qs.push(query(coll(cn), where('grupoNumero','==',n)));
        });
      });
      await runQs(qs);
    }
  }

  /* ───────────── FASE FINAL: escaneo acotado si no hay nada ───────────── */
  if (vistos.size === 0) {
    const matchesGroup = (v) => {
      // arreglo "grupos" (puede venir string u objeto)
      if (Array.isArray(v.grupos)) {
        const ok = v.grupos.some(x => {
          if (typeof x === 'string')
            return (groupDocId && x === groupDocId) || (groupNum && x === groupNum);
          if (x && typeof x === 'object') {
            const xid  = String(x.id || x.grupoId || '').trim();
            const xnum = String(x.numeroNegocio || x.numNegocio || '').trim();
            return (groupDocId && xid === groupDocId) || (groupNum && xnum === groupNum);
          }
          return false;
        });
        if (ok) return true;
      }
      // arreglo "grupoIds" con tipos mixtos
      if (Array.isArray(v.grupoIds)) {
        if (v.grupoIds.some(x => (groupDocId && x === groupDocId))) return true;
        if (groupNum) {
          if (v.grupoIds.some(x => x === groupNum)) return true;
          if (!Number.isNaN(numAsNumber) && v.grupoIds.some(x => x === numAsNumber)) return true;
        }
      }
      // campos raíz frecuentes
      const rootId  = String(v.grupoId || v.grupoDocId || '').trim();
      const rootNum = String(v.grupoNumero || v.numeroNegocio || '').trim();
      if (groupDocId && rootId === groupDocId) return true;
      if (groupNum && rootNum === groupNum) return true;
      return false;
    };

    let last = null, loops = 0;
    while (loops++ < 4) { // 4 * 50 = 200 docs máx.
      const q = last
        ? query(coll('vuelos'), orderBy('fechaIda','desc'), startAfter(last), limit(50))
        : query(coll('vuelos'), orderBy('fechaIda','desc'), limit(50));
      const snap = await getDocs(q).catch(()=>null);
      if (!snap || !snap.size) break;

      snap.forEach(d => {
        const v = d.data() || {};
        if (matchesGroup(v)) vistos.set(d.id, { id:d.id, ...v });
      });

      last = snap.docs[snap.docs.length - 1];
      if (vistos.size) break; // en cuanto encontremos algo, cortamos
    }
  }

  // Orden final
  const out = [...vistos.values()].sort((a,b)=>{
    const aF = toISO(a.fechaIda || a.fechaVuelta || a.fecha || '');
    const bF = toISO(b.fechaIda || b.fechaVuelta || b.fecha || '');
    if (aF !== bF) return aF.localeCompare(bF);
    const at = (a.updatedAt?.seconds || a.createdAt?.seconds || 0);
    const bt = (b.updatedAt?.seconds || b.createdAt?.seconds || 0);
    return at - bt;
  });

  cache.vuelosByGroup.set(key, out);
  return out;
}

/* ───────────────── FLIGHTS (igual lógica que portal) ──────────────── */
function normalizeVuelo(v){
  const get=(...keys)=>{ for(const k of keys){ const val=k.split('.').reduce((acc,part)=> (acc && acc[part]!==undefined)? acc[part] : undefined, v); if(val!==undefined && val!==null && val!=='') return val; } return ''; };

  const numero    = String(get('numero','nro','numVuelo','vuelo','flightNumber','codigo','code')||'').toUpperCase();
  const proveedor = String(get('proveedor','empresa','aerolinea','compania')||'').toUpperCase();

  const tipoTransporte = norm(String(get('tipoTransporte') || 'aereo')); // 'AÉREO' -> 'aereo'
  const tipoVuelo = (tipoTransporte==='aereo') ? (String(get('tipoVuelo')||'charter').toLowerCase()) : '';

  const presentacionIdaHora    = normTime(get('presentacionIdaHora'));
  const vueloIdaHora           = normTime(get('vueloIdaHora'));
  const presentacionVueltaHora = normTime(get('presentacionVueltaHora'));
  const vueloVueltaHora        = normTime(get('vueloVueltaHora'));

  // ⬇️ NUEVO: posibles nombres de llegada/arribo (ida/vuelta)
  const llegadaIdaHora    = normTime(get('llegadaIdaHora','arriboIdaHora','horaArriboIda','arriboHoraIda'));
  const llegadaVueltaHora = normTime(get('llegadaVueltaHora','arriboVueltaHora','horaArriboVuelta','arriboHoraVuelta'));

  const idaHora    = normTime(get('idaHora'));     // terrestre (transfer/bus)
  const vueltaHora = normTime(get('vueltaHora'));  // terrestre
  const encuentroAeropuerto = String(get('encuentroAeropuerto') || '').toUpperCase();

  const origen      = String(get('origen','desde','from','salida.origen','salida.iata','origenIATA','origenSigla','origenCiudad')||'').toUpperCase();
  const destino     = String(get('destino','hasta','to','llegada.destino','llegada.iata','destinoIATA','destinoSigla','destinoCiudad')||'').toUpperCase();

  const fechaIda    = toISO(get('fechaIda','ida','salida.fecha','fechaSalida','fecha_ida','fecha'));
  const fechaVuelta = toISO(get('fechaVuelta','vuelta','regreso.fecha','fechaRegreso','fecha_vuelta'));

  const isTransfer  = !!get('isTransfer');
  const transferLeg = String(get('transferLeg')||'').toLowerCase(); // ida|vuelta|ida+vuelta

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
    // ⬇️ NUEVO: llegada por tramo
    llegadaIdaHora:         normTime(t.llegadaIdaHora||t.arriboIdaHora||''),
    llegadaVueltaHora:      normTime(t.llegadaVueltaHora||t.arriboVueltaHora||''),
    tipoTramo: (String(t.tipoTramo||'').toLowerCase())
  }));

  return {
    numero, proveedor, tipoTransporte, tipoVuelo,
    origen, destino, fechaIda, fechaVuelta,
    presentacionIdaHora, vueloIdaHora, presentacionVueltaHora, vueloVueltaHora,
    llegadaIdaHora, llegadaVueltaHora,
    idaHora, vueltaHora,
    isTransfer, transferLeg,
    tramos,
    encuentroAeropuerto 
  };
}

// === Helper: particiona vuelos en IDA/VUELTA (aéreos) y TERRESTRES
//     + clasifica TRANSFERS (terrestre y "aéreo/traslado")
//     + expone listas "idaLegsPlan/vueltaLegsPlan" (aéreos SIN transfers) para Plan de Viaje
function particionarVuelos(vuelosNorm) {
  const aereos = [];
  const terrestres = [];
  const esTerrestre = (v) => norm(v.tipoTransporte || '') !== 'aereo';

  const legFrom = (v, t = {}) => {
    const aerolinea = String(t.aerolinea || v.proveedor || '').toUpperCase();
    const numero    = String(t.numero    || v.numero    || '').toUpperCase();
    const origen    = String(t.origen    || v.origen    || '').toUpperCase();
    const destino   = String(t.destino   || v.destino   || '').toUpperCase();

    const fechaIda    = toISO(t.fechaIda    || v.fechaIda    || '');
    const fechaVuelta = toISO(t.fechaVuelta || v.fechaVuelta || '');

    const presentacionIda    = normTime(t.presentacionIdaHora    || v.presentacionIdaHora    || (esTerrestre(v) ? v.idaHora    : ''));
    const presentacionVuelta = normTime(t.presentacionVueltaHora || v.presentacionVueltaHora || (esTerrestre(v) ? v.vueltaHora : ''));
    const salidaIda          = normTime(t.vueloIdaHora           || v.vueloIdaHora           || (esTerrestre(v) ? v.idaHora    : ''));
    const salidaVuelta       = normTime(t.vueloVueltaHora        || v.vueloVueltaHora        || (esTerrestre(v) ? v.vueltaHora : ''));

    const arriboIda = normTime(
      t.arriboIdaHora || t.llegadaIdaHora ||
      v.arriboIdaHora || v.llegadaIdaHora || v.horaArriboIda || ''
    );
    const arriboVuelta = normTime(
      t.arriboVueltaHora || t.llegadaVueltaHora ||
      v.arriboVueltaHora || v.llegadaVueltaHora || v.horaArriboVuelta || ''
    );

    const fecha = toISO(fechaIda || fechaVuelta || '');

    // ← incluimos tipoVuelo en el leg para rotular “CHARTER/REGULAR”
    const tipoVuelo = esTerrestre(v) ? '' : String(v.tipoVuelo || '').toLowerCase();

    // Transfer: respetar bandera explícita y, de apoyo, transferLeg
    const isTransfer = !!v.isTransfer || /^(ida|vuelta|ida\+vuelta)$/.test(String(v.transferLeg||'').toLowerCase());

    return {
      fecha, fechaIda, fechaVuelta,
      aerolinea, numero, origen, destino,
      presentacionIda, presentacionVuelta,
      salidaIda, salidaVuelta,
      arriboIda, arriboVuelta,
      tipoTransporte: v.tipoTransporte || 'aereo',
      tipoVuelo, // ← importante
      isTransfer,
      transferLeg: String(v.transferLeg||'').toLowerCase()
    };
  };

  // Armar listas base
  for (const v of (vuelosNorm || [])) {
    if (esTerrestre(v)) {
      if (Array.isArray(v.tramos) && v.tramos.length) v.tramos.forEach(t => terrestres.push(legFrom(v, t)));
      else terrestres.push(legFrom(v, {}));
    } else {
      if (Array.isArray(v.tramos) && v.tramos.length) v.tramos.forEach(t => aereos.push(legFrom(v, t)));
      else aereos.push(legFrom(v));
    }
  }

  // Orden cronológico básico en aéreos
  aereos.sort((x, y) => (x.fecha || '').localeCompare(y.fecha || ''));

  // Legs aéreos
  const idaLegsAll    = aereos.filter(l => l.fechaIda);
  const vueltaLegsAll = aereos.filter(l => l.fechaVuelta);

  // Detectores de transferencia terrestre típica (además de isTransfer)
  const U = s => String(s||'').toUpperCase();
  const isColegioToAero = (t) => U(t.origen).includes('COLEGIO')   && U(t.destino).includes('AEROPUERTO');
  const isAeroToColegio = (t) => U(t.origen).includes('AEROPUERTO') && U(t.destino).includes('COLEGIO');

  // TRANSFERS TERRESTRES (respetar transferLeg si viene)
  const hasLeg = (t, leg) => (t.transferLeg === leg || t.transferLeg === 'ida+vuelta');

  const transferTerrestreIda = terrestres
    .filter(t => {
      if (t.isTransfer) return hasLeg(t, 'ida');
      return isColegioToAero(t);
    })
    .map(t => ({ ...t, __modo:'ida', __tipo:'terrestre' }));

  const transferTerrestreVuelta = terrestres
    .filter(t => {
      if (t.isTransfer) return hasLeg(t, 'vuelta');
      return isAeroToColegio(t);
    })
    .map(t => ({ ...t, __modo:'vuelta', __tipo:'terrestre' }));


  // TRANSFER AÉREO ("traslado aéreo" guardado como isTransfer=true)
  const transferAereoIda    = idaLegsAll.filter(l => l.isTransfer).map(l => ({ ...l, __modo:'ida', __tipo:'aereo' }));
  const transferAereoVuelta = vueltaLegsAll.filter(l => l.isTransfer).map(l => ({ ...l, __modo:'vuelta', __tipo:'aereo' }));

  // Para PLAN DE VIAJE → aéreos SIN transfers
  const idaLegsPlan    = idaLegsAll.filter(l => !l.isTransfer);
  const vueltaLegsPlan = vueltaLegsAll.filter(l => !l.isTransfer);

  // Para PLAN DE VIAJE → buses SIN transfers
  const terrestresNoTransfer = terrestres.filter(t => !t.isTransfer && !isColegioToAero(t) && !isAeroToColegio(t));
  const terrestresPlanIda    = terrestresNoTransfer.filter(t => !!(t.fechaIda || t.presentacionIda || t.salidaIda));
  const terrestresPlanVuelta = terrestresNoTransfer.filter(t => !!(t.fechaVuelta || t.presentacionVuelta || t.salidaVuelta));

  const hasColegioToAeropuerto = transferTerrestreIda.length > 0;
  const hasAeropuertoToColegio = transferTerrestreVuelta.length > 0;

  return {
    // crudos (si los necesitas)
    idaLegs: idaLegsAll, vueltaLegs: vueltaLegsAll,
    terrestres,

    // para leyendas
    hasColegioToAeropuerto, hasAeropuertoToColegio,

    // transfers para Información General
    transferTerrestreIda, transferTerrestreVuelta,
    transferAereoIda, transferAereoVuelta,

    // SOLO PARA PLAN (excluyen transfers)
    idaLegsPlan, vueltaLegsPlan,
    terrestresPlanIda, terrestresPlanVuelta
  };
}

// Invertir origen/destino en VUELTA (solo al pintar)
function maybeSwapOD(origen, destino, modo){
  if (modo === 'vuelta') return { origen: String(destino||'').toUpperCase(), destino: String(origen||'').toUpperCase() };
  return { origen: String(origen||'').toUpperCase(), destino: String(destino||'').toUpperCase() };
}

function chooseFlightNumber(raw, modo){
  const s = String(raw||'').toUpperCase();
  if (!s.includes('//')) return s;
  const parts = s.split('//').map(x=>x.trim()).filter(Boolean);
  return (modo === 'ida') ? (parts[0]||'') : (parts[parts.length-1]||'');
}

// Filas genéricas para cualquier "leg"
function rowHTML(leg, modo){
  const fecha        = (modo==='ida') ? (leg.fechaIda || leg.fecha) : (leg.fechaVuelta || leg.fecha);
  const presentacion = (modo==='ida') ? leg.presentacionIda         : leg.presentacionVuelta;
  const salida       = (modo==='ida') ? leg.salidaIda               : leg.salidaVuelta;
  const arribo       = (modo==='ida') ? leg.arriboIda               : leg.arriboVuelta;
  const { origen, destino } = maybeSwapOD(leg.origen, leg.destino, modo);
  const nro = chooseFlightNumber(leg.numero, modo);

  return `
    <tr>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${fecha ? formatShortDate(fecha) : '—'}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${nro || '—'}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(origen)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(presentacion)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(salida)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(destino)}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(arribo)}</td>
    </tr>`;
}

// Tabla de TRANSFERS (terrestre o “traslado aéreo”)
// Tabla de TRANSFERS (separa terrestre vs aéreo)
function renderTransferTable(arr){
  if (!arr || !arr.length) return '';

  const isAereo = x => (x.__tipo === 'aereo') || (norm(x.tipoTransporte||'') === 'aereo');
  const terrestres = arr.filter(x => !isAereo(x));
  const aereos     = arr.filter(isAereo);

  // TERRESTRES: 5 columnas y salida = presentación + 30
  const htmlTerrestres = terrestres.length ? (() => {
    const rows = terrestres.map(x=>{
      const modo  = x.__modo === 'vuelta' ? 'vuelta' : 'ida';
      const fecha = (modo==='ida') ? (x.fechaIda || x.fecha) : (x.fechaVuelta || x.fecha);
      const pres  = (modo==='ida') ? x.presentacionIda       : x.presentacionVuelta;
      const sal   = addMinutesHM(pres, 30) || ((modo==='ida') ? x.salidaIda : x.salidaVuelta);
      const { origen, destino } = maybeSwapOD(x.origen, x.destino, modo);
      return `
        <tr>
          <td style="padding:6px 8px;border:1px solid #d1d5db;">${fecha ? formatShortDate(fecha) : '—'}</td>
          <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(origen)}</td>
          <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(pres)}</td>
          <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(sal)}</td>
          <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(destino)}</td>
        </tr>`;
    }).join('');

    return `
      <div style="overflow:auto;margin-top:6px;">
        <div style="font-weight:600;margin:0 0 4px 0;">Terrestres</div>
        <table style="border-collapse:collapse;min-width:560px;">
          <thead>
            <tr>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Origen</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora presentación</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora salida</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Destino</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  })() : '';

  // AÉREOS: tabla completa (usa tu rowHTML actual)
  const htmlAereos = aereos.length ? (() => {
    const rows = aereos.map(x => rowHTML(x, x.__modo)).join('');
    return `
      <div style="overflow:auto;margin-top:${terrestres.length ? '10px' : '6px'};">
        <div style="font-weight:600;margin:0 0 4px 0;">Aéreos</div>
        <table style="border-collapse:collapse;min-width:680px;">
          <thead>
            <tr>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">N° vuelo</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Origen</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora presentación</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora salida</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Destino</th>
              <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora arribo</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  })() : '';

  return `${htmlTerrestres}${htmlAereos}`;
}

/* ========= Helpers de TABLAS para IMPRESIÓN (puntos 1 y 2) ========= */

// Celdas comunes
const td = (v)=> `<td>${v ?? '—'}</td>`;

// Tabla de PLAN (aéreo o terrestre) para impresión
function printTablePlan(legs = [], modo = 'ida', tipo = 'aereo'){
  if (!legs.length) return '';
  // Título
  const tituloModo = (modo === 'ida') ? 'IDA' : 'VUELTA / REGRESO';

  // Para aéreos mostramos Nº vuelo y Arribo; para buses no.
  const isAereo = (tipo === 'aereo');

  // Header “IDA: VUELO XXX VÍA YYY (CHARTER/REGULAR)”
  let header = '';
  if (isAereo && legs[0]){
    const f = legs[0];
    const nro = chooseFlightNumber(f.numero, modo);
    const via = f.aerolinea ? ` VÍA ${String(f.aerolinea).toUpperCase()}` : '';
    const tipoVuelo = f.tipoVuelo ? ` (${String(f.tipoVuelo).toUpperCase()})` : '';
    header = `${tituloModo}: VUELO ${nro}${via}`.trim();
  } else {
    header = tituloModo;
  }

  // Filas
  const rows = legs.map(l=>{
    const fecha  = (modo==='ida') ? (l.fechaIda || l.fecha) : (l.fechaVuelta || l.fecha);
    const pres   = (modo==='ida') ? l.presentacionIda       : l.presentacionVuelta;
    const salida = (modo==='ida') ? l.salidaIda             : l.salidaVuelta;
    const arribo = (modo==='ida') ? l.arriboIda             : l.arriboVuelta;
    const { origen, destino } = maybeSwapOD(l.origen, l.destino, modo);
    return `
      <tr>
        ${td(fecha ? formatShortDate(fecha) : '—')}
        ${td(origen || '—')}
        ${td(pres   || '—')}
        ${td(salida || '—')}
        ${td(destino|| '—')}
        ${isAereo ? td(arribo || '—') : ''}
      </tr>`;
  }).join('');

  // Head
  const headAereo = `
    <tr>
      <th>Fecha</th>
      <th>Origen</th>
      <th>Presentación</th>
      <th>Hora de salida</th>
      <th>Destino</th>
      <th>Hora de arribo</th>
    </tr>`;

  const headBus = `
    <tr>
      <th>Fecha</th>
      <th>Origen</th>
      <th>Presentación</th>
      <th>Hora de salida</th>
      <th>Destino</th>
    </tr>`;

  return `
    <div class="table-wrap">
      <div class="table-title">${header}</div>
      <table class="print-table">
        <thead class="thead-muted">
          ${isAereo ? headAereo : headBus}
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Tabla de TRANSFERS (punto 1) para impresión
function printTableTransfers(arr = []){
  if (!arr.length) return '';

  const isAereo = x => (x.__tipo === 'aereo') || (norm(x.tipoTransporte||'') === 'aereo');
  const terrestres = arr.filter(x => !isAereo(x));
  const aereos     = arr.filter(isAereo);

  // TERRESTRE: 5 columnas, salida = presentación + 30 (si hay presentación)
  const rowsTer = terrestres.map(x=>{
    const modo = (x.__modo === 'vuelta') ? 'vuelta' : 'ida';
    const fecha = (modo==='ida') ? (x.fechaIda || x.fecha) : (x.fechaVuelta || x.fecha);
    const pres  = (modo==='ida') ? x.presentacionIda       : x.presentacionVuelta;
    const baseSalida = (modo==='ida') ? x.salidaIda : x.salidaVuelta;
    const salida = addMinutesHM(pres, 30) || baseSalida || '';
    const { origen, destino } = maybeSwapOD(x.origen, x.destino, modo);
    return `
      <tr>
        ${td(fecha ? formatShortDate(fecha) : '—')}
        ${td(origen || '—')}
        ${td(pres   || '—')}
        ${td(salida || '—')}
        ${td(destino|| '—')}
      </tr>`;
  }).join('');

  const tableTer = terrestres.length ? `
    <div class="table-wrap">
      <div class="table-title">Terrestres</div>
      <table class="print-table">
        <thead class="thead-muted">
          <tr>
            <th>Fecha</th>
            <th>Origen</th>
            <th>Hora presentación</th>
            <th>Hora salida</th>
            <th>Destino</th>
          </tr>
        </thead>
        <tbody>${rowsTer}</tbody>
      </table>
    </div>` : '';

  // AÉREO: 6 columnas (sí muestra Nº vuelo y Arribo)
  const rowsAer = aereos.map(x=>{
    const modo = (x.__modo === 'vuelta') ? 'vuelta' : 'ida';
    const fecha = (modo==='ida') ? (x.fechaIda || x.fecha) : (x.fechaVuelta || x.fecha);
    const pres  = (modo==='ida') ? x.presentacionIda       : x.presentacionVuelta;
    const salida = (modo==='ida') ? x.salidaIda : x.salidaVuelta;
    const arribo = (modo==='ida') ? x.arriboIda : x.arriboVuelta;
    const nro = chooseFlightNumber(x.numero, modo);
    const { origen, destino } = maybeSwapOD(x.origen, x.destino, modo);
    return `
      <tr>
        ${td(fecha ? formatShortDate(fecha) : '—')}
        ${td(nro || '—')}
        ${td(origen || '—')}
        ${td(pres   || '—')}
        ${td(salida || '—')}
        ${td(destino|| '—')}
        ${td(arribo || '—')}
      </tr>`;
  }).join('');

  const tableAer = aereos.length ? `
    <div class="table-wrap">
      <div class="table-title">Aéreos</div>
      <table class="print-table">
        <thead class="thead-muted">
          <tr>
            <th>Fecha</th>
            <th>N° vuelo</th>
            <th>Origen</th>
            <th>Hora presentación</th>
            <th>Hora salida</th>
            <th>Destino</th>
            <th>Hora de arribo</th>
          </tr>
        </thead>
        <tbody>${rowsAer}</tbody>
      </table>
    </div>` : '';

  return `${tableTer}${tableAer}`;
}

// === FECHA DE INICIO DEL VIAJE (una sola) ===
// Prioridad: transfer COLEGIO→AEROPUERTO (ida) → primer vuelo de ida → primer terrestre.
function computeFechaInicioViaje(vuelosNorm){
  if (!Array.isArray(vuelosNorm) || !vuelosNorm.length) return '';
  const {
    idaLegs, terrestres,
    transferTerrestreIda, transferAereoIda
  } = particionarVuelos(vuelosNorm);

  const toFirstISO = (arr, pick) => {
    const xs = (arr||[]).map(pick).map(toISO).filter(Boolean).sort();
    return xs[0] || '';
  };

  // 1) Transfer COLEGIO → AEROPUERTO (ida) (prioridad)
  const firstTransferIdaISO = toFirstISO(
    [...(transferTerrestreIda||[]), ...(transferAereoIda||[])],
    x => x.fechaIda || x.fecha
  );
  if (firstTransferIdaISO) return firstTransferIdaISO;

  // 2) Primer vuelo de ida
  const firstIdaISO = toFirstISO(idaLegs||[], x => x.fechaIda || x.fecha);
  if (firstIdaISO) return firstIdaISO;

  // 3) Primer terrestre (cuando no hay aéreos)
  const firstTerISO = toFirstISO(terrestres||[], x => x.fechaIda || x.fecha);
  if (firstTerISO) return firstTerISO;

  return '';
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
  const {
    idaLegs,
    transferTerrestreIda, transferTerrestreVuelta,
    transferAereoIda,     transferAereoVuelta,
    hasColegioToAeropuerto
  } = particionarVuelos(vuelosNorm);

  const T_IDA    = [...(transferTerrestreIda||[]), ...(transferAereoIda||[])].sort((a,b)=> (toISO(a.fechaIda||a.fecha||'')||'').localeCompare(toISO(b.fechaIda||b.fecha||'')||''));
  const T_VUELTA = [...(transferTerrestreVuelta||[]), ...(transferAereoVuelta||[])].sort((a,b)=> (toISO(a.fechaVuelta||a.fecha||'')||'').localeCompare(toISO(b.fechaVuelta||b.fecha||'')||''));

  const primeraIda = (idaLegs||[])[0] || null;
  const firstTransIda    = T_IDA[0]    || null;
  const firstTransVuelta = T_VUELTA[0] || null;

  let lugar = (grupo.presentacionLugar || '').trim();
  if (!lugar) {
    lugar = hasColegioToAeropuerto ? 'En las puertas del Colegio'
                                   : (primeraIda ? 'En el aeropuerto' : 'Punto de encuentro');
  }

  let aeropuerto = grupo.presentacionAeropuerto || (primeraIda ? primeraIda.origen : '') || (firstTransVuelta ? firstTransVuelta.origen : '');

  let presHora   = '';
  let salidaHora = '';

  // 1) Si hay TRANSFER de IDA, usarlo
  if (firstTransIda){
    presHora = firstTransIda.presentacionIda || firstTransIda.salidaIda || '';
    if (firstTransIda.__tipo === 'terrestre'){
      salidaHora = addMinutesHM(presHora, 30) || firstTransIda.salidaIda || '';
    } else {
      salidaHora = firstTransIda.salidaIda || '';
    }
  }

  // 2) Si no hubo transfer ida, usar primer vuelo de ida
  if (!presHora && primeraIda) presHora = primeraIda.presentacionIda || primeraIda.salidaIda || '';
  if (!salidaHora && primeraIda) salidaHora = primeraIda.salidaIda || '';

  // 3) Caso sólo-vuelta
  if (!presHora && firstTransVuelta){
    presHora   = firstTransVuelta.presentacionVuelta || firstTransVuelta.salidaVuelta || '';
    if (firstTransVuelta.__tipo === 'terrestre'){
      salidaHora = addMinutesHM(presHora, 30) || firstTransVuelta.salidaVuelta || '';
    } else {
      salidaHora = firstTransVuelta.salidaVuelta || '';
    }
    aeropuerto = firstTransVuelta.origen || aeropuerto;
    if (!lugar) lugar = 'En el aeropuerto';
  }

  const encuentro = (vuelosNorm || [])
    .find(x => norm(x.tipoTransporte || '') === 'aereo' && x.encuentroAeropuerto)?.encuentroAeropuerto || '';

  return { lugar, aeropuerto, presHora, salidaHora, encuentro };
}


// === Textos DOCUMENTOS / EQUIPAJE / RECOMENDACIONES según programa ===
function getDERTextos(programa, overrides = {}) {
  // Normaliza: sin tildes, minúsculas
  const P = norm(programa || '');

  // Base equipaje (común a todos)
  const equipajeText1 =
    overrides.equipaje1 ||
    'Equipaje en bodega 01 Maleta (peso máximo 23 kg.) el cual debe tener como medidas máximo 158 cm lineales (largo, ancho, alto), más un bolso de mano (peso máximo 5 Kg.). Equipaje adicional será cobrado por la empresa de transporte respectiva.';
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
            'Verificar que la autorización notarial esté con todos los datos correctos según detalle enviado a los encargados del grupo. La cédula de identidad debe estar en óptimas condiciones para que los pasajeros no tengan problemas para salir del país.'
          ]  
        },
        {
          title: 'EXTRANJEROS',
          items: [
            'Verificar que Cédula de Identidad Chilena y Pasaporte de origen, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).',
            'Verificar con consulado del país de destino los requerimientos para el ingreso y salida de acuerdo a la nacionalidad del menor. Es responsabilidad de cada pasajero, junto a sus padres o apoderados, tener la documentación vigente, correcta y necesaria para su viaje.'
          ]
        }
      ];
    const recs =
      overrides.recomendaciones || [
        'Llevar ropa y calzado, cómodo, adecuado a Clima del Destino. Llevar protector solar',
        'Llevar una botella reutilizable para el consumo de agua',
        'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida.',
        'Las pertenencias personales son de responsabilidad exclusiva de cada pasajero.',
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
        'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida.',
        'Las pertenencias personales son de responsabilidad exclusiva de cada pasajero.',
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
        'Se recomienda que la documentación quede bajo la supervisión de los adultos para evitar su pérdida.',
        'Las pertenencias personales son de responsabilidad exclusiva de cada pasajero.',
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

  const P = extractPresentacion(grupo, vuelosNorm);

  const {
    // aéreos “plan” sin transfers
    idaLegsPlan, vueltaLegsPlan,
    // info para leyendas
    hasColegioToAeropuerto, hasAeropuertoToColegio,
    // transfers (terrestre + “aéreo”)
    transferTerrestreIda, transferTerrestreVuelta,
    transferAereoIda, transferAereoVuelta,
    // buses de plan (sin transfers)
    terrestresPlanIda, terrestresPlanVuelta
  } = particionarVuelos(vuelosNorm);

  // Leyendas
  const legendBits = [];
  if (hasColegioToAeropuerto) legendBits.push('El grupo contempla traslado COLEGIO → AEROPUERTO.');
  if (hasAeropuertoToColegio) legendBits.push('Y traslado AEROPUERTO → COLEGIO.');
  const legendInline = legendBits.join(' ');

  // Filas (aéreo o bus). Si isAereo=false, oculta "arribo".
  const makeRows = (legs, modo, isAereo = true) => legs.map(r => {
    const fecha        = (modo === 'ida') ? (r.fechaIda || r.fecha) : (r.fechaVuelta || r.fecha);
    const presentacion = (modo === 'ida') ? r.presentacionIda       : r.presentacionVuelta;
    const salida       = (modo === 'ida') ? r.salidaIda             : r.salidaVuelta;
    const arribo       = (modo === 'ida') ? r.arriboIda             : r.arriboVuelta;
    const { origen, destino } = maybeSwapOD(r.origen, r.destino, modo);
    return `
      <tr>
        <td style="padding:6px 8px;border:1px solid #d1d5db;">${fecha ? formatShortDate(fecha) : '—'}</td>
        <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(origen)}</td>
        <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(presentacion)}</td>
        <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(salida)}</td>
        <td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(destino)}</td>
        ${isAereo ? `<td style="padding:6px 8px;border:1px solid #d1d5db;">${safe(arribo)}</td>` : ``}
      </tr>`;
  }).join('');

  // Encabezados para aéreos (si aplica)
  const chooseNum = (raw, modo) => {
    const s = String(raw||'').toUpperCase();
    if (!s.includes('//')) return s;
    const parts = s.split('//').map(x=>x.trim());
    return (modo === 'ida') ? (parts[0]||'') : (parts[parts.length-1]||'');
  };

  const idaHeaderAereo = (() => {
    const f = idaLegsPlan[0]; if (!f) return '';
    const tipo = f.tipoVuelo ? ` (${String(f.tipoVuelo).toUpperCase()})` : '';
    return `IDA: VUELO ${chooseNum(f.numero,'ida')} VÍA ${f.aerolinea||''}`.trim();
  })();
  const vtaHeaderAereo = (() => {
    const f = vueltaLegsPlan[0]; if (!f) return '';
    const tipo = f.tipoVuelo ? ` (${String(f.tipoVuelo).toUpperCase()})` : '';
    return `VUELTA: VUELO ${chooseNum(f.numero,'vuelta')} VÍA ${f.aerolinea||''}`.trim();
  })();

  // Punto de encuentro (SOLO en Plan de viaje)
  const puntoEncuentroTexto = (() => {
    if (idaLegsPlan.length) {
      if (P.encuentro) return P.encuentro;
      const aero = idaLegsPlan[0]?.origen || '';
      return aero ? `Encuentro en Aeropuerto ${aero}` : '';
    }
    if (terrestresPlanIda.length) {
      const ori = terrestresPlanIda[0]?.origen || '';
      return ori ? `Encuentro en ${ori}` : '';
    }
    return '';
  })();

  // TRANSFERS (solo para Información General)
  const transfersHTML = (() => {
    const arr = [
      ...(transferTerrestreIda || []),
      ...(transferTerrestreVuelta || []),
      ...(transferAereoIda || []),
      ...(transferAereoVuelta || [])
    ];
    if (!arr.length) return '';
    return `
      <div style="font-weight:700;margin:.8rem 0 .25rem 0;">TRASLADOS</div>
      ${renderTransferTable(arr)}
    `;
  })();

  // Bloque Plan de Viaje → aéreos si existen; si no, buses (sin transfers)
  const hayAereos = idaLegsPlan.length || vueltaLegsPlan.length;
  const hayBusesPlan = terrestresPlanIda.length || terrestresPlanVuelta.length;

  const planLegend = `Los horarios a continuación pueden sufrir modificaciones sin previo aviso.`;

  const planDeViajeHTML = (() => {
    // AÉREO
    if (hayAereos) {
      return `
        <div class="legend" style="color:#6b7280;margin:.25rem 0 .45rem 0;">${planLegend}</div>
        ${puntoEncuentroTexto ? `<div style="margin:2px 0 8px 0;"><strong>Punto de encuentro con coordinador(a):</strong> ${puntoEncuentroTexto}</div>` : ''}

        ${ idaHeaderAereo ? `<div class="subsec" style="font-weight:700;margin:.35rem 0 .25rem 0;">${idaHeaderAereo}</div>` : '' }
        ${ idaLegsPlan.length ? `
          <div style="overflow:auto;margin-top:2px;">
            <table style="border-collapse:collapse;min-width:560px;">
              <thead>
                <tr>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Origen</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Presentación</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de salida</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Destino</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de arribo</th>
                </tr>
              </thead>
              <tbody>${makeRows(idaLegsPlan, 'ida')}</tbody>
            </table>
          </div>` : '' }

        ${ vtaHeaderAereo ? `<div class="subsec" style="font-weight:700;margin:.6rem 0 .25rem 0;">${vtaHeaderAereo}</div>` : '' }
        ${ vueltaLegsPlan.length ? `
          <div style="overflow:auto;margin-top:2px;">
            <table style="border-collapse:collapse;min-width:560px;">
              <thead>
                <tr>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Origen</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Presentación</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de salida</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Destino</th>
                  <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de arribo</th>
                </tr>
              </thead>
              <tbody>${makeRows(vueltaLegsPlan, 'vuelta')}</tbody>
            </table>
          </div>` : '' }
      `;
    }

    // TERRESTRE (sin transfers)
    if (hayBusesPlan) {
      return `
        <div class="legend" style="color:#6b7280;margin:.25rem 0 .45rem 0;">${planLegend}</div>
        ${puntoEncuentroTexto ? `<div style="margin:2px 0 8px 0;"><strong>Punto de encuentro con coordinador(a):</strong> ${puntoEncuentroTexto}</div>` : ''}

        <div class="subsec" style="font-weight:700;margin:.35rem 0 .25rem 0;">IDA</div>
        <div style="overflow:auto;margin-top:2px;">
          <table style="border-collapse:collapse;min-width:560px;">
    
            <thead>
              <tr>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Origen</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Presentación</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de salida</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Destino</th>
              </tr>
            </thead>
            <tbody>${makeRows(terrestresPlanIda, 'ida', /* isAereo= */ false)}</tbody>

          </table>
        </div>

        <div class="subsec" style="font-weight:700;margin:.6rem 0 .25rem 0;">VUELTA</div>
        <div style="overflow:auto;margin-top:2px;">
          <table style="border-collapse:collapse;min-width:560px;">

            <thead>
              <tr>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Fecha</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Origen</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Presentación</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Hora de salida</th>
                <th style="padding:6px 8px;border:1px solid #d1d5db;background:#f3f4f6;text-align:left;">Destino</th>
              </tr>
            </thead>
            <tbody>${makeRows(terrestresPlanVuelta, 'vuelta', /* isAereo= */ false)}</tbody>

          </table>
        </div>
      `;
    }

    // Sin nada
    return `
      <div class="legend" style="color:#6b7280;margin:.25rem 0 .45rem 0;">${planLegend}</div>
      ${puntoEncuentroTexto ? `<div style="margin:2px 0 8px 0;"><strong>Punto de encuentro con coordinador(a):</strong> ${puntoEncuentroTexto}</div>` : ''}
      <div style="opacity:.7;">— Sin información del plan —</div>
    `;
  })();

  // —— Hotelería (pantalla) ——
  injectScreenHotelStyles();
  const dmy = (s) => { const iso = toISO(s); if (!iso) return '—'; const [y,m,d] = iso.split('-'); return `${d}-${m}-${y}`; };
  const hotelesHtml = `
    <ul class="hoteles-list">
      ${ (hoteles||[]).map(h=>{
          const H = h.hotel || {};
          const ciudad = (H.ciudad || h.ciudad || H.destino || h.destino || '').toString().toUpperCase();
          const hotel  = (h.hotelNombre || H.nombre || '—').toString().toUpperCase();
          const dir    = (H.direccion || h.direccion || '').toString();
          const tel1   = (H.contactoTelefono || '').toString().trim();
          const tel2   = (H.telefono || H.phone || H.contactoFono || '').toString().trim();
          const tels   = [tel1, tel2].filter(Boolean).join(' ');
          return `
            <li class="hotel-item">
              <div class="hotel-grid">
                <div class="hotel-left"><strong>${ciudad || '—'}</strong></div>
                <div class="hotel-right">
                  <div><strong>${hotel}</strong></div>
                  <div>In : ${dmy(h.checkIn)}</div>
                  <div>Out: ${dmy(h.checkOut)}</div>
                  ${dir  ? `<div>Dirección: ${dir}</div>` : ``}
                  ${tels ? `<div>Fono: ${tels}</div>`     : ``}
                  ${H.web ? `<div>Web: <a href="${H.web}" target="_blank" rel="noopener">${H.web}</a></div>` : ``}
                </div>
              </div>
            </li>`;
        }).join('') }
    </ul>
  `;

  const { docsText, equipajeText1, equipajeText2, recs } =
    getDERTextos(`${grupo.programa || ''} ${grupo.destino || ''}`, grupo.textos || {});
  const documentosHTML = renderDocsList(docsText);
  const recomendacionesHTML = Array.isArray(recs) ? recs.map(r=>`<li>${r}</li>`).join('') : `<li>${recs}</li>`;

  // Fecha de inicio (misma lógica que tenías)
  const fechaInicioViajeISO = computeFechaInicioViaje(vuelosNorm);
  const fechaInicioViajeTxt = fechaInicioViajeISO ? formatShortDate(fechaInicioViajeISO) : '—';

  hoja.innerHTML = `
      <div style="text-align:center;margin-bottom:10px;">
        <div style="font-size:20px;font-weight:800;">${titulo}</div>
      </div>

    <ol style="padding-left:18px;margin:0;">
      <!-- 1. INFORMACIÓN GENERAL -->
      <li class="punto1" style="margin-bottom:12px;">
        <div style="font-weight:700;">INFORMACIÓN GENERAL</div>
        <div class="legend" style="color:#6b7280;margin:.25rem 0 .45rem 0;">${legendInline}</div>
        ${fechaInicioViajeISO ? `<div><strong>Fecha de inicio del viaje:</strong> ${fechaInicioViajeTxt}</div>` : ''}
        <div class="presentacion" style="line-height:1.35;">
          Presentación: ${P.lugar}${P.presHora ? ` a las ${P.presHora} hrs.` : ''}${P.aeropuerto ? ` en ${String(P.aeropuerto||'').toUpperCase()}` : ''}${P.salidaHora ? `; salida a las ${P.salidaHora} hrs.` : ''}.
        </div>
        ${transfersHTML}
      </li>

      <!-- 2. INFORMACIÓN DEL PLAN DE VIAJE -->
      <li style="margin-bottom:12px;">
        <div style="font-weight:700;">INFORMACIÓN DEL PLAN DE VIAJE</div>
        ${planDeViajeHTML}
      </li>

      <!-- 3. HOTELERÍA -->
      <li style="margin-bottom:12px;">
        <div style="font-weight:700;">HOTELERÍA CONFIRMADA</div>
        ${hoteles && hoteles.length
          ? `<div style="margin-top:6px;">${hotelesHtml}</div>`
          : `<div style="opacity:.7;">— Sin hotelería cargada —</div>`}
      </li>

      <!-- 4. DOCUMENTOS -->
      <li style="margin-bottom:12px;">
        <div style="font-weight:700;">DOCUMENTOS PARA EL VIAJE</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          ${documentosHTML}
        </ul>
      </li>

      <!-- 5. EQUIPAJE -->
      <li style="margin-bottom:12px;">
        <div style="font-weight:700;">EQUIPAJE</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          <li>${equipajeText1}</li>
          <li>${equipajeText2}</li>
        </ul>
      </li>

      <!-- 6. RECOMENDACIONES -->
      <li style="margin-bottom:6px;">
        <div style="font-weight:700;">RECOMENDACIONES GENERALES</div>
        <ul style="margin:4px 0 0 18px;list-style:disc;">
          ${recomendacionesHTML}
        </ul>
      </li>

      <!-- 7. ITINERARIO -->
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
function buildPrintHtml(grupo, fechas){
  const liDays = fechas.map((f, i) => {
    const src = grupo.itinerario?.[f];
    const arr = (Array.isArray(src) ? src
               : (src && typeof src==='object' ? Object.values(src) : []))
      .sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));

    const actividades = arr
      .map(a => (a?.actividad || '').toString().trim().toUpperCase())
      .filter(Boolean);

    // Cabecera de día en NEGRITA y MAYÚSCULAS
    const head = `DÍA ${i+1} - ${formatDateReadable(f).toUpperCase()}:`;

    // Actividades separadas por " — " en negrita
    const body = actividades.length
      ? actividades.map((t,idx)=> `${idx?'<span class="sep"> — </span>':''}${t}`).join('')
      : '—';

    return `
      <li class="print-dia">
        <div class="print-dia-head"><strong>${head}</strong></div>
        <div class="print-dia-body">${body}</div>
      </li>`;
  }).join('');

  return `
    <ul class="print-itin">
      ${liDays}
    </ul>
    <div class="print-despedida">¡¡ TURISMO RAITRAI LES DESEA UN VIAJE INOLVIDABLE !!</div>
  `;
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

/* ---------- PRINT CSS v2: documento limpio A4, sin bordes, tablas 100% y logo seguro ---------- */
function injectPrintStyles(){
  const ID = 'print-tweaks';
  if (document.getElementById(ID)) return;

  const css = `
    #print-block{ display:none; }

    /* Top grande para que todas las páginas partan igual que la 1 */
    @page{ size:A4; margin:32mm 12mm 12mm 12mm; }

    @media print{
      html,body{
        background:#fff !important;
        color:#111 !important;
        font:10pt/1.18 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
      }

      /* Sólo el documento imprimible */
      #hoja-resumen,#mi-itin,#itin-slot,.dias-embebidas,header,nav,footer{ display:none !important; }

      /* 🔒 Reserva carril derecho para el logo (evita que el texto lo invada) */
      #print-block{ 
        display:block !important; 
        position:relative; 
        z-index:1; 
        white-space:normal !important;
        padding-right:34mm !important;   /* << clave */
      }
      #print-block .print-doc{ margin-right:0 !important; } /* por si dejaste algún margen viejo */

      /* Logo fijo arriba-derecha, fuera del texto */
      #print-logo{
        position:fixed !important;
        top:0mm !important;
        right:0mm !important;
        width:22mm !important;
        height:auto !important;
        opacity:.95; pointer-events:none; z-index:2 !important;
      }

      /* Títulos / espaciado */
      #print-block .doc-title{ font-weight:800; font-size:17pt; line-height:1.12; margin:0 0 6mm 0; }
      #print-block .doc-sub{ font-size:10pt; color:#374151; line-height:1.18; margin:0 0 4mm 0; }

      #print-block .sec{ break-inside:avoid; page-break-inside:avoid; margin:0 0 5mm 0; }
      #print-block .sec + .sec{ margin-top:5mm; }
      #print-block .sec-title{ font-weight:700; font-size:10.5pt; margin:0 0 2.5mm 0; }

      .flight-block{ margin:0 0 4mm 0; }
      .flights-header{ font-weight:700; margin:0 0 1.6mm 0; }
      .flight-lines{ list-style:none; margin:0 0 2.2mm 0; padding:0; }
      .flight-lines li{ margin:.4mm 0; line-height:1.18; }
      .flight-lines .lbl{ font-weight:700; }
      .sec .note{ margin-bottom:3mm; }
      .sec .note + .flight-block{ margin-top:4mm; }
      .flight-block + .flight-block{ margin-top:4mm; }

      #print-block .hoteles-list{ list-style:none; margin:.8mm 0 0 0; padding:0; }
      #print-block .hotel-item{ margin:.6mm 0 .8mm; }
      #print-block .hotel-grid{ display:grid; grid-template-columns:var(--hotel-left-col,48mm) 1fr; column-gap:5mm; }
      #print-block .hotel-right > div{ margin:.15mm 0; }

      .itinerario-sec{ break-before:auto; page-break-before:auto; }
      .itinerario-sec .sec-title{ margin-bottom:4mm; }
      .itinerario .it-day{ margin:0 0 3.5mm 0; }
      .closing{ text-align:center; font-weight:800; margin-top:8mm; }

      /* ==== Tablas IMPRESIÓN: ancho completo, sin cortes por fila, encabezado repetido ==== */
      #print-block .table-wrap{
        break-inside: avoid;
        page-break-inside: avoid;
        margin: 0 0 4mm 0;
      }
      
      #print-block .table-title{
        font-weight:700;
        margin: 0 0 1.8mm 0;
      }
      
      #print-block table.print-table{
        width:100%;
        border-collapse:collapse;
        table-layout:fixed;            /* evita desborde de margen */
        word-break:break-word;
      }
      
      #print-block .print-table thead { 
        display: table-header-group;   /* repite encabezado en cada página */
      }
      
      #print-block .print-table th,
      #print-block .print-table td{
        padding: 2mm 2.5mm;
        border: 0.2mm solid #d1d5db;
        vertical-align: top;
      }
      
      #print-block .print-table tbody tr{
        break-inside: avoid;           /* no cortar fila en cambio de página */
        page-break-inside: avoid;
      }
      
      /* Encabezados específicos */
      #print-block .thead-muted th{
        background:#f3f4f6;
        text-align:left;
        font-weight:600;
      }
    }
  `;
  const s = document.createElement('style');
  s.id = ID; s.textContent = css; document.head.appendChild(s);
}

// === Logo fijo en impresión (arriba-derecha) ===
function ensurePrintLogo(){
  if (document.getElementById('print-logo')) return;
  const img = document.createElement('img');
  img.id = 'print-logo';
  img.src = 'Logo Raitrai.png';           // ajusta ruta si tu logo está en otra carpeta
  img.alt = 'Turismo Rai Trai';
  document.body.appendChild(img);         // queda fijo por CSS @media print
}

// ===== Estilos de PANTALLA para la lista de hotelería (viñeta + 2 columnas) =====
function injectScreenHotelStyles(){
  if (document.getElementById('screen-hotel-styles')) return;
  const css = `
    .hoteles-list{
      list-style: disc;
      margin: 4px 0 0 18px;   /* mismo margen que el resto de listas */
      padding: 0;
    }
    .hoteles-list > li.hotel-item{ margin: 6px 0 8px; }
    .hoteles-list .hotel-grid{
      display: grid;
      grid-template-columns: var(--hotel-left-col, 240px) 1fr; /* ← columna ciudad auto-ajustada */
      column-gap: 16px;
    }
    .hoteles-list .hotel-left{ font-weight: 400; } /* sin negrita */
    .hoteles-list .hotel-right > div{ margin: 2px 0; }

    /* Responsive: apila en móviles */
    @media (max-width: 640px){
      .hoteles-list .hotel-grid{ grid-template-columns: 1fr; }
    }
  `;
  const s = document.createElement('style');
  s.id = 'screen-hotel-styles';
  s.textContent = css;
  document.head.appendChild(s);
}

// Menos aire en pantalla para la Hoja Resumen
function injectCompactScreenStyles(){
  if (document.getElementById('compact-screen-styles')) return;
  const css = `
    #hoja-resumen .legend{ margin:.25rem 0 .35rem 0 !important; }
    #hoja-resumen li{ margin-bottom:8px !important; }
    #hoja-resumen .subsec{ margin:.35rem 0 .2rem 0 !important; }
    #hoja-resumen table{ margin-top:2px !important; }
  `;
  const s = document.createElement('style');
  s.id = 'compact-screen-styles';
  s.textContent = css;
  document.head.appendChild(s);
}

function syncHotelColumnToDocs(){
  // pantalla
  const hoja = document.getElementById('hoja-resumen');
  const hotelesUL = hoja?.querySelector('li:nth-of-type(3) .hoteles-list');
  const refNacionales = hoja?.querySelector('li:nth-of-type(4) ul > li:first-child > div > strong'); // "NACIONALES:"
  if (hotelesUL && refNacionales) {
    const leftRef = refNacionales.getBoundingClientRect().left;    // donde parte "NACIONALES:"
    const leftUL  = hotelesUL.getBoundingClientRect().left;        // donde parte el contenido del UL de hotel
    const colPx   = Math.max(120, Math.round(leftRef - leftUL));   // ancho de columna IZQ para ciudad
    hotelesUL.style.setProperty('--hotel-left-col', colPx + 'px');
  }

  // impresión (#print-block)
  const printBlock = document.getElementById('print-block');
  const hotelesULPrint = printBlock?.querySelector('.hoteles-list');
  const refNacPrint = printBlock?.querySelector('.sec:nth-of-type(4) ul > li:first-child > div > strong');
  if (hotelesULPrint && refNacPrint) {
    const leftRefP = refNacPrint.getBoundingClientRect().left;
    const leftULP  = hotelesULPrint.getBoundingClientRect().left;
    const colPxP   = Math.max(120, Math.round(leftRefP - leftULP));
    hotelesULPrint.style.setProperty('--hotel-left-col', colPxP + 'px');
  }
}



/* ──────────────────────────────────────────────────────────────────────────
   Estilos de IMPRESIÓN (logo fijo, sin “caja”, tablas full width, etc.)
────────────────────────────────────────────────────────────────────────── */
function buildPrintDoc(grupo, vuelosNorm, hoteles, fechas){
  const P = extractPresentacion(grupo, vuelosNorm);
  const {
    idaLegsPlan, vueltaLegsPlan,
    hasColegioToAeropuerto, hasAeropuertoToColegio,
    transferTerrestreIda, transferTerrestreVuelta,
    transferAereoIda, transferAereoVuelta,
    terrestresPlanIda, terrestresPlanVuelta
  } = particionarVuelos(vuelosNorm);

  const fechaInicioViajeISO = computeFechaInicioViaje(vuelosNorm);
  const fechaInicioViajeTxt = fechaInicioViajeISO ? formatShortDate(fechaInicioViajeISO) : '—';

  const planLegend = `Los horarios a continuación pueden sufrir modificaciones sin previo aviso.`;
  const withHrs = t => t ? `${t} HRS` : '—';
  const U = s => String(s||'').toUpperCase();

  // AÉREO (impresión) → usa tabla
  const flightsBlock = (legs, modo) => {
    return printTablePlan(legs || [], modo, 'aereo');
  };
  
  // TERRESTRE (impresión) → usa tabla
  const busesBlock = (legs, modo) => {
    return printTablePlan(legs || [], modo, 'terrestre');
  };
  
  // TRANSFERS (solo para sección 1) → usa tablas
  const transfersBlock = (() => {
    const arr = [
      ...(transferTerrestreIda || []),
      ...(transferTerrestreVuelta || []),
      ...(transferAereoIda || []),
      ...(transferAereoVuelta || [])
    ];
    if (!arr.length) return '';
    return `
      <div class="flight-block">
        <div class="flights-header">TRASLADOS</div>
        ${printTableTransfers(arr)}
      </div>`;
  })();


  // Punto de encuentro (SOLO en sección 2)
  const puntoEncuentroTexto = (() => {
    if (idaLegsPlan.length) return P.encuentro || (idaLegsPlan[0]?.origen ? `Encuentro en Aeropuerto ${idaLegsPlan[0].origen}` : '');
    if (terrestresPlanIda.length) return `Encuentro en ${terrestresPlanIda[0]?.origen || ''}`;
    return '';
  })();


  // Hotelería
  const dmy = (s) => { const iso = toISO(s); if (!iso) return '—'; const [y,m,d] = iso.split('-'); return `${d}-${m}-${y}`; };
  const hotelesHtml = `
    <ul class="hoteles-list">
      ${(hoteles||[]).map(h=>{
        const H = h.hotel || {};
        const ciudad = (H.ciudad || h.ciudad || H.destino || h.destino || '').toString().toUpperCase();
        const hotel  = (h.hotelNombre || H.nombre || '—').toString().toUpperCase();
        const dir    = (H.direccion || h.direccion || '').toString();
        const tel1   = (H.contactoTelefono || '').toString().trim();
        const tel2   = (H.telefono || H.phone || H.contactoFono || '').toString().trim();
        const tels   = [tel1, tel2].filter(Boolean).join(' ');
        return `
          <li class="hotel-item">
            <div class="hotel-grid">
              <div class="hotel-left"><strong>${ciudad ? ciudad + ':' : '—'}</strong></div>
              <div class="hotel-right">
                <div><strong>${hotel}</strong></div>
                <div>In : ${dmy(h.checkIn)}</div>
                <div>Out: ${dmy(h.checkOut)}</div>
                ${dir  ? `<div>Dirección: ${dir}</div>` : ``}
                ${tels ? `<div>Fono: ${tels}</div>`     : ``}
                ${H.web ? `<div>Web: <a href="${H.web}" target="_blank" rel="noopener">${H.web}</a></div>` : ``}
              </div>
            </div>
          </li>`;
      }).join('')}
    </ul>`;

  const { docsText, equipajeText1, equipajeText2, recs } =
    getDERTextos(`${grupo.programa || ''} ${grupo.destino || ''}`, grupo.textos || {});
  const documentosHTML = renderDocsList(docsText);
  const recomendacionesHTML = Array.isArray(recs) ? recs.map(r => `<li>${r}</li>`).join('') : `<li>${recs}</li>`;

  // Itinerario
  const itinHTML = (() => {
    if (!fechas || !fechas.length) return '<div class="note">— Sin actividades —</div>';
    const days = fechas.map((f, i) => {
      const src = grupo.itinerario?.[f];
      const arr = (Array.isArray(src) ? src
                  : (src && typeof src==='object' ? Object.values(src) : []))
                  .sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));
      const acts = arr.map(a => (a?.actividad || '').toString().trim().toUpperCase()).filter(Boolean);
      const head = `DÍA ${i+1} - ${formatDateReadable(f).toUpperCase()}:`;
      const body = acts.length ? (acts.join(' — ')) : '—';
      return `<li class="it-day"><div class="day-head"><strong>${head}</strong></div><div>${body}</div></li>`;
    });
    return `<ul class="itinerario">${days.join('')}</ul>`;
  })();

  const titulo  = `Viaje de Estudios ${(grupo.colegio || grupo.cliente || '')} ${(grupo.curso || grupo.subgrupo || grupo.nombreGrupo || '')}`.trim();

  return `
    <div class="print-doc">
      <div class="doc-title">${titulo || ('Viaje de Estudios ' + (grupo.programa||''))}</div>
      <div class="sec-title">Fecha de inicio del viaje: ${fechaInicioViajeTxt}</div>

      <!-- 1. INFORMACIÓN GENERAL -->
      <div class="sec">
        <div class="sec-title">1. INFORMACIÓN GENERAL</div>
        <div class="note">
          ${hasColegioToAeropuerto ? 'El grupo contempla traslado COLEGIO → AEROPUERTO. ' : ''}
          ${hasAeropuertoToColegio ? 'Y traslado AEROPUERTO → COLEGIO.' : ''}
        </div>
        <p>Presentación: ${P.lugar}${P.presHora ? ` a las ${P.presHora} HRS` : ''}${P.aeropuerto ? ` EN ${U(P.aeropuerto)}` : ''}${P.salidaHora ? `; SALIDA A LAS ${P.salidaHora} HRS` : ''}.</p>
        ${transfersBlock}
      </div>

      <!-- 2. INFORMACIÓN DEL PLAN DE VIAJE -->
      <div class="sec">
        <div class="sec-title">2. INFORMACIÓN DEL PLAN DE VIAJE</div>
        <div class="note">${planLegend}</div>
        ${puntoEncuentroTexto ? `<p><strong>Punto de encuentro con coordinador(a):</strong> ${puntoEncuentroTexto}.</p>` : ''}
        ${flightsBlock(idaLegsPlan, 'ida') || ''}
        ${flightsBlock(vueltaLegsPlan, 'vuelta') || ''}
        ${(!idaLegsPlan.length && !vueltaLegsPlan.length) ? (busesBlock(terrestresPlanIda, 'ida') + busesBlock(terrestresPlanVuelta, 'vuelta')) : ''}
        ${(!idaLegsPlan.length && !vueltaLegsPlan.length && !terrestresPlanIda.length && !terrestresPlanVuelta.length) ? `<div class="note">— Sin información del plan —</div>` : ''}

      </div>

      <!-- 3. HOTELERÍA -->
      <div class="sec">
        <div class="sec-title">3. HOTELERÍA CONFIRMADA</div>
        ${hotelesHtml}
      </div>

      <!-- 4. DOCUMENTOS -->
      <div class="sec">
        <div class="sec-title">4. DOCUMENTOS PARA EL VIAJE</div>
        <ul>${documentosHTML}</ul>
      </div>

      <!-- 5. EQUIPAJE -->
      <div class="sec">
        <div class="sec-title">5. EQUIPAJE</div>
        <ul>
          <li>${equipajeText1}</li>
          <li>${equipajeText2}</li>
        </ul>
      </div>

      <!-- 6. RECOMENDACIONES -->
      <div class="sec">
        <div class="sec-title">6. RECOMENDACIONES GENERALES</div>
        <ul>${recomendacionesHTML}</ul>
      </div>

      <!-- 7. ITINERARIO -->
      <div class="sec itinerario-sec">
        <div class="sec-title">7. ITINERARIO DE VIAJE</div>
        <div class="note">El orden de las actividades podría ser modificado por razones de coordinación.</div>
        ${itinHTML}
      </div>

      <div class="closing">¡¡ TURISMO RAITRAI LES DESEA UN VIAJE INOLVIDABLE !!</div>
    </div>
  `;
}

/* ──────────────────────────────────────────────────────────────────────────
   MAIN
────────────────────────────────────────────────────────────────────────── */
async function main(){
  const { numeroNegocio, id, hideNotes } = getParamsFromURL();

  // ——— DOM refs y botón imprimir (REEMPLAZA TODO ESTE BLOQUE) ———
  const titleEl    = document.getElementById('grupo-title');
  const nombreEl   = document.getElementById('grupo-nombre');
  const numEl      = document.getElementById('grupo-numero');
  const destinoEl  = document.getElementById('grupo-destino');
  const fechasEl   = document.getElementById('grupo-fechas');
  const resumenPax = document.getElementById('resumen-pax');
  const cont       = document.getElementById('mi-itin');
  const printEl    = document.getElementById('print-block'); // ← solo una vez
  const btnPrint   = document.getElementById('btnPrint');    // ← declarado
  const btnShare   = document.getElementById('btnShare');

  // Estilos de impresión + acción del botón
  injectPrintStyles();
  injectCompactScreenStyles(); 
  if (btnPrint) btnPrint.addEventListener('click', () => window.print());

  if(!numeroNegocio && !id){
    if (cont) cont.innerHTML = `<p style="padding:1rem;">Falta <code>numeroNegocio</code> o <code>id</code> en la URL.</p>`;
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
  titleEl   && (titleEl.textContent   = ' ' + (g.programa || '—').toString().toUpperCase());
  nombreEl  && (nombreEl.textContent  = g.nombreGrupo || '—');
  numEl     && (numEl.textContent     = g.numeroNegocio ?? g.id ?? '—');
  destinoEl && (destinoEl.textContent = g.destino || '—');
  fechasEl  && (fechasEl.textContent  = formatDateRange(g.fechaInicio, g.fechaFin));
  
  const totalA = parseInt(g.adultos,10)||0, totalE = parseInt(g.estudiantes,10)||0;
  const total  = (totalA + totalE) || g.pax || g.cantidadgrupo || '';
  resumenPax && (resumenPax.textContent = total ? `👥 Total pax: ${total}${(totalA||totalE)?` (A:${totalA} · E:${totalE})`:''}` : '');


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
 if (!fechas.length) {
   cont.innerHTML = `<p style="padding:1rem;">No hay itinerario disponible.</p>`;
 } else {
   const slot = document.getElementById('itin-slot');
   renderItin(g, fechas, hideNotes, slot || cont);
 }

 // Genera el documento de IMPRESIÓN (una vez)
if (printEl) {
  printEl.innerHTML = buildPrintDoc(g, vuelosNorm, hoteles, fechas || []);
  ensurePrintLogo(); // ← NUEVO: inserta <img id="print-logo"> para que el @media print lo fije arriba-derecha
}
syncHotelColumnToDocs();
window.addEventListener('resize', syncHotelColumnToDocs);
window.addEventListener('beforeprint', syncHotelColumnToDocs);
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
