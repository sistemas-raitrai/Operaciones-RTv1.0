// documentacion.js
// Página de lotes PDF para confirmaciones (filtrado + exportación)
// NOTA: Requiere tu './firebase-core.js' (exporta { app, db })

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, query, where, orderBy, limit, startAfter
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// Fuerzo una clase de página para poder sobreescribir estilos globales
document.body.classList.add('confirmaciones-page');


/* ──────────────────────────────────────────────────────────────────────
   Utilidades básicas
────────────────────────────────────────────────────────────────────── */
const TZ = 'America/Santiago';

const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const safe = (v, fb='—') => (v===0||v)?v:fb;

// Espera activa a que una condición sea verdadera (o venza el timeout)
async function waitFor(testFn, timeout = 6000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (testFn()) return true; } catch { /* noop */ }
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

/* === UI CLARA + LAYOUT DE ANCHO COMPLETO PARA ESTA PÁGINA ============ */
function injectPageLightStyles(){
  if (document.getElementById('light-ui-overrides')) return;
  const css = `
    :root { color-scheme: light; }
    html, body { background:#f7f7f8 !important; color:#111 !important; }
    body.confirmaciones-page * { color-scheme: light; }

    /* === ancho completo (por si el CSS global prevalece) === */
    body.confirmaciones-page main.main.fullwidth,
    body.confirmaciones-page .main.fullwidth{
      max-width: none !important;
      width: 100% !important;
      margin: 12px 0 40px !important;
      padding-left: 12px !important;
      padding-right: 12px !important;
      display: block !important;
    }
    body.confirmaciones-page .main.fullwidth > .card{
      width: 100% !important;
      max-width: none !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      display: block !important;
      box-sizing: border-box;
    }
    body.confirmaciones-page .main.fullwidth table{
      width: 100% !important;
    }
    body.confirmaciones-page .main.fullwidth .filters .row{
      display: grid !important;
      gap: 12px !important;
      grid-template-columns: 1fr !important;
    }
    
    .print-doc{ margin:0 auto !important; }

    @media (min-width: 1000px){
      body.confirmaciones-page .main.fullwidth .filters .row{
        grid-template-columns: repeat(6, minmax(0, 1fr)) !important;
      }
    }
  `;
  const s = document.createElement('style');
  s.id = 'light-ui-overrides';
  s.textContent = css;
  document.head.appendChild(s);
}

injectPageLightStyles();

/* ====== NUEVO: utilidades para exportar PDF y contenedores ====== */
async function ensureHtml2Pdf(){
  if (window.html2pdf) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('No se pudo cargar html2pdf'));
    document.head.appendChild(s);
  });
}

function ensurePdfWork(){
  let el = document.getElementById('pdf-work');

  // Si no existe (por si lo quitas del HTML), lo creamos
  if (!el){
    el = document.createElement('div');
    el.id = 'pdf-work';
    document.body.appendChild(el);
  }

  // Estilo unificado: SIEMPRE en (0,0), invisible pero renderizable
  el.setAttribute('aria-hidden', 'true');
  el.style.position       = 'fixed';
  el.style.left           = '0';
  el.style.top            = '0';
  el.style.width          = '210mm';
  el.style.minHeight      = '297mm';
  el.style.display        = 'block';
  el.style.opacity        = '0';           // no se ve
  el.style.pointerEvents  = 'none';        // no captura clicks
  el.style.background     = '#ffffff';
  el.style.zIndex         = '-1';          // queda detrás de todo

  return el;
}



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
  const dt=new Date(Date.UTC(y,m-1,d));
  const mes=dt.toLocaleDateString('es-CL',{month:'long', timeZone:'UTC'});
  return `${d} de ${mes} ${y}`;
}

// NUEVO: para finanzas → "13 DIC"
function formatShortDayMonth(iso){
  if (!iso) return '—';
  const parts = iso.split('-').map(Number);
  if (parts.length < 3) return '—';
  const [y,m,d] = parts;
  if (!y || !m || !d) return '—';
  const dt = new Date(Date.UTC(y, m-1, d));
  let txt = dt.toLocaleDateString('es-CL', { day:'2-digit', month:'short', timeZone:'UTC' });
  // suele venir "13 dic." → sacamos el punto y dejamos mayúsculas
  txt = txt.replace(/\./g,'');
  return txt.toUpperCase();
}

// NUEVO: para rangos → "1 DIC al 7 DIC"
function formatRangeDayMonth(startIso, endIso){
  if (!startIso && !endIso) return '—';
  if (!startIso) return formatShortDayMonth(endIso);
  if (!endIso) return formatShortDayMonth(startIso);
  return `${formatShortDayMonth(startIso)} al ${formatShortDayMonth(endIso)}`;
}

function formatDMYDownload(date=new Date()){
  const dt = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const yyyy = dt.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

// NUEVO: rango de viaje (inicio / fin) para usar en finanzas
function computeRangoViaje(grupo, abonos){
  let inicio = toISO(grupo.fechaInicio || grupo.fechaViaje || '');
  let fin    = toISO(grupo.fechaFin || grupo.fechaRegreso || '');

  const it = grupo.itinerario;
  if ((!inicio || !fin) && it && typeof it === 'object'){
    const fechas = Object.keys(it).map(toISO).filter(Boolean).sort();
    if (!inicio && fechas.length) inicio = fechas[0];
    if (!fin && fechas.length)    fin    = fechas[fechas.length-1];
  }

  // último respaldo: rangos a partir de fechas de abonos
  if ((!inicio || !fin) && Array.isArray(abonos) && abonos.length){
    const fechasA = abonos
      .map(a => a.fechaActividadISO || a.fechaISO)
      .filter(Boolean)
      .sort();
    if (!inicio && fechasA.length) inicio = fechasA[0];
    if (!fin && fechasA.length)    fin    = fechasA[fechasA.length-1];
  }

  return {
    inicio: inicio || null,
    fin:    fin    || null
  };
}

function formatMoney(value, moneda='CLP'){
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (!isFinite(num)) return String(value);

  try{
    return new Intl.NumberFormat('es-CL', {
      style: 'currency',
      currency: moneda || 'CLP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(num);
  }catch(_){
    return `${num} ${moneda || ''}`.trim();
  }
}

function fileSafe(s=''){
  return s.toString().trim()
    .replace(/[\\/:*?"<>|]/g,'-')
    .replace(/\s+/g,'_')
    .replace(/_+/g,'_')
    .slice(0,120);
}

/* ──────────────────────────────────────────────────────────────────────
   VUELOS / HOTELES (mismas reglas que miviaje.js)
────────────────────────────────────────────────────────────────────── */
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

const cache = {
  hotelesIndex: null,
  hotelesByGroup: new Map(),
  vuelosByGroup: new Map(),
  // NUEVO: índices para servicios y proveedores por destino (BRASIL, SUR DE CHILE, etc.)
  serviciosByDestino: new Map(),
  proveedoresByDestino: new Map()
};

// NUEVO: resuelve uno o varios destinos "base" para buscar en
// Servicios/{DESTINO}/Listado y Proveedores/{DESTINO}/Listado
function getDestinoServiciosKeys(grupo){
  const raw = (grupo?.destino || '').toString().trim().toUpperCase();
  const keys = new Set();

  if (!raw) return [];

  // Destinos principales (ajusta o agrega más si es necesario)
  if (raw.includes('BRASIL'))         keys.add('BRASIL');
  if (raw.includes('SUR DE CHILE'))   keys.add('SUR DE CHILE');
  if (raw.includes('BARILOCHE'))      keys.add('BARILOCHE');
  if (raw.includes('NORTE DE CHILE')) keys.add('NORTE DE CHILE');

  // Ejemplos:
  //  - "SUR DE CHILE Y BARILOCHE"  → ["SUR DE CHILE","BARILOCHE"]
  //  - "BRASIL - ITAPEMA 2025"     → ["BRASIL"]

  // Si no se detectó ninguno, usamos el texto tal cual como key de colección
  if (!keys.size) keys.add(raw);

  return [...keys];
}

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
    const cands2 = all.filter(h => norm(h.destino||h.ciudad||'')===dest);
    return cands2[0] || null;
  };

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
      __ord: idx, __ts: ts,
      hotel:H,
      hotelNombre:a?.hotelNombre || a?.nombre || H?.nombre || '',
      checkIn:ci, checkOut:co, noches
    };
  });

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
  const out = [...byRange.values()].sort((a,b)=>(a.checkIn||'').localeCompare(b.checkIn||''));
  cache.hotelesByGroup.set(key,out);
  return out;
}

async function loadVuelosInfo(g){
  if (!cache.vuelosByGroup) cache.vuelosByGroup = new Map();
  const groupDocId = String(g.id || '').trim();
  const groupNum   = String(g.numeroNegocio || '').trim();
  const key = `vuelos:${groupDocId || groupNum}`;
  if (cache.vuelosByGroup.has(key)) return cache.vuelosByGroup.get(key);

  const vistos = new Map();
  const pushSnap = (snap) => { if (!snap) return; snap.forEach(d => vistos.set(d.id, { id:d.id, ...(d.data()||{}) })); };
  const runQs = async (qs) => { const snaps = await Promise.all(qs.map(q => q ? getDocs(q).catch(()=>null) : null)); snaps.forEach(pushSnap); };
  const coll = (name) => collection(db, name);
  const numAsNumber = Number(groupNum);

  await runQs([
    groupDocId ? query(coll('vuelos'), where('grupoIds','array-contains', groupDocId)) : null,
    groupNum   ? query(coll('vuelos'), where('grupoIds','array-contains', groupNum))   : null,
    (groupNum && !Number.isNaN(numAsNumber))
      ? query(coll('vuelos'), where('grupoIds','array-contains', numAsNumber)) : null
  ]);

  if (vistos.size === 0) {
    await runQs([
      groupDocId ? query(coll('vuelos'), where('grupoId','==',groupDocId))   : null,
      groupDocId ? query(coll('vuelos'), where('grupoDocId','==',groupDocId)): null,
      groupDocId ? collection(db, 'grupos', groupDocId, 'vuelos')            : null
    ]);
  }

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

  if (vistos.size === 0) {
    let last = null, loops = 0;
    while (loops++ < 3) {
      const q = last
        ? query(coll('vuelos'), orderBy('fechaIda','desc'), startAfter(last), limit(50))
        : query(coll('vuelos'), orderBy('fechaIda','desc'), limit(50));
      const snap = await getDocs(q).catch(()=>null);
      if (!snap || !snap.size) break;
      snap.forEach(d => {
        const v = d.data() || {};
        const xid  = String(v.grupoId || v.grupoDocId || '').trim();
        const xnum = String(v.grupoNumero || v.numeroNegocio || '').trim();
        if ((groupDocId && xid === groupDocId) || (groupNum && xnum === groupNum)) {
          vistos.set(d.id, { id:d.id, ...v });
        }
      });
      last = snap.docs[snap.docs.length - 1];
      if (vistos.size) break;
    }
  }

  const out = [...vistos.values()].sort((a,b)=>{
    const aF = toISO(a.fechaIda || a.fechaVuelta || a.fecha || '');
    const bF = toISO(b.fechaIda || b.fechaVuelta || b.fecha || '');
    if (aF !== bF) return aF.localeCompare(bF);
    return ( (a.updatedAt?.seconds||a.createdAt?.seconds||0) - (b.updatedAt?.seconds||b.createdAt?.seconds||0) );
  });
  cache.vuelosByGroup.set(key, out);
  return out;
}

// ================== SERVICIOS + PROVEEDORES (para vouchers) ==================

async function ensureServiciosIndex(destinoKeyRaw){
  const destinoKey = (destinoKeyRaw || '').toString().trim();
  if (!destinoKey){
    return {
      serviciosByNombre: new Map(),
      proveedoresByNombre: new Map()
    };
  }

  // Si ya lo tenemos cacheado, lo devolvemos
  if (cache.serviciosByDestino.has(destinoKey)){
    return {
      serviciosByNombre: cache.serviciosByDestino.get(destinoKey),
      proveedoresByNombre: cache.proveedoresByDestino.get(destinoKey) || new Map()
    };
  }

  const serviciosByNombre = new Map();
  const proveedoresByNombre = new Map();

  // 1) Cargar servicios: Servicios/{DESTINO}/Listado
  try{
    const collServ = collection(db, 'Servicios', destinoKey, 'Listado');
    const snapServ = await getDocs(collServ);
    snapServ.forEach(d => {
      const x = d.data() || {};
      const baseNombre = (x.servicio || d.id || '').toString();
      const slugBase = norm(baseNombre);
      if (!slugBase) return;

      const docu = { id:d.id, ...x };
      serviciosByNombre.set(slugBase, docu);

      // alias y prevIds también apuntan al mismo servicio
      if (Array.isArray(x.aliases)){
        x.aliases.forEach(a => {
          const s = norm(a);
          if (s) serviciosByNombre.set(s, docu);
        });
      }
      if (Array.isArray(x.prevIds)){
        x.prevIds.forEach(a => {
          const s = norm(a);
          if (s) serviciosByNombre.set(s, docu);
        });
      }
    });
  }catch(e){
    console.warn('No se pudieron cargar Servicios para destino', destinoKey, e);
  }

  // 2) Cargar proveedores: Proveedores/{DESTINO}/Listado
  try{
    const collProv = collection(db, 'Proveedores', destinoKey, 'Listado');
    const snapProv = await getDocs(collProv);
    snapProv.forEach(d => {
      const x = d.data() || {};
      const nombre = (x.proveedor || d.id || '').toString();
      const slug = norm(nombre);
      if (!slug) return;
      proveedoresByNombre.set(slug, { id:d.id, ...x });
    });
  }catch(e){
    console.warn('No se pudieron cargar Proveedores para destino', destinoKey, e);
  }

  cache.serviciosByDestino.set(destinoKey, serviciosByNombre);
  cache.proveedoresByDestino.set(destinoKey, proveedoresByNombre);

  return { serviciosByNombre, proveedoresByNombre };
}

function normalizeVuelo(v){
  const get=(...keys)=>{ for(const k of keys){ const val=k.split('.').reduce((acc,part)=> (acc && acc[part]!==undefined)? acc[part] : undefined, v); if(val!==undefined && val!==null && val!=='') return val; } return ''; };
  const numero    = String(get('numero','nro','numVuelo','vuelo','flightNumber','codigo','code')||'').toUpperCase();
  const proveedor = String(get('proveedor','empresa','aerolinea','compania')||'').toUpperCase();
  const tipoTransporte = norm(String(get('tipoTransporte') || 'aereo'));
  const tipoVuelo = (tipoTransporte==='aereo') ? (String(get('tipoVuelo')||'charter').toLowerCase()) : '';
  const presentacionIdaHora    = normTime(get('presentacionIdaHora'));
  const vueloIdaHora           = normTime(get('vueloIdaHora'));
  const presentacionVueltaHora = normTime(get('presentacionVueltaHora'));
  const vueloVueltaHora        = normTime(get('vueloVueltaHora'));
  const llegadaIdaHora    = normTime(get('llegadaIdaHora','arriboIdaHora','horaArriboIda','arriboHoraIda'));
  const llegadaVueltaHora = normTime(get('llegadaVueltaHora','arriboVueltaHora','horaArriboVuelta','arriboHoraVuelta'));
  const idaHora    = normTime(get('idaHora'));
  const vueltaHora = normTime(get('vueltaHora'));
  const origen      = String(get('origen','desde','from','salida.origen','salida.iata','origenIATA','origenSigla','origenCiudad')||'').toUpperCase();
  const destino     = String(get('destino','hasta','to','llegada.destino','llegada.iata','destinoIATA','destinoSigla','destinoCiudad')||'').toUpperCase();
  const fechaIda    = toISO(get('fechaIda','ida','salida.fecha','fechaSalida','fecha_ida','fecha'));
  const fechaVuelta = toISO(get('fechaVuelta','vuelta','regreso.fecha','fechaRegreso','fecha_vuelta'));
  const isTransfer  = !!get('isTransfer');
  const transferLeg = String(get('transferLeg')||'').toLowerCase();
  const encontro    = String(get('encuentroAeropuerto')||'').toUpperCase();
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
    encuentroAeropuerto: encontro
  };
}

// Particionar y devolver SOLO aéreos de plan (sin transfers)
function particionarVuelos(vuelosNorm) {
  const aereos = [];
  const esTerrestre = (v) => norm(v.tipoTransporte || '') !== 'aereo';
  const legFrom = (v, t = {}) => {
    const aerolinea = String(t.aerolinea || v.proveedor || '').toUpperCase();
    const numero    = String(t.numero    || v.numero    || '').toUpperCase();
    const origen    = String(t.origen    || v.origen    || '').toUpperCase();
    const destino   = String(t.destino   || v.destino   || '').toUpperCase();
    const fechaIda    = toISO(t.fechaIda    || v.fechaIda    || '');
    const fechaVuelta = toISO(t.fechaVuelta || v.fechaVuelta || '');
    const presentacionIda    = normTime(t.presentacionIdaHora    || v.presentacionIdaHora);
    const presentacionVuelta = normTime(t.presentacionVueltaHora || v.presentacionVueltaHora);
    const salidaIda          = normTime(t.vueloIdaHora           || v.vueloIdaHora);
    const salidaVuelta       = normTime(t.vueloVueltaHora        || v.vueloVueltaHora);
    const arriboIda          = normTime(t.arriboIdaHora || t.llegadaIdaHora || v.llegadaIdaHora);
    const arriboVuelta       = normTime(t.arriboVueltaHora || t.llegadaVueltaHora || v.llegadaVueltaHora);
    const fecha = toISO(fechaIda || fechaVuelta || '');
    const tipoVuelo = String(v.tipoVuelo || '').toLowerCase();
    const isTransfer = !!v.isTransfer || /^(ida|vuelta|ida\+vuelta)$/.test(String(v.transferLeg||'').toLowerCase());
    return {
      fecha, fechaIda, fechaVuelta,
      aerolinea, numero, origen, destino,
      presentacionIda, presentacionVuelta,
      salidaIda, salidaVuelta, arriboIda, arriboVuelta,
      tipoTransporte: v.tipoTransporte || 'aereo',
      tipoVuelo, isTransfer
    };
  };

  for (const v of (vuelosNorm || [])) {
    if (esTerrestre(v)) continue; // sólo aéreos
    if (Array.isArray(v.tramos) && v.tramos.length) v.tramos.forEach(t => aereos.push(legFrom(v, t)));
    else aereos.push(legFrom(v));
  }

  aereos.sort((x, y) => (x.fecha || '').localeCompare(y.fecha || ''));

  const idaLegsAll    = aereos.filter(l => l.fechaIda);
  const vueltaLegsAll = aereos.filter(l => l.fechaVuelta);
  const idaLegsPlan    = idaLegsAll.filter(l => !l.isTransfer);
  const vueltaLegsPlan = vueltaLegsAll.filter(l => !l.isTransfer);

  return { idaLegsPlan, vueltaLegsPlan };
}

// *** Regla solicitada: SOLO primer vuelo de ida ***
function computeInicioSoloPrimerVueloIda(vuelosNorm){
  const { idaLegsPlan } = particionarVuelos(vuelosNorm);
  const xs = (idaLegsPlan||[]).map(x=> toISO(x.fechaIda || x.fecha)).filter(Boolean).sort();
  return xs[0] || ''; // si no hay vuelos de ida → ''
}

/* ──────────────────────────────────────────────────────────────────────
   Textos y armado del documento (igual que miviaje.js, versión compacta)
────────────────────────────────────────────────────────────────────── */
function getDERTextos(programa, overrides = {}) {
  const P = norm(programa || '');
  const equipajeText1 = overrides.equipaje1 ||
    'Equipaje en bodega 01 Maleta (peso máximo 23 kg.) el cual debe tener como medidas máximo 158 cm lineales (largo, ancho, alto), más un bolso de mano (peso máximo 5 Kg.). Equipaje adicional será cobrado por la empresa de transporte respectiva.';
  const equipajeText2 = overrides.equipaje2 ||
    'Está prohibido transportar líquidos, elementos corto-punzantes o de aseo en el bolso de mano.';
  if (/(^|[\W])(bariloche|brasil)(?=$|[\W])/.test(P)) {
    const docsText = overrides.documentos || [
      { title:'NACIONALES', items:[
        'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).',
        'Verificar que la autorización notarial de quienes tengan la patria potestad del menor esté con los datos correctos de Nombres / Rut, la cédula de identidad debe estar en óptimas condiciones para que los pasajeros no tengan problemas para salir del país.'
      ] },
      { title:'EXTRANJEROS', items:[
        'Verificar que Cédula de Identidad Chilena y Pasaporte de origen, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).',
        'Verificar con consulado del país de destino los requerimientos según nacionalidad. Es responsabilidad de los tutores la documentación correcta.'
      ] }
    ];
    const recs = overrides.recomendaciones || [
      'Llevar ropa y calzado cómodo, adecuado al clima del destino. Llevar protector solar.',
      'Llevar una botella reutilizable para el consumo de agua.',
      'La documentación debe quedar bajo supervisión de los adultos.',
      'Las pertenencias personales son de responsabilidad de cada persona.',
      'Se recomienda que los adultos tengan fotocopia de las Cédulas de Identidad de todos los pasajeros.'
    ];
    return { docsText, equipajeText1, equipajeText2, recs };
  }
  if (/huilo\W*huilo/.test(P)) {
    const docsText = overrides.documentos ||
      'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).';
    const recs = overrides.recomendaciones || [
      'Llevar ropa y calzado cómodo, adecuado al clima. Protector solar.',
      'Botella reutilizable de agua.',
      'Saco de dormir.',
      'Toalla, shampoo y jabón (Huilo Huilo NO INCLUYE TOALLAS NI AMENIDADES).',
      'La documentación bajo supervisión de los adultos.',
      'Evitar llevar objetos de valor.'
    ];
    return { docsText, equipajeText1, equipajeText2, recs };
  }
  const docsText = overrides.documentos ||
    'Verificar que Cédula de Identidad o Pasaporte, esté en buen estado y vigente (mínimo 6 meses a futuro al momento del viaje).';
  const recs = overrides.recomendaciones || [
    'Llevar ropa y calzado cómodo, adecuado al clima. Protector solar.',
    'Botella reutilizable.',
    'La documentación bajo supervisión de los adultos.',
    'Evitar llevar objetos de valor.',
    'Copias de cédulas de identidad de todos los pasajeros.'
  ];
  return { docsText, equipajeText1, equipajeText2, recs };
}

function renderDocsList(docsText) {
  if (Array.isArray(docsText)) {
    if (docsText.length && typeof docsText[0] === 'object' && Array.isArray(docsText[0].items)) {
      return docsText.map(sec => `
        <li>
          <div><strong>${sec.title}:</strong></div>
          <ul style="margin:4px 0 0 18px;list-style:disc;">
            ${sec.items.map(it => `<li>${it}</li>`).join('')}
          </ul>
        </li>`).join('');
    }
    return docsText.map(t => `<li>${t}</li>`).join('');
  }
  return `<li>${docsText}</li>`;
}

// Estilos para captura html2pdf (pantalla). Mantiene estética limpia A4.
function injectPdfStyles(){
  if (document.getElementById('pdf-styles')) return;
  const css = `
  /* Margen REAL por página: se aplica en TODAS las hojas
     (soluciona que la segunda hoja salga sin margen) */
  @page {
    size: A4 portrait;
    margin: 25mm 10mm 25mm 10mm; /* top right bottom left */
  }

  .print-doc{ page-break-after: always; }
  .print-doc:last-child{ page-break-after: auto; }

  .print-doc{
    background:#ffffff !important;
    color:#111 !important;
    width:190mm !important;           /* zona segura para evitar cortes */
    min-height:auto;                  /* que crezca según contenido, sin forzar alto fijo */
    box-sizing:border-box;
    /* ahora el “margen fuerte” lo da @page; este padding es solo acolchado interno */
    padding:4mm 6mm 6mm 6mm;
    margin:0 auto !important;
    font:11pt/1.28 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  }

  ...
  .finanzas-doc .vouchers-section + .finanzas-footnote{
    margin-top:10mm;
  }

  /* Separación normal entre líneas de firma */
  .finanzas-doc .finanzas-footnote + .finanzas-footnote{
    margin-top:4mm;
  }

    /* Espacios dobles entre I, II y III */
  /* I. ABONOS después del bloque de COORDINADOR(A) */
  .finanzas-doc .finanzas-coord + .sec{
    margin-top:8mm;        /* separa COORDINADOR de I. ABONOS */
  }

  /* II. ACTIVIDADES CON VOUCHERS después de I. ABONOS */
  .finanzas-doc .sec + .vouchers-section{
    margin-top:8mm;        /* doble espacio entre I y II */
  }

  /* III. ACTIVIDADES CON TICKETS después de II */
  .finanzas-doc .vouchers-section + .vouchers-section{
    margin-top:8mm;        /* doble espacio entre II y III */
  }

  .finanzas-doc .vouchers-section + .finanzas-footnote{
    margin-top:10mm;
  }

  /* Separación normal entre líneas de firma */
  .finanzas-doc .finanzas-footnote + .finanzas-footnote{
    margin-top:4mm;
  }

  /* Extra separación entre bloque de coordinador y sección I (abonos) */
  .finanzas-doc .finanzas-coord{
    margin-bottom:8mm;
  }
  .finanzas-doc .finanzas-abonos{
    margin-top:2mm; /* se suma al margen general de .sec */
  }

  /* Tabla de abonos bien marcada (bordes completos) */
  .finanzas-doc .finanzas-table{
    width:100%;
    border-collapse:collapse;
    border:0.6pt solid #000;
    font-size:9pt;
    margin-top:2mm;
  }
  .finanzas-doc .finanzas-table th,
  .finanzas-doc .finanzas-table td{
    border:0.6pt solid #000;
    padding:1.5mm 2mm;
    text-align:left;
    vertical-align:middle;
  }
  .finanzas-doc .finanzas-table thead th{
    background:#f2f2f2;
    font-weight:700;
    text-transform:uppercase;
    font-size:8.5pt;
  }
  .finanzas-doc .finanzas-table tfoot td.finanzas-total-label{
    font-weight:700;
    text-align:right;
  }
  .finanzas-doc .finanzas-table tfoot td.finanzas-total-value{
    font-weight:700;
  }
  .finanzas-doc .finanzas-table td.nowrap,
  .finanzas-doc .finanzas-table th.nowrap{
    white-space:nowrap;
  }
  .finanzas-doc .finanzas-table .no-rows{
    text-align:center;
    padding:3mm 2mm;
    font-style:italic;
  }

  /* ===== VOUCHERS FÍSICOS (3 por página aprox.) ===== */
  .vouchers-doc{
    min-height:auto !important;
  }
  .vouchers-doc .vouchers-header{
    margin-bottom:4mm;
  }
  .vouchers-doc .vouchers-title{
    font-size:14pt;
    font-weight:800;
    margin:0 0 1mm 0;
  }
  .vouchers-doc .vouchers-subtitle{
    font-size:10.5pt;
    font-weight:600;
    margin:0 0 1mm 0;
  }
  .vouchers-doc .vouchers-meta span{
    display:inline-block;
    font-size:9pt;
    margin-right:4mm;
  }

  .vouchers-doc .voucher-grid{
    display:grid;
    grid-template-columns:1fr;
    gap:4mm;
  }
  @media print{
    .vouchers-doc .voucher-grid{
      grid-template-columns:1fr;
    }
  }

  .voucher-card{
    border:0.6pt solid #111;
    padding:3mm 4mm;
    min-height:75mm;               /* pensado para ~3 vouchers por página */
    box-sizing:border-box;
    display:flex;
    flex-direction:column;
    justify-content:space-between;
    page-break-inside:avoid;
    break-inside:avoid;
  }

  .voucher-header{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    margin-bottom:2mm;
    gap:3mm;
  }
  .voucher-title{
    font-size:11pt;
    font-weight:800;
    margin:0;
  }
  .voucher-subtitle{
    font-size:9pt;
    text-transform:uppercase;
    letter-spacing:.06em;
    margin:0 0 1mm 0;
  }
  .voucher-group{
    font-size:9pt;
    margin-bottom:1mm;
  }
  .voucher-meta{
    font-size:8.5pt;
  }
  .voucher-meta span{
    display:inline-block;
    margin-right:3mm;
  }
  .voucher-logo img{
    max-height:14mm;
    width:auto;
  }

  .voucher-body{
    font-size:9.5pt;
  }
  .voucher-row{
    margin:1mm 0;
  }
  .voucher-row .lbl{
    font-weight:700;
  }

  .voucher-asistencia-box{
    border:0.5pt solid #111;
    padding:2mm 3mm;
    margin-top:1mm;
  }
  .voucher-asistencia-inner{
    display:flex;
    flex-wrap:wrap;
    gap:4mm;
    font-size:9pt;
  }
  .voucher-asistencia-inner span{
    flex:1 1 auto;
  }

  .voucher-observaciones-box{
    border:0.5pt solid #111;
    margin-top:1mm;
    min-height:16mm;
  }

  .voucher-footer{
    margin-top:3mm;
    display:grid;
    grid-template-columns:1fr 1fr 1fr;
    gap:4mm;
    font-size:8.5pt;
  }
  .voucher-firma-label{
    margin-bottom:3mm;
  }
  .voucher-firma-line{
    border-bottom:0.5pt solid #111;
    height:0;
    margin-top:6mm;
  }

    /* ===== AJUSTE CABECERA RESUMEN OPERATIVO (FINANZAS) ===== */
  .finanzas-header{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap:8mm;
    margin-bottom:6mm;
  }

  .finanzas-title-block{
    flex:1 1 auto;
  }

  .finanzas-title{
    font-size:16pt;
    font-weight:800;
    text-transform:uppercase;
    margin:0 0 2mm 0;
  }

  .finanzas-subtitle{
    font-size:11pt;
    font-weight:600;
    margin:0 0 2mm 0;
  }

  .finanzas-meta{
    font-size:9pt;
  }

  .finanzas-meta span{
    display:inline-block;
    margin-right:4mm;
  }

  .finanzas-logo{
    flex:0 0 auto;
    text-align:right;
  }

  .finanzas-logo img{
    max-height:14mm;
    width:auto;
    display:block;
  }

  `;
  const s = document.createElement('style');
  s.id = 'pdf-styles';
  s.textContent = css;
  document.head.appendChild(s);
}


/* ======================================================================
   NUEVO: IMPRESIÓN NATIVA (SIN HTML2PDF)
   - Reusa #pdf-work como contenedor oculto
   - Oculta toda la UI en @media print y muestra sólo .print-doc
====================================================================== */
function injectNativePrintStyles(){
  if (document.getElementById('native-print-styles')) return;

  const css = `
    @media print{
      html, body{
        margin:0 !important;
        padding:0 !important;
        background:#ffffff !important;
        color:#000000 !important;
      }

      /* Oculta todo lo demás y deja sólo el contenido imprimible */
      body > *:not(#pdf-work){
        display:none !important;
      }

      #pdf-work{
        display:block !important;
        position:static !important;
        opacity:1 !important;
        pointer-events:auto !important;
        width:auto !important;
        min-height:auto !important;
        z-index:1 !important;
        background:#ffffff !important;
      }

      #pdf-work .print-doc{
        page-break-after:always;
      }
      #pdf-work .print-doc:last-child{
        page-break-after:auto;
      }
    }
  `;

  const s = document.createElement('style');
  s.id = 'native-print-styles';
  s.textContent = css;
  document.head.appendChild(s);
}


/**
 * Recibe HTML con uno o varios <div class="print-doc"> y abre el
 * diálogo de impresión del navegador usando #pdf-work como contenedor.
 */
function imprimirHtml(html){
  injectPdfStyles();          // estilos A4 de .print-doc y finanzas
  injectNativePrintStyles();

  const work = ensurePdfWork();
  work.innerHTML = html;

  // pequeño delay para que el layout se calcule antes de imprimir
  setTimeout(() => {
    window.focus();
    window.print();
  }, 150);
}

function buildPrintDoc(grupo, vuelosNorm, hoteles, fechas){
  const { idaLegsPlan, vueltaLegsPlan } = particionarVuelos(vuelosNorm);
  const fechaInicioViajeISO = computeInicioSoloPrimerVueloIda(vuelosNorm); // ← regla solicitada
  const fechaInicioViajeTxt = fechaInicioViajeISO ? formatShortDate(fechaInicioViajeISO) : '—';

  // Punto de encuentro: si hay ida, usa origen del primer aereo ida
  const puntoEncuentroTexto = (() => {
    if (idaLegsPlan.length) return idaLegsPlan[0]?.origen ? `Encuentro en Aeropuerto ${idaLegsPlan[0].origen}` : '';
    return '';
  })();

  const withHrs = t => t ? `${t} HRS` : '—';
  const U = s => String(s||'').toUpperCase();

  const flightsBlock = (legs, modo) => {
    if (!legs || !legs.length) return '';
    const header = (() => {
      const f = legs[0];
      const chooseNum = (raw) => {
        const s = String(raw||'').toUpperCase();
        if (!s.includes('//')) return s;
        const p = s.split('//').map(x=>x.trim());
        return (modo === 'ida') ? (p[0]||'') : (p[p.length-1]||'');
      };
      const nro = chooseNum(f.numero);
      const via = f.aerolinea ? ` VÍA ${U(f.aerolinea)}` : '';
      return `${modo==='ida' ? 'IDA' : 'VUELTA'}: VUELO ${nro}${via}`;
    })();

    const legsHtml = legs.map(l=>{
      const fecha = (modo==='ida') ? (l.fechaIda || l.fecha) : (l.fechaVuelta || l.fecha);
      const pres  = (modo==='ida') ? l.presentacionIda : l.presentacionVuelta;
      const sal   = (modo==='ida') ? l.salidaIda       : l.salidaVuelta;
      const arr   = (modo==='ida') ? l.arriboIda       : l.arriboVuelta;
      return `
        <ul class="flight-lines">
          <li><span class="lbl">Fecha:</span> ${formatShortDate(fecha)}</li>
          <li><span class="lbl">Origen:</span> ${U(l.origen)}</li>
          <li><span class="lbl">Presentación:</span> ${withHrs(pres)}</li>
          <li><span class="lbl">Hora de salida:</span> ${withHrs(sal)}</li>
          <li><span class="lbl">Destino:</span> ${U(l.destino)}</li>
          <li><span class="lbl">Hora de arribo:</span> ${withHrs(arr)}</li>
        </ul>`;
    }).join('');

    return `<div class="flight-block"><div class="flights-header">${header}</div><div class="flight-legs">${legsHtml}</div></div>`;
  };

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

  const titulo  = `Viaje de Estudios ${(grupo.colegio || grupo.cliente || '')} ${(grupo.curso || grupo.subgrupo || grupo.nombreGrupo || '')}`.trim();

  // Itinerario compacto (para PDF)
  const itinHTML = (() => {
    const fechas = (() => {
      if (grupo.itinerario && typeof grupo.itinerario==='object') return Object.keys(grupo.itinerario).sort((a,b)=> new Date(a)-new Date(b));
      if (grupo.fechaInicio && grupo.fechaFin) {
        const out=[]; const A=toISO(grupo.fechaInicio), B=toISO(grupo.fechaFin);
        if(A&&B){ const a=new Date(A), b=new Date(B); for(let d=new Date(a); d<=b; d.setDate(d.getDate()+1)){ out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);} }
        return out;
      }
      return [];
    })();
    if (!fechas.length) return '<div class="note">— Sin actividades —</div>';
    const days = fechas.map((f, i) => {
      const src = grupo.itinerario?.[f];
      const arr = (Array.isArray(src) ? src : (src && typeof src==='object' ? Object.values(src) : []))
        .sort((a,b)=>(normTime(a?.horaInicio)||'99:99').localeCompare(normTime(b?.horaInicio)||'99:99'));
      const acts = arr.map(a => (a?.actividad || '').toString().trim().toUpperCase()).filter(Boolean);
      const head = `DÍA ${i+1} - ${new Date(f).toLocaleDateString('es-CL',{weekday:'long', day:'2-digit', month:'2-digit'}).toUpperCase()}:`;
      const body = acts.length ? (acts.join(' — ')) : '—';
      return `<li class="it-day"><div class="day-head"><strong>${head}</strong></div><div>${body}</div></li>`;
    });
    return `<ul class="itinerario">${days.join('')}</ul>`;
  })();

  return `
    <div class="print-doc">
      <div class="doc-title">${titulo || ('Viaje de Estudios ' + (grupo.programa||''))}</div>
      <div class="sec-title">Fecha de inicio del viaje: ${fechaInicioViajeTxt}</div>

      <div class="sec">
        <div class="sec-title">1. INFORMACIÓN GENERAL</div>
        ${puntoEncuentroTexto ? `<p><strong>Punto de encuentro con coordinador(a):</strong> ${puntoEncuentroTexto}.</p>` : ''}
      </div>

      <div class="sec">
        <div class="sec-title">2. INFORMACIÓN DEL PLAN DE VIAJE</div>
        ${flightsBlock(idaLegsPlan, 'ida') || '<div class="note">— Sin vuelos de ida —</div>'}
        ${flightsBlock(vueltaLegsPlan, 'vuelta') || ''}
      </div>

      <div class="sec">
        <div class="sec-title">3. HOTELERÍA CONFIRMADA</div>
        ${hotelesHtml}
      </div>

      <div class="sec">
        <div class="sec-title">4. DOCUMENTOS PARA EL VIAJE</div>
        <ul>${documentosHTML}</ul>
      </div>

      <div class="sec">
        <div class="sec-title">5. EQUIPAJE</div>
        <ul><li>${equipajeText1}</li><li>${equipajeText2}</li></ul>
      </div>

      <div class="sec">
        <div class="sec-title">6. RECOMENDACIONES GENERALES</div>
        <ul>${recomendacionesHTML}</ul>
      </div>

      <div class="sec">
        <div class="sec-title">7. ITINERARIO DE VIAJE</div>
        <div class="note">El orden de las actividades podría ser modificado por razones de coordinación.</div>
        ${itinHTML}
      </div>

      <div class="closing">¡¡ TURISMO RAITRAI LES DESEA UN VIAJE INOLVIDABLE !!</div>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────
// Helper: construir HTML de confirmación para un grupo
// ──────────────────────────────────────────────────────────────
async function buildConfirmacionHTML(grupoId){
  // 1) Traer el grupo
  const d = await getDoc(doc(db,'grupos', grupoId));
  if (!d.exists()) return '';
  const g = { id:d.id, ...d.data() };

  // 2) Datos necesarios para render local (igual que antes en descargarUno)
  const vuelosDocs = await loadVuelosInfo(g);
  const vuelosNorm = (vuelosDocs || []).map(normalizeVuelo);
  const hoteles    = await loadHotelesInfo(g);

  // 3) Fechas para el itinerario (si aplica)
  const fechas = (() => {
    if (g.itinerario && typeof g.itinerario==='object') {
      return Object.keys(g.itinerario).sort((a,b)=> new Date(a)-new Date(b));
    }
    if (g.fechaInicio && g.fechaFin) {
      const out=[]; const A=toISO(g.fechaInicio), B=toISO(g.fechaFin);
      if(A&&B){
        const a=new Date(A), b=new Date(B);
        for(let d=new Date(a); d<=b; d.setDate(d.getDate()+1)){
          out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
        }
      }
      return out;
    }
    return [];
  })();

  // 4) Devuelve el HTML que antes se mandaba a html2pdf
  return buildPrintDoc(g, vuelosNorm, hoteles, fechas);
}

// ──────────────────────────────────────────────────────────────
// FINANZAS: leer subcolección finanzas_abonos del grupo
// ──────────────────────────────────────────────────────────────
async function fetchFinanzasAbonos(grupoId){
  const out = [];
  try{
    const col = collection(db, 'grupos', grupoId, 'finanzas_abonos');
    const snap = await getDocs(col);
    snap.forEach(d => {
      const x = d.data() || {};
      const fechaISO = toISO(x.fecha || x.createdAt || x.fechaMovimiento || '');

      // PRIORIZA "valor" (tu esquema actual)
      let montoNum = null;
      ['valor','monto','total','montoCLP','totalCLP'].some(k => {
        if (typeof x[k] === 'number' && isFinite(x[k])) {
          montoNum = x[k];
          return true;
        }
        return false;
      });

      const moneda = (x.moneda || 'CLP').toString().trim().toUpperCase();

      out.push({
        id: d.id,
        fechaISO,
        asunto:   (x.asunto || '').toString(),
        actividad:(x.actividad || x.servicio || '').toString(),  // ← NUEVO
        concepto: (x.concepto  || '').toString(),                // ← NUEVO
        medio:    (x.medio || '').toString(),
        moneda:   moneda || 'CLP',
        montoNum,
        comentarios: (x.comentarios || '').toString()
      });
    });
    // Orden base por fecha del abono (luego reordenamos por fecha de actividad)
    out.sort((a,b)=> (a.fechaISO || '').localeCompare(b.fechaISO || ''));
  }catch(e){
    console.error('Error cargando finanzas_abonos para', grupoId, e);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// ITINERARIO: mapear actividades a fecha (YYYY-MM-DD)
// ──────────────────────────────────────────────────────────────
function buildItinerarioIndex(grupo){
  // index: nombreActividadNormalizado -> fechaISO
  const idx = new Map();
  const it = grupo.itinerario;

  if (!it || typeof it !== 'object') return idx;

  Object.entries(it).forEach(([dia, raw]) => {
    const fechaISO = toISO(dia);
    if (!fechaISO) return;

    const arr = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' ? Object.values(raw) : []);

    arr.forEach(act => {
      if (!act) return;
      const nombre = norm(
        (act.actividad || act.servicio || act.nombre || act.titulo || '').toString()
      );
      if (!nombre) return;

      const prev = idx.get(nombre);
      // si aparece varias veces la misma actividad, nos quedamos con la fecha más temprana
      if (!prev || fechaISO < prev){
        idx.set(nombre, fechaISO);
      }
    });
  });

  return idx;
}

/**
 * Enriquecer abonos con fechaActividadISO = fecha del itinerario
 * según el nombre de la actividad/concepto.
 */
function enrichAbonosWithItinerario(grupo, abonos){
  if (!abonos || !abonos.length) return [];

  const idx  = buildItinerarioIndex(grupo);
  const keys = [...idx.keys()];

  const pickFecha = (nombreNorm) => {
    if (!nombreNorm) return null;
    if (idx.has(nombreNorm)) return idx.get(nombreNorm);

    // fallback: match parcial
    const hit = keys.find(k => k.includes(nombreNorm) || nombreNorm.includes(k));
    return hit ? idx.get(hit) : null;
  };

  const out = abonos.map(a => {
    const nombreNorm = norm(
      (a.actividad || a.concepto || a.asunto || '').toString()
    );
    const fechaActividadISO = pickFecha(nombreNorm);

    return {
      ...a,
      fechaActividadISO   // puede ser null si no se encuentra
    };
  });

  return out;
}

// ──────────────────────────────────────────────────────────────
// COORDINADOR(A): buscar datos en colección "coordinadores"
// ──────────────────────────────────────────────────────────────
function slugCoordinadorName(name){
  return norm(name || '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchCoordinadorPrincipal(grupo){
  try{
    const nombres = [];

    if (Array.isArray(grupo.coordinadores) && grupo.coordinadores.length){
      grupo.coordinadores.forEach(n => {
        if (n) nombres.push(String(n));
      });
    }
    if (grupo.coordinador){
      nombres.push(String(grupo.coordinador));
    }

    if (!nombres.length) return null;

    const baseName = nombres[0];
    const slug = slugCoordinadorName(baseName);

    // 1) Intento directo por ID (ej: "aldo-hip")
    try{
      const docRef = doc(db, 'coordinadores', slug);
      const d = await getDoc(docRef);
      if (d.exists()){
        return { id: d.id, ...d.data() };
      }
    }catch(e){ /* noop */ }

    // 2) Fallback: recorrer colección y emparejar por nombre normalizado
    const snap = await getDocs(collection(db, 'coordinadores'));
    const targetNorm = norm(baseName);
    let best = null;

    snap.forEach(dd => {
      const x = dd.data() || {};
      const n = norm(x.nombre || dd.id || '');
      if (!n) return;

      if (n === targetNorm){
        best = { id: dd.id, ...x };
      } else if (!best && (n.includes(targetNorm) || targetNorm.includes(n))){
        best = { id: dd.id, ...x };
      }
    });

    return best;
  }catch(e){
    console.error('Error buscando coordinador principal', e);
    return null;
  }
}

async function collectVoucherActivities(grupo){
  const it = grupo && grupo.itinerario;
  const fisicos = [];
  const tickets = [];

  if (!it || typeof it !== 'object') return { fisicos, tickets };

  // índice de fechas por actividad (primer día donde aparece en el itinerario)
  const itIndex = buildItinerarioIndex(grupo);

  // Puede devolver 1 o varios destinos base:
  //   ["SUR DE CHILE","BARILOCHE"], ["BRASIL"], etc.
  const destinoKeys = getDestinoServiciosKeys(grupo);

  // Índices combinados de todos esos destinos
  const serviciosByNombre   = new Map();
  const proveedoresByNombre = new Map();

  for (const key of destinoKeys){
    if (!key) continue;

    const {
      serviciosByNombre: servIdx,
      proveedoresByNombre: provIdx
    } = await ensureServiciosIndex(key);

    // Unimos índices sin sobrescribir si ya existe la clave
    for (const [slug, doc] of servIdx){
      if (!serviciosByNombre.has(slug)) serviciosByNombre.set(slug, doc);
    }
    if (provIdx){
      for (const [slug, doc] of provIdx){
        if (!proveedoresByNombre.has(slug)) proveedoresByNombre.set(slug, doc);
      }
    }
  }

  const pushUnique = (arr, item) => {
    const key = item.key;
    if (!arr.some(x => x.key === key)) arr.push(item);
  };

  Object.values(it).forEach(raw => {
    const arr = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' ? Object.values(raw) : []);

    arr.forEach(act => {
      if (!act) return;

      const nombre = (act.actividad || act.servicio || act.nombre || '').toString().trim();
      if (!nombre) return;

      const slugNombre = norm(nombre);
      const servDoc = serviciosByNombre.get(slugNombre);
      if (!servDoc) return;

      const voucherVal = String(servDoc.voucher || '').toUpperCase();

      // SOLO FÍSICO / TICKET; "NO APLICA" queda fuera
      const isFisico = voucherVal.includes('FISICO') || voucherVal.includes('FÍSICO');
      const isTicket = voucherVal.includes('TICKET');

      if (!isFisico && !isTicket) return;

      // Buscar proveedor para contacto / teléfono
      const provName = (servDoc.proveedor || '').toString();
      const provSlug = norm(provName);
      const provDoc = provSlug ? proveedoresByNombre.get(provSlug) : null;

      const contacto = (provDoc?.contacto || provDoc?.contactoNombre || '').toString().trim();
      const telefono = (provDoc?.telefono || provDoc?.fono || provDoc?.celular || '').toString().trim();

      // Fecha en el itinerario (si existe) según nombre normalizado
      const fechaActividadISO = itIndex.get(slugNombre) || null;

      const item = {
        key: slugNombre,
        nombre,
        proveedor: provName,
        contacto,
        telefono,
        fechaActividadISO
      };

      if (isFisico) pushUnique(fisicos, item);
      if (isTicket) pushUnique(tickets, item);
    });
  });

  // Ordenar por fecha de actividad (las sin fecha al final, luego por nombre)
  const sortByFecha = (a, b) => {
    const fa = a.fechaActividadISO || '';
    const fb = b.fechaActividadISO || '';
    if (fa && fb) return fa.localeCompare(fb);
    if (fa && !fb) return -1;
    if (!fa && fb) return 1;
    return a.nombre.localeCompare(b.nombre, 'es');
  };

  fisicos.sort(sortByFecha);
  tickets.sort(sortByFecha);

  return { fisicos, tickets };
}

// ──────────────────────────────────────────────────────────────
// FINANZAS: construir documento "ESTADO DE CUENTAS DEL VIAJE"
// ──────────────────────────────────────────────────────────────
function buildFinanzasDoc(grupo, abonos, coord, vouchersData){
  const alias   = grupo.aliasGrupo || grupo.nombreGrupo || grupo.numeroNegocio || '';
  const colegio = grupo.colegio || grupo.cliente || '';
  const curso   = grupo.curso || grupo.subgrupo || grupo.nombreGrupo || '';
  const destino = grupo.destino || '';
  const programa= grupo.programa || '';
  const ano     = grupo.anoViaje || '';

  const lineaPrincipal = [colegio, curso, destino].filter(Boolean).join(' · ');

  // ── RANGO DE VIAJE + DECORADO DE ABONOS (fechas y "IMPREVISTOS")
  const { inicio: inicioViajeISO, fin: finViajeISO } = computeRangoViaje(grupo, abonos || []);

  const abonosDecorados = (abonos || []).map(a => {
    const baseText = (a.actividad || a.concepto || a.asunto || '').toString();
    const isImprevistos = norm(baseText).includes('imprevisto');

    // fecha base para ordenar y mostrar:
    // 1) fechaActividadISO (itinerario)
    // 2) inicio del viaje
    // 3) fecha del abono
    let fechaBaseISO = a.fechaActividadISO || '';
    if (!fechaBaseISO && inicioViajeISO) fechaBaseISO = inicioViajeISO;
    if (!fechaBaseISO) fechaBaseISO = a.fechaISO || '';

    return {
      ...a,
      isImprevistos,
      fechaBaseISO
    };
  });

  // Orden final: por fecha, dejando IMPREVISTOS al final
  abonosDecorados.sort((a,b) => {
    if (a.isImprevistos && !b.isImprevistos) return 1;
    if (!a.isImprevistos && b.isImprevistos) return -1;
    const fa = a.fechaBaseISO || '';
    const fb = b.fechaBaseISO || '';
    return fa.localeCompare(fb);
  });

  // ── MONEDAS PRESENTES → una columna por moneda que tenga algún valor
  const monedas = (() => {
    const found = new Set();
    (abonosDecorados || []).forEach(a => {
      if (a && a.montoNum != null){
        const m = (a.moneda || 'CLP').toString().trim() || 'CLP';
        if (m) found.add(m);
      }
    });
    const pref = ['CLP','BRL','USD','EUR','ARS'];
    const out = [];
    pref.forEach(m => { if (found.has(m)) { out.push(m); found.delete(m); }});
    return out.concat([...found].sort());
  })();

  const headerMonedas = monedas.map(m => `<th>${m}</th>`).join('');
  const colCount = 4 + monedas.length + 1; // N°, Fecha, Concepto, Medio, [monedas...], Comentario

  const rowsHtml = (abonosDecorados && abonosDecorados.length)
    ? abonosDecorados.map((a,idx)=>{
        let fechaTxt = '—';
        if (a.isImprevistos && inicioViajeISO && finViajeISO){
          // "1 DIC al 7 DIC"
          fechaTxt = formatRangeDayMonth(inicioViajeISO, finViajeISO);
        } else if (a.fechaBaseISO){
          // "13 DIC"
          fechaTxt = formatShortDayMonth(a.fechaBaseISO);
        }

        const celdasMon = monedas.map(m => {
          const show = (a.montoNum != null && (a.moneda || 'CLP') === m);
          const valor = show ? formatMoney(a.montoNum, m) : '';
          return `<td class="nowrap">${valor}</td>`;
        }).join('');

        return `
          <tr>
            <td class="nowrap">${idx+1}</td>
            <td class="nowrap">${fechaTxt}</td>
            <td>${safe(a.asunto)}</td>
            <td class="nowrap">${safe(a.medio)}</td>
            ${celdasMon}
            <td>${safe(a.comentarios)}</td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="${colCount}" class="no-rows">No hay abonos registrados para este grupo.</td></tr>`;

  const totalesPorMoneda = new Map();
  (abonosDecorados || []).forEach(a => {
    if (a.montoNum != null) {
      const key = a.moneda || 'CLP';
      totalesPorMoneda.set(key, (totalesPorMoneda.get(key) || 0) + Number(a.montoNum));
    }
  });

  let tfootHtml = '';
  if (totalesPorMoneda.size && monedas.length){
    const celdasTotales = monedas.map(m => {
      const val = totalesPorMoneda.get(m);
      return `<td class="finanzas-total-value">${val != null ? formatMoney(val, m) : ''}</td>`;
    }).join('');
    tfootHtml = `
      <tfoot>
        <tr>
          <td colspan="4" class="finanzas-total-label">TOTAL</td>
          ${celdasTotales}
          <td></td>
        </tr>
      </tfoot>`;
  }

  // ── Bloque con datos del coordinador(a)
  const coordBlock = (() => {
    if (!coord) return '';
    const nombreCoord = (coord.nombre || coord.nombreCompleto || '').toString().trim();
    const rutCoord    = (coord.rut || coord.RUT || '').toString().trim();
    const telCoord    = (coord.telefono || coord.fono || coord.celular || '').toString().trim();
    const correoCoord = (coord.correo || '').toString().trim();

    if (!nombreCoord && !rutCoord && !telCoord && !correoCoord) return '';

    return `
      <div class="sec finanzas-coord">
        <div class="sec-title">COORDINADOR(A) A CARGO</div>
        <div class="note">
          ${nombreCoord ? `<div><strong>Nombre:</strong> ${nombreCoord.toUpperCase()}</div>` : ''}
          ${telCoord ? `<div><strong>Teléfono:</strong> ${telCoord}</div>` : ''}
          ${correoCoord ? `<div><strong>Correo:</strong> ${correoCoord}</div>` : ''}
        </div>
      </div>
    `;
  })();

  // ── Listados de vouchers (físicos y tipo ticket) basados en el itinerario del grupo
  const { fisicos = [], tickets = [] } = vouchersData || {};

  const vouchersFisicosHtml = `
    <div class="sec vouchers-section">
     <div class="sec-title">II. ACTIVIDADES CON VOUCHERS</div>
      ${
        fisicos.length
          ? `<ul class="itinerario">
              ${fisicos.map(v => `
                <li class="it-day">
                  <div>
                    <strong>
                      ${v.fechaActividadISO ? `${formatShortDayMonth(v.fechaActividadISO)}: ` : ''}
                      ${v.nombre}
                    </strong>
                  </div>
                  ${v.contacto ? `<div>Contacto: ${v.contacto}</div>` : ''}
                  ${v.telefono ? `<div>Teléfono: ${v.telefono}</div>` : ''}
                </li>
              `).join('')}
            </ul>`
          : `<div class="note">— Sin actividades con voucher registradas —</div>`
      }
    </div>
  `;

  const totalEst = Number(grupo.estudiantes || grupo.cantidadEstudiantes || 0) || 0;
  const totalAd  = Number(grupo.adultos || grupo.cantidadAdultos || 0) || 0;

  const vouchersTicketsHtml = `
    <div class="sec vouchers-section">
     <div class="sec-title">III. ACTIVIDADES CON TICKETS</div>
      ${
        tickets.length
          ? `<ul class="itinerario">
              ${tickets.map(v => `
                <li class="it-day">
                  <div>
                    <strong>
                      ${v.fechaActividadISO ? `${formatShortDayMonth(v.fechaActividadISO)}: ` : ''}
                      ${v.nombre}
                    </strong>
                  </div>
                  <div>${totalEst} tickets estudiantes, ${totalAd} tickets adultos, 1 ticket coordinador(a)</div>
                </li>
              `).join('')}
            </ul>`
          : `<div class="note">— Sin actividades con ticket registradas —</div>`
      }
    </div>
  `;

  const vouchersSectionHtml = vouchersFisicosHtml + vouchersTicketsHtml;


  return `
    <div class="print-doc finanzas-doc">
      <div class="finanzas-header">
        <div class="finanzas-title-block">
          <div class="finanzas-title">RESUMEN OPERATIVO</div>
          <div class="finanzas-subtitle">${safe(lineaPrincipal, '')}</div>
          <div class="finanzas-meta">
            ${programa ? `<span>PROGRAMA: ${programa}</span>` : ''}
            ${grupo.fechaInicio ? `<span>INICIO: ${grupo.fechaInicio}</span>` : ''}
            ${grupo.fechaFin ? `<span>FIN: ${grupo.fechaFin}</span>` : ''}
            ${ano ? `<span>AÑO VIAJE: ${ano}</span>` : ''}
          </div>
          <div class="finanzas-meta">
            <span>CANTIDAD DE PASAJEROS:</span>
            ${grupo ? `<span>ESTUDIANTES: ${grupo.estudiantes}</span>` : ''}
            ${grupo ? `<span>ADULTOS: ${grupo.adultos}</span>` : ''}
            ${grupo ? `<span>TOTAL: ${grupo.cantidadGrupo}</span>` : ''}
          </div>
        </div>
        <div class="finanzas-logo">
          <img src="Logo Raitrai.png" alt="Turismo RaiTrai">
        </div>
      </div>

      ${coordBlock}

      <div class="sec finanzas-abonos">
        <div class="sec-title">I. ABONOS ENTREGADOS AL COORDINADOR(A)</div>
        <table class="finanzas-table">
          <thead>
            <tr>
              <th>N°</th>
              <th>Fecha</th>
              <th>Actividad / Concepto</th>
              <th>Medio de pago</th>
              
              ${headerMonedas}
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
          ${tfootHtml}
        </table>
      </div>


      ${vouchersSectionHtml}

      <div class="finanzas-footnote">
       &nbsp;
       &nbsp;
       &nbsp; 
       &nbsp;
        Declaro haber recibido a conformidad los abonos indicados, los vouchers y los tickets señalados en este documento.
      </div>
      &nbsp;
      &nbsp;
      <div class="finanzas-footnote">
        NOMBRE COORDINADOR(A): ___________________________________________________________________________________________
      </div>
      &nbsp;
      &nbsp;
      <div class="finanzas-footnote">
        FECHA: __________________________________________
      </div>
      &nbsp;
      &nbsp;
      &nbsp;
      &nbsp;
      <div class="finanzas-footnote">
        FIRMA: __________________________________________
      </div>
    </div>
  `;
}

function buildVouchersDoc(grupo, vouchersData){
  const alias   = grupo.aliasGrupo || grupo.nombreGrupo || grupo.numeroNegocio || '';
  const colegio = grupo.colegio || grupo.cliente || '';
  const curso   = grupo.curso || grupo.subgrupo || '';
  const destino = grupo.destino || '';
  const programa= grupo.programa || '';
  const ano     = grupo.anoViaje || '';

  const lineaPrincipal = [colegio, curso, destino].filter(Boolean).join(' · ');

  const aliasLabel = (() => {
    const num = grupo.numeroNegocio || '';
    const al  = grupo.aliasGrupo || grupo.nombreGrupo || '';
    if (num && al) return `(${num}) ${al}`;
    return num || al || '';
  })();

  const totalEst = Number(grupo.estudiantes || grupo.cantidadEstudiantes || 0) || 0;
  const totalAd  = Number(grupo.adultos || grupo.cantidadAdultos || 0) || 0;
  const totalGrupo = (() => {
    const base =
      Number(grupo.cantidadGrupo || grupo.cantidadgrupo || grupo.pax || 0) ||
      (totalEst + totalAd);
    return base || '';
  })();

  const { fisicos = [] } = vouchersData || {};

  if (!fisicos.length){
    return `
      <div class="print-doc vouchers-doc">
        <div class="vouchers-header">
        </div>
        <div class="note">No hay actividades con voucher físico registradas para este grupo.</div>
      </div>
    `;
  }

  const cardsHtml = fisicos.map(v => {
    const fechaTxt = v.fechaActividadISO ? formatShortDate(v.fechaActividadISO) : '—';
    const proveedor = v.proveedor || '';

    return `
      <div class="voucher-card">
        <div class="voucher-header">
          <div>
            <div class="voucher-title">VOUCHER DE SERVICIO</div>
            <div class="voucher-subtitle">TURISMO RAITRAI</div>
            ${aliasLabel ? `<div class="voucher-group"><span class="lbl">Grupo:</span> ${aliasLabel}</div>` : ''}
            <div class="voucher-meta">
              ${colegio ? `<span>${colegio}</span>` : ''}
              ${curso ? `<span>${curso}</span>` : ''}
              ${destino ? `<span>${destino}</span>` : ''}
            </div>
          </div>
          <div class="voucher-logo">
            <img src="Logo Raitrai.png" alt="Turismo RaiTrai">
          </div>
        </div>

        <div class="voucher-body">
          <div class="voucher-row">
            <span class="lbl">Proveedor:</span> ${proveedor || '____________________________'}
          </div>
          <div class="voucher-row">
            <span class="lbl">Servicio:</span> ${v.nombre}
          </div>
          <div class="voucher-row">
            <span class="lbl">Fecha de uso:</span> ${fechaTxt}
          </div>
          <div class="voucher-row">
            <span class="lbl">Pax planificados:</span>
            ${
              totalGrupo
                ? `${totalGrupo} pax${
                    (totalEst || totalAd)
                      ? ` (Estudiantes: ${totalEst || 0} · Adultos: ${totalAd || 0})`
                      : ''
                  }`
                : '________________'
            }
          </div>

          <div class="voucher-row">
            <span class="lbl">Asistencia real:</span>
          </div>
          <div class="voucher-asistencia-box">
            <div class="voucher-asistencia-inner">
              <span>Estudiantes: __________</span>
              <span>Adultos: __________</span>
              <span>Total: __________</span>
            </div>
          </div>

          <div class="voucher-row">
            <span class="lbl">Observaciones:</span>
          </div>
          <div class="voucher-observaciones-box"></div>
        </div>

        <div class="voucher-footer">
          <div class="voucher-firma">
            <div class="voucher-firma-label">Firma PROVEEDOR (firma o timbre):</div>
            <div class="voucher-firma-line"></div>
          </div>
          <div class="voucher-firma">
            <div class="voucher-firma-label">Firma COORDINADOR(A):</div>
            <div class="voucher-firma-line"></div>
          </div>
          <div class="voucher-firma">
            <div class="voucher-firma-label">Timbre Rai Trai:</div>
            <div class="voucher-firma-line"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="print-doc vouchers-doc">
      <div class="vouchers-header">
        <div class="vouchers-title">VOUCHERS DE SERVICIO</div>
        <div class="vouchers-subtitle">${safe(lineaPrincipal, '')}</div>
        <div class="vouchers-meta">
          ${aliasLabel ? `<span>Grupo: ${aliasLabel}</span>` : ''}
          ${ano ? `<span>Año viaje: ${ano}</span>` : ''}
          ${programa ? `<span>Programa: ${programa}</span>` : ''}
        </div>
      </div>
      <div class="voucher-grid">
        ${cardsHtml}
      </div>
    </div>
  `;
}


/* ──────────────────────────────────────────────────────────────────────
   Carga de opciones (Año, Destino, Programa, Hotel)
────────────────────────────────────────────────────────────────────── */
async function fetchDistinctOptions(){
  const anos = new Set();
  const destinos = new Set();
  const programas = new Set();

  // Traemos una muestra amplia de grupos (ajusta si lo necesitas)
  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d=>{
    const g = d.data() || {};
    if (g.anoViaje) anos.add(String(g.anoViaje));
    if (g.destino) destinos.add(String(g.destino));
    if (g.programa) programas.add(String(g.programa));
  });

  // Hoteles
  const hoteles = [];
  const hsnap = await getDocs(collection(db,'hoteles'));
  hsnap.forEach(d=>{
    const h = d.data() || {};
    hoteles.push({ id:d.id, nombre: h.nombre || d.id });
  });

  return {
    anos: [...anos].sort(),
    destinos: [...destinos].sort((a,b)=>a.localeCompare(b,'es')),
    programas: [...programas].sort((a,b)=>a.localeCompare(b,'es')),
    hoteles
  };
}
function fillSelect(sel, values, placeholder='(Todos)'){
  sel.innerHTML = '';
  const opt0=document.createElement('option');
  opt0.value = ''; opt0.textContent = placeholder;
  sel.appendChild(opt0);
  values.forEach(v=>{
    const o=document.createElement('option');
    o.value=v.value ?? v.id ?? v;
    o.textContent=v.label ?? v.nombre ?? v;
    sel.appendChild(o);
  });
}

/* ──────────────────────────────────────────────────────────────────────
   Búsqueda y filtrado
────────────────────────────────────────────────────────────────────── */
async function buscar(){
  const nombre = norm(document.getElementById('fNombre').value);
  const codigo = norm(document.getElementById('fCodigo').value);
  const coord  = norm(document.getElementById('fCoordinador').value);
  const ano    = document.getElementById('fAno').value;
  const destino= document.getElementById('fDestino').value;
  const programa = document.getElementById('fPrograma').value;
  const hotelId = document.getElementById('fHotel').value;
  const inicioDia = document.getElementById('fInicioDia').value; // yyyy-mm-dd

  // 1) Prefiltro por grupos (aplico where donde es seguro)
  // Para simplificar, traemos todos y filtramos cliente por ahora.
  const snap = await getDocs(collection(db,'grupos'));
  const candidatos = [];
  snap.forEach(d=>{
    const g = { id:d.id, ...d.data() };
    if (ano && String(g.anoViaje||'') !== String(ano)) return;
    if (destino && String(g.destino||'') !== String(destino)) return;
    if (programa && String(g.programa||'') !== String(programa)) return;

    const N = `${g.nombreGrupo||''} ${g.aliasGrupo||''}`.trim();
    if (nombre && !norm(N).includes(nombre)) return;

    const C = `${g.numeroNegocio||''}`;
    if (codigo && !norm(C).includes(codigo)) return;

    const COORDS = Array.isArray(g.coordinadores) ? g.coordinadores.join(' ') : (g.coordinador||'');
    if (coord && !norm(COORDS).includes(coord)) return;

    candidatos.push(g);
  });

  // 2) Para cada candidato: cargar vuelos (para obtener primer vuelo de ida) y (si es necesario) hoteles para filtrar por hotel
  const rows = [];
  for (const g of candidatos){
    const vuelosDocs = await loadVuelosInfo(g);
    const vuelosNorm = vuelosDocs.map(normalizeVuelo);
    const inicioISO  = computeInicioSoloPrimerVueloIda(vuelosNorm); // ← SOLO primer vuelo de ida

    if (inicioDia) {
      if (!inicioISO) continue;               // sin vuelos de ida → no entra
      if (inicioISO !== inicioDia) continue;  // no coincide el día
    }

    // Filtro por hotel (si se pide)
    if (hotelId) {
      const asigs = await loadHotelesInfo(g);
      const hit = (asigs||[]).some(a => String(a.hotel?.id||'') === hotelId);
      if (!hit) continue;
    }

    rows.push({
      g,
      inicioISO
    });
  }

  renderTabla(rows);
}

/* ──────────────────────────────────────────────────────────────────────
   Render tabla
────────────────────────────────────────────────────────────────────── */
function renderTabla(rows){
  const tb = document.getElementById('tbody');
  const chkAll = document.getElementById('chkAll');
  tb.innerHTML = '';
  chkAll.checked = false;

  rows.sort((a,b)=>{
    const A=a.inicioISO||'', B=b.inicioISO||'';
    if (A!==B) return A.localeCompare(B);
    const an = norm(a.g.aliasGrupo||a.g.nombreGrupo||'');
    const bn = norm(b.g.aliasGrupo||b.g.nombreGrupo||'');
    return an.localeCompare(bn);
  });

  for (const { g, inicioISO } of rows){
    const tr=document.createElement('tr');
    tr.dataset.id = g.id;

    const alias = g.aliasGrupo || g.nombreGrupo || g.numeroNegocio || '—';
    const grupo = `${g.colegio||g.cliente||''} ${g.curso||g.subgrupo||g.nombreGrupo||''}`.trim();
    const inicioTxt = inicioISO ? formatShortDate(inicioISO) : '—';

    tr.innerHTML = `
      <td><input type="checkbox" class="rowchk"/></td>
      <td>${alias}</td>
      <td>${grupo || '—'}</td>
      <td>${g.numeroNegocio ?? '—'}</td>
      <td>${g.destino ?? '—'}</td>
      <td>${g.programa ?? '—'}</td>
      <td><span class="badge">${inicioTxt}</span></td>
      <td class="acciones">
        <div class="acciones-wrap">
          <button class="btn-add btn-one">C</button>
          <button class="btn-add btn-finanzas">R</button>
          <button class="btn-add btn-vouchers">V</button>
        </div>
      </td>

    `;

    tb.appendChild(tr);
  }

  document.getElementById('countHint').textContent = `${rows.length} grupo(s) encontrados.`;
  tb.querySelectorAll('.btn-one').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const tr = ev.currentTarget.closest('tr');
      const id = tr?.dataset?.id;
      if (!id) return;
      await descargarUno(id);
    });
  });

  tb.querySelectorAll('.btn-finanzas').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const tr = ev.currentTarget.closest('tr');
      const id = tr?.dataset?.id;
      if (!id) return;
      await descargarFinanzas(id);
    });
  });

  tb.querySelectorAll('.btn-vouchers').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const tr = ev.currentTarget.closest('tr');
      const id = tr?.dataset?.id;
      if (!id) return;
      await descargarVouchers(id);
    });
  });

  document.getElementById('chkAll').onchange = (ev)=>{
    tb.querySelectorAll('.rowchk').forEach(c=> c.checked = ev.currentTarget.checked);
  };
}

// ──────────────────────────────────────────────────────────────
// FINANZAS: imprimir "ESTADO DE CUENTAS DEL VIAJE"
// ──────────────────────────────────────────────────────────────
async function descargarFinanzas(grupoId){
  // 1) Traer datos del grupo
  const d = await getDoc(doc(db,'grupos', grupoId));
  if (!d.exists()) return;
  const g = { id:d.id, ...d.data() };

  // 2) Traer abonos "crudos"
  const abonosRaw = await fetchFinanzasAbonos(grupoId);

  // 3) Enriquecer con FECHA DE ACTIVIDAD desde el itinerario del grupo
  const abonos = enrichAbonosWithItinerario(g, abonosRaw);

  // 4) Buscar datos del coordinador(a) principal en colección "coordinadores"
  const coordData = await fetchCoordinadorPrincipal(g);

  // 5) Armar listas de vouchers (físicos y ticket) cruzando con Servicios/Proveedores
  const vouchersData = await collectVoucherActivities(g);

  // 6) Construir el HTML y mandar a imprimir
  const html = buildFinanzasDoc(g, abonos, coordData, vouchersData);
  imprimirHtml(html);
}

// ──────────────────────────────────────────────────────────────
// VOUCHERS FÍSICOS: imprimir hoja con vouchers del grupo
// ──────────────────────────────────────────────────────────────
async function descargarVouchers(grupoId){
  // 1) Traer datos del grupo
  const d = await getDoc(doc(db,'grupos', grupoId));
  if (!d.exists()) return;
  const g = { id:d.id, ...d.data() };

  // 2) Armar listas de vouchers (físicos y ticket) cruzando con Servicios/Proveedores
  const vouchersData = await collectVoucherActivities(g);

  // 3) Construir HTML de vouchers físicos y mandar a imprimir
  const html = buildVouchersDoc(g, vouchersData);
  imprimirHtml(html);
}

/* ──────────────────────────────────────────────────────────────────────
   Exportación / IMPRESIÓN de CONFIRMACIÓN (uno)
────────────────────────────────────────────────────────────────────── */
async function descargarUno(grupoId){
  const html = await buildConfirmacionHTML(grupoId);
  if (!html) return;
  imprimirHtml(html);
}

async function descargarSeleccionados(){
  const tb = document.getElementById('tbody');
  const ids = [...tb.querySelectorAll('tr')].filter(tr=> tr.querySelector('.rowchk')?.checked).map(tr=> tr.dataset.id);
  await descargarLote(ids);
}

async function descargarTodos(){
  const tb = document.getElementById('tbody');
  const ids = [...tb.querySelectorAll('tr')].map(tr=> tr.dataset.id);
  await descargarLote(ids);
}

async function descargarLote(ids){
  if (!ids.length) return;
  const prog = document.getElementById('progressTxt');
  let ok = 0, fail = 0;
  const partes = [];

  for (let i = 0; i < ids.length; i++){
    prog.textContent = `Preparando ${i+1}/${ids.length}…`;
    try{
      const html = await buildConfirmacionHTML(ids[i]);
      if (html){
        partes.push(html);   // cada html trae su <div class="print-doc">
        ok++;
      }else{
        fail++;
      }
    }catch(e){
      console.error('Error generando confirmación', ids[i], e);
      fail++;
    }
  }

  prog.textContent = `Listo: ${ok} ok${fail?`, ${fail} con error`:''}.`;
  setTimeout(()=> prog.textContent = '', 4000);

  if (!partes.length) return;

  // Un solo documento con varias páginas .print-doc
  const htmlLote = partes.join('');
  imprimirHtml(htmlLote);
}


async function pdfDesdeMiViaje(grupoId, filename){
  const SAFE_PX = Math.round(190 * 96 / 25.4); // zona segura
  await ensureHtml2Pdf();

  // 1) Cargar MiViaje en iframe oculto
  const iframe = document.createElement('iframe');
  // fuera de pantalla + opaco (no visibility:hidden para que renderice)
  iframe.style.cssText = 'position:absolute;left:-10000px;top:0;width:210mm;height:297mm;opacity:0;pointer-events:none;border:0;z-index:-1;';
  iframe.src = `./miviaje.html?id=${encodeURIComponent(grupoId)}&embed=1`;
  document.body.appendChild(iframe);
  await new Promise(res => { iframe.onload = res; });

  const idoc = iframe.contentDocument || iframe.contentWindow?.document;

  // 2) Esperar a que #print-block exista y sea RENDERIZABLE (con tamaño > 0)
  const okPB = await waitFor(() => {
    const el = idoc?.querySelector('#print-block');
    return el && el.offsetWidth > 0 && el.offsetHeight > 0;
  }, 8000, 100);
  
  const printBlock = idoc?.querySelector('#print-block');
  if (!okPB || !printBlock){
    iframe.remove();
    throw new Error('No se encontró #print-block visible en MiViaje.');
  }


  // 3) Inyecta FIX: elimina zoom/transform y fuerza A4 + saltos de página
  const fix = idoc.createElement('style');
  fix.id = 'miViajePdfFix';
  fix.textContent = `
    #print-block {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      transform: none !important;
      -webkit-transform: none !important;
      zoom: 1 !important;
      width: 190mm !important;             /* zona segura */
      margin: 0 auto !important;
      background: #ffffff !important;
    }
    #print-block .print-doc{
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      transform: none !important;
      -webkit-transform: none !important;
      zoom: 1 !important;
      width: 190mm !important;             /* zona segura */
      min-height: 270mm !important;
      margin: 0 auto !important;
      background: #ffffff !important;
      page-break-after: always !important;
      break-inside: avoid !important;
    }
    #print-block .print-doc:last-child{
      page-break-after: auto !important;
    }
  `;


  idoc.head.appendChild(fix);

  // 4) Ajuste directo en runtime por si quedan estilos inline que oculten
  printBlock.style.display = 'block';
  printBlock.style.visibility = 'visible';
  printBlock.style.opacity = '1';
  printBlock.style.width = '210mm';
  [...printBlock.querySelectorAll('.print-doc')].forEach(p=>{
    p.style.display = 'block';
    p.style.visibility = 'visible';
    p.style.opacity = '1';
    p.style.width = '190mm';
    p.style.minHeight = '270mm';
    p.style.background = '#ffffff';
    p.style.transform = 'none';
  });


  try { if (idoc.fonts && idoc.fonts.ready) await idoc.fonts.ready; } catch {}
  await new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)));

  // 5) Ancho real de captura (evita escalado que “encoge” dos páginas en una)
  const capW = Math.max(
    SAFE_PX,
    printBlock.scrollWidth,
    Math.ceil(printBlock.getBoundingClientRect().width)
  );

  // 6) Exportar tal cual (sin clonar), respetando los page-break CSS
  await html2pdf().set({
    margin: 0,
    filename,
    pagebreak: { mode: ['css', 'legacy'] },
    image: { type: 'jpeg', quality: 0.96 },
    html2canvas: {
      scale: 2,
      windowWidth: capW,
      width: capW,
      scrollX: 0,
      scrollY: 0,
      backgroundColor: '#ffffff',
      useCORS: true,
      allowTaint: true
    },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(printBlock).save();

  // 7) Limpieza
  iframe.remove();
}


/* ====== NUEVO: usa MiViaje si está ok; si falla, usa el HTML local ====== */
async function exportarPDFconFallback({ grupoId, node, filename }){
  try{
    await pdfDesdeMiViaje(grupoId, filename);
  }catch(e){
    console.warn('MiViaje no entregó #print-block, uso fallback local:', e);
    await ensureHtml2Pdf();

    // Calcular ancho de captura: mantener A4 real o el scrollWidth
    const SAFE_PX = Math.round(190 * 96 / 25.4);
    const capW  = Math.max(SAFE_PX, node.scrollWidth, Math.ceil(node.getBoundingClientRect().width));
    
    // Exportación directa del nodo local (el que construiste con buildPrintDoc)
    await html2pdf().set({
      margin: 0,
      filename,
      pagebreak: { mode: ['css', 'legacy'] },
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: {
        scale: 2,
        windowWidth: capW,
        width: capW,
        scrollX: 0,
        scrollY: 0,
        backgroundColor: '#ffffff',
        useCORS: true,
        allowTaint: true
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).from(node).save();
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Boot
────────────────────────────────────────────────────────────────────── */
async function init(){
  // Filtros
  const { anos, destinos, programas, hoteles } = await fetchDistinctOptions();

  // Año (default: actual)
  const selAno = document.getElementById('fAno');
  const currentYear = new Date(
    new Date().toLocaleString('en-US', { timeZone: TZ })
  ).getFullYear();
  fillSelect(selAno, anos.map(a=>({value:a,label:a})), '(Todos)');
  if (anos.includes(String(currentYear))) selAno.value = String(currentYear);

  fillSelect(document.getElementById('fDestino'), destinos.map(v=>({value:v,label:v})));
  fillSelect(document.getElementById('fPrograma'), programas.map(v=>({value:v,label:v})));
  fillSelect(document.getElementById('fHotel'), hoteles.map(h=>({value:h.id,label:h.nombre})));

  // Eventos
  document.getElementById('btnBuscar').addEventListener('click', buscar);
  document.getElementById('btnLimpiar').addEventListener('click', ()=>{
    document.getElementById('filtros').reset();
    selAno.value = String(currentYear);
    document.getElementById('tbody').innerHTML='';
    document.getElementById('countHint').textContent='—';
  });

  document.getElementById('btnDescSel').addEventListener('click', descargarSeleccionados);
  document.getElementById('btnDescAll').addEventListener('click', descargarTodos);
}

init().catch(e=>{

  
  console.error('Init error', e);
  document.getElementById('countHint').textContent='Error inicializando la página.';
});
