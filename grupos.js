//grupos.js

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, orderBy, where,
  doc, updateDoc, addDoc, Timestamp, writeBatch   // ← agrega writeBatch aquí
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
// Clave requerida para modificar PAX / ADULTOS / ESTUDIANTES
const PAX_PASSWORD = 'Nacho123!';


// Propiedades en el mismo orden que aparecen en la tabla
const camposFire = [
  "numeroNegocio",      // 0
  "identificador",      // 1
  "nombreGrupo",        // 2
  "anoViaje",           // 3
  "vendedora",          // 4 
  "cantidadgrupo",      // 5
  "adultos",            // 6
  "estudiantes",        // 7
  "colegio",            // 8
  "curso",              // 9
  "destino",            // 10
  "programa",           // 11
  "fechaInicio",        // 12
  "fechaFin",           // 13
  "asistenciaEnViajes", // 14
  "autorizacion",       // 15
  "hoteles",            // 16
  "ciudades",           // 17
  "transporte",         // 18
  "tramos",             // 19
  "fechaDeViaje",       // 20
  "observaciones",      // 21
  "creadoPor",          // 22
  "fechaCreacion"       // 23
];

// Campos que deben ser numéricos en Firestore
const NUMERIC_FIELDS = new Set(['cantidadgrupo','adultos','estudiantes']);

let editMode = false;
let dtHist = null;
let GRUPOS_RAW = [];

let tablaGruposDT = null;

const ANO_ACTUAL = new Date().getFullYear();

function resolverAnoFiltro(valor) {
  if (valor === 'anterior') return String(ANO_ACTUAL - 1);
  if (valor === 'proximo') return String(ANO_ACTUAL + 1);
  if (valor === 'todos') return 'todos';
  return String(ANO_ACTUAL);
}

// 👇 NUEVO: estado de filtros de vuelo
const FLT_FILTER = {
  tipo: 'all',      // 'all' | 'charter' | 'regular'
  fechaIda: ''      // 'YYYY-MM-DD' o ''
};

$(function(){
  $('#btn-logout').click(() => signOut(auth).then(()=>location='login.html'));
  onAuthStateChanged(auth, user => {
    if (!user) location = 'login.html';
    else cargarYMostrarTabla('actual');
  });
});

function formatearCelda(valor, campo) {
  const camposFecha = ['fechaInicio', 'fechaFin', 'fechaDeViaje', 'fechaCreacion'];

  if (camposFecha.includes(campo)) {
    let date = null;

    if (valor instanceof Timestamp) {
      date = valor.toDate();
    } else if (valor?.toDate) {
      date = valor.toDate();
    } else {
      date = parseFechaPosible(valor);
    }

    if (date instanceof Date && !isNaN(date.getTime())) {
      return date.toLocaleDateString('es-CL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }).replaceAll('/', '-');
    }
  }

  return valor?.toString() || '';
}

// ==== Helpers de normalización para Totales ====
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function parseFechaPosible(v) {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (v?.toDate) return v.toDate();
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (m) {
      let [ , dd, mm, yy ] = m;
      dd = dd.padStart(2,'0'); mm = mm.padStart(2,'0');
      yy = yy.length === 2 ? ('20' + yy) : yy;
      return new Date(`${yy}-${mm}-${dd}T00:00:00`);
    }
  }
  return null;
}

// Convierte Date -> "YYYY-MM-DD" para <input type="date">
function toInputDate(d) {
  if (!(d instanceof Date)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ================== ENRIQUECIMIENTO: HELPERS REUTILIZABLES ===================
const _norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,'');
const _arrify = v => Array.isArray(v) ? v : (v && typeof v==='object' ? Object.values(v) : (v?[v]:[]));

function _toISO(x){
  if (!x) return '';
  if (typeof x === 'string') {
    const t = x.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;          // YYYY-MM-DD
    if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {                   // DD-MM-YYYY
      const [dd,mm,yy] = t.split('-');
      return `${yy}-${mm}-${dd}`;
    }
    const d = new Date(t);
    return isNaN(d) ? '' : d.toISOString().slice(0,10);
  }
  if (x instanceof Date) return x.toISOString().slice(0,10);
  if (x?.toDate) return x.toDate().toISOString().slice(0,10);
  if (x?.seconds != null) return new Date(x.seconds*1000).toISOString().slice(0,10);
  return '';
}
const _dmy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||''); 
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const _timeVal = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t||'').trim());
  if (!m) return 1e9;
  const h = Math.max(0, Math.min(23, parseInt(m[1],10)));
  const mi= Math.max(0, Math.min(59, parseInt(m[2],10)));
  return h*60+mi;
};

// === Color de fondo por estado del coordinador ===
function _bgEstado(est){
  const v = String(est||'').toLowerCase();
  if (v === 'aprobado')  return 'background-color: rgba(16,185,129,.18)'; // verde suave
  if (v === 'rechazado') return 'background-color: rgba(239,68,68,.18)';  // rojo suave
  return 'background-color: rgba(234,179,8,.22)';                         // amarillo (pendiente / default)
}

// Emails/nombres probables de coordinadores desde el doc grupo
function _emailsOf(g){
  const out = new Set();
  const push = (e)=>{ if(e) out.add(String(e).toLowerCase()); };
  push(g?.coordinadorEmail); 
  push(g?.coordinador?.email);
  _arrify(g?.coordinadoresEmails).forEach(push);
  if (g?.coordinadoresEmailsObj) Object.keys(g.coordinadoresEmailsObj).forEach(push);
  _arrify(g?.coordinadores).forEach(x=>{
    if (x?.email) push(x.email);
    else if (typeof x === 'string' && x.includes('@')) push(x);
  });
  return [...out];
}

// =============== ÍNDICE DE HOTELES (caché) ===============
const _hotelesCache = { loaded:false, byId:new Map(), bySlug:new Map(), all:[] };

async function _ensureHotelesIndex(db){
  if (_hotelesCache.loaded) return _hotelesCache;
  const snap = await getDocs(collection(db,'hoteles'));
  snap.forEach(d=>{
    const x = d.data() || {};
    const docu = { id:d.id, ...x };
    const s = _norm(x.slug || x.nombre || d.id);
    _hotelesCache.byId.set(String(d.id), docu);
    if (s) _hotelesCache.bySlug.set(s, docu);
    _hotelesCache.all.push(docu);
  });
  _hotelesCache.loaded = true;
  return _hotelesCache;
}

// =============== HOTELES POR GRUPO (multi-esquema) ===============
const _cacheHotelesByGroup = new Map();
async function _loadHotelesInfo(db, g){
  const groupDocId = String(g.id || '').trim();
  const groupNum   = String(g.numeroNegocio || '').trim();
  const cacheKey   = `hoteles:${groupDocId || groupNum}`;
  if (_cacheHotelesByGroup.has(cacheKey)) return _cacheHotelesByGroup.get(cacheKey);

  let cand = [];
  // esquemas frecuentes
  if (groupDocId){
    try{
      const q1 = query(collection(db,'hotelAssignments'), where('grupoId','==', groupDocId));
      const s1 = await getDocs(q1); s1.forEach(d=> cand.push({ id:d.id, ...(d.data()||{}) }));
    }catch{}
    if (!cand.length){
      try{
        const q2 = query(collection(db,'hotelAssignments'), where('grupoDocId','==', groupDocId));
        const s2 = await getDocs(q2); s2.forEach(d=> cand.push({ id:d.id, ...(d.data()||{}) }));
      }catch{}
    }
  }
  if (!cand.length && groupNum){
    try{
      const q3 = query(collection(db,'hotelAssignments'), where('grupoNumero','==', groupNum));
      const s3 = await getDocs(q3); s3.forEach(d=> cand.push({ id:d.id, ...(d.data()||{}) }));
    }catch{}
  }
  if (!cand.length){ _cacheHotelesByGroup.set(cacheKey, []); return []; }

  // resolver doc hotel
  const { byId, bySlug, all } = await _ensureHotelesIndex(db);
  function pickHotelDoc(asig){
    const tryIds = [];
    if (asig?.hotelId) tryIds.push(String(asig.hotelId));
    if (asig?.hotelDocId) tryIds.push(String(asig.hotelDocId));
    if (asig?.hotel?.id) tryIds.push(String(asig.hotel.id));
    if (asig?.hotelRef?.id) tryIds.push(String(asig.hotelRef.id));
    const m = (asig?.hotelPath||'').match(/hoteles\/([^/]+)/i);
    if (m) tryIds.push(m[1]);
    for (const id of tryIds){ if (byId.has(id)) return byId.get(id); }

    const s = _norm(asig?.nombre || asig?.hotelNombre || '');
    const dest = _norm(g.destino || '');
    if (s){
      if (bySlug.has(s)) return bySlug.get(s);
      const cand = [];
      for (const [slugName, docu] of bySlug){ if (slugName.includes(s) || s.includes(slugName)) cand.push(docu); }
      if (cand.length === 1) return cand[0];
      return cand.find(d => _norm(d.destino||d.ciudad||'') === dest) || cand[0] || null;
    }
    // fallback por destino
    const sameDest = all.filter(h => _norm(h.destino||h.ciudad||'') === dest);
    return sameDest[0] || null;
  }

  cand.sort((a,b)=> (_toISO(a.checkIn)||'').localeCompare(_toISO(b.checkIn)||''));
  const out = cand.map(a=>{
    const H = pickHotelDoc(a);
    return {
      ...a,
      hotel: H,
      hotelNombre: a?.hotelNombre || a?.nombre || H?.nombre || '',
      checkIn: _toISO(a.checkIn),
      checkOut: _toISO(a.checkOut)
    };
  });

  _cacheHotelesByGroup.set(cacheKey, out);
  return out;
}

// =============== VUELOS POR GRUPO (multi-esquema) ===============
const _cacheVuelosByGroup = new Map();
function _normalizeVuelo(v){
  const get = (...keys)=>{ for (const k of keys){
    const val = k.split('.').reduce((acc,p)=> (acc && acc[p]!==undefined) ? acc[p] : undefined, v);
    if (val!==undefined && val!==null && val!=='') return val;
  } return ''; };

  const tipoTransporte = (String(get('tipoTransporte')) || 'aereo').toLowerCase() || 'aereo';
  const tipoVuelo      = (tipoTransporte==='aereo')
    ? (String(get('tipoVuelo') || 'charter').toLowerCase())
    : '';

  const numero    = get('numero','nro','numVuelo','vuelo','flightNumber','codigo','code');
  const proveedor = get('proveedor','empresa','aerolinea','compania');

  const origen    = get('origen','salida.origen','salida.iata','origenIATA','origenSigla','origenCiudad');
  const destino   = get('destino','llegada.destino','llegada.iata','destinoIATA','destinoSigla','destinoCiudad');
  const fechaIda  = get('fechaIda','ida','salida.fecha','fechaSalida','fecha_ida','fecha');
  const fechaVta  = get('fechaVuelta','vuelta','regreso.fecha','fechaRegreso','fecha_vuelta');

  const presentacionIdaHora    = get('presentacionIdaHora');
  const vueloIdaHora           = get('vueloIdaHora');
  const presentacionVueltaHora = get('presentacionVueltaHora');
  const vueloVueltaHora        = get('vueloVueltaHora');

  const idaHora    = get('idaHora');
  const vueltaHora = get('vueltaHora');

  const tr = Array.isArray(v.tramos) ? v.tramos : [];
  const tramos = tr.map(t=>({
    aerolinea: String(t.aerolinea||'').toUpperCase(),
    numero:    String(t.numero||'').toUpperCase(),
    origen:    String(t.origen||'').toUpperCase(),
    destino:   String(t.destino||'').toUpperCase(),
    fechaIda:  t.fechaIda || '',
    fechaVuelta: t.fechaVuelta || '',
    presentacionIdaHora:    t.presentacionIdaHora || '',
    vueloIdaHora:           t.vueloIdaHora || '',
    presentacionVueltaHora: t.presentacionVueltaHora || '',
    vueloVueltaHora:        t.vueloVueltaHora || ''
  }));

  return {
    numero, proveedor,
    tipoTransporte, tipoVuelo,
    origen, destino, fechaIda, fechaVta,
    presentacionIdaHora, vueloIdaHora, presentacionVueltaHora, vueloVueltaHora,
    idaHora, vueltaHora,
    tramos
  };
}

async function _loadVuelosInfo(db, g){
  const docId = String(g.id || '').trim();
  const num   = String(g.numeroNegocio || '').trim();
  const cacheKey = `vuelos:${docId || num}`;
  if (_cacheVuelosByGroup.has(cacheKey)) return _cacheVuelosByGroup.get(cacheKey);

  const found = [];
  // a) grupoIds array-contains docId / numero
  if (docId){ try{
    const q1 = query(collection(db,'vuelos'), where('grupoIds','array-contains', docId));
    const s1 = await getDocs(q1); s1.forEach(d=> found.push({ id:d.id, ...(d.data()||{}) }));
  }catch{} }
  if (!found.length && num){ try{
    const q2 = query(collection(db,'vuelos'), where('grupoIds','array-contains', num));
    const s2 = await getDocs(q2); s2.forEach(d=> found.push({ id:d.id, ...(d.data()||{}) }));
  }catch{} }

  // b) barrido general (por si no están indexados)
  if (!found.length){
    const sAll = await getDocs(collection(db,'vuelos'));
    sAll.forEach(d=>{
      const v = d.data()||{};
      let match = false;
      if (Array.isArray(v.grupos)) {
        match = v.grupos.some(x=>{
          if (typeof x === 'string') return (docId && x===docId) || (num && x===num);
          if (x && typeof x==='object'){
            const xid  = String(x.id || x.grupoId || '').trim();
            const xnum = String(x.numeroNegocio || x.numNegocio || '').trim();
            return (docId && xid===docId) || (num && xnum===num);
          }
          return false;
        });
      }
      if (!match){
        const rootId  = String(v.grupoId || '').trim();
        const rootNum = String(v.grupoNumero || v.numeroNegocio || '').trim();
        match = (docId && rootId===docId) || (num && rootNum===num);
      }
      if (match) found.push({ id:d.id, ...v });
    });
  }

  const out = found.map(_normalizeVuelo);
  _cacheVuelosByGroup.set(cacheKey, out);
  return out;
}

// ------------ ÍNDICES RÁPIDOS PARA COORDINADORES ------------
async function _buildCoordIndexes() {
  // 1) coordinadorId -> { nombre, correo, telefono }
  const coordById = new Map();
  try {
    const snapC = await getDocs(collection(db, 'coordinadores'));
    snapC.forEach(d => {
      const x = d.data() || {};
      const nombre   = (x.nombre || '').trim();
      const correo   = (x.correo || '').trim().toLowerCase();
      const telefono =
        (x.telefono || x.fono || x.celular || (x.meta && (x.meta.telefono || x.meta.celular)) || '')
        .toString()
        .trim();

      coordById.set(d.id, { nombre, correo, telefono });
    });
  } catch (e) {
    console.warn('No pude leer coordinadores:', e);
  }

  // 2) grupoId -> coordinadorId (desde collectionGroup('conjuntos'))
  const coordIdByGrupo = new Map();
  const estadoByGrupo  = new Map();

  try {
    const snapSets = await getDocs(collectionGroup(db, 'conjuntos'));
    snapSets.forEach(s => {
      const coordId = s.ref.parent.parent.id;
      const x = s.data() || {};
      const est = String(x.estadoCoord || 'pendiente').toLowerCase();
      (x.viajes || []).forEach(gid => {
        const k = String(gid);
        coordIdByGrupo.set(k, coordId);
        estadoByGrupo.set(k, est);
      });
    });
  } catch (e) {
    console.warn('No pude leer conjuntos:', e);
  }

  return { coordById, coordIdByGrupo, estadoByGrupo };
}

function setCarga(porcentaje, titulo, detalle = '') {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('ok', 'error');
  box.style.display = 'block';

  bar.style.width = `${Math.max(0, Math.min(100, porcentaje))}%`;
  title.textContent = titulo;
  detail.textContent = detalle;
}

function setCargaOk(detalle = 'Datos cargados correctamente.') {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('error');
  box.classList.add('ok');
  bar.style.width = '100%';
  title.textContent = 'Listo';
  detail.textContent = detalle;
}

function setCargaError(error) {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('ok');
  box.classList.add('error');
  bar.style.width = '100%';
  title.textContent = 'Error al cargar';
  detail.textContent = error?.message || String(error) || 'Error desconocido. Revisa la consola.';
}

async function cargarYMostrarTabla(filtroAnoCarga = 'actual') {
  try {
    setCarga(5, 'Cargando grupos...', 'Leyendo colección grupos');

    // 1) Leer colección "grupos" filtrada por año para cargar más rápido
    const anoResuelto = resolverAnoFiltro(filtroAnoCarga);
    
    let qGrupos;
    
    if (anoResuelto === 'todos') {
      qGrupos = query(collection(db, 'grupos'));
    } else {
      qGrupos = query(
        collection(db, 'grupos'),
        where('anoViaje', '==', anoResuelto)
      );
    }
    
    const snap = await getDocs(qGrupos);
    
    if (snap.empty) {
      console.warn('No hay grupos para el filtro:', filtroAnoCarga);
      return;
    }

    setCarga(15, 'Grupos cargados', `${snap.size} grupos encontrados`);

  // Índices de coordinadores (1 sola vez)
  setCarga(25, 'Cargando coordinadores...', 'Leyendo coordinadores y conjuntos');
  const { coordById, coordIdByGrupo, estadoByGrupo } = await _buildCoordIndexes();
  setCarga(35, 'Coordinadores cargados', 'Preparando tabla principal');

  // 2) Mapear docs → {id,fila:[], coordTexto} PARA LA TABLA
  const valores = snap.docs.map(docSnap => {
    const d = docSnap.data();
  
    // Resolver coordinador visible: primero el que venga en el doc, si no, desde conjuntos
    const coordIdDoc         = d.coordinadorId || null;
    const coordIdViaConjunto = coordIdByGrupo.get(docSnap.id) || null;
    const coordId            = coordIdDoc || coordIdViaConjunto || null;
    const coordInfo          = coordId ? coordById.get(coordId) : null;
  
    const coordTexto =
      (coordInfo?.nombre || '').trim() ||
      (d.coordinador || '').toString().trim() ||
      (coordInfo?.correo || '').trim() || '';
  
    const coordTelefono =
      (coordInfo?.telefono || '').toString().trim();
  
    return {
      id:   docSnap.id,
      fila: camposFire.map(c => d[c] || ''),
      coordTexto,
      coordTelefono,
      estadoCoord: d.coordEstado || estadoByGrupo.get(docSnap.id) || 'pendiente'
    };
  });



  // 2.b) Normalizar datos crudos → GRUPOS_RAW (para Totales)
  GRUPOS_RAW = snap.docs.map(s => {
    const d = s.data();
    return {
      _id: s.id,
      numeroNegocio: d.numeroNegocio ?? '',
      identificador: d.identificador ?? '',
      nombreGrupo: d.nombreGrupo ?? '',
      anoViaje: d.anoViaje ?? '',
      vendedora: d.vendedora ?? '',
      cantidadgrupo: toNum(d.cantidadgrupo),
      adultos: toNum(d.adultos),
      estudiantes: toNum(d.estudiantes),
      colegio: d.colegio ?? '',
      curso: d.curso ?? '',
      destino: d.destino ?? '',
      programa: d.programa ?? '',
      fechaInicio: parseFechaPosible(d.fechaInicio),
      fechaFin: parseFechaPosible(d.fechaFin),
      hoteles: d.hoteles ?? '',
      transporte: d.transporte ?? ''
    };
  });

    // ============ ENRIQUECIMIENTO: HOTELES + VUELOS + COORDINADORES ============
  // Construimos un espejo mínimo del grupo para los loaders
  const gruposParaLookup = snap.docs.map(s => {
    const d = s.data() || {};
    return {
      id: s.id,
      numeroNegocio: String(d.numeroNegocio ?? d.numNegocio ?? d.idNegocio ?? s.id),
      destino: d.destino ?? '',
      fechaInicio: _toISO(d.fechaInicio),
      fechaFin:    _toISO(d.fechaFin),
      // campos crudos por si hay estructuras legacy
      coordinadorEmail: d.coordinadorEmail,
      coordinador: d.coordinador,
      coordinadoresEmails: d.coordinadoresEmails,
      coordinadoresEmailsObj: d.coordinadoresEmailsObj,
      coordinadores: d.coordinadores
    };
  });

  // Procesa en tandas para no saturar
  const BATCH = 15;
  for (let i=0; i<valores.length; i+=BATCH){
    const avance = 40 + Math.round((i / Math.max(1, valores.length)) * 35);
    setCarga(
      avance,
      'Enriqueciendo información...',
      `Procesando hoteles, vuelos y coordinadores ${Math.min(i + BATCH, valores.length)} de ${valores.length}`
    );
    const sliceVals = valores.slice(i, i+BATCH);
    const sliceGps  = gruposParaLookup.slice(i, i+BATCH);

    const jobs = sliceGps.map(async (g, k) => {
      const idx = i + k;
      const fila = sliceVals[k].fila;

      // --- Hoteles
      try{
        const hoteles = await _loadHotelesInfo(db, g);
        if (hoteles && hoteles.length){
          const txt = hoteles.map(h => {
            const name = String(h.hotelNombre||'').toUpperCase();
            const ci = _dmy(_toISO(h.checkIn));
            const co = _dmy(_toISO(h.checkOut));
            return `${name}${ci||co ? ` (${ci} → ${co})` : ''}`;
          }).join(' · ');
          fila[16] = txt || fila[16]; // Columna "hoteles"
          // Mantener también en GRUPOS_RAW para Totales por "Hoteles"
          const graw = GRUPOS_RAW[idx]; if (graw) graw.hoteles = txt;
        }
      }catch(e){ /* silencioso */ }

      // --- Vuelos / Transporte
      try{
        const vuelos = await _loadVuelosInfo(db, g);
        if (vuelos && vuelos.length){
          // sumario simple: si hay aéreos, tomar primero; si no, bus
          const v0 = vuelos[0]; // o mezcla si quieres
          const isAereo = (v0.tipoTransporte || 'aereo') === 'aereo';
          if (isAereo){
            const tipo = (v0.tipoVuelo||'').toUpperCase(); // CHARTER/REGULAR
            const nro  = (v0.numero||'').toString().toUpperCase();
            const ida  = _dmy(_toISO(v0.fechaIda));
            const vta  = _dmy(_toISO(v0.fechaVta));
            const lIda = (v0.presentacionIdaHora || v0.vueloIdaHora)
              ? ` · IDA: ${v0.presentacionIdaHora?('PRES '+v0.presentacionIdaHora):''}${v0.vueloIdaHora?(v0.presentacionIdaHora?' · ':'')+'VUELO '+v0.vueloIdaHora:''}`
              : '';
            const lVta = (v0.presentacionVueltaHora || v0.vueloVueltaHora)
              ? ` · VUELTA: ${v0.presentacionVueltaHora?('PRES '+v0.presentacionVueltaHora):''}${v0.vueloVueltaHora?(v0.presentacionVueltaHora?' · ':'')+'VUELO '+v0.vueloVueltaHora:''}`
              : '';
            fila[18] = `AÉREO${tipo?(' · '+tipo):''}${nro?(' · '+nro):''} · ${ida||'—'} → ${vta||'—'}${lIda}${lVta}`.trim();
            fila[19] = Array.isArray(v0.tramos) && v0.tramos.length
              ? `${v0.tramos.length} TRAMO(S)`
              : (fila[19] || '');
          } else {
            // BUS
            const idaH = v0.idaHora || '';
            const vtaH = v0.vueltaHora || '';
            fila[18] = `TERRESTRE (BUS)${idaH||vtaH?` · SALIDA: ${idaH||'—'} · REGRESO: ${vtaH||'—'}`:''}`;
            fila[19] = fila[19] || ''; // puedes usarlo para #buses si lo deseas
          }
          // Mantener para Totales por "Transporte"
          const graw = GRUPOS_RAW[idx]; if (graw) graw.transporte = fila[18];
        }
      }catch(e){ /* silencioso */ }

      // --- Coordinadores → NUEVA COLUMNA (col 24, no editable)
      // --- Coordinadores → NUEVA COLUMNA (col 24, no editable)
    // (no haces nada extra aquí por ahora)
  }); // ← cierre de sliceGps.map(async (g, k) => { ... })
    // Espera que terminen todas las tareas de este bloque
    await Promise.allSettled(jobs);
  } // ← cierre del for (i += BATCH)

  setCarga(80, 'Construyendo filtros...', 'Preparando destino, año y transporte');

  // Para filtros rápido (Destino / Año / Transporte)
  const destinosUnicos     = new Set();
  const aniosUnicos        = new Set();
  const transportesUnicos  = new Set();

  valores.forEach(item => {
    const fila = item.fila;
    destinosUnicos.add(fila[10]);          // Destino
    aniosUnicos.add(fila[3]);              // Año
    if (fila[18]) transportesUnicos.add(fila[18]); // Texto de TRANSPORTE (vuelo/bus) ya enriquecido
  });

  const destinos    = Array.from(destinosUnicos).sort();
  const anios       = Array.from(aniosUnicos).sort();
  const transportes = Array.from(transportesUnicos).sort();

  // Destinos
  const $filtroDestino = $('#filtroDestino').empty().append('<option value="">Todos</option>');
  destinos.forEach(d => $filtroDestino.append(`<option value="${d}">${d}</option>`));

  // Año: se mantiene como selector de carga, no como filtro local
  $('#filtroAno').val(filtroAnoCarga);

  // 👇 NUEVO: selector de Vuelo / Transporte (columna Transporte)
  const $filtroTransporte = $('#filter-transporte').empty().append('<option value="">Todos</option>');
  transportes.forEach(t => {
    $filtroTransporte.append(`<option value="${t}">${t}</option>`);
  });

  // 3) Renderizar <tbody>
  const $tb = $('#tablaGrupos tbody').empty();
  valores.forEach(item => {
    const $tr = $('<tr>');

    // columnas 0..4 (hasta Vendedor[a])
    for (let idx = 0; idx <= 4; idx++) {
      const campo = camposFire[idx];
      const celda = item.fila[idx];
      const $td = $('<td>')
        .text(formatearCelda(celda, campo))
        .attr('data-doc-id', item.id)
        .attr('data-campo', campo)
        .attr('data-original', celda);
      if (NUMERIC_FIELDS.has(campo)) $td.attr('data-tipo', 'number');
      $tr.append($td);
    }

    // 👉 COLUMNA 5: COORDINADORES (no editable) + color por estado
    const coordText = (item.coordTexto || '').toString().toUpperCase();
    const est = (item.estadoCoord || 'pendiente');
    const $tdCoord = $('<td>')
      .text(coordText)
      .attr('data-doc-id', item.id)
      .attr('data-fixed', '1')
      .attr('data-campo', '')
      .attr('data-original', coordText)
      .attr('title', 'Estado: ' + est.toUpperCase())
      .attr('style', _bgEstado(est)); // verde/amarillo/rojo
    $tr.append($tdCoord);

    // 👉 COLUMNA 6: TELÉFONO DEL COORDINADOR (no editable)
    const telText = (item.coordTelefono || '').toString().trim();
    const $tdTel = $('<td>')
      .text(telText)
      .attr('data-doc-id', item.id)
      .attr('data-fixed', '1')
      .attr('data-campo', '')
      .attr('data-original', telText)
      .attr('title', 'Teléfono coordinador');
    $tr.append($tdTel);

    // resto de columnas 5..23 (corren a 7..25)
    for (let idx = 5; idx < camposFire.length; idx++) {
      const campo = camposFire[idx];
      const celda = item.fila[idx];
      const $td = $('<td>')
        .text(formatearCelda(celda, campo))
        .attr('data-doc-id', item.id)
        .attr('data-campo', campo)
        .attr('data-original', celda);
      if (NUMERIC_FIELDS.has(campo)) $td.attr('data-tipo', 'number');
      $tr.append($td);
    }

    $tb.append($tr);
  });

  setCarga(90, 'Renderizando tabla...', 'Inicializando DataTable');
    
  // 4) Iniciar DataTable principal
  const tabla = $('#tablaGrupos').DataTable({
    // (config actual igual)
    language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    dom:        'Brtip',
    buttons: [
      {
        extend: 'colvis',
        text:    'Ver columnas',
        className: 'dt-button',
        columns: ':gt(0)'
      }
    ],
    pageLength: -1,
    lengthChange: false,
    order: [[12, 'desc'], [13, 'desc'], [14, 'desc'], [1, 'desc']],
    scrollX: true,
    autoWidth: true,
    scrollCollapse: true,
    fixedHeader: {
      header: true,
      headerOffset: $('header.header').outerHeight() + $('.filter-bar').outerHeight()
    },
    columnDefs: [
      { targets: [10, 11, 16, 17, 19, 21, 24, 25], visible: false },
      { targets: [7, 8, 9], type: 'num', className: 'dt-body-right' },
      { targets: '_all', className: 'dt-nowrap' }
    ]
  });
  tablaGruposDT = tabla;
  tabla.buttons().container().appendTo('#toolbar');

  setTimeout(() => {
    const $wrapper = $('#tablaGrupos').closest('.dataTables_wrapper');

    tabla.columns.adjust().draw(false);

    if (tabla.fixedHeader) {
      tabla.fixedHeader.adjust();
    }

    $wrapper.find('.dataTables_scrollBody').scrollLeft(0);
  }, 300);

  // ——— BÚSQUEDA ESPECIAL: "<texto>,..."  para incluir coordinadores en blanco ———
  const BUSQ_ESPECIAL = { activo:false, termino:'' };
  
  // Filtro personalizado de DataTables (BUSQ_ESPECIAL + filtros de vuelo)
  $.fn.dataTable.ext.search.push(function (settings, rowData) {
    if (settings.nTable.id !== 'tablaGrupos') return true;

    // 1) FILTRO DE VUELOS → usamos la columna Transporte (índice 20)
    const trans = (rowData[20] || '').toString();

    // Tipo vuelo: 'charter' | 'regular' | 'all'
    if (FLT_FILTER.tipo === 'charter' || FLT_FILTER.tipo === 'regular') {
      const target = FLT_FILTER.tipo.toUpperCase();
      if (!trans.toUpperCase().includes(target)) {
        return false; // no coincide tipo → excluimos fila
      }
    }

    // Fecha ida: viene como YYYY-MM-DD desde el <input type="date">
    if (FLT_FILTER.fechaIda) {
      const [yyyy, mm, dd] = FLT_FILTER.fechaIda.split('-');
      const dmy = `${dd}-${mm}-${yyyy}`; // así la escribimos en el texto de Transporte
      if (!trans.includes(dmy)) {
        return false; // no coincide fecha de ida → excluimos
      }
    }

    // 2) MODO BUSQ_ESPECIAL (misma lógica que tenías)
    if (!BUSQ_ESPECIAL.activo) return true;

    const colCoord = 5;                                 // índice de "Coordinadores"
    const coordTxt = (rowData[colCoord] || '').trim();  // texto en Coordinadores
    const term     = BUSQ_ESPECIAL.termino.toLowerCase();
  
    // Si NO hay término (p.ej. escribiste solo ",") => mostrar SOLO los vacíos
    if (!term) return coordTxt === '';
  
    // Hay término: incluir fila si:
    //   (a) coincide el término en CUALQUIER columna,  OR
    //   (b) la columna Coordinadores está vacía
    const rowText = rowData.join(' ').toLowerCase();
    const coincide = rowText.indexOf(term) !== -1;
    return coincide || coordTxt === '';
  });


  
  // Filtros con los nuevos índices
  // Filtros con los nuevos índices
  $('#buscador').on('input', function () {
    const raw = String(this.value || '');
    const tieneComa = raw.includes(',');

    if (tieneComa) {
      // Modo especial: término = lo que va antes de la primera coma
      const termino = raw.split(',')[0].trim();
      BUSQ_ESPECIAL.activo  = true;
      BUSQ_ESPECIAL.termino = termino;

      // Desactivamos la búsqueda global de DT y usamos SOLO nuestro filtro
      tabla.search('');
    } else {
      // Modo normal: sin “OR con blancos”
      BUSQ_ESPECIAL.activo  = false;
      BUSQ_ESPECIAL.termino = '';
      tabla.search(raw);   // búsqueda global normal de DataTables
    }
    tabla.draw();
  });

  // Destino (columna 12 de la tabla)
  $('#filtroDestino').on('change', function(){
    tabla.column(12).search(this.value).draw();
  });

  // Año de viaje: recarga desde Firestore, no solo filtra DataTable
  $('#filtroAno').off('change').on('change', async function () {
    const valor = this.value || 'actual';

    try {
      if ($.fn.DataTable.isDataTable('#tablaGrupos')) {
        $('#tablaGrupos').DataTable().destroy();
      }

      $('#tablaGrupos tbody').empty();

      await cargarYMostrarTabla(valor);

    } catch (err) {
      console.error('Error recargando por año:', err);
      alert('Error al cargar grupos del año seleccionado.');
    }
  });

  // 👇 NUEVO: Tipo de vuelo (usa FLT_FILTER.tipo y ext.search)
  $('#filter-tipoVuelo').on('change', function () {
    const v = this.value || 'all';
    if (v === 'charter' || v === 'regular') {
      FLT_FILTER.tipo = v;
    } else {
      FLT_FILTER.tipo = 'all';
    }
    tabla.draw();
  });

  // 👇 NUEVO: Fecha de ida (usa FLT_FILTER.fechaIda y ext.search)
  $('#filter-fechaIda').on('change', function () {
    FLT_FILTER.fechaIda = this.value || '';
    tabla.draw();
  });

  // 👇 NUEVO: selector de Vuelo / Transporte → filtra por coincidencia exacta
  $('#filter-transporte').on('change', function () {
    const val = this.value || '';
    if (!val) {
      // Limpia filtro de columna
      tabla.column(20).search('', true, false).draw();
    } else {
      const escaped = $.fn.dataTable.util.escapeRegex(val);
      // ^...$ para coincidencia EXACTA del texto de Transporte
      tabla.column(20).search('^' + escaped + '$', true, false).draw();
    }
  });

  const DATE_FIELDS = new Set([
    'fechaInicio',
    'fechaFin',
    'fechaDeViaje',
    'fechaCreacion'
  ]);

  function timestampToInputDate(valor) {
    if (!valor) return '';

    if (valor instanceof Timestamp) {
      return toInputDate(valor.toDate());
    }

    if (valor?.toDate) {
      return toInputDate(valor.toDate());
    }

    if (valor instanceof Date) {
      return toInputDate(valor);
    }

    const parsed = parseFechaPosible(valor);
    return parsed ? toInputDate(parsed) : '';
  }

  function inputDateToDisplay(value) {
    if (!value) return '';
    const [yyyy, mm, dd] = value.split('-');
    return `${dd}-${mm}-${yyyy}`;
  }

  function inputDateToTimestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('Fecha inválida.');
    }

    return Timestamp.fromDate(new Date(value + 'T00:00:00'));
  }

  // Edición de fechas con calendario
  $('#tablaGrupos tbody')
    .off('click', 'td[data-campo]')
    .on('click', 'td[data-campo]', function () {
      if (!editMode) return;

      const $td = $(this);
      const campo = $td.attr('data-campo');

      if (!DATE_FIELDS.has(campo)) return;
      if ($td.find('input[type="date"]').length) return;

      const valorOriginal = $td.attr('data-original');
      const fechaInput = timestampToInputDate(valorOriginal || $td.text().trim());

      const $input = $('<input type="date">')
        .val(fechaInput)
        .css({
          width: '130px',
          border: '1px solid #7c3aed',
          padding: '4px',
          borderRadius: '6px'
        });

      $td.empty().append($input);
      $input.trigger('focus');

      $input.on('change blur', async function () {
        const value = this.value;

        if (!value) {
          $td.text(formatearCelda(valorOriginal, campo));
          return;
        }

        const docId = $td.attr('data-doc-id');
        const nuevoValor = inputDateToTimestamp(value);
        const displayText = inputDateToDisplay(value);

        try {
          await updateDoc(doc(db, 'grupos', docId), {
            [campo]: nuevoValor
          });

          await addDoc(collection(db, 'historial'), {
            numeroNegocio: $td.closest('tr').find('td').eq(0).text().trim(),
            campo,
            anterior: formatearCelda(valorOriginal, campo),
            nuevo: displayText,
            modificadoPor: auth.currentUser.email,
            timestamp: new Date()
          });

          $td
            .text(displayText)
            .attr('data-original', nuevoValor);

        } catch (err) {
          console.error('Error guardando fecha:', err);
          alert('No se pudo guardar la fecha.');
          $td.text(formatearCelda(valorOriginal, campo));
        }
      });
    });
    
  // 5) Edición inline en blur (numéricos -> número real en Firestore)
  $('#tablaGrupos tbody')
    .off('focusout', 'td[contenteditable]')
    .on('focusout', 'td[contenteditable]', async function () {
      const $td   = $(this);
      const campo = $td.attr('data-campo');
      const docId = $td.attr('data-doc-id');
      const orig  = $td.attr('data-original');

      // Si no hay campo o docId (ej. celda fija), salir
      if (!campo || !docId) return;

      // Las fechas se editan con calendario, no como texto libre
      if (DATE_FIELDS.has(campo)) return;

      // valor escrito por el usuario
      const raw = $td.text().trim();

      let nuevoValor;   // lo que enviaremos a Firestore
      let displayText;  // lo que dejamos visible en la celda

      if (NUMERIC_FIELDS.has(campo)) {
        // Validación/normalización numérica (solo enteros)
        if (raw === '') {
          nuevoValor  = 0;
          displayText = '0';
        } else {
          const n = Number(raw.replace(/[^\d.-]/g, ''));
          if (!Number.isFinite(n)) {
            // inválido -> revertimos visualmente
            $td.text(String(orig ?? ''));
            return;
          }
          const entero = Math.trunc(n);
          nuevoValor  = entero;           // Firestore: Number
          displayText = String(entero);   // UI
        }

      } else if (DATE_FIELDS.has(campo)) {
        nuevoValor = parseFechaParaFirestore(raw);
        displayText = raw;
      } else {
        // texto normal
        nuevoValor  = raw.toUpperCase();
        displayText = nuevoValor;
      }

      // Si no cambió realmente, salir
      if (String(orig ?? '') === String(displayText)) return;

      // ---------- PROTECCIÓN CAMPOS SENSIBLES (PAX / ADULTOS / ESTUDIANTES) ----------
      const esCampoPax =
        campo === 'cantidadgrupo' ||  // PAX
        campo === 'adultos'       ||  // ADULTOS
        campo === 'estudiantes';      // ESTUDIANTES;

      if (esCampoPax) {
        const clave = window.prompt('⚠️ Para modificar PAX / ADULTOS / ESTUDIANTES, ingresa la clave:');
        if (clave !== PAX_PASSWORD) {
          alert('Clave incorrecta. No se guardaron los cambios.');
          // Revertimos el texto a su valor original
          $td.text(String(orig ?? ''));
          return;
        }
      }
      // ------------------------------------------------------------------------------

      try {
        // Actualiza en Firestore con el TIPO correcto
        await updateDoc(doc(db, 'grupos', docId), { [campo]: nuevoValor });

        // Historial
        await addDoc(collection(db, 'historial'), {
          numeroNegocio: $td.closest('tr').find('td').eq(0).text().trim(),
          campo,
          anterior: orig ?? '',
          nuevo: displayText,
          modificadoPor: auth.currentUser.email,
          timestamp: new Date()
        });

        // Actualiza atributos/UI locales
        $td.text(displayText).attr('data-original', displayText);

        // Mantén sincronizado GRUPOS_RAW para Totales si es numérico
        if (NUMERIC_FIELDS.has(campo)) {
          const g = GRUPOS_RAW.find(x => x._id === docId);
          if (g) g[campo] = Number(displayText);
        }
      } catch (err) {
        console.error('Error al guardar edición:', err);
        // Revertimos visual si falla
        $td.text(String(orig ?? ''));
      }
    });


  // 6) Toggle edición
  $('#btn-toggle-edit').off('click').on('click', async () => {
    editMode = !editMode;
    $('#btn-toggle-edit').text(editMode?'🔒 Desactivar Edición':'🔓 Activar Edición');
    $('#tablaGrupos tbody tr').each((_,tr)=>{
      $(tr).find('td').each((i,td)=>{
        const $td = $(td);
        if (i > 1 && !$td.attr('data-fixed')) {
          $td.attr('contenteditable', editMode);
        } else {
          $td.removeAttr('contenteditable');
        }
      });
    });
    await addDoc(collection(db,'historial'),{
      accion: editMode?'ACTIVÓ MODO EDICIÓN':'DESACTIVÓ MODO EDICIÓN',
      usuario: auth.currentUser.email,
      timestamp: new Date()
    });
  });

  // 7) Ver Historial
  $('#btn-view-history').off('click').on('click', async () => {
    await recargarHistorial();
    $('#modalHistorial').show();
  });

  // =========================================================
  // 8) TOTALES — funciones locales y exposición global
  // =========================================================
  const $modalTot = $('#modalTotales');
  const $popover  = $('#tot-popover');

  function overlaps(ini, fin, min, max) {
    if (!ini && !fin) return false;
    ini = ini || fin; fin = fin || ini;
    if (min && fin < min) return false;
    if (max && ini > max) return false;
    return true;
  }

  function openTotales() {
    // Rango por defecto: primer inicio → fin del último que inicia
    const conInicio = GRUPOS_RAW.filter(g => g.fechaInicio instanceof Date);
    if (conInicio.length) {
      conInicio.sort((a,b) => a.fechaInicio - b.fechaInicio);
      const primero = conInicio[0];
      const ultimo  = conInicio[conInicio.length-1];
      const ini     = primero.fechaInicio;
      const fin     = ultimo.fechaFin || ultimo.fechaInicio;
      $('#totInicio').val(toInputDate(ini));
      $('#totFin').val(toInputDate(fin));
    } else {
      $('#totInicio').val('');
      $('#totFin').val('');
    }

    // Limpia UI y abre
    $('#tot-resumen').empty();
    $('#tot-tablas').empty();
    $popover.hide();
    $modalTot.show();

    // Calcular automáticamente
    renderTotales();
  }

  function renderTotales() {
    const min = $('#totInicio').val() ? new Date($('#totInicio').val() + 'T00:00:00') : null;
    const max = $('#totFin').val()    ? new Date($('#totFin').val()    + 'T23:59:59') : null;

    const lista = GRUPOS_RAW.filter(g => {
      if (!min && !max) return true;
      return overlaps(g.fechaInicio, g.fechaFin, min, max);
    });

    const cats = { '101': [], '201/202': [], '301/302/303': [] };
    for (const g of lista) {
      const idn = parseInt(String(g.identificador).replace(/[^\d]/g,''), 10);
      if (idn === 101) cats['101'].push(g);
      else if (idn === 201 || idn === 202) cats['201/202'].push(g);
      else if ([301,302,303].includes(idn)) cats['301/302/303'].push(g);
    }

    const sum = (arr, k) => arr.reduce((acc,x)=>acc+(x[k]||0),0);
    const totPax  = sum(lista,'cantidadgrupo');
    const totAdul = sum(lista,'adultos');
    const totEst  = sum(lista,'estudiantes');

    const fechasValidas = lista.flatMap(g => [g.fechaInicio, g.fechaFin]).filter(Boolean).sort((a,b)=>a-b);
    const minReal = fechasValidas[0] ? fechasValidas[0].toLocaleDateString('es-CL') : '—';
    const maxReal = fechasValidas[fechasValidas.length-1] ? fechasValidas[fechasValidas.length-1].toLocaleDateString('es-CL') : '—';

    const $res = $('#tot-resumen').empty();
    const PILL_INDEX = [];
    const $tbx = $('#tot-tablas').empty();

    const addPill = (label, arr, key) => {
      const i = PILL_INDEX.push({ key, arr }) - 1;
      $('<div class="tot-pill" data-pill="'+i+'" title="Click para ver grupos"></div>')
        .append(`<span>${label}:</span>`)
        .append(`<span>${arr.length}</span>`)
        .append('<small>grupos</small>')
        .on('click', (ev) => showPopover(ev, PILL_INDEX[i], label))
        .appendTo($res);
    };

    addPill('Identificador 101', cats['101'], 'id101');
    addPill('Identificador 201/202', cats['201/202'], 'id201_202');
    addPill('Identificador 301/302/303', cats['301/302/303'], 'id301_303');

    $('<div class="tot-pill" title="Totales de personas"></div>')
      .append(`<span>👥 Pax</span><span>${totPax}</span>`)
      .append(`<small>(Adultos ${totAdul} / Estudiantes ${totEst})</small>`)
      .appendTo($res);

    $('<div class="tot-pill" title="Rango efectivo"></div>')
      .append(`<span>🗓️ Rango</span><span>${minReal} → ${maxReal}</span>`)
      .appendTo($res);

    const mkTabla = (titulo, filas, includePax=true) => {
      const $wrap = $('<div></div>').append(`<h3 style="margin:.5rem 0;">${titulo}</h3>`);
      const $t = $(`<table><thead><tr>
        <th>${titulo}</th><th># Grupos</th>${includePax?'<th>Pax</th>':''}
      </tr></thead><tbody></tbody></table>`);
      const $tb = $t.find('tbody');
      filas.forEach(row => {
        const i = PILL_INDEX.push({ key: `${titulo}:${row.clave}`, arr: row.grupos }) - 1;
        const paxTd = includePax ? `<td>${row.pax}</td>` : '';
        $tb.append(`<tr>
          <td>${row.clave || '—'}</td>
          <td><button class="mini-link" data-pill="${i}" type="button">${row.grupos.length}</button></td>
          ${paxTd}
        </tr>`);
      });
      $t.on('click','button.mini-link', (ev) => {
        const idx = parseInt(ev.currentTarget.getAttribute('data-pill'),10);
        showPopover(ev, PILL_INDEX[idx], titulo);
      });
      $wrap.append($t);
      $tbx.append($wrap);
    };

    const groupBy = (arr, key) => {
      const map = new Map();
      for (const g of arr) {
        const k = (g[key] ?? '').toString().trim();
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(g);
      }
      return [...map.entries()].map(([clave, grupos]) => ({
        clave,
        grupos,
        pax: sum(grupos,'cantidadgrupo')
      })).sort((a,b)=> b.grupos.length - a.grupos.length);
    };

    mkTabla('Año',        groupBy(lista, 'anoViaje'));
    mkTabla('Vendedor(a)',groupBy(lista, 'vendedora'));
    mkTabla('Destino',    groupBy(lista, 'destino'));
    mkTabla('Programa',   groupBy(lista, 'programa'));
    mkTabla('Hoteles',    groupBy(lista, 'hoteles'));
    mkTabla('Transporte', groupBy(lista, 'transporte'));

    function showPopover(ev, bucket, titulo) {
      const items = (bucket?.arr || []);
      const html = `
        <h4>${titulo}</h4>
        <ul>
          ${items.map(g => `<li>
            <a href="#" class="go-row" data-num="${g.numeroNegocio}">
              ${g.numeroNegocio} — ${g.nombreGrupo}
            </a>
          </li>`).join('')}
        </ul>`;
      $popover.html(html);

      const vw = $(window).width(), vh = $(window).height();
      const w  = Math.min(420, vw - 24);
      $popover.css({ width: w + 'px' });
      const clickX = ev.pageX, clickY = ev.pageY;
      const left = Math.min(clickX + 12, window.scrollX + vw - w - 12);
      const top  = Math.min(clickY + 12, window.scrollY + vh - 24);
      $popover.css({ left: left + 'px', top: top + 'px' }).show();

      $popover.off('click', 'a.go-row').on('click', 'a.go-row', (e) => {
        e.preventDefault();
        const num = e.currentTarget.getAttribute('data-num') || '';
        let foundNode = null;
        tabla.rows().every(function(){
          const data = this.data();
          if ((data?.[0]||'').toString().trim() === num.toString().trim()) {
            foundNode = this.node();
          }
        });
        if (foundNode) {
          $('#tablaGrupos tbody tr').removeClass('highlight-row');
          $(foundNode).addClass('highlight-row')[0]
            .scrollIntoView({ behavior:'smooth', block:'center' });
        } else {
          tabla.search(num).draw();
        }
      });
    }
  }

  // Exponer funciones para handlers globales
  window.__RT_totales = {
    open: openTotales,
    render: renderTotales
  };

  // 9) Función que carga y pivota historial
  async function recargarHistorial() {
    console.group('🔄 recargarHistorial()');
    try {
      const $tabla = $('#tablaHistorial');
      if (!$tabla.length) { console.error('No encontré #tablaHistorial'); console.groupEnd(); return; }

      const q    = query(collection(db, 'historial'), orderBy('timestamp', 'desc'));
      const snap = await getDocs(q);

      const $tbH = $tabla.find('tbody').empty();
      snap.forEach((s) => {
        const d     = s.data();
        const fecha = d.timestamp?.toDate?.();
        if (!fecha) return;
        const ts  = fecha.getTime();
        $tbH.append(`
          <tr>
            <td data-timestamp="${ts}">${fecha.toLocaleString('es-CL')}</td>
            <td>${d.modificadoPor || d.usuario || ''}</td>
            <td>${d.numeroNegocio || ''}</td>
            <td>${d.accion || d.campo || ''}</td>
            <td>${d.anterior || ''}</td>
            <td>${d.nuevo || ''}</td>
          </tr>
        `);
      });

      if ($.fn.DataTable.isDataTable('#tablaHistorial')) {
        $('#tablaHistorial').DataTable().destroy();
      }
      dtHist = $('#tablaHistorial').DataTable({
        language:   { url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
        pageLength: 15,
        lengthMenu: [[15,30,50,-1],[15,30,50,'Todos']],
        order:      [[0,'desc']],
        dom:        'ltip'
      });
    } catch (err) {
      console.error('🔥 recargarHistorial() error:', err);
    }
    console.groupEnd();
  }

  // 10) Botones del Historial
  $('#btn-refresh-history').off('click').on('click', recargarHistorial);
  $('#btn-close-history').off('click').on('click', () => $('#modalHistorial').hide());
  $('#buscadorHistorial').off('input').on('input', () => dtHist.search($('#buscadorHistorial').val()).draw());

  // 12) Filtro de fechas del Historial (ext.search)
  $.fn.dataTable.ext.search.push((settings, rowData, rowIdx) => {
    if (settings.nTable.id !== 'tablaHistorial') return true;
    const cell = dtHist.row(rowIdx).node().querySelector('td[data-timestamp]');
    if (!cell) return true;
    const ts = parseInt(cell.getAttribute('data-timestamp'), 10);
    const min = $('#histInicio').val() ? new Date($('#histInicio').val()).getTime() : -Infinity;
    const max = $('#histFin').val()    ? new Date($('#histFin').val()).getTime()    : +Infinity;
    return ts >= min && ts <= max;
  });
  $('#histInicio, #histFin').off('change').on('change', () => dtHist.draw());
  
  setCargaOk(`Tabla cargada correctamente con ${valores.length} grupos.`);

  } catch (err) {
    console.error('🔥 Error general en cargarYMostrarTabla():', err);
    setCargaError(err);
  }
} // ← cierre de cargarYMostrarTabla()

// 1) Función que lee toda la tabla de DataTables y genera un Excel
function exportarGrupos() {
  // Usamos DataTables API para obtener datos tal como se muestran (filtrados, ordenados)
  const tabla = $('#tablaGrupos').DataTable();
  // Obtiene un array de arrays: cada fila en un sub-array de celdas de texto
  const rows = tabla.rows({ search: 'applied' }).data().toArray();

  // Encabezados igual a las columnas definidas en el HTML (ordenado)
  const headers = [
    "N° Negocio","Identificador","Nombre de Grupo","Año","Vendedor(a)","Coordinadores","Tel. Coord.",
    "Pax","Adultos","Estudiantes","Colegio","Curso","Destino","Programa"," Fecha Inicio","Fecha Fin",
    "Seguro Médico","Autoriz.","Hoteles","Ciudades","Transporte","Tramos","Indicaciones de la Fecha",
    "Observaciones","Creado Por","Fecha Creación"
  ];

  // Prepara un array de objetos (clave=header, valor=celda)
  const datos = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });

  // 2) Genera worksheet y workbook con SheetJS
  const ws = XLSX.utils.json_to_sheet(datos, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Grupos");

  // 3) Desencadena la descarga
  XLSX.writeFile(wb, "grupos.xlsx");
}

// 4) Asocia el botón
document
  .getElementById('btn-export-excel')
  .addEventListener('click', exportarGrupos);

// Handlers robustos (delegados) para el modal Totales
$(document).off('click.RTtot');

$(document).on('click.RTtot', '#btn-totales', function (e) {
  e.preventDefault();
  window.__RT_totales?.open();
});

$(document).on('click.RTtot', '#btn-tot-calcular', function (e) {
  e.preventDefault();
  window.__RT_totales?.render();
});

$(document).on('click.RTtot', '#btn-tot-cerrar', function (e) {
  e.preventDefault();
  $('#tot-popover').hide();
  $('#modalTotales').hide();
});

// Cerrar popover al hacer click fuera (sin cerrar el modal)
$(document).on('click.RTtot', function (e) {
  if (!$(e.target).closest('#tot-popover, .tot-pill, .mini-link').length) {
    $('#tot-popover').hide();
  }
});
