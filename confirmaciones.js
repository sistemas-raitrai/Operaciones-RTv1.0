// confirmaciones.js
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
function formatDMYDownload(date=new Date()){
  const dt = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const yyyy = dt.getFullYear();
  return `${dd}${mm}${yyyy}`;
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
  vuelosByGroup: new Map()
};

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
  @page { size: A4 portrait; margin: 0; }
  .print-doc{ page-break-after: always; }
  .print-doc:last-child{ page-break-after: auto; }

  .print-doc{
    background:#ffffff !important;
    color:#111 !important;
    width:208mm !important;           /* zona segura para evitar cortes */
    min-height:297mm;
    box-sizing:border-box;
    padding:12mm 12mm 14mm 14mm;      /* márgenes internos un poco mayores */
    margin:0 auto !important;
    font:11pt/1.28 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  }
  /* Evitar que textos/URLs largos rompan el ancho y se “salgan” */
  .hotel-right, .hotel-right a, .flight-legs, .itinerario{
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  
  .doc-title{ font-weight:800; font-size:17pt; line-height:1.12; margin:0 0 5mm 0; text-align:center; }
  .sec{ margin:0 0 4.5mm 0; break-inside:avoid; page-break-inside:avoid; }
  .sec-title{ font-weight:700; font-size:11pt; margin:0 0 2mm 0; }
  .note{ color:#374151; font-size:10pt; }
  .flight-block{ margin:0 0 4mm 0; }
  .flights-header{ font-weight:700; margin:0 0 1.6mm 0; }
  .flight-lines{ list-style:none; margin:0 0 2mm 0; padding:0; }
  .flight-lines li{ margin:.6mm 0; line-height:1.22; }
  .flight-lines .lbl{ font-weight:700; }
  .hoteles-list{ list-style:none; margin:.8mm 0 0 0; padding:0; }
  .hotel-item{ margin:.6mm 0 .8mm; }
  .hotel-grid{ display:grid; grid-template-columns:48mm 1fr; column-gap:5mm; }
  .hotel-right > div{ margin:.15mm 0; }
  .itinerario{ list-style:none; margin:0; padding:0; }
  .it-day{ margin:0 0 3mm 0; }
  .closing{ text-align:center; font-weight:800; margin-top:7mm; }

  /* ───── ESTADO DE CUENTAS DEL VIAJE (FINANZAS) ───── */

  .finanzas-doc{
    min-height: auto !important;   /* así no fuerza 297mm + padding → 2ª página en blanco */
  }
  
  .finanzas-doc .finanzas-header{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    margin-bottom:6mm;
  }
  .finanzas-title{
    font-size:16pt;
    font-weight:800;
    margin:0 0 2mm 0;
  }
  .finanzas-subtitle{
    font-size:11pt;
    font-weight:600;
    margin:0 0 1mm 0;
  }
  .finanzas-meta span{
    display:inline-block;
    font-size:9.5pt;
    margin-right:4mm;
  }
  .finanzas-logo img{
    max-height:18mm;
    width:auto;
  }
  .finanzas-table{
    width:100%;
    border-collapse:collapse;
    font-size:10pt;
    margin-top:2mm;
  }
  .finanzas-table th,
  .finanzas-table td{
    border:0.4pt solid #111;
    padding:2px 3px;
    vertical-align:top;
  }
  .finanzas-table th{
    text-align:left;
    background:#f3f4f6;
    font-weight:700;
  }
  .finanzas-table td:nth-child(1),
  .finanzas-table td:nth-child(2),
  .finanzas-table td:nth-child(5),
  .finanzas-table td:nth-child(6){
    white-space:nowrap;
  }
  .finanzas-table .no-rows{
    text-align:center;
    font-style:italic;
    color:#6b7280;
  }
  .finanzas-total-label{
    text-align:right;
    font-weight:700;
    padding-top:3px;
    border-top:0.6pt solid #111;
  }
  .finanzas-total-value{
    font-weight:700;
    padding-top:3px;
    border-top:0.6pt solid #111;
  }
  .finanzas-footnote{
    margin-top:6mm;
    font-size:9pt;
    color:#4b5563;
  }
  `;
  const s = document.createElement('style');
  s.id = 'pdf-styles';
  s.textContent = css;
  document.head.appendChild(s);
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
      let montoNum = null;
      ['monto','total','montoCLP','totalCLP'].some(k => {
        if (typeof x[k] === 'number' && isFinite(x[k])) {
          montoNum = x[k];
          return true;
        }
        return false;
      });
      out.push({
        id: d.id,
        fechaISO,
        asunto: (x.asunto || '').toString(),
        medio: (x.medio || '').toString(),
        moneda: (x.moneda || '').toString() || 'CLP',
        montoNum,
        comentarios: (x.comentarios || '').toString()
      });
    });
    out.sort((a,b)=> (a.fechaISO || '').localeCompare(b.fechaISO || ''));
  }catch(e){
    console.error('Error cargando finanzas_abonos para', grupoId, e);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// FINANZAS: construir documento "ESTADO DE CUENTAS DEL VIAJE"
// ──────────────────────────────────────────────────────────────
function buildFinanzasDoc(grupo, abonos){
  const alias   = grupo.aliasGrupo || grupo.nombreGrupo || grupo.numeroNegocio || '';
  const colegio = grupo.colegio || grupo.cliente || '';
  const curso   = grupo.curso || grupo.subgrupo || grupo.nombreGrupo || '';
  const destino = grupo.destino || '';
  const programa= grupo.programa || '';
  const ano     = grupo.anoViaje || '';

  const lineaPrincipal = [colegio, curso, destino].filter(Boolean).join(' · ');

  const rowsHtml = (abonos && abonos.length)
    ? abonos.map((a,idx)=>`
        <tr>
          <td>${idx+1}</td>
          <td>${a.fechaISO ? formatShortDate(a.fechaISO) : '—'}</td>
          <td>${safe(a.asunto)}</td>
          <td>${safe(a.medio)}</td>
          <td>${safe(a.moneda || 'CLP')}</td>
          <td>${a.montoNum != null ? formatMoney(a.montoNum, a.moneda || 'CLP') : ''}</td>
          <td>${safe(a.comentarios)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="7" class="no-rows">No hay abonos registrados para este grupo.</td></tr>`;

  const totalesPorMoneda = new Map();
  (abonos || []).forEach(a => {
    if (a.montoNum != null) {
      const key = a.moneda || 'CLP';
      totalesPorMoneda.set(key, (totalesPorMoneda.get(key) || 0) + Number(a.montoNum));
    }
  });

  let tfootHtml = '';
  if (totalesPorMoneda.size){
    const lineas = [];
    totalesPorMoneda.forEach((val, mon) => {
      lineas.push(`${formatMoney(val, mon)} ${mon}`);
    });
    tfootHtml = `
      <tfoot>
        <tr>
          <td colspan="5" class="finanzas-total-label">TOTAL</td>
          <td colspan="2" class="finanzas-total-value">${lineas.join(' · ')}</td>
        </tr>
      </tfoot>`;
  }

  return `
    <div class="print-doc finanzas-doc">
      <div class="finanzas-header">
        <div class="finanzas-title-block">
          <div class="finanzas-title">ESTADO DE CUENTAS DEL VIAJE</div>
          <div class="finanzas-subtitle">${safe(lineaPrincipal, '')}</div>
          <div class="finanzas-meta">
            ${grupo.numeroNegocio ? `<span>Nº NEGOCIO: ${grupo.numeroNegocio}</span>` : ''}
            ${ano ? `<span>AÑO VIAJE: ${ano}</span>` : ''}
            ${programa ? `<span>PROGRAMA: ${programa}</span>` : ''}
          </div>
        </div>
        <div class="finanzas-logo">
          <!-- Ajusta la ruta del logo si es distinta -->
          <img src="Logo Raitrai.png" alt="Turismo RaiTrai">
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">ABONOS ENTREGADOS AL GRUPO</div>
        <table class="finanzas-table">
          <thead>
            <tr>
              <th>N°</th>
              <th>Fecha</th>
              <th>Actividad / Concepto</th>
              <th>Medio de pago</th>
              <th>Moneda</th>
              <th>Monto</th>
              <th>Comentario</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
          ${tfootHtml}
        </table>
      </div>

      <div class="finanzas-footnote">
        Documento generado por Turismo RaiTrai para uso del/de la coordinador(a) durante el viaje.
        
        NOMBRE:
        
        FECHA:

        
        FIRMA:
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
      <td class="right">
        <button class="btn-add btn-one">CONFIRMACIÓN</button>
        <button class="btn-add btn-finanzas">FINANZAS</button>
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

  document.getElementById('chkAll').onchange = (ev)=>{
    tb.querySelectorAll('.rowchk').forEach(c=> c.checked = ev.currentTarget.checked);
  };
}

// ──────────────────────────────────────────────────────────────
// Descargar PDF de FINANZAS (Estado de cuentas del viaje)
// ──────────────────────────────────────────────────────────────
async function descargarFinanzas(grupoId){
  // 1) Traer datos del grupo
  const d = await getDoc(doc(db,'grupos', grupoId));
  if (!d.exists()) return;
  const g = { id:d.id, ...d.data() };

  // 2) Traer abonos
  const abonos = await fetchFinanzasAbonos(grupoId);

  // 3) Preparar contenedor oculto y estilos
  injectPdfStyles();
  const work = ensurePdfWork();                 // ← ya lo deja en (0,0) invisible
  work.innerHTML = buildFinanzasDoc(g, abonos);

  const node = work.querySelector('.finanzas-doc') || work;

  // 4) Calcular ancho real de captura (zona segura A4)
  const SAFE_PX = Math.round(208 * 96 / 25.4);  // ≈ ancho 208mm en px
  const capW = Math.max(
    SAFE_PX,
    node.scrollWidth || SAFE_PX,
    Math.ceil(node.getBoundingClientRect().width || SAFE_PX)
  );

  // 5) Nombre de archivo
  const fechaDescarga = formatDMYDownload(new Date());
  const base = g.aliasGrupo || g.nombreGrupo || g.numeroNegocio || 'Grupo';
  const filename = `Finanzas_${fileSafe(base)}_${fechaDescarga}.pdf`;

  // 6) Exportar con html2pdf (local, sin MiViaje)
  await ensureHtml2Pdf();
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

/* ──────────────────────────────────────────────────────────────────────
   Exportación a PDF (uno / lote)
────────────────────────────────────────────────────────────────────── */
async function descargarUno(grupoId){
  // Trae el grupo (para nombre y para fallback local)
  const d = await getDoc(doc(db,'grupos', grupoId));
  if (!d.exists()) return;
  const g = { id:d.id, ...d.data() };

  // Nombre de archivo (DDMMAAAA)
  const fechaDescarga = formatDMYDownload(new Date());
  const base = g.aliasGrupo || g.nombreGrupo || g.numeroNegocio || 'Grupo';
  const filename = `Conf_${fileSafe(base)}_${fechaDescarga}.pdf`;

  // ====== PREPAREMOS FALLBACK LOCAL (por si MiViaje no sirve) ======
  // Datos necesarios para render local
  const vuelosDocs = await loadVuelosInfo(g);
  const vuelosNorm = (vuelosDocs || []).map(normalizeVuelo);
  const hoteles    = await loadHotelesInfo(g);

  // Fechas para el itinerario (si aplica)
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

  // Render local oculto
  injectPdfStyles();                   // estilos A4
  const work = ensurePdfWork();        // crea #pdf-work si no existe
  work.innerHTML = buildPrintDoc(g, vuelosNorm, hoteles, fechas);

  // Fijar ancho A4 en px para html2canvas
  const target = work.querySelector('.print-doc');
  const CAPTURE_PX = Math.round(208 * 96 / 25.4); // zona segura
  if (target){
    target.style.width = CAPTURE_PX + 'px';
    target.style.minHeight = Math.round(297 * 96 / 25.4) + 'px';
  }


  // ====== PRUEBA MI VIAJE y si se cae/recorta → fallback local ======
  await exportarPDFconFallback({ grupoId: g.id, node: target || work, filename });
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
  let ok=0, fail=0;
  for (let i=0;i<ids.length;i++){
    prog.textContent = `Generando ${i+1}/${ids.length}…`;
    try{
      await descargarUno(ids[i]);
      ok++;
    }catch(e){
      console.error('PDF error', ids[i], e);
      fail++;
    }
  }
  prog.textContent = `Listo: ${ok} ok${fail?`, ${fail} con error`:''}.`;
  setTimeout(()=> prog.textContent = '', 4000);
}

async function pdfDesdeMiViaje(grupoId, filename){
  const SAFE_PX = Math.round(208 * 96 / 25.4); // zona segura
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
      width: 208mm !important;             /* zona segura */
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
      width: 208mm !important;             /* zona segura */
      min-height: 297mm !important;
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
    p.style.width = '208mm';
    p.style.minHeight = '297mm';
    p.style.background = '#ffffff';
    p.style.transform = 'none';
  });


  try { if (idoc.fonts && idoc.fonts.ready) await idoc.fonts.ready; } catch {}
  await new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)));

  // 5) Ancho real de captura (evita escalado que “encoge” dos páginas en una)
  const capW = Math.max(
    A4_PX,
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
    const SAFE_PX = Math.round(208 * 96 / 25.4);
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
