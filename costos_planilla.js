// costos_planilla.js — Planilla “Hoja 1” en pantalla + Export XLSX con fórmulas
// ✅ Columnas EXACTAS del CSV
// ✅ Click en montos de ítems -> Modal con detalle
// ✅ Soporta destino compuesto: CLP (Chile) + USD (Exterior) en paralelo + total USD combinado
// ✅ Export XLSX con hoja FX + fórmulas por fila (SUM + conversiones)
// Requiere: firebase-init.js (exporta app/db/auth o app/db + getAuth)
// y XLSX global

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, where, orderBy,
  doc, getDoc, setDoc, updateDoc, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================================================
   0) MAPEO — ajusta aquí si tus campos difieren
   ========================================================= */

// A) Regla de “destino exterior vs Chile”
const DESTINO = {
  isChile: (dest) => U(dest).includes('CHILE'),
  // si NO es Chile => tratamos como “exterior”
  isExterior: (dest) => !U(dest).includes('CHILE'),
  // destino compuesto = contiene CHILE y además otro destino
  isCompuesto: (dest) => {
    const d = U(dest);
    return d.includes('CHILE') && (d.includes('BARILOCHE') || d.includes('BRASIL') || d.includes('ARGENT') || d.includes('URUGU') || d.includes('EXTERIOR'));
  }
};

// B) Cómo obtener datos base del grupo
const GRUPO = {
  codigo: (g) => (g.numeroNegocio || g.codigo || g.numero || g.Codigo || '').toString().trim() || g.id,
  nombre: (g) => (g.nombreGrupo || g.nombre || g.Grupo || '').toString().trim() || g.id,
  ano: (g) => Number(g.anoViaje || g.Año || g.ano || g.anio || g.ANO || new Date().getFullYear()),
  destino: (g) => (g.destino || g.Destino || '').toString().trim(),
  coordinador: (g) => (g.coordinador || g.coord || g.coordinadorEmail || g.CoordInador || '').toString().trim(),
  // PAX contable del CSV: paxReales - paxLiberados (fallback base)
  paxBase: (g) => num(g.cantidadPax || g.cantidadgrupo || g.pax || g.PAX || 0) || (num(g.adultos) + num(g.estudiantes)) || 0,
  paxReales: (g) => num(g.paxReales ?? g.paxReal ?? g.paxFinal ?? g.PAXFINAL ?? 0),
  paxLiberados: (g) => num(g.paxLiberados ?? g.liberados ?? 0),
  fechasInicio: (g) => iso(g.fechaInicio || g.inicioViaje || ''),
  fechasFin: (g) => iso(g.fechaFin || g.finViaje || ''),
};

// C) Vuelos: colección "vuelos" (ajustado a tu schema real)
const VUELOS = {
  // ✅ Match grupo: primero por grupoIds (lo más sano), si no existe, fallback por stringify
  matchGroup: ({ vuelo, gid, codigo }) => {
    const v = vuelo || {};

    // 1) grupoIds (array) recomendado
    const ids = Array.isArray(v.grupoIds) ? v.grupoIds.map(x => String(x)) : [];
    if (ids.includes(String(gid))) return true;
    if (codigo && ids.includes(String(codigo))) return true;

    // 2) fallback legacy (si hay data antigua)
    const s = JSON.stringify(v).toUpperCase();
    return s.includes(String(gid).toUpperCase()) || (codigo && s.includes(String(codigo).toUpperCase()));
  },

  // ✅ SOLO AÉREO vs TERRESTRE (si no existe, asumimos aereo)
  tipo: (v) => (v.tipoTransporte || v.tipo || v.medio || 'aereo').toString().trim().toLowerCase(),

  // ✅ Empresa real (en tu viajes.js usas "proveedor")
  empresa: (v) =>
    (v.proveedor || v.empresa || v.aerolinea || v.airline || v.Empresa || v.tramos?.[0]?.aerolinea || '')
      .toString().trim() || '(SIN EMPRESA)',

  // ✅ Asunto: si no viene, lo armamos con datos típicos
  asunto: (v) => {
    const direct = (v.asunto || v.vuelo || v.numeroVuelo || v.tramo || v.ruta || '').toString().trim();
    if (direct) return direct;

    const prov = (v.proveedor || v.tramos?.[0]?.aerolinea || '').toString().trim();
    const nume = (v.numero || v.tramos?.[0]?.numero || '').toString().trim();
    const o = (v.origen || v.tramos?.[0]?.origen || '').toString().trim();
    const d = (v.destino || v.tramos?.[0]?.destino || '').toString().trim();
    const ida = (v.fechaIda || v.tramos?.[0]?.fechaIda || '').toString().trim();

    const pn = [prov, nume].filter(Boolean).join(' ');
    const od = (o || d) ? `${o}→${d}` : '';
    return [pn, od, ida].filter(Boolean).join(' · ') || '(SIN ASUNTO)';
  },

  // ✅ Moneda + Monto: prioriza "costoMoneda/costoValor" (lo correcto),
  // y deja fallback a campos antiguos.
  moneda: (v) => normMoneda(v.costoMoneda || v.moneda || v.currency || 'CLP'),
  monto: (v) => num(
    v.costoValor ?? v.monto ?? v.valor ?? v.precio ?? v.total ?? 0
  )
};


// D) Hotel Assignments: si traen costo, usamos eso. Si no, queda 0.
const HOTEL = {
  matchGroup: ({ ha, gid, codigo }) => {
    const o = ha || {};
    const gidOK = (o.grupoId && String(o.grupoId) === String(gid));
    const docOK = (o.grupoDocId && String(o.grupoDocId) === String(gid));
    const numOK = (codigo && (String(o.grupoNumero||'') === String(codigo)));
    return gidOK || docOK || numOK;
  },
  empresa: (ha) => (ha.hotelNombre || ha.hotel || ha.nombreHotel || '').toString().trim() || '',
  asunto: (ha) => (ha.asunto || ha.regimen || ha.tipo || 'HOTEL').toString().trim(),
  moneda: (ha) => normMoneda(ha.moneda || ha.currency || 'USD'),
  monto: (ha) => num(ha.monto || ha.valor || ha.tarifaTotal || ha.total || 0)
};

// E) Servicios/Actividades/Comidas
// Usamos Servicios/{DESTINO}/Listado: {servicio, proveedor, valorServicio, moneda, tipoCobro}
// Clasificación a “Comidas” si nombre contiene keywords o categoría.
const CLASIF = {
  isComida: (svc) => {
    const n = U(svc.nombre || svc.servicio || '');
    const cat = U(svc.categoria || svc.tipo || '');
    return (
      cat.includes('COMIDA') ||
      n.includes('CENA') || n.includes('ALMUERZO') || n.includes('DESAYUNO') ||
      n.includes('COMID') || n.includes('BUFFET')
    );
  },
  // Si quieres separar “Terrestre” desde servicios:
  isTerrestre: (svc) => {
    const n = U(svc.nombre || svc.servicio || '');
    const cat = U(svc.categoria || svc.tipo || '');
    return (
      cat.includes('TERRESTRE') || cat.includes('TRASLADO') ||
      n.includes('TRANSFER') || n.includes('BUS') || n.includes('TRASLADO')
    );
  }
};

// F) Gastos aprobados: collectionGroup('gastos') con estado APROBADO o montoAprobado>0
const GASTOS = {
  isAprobado: (g) => {
    const est = U(g.estado || g.status || '');
    const tipo = U(g.tipoDoc || g.tipo || '');
    const m = num(g.montoAprobado ?? g.aprobado ?? g.monto ?? g.total ?? 0);
    if (est) return est.includes('APROB') && m > 0;
    if (tipo === 'GASTO') return m > 0;
    return m > 0;
  },
  moneda: (g) => normMoneda(g.moneda || g.currency || 'CLP'),
  monto: (g) => num(g.montoAprobado ?? g.aprobado ?? g.monto ?? g.total ?? 0),
  empresa: (g) => (g.proveedor || g.comercio || g.empresa || '').toString().trim() || '(GASTO)',
  asunto: (g) => (g.asunto || g.descripcion || g.detalle || g.glosa || '').toString().trim() || '(SIN ASUNTO)',
};

// G) Seguro: regla simple por pax (editable)
const SEGURO = {
  etiqueta: () => 'AC 150',
  // si es exterior o compuesto: seguro en USD por pax
  usdPorPaxExterior: () => 150
};

// H) Coordinador: si existe valor fijo, úsalo, sino 0.
const COORD = {
  nombre: (g) => (g.coordinador || g.coord || g.coordinadorEmail || '').toString().trim(),
  valorCLP: (g) => num(g.pagoCoordinador ?? g.coordinadorPago ?? g.finanzas?.pagoCoordinador ?? 0)
};

/* =========================================================
   1) Helpers
   ========================================================= */
const auth = getAuth(app);
// Helper seguro: no revienta si el ID no existe
const $ = (id) => document.getElementById(id);

// Setea textContent solo si el elemento existe (evita null.textContent)
function setText(id, txt){
  const el = $(id);
  if (!el) return;
  el.textContent = txt ?? '';
}


// ✅ Carga XLSX si no está disponible (Vercel/CSP/adblock a veces bloquea el script del HTML)
async function ensureXLSX(){
  if (window.XLSX) return true;

  const url = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.19.3/xlsx.full.min.js';

  const ok = await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });

  return ok && !!window.XLSX;
}

function U(s){ return (s ?? '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toUpperCase(); }
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function iso(s){
  const t = (s||'').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return '';
}
function fmtInt(n){ return (Math.round(Number(n)||0)).toLocaleString('es-CL'); }
function moneyCLP(n){ return '$' + fmtInt(n); }
function moneyUSD(n){ return '$' + (Number(n)||0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

function shortCoordName(full){
  const s = (full || '').toString().trim();
  if (!s) return '';
  const p = s.split(/\s+/).filter(Boolean);

  if (p.length <= 2) return p.join(' ');
  if (p.length === 3) return `${p[0]} ${p[1]}`; // 1 + 2
  if (p.length === 4) return `${p[0]} ${p[2]}`; // 1 + 3
  if (p.length === 5) return `${p[0]} ${p[3]}`; // 1 + 4

  // fallback 6+ (por si acaso)
  return `${p[0]} ${p[p.length - 1]}`;
}

// Resume empresas/asuntos para mostrar en la tabla (similar a costos_master.js)
function summarizeNamesFromDetalles(detalles = [], opts = {}){
  // opts.mode: 'aereo' | 'terrestre' | 'default'
  const mode = (opts.mode || 'default').toString();

  const pickLabel = (d) => {
    const empresa = (d?.empresa || '').toString().trim();
    const asunto  = (d?.asunto  || '').toString().trim();

    // 1) AÉREOS: mostrar solo la "marca" (LATAM, SKY, etc.)
    //    Preferimos empresa porque en vuelos viene limpio.
    if (mode === 'aereo') {
      if (empresa) return empresa.split(/\s+/)[0].trim(); // por si empresa trae algo extra
      if (asunto) return asunto.split(/\s+/)[0].trim();
      return '';
    }

    // 2) TERRESTRES: mostrar solo el primer tramo
    //    Ej: "SERGIO CARRASCO : COLEGIO—AEROPUERTO..." => "SERGIO CARRASCO"
    //    Soporta separadores comunes: ":" "." "·" "–" "-"
    if (mode === 'terrestre') {
      const base = (asunto || empresa || '').trim();
      if (!base) return '';
      const first =
        base.split(':')[0]
            .split('.')[0]
            .split('·')[0]
            .split('–')[0]
            .split('-')[0]
            .trim();
      return first;
    }

    // 3) DEFAULT: lo mismo que tenías (asunto o empresa completo)
    return (asunto || empresa || '').trim();
  };

  const xs = (detalles || [])
    .map(pickLabel)
    .filter(s => s && s !== '(HOTEL)' && s !== 'HOTEL');

  if (!xs.length) return '';

  const uniq = [...new Set(xs)];
  const cut = uniq.slice(0, 6);
  const txt = cut.join('\n');
  return txt + (uniq.length > 6 ? `\n…` : '');
}



function normMoneda(m){
  const M = U(m);
  if (['REAL','REALES','R$','BRL'].includes(M)) return 'BRL';
  if (['ARS','AR$','ARG','PESO ARGENTINO','PESOS ARGENTINOS'].includes(M)) return 'ARS';
  if (['USD','US$','DOLAR','DOLAR AMERICANO','DOLLAR'].includes(M)) return 'USD';
  if (['CLP','PESO CHILENO','PESOS CHILENOS','$'].includes(M)) return 'CLP';
  return (M || 'USD');
}

function inRango({ inicio, fin, fechasIt }, desde, hasta){
  if (!desde && !hasta) return true;
  const a = inicio || (fechasIt[0] || '');
  const b = fin || (fechasIt[fechasIt.length-1] || '');
  if (!a && !b) return true;
  const start = a || b;
  const end   = b || a;
  if (desde && end < desde) return false;
  if (hasta && start > hasta) return false;
  return true;
}

function getFechasGrupo(G){
  const inicio = GRUPO.fechasInicio(G);
  const fin = GRUPO.fechasFin(G);
  const it = G.itinerario || {};
  const fechasIt = Object.keys(it).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const rangoTxt = (inicio && fin) ? `${inicio} → ${fin}`
    : (fechasIt.length ? `${fechasIt[0]} → ${fechasIt[fechasIt.length-1]}` : '—');
  const noches = calcNoches({ inicio, fin, fechasIt });
  return { inicio, fin, fechasIt, rangoTxt, noches };
}
function calcNoches({ inicio, fin, fechasIt }){
  const a = inicio || (fechasIt[0] || '');
  const b = fin || (fechasIt[fechasIt.length-1] || '');
  if (!a || !b) return 0;
  const ms = (new Date(b) - new Date(a));
  const days = Math.round(ms / 86400000);
  return Math.max(0, days);
}

function paxContable(G){
  const base = GRUPO.paxBase(G);
  const reales = GRUPO.paxReales(G) > 0 ? GRUPO.paxReales(G) : base;
  const liberados = GRUPO.paxLiberados(G);
  return Math.max(0, reales - liberados);
}

/* =========================================================
   2) FX (USD pivot) — en UI inputs
   ========================================================= */
function getFX(){
  const usdclp = num($('usdclp').value || 0);
  const usdbsl = num($('usdbrl').value || 0);
  const usdars = num($('usdars').value || 0);
  return { usdclp, usdbrl: usdbsl, usdars };
}
// Convierte moneda a USD usando “USD→MONEDA”
function toUSD(amount, moneda, fx){
  const m = normMoneda(moneda);
  const a = Number(amount)||0;
  if (m === 'USD') return a;
  if (m === 'CLP' && fx.usdclp) return a / fx.usdclp;
  if (m === 'BRL' && fx.usdbrl) return a / fx.usdbrl;
  if (m === 'ARS' && fx.usdars) return a / fx.usdars;
  return null; // sin tipo de cambio
}
function toCLP(amount, moneda, fx){
  const m = normMoneda(moneda);
  const a = Number(amount)||0;
  if (m === 'CLP') return a;
  if (m === 'USD' && fx.usdclp) return a * fx.usdclp;
  if (m === 'BRL' && fx.usdclp && fx.usdbrl) return (a / fx.usdbrl) * fx.usdclp;
  if (m === 'ARS' && fx.usdclp && fx.usdars) return (a / fx.usdars) * fx.usdclp;
  return null;
}

/* =========================================================
   3) Carga data: grupos + servicios + vuelos + hotelAssignments + gastos
   ========================================================= */
const state = {
  user: null,
  grupos: [],     // [{id,data}]
  servicios: [],  // flat
  svcIndex: new Map(), // key: DEST||NAME -> svc
  vuelos: [],
  hoteles: [],
  hotelIndex: new Map(),
  hotelAsg: [],
  gastos: [],
  rows: [],

  // ✅ Overrides (cache por gid+bucket)
  overrides: new Map(), // key: `${gid}||${bucket}` -> { items: { [itemId]: {isChecked, monedaOriginal, montoOriginal, updatedBy, updatedAt} } }

  // ✅ Contexto modal para guardar
  modal: {
    gid: '',
    bucket: '',
    fx: null,
    baseDetalles: [],   // detalles ya calculados (con overrides aplicados)
    title: '',
    sub: ''
  }
};

async function loadGrupos(){
  const snap = await getDocs(collection(db, 'grupos'));
  state.grupos = snap.docs.map(d => ({ id:d.id, data:(d.data()||{}) }));
}

async function loadServicios(){
  // Servicios/{DESTINO}/Listado/*
  const root = await getDocs(collection(db, 'Servicios'));
  const prom = [];
  for (const top of root.docs){
    prom.push(
      getDocs(query(collection(top.ref, 'Listado'), orderBy('servicio','asc')))
        .then(s => s.docs.map(d => ({ id:d.id, destino: top.id, ...d.data() })))
        .catch(()=>[])
    );
  }
  const arrays = await Promise.all(prom);
  state.servicios = arrays.flat();

  state.svcIndex.clear();
  for (const s of state.servicios){
    const dest = U(s.destino || '');
    const name = U(s.servicio || s.nombre || s.id || '');
    const k = `${dest}||${name}`;
    if (!state.svcIndex.has(k)) state.svcIndex.set(k, normalizeSvc(s));
  }
}

function normalizeSvc(s){
  return {
    id: s.id,
    destino: s.destino,
    nombre: (s.servicio || s.nombre || s.id || '').toString().trim(),
    proveedor: (s.proveedor || '').toString().trim(),
    moneda: normMoneda(s.moneda || 'USD'),
    valorServicio: num(s.valorServicio ?? s.valor ?? s.precio ?? 0),
    tipoCobro: U(s.tipoCobro || ''),
    categoria: (s.categoria || s.tipo || '').toString().trim(),
    raw: s
  };
}

function findSvc({ destino, actividad }){
  const d = U(destino || '');
  const a = U(actividad || '');
  const k = `${d}||${a}`;
  if (state.svcIndex.has(k)) return state.svcIndex.get(k);

  // fallback por actividad en cualquier destino
  for (const svc of state.svcIndex.values()){
    if (U(svc.nombre) === a) return svc;
  }
  return null;
}

async function loadVuelos(){
  // Si tu colección es gigante, luego lo optimizamos con filtros.
  const snap = await getDocs(collection(db, 'vuelos'));
  state.vuelos = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function loadHoteles(){
  // ✅ Índice global para resolver nombres aunque hotelAssignments tenga solo IDs/slugs
  const snap = await getDocs(collection(db, 'hoteles'));
  state.hoteles = snap.docs.map(d => ({ id:d.id, ...d.data() }));

  state.hotelIndex.clear();
  for (const h of state.hoteles){
    const id = (h.id || '').toString().trim();
    const slug = (h.slug || h.codigo || h.code || '').toString().trim();
    const nombre = (h.nombre || h.hotel || h.nombreHotel || h.titulo || '').toString().trim();

    // index por docId
    if (id) state.hotelIndex.set(U(id), h);

    // index por slug/código
    if (slug) state.hotelIndex.set(U(slug), h);

    // index por nombre
    if (nombre) state.hotelIndex.set(U(nombre), h);
  }
}

// Intenta resolver un hotel desde cualquier “puntero” que venga en hotelAssignments
function resolveHotelFromAssignment(ha){
  if (!ha) return null;

  const candidates = [
    ha.hotelId,
    ha.hotelDocId,
    ha.hotelRefId,
    ha.hotelRef,
    ha.hotelSlug,
    ha.slugHotel,
    ha.codigoHotel,
    ha.hotelCodigo,
    ha.hotelNombre,
    ha.hotel,
    ha.nombreHotel,
    ha.nombre
  ].filter(Boolean).map(x => U(String(x)));

  for (const k of candidates){
    if (state.hotelIndex.has(k)) return state.hotelIndex.get(k);
  }

  return null;
}

async function loadHotelAssignments(){
  const snap = await getDocs(collection(db, 'hotelAssignments'));
  state.hotelAsg = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function loadGastos(){
  // Lee TODOS los gastos (staff). Si es pesado, lo optimizamos por rango/where.
  const snap = await getDocs(collectionGroup(db, 'gastos'));
  state.gastos = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

/* =========================================================
   4) Cálculo por grupo (con DETALLE por ítem)
   ========================================================= */
function calcAereos({ gid, codigo, fx }){
  const detalles = [];
  let totalCLP = 0;

  for (const v of state.vuelos){
    if (!VUELOS.matchGroup({ vuelo: v, gid, codigo })) continue;

    // ✅ SOLO AÉREO aquí
    if (VUELOS.tipo(v) !== 'aereo') continue;

    const emp = VUELOS.empresa(v);
    const asu = VUELOS.asunto(v);
    const mon = VUELOS.moneda(v);
    const monto = VUELOS.monto(v);

    // En tu CSV “Valor Aéreo (CLP)” => lo dejamos como CLP (si viene USD lo convertimos a CLP)
    const clp = toCLP(monto, mon, fx);
    if (clp == null) continue;

    totalCLP += clp;
    const det0 = {
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: toUSD(monto, mon, fx),
      clp,
      fuente: `vuelos/${v.id}`
    };
    det0.itemId = makeItemId(det0);
    detalles.push(det0);

  }

  return {
    etiqueta: '', // “Aéreo/s” (texto) se arma arriba
    totalCLP,
    detalles
  };
}

function calcTerrestresDesdeVuelos({ gid, codigo, fx }){
  const detalles = [];
  let usd = 0;
  let clp = 0;

  for (const v of state.vuelos){
    if (!VUELOS.matchGroup({ vuelo: v, gid, codigo })) continue;

    // ✅ SOLO TERRESTRE aquí
    if (VUELOS.tipo(v) !== 'terrestre') continue;

    const emp = VUELOS.empresa(v);
    const asu = VUELOS.asunto(v);
    const mon = VUELOS.moneda(v);
    const monto = VUELOS.monto(v);

    const _usd = toUSD(monto, mon, fx);
    const _clp = toCLP(monto, mon, fx);

    if (_usd != null) usd += _usd;
    if (_clp != null) clp += _clp;

    const det0 = {
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: _usd,
      clp: _clp,
      fuente: `vuelos/${v.id}`
    };
    det0.itemId = makeItemId(det0);
    detalles.push(det0);
  }

  return { usd, clp, detalles };
}


function calcHotel({ gid, codigo, fx, destinoGrupo }){
  const detalles = [];
  let usd = 0;
  let clp = 0;

  for (const ha of state.hotelAsg){
    if (!HOTEL.matchGroup({ ha, gid, codigo })) continue;

    // ✅ Primero toma lo que venga directo en assignment
    let emp = HOTEL.empresa(ha);
    const asu = HOTEL.asunto(ha);
    
    // ✅ Si no viene nombre, lo resolvemos desde colección "hoteles"
    if (!emp){
      const h = resolveHotelFromAssignment(ha);
      emp = (h?.nombre || h?.hotel || h?.nombreHotel || h?.titulo || '').toString().trim();
    }

    const mon = HOTEL.moneda(ha);
    const monto = HOTEL.monto(ha);

    const _usd = toUSD(monto, mon, fx);
    const _clp = toCLP(monto, mon, fx);

    // En principal (CSV) hay Valor Hotel USD y CLP: guardamos ambos si podemos
    if (_usd != null) usd += _usd;
    if (_clp != null) clp += _clp;

    const det0 = {
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: _usd,
      clp: _clp,
      fuente: `hotelAssignments/${ha.id}`
    };
    det0.itemId = makeItemId(det0);
    detalles.push(det0);
  }

  return { usd, clp, detalles };
}

function calcTerrestresDesdeServicios({ G, gid, destinoGrupo, pax, fx }){
  // Si no tienes terrestre en otra colección, lo separo desde “Servicios” por keywords.
  const detalles = [];
  let usd = 0;
  let clp = 0;

  const it = G.itinerario || {};
  for (const fecha of Object.keys(it)){
    const arr = Array.isArray(it[fecha]) ? it[fecha] : [];
    for (const item of arr){
      const actividad = (item.actividad || item.servicio || item.nombre || '').toString().trim();
      const destAct = (item.servicioDestino || item.destino || destinoGrupo || '').toString().trim();
      const svc = findSvc({ destino: destAct, actividad });

      if (!svc) continue;
      if (!CLASIF.isTerrestre(svc)) continue;

      const emp = svc.proveedor || '(PROVEEDOR)';
      const asu = svc.nombre;
      const mon = svc.moneda;
      const valor = num(svc.valorServicio);

      // tipoCobro simple (por persona / por grupo / por día)
      let qty = 1;
      if (svc.tipoCobro.includes('PERSONA')) qty = pax || 0;
      else if (svc.tipoCobro.includes('GRUPO')) qty = 1;
      else if (svc.tipoCobro.includes('DIA')) qty = 1;

      const monto = valor * qty;
      const _usd = toUSD(monto, mon, fx);
      const _clp = toCLP(monto, mon, fx);

      if (_usd != null) usd += _usd;
      if (_clp != null) clp += _clp;

      const det0 = {
        empresa: emp, asunto: asu, monedaOriginal: mon,
        montoOriginal: monto,
        usd: _usd, clp: _clp,
        fuente: `Servicios/${svc.destino}/Listado/${svc.id} @ ${fecha}`
      };
      det0.itemId = makeItemId(det0);
      detalles.push(det0);
    }
  }

  return { usd, clp, detalles };
}

function calcActividadesYComidas({ G, destinoGrupo, pax, fx }){
  const detActs = [];
  const detComidas = [];
  let actsUSD = 0, actsCLP = 0;
  let comUSD = 0, comCLP = 0;

  const it = G.itinerario || {};
  for (const fecha of Object.keys(it)){
    const arr = Array.isArray(it[fecha]) ? it[fecha] : [];
    for (const item of arr){
      const actividad = (item.actividad || item.servicio || item.nombre || '').toString().trim();
      const destAct = (item.servicioDestino || item.destino || destinoGrupo || '').toString().trim();
      const svc = findSvc({ destino: destAct, actividad });
      if (!svc) continue;

      const emp = svc.proveedor || '(PROVEEDOR)';
      const asu = svc.nombre;
      const mon = svc.moneda;
      const valor = num(svc.valorServicio);
      if (!valor) continue;

      // qty
      let qty = 1;
      if (svc.tipoCobro.includes('PERSONA')) qty = pax || 0;
      else if (svc.tipoCobro.includes('GRUPO')) qty = 1;
      else if (svc.tipoCobro.includes('DIA')) qty = 1;

      const monto = valor * qty;
      const _usd = toUSD(monto, mon, fx);
      const _clp = toCLP(monto, mon, fx);

      const row = {
        empresa: emp, asunto: asu, monedaOriginal: mon,
        montoOriginal: monto,
        usd: _usd, clp: _clp,
        fuente: `Servicios/${svc.destino}/Listado/${svc.id} @ ${fecha}`
      };
      row.itemId = makeItemId(row);

      if (CLASIF.isComida(svc)){
        if (_usd != null) comUSD += _usd;
        if (_clp != null) comCLP += _clp;
        detComidas.push(row);
      } else if (CLASIF.isTerrestre(svc)){
        // terrestre se calcula aparte (para no duplicar)
        continue;
      } else {
        if (_usd != null) actsUSD += _usd;
        if (_clp != null) actsCLP += _clp;
        detActs.push(row);
      }
    }
  }

  return {
    actividades: { usd: actsUSD, clp: actsCLP, detalles: detActs },
    comidas: { usd: comUSD, clp: comCLP, detalles: detComidas }
  };
}

function calcGastos({ gid, codigo, fx }){
  const detalles = [];
  let totalCLP = 0;

  // Filtrado robusto: por campos típicos
  const match = (g) => {
    const s = JSON.stringify(g).toUpperCase();
    return s.includes(String(gid).toUpperCase()) || (codigo && s.includes(String(codigo).toUpperCase()));
  };

  for (const g of state.gastos){
    if (!match(g)) continue;
    if (!GASTOS.isAprobado(g)) continue;

    const emp = GASTOS.empresa(g);
    const asu = GASTOS.asunto(g);
    const mon = GASTOS.moneda(g);
    const monto = GASTOS.monto(g);

    const clp = toCLP(monto, mon, fx);
    if (clp == null) continue;

    totalCLP += clp;
    const det0 = {
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: toUSD(monto, mon, fx),
      clp,
      fuente: `gastos/${g.id}`
    };
    det0.itemId = makeItemId(det0);
    detalles.push(det0);
  }

  return { totalCLP, detalles };
}

function calcSeguro({ pax, destino, fx }){
  // Seguro siempre en USD (según tu explicación)
  const usd = (DESTINO.isExterior(destino) || DESTINO.isCompuesto(destino))
    ? (SEGURO.usdPorPaxExterior() * (pax || 0))
    : 0;

    const detalles = usd ? (() => {
      const det0 = {
        empresa: 'ASSIST CARD',
        asunto: `Seguro x ${pax || 0} pax`,
        monedaOriginal: 'USD',
        montoOriginal: usd,
        usd,
        clp: toCLP(usd, 'USD', fx),
        fuente: 'regla/seguro'
      };
      det0.itemId = makeItemId(det0); // ✅ NUEVO
      return [det0];
    })() : [];

  return { etiqueta: SEGURO.etiqueta(), usd, detalles };
}

function calcCoordinador({ G, fx, noches, destino }) {
  // Regla:
  // - Normal: 70.000 CLP por día
  // - Excepción: "Sur de Chile y Bariloche" => 75.000 CLP por día
  // - días = noches + 1
  const DIARIO_NORMAL_CLP = 70000;
  const DIARIO_SUR_BARI_CLP = 75000;

  const dias = Math.max(0, Number(noches || 0)) + 1;

  const d = U(destino || '');
  const esSurYBari =
    d.includes('SUR') && d.includes('CHILE') && d.includes('BARILOCHE');

  const diario = esSurYBari ? DIARIO_SUR_BARI_CLP : DIARIO_NORMAL_CLP;
  const clp = diario * dias;

  const det0 = {
    empresa: 'COORDINACIÓN',
    asunto: `${esSurYBari ? 'Coordinación (Sur+Bariloche)' : 'Coordinación'} · ${dias} día(s) x $${fmtInt(diario)}`,
    monedaOriginal: 'CLP',
    montoOriginal: clp,
    usd: toUSD(clp, 'CLP', fx),
    clp,
    fuente: 'regla/coordinador'
  };
  det0.itemId = makeItemId(det0);

  const detalles = [det0];

  return {
    nombre: COORD.nombre(G) || '',
    clp,
    detalles
  };

}

/* =========================================================
   5) UI: modal detalle
   ========================================================= */
function openModal({ title, sub, detalles, fx, gid, bucket }){
  // ✅ guardar contexto modal
  state.modal.gid = String(gid || '');
  state.modal.bucket = String(bucket || '');
  state.modal.fx = fx || getFX();
  state.modal.baseDetalles = Array.isArray(detalles) ? detalles : [];
  state.modal.title = title || 'Detalle';
  state.modal.sub = sub || '—';

  $('modalTitle').textContent = state.modal.title;
  $('modalSub').textContent = state.modal.sub;

  const tb = $('modalTbl').querySelector('tbody');
  tb.innerHTML = '';

  let sumUSD = 0;
  let sumCLP = 0;

  (state.modal.baseDetalles || []).forEach((d, idx) => {
    const usd = (d.usd == null ? null : Number(d.usd));
    const clp = (d.clp == null ? null : Number(d.clp));
    if (usd != null) sumUSD += usd;
    if (clp != null) sumCLP += clp;

    const tr = document.createElement('tr');
    tr.dataset.itemId = d.itemId || makeItemId(d);
    tr.dataset.idx = String(idx);

    tr.innerHTML = `
      <td title="${esc(d.empresa)}">${esc(d.empresa)}</td>
      <td title="${esc(d.asunto)}">${esc(d.asunto)}</td>

      <!-- ✅ editable -->
      <td>
        <select class="cp-inp moneda">
          <option value="CLP" ${normMoneda(d.monedaOriginal)==='CLP'?'selected':''}>CLP</option>
          <option value="USD" ${normMoneda(d.monedaOriginal)==='USD'?'selected':''}>USD</option>
          <option value="BRL" ${normMoneda(d.monedaOriginal)==='BRL'?'selected':''}>BRL</option>
          <option value="ARS" ${normMoneda(d.monedaOriginal)==='ARS'?'selected':''}>ARS</option>
        </select>
      </td>

      <td class="cp-right">
        <input class="cp-inp monto cp-right" type="number" value="${Number(d.montoOriginal||0)}" />
      </td>

      <td class="cp-right usd">${usd == null ? '—' : moneyUSD(usd)}</td>
      <td class="cp-right clp">${clp == null ? '—' : moneyCLP(clp)}</td>

      <td class="cp-muted" title="${esc(d.fuente||'')}">${esc(d.fuente||'')}</td>

      <td class="cp-muted">${d._override ? 'REVISADO' : ''}</td>
    `;

    // ✅ al cambiar moneda/monto recalcula preview USD/CLP
    const selMon = tr.querySelector('select.moneda');
    const inpMonto = tr.querySelector('input.monto');
    const tdUsd = tr.querySelector('td.usd');
    const tdClp = tr.querySelector('td.clp');

    const recalc = ()=>{
      const fx0 = state.modal.fx || getFX();
      const mon = normMoneda(selMon.value);
      const monto = num(inpMonto.value);
      const _usd = toUSD(monto, mon, fx0);
      const _clp = toCLP(monto, mon, fx0);
      tdUsd.textContent = (_usd==null) ? '—' : moneyUSD(_usd);
      tdClp.textContent = (_clp==null) ? '—' : moneyCLP(_clp);
    };
    selMon.addEventListener('change', recalc);
    inpMonto.addEventListener('input', recalc);

    tb.appendChild(tr);
  });

  $('modalFoot').textContent = `Total detalle: ${moneyUSD(sumUSD)} USD · ${moneyCLP(sumCLP)} CLP`;

  $('modalBack').style.display = 'flex';

  // ✅ cargar historial del bucket
  loadModalHistorial().catch(()=>{});
}

function closeModal(){ $('modalBack').style.display = 'none'; }

async function loadModalHistorial(){
  const gid = state.modal.gid;
  const bucket = state.modal.bucket;
  if (!gid || !bucket) return;

  const wrap = $('modalHist');
  if (!wrap) return;

  wrap.innerHTML = `<div class="cp-muted">Cargando historial…</div>`;

  const histCol = collection(db, 'grupos', gid, 'costos_override', bucket, 'historial');
  const snap = await getDocs(query(histCol, orderBy('ts','desc'))).catch(()=>null);

  const rows = snap?.docs?.map(d => d.data()) || [];
  if (!rows.length){
    wrap.innerHTML = `<div class="cp-muted">Sin cambios registrados.</div>`;
    return;
  }

  wrap.innerHTML = rows.slice(0,20).map(h => `
    <div class="cp-hrow">
      <b>${esc(h.by || '')}</b> · <span class="cp-muted">${esc(h.when || '')}</span><br/>
      <span class="cp-muted">${esc(h.itemId||'')}</span> · ${esc(h.field||'')}:
      <b>${esc(String(h.prev||''))}</b> → <b>${esc(String(h.next||''))}</b>
    </div>
  `).join('');
}

async function saveModalEdits(){
  const gid = state.modal.gid;
  const bucket = state.modal.bucket;
  const fx0 = state.modal.fx || getFX();

  if (!gid || !bucket){
    alert('Falta contexto (gid/bucket).');
    return;
  }

  // Base actual aplicada (ya con overrides)
  const base = state.modal.baseDetalles || [];
  const tb = $('modalTbl')?.querySelector('tbody');
  if (!tb) return;

  // Carga overrides actuales (cache)
  const pack = await loadOverrides(gid, bucket);
  const ovItems = { ...(pack.items || {}) };

  const nowISO = new Date().toISOString();

  // Recorremos filas y detectamos cambios
  const trs = [...tb.querySelectorAll('tr')];
  const hist = [];

  trs.forEach(tr=>{
    const itemId = tr.dataset.itemId;
    const idx = Number(tr.dataset.idx || 0);
    const d0 = base[idx] || {};
    const monNew = normMoneda(tr.querySelector('select.moneda')?.value || d0.monedaOriginal || 'USD');
    const montoNew = num(tr.querySelector('input.monto')?.value || d0.montoOriginal || 0);

    const monPrev = normMoneda(d0.monedaOriginal || 'USD');
    const montoPrev = num(d0.montoOriginal || 0);

    const changedMon = monNew !== monPrev;
    const changedMonto = Math.abs(montoNew - montoPrev) > 0.000001;

    if (!changedMon && !changedMonto) return;

    // Guardamos override “chequeado”
    ovItems[itemId] = {
      isChecked: true,
      monedaOriginal: monNew,
      montoOriginal: montoNew,
      updatedBy: state.user?.email || '',
      updatedAt: nowISO
    };

    if (changedMon){
      hist.push({ itemId, field:'monedaOriginal', prev: monPrev, next: monNew });
    }
    if (changedMonto){
      hist.push({ itemId, field:'montoOriginal', prev: montoPrev, next: montoNew });
    }
  });

  // Si no hay cambios, no hacemos nada
  if (!hist.length){
    alert('No hay cambios para guardar.');
    return;
  }

  // Guardar doc override (merge)
  const ref = overrideDocRef(gid, bucket);
  await setDoc(ref, { items: ovItems, updatedAt: serverTimestamp(), updatedBy: state.user?.email || '' }, { merge:true });

  // Guardar historial (1 doc por cambio)
  const histCol = collection(db, 'grupos', gid, 'costos_override', bucket, 'historial');
  for (const h of hist){
    await addDoc(histCol, {
      ...h,
      by: state.user?.email || '',
      when: nowISO,
      ts: serverTimestamp()
    });
  }

  // Refrescar cache local
  state.overrides.set(`${gid}||${bucket}`, { items: ovItems });

  // Re-aplicar para que el principal cambie
  await aplicar();

  // Recargar historial en modal
  await loadModalHistorial();

  alert('Guardado ✅ (override activo).');
}

function esc(s){
  return (s??'').toString().replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]
  ));
}

/* =========================================================
   OVERRIDES (revisados/chequeados)
   Ruta:
   - Doc override: grupos/{gid}/costos_override/{bucket}  (items: map)
   - Historial:    grupos/{gid}/costos_override/{bucket}/historial
   ========================================================= */

// Hash simple estable para generar itemId desde "fuente" + empresa + asunto
function hash32(str){
  let h = 2166136261;
  for (let i=0; i<str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function makeItemId(d){
  // Fuente es lo más estable (vuelos/{id}, hotelAssignments/{id}, regla/coordinador, Servicios/...@fecha, gastos/{id})
  const key = [
    d?.fuente || '',
    d?.empresa || '',
    d?.asunto || '',
    normMoneda(d?.monedaOriginal || ''),
  ].join('||');
  return 'it_' + hash32(key);
}

function overrideDocRef(gid, bucket){
  return doc(db, 'grupos', String(gid), 'costos_override', String(bucket));
}

async function loadOverrides(gid, bucket){
  const k = `${gid}||${bucket}`;
  if (state.overrides.has(k)) return state.overrides.get(k);

  const ref = overrideDocRef(gid, bucket);
  const snap = await getDoc(ref).catch(()=>null);

  const data = snap?.exists() ? (snap.data() || {}) : {};
  const pack = { items: data.items || {} };

  state.overrides.set(k, pack);
  return pack;
}

// mode:
// - 'PARALLEL' : CLP se queda en CLP; NO-CLP (USD/BRL/ARS) se transforma a USD y NO genera CLP
// - 'CLP_ONLY' : todo se expresa solo en CLP (si no se puede convertir, queda null)
// - 'USD_ONLY' : todo se expresa solo en USD (si no se puede convertir, queda null)
// - 'BOTH'     : (legacy) calcula ambas (no lo usaremos en la planilla principal)
function applyOverrideToDetalle(det, ovItems, fx, mode='PARALLEL'){
  const itemId = det.itemId || makeItemId(det);
  const ov = ovItems?.[itemId];

  // 1) Tomar base (o override si está chequeado)
  const monBase = normMoneda((ov?.isChecked ? ov.monedaOriginal : det.monedaOriginal) || 'USD');
  const montoBase = num(ov?.isChecked ? (ov.montoOriginal ?? det.montoOriginal) : (det.montoOriginal ?? 0));

  // 2) Calcular valores según modo
  let usd = null;
  let clp = null;

  if (mode === 'CLP_ONLY'){
    clp = toCLP(montoBase, monBase, fx);
    usd = null;
  } else if (mode === 'USD_ONLY'){
    usd = toUSD(montoBase, monBase, fx);
    clp = null;
  } else if (mode === 'PARALLEL'){
    if (monBase === 'CLP'){
      clp = montoBase;          // CLP real
      usd = null;               // NO convertimos a USD en paralelo
    } else {
      usd = toUSD(montoBase, monBase, fx); // USD real (USD directo o BRL/ARS->USD)
      clp = null;                           // NO convertimos a CLP en paralelo
    }
  } else { // 'BOTH' (solo si algún día lo necesitas)
    usd = toUSD(montoBase, monBase, fx);
    clp = toCLP(montoBase, monBase, fx);
  }

  // 3) Armar retorno
  return {
    ...det,
    itemId,
    monedaOriginal: monBase,
    montoOriginal: montoBase,
    usd,
    clp,
    _override: !!(ov && ov.isChecked),
    _overrideBy: (ov && ov.isChecked) ? (ov.updatedBy || '') : '',
    _overrideAt: (ov && ov.isChecked) ? (ov.updatedAt || null) : null
  };
}


/* =========================================================
   6) Render tabla principal (CSV columns)
   ========================================================= */
function setStatus(msg){
  setText('status', msg || '—');
}
function setKPIs({ rows, fx }){
  $('kpiGrupos').textContent = String(rows.length || 0);

  const totalUSD = rows.reduce((a,r)=> a + (r.totalUSD || 0), 0);
  const totalCLP = rows.reduce((a,r)=> a + (r.totalCLP || 0), 0);
  $('kpiUsd').textContent = moneyUSD(totalUSD);
  $('kpiClp').textContent = moneyCLP(totalCLP);

  const fxTxt = fx.usdclp ? `USDCLP ${fx.usdclp}` : 'sin USDCLP';
  $('kpiFx').textContent = fxTxt;
}

function render(rows){
  const tb = $('tbl').querySelector('tbody');
  tb.innerHTML = '';

  if (!rows.length){
    tb.innerHTML = `<tr><td colspan="33" class="cp-muted">Sin resultados.</td></tr>`;
    return;
  }

  for (const r of rows){
    const tr = document.createElement('tr');

    // Helpers para “clic detalle”
    const cellLink = (txt, onClick, title='') => {
      const span = document.createElement('span');
      span.className = 'cp-link';
      span.textContent = txt;
      if (title) span.title = title;
      span.addEventListener('click', (e)=> { e.preventDefault(); e.stopPropagation(); onClick(); });
      return span;
    };

    // construir row
    tr.innerHTML = `
      <td>${esc(r.Codigo)}</td>
      <td title="${esc(r._gid)}">${esc(r.Grupo)}</td>
      <td>${esc(r['Año'])}</td>
      <td>${esc(r.Destino)}</td>
      <td class="cp-right">${fmtInt(r['PAX (paxReales - paxLiberados)'])}</td>
      <td class="cp-muted">${esc(r.Fechas)}</td>
      <td class="cp-right">${fmtInt(r['Cantidad Noches'])}</td>
    
      <!-- ✅ AHORA CLICKEABLE TAMBIÉN EL ITEM -->
      <td data-k="aereo_txt" style="white-space:pre-line">${esc(r['Aéreo/s'])}</td>
      <td class="cp-right" data-k="aereo">${moneyCLP(r['Valor Aéreo (CLP)'] || 0)}</td>
    
      <!-- ✅ TERRESTRE ITEM CLICKEABLE -->
      <td data-k="ter_txt" style="white-space:pre-line">${esc(r['Terrestre/s'])}</td>
      <td>${esc(r['Moneda Terrestre'])}</td>
      <td class="cp-right" data-k="ter_usd">${moneyUSD(r['Valor Terrestre (USD)'] || 0)}</td>
      <td class="cp-right" data-k="ter_clp">${moneyCLP(r['Valor Terrestre (CLP)'] || 0)}</td>
    
      <!-- ✅ HOTEL ITEM CLICKEABLE -->
      <td data-k="hot_txt" style="white-space:pre-line">${esc(r['Hotel/es'])}</td>
      <td>${esc(r['Moneda Hotel'])}</td>
      <td class="cp-right" data-k="hot_usd">${moneyUSD(r['Valor Hotel (USD)'] || 0)}</td>
      <td class="cp-right" data-k="hot_clp">${moneyCLP(r['Valor Hotel (CLP)'] || 0)}</td>
    
      <!-- ✅ ACTIVIDADES: nueva columna ITEMS + montos -->
      <td data-k="act_txt">${esc(r['Actividades'])}</td>
      <td>${esc(r['Moneda Actividades '])}</td>
      <td class="cp-right" data-k="act_usd">${moneyUSD(r['Actividades (USD)'] || 0)}</td>
      <td class="cp-right" data-k="act_clp">${moneyCLP(r['Actividades (CLP)'] || 0)}</td>
      
      <!-- ✅ COMIDAS (ya existía) -->
      <td data-k="com_txt">${esc(r['Comidas'])}</td>
      <td>${esc(r['Moneda Comidas'])}</td>
      <td class="cp-right" data-k="com_usd">${moneyUSD(r['Valor Comidas (USD)'] || 0)}</td>
      <td class="cp-right" data-k="com_clp">${moneyCLP(r['Valor Comidas (CLP)'] || 0)}</td>
      
      <td data-k="coord_txt" title="${esc(r['CoordInador(a)'])}">
        ${esc(shortCoordName(r['CoordInador(a)']))}
      </td>
      <td class="cp-right" data-k="coord_clp">${moneyCLP(r['Valor Coordinador/a CLP'] || 0)}</td>

      
      <!-- ✅ GASTOS: nueva columna ITEMS + monto -->
      <td data-k="gastos_txt">${esc(r['Gastos'])}</td>
      <td class="cp-right" data-k="gastos_clp">${moneyCLP(r['Gastos aprob (CLP)'] || 0)}</td>
      
      <td>${esc(r['Seguro '])}</td>
      <td class="cp-right" data-k="seg_usd">${moneyUSD(r['Valor Seguro (USD)'] || 0)}</td>
      <td class="cp-right"><b>${moneyUSD(r['TOTAL USD'] || 0)}</b></td>
      <td class="cp-right"><b>${moneyCLP(r['TOTAL CLP'] || 0)}</b></td>
    `;


    // enganchar clicks
    const fx = r._fx;
    const gid = r._gid;

    // Aereo CLP
    // ✅ ALSO: Item text columns clickeables (Aéreo/s, Terrestre/s, Hotel/es, Comidas)
    const bindItemCell = (selector, itemKey, titulo) => {
      const td = tr.querySelector(selector);
      if (!td) return;
      const text = td.textContent || '';     // ya viene con saltos por white-space
      td.textContent = '';
      td.appendChild(
      
        cellLink(
          text,
          ()=> openModal({
            title: `Detalle ${titulo} — ${r.Grupo}`,
            sub: `${r.Destino} · ${r.Fechas}`,
            detalles: (r._det?.[itemKey] || []),
            fx,
            gid: r._gid,
            bucket: itemKey
          }),
          'Click para ver detalle'
        )

      );
    };
    
    // Nota: itemKey debe coincidir con tus keys de _det
    bindItemCell('[data-k="aereo_txt"]', 'aereo', 'Aéreos');
    bindItemCell('[data-k="ter_txt"]', 'terrestre', 'Terrestres');
    bindItemCell('[data-k="hot_txt"]', 'hotel', 'Hoteles');
    
    bindItemCell('[data-k="act_txt"]', 'actividades', 'Actividades'); // ✅ NUEVO
    bindItemCell('[data-k="com_txt"]', 'comidas', 'Comidas');
    
    bindItemCell('[data-k="gastos_txt"]', 'gastos', 'Gastos');        // ✅ NUEVO
    bindItemCell('[data-k="coord_txt"]', 'coord', 'Coordinador');



    // Terrestre USD/CLP
    ['ter_usd','ter_clp','hot_usd','hot_clp','act_usd','act_clp','com_usd','com_clp','coord_clp','gastos_clp','seg_usd']
      .forEach(k => {
        const td = tr.querySelector(`[data-k="${k}"]`);
        if (!td) return;
        const valueText = td.textContent;
        td.textContent = '';

        const mapKtoItem = {
          ter_usd:'terrestre', ter_clp:'terrestre',
          hot_usd:'hotel', hot_clp:'hotel',
          act_usd:'actividades', act_clp:'actividades',
          com_usd:'comidas', com_clp:'comidas',
          coord_clp:'coord', gastos_clp:'gastos', seg_usd:'seguro'
        };
        const itemKey = mapKtoItem[k];

        td.appendChild(
          cellLink(
            valueText,
            ()=> openModal({
              title: `Detalle ${itemKey.toUpperCase()} — ${r.Grupo}`,
              sub: `${r.Destino} · ${r.Fechas}`,
              detalles: (r._det?.[itemKey] || []),
              fx,
              gid: r._gid,
              bucket: itemKey
            }),

            'Click para ver detalle'
          )
        );
      });

    tb.appendChild(tr);
  }
}

/* =========================================================
   7) Construcción de filas (según CSV)
   ========================================================= */
async function buildRows(){
  const fx = getFX();
  const q = U($('q').value || '');
  const filtroAno = $('filtroAno').value || '*';
  const filtroDestino = $('filtroDestino').value || '*';
  const desde = $('desde').value || '';
  const hasta = $('hasta').value || '';

  const rows = [];
  for (const g of state.grupos){
    const G = g.data || {};
    const gid = g.id;

    const Codigo = GRUPO.codigo({ ...G, id: gid });
    const GrupoNombre = GRUPO.nombre({ ...G, id: gid });
    const Ano = GRUPO.ano(G);
    const Dest = GRUPO.destino(G) || '—';

    // filtros
    if (filtroAno !== '*' && String(Ano) !== String(filtroAno)) continue;
    if (filtroDestino !== '*' && U(Dest) !== U(filtroDestino)) continue;

    const { inicio, fin, fechasIt, rangoTxt, noches } = getFechasGrupo(G);
    if (!inRango({ inicio, fin, fechasIt }, desde, hasta)) continue;

    if (q){
      const hay = U([Codigo, GrupoNombre, Ano, Dest, gid].join(' ')).includes(q);
      if (!hay) continue;
    }

    const pax = paxContable(G);

    const aereos = calcAereos({ gid, codigo: Codigo, fx });
    const hotel = calcHotel({ gid, codigo: Codigo, fx, destinoGrupo: Dest });
    const ter = calcTerrestresDesdeVuelos({ gid, codigo: Codigo, fx });
    const ac = calcActividadesYComidas({ G, destinoGrupo: Dest, pax, fx });
    const coord = calcCoordinador({ G, fx, noches, destino: Dest });
    const gastos = calcGastos({ gid, codigo: Codigo, fx });
    const seguro = calcSeguro({ pax, destino: Dest, fx });
    
    // ✅ aplicar overrides por bucket (manda el revisado)
    const ovA = (await loadOverrides(gid, 'aereo')).items;
    const ovT = (await loadOverrides(gid, 'terrestre')).items;
    const ovH = (await loadOverrides(gid, 'hotel')).items;
    const ovAc = (await loadOverrides(gid, 'actividades')).items;
    const ovCo = (await loadOverrides(gid, 'comidas')).items;
    const ovC = (await loadOverrides(gid, 'coord')).items;
    const ovG = (await loadOverrides(gid, 'gastos')).items;
    const ovS = (await loadOverrides(gid, 'seguro')).items;
    
    // ✅ Modos por bucket según tu regla de “bolsas”
    const detA     = aereos.detalles.map(d => applyOverrideToDetalle(d, ovA,  fx, 'CLP_ONLY'));   // Aéreo planilla: CLP
    const detT     = ter.detalles.map(d    => applyOverrideToDetalle(d, ovT,  fx, 'PARALLEL'));   // Paralelo real
    const detH     = hotel.detalles.map(d  => applyOverrideToDetalle(d, ovH,  fx, 'PARALLEL'));   // Paralelo real
    const detAct   = ac.actividades.detalles.map(d => applyOverrideToDetalle(d, ovAc, fx, 'PARALLEL')); // ✅ clave
    const detCom   = ac.comidas.detalles.map(d     => applyOverrideToDetalle(d, ovCo, fx, 'PARALLEL')); // ✅ clave
    
    const detCoord = coord.detalles.map(d  => applyOverrideToDetalle(d, ovC,  fx, 'CLP_ONLY'));   // Coordinador: CLP
    const detGastos= gastos.detalles.map(d => applyOverrideToDetalle(d, ovG,  fx, 'CLP_ONLY'));   // Gastos aprobados: CLP
    const detSeg   = seguro.detalles.map(d => applyOverrideToDetalle(d, ovS,  fx, 'USD_ONLY'));   // Seguro: USD

    
    // ✅ Totales recalculados desde detalles (si hay override, ya viene aplicado)
    const sumUSD = (arr) => (arr||[]).reduce((a,x)=> a + (x.usd==null?0:Number(x.usd)), 0);
    const sumCLP = (arr) => (arr||[]).reduce((a,x)=> a + (x.clp==null?0:Number(x.clp)), 0);
    
    // Aéreo “oficial” en tu planilla era CLP (pero total USD necesita conversion):
    const aereoCLP = sumCLP(detA);
    const aereoUSD = toUSD(aereoCLP, 'CLP', fx) || 0;
    
    const totalUSD =
      aereoUSD +
      sumUSD(detT) + sumUSD(detH) + sumUSD(detAct) + sumUSD(detCom) +
      sumUSD(detSeg);
    
    // CLP total: CLP directos + USD convertidos
    const totalCLP =
      aereoCLP +
      sumCLP(detT) + sumCLP(detH) + sumCLP(detAct) + sumCLP(detCom) +
      sumCLP(detCoord) + sumCLP(detGastos) +
      (toCLP(sumUSD(detSeg), 'USD', fx) || 0);
    
    // ✅ Reemplazamos “det” para que modal muestre lo aplicado
    const det = {
      aereo: detA,
      hotel: detH,
      terrestre: detT,
      actividades: detAct,
      comidas: detCom,
      coord: detCoord,
      gastos: detGastos,
      seguro: detSeg
    };

    rows.push({
      _gid: gid,
      _fx: fx,
      _det: det,
      Codigo,
      Grupo: GrupoNombre,
      'Año': Ano,
      Destino: Dest,
      'PAX (paxReales - paxLiberados)': pax,
      Fechas: rangoTxt,
      'Cantidad Noches': noches,

      // Aéreo: texto desde detA y monto CLP desde aereoCLP (recalculado)
      'Aéreo/s': detA.length ? summarizeNamesFromDetalles(detA, { mode:'aereo' }) : '',
      'Valor Aéreo (CLP)': Math.round(aereoCLP || 0),
      
      // Terrestre: desde detT
      'Terrestre/s': detT.length ? summarizeNamesFromDetalles(detT, { mode:'terrestre' }) : '',
      'Moneda Terrestre': 'USD/CLP',
      'Valor Terrestre (USD)': round2(sumUSD(detT)),
      'Valor Terrestre (CLP)': Math.round(sumCLP(detT)),
      
      // Hotel: desde detH
      'Hotel/es': detH.length ? summarizeNamesFromDetalles(detH) : '',
      'Moneda Hotel': 'USD/CLP',
      'Valor Hotel (USD)': round2(sumUSD(detH)),
      'Valor Hotel (CLP)': Math.round(sumCLP(detH)),
      
      // Actividades: desde detAct
      'Actividades': detAct.length ? `${detAct.length} Actividad(es)` : '',
      'Moneda Actividades ': 'USD/CLP',
      'Actividades (USD)': round2(sumUSD(detAct)),
      'Actividades (CLP)': Math.round(sumCLP(detAct)),
      
      // Comidas: desde detCom
      'Comidas': detCom.length ? `${detCom.length} item(s)` : '',
      'Moneda Comidas': 'USD/CLP',
      'Valor Comidas (USD)': round2(sumUSD(detCom)),
      'Valor Comidas (CLP)': Math.round(sumCLP(detCom)),
      
      // Coordinador: desde detCoord
      'CoordInador(a)': coord.nombre || '',
      'Valor Coordinador/a CLP': Math.round(sumCLP(detCoord)),
      
      // Gastos: desde detGastos
      'Gastos': detGastos.length ? `${detGastos.length} item(s)` : '',
      'Gastos aprob (CLP)': Math.round(sumCLP(detGastos)),
      
      // Seguro: desde detSeg
      'Seguro ': seguro.etiqueta || '',
      'Valor Seguro (USD)': round2(sumUSD(detSeg)),

      'TOTAL USD': round2(totalUSD),
      'TOTAL CLP': Math.round(totalCLP),

      // cache para KPIs
      totalUSD,
      totalCLP
    });
  }

  // orden: total USD desc
  rows.sort((a,b)=> (b.totalUSD||0) - (a.totalUSD||0));
  return rows;
}

function round2(x){
  const n = Number(x)||0;
  return Math.round(n*100)/100;
}

/* =========================================================
  7/8) funcion helper
   ========================================================= */
async function ensureXLSXLoaded(){
  if (window.XLSX) return true;

  const urls = [
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
  ];


  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('Falló carga: ' + src));
    document.head.appendChild(s);
  });

  // intenta en serie
  for (const u of urls){
    try{
      await loadScript(u);
      if (window.XLSX) return true;
    }catch(_){}
  }
  return false;
}


/* =========================================================
   8) Export XLSX con fórmulas (Hoja 1 + FX)
   ========================================================= */
function exportXLSX(rows){
  try{
    if (!window.XLSX) throw new Error('XLSX no cargado');

    const fx = getFX();
    if (!fx.usdclp) {
      alert('Para exportar con fórmulas necesitas USD→CLP (usdclp).');
      return;
    }

    // ✅ Workbook se crea UNA SOLA VEZ
    const wb = XLSX.utils.book_new();

    /* ===================================================
       1) Hoja "Costos" (PRINCIPAL) — PRIMERA hoja del libro
       =================================================== */
    const header = [
      'Codigo','Grupo','Año','Destino','PAX (paxReales - paxLiberados)','Fechas','Cantidad Noches',
      'Aéreo/s','Valor Aéreo (CLP)',
      'Terrestre/s','Moneda Terrestre','Valor Terrestre (USD)','Valor Terrestre (CLP)',
      'Hotel/es','Moneda Hotel','Valor Hotel (USD)','Valor Hotel (CLP)',
      'Actividades','Moneda Actividades ','Actividades (USD)','Actividades (CLP)',
      'Comidas','Moneda Comidas','Valor Comidas (USD)','Valor Comidas (CLP)',
      'CoordInador(a)','Valor Coordinador/a CLP',
      'Gastos','Gastos aprob (CLP)',
      'Seguro ','Valor Seguro (USD)',
      'TOTAL USD','TOTAL CLP'
    ];

    const aoaMain = [header];
    for (const r of (rows || [])){
      aoaMain.push(header.map(h => (r[h] ?? '')));
    }

    const wsMain = XLSX.utils.aoa_to_sheet(aoaMain);

    // ✅ Costos primero
    XLSX.utils.book_append_sheet(wb, wsMain, 'Costos');

    /* =========================
       2) Hoja FX (tipos de cambio)
       ========================= */
    const fxAOA = [
      ['FX','VALOR'],
      ['USDCLP', fx.usdclp || 0],
      ['USDBRL', fx.usdbrl || 0],
      ['USDARS', fx.usdars || 0],
    ];
    const fxSheet = XLSX.utils.aoa_to_sheet(fxAOA);
    XLSX.utils.book_append_sheet(wb, fxSheet, 'FX');

    /* =====================================================
       Helpers Excel: formulas por MODO (respeta “bolsas”)
       - Columnas item sheet:
         A:Codigo B:Grupo C:Año D:Destino E:Empresa F:Asunto
         G:Moneda H:MontoOriginal I:USD J:CLP K:Fuente
    
       ✅ IMPORTANTE:
       - En SheetJS (XLSX), ws[cell].f debe ir SIN "="
       - Si anidas fórmulas, jamás metas otra fórmula que empiece con "="
       ===================================================== */
    
    // Convierte cualquier moneda a USD (si FX falta, deja "")
    const usdAny = (r) =>
      `IF(G${r}="USD",H${r},` +
      `IF(G${r}="CLP",IF(FX!$B$2=0,"",H${r}/FX!$B$2),` +
      `IF(G${r}="BRL",IF(FX!$B$3=0,"",H${r}/FX!$B$3),` +
      `IF(G${r}="ARS",IF(FX!$B$4=0,"",H${r}/FX!$B$4),""))))`;
    
    // Convierte cualquier moneda a CLP (si FX falta, deja "")
    const clpAny = (r) =>
      `IF(G${r}="CLP",H${r},` +
      `IF(G${r}="USD",IF(FX!$B$2=0,"",H${r}*FX!$B$2),` +
      `IF(G${r}="BRL",IF(OR(FX!$B$2=0,FX!$B$3=0),"",(H${r}/FX!$B$3)*FX!$B$2),` +
      `IF(G${r}="ARS",IF(OR(FX!$B$2=0,FX!$B$4=0),"",(H${r}/FX!$B$4)*FX!$B$2),""))))`;
    
    // Modo PARALLEL:
    // - Si moneda=CLP => CLP lleno, USD vacío
    // - Si moneda!=CLP => USD lleno (USD o convertido), CLP vacío
    const usdParallel = (r) => `IF(G${r}="CLP","",${usdAny(r)})`;
    const clpParallel = (r) => `IF(G${r}="CLP",H${r},"")`;
    
    // Modo CLP_ONLY: solo CLP (convertido si hace falta), USD = 0
    const usdZero = (_r) => `0`;
    
    // Modo USD_ONLY: solo USD (convertido si hace falta), CLP = 0
    const usdOnly = (r) => `${usdAny(r)}`;
    const clpZero = (_r) => `0`;
    
    function addItemSheet(sheetName, items, mode='PARALLEL'){
      const aoa = [[
        'Codigo','Grupo','Año','Destino','Empresa','Asunto','Moneda','MontoOriginal','USD','CLP','Fuente'
      ]];
    
      for (const it of items){
        aoa.push([
          it.Codigo || '',
          it.Grupo || '',
          it['Año'] || '',
          it.Destino || '',
          it.empresa || '',
          it.asunto || '',
          normMoneda(it.monedaOriginal || 'USD'),
          Number(it.montoOriginal || 0),
          '', // USD formula
          '', // CLP formula
          it.fuente || ''
        ]);
      }
    
      const ws = XLSX.utils.aoa_to_sheet(aoa);
    
      // Fórmulas en I (USD) y J (CLP) desde fila 2
      for (let r=2; r<=aoa.length; r++){
        let fUsd = usdAny(r);
        let fClp = clpAny(r);
    
        if (mode === 'PARALLEL'){
          fUsd = usdParallel(r);
          fClp = clpParallel(r);
        } else if (mode === 'CLP_ONLY'){
          fUsd = usdZero(r);  // 0
          fClp = clpAny(r);   // CLP convertido si aplica
        } else if (mode === 'USD_ONLY'){
          fUsd = usdOnly(r);  // USD convertido si aplica
          fClp = clpZero(r);  // 0
        }
    
        // ✅ SIN "="
        ws[`I${r}`] = { f: fUsd };
        ws[`J${r}`] = { f: fClp };
      }
    
      ws['!cols'] = [
        {wch:12},{wch:28},{wch:8},{wch:18},{wch:22},{wch:28},
        {wch:10},{wch:16},{wch:14},{wch:14},{wch:28}
      ];
    
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    
    /* ==========================================
       3) Construir DETALLES por ítem (global)
       ========================================== */
    const all = {
      AEREOS: [],
      TERRESTRES: [],
      HOTELES: [],
      ACTIVIDADES: [],
      COMIDAS: [],
      COORD: [],
      GASTOS: [],
      SEGURO: [],
    };
    
    for (const r of (rows || [])){
      const base = { Codigo:r.Codigo, Grupo:r.Grupo, 'Año':r['Año'], Destino:r.Destino };
    
      const pushMany = (arr, dets=[]) => {
        for (const d of (dets || [])){
          arr.push({
            ...base,
            empresa: d.empresa,
            asunto: d.asunto,
            monedaOriginal: d.monedaOriginal,
            montoOriginal: d.montoOriginal,
            fuente: d.fuente
          });
        }
      };
    
      pushMany(all.AEREOS, r._det?.aereo);
      pushMany(all.TERRESTRES, r._det?.terrestre);
      pushMany(all.HOTELES, r._det?.hotel);
      pushMany(all.ACTIVIDADES, r._det?.actividades);
      pushMany(all.COMIDAS, r._det?.comidas);
      pushMany(all.COORD, r._det?.coord);
      pushMany(all.GASTOS, r._det?.gastos);
      pushMany(all.SEGURO, r._det?.seguro);
    }
    
    /* ==========================================
       4) Hojas por ítem (cada una un item)
       ========================================== */
    addItemSheet('Aereos',      all.AEREOS,      'CLP_ONLY');
    addItemSheet('Terrestres',  all.TERRESTRES,  'PARALLEL');
    addItemSheet('Hoteles',     all.HOTELES,     'PARALLEL');
    addItemSheet('Actividades', all.ACTIVIDADES, 'PARALLEL');
    addItemSheet('Comidas',     all.COMIDAS,     'PARALLEL');
    addItemSheet('Coordinador', all.COORD,       'CLP_ONLY');
    addItemSheet('Gastos',      all.GASTOS,      'CLP_ONLY');
    addItemSheet('Seguro',      all.SEGURO,      'USD_ONLY');
    
    /* ===================================================
       5) Fórmulas en "Costos" para alimentarse desde ítems
       (✅ columnas dinámicas según header)
       =================================================== */
    
    // --- Helpers de columna Excel ---
    function colLetter(n){ // 1-based -> A, B, ... Z, AA...
      let s = '';
      while (n > 0){
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    }
    function colIndex(name){
      const idx0 = header.indexOf(name);
      if (idx0 < 0) throw new Error(`Export XLSX: no existe columna "${name}" en header`);
      return idx0 + 1; // 1-based
    }
    function cell(name, row){
      return `${colLetter(colIndex(name))}${row}`;
    }
    function setF(name, row, f){
      wsMain[cell(name,row)] = { f };
    }
    
    // ✅ SUMIF SIN "="
    const sumifCLP = (sheet, row) => `SUMIF(${sheet}!$A:$A,${cell('Codigo',row)},${sheet}!$J:$J)`;
    const sumifUSD = (sheet, row) => `SUMIF(${sheet}!$A:$A,${cell('Codigo',row)},${sheet}!$I:$I)`;
    
    for (let i=2; i<=aoaMain.length; i++){
    
      setF('Valor Aéreo (CLP)', i, sumifCLP('Aereos', i));
    
      setF('Valor Terrestre (USD)', i, sumifUSD('Terrestres', i));
      setF('Valor Terrestre (CLP)', i, sumifCLP('Terrestres', i));
    
      setF('Valor Hotel (USD)', i, sumifUSD('Hoteles', i));
      setF('Valor Hotel (CLP)', i, sumifCLP('Hoteles', i));
    
      setF('Actividades (USD)', i, sumifUSD('Actividades', i));
      setF('Actividades (CLP)', i, sumifCLP('Actividades', i));
    
      setF('Valor Comidas (USD)', i, sumifUSD('Comidas', i));
      setF('Valor Comidas (CLP)', i, sumifCLP('Comidas', i));
    
      setF('Valor Coordinador/a CLP', i, sumifCLP('Coordinador', i));
      setF('Gastos aprob (CLP)', i, sumifCLP('Gastos', i));
    
      setF('Valor Seguro (USD)', i, sumifUSD('Seguro', i));
    
      // ---- Totales (SIN "=")
      const AER_CLP = cell('Valor Aéreo (CLP)', i);
    
      const TER_USD = cell('Valor Terrestre (USD)', i);
      const TER_CLP = cell('Valor Terrestre (CLP)', i);
    
      const HOT_USD = cell('Valor Hotel (USD)', i);
      const HOT_CLP = cell('Valor Hotel (CLP)', i);
    
      const ACT_USD = cell('Actividades (USD)', i);
      const ACT_CLP = cell('Actividades (CLP)', i);
    
      const COM_USD = cell('Valor Comidas (USD)', i);
      const COM_CLP = cell('Valor Comidas (CLP)', i);
    
      const COORD_CLP  = cell('Valor Coordinador/a CLP', i);
      const GASTOS_CLP = cell('Gastos aprob (CLP)', i);
    
      const SEG_USD = cell('Valor Seguro (USD)', i);
    
      const totalUsdFormula =
        `(${AER_CLP}/FX!$B$2)` +
        `+${TER_USD}+(${TER_CLP}/FX!$B$2)` +
        `+${HOT_USD}+(${HOT_CLP}/FX!$B$2)` +
        `+${ACT_USD}+(${ACT_CLP}/FX!$B$2)` +
        `+${COM_USD}+(${COM_CLP}/FX!$B$2)` +
        `+${SEG_USD}`;
    
      const totalClpFormula =
        `${AER_CLP}+${TER_CLP}+${HOT_CLP}+${ACT_CLP}+${COM_CLP}+${COORD_CLP}+${GASTOS_CLP}` +
        `+(${TER_USD}*FX!$B$2)+(${HOT_USD}*FX!$B$2)+(${ACT_USD}*FX!$B$2)+(${COM_USD}*FX!$B$2)+(${SEG_USD}*FX!$B$2)`;
    
      wsMain[cell('TOTAL USD', i)] = { f: totalUsdFormula };
      wsMain[cell('TOTAL CLP', i)] = { f: totalClpFormula };
    }

    /* ==========================
       6) Exporta archivo
       ========================== */
    const fecha = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `Planilla_Costos_${fecha}.xlsx`);

  } catch(e){
    console.error(e);
    alert('No se pudo exportar: ' + (e?.message || e));
  }
}

/* =========================================================
   9) Boot + filtros
   ========================================================= */
function fillFilters(){
  // años
  const anos = [...new Set(state.grupos.map(g => GRUPO.ano(g.data||{})).filter(Boolean))]
    .sort((a,b)=>a-b);
  const selAno = $('filtroAno');
  selAno.innerHTML = `<option value="*">TODOS</option>` + anos.map(a=>`<option value="${a}">${a}</option>`).join('');
  
  // ✅ Default: año anterior (temporada cerrada) si existe; si no, año actual; si no, TODOS
  const nowY = new Date().getFullYear();
  const prefer = String(nowY - 1);
  const current = String(nowY);
  
  const has = (val) => [...selAno.options].some(o => o.value === String(val));
  
  if (has(prefer)) selAno.value = prefer;
  else if (has(current)) selAno.value = current;
  else selAno.value = '*';


  // destinos
  const destinos = [...new Set(state.grupos.map(g => (GRUPO.destino(g.data||{})||'').trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b,'es'));
  const selDest = $('filtroDestino');
  selDest.innerHTML = `<option value="*">TODOS</option>` + destinos.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('');
}

// ✅ flags de carga pesada (se inicializan la primera vez que aplicas)
state.loaded = state.loaded || {
  servicios:false,
  vuelos:false,
  hoteles:false,
  hotelAsg:false,
  gastos:false
};

async function ensureHeavyDataLoaded(){
  // Carga solo lo que falta (una vez)
  const tasks = [];

  if (!state.loaded.servicios){ tasks.push(loadServicios().then(()=> state.loaded.servicios=true)); }
  if (!state.loaded.vuelos){ tasks.push(loadVuelos().then(()=> state.loaded.vuelos=true)); }
  if (!state.loaded.hoteles){ tasks.push(loadHoteles().then(()=> state.loaded.hoteles=true)); }
  if (!state.loaded.hotelAsg){ tasks.push(loadHotelAssignments().then(()=> state.loaded.hotelAsg=true)); }
  if (!state.loaded.gastos){ tasks.push(loadGastos().then(()=> state.loaded.gastos=true)); }

  if (!tasks.length) return; // ya está todo listo
  setStatus('Cargando datos para cálculo…');
  await Promise.all(tasks);
}

async function aplicar(){
  try{
    // ✅ 1) Cargar data pesada SOLO cuando se aplica
    await ensureHeavyDataLoaded();

    // ✅ 2) Calcular y renderizar
    setStatus('Calculando…');
    const rows = await buildRows();
    state.rows = rows;
    render(rows);
    setKPIs({ rows, fx: getFX() });

    setStatus(`OK ✅ (${rows.length} filas). Click en cualquier monto para ver detalle.`);
  }catch(e){
    console.error(e);
    setStatus('Error calculando. Revisa consola.');
    alert('Error: ' + (e?.message || e));
  }
}


async function boot(){
  $('modalClose').addEventListener('click', closeModal);

  const btnSave = $('modalSave');
  if (btnSave) btnSave.addEventListener('click', ()=> {
    saveModalEdits().catch(e=>{
      console.error(e);
      alert('Error guardando: ' + (e?.message || e));
    });
  });

  $('modalBack').addEventListener('click', (e)=>{ if (e.target === $('modalBack')) closeModal(); });

  $('btnAplicar').addEventListener('click', aplicar);
  $('btnExport').addEventListener('click', async ()=> {
    await exportXLSX(state.rows || []);
  });

  // defaults
  const today = new Date().toISOString().slice(0,10);
  $('hasta').value = today;

  setStatus('Cargando grupos…');
  
  // ✅ 1) SOLO grupos al iniciar (rápido)
  await loadGrupos();
  
  // ✅ 2) Filtros listos + año default (año actual - 1 si existe)
  fillFilters();
  
  // ✅ 3) NO calculamos automáticamente
  setStatus(`Listo ✅ (grupos: ${state.grupos.length}). Ajusta filtros y presiona APLICAR.`);

}

onAuthStateChanged(auth, (user)=>{
  if (!user) return (location.href = 'login.html');
  state.user = user;

  // ✅ no revienta si el HTML no tiene #who
  setText('who', user?.email ? `Conectado: ${user.email}` : '—');

  boot().catch(err=>{
    console.error(err);
    setStatus('Error cargando datos. Revisa consola.');
    alert('Error: ' + (err?.message || err));
  });
});
