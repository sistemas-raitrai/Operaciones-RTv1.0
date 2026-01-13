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
  collection, collectionGroup, getDocs, query, where, orderBy
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

// C) Vuelos: colección "vuelos" (si tu schema difiere, ajusta campos)
const VUELOS = {
  // match grupo: por gid o numeroNegocio (o arrays legacy)
  matchGroup: ({ vuelo, gid, codigo }) => {
    const v = vuelo || {};
    const s = JSON.stringify(v).toUpperCase();
    return s.includes(String(gid).toUpperCase()) || (codigo && s.includes(String(codigo).toUpperCase()));
  },
  empresa: (v) => (v.empresa || v.aerolinea || v.airline || v.Empresa || '').toString().trim() || '(SIN EMPRESA)',
  asunto: (v) => (v.asunto || v.vuelo || v.numeroVuelo || v.tramo || v.ruta || '').toString().trim() || '(SIN ASUNTO)',
  moneda: (v) => normMoneda(v.moneda || v.currency || 'CLP'),
  monto: (v) => num(v.monto || v.valor || v.precio || v.total || 0)
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
  empresa: (ha) => (ha.hotelNombre || ha.hotel || ha.nombreHotel || '').toString().trim() || '(HOTEL)',
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
const $ = (id) => document.getElementById(id);

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
  hotelAsg: [],
  gastos: [],     // collectionGroup gastos
  rows: [],       // filas visibles con detalle
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

    const emp = VUELOS.empresa(v);
    const asu = VUELOS.asunto(v);
    const mon = VUELOS.moneda(v);
    const monto = VUELOS.monto(v);

    // En tu CSV “Valor Aéreo (CLP)” => lo dejamos como CLP (si viene USD lo convertimos a CLP)
    const clp = toCLP(monto, mon, fx);
    if (clp == null) continue;

    totalCLP += clp;
    detalles.push({
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: toUSD(monto, mon, fx),
      clp,
      fuente: `vuelos/${v.id}`
    });
  }

  return {
    etiqueta: '', // “Aéreo/s” (texto) se arma arriba
    totalCLP,
    detalles
  };
}

function calcHotel({ gid, codigo, fx, destinoGrupo }){
  const detalles = [];
  let usd = 0;
  let clp = 0;

  for (const ha of state.hotelAsg){
    if (!HOTEL.matchGroup({ ha, gid, codigo })) continue;

    const emp = HOTEL.empresa(ha);
    const asu = HOTEL.asunto(ha);
    const mon = HOTEL.moneda(ha);
    const monto = HOTEL.monto(ha);

    const _usd = toUSD(monto, mon, fx);
    const _clp = toCLP(monto, mon, fx);

    // En principal (CSV) hay Valor Hotel USD y CLP: guardamos ambos si podemos
    if (_usd != null) usd += _usd;
    if (_clp != null) clp += _clp;

    detalles.push({
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: _usd,
      clp: _clp,
      fuente: `hotelAssignments/${ha.id}`
    });
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

      detalles.push({
        empresa: emp, asunto: asu, monedaOriginal: mon,
        montoOriginal: monto,
        usd: _usd, clp: _clp,
        fuente: `Servicios/${svc.destino}/Listado/${svc.id} @ ${fecha}`
      });
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
    detalles.push({
      empresa: emp, asunto: asu, monedaOriginal: mon,
      montoOriginal: monto,
      usd: toUSD(monto, mon, fx),
      clp,
      fuente: `gastos/${g.id}`
    });
  }

  return { totalCLP, detalles };
}

function calcSeguro({ pax, destino, fx }){
  // Seguro siempre en USD (según tu explicación)
  const usd = (DESTINO.isExterior(destino) || DESTINO.isCompuesto(destino))
    ? (SEGURO.usdPorPaxExterior() * (pax || 0))
    : 0;

  const detalles = usd ? [{
    empresa: 'ASSIST CARD',
    asunto: `Seguro x ${pax || 0} pax`,
    monedaOriginal: 'USD',
    montoOriginal: usd,
    usd,
    clp: toCLP(usd, 'USD', fx),
    fuente: 'regla/seguro'
  }] : [];

  return { etiqueta: SEGURO.etiqueta(), usd, detalles };
}

function calcCoordinador({ G, fx }){
  const clp = COORD.valorCLP(G) || 0;
  const detalles = clp ? [{
    empresa: 'COORDINACIÓN',
    asunto: COORD.nombre(G) || 'COORDINADOR',
    monedaOriginal: 'CLP',
    montoOriginal: clp,
    usd: toUSD(clp, 'CLP', fx),
    clp,
    fuente: 'grupo/pagoCoordinador'
  }] : [];

  return { nombre: COORD.nombre(G) || '', clp, detalles };
}

/* =========================================================
   5) UI: modal detalle
   ========================================================= */
function openModal({ title, sub, detalles, fx }){
  $('modalTitle').textContent = title || 'Detalle';
  $('modalSub').textContent = sub || '—';

  const tb = $('modalTbl').querySelector('tbody');
  tb.innerHTML = '';

  let sumUSD = 0;
  let sumCLP = 0;

  (detalles || []).forEach(d => {
    const usd = (d.usd == null ? null : Number(d.usd));
    const clp = (d.clp == null ? null : Number(d.clp));
    if (usd != null) sumUSD += usd;
    if (clp != null) sumCLP += clp;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${esc(d.empresa)}">${esc(d.empresa)}</td>
      <td title="${esc(d.asunto)}">${esc(d.asunto)}</td>
      <td>${esc(d.monedaOriginal || '')}</td>
      <td class="cp-right">${fmtInt(d.montoOriginal || 0)}</td>
      <td class="cp-right">${usd == null ? '—' : moneyUSD(usd)}</td>
      <td class="cp-right">${clp == null ? '—' : moneyCLP(clp)}</td>
      <td class="cp-muted" title="${esc(d.fuente||'')}">${esc(d.fuente||'')}</td>
    `;
    tb.appendChild(tr);
  });

  $('modalFoot').textContent = `Total detalle: ${moneyUSD(sumUSD)} USD · ${moneyCLP(sumCLP)} CLP`;
  $('modalBack').style.display = 'flex';
}
function closeModal(){ $('modalBack').style.display = 'none'; }

function esc(s){
  return (s??'').toString().replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]
  ));
}

/* =========================================================
   6) Render tabla principal (CSV columns)
   ========================================================= */
function setStatus(msg){ $('status').textContent = msg || '—'; }
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
    tb.innerHTML = `<tr><td colspan="31" class="cp-muted">Sin resultados.</td></tr>`;
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
      <td>${esc(r['Aéreo/s'])}</td>
      <td class="cp-right" data-k="aereo">${moneyCLP(r['Valor Aéreo (CLP)'] || 0)}</td>
      <td>${esc(r['Terrestre/s'])}</td>
      <td>${esc(r['Moneda Terrestre'])}</td>
      <td class="cp-right" data-k="ter_usd">${moneyUSD(r['Valor Terrestre (USD)'] || 0)}</td>
      <td class="cp-right" data-k="ter_clp">${moneyCLP(r['Valor Terrestre (CLP)'] || 0)}</td>
      <td>${esc(r['Hotel/es'])}</td>
      <td>${esc(r['Moneda Hotel'])}</td>
      <td class="cp-right" data-k="hot_usd">${moneyUSD(r['Valor Hotel (USD)'] || 0)}</td>
      <td class="cp-right" data-k="hot_clp">${moneyCLP(r['Valor Hotel (CLP)'] || 0)}</td>
      <td>${esc(r['Moneda Actividades '])}</td>
      <td class="cp-right" data-k="act_usd">${moneyUSD(r['Actividades (USD)'] || 0)}</td>
      <td class="cp-right" data-k="act_clp">${moneyCLP(r['Actividades (CLP)'] || 0)}</td>
      <td>${esc(r['Comidas'])}</td>
      <td>${esc(r['Moneda Comidas'])}</td>
      <td class="cp-right" data-k="com_usd">${moneyUSD(r['Valor Comidas (USD)'] || 0)}</td>
      <td class="cp-right" data-k="com_clp">${moneyCLP(r['Valor Comidas (CLP)'] || 0)}</td>
      <td>${esc(r['CoordInador(a)'])}</td>
      <td class="cp-right" data-k="coord_clp">${moneyCLP(r['Valor Coordinador/a CLP'] || 0)}</td>
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
    tr.querySelector('[data-k="aereo"]').textContent = '';
    tr.querySelector('[data-k="aereo"]').appendChild(
      cellLink(
        moneyCLP(r['Valor Aéreo (CLP)'] || 0),
        ()=> openModal({
          title: `Detalle Aéreos — ${r.Grupo}`,
          sub: `${r.Destino} · ${r.Fechas}`,
          detalles: (r._det?.aereo || []),
          fx
        }),
        'Click para ver detalle'
      )
    );

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
              fx
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

    // 1) Aéreos
    const aereos = calcAereos({ gid, codigo: Codigo, fx });

    // 2) Hotel
    const hotel = calcHotel({ gid, codigo: Codigo, fx, destinoGrupo: Dest });

    // 3) Terrestre (separado desde servicios)
    const ter = calcTerrestresDesdeServicios({ G, gid, destinoGrupo: Dest, pax, fx });

    // 4) Actividades + Comidas (desde servicios)
    const ac = calcActividadesYComidas({ G, destinoGrupo: Dest, pax, fx });

    // 5) Coord (CLP)
    const coord = calcCoordinador({ G, fx });

    // 6) Gastos (CLP)
    const gastos = calcGastos({ gid, codigo: Codigo, fx });

    // 7) Seguro (USD)
    const seguro = calcSeguro({ pax, destino: Dest, fx });

    // Totales para “principal”:
    // - TOTAL USD: suma de USD + (CLP -> USD) + (BRL/ARS -> USD via toUSD ya aplicado si corresponde)
    // - TOTAL CLP: suma de CLP + (USD -> CLP)
    // Nota: tus columnas incluyen Aereo CLP (lo convertimos a USD para TOTAL USD).
    const aereoUSD = toUSD(aereos.totalCLP, 'CLP', fx) || 0;

    const totalUSD =
      aereoUSD +
      (ter.usd || 0) + (hotel.usd || 0) + (ac.actividades.usd || 0) + (ac.comidas.usd || 0) +
      (seguro.usd || 0);

    // CLP total: sumamos CLP directos + USD convertidos
    const totalCLP =
      (aereos.totalCLP || 0) +
      (ter.clp || 0) + (hotel.clp || 0) + (ac.actividades.clp || 0) + (ac.comidas.clp || 0) +
      (coord.clp || 0) + (gastos.totalCLP || 0) +
      (toCLP(seguro.usd || 0, 'USD', fx) || 0);

    // destino compuesto: solo afecta “lectura”, pero el total combinado USD ya lo estamos dando
    // (porque aereo/hotel/acts etc ya tienen ambas monedas convertidas a USD para el total)
    const det = {
      aereo: aereos.detalles,
      hotel: hotel.detalles,
      terrestre: ter.detalles,
      actividades: ac.actividades.detalles,
      comidas: ac.comidas.detalles,
      coord: coord.detalles,
      gastos: gastos.detalles,
      seguro: seguro.detalles
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

      'Aéreo/s': aereos.detalles.length ? `${aereos.detalles.length} item(s)` : '',
      'Valor Aéreo (CLP)': Math.round(aereos.totalCLP || 0),

      'Terrestre/s': ter.detalles.length ? `${ter.detalles.length} item(s)` : '',
      'Moneda Terrestre': 'USD/CLP',
      'Valor Terrestre (USD)': round2(ter.usd || 0),
      'Valor Terrestre (CLP)': Math.round(ter.clp || 0),

      'Hotel/es': hotel.detalles.length ? `${hotel.detalles.length} item(s)` : '',
      'Moneda Hotel': 'USD/CLP',
      'Valor Hotel (USD)': round2(hotel.usd || 0),
      'Valor Hotel (CLP)': Math.round(hotel.clp || 0),

      'Moneda Actividades ': 'USD/CLP',
      'Actividades (USD)': round2(ac.actividades.usd || 0),
      'Actividades (CLP)': Math.round(ac.actividades.clp || 0),

      'Comidas': ac.comidas.detalles.length ? `${ac.comidas.detalles.length} item(s)` : '',
      'Moneda Comidas': 'USD/CLP',
      'Valor Comidas (USD)': round2(ac.comidas.usd || 0),
      'Valor Comidas (CLP)': Math.round(ac.comidas.clp || 0),

      'CoordInador(a)': coord.nombre || '',
      'Valor Coordinador/a CLP': Math.round(coord.clp || 0),

      'Gastos aprob (CLP)': Math.round(gastos.totalCLP || 0),

      'Seguro ': seguro.etiqueta || '',
      'Valor Seguro (USD)': round2(seguro.usd || 0),

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
   8) Export XLSX con fórmulas (Hoja 1 + FX)
   ========================================================= */
async function exportXLSX(rows){
  try{
    // ✅ Asegura XLSX (si el <script> del HTML no cargó por CSP/adblock, lo reintenta)
    const ok = await ensureXLSX();
    if (!ok) throw new Error('XLSX no cargado (CDN bloqueado o falló la carga)');

    const XLSX = window.XLSX; // ✅ usa el global real

    const fx = getFX();
    if (!fx.usdclp) {
      alert('Para exportar con fórmulas necesitas USD→CLP (usdclp).');
      return;
    }

    // AOA principal (header exacto CSV)
    const header = [
      'Codigo','Grupo','Año','Destino','PAX (paxReales - paxLiberados)','Fechas','Cantidad Noches',
      'Aéreo/s','Valor Aéreo (CLP)',
      'Terrestre/s','Moneda Terrestre','Valor Terrestre (USD)','Valor Terrestre (CLP)',
      'Hotel/es','Moneda Hotel','Valor Hotel (USD)','Valor Hotel (CLP)',
      'Moneda Actividades ','Actividades (USD)','Actividades (CLP)',
      'Comidas','Moneda Comidas','Valor Comidas (USD)','Valor Comidas (CLP)',
      'CoordInador(a)','Valor Coordinador/a CLP','Gastos aprob (CLP)',
      'Seguro ','Valor Seguro (USD)',
      'TOTAL USD','TOTAL CLP'
    ];

    const aoa = [header];

    (rows || []).forEach(r=>{
      aoa.push(header.map(h => r[h] ?? ''));
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Hoja FX
    const fxSheet = XLSX.utils.aoa_to_sheet([
      ['FX','VALOR'],
      ['USDCLP', fx.usdclp || 0],
      ['USDBRL', fx.usdbrl || 0],
      ['USDARS', fx.usdars || 0],
    ]);
    XLSX.utils.book_append_sheet(wb, fxSheet, 'FX');

    // Poner fórmulas por fila (desde fila 2)
    for (let i=2; i<=aoa.length; i++){
      const totalUsdFormula =
        `=(I${i}/FX!$B$2)+L${i}+(M${i}/FX!$B$2)+P${i}+(Q${i}/FX!$B$2)+S${i}+(T${i}/FX!$B$2)+W${i}+(X${i}/FX!$B$2)+AC${i}`;

      const totalClpFormula =
        `=I${i}+M${i}+Q${i}+T${i}+X${i}+Z${i}+AA${i}+(L${i}*FX!$B$2)+(P${i}*FX!$B$2)+(S${i}*FX!$B$2)+(W${i}*FX!$B$2)+(AC${i}*FX!$B$2)`;

      ws[`AD${i}`] = { t:'n', f: totalUsdFormula };
      ws[`AE${i}`] = { t:'n', f: totalClpFormula };
    }

    ws['!cols'] = header.map(h => ({ wch: Math.max(10, Math.min(35, (h||'').length + 2)) }));

    XLSX.utils.book_append_sheet(wb, ws, 'Hoja 1');

    const fecha = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `Planilla_Costos_Hoja1_${fecha}.xlsx`);
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

  // destinos
  const destinos = [...new Set(state.grupos.map(g => (GRUPO.destino(g.data||{})||'').trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b,'es'));
  const selDest = $('filtroDestino');
  selDest.innerHTML = `<option value="*">TODOS</option>` + destinos.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('');
}

async function aplicar(){
  setStatus('Calculando…');
  const rows = await buildRows();
  state.rows = rows;
  render(rows);
  setKPIs({ rows, fx: getFX() });
  setStatus(`OK ✅ (${rows.length} filas). Click en cualquier monto para ver detalle.`);
}

async function boot(){
  $('modalClose').addEventListener('click', closeModal);
  $('modalBack').addEventListener('click', (e)=>{ if (e.target === $('modalBack')) closeModal(); });

  $('btnAplicar').addEventListener('click', aplicar);
  $('btnExport').addEventListener('click', async ()=> {
    await exportXLSX(state.rows || []);
  });

  // defaults
  const today = new Date().toISOString().slice(0,10);
  $('hasta').value = today;

  setStatus('Cargando datos…');

  await Promise.all([
    loadGrupos(),
    loadServicios(),
    loadVuelos(),
    loadHotelAssignments(),
    loadGastos()
  ]);

  fillFilters();

  setStatus(`Listo ✅ (grupos: ${state.grupos.length}). Define FX y presiona APLICAR.`);
  await aplicar();
}

onAuthStateChanged(auth, (user)=>{
  if (!user) return (location.href = 'login.html');
  state.user = user;
  $('who').textContent = user?.email ? `Conectado: ${user.email}` : '—';
  boot().catch(err=>{
    console.error(err);
    setStatus('Error cargando datos. Revisa consola.');
    alert('Error: ' + (err?.message || err));
  });
});
