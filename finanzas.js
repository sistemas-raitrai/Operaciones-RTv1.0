// finanzas.js — Finanzas Operaciones RT
// =====================================================================================
// - Equivalencias en USD/BRL/ARS/CLP (pivote CLP) con TC actuales (inputs de cabecera)
// - Modal por proveedor:
//    • Resumen por servicio (totales eq.) con "Ver detalle"
//    • Detalle fila a fila; moneda nativa en NARANJO
//    • Sección ABONOS por servicio: responsable (email), estado (ORIGINAL/EDITADO/ARCHIVADO),
//      acciones (VER COMPROBANTE / EDITAR / ARCHIVAR), buscador y ver archivados.
//    • Totales en negrita. SALDO POR PAGAR en rojo si ≠ 0.
//    • Exportar a EXCEL (formato HTML compatible con Excel).
// - Ruta de abonos: Servicios/{DESTINO}/Listado/{SERVICIO}/Abonos/*
//   Guarda snapshot de TC, responsable y auditoría.

// Firebase
import { app, db } from './firebase-init.js';
import {
  collection, getDocs, addDoc, updateDoc, doc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

// -------------------------------
// 0) Rutas raíz
// -------------------------------
const RUTA_SERVICIOS  = 'Servicios';
const RUTA_PROV_ROOT  = 'Proveedores';
const RUTA_HOTEL_ROOT = 'Hoteles';
const RUTA_GRUPOS     = 'grupos';

// -------------------------------
// 1) Estado + helpers
// -------------------------------
const auth = getAuth(app);
const storage = getStorage(app);

let GRUPOS = [];
let SERVICIOS = [];    // [{id, destino, servicio, ...}]
let PROVEEDORES = {};
let HOTELES = [];
let ASIGNACIONES = [];

let LINE_ITEMS = []; // actividades
let LINE_HOTEL = []; // hoteles

const el    = id => document.getElementById(id);
const $     = (sel, root=document) => root.querySelector(sel);
const $$    = (sel, root=document) => [...root.querySelectorAll(sel)];
const fmt   = n => (n ?? 0).toLocaleString('es-CL');
const money = n => '$' + fmt(Math.round(n || 0));
const slug  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');
const norm  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();

// Moneda nativa → estándar
function normalizarMoneda(m){
  const M = (m||'').toString().toUpperCase().trim();
  if (['REAL','REALES','R$','BRL'].includes(M)) return 'BRL';
  if (['ARS','AR$','ARG','PESO ARGENTINO','PESOS ARGENTINOS','ARGENTINOS','ARGENTINO'].includes(M)) return 'ARS';
  if (['USD','US$','DOLAR','DÓLAR','DOLLAR'].includes(M)) return 'USD';
  return 'CLP';
}
function paxDeGrupo(g) {
  const a = Number(g.adultos || g.ADULTOS || 0);
  const e = Number(g.estudiantes || g.ESTUDIANTES || 0);
  const cg = Number(g.cantidadgrupo || g.CANTIDADGRUPO || g.pax || g.PAX || 0);
  return (a + e) || cg || 0;
}
function within(dateISO, d1, d2) {
  if (!dateISO) return false;
  const t  = new Date(dateISO + 'T00:00:00').getTime();
  const t1 = d1 ? new Date(d1 + 'T00:00:00').getTime() : -Infinity;
  const t2 = d2 ? new Date(d2 + 'T00:00:00').getTime() : Infinity;
  return t >= t1 && t <= t2;
}

// TC actuales (desde inputs)
function pickTC(moneda) {
  const m   = normalizarMoneda(moneda);
  const usd = Number(el('tcUSD')?.value || 0);
  const brl = Number(el('tcBRL')?.value || 0);
  const ars = Number(el('tcARS')?.value || 0);
  if (m === 'CLP') return 1;
  if (m === 'USD') return usd > 0 ? usd : null;
  if (m === 'BRL') return brl > 0 ? brl : null;
  if (m === 'ARS') return ars > 0 ? ars : null;
  return null;
}

/** Convierte monto desde su moneda nativa a USD/BRL/ARS/CLP (pivote CLP) con TC actuales. */
function convertirTodas(monedaOrigen, monto){
  const from = normalizarMoneda(monedaOrigen);
  const tcFrom = pickTC(from);
  const tcUSD  = pickTC('USD');
  const tcBRL  = pickTC('BRL');
  const tcARS  = pickTC('ARS');

  const totalCLP = (from === 'CLP')
    ? (monto ?? null)
    : (tcFrom ? (monto * tcFrom) : null);

  const conv = { USD:null, BRL:null, ARS:null, CLP: totalCLP };
  const toTarget = (tcTarget) => (totalCLP != null && tcTarget) ? (totalCLP / tcTarget) : null;

  conv.USD = (from === 'USD') ? (monto ?? null) : toTarget(tcUSD);
  conv.BRL = (from === 'BRL') ? (monto ?? null) : toTarget(tcBRL);
  conv.ARS = (from === 'ARS') ? (monto ?? null) : toTarget(tcARS);
  return conv;
}

// -------------------------------
// 2) Carga de datos
// -------------------------------
async function loadServicios() {
  const rootSnap = await getDocs(collection(db, RUTA_SERVICIOS));
  const promSub = [];
  for (const docTop of rootSnap.docs) {
    const destinoId = docTop.id;
    promSub.push(
      getDocs(collection(docTop.ref, 'Listado'))
        .then(snap => snap.docs.map(d => {
          const data = d.data() || {};
          return { id: d.id, destino: destinoId, servicio: data.servicio || d.id, ...data };
        }))
        .catch(() => [])
    );
  }
  const arrays = await Promise.all(promSub);
  SERVICIOS = arrays.flat();
}
async function loadProveedores() {
  PROVEEDORES = {};
  try {
    const rootSnap = await getDocs(collection(db, RUTA_PROV_ROOT));
    const promSub = [];
    for (const docTop of rootSnap.docs) {
      promSub.push(
        getDocs(collection(docTop.ref, 'Listado'))
          .then(snap => snap.docs.map(d => ({ id:d.id, ...d.data() })))
          .catch(() => [])
      );
    }
    const arrays = await Promise.all(promSub);
    arrays.flat().forEach(d => {
      const key = slug(d.proveedor || d.nombre || d.id);
      PROVEEDORES[key] = { ...d };
    });
  } catch (e) {
    console.warn('Proveedores no disponibles:', e);
  }
}
async function loadGrupos() {
  const snap = await getDocs(collection(db, RUTA_GRUPOS));
  GRUPOS = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadHotelesYAsignaciones() {
  HOTELES = []; ASIGNACIONES = [];
  try {
    const rootSnap = await getDocs(collection(db, RUTA_HOTEL_ROOT));
    const promListado = [], promAsign = [];
    for (const docTop of rootSnap.docs) {
      const destinoId = docTop.id;
      promListado.push(
        getDocs(collection(docTop.ref, 'Listado'))
          .then(snap => snap.docs.map(d => ({ id:d.id, destino:destinoId, ...d.data() })))
          .catch(() => [])
      );
      promAsign.push(
        getDocs(collection(docTop.ref, 'Asignaciones'))
          .then(snap => snap.docs.map(d => ({ id:d.id, destino:destinoId, ...d.data() })))
          .catch(() => [])
      );
    }
    const [arrH, arrA] = await Promise.all([Promise.all(promListado), Promise.all(promAsign)]);
    HOTELES = arrH.flat();
    ASIGNACIONES = arrA.flat();
  } catch (e) {
    console.warn('Hoteles/Asignaciones no disponibles:', e);
  }
}

// -------------------------------
// 3) Resolver Servicio
// -------------------------------
function resolverServicio(itemActividad, destinoGrupo) {
  const act    = norm(itemActividad?.actividad || itemActividad?.servicio || '');
  const dest   = norm(destinoGrupo || '');
  const provIt = norm(itemActividad?.proveedor || '');

  let cand = SERVICIOS.filter(s =>
    norm(s.servicio) === act &&
    norm(s.destino || s.DESTINO || s.ciudad || s.CIUDAD) === dest
  );
  if (cand.length === 0) cand = SERVICIOS.filter(s => norm(s.servicio) === act);
  if (cand.length > 1 && provIt) {
    const afin = cand.filter(s => norm(s.proveedor) === provIt);
    if (afin.length) cand = afin;
  }
  return cand[0] || null;
}

// -------------------------------
// 4) Construcción de line items
// -------------------------------
function construirLineItems(fechaDesde, fechaHasta, destinosSel, incluirActividades) {
  const out = [];
  if (!incluirActividades) return out;

  for (const g of GRUPOS) {
    const destinoGrupo = g.destino || g.DESTINO || g.ciudad || '';
    if (destinosSel.size && !destinosSel.has(destinoGrupo)) continue;

    const pax = paxDeGrupo(g);
    const it  = g.itinerario || {};

    for (const fechaISO of Object.keys(it)) {
      if (!within(fechaISO, fechaDesde, fechaHasta)) continue;
      const arr = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];

      for (const item of arr) {
        const svc = resolverServicio(item, destinoGrupo);

        // Sin tarifario → ítem neutro
        if (!svc) {
          out.push({
            tipo:'actividad',
            proveedor: item.proveedor || '(desconocido)',
            proveedorSlug: slug(item.proveedor || '(desconocido)'),
            servicio: item.actividad || item.servicio || '(sin nombre)',
            servicioId: null,
            destinoGrupo, fecha: fechaISO,
            grupoId: g.id, nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
            numeroNegocio: g.numeroNegocio || g.id,
            identificador: g.identificador || g.IDENTIFICADOR || '',
            pax, moneda:'CLP', tarifa:0,
            pagoTipo:'por_grupo', pagoFrecuencia:'unitario',
            totalMoneda:0,
          });
          continue;
        }

        const proveedor     = svc.proveedor || '(sin proveedor)';
        const moneda        = normalizarMoneda(svc.moneda || svc.MONEDA || 'CLP');
        const tipoCobroRaw  = (svc.tipoCobro || svc.tipo_cobro || '').toString().toUpperCase();
        const esPorPersona  = tipoCobroRaw.includes('PERSONA') || tipoCobroRaw.includes('PAX');
        const valor         = Number(svc.valorServicio ?? svc.valor_servicio ?? svc.valor ?? svc.precio ?? 0);

        const multiplicador = esPorPersona ? pax : 1;
        const totalMoneda   = valor * multiplicador;

        out.push({
          tipo:'actividad',
          proveedor, proveedorSlug:slug(proveedor),
          servicio: svc.servicio || item.actividad || '(sin nombre)',
          servicioId: svc.id,             // <-- para ubicar Abonos
          destinoGrupo, fecha: fechaISO,
          grupoId: g.id, nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
          numeroNegocio: g.numeroNegocio || g.id,
          identificador: g.identificador || g.IDENTIFICADOR || '',
          pax, moneda, tarifa: valor,
          pagoTipo: esPorPersona ? 'por_pax' : 'por_grupo',
          pagoFrecuencia:'unitario',
          totalMoneda,
        });
      }
    }
  }
  return out;
}
function construirLineItemsHotel(fechaDesde, fechaHasta, destinosSel, incluirHoteles) {
  const out = [];
  if (!incluirHoteles || !ASIGNACIONES.length) return out;

  const mapHotel = {}; for (const h of HOTELES) mapHotel[h.id] = h;

  for (const asg of ASIGNACIONES) {
    const g = GRUPOS.find(x => x.id === (asg.grupoId || asg.idGrupo));
    if (!g) continue;

    const destinoGrupo = g.destino || asg.destino || '';
    if (destinosSel.size && !destinosSel.has(destinoGrupo)) continue;

    const start = asg.fechaInicio, end = asg.fechaFin;
    if (!start || !end) continue;

    // noches dentro del rango
    const nights = [];
    let cur = new Date(start + 'T00:00:00');
    const fin = new Date(end + 'T00:00:00');
    while (cur < fin) {
      const iso = cur.toISOString().slice(0,10);
      if (within(iso, fechaDesde, fechaHasta)) nights.push(iso);
      cur.setDate(cur.getDate()+1);
    }

    const hotel = mapHotel[asg.hotelId] || {};
    const hotelNombre = hotel.nombre || asg.hotelNombre || '(hotel)';

    const pax       = paxDeGrupo(g);
    const moneda    = normalizarMoneda(asg.moneda || hotel.moneda || 'CLP');
    const tarifa    = Number(asg.tarifa || hotel.tarifa || 0);
    const tipoCobro = (asg.tipoCobro || hotel.tipoCobro || 'por_pax_noche').toLowerCase();

    let totalPorNoche = 0;
    if (tipoCobro === 'por_pax_noche') totalPorNoche = tarifa * pax;
    else if (tipoCobro === 'por_grupo_noche') totalPorNoche = tarifa;
    else if (tipoCobro === 'por_hab_noche') totalPorNoche = tarifa;

    const totalMoneda = totalPorNoche * nights.length;

    out.push({
      tipo:'hotel',
      hotel:hotelNombre, destinoGrupo,
      grupoId:g.id, nombreGrupo:g.nombreGrupo || '',
      numeroNegocio:g.numeroNegocio || g.id,
      identificador:g.identificador || g.IDENTIFICADOR || '',
      noches:nights.length,
      moneda, tarifa, tipoCobro,
      totalMoneda,
    });
  }
  return out;
}

// -------------------------------
// 5) Agregaciones (sumamos EQUIVALENTES)
// -------------------------------
function agruparPorDestino(items) {
  const r = new Map();
  for (const it of items) {
    const key = it.destinoGrupo || it.destino || '(sin destino)';
    const acc = r.get(key) || { clpEq:0, usdEq:0, brlEq:0, arsEq:0, count:0 };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq += conv.USD;
    if (conv.BRL != null) acc.brlEq += conv.BRL;
    if (conv.ARS != null) acc.arsEq += conv.ARS;
    acc.count++;
    r.set(key, acc);
  }
  return r;
}
function agruparPorProveedor(items) {
  const r = new Map();
  for (const it of items) {
    const slugProv = it.proveedorSlug || slug(it.proveedor || '(sin proveedor)');
    const nombre   = it.proveedor || '(sin proveedor)';
    const acc = r.get(slugProv) || { nombre, destinos:new Set(), clpEq:0, usdEq:0, brlEq:0, arsEq:0, count:0, items:[] };
    acc.destinos.add(it.destinoGrupo || '(sin destino)');
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq += conv.USD;
    if (conv.BRL != null) acc.brlEq += conv.BRL;
    if (conv.ARS != null) acc.arsEq += conv.ARS;
    acc.count++;
    acc.items.push(it);
    r.set(slugProv, acc);
  }
  return r;
}
function agruparPorHotel(itemsHotel) {
  const r = new Map();
  for (const it of itemsHotel) {
    const key = it.hotel || '(hotel)';
    const acc = r.get(key) || { destino: it.destinoGrupo || '(sin destino)', clpEq:0, usdEq:0, brlEq:0, arsEq:0, noches:0 };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq += conv.USD;
    if (conv.BRL != null) acc.brlEq += conv.BRL;
    if (conv.ARS != null) acc.arsEq += conv.ARS;
    acc.noches += (it.noches || 0);
    r.set(key, acc);
  }
  return r;
}

// -------------------------------
// 6) Render KPIs + tablas
// -------------------------------
function renderKPIs(items, itemsHotel) {
  const all = [...items, ...itemsHotel];
  let totCLP = 0, missUSD = 0, missBRL = 0, missARS = 0;
  for (const it of all){
    const c = convertirTodas(it.moneda, it.totalMoneda);
    if (c.CLP != null) totCLP += c.CLP;
    if (c.USD == null) missUSD += (it.totalMoneda || 0);
    if (c.BRL == null) missBRL += (it.totalMoneda || 0);
    if (c.ARS == null) missARS += (it.totalMoneda || 0);
  }
  el('kpiTotCLP').textContent = money(totCLP);
  el('kpiOtrosMon').textContent = `USD no conv.: ${fmt(missUSD)} — BRL no conv.: ${fmt(missBRL)} — ARS no conv.: ${fmt(missARS)}`;

  const provSet = new Set(items.filter(x => x.tipo==='actividad').map(x => x.proveedorSlug));
  el('kpiProv').textContent = provSet.size;

  const destSet = new Set(items.map(x => x.destinoGrupo).filter(Boolean));
  el('kpiDest').textContent = destSet.size;
}
function renderTablaDestinos(mapDest) {
  const tb = el('tblDestinos').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [];
  mapDest.forEach((v, k) => rows.push({
    destino:k,
    clpEq:v.clpEq||0, usdEq:v.usdEq||0, brlEq:v.brlEq||0, arsEq:v.arsEq||0,
    count:v.count||0
  }));
  rows.sort((a,b)=>b.clpEq - a.clpEq);
  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.destino}">${r.destino || '(sin destino)'}</td>
        <td class="right" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
      </tr>
    `);
  }
}
function renderTablaProveedores(mapProv) {
  const tb = el('tblProveedores').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [];
  mapProv.forEach((v, key) => rows.push({
    slug:key, nombre:v.nombre, destinos:[...v.destinos].join(', '),
    clpEq:v.clpEq||0, usdEq:v.usdEq||0, brlEq:v.brlEq||0, arsEq:v.arsEq||0,
    count:v.count||0, items:v.items
  }));
  rows.sort((a,b)=>b.clpEq - a.clpEq);

  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.nombre}">${r.nombre}</td>
        <td title="${r.destinos}">${r.destinos}</td>
        <td class="right" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
        <td class="right">
          <button class="btn secondary" data-prov="${r.slug}">Ver detalle</button>
        </td>
      </tr>
    `);
  }

  tb.querySelectorAll('button[data-prov]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slugProv = btn.getAttribute('data-prov');
      openModalProveedor(slugProv, mapProv.get(slugProv));
    });
  });
}
function renderTablaHoteles(mapHoteles) {
  const tb = el('tblHoteles').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [];
  mapHoteles.forEach((v,k)=>rows.push({
    hotel:k, destino:v.destino,
    clpEq:v.clpEq||0, usdEq:v.usdEq||0, brlEq:v.brlEq||0, arsEq:v.arsEq||0,
    noches:v.noches||0
  }));
  rows.sort((a,b)=>b.clpEq - a.clpEq);
  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.hotel}">${r.hotel}</td>
        <td title="${r.destino || ''}">${r.destino || ''}</td>
        <td class="right" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.noches}">${fmt(r.noches)}</td>
      </tr>
    `);
  }
}

// -------------------------------
// 7) Modal — Abonos helpers
// -------------------------------
function abonoEquivalentes(ab) {
  // usar TC actuales para equivalencias del abono (snapshot solo para auditoría)
  return convertirTodas(ab.moneda, Number(ab.monto || 0));
}
function abonoEstadoLabel(ab) {
  return (ab.estado || 'ORIGINAL').toUpperCase();
}
function abonoIncluido(ab) {
  return (ab.estado || 'ORIGINAL') !== 'ARCHIVADO';
}
function nowISODate() {
  const d = new Date();
  return d.toISOString().slice(0,10);
}
function currentTCSnapshot() {
  return {
    USD: Number(el('tcUSD')?.value || 0) || null,
    BRL: Number(el('tcBRL')?.value || 0) || null,
    ARS: Number(el('tcARS')?.value || 0) || null,
  };
}

// Cargar/guardar abonos de un servicio
async function loadAbonos(destinoId, servicioId) {
  const col = collection(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos`);
  const snap = await getDocs(col);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function guardarAbono({ destinoId, servicioId, abonoId, data, file }) {
  // Subir comprobante (opcional)
  let comprobanteURL = data.comprobanteURL || null;
  if (file) {
    const ref = storageRef(storage, `abonos/${destinoId}/${servicioId}/${Date.now()}_${file.name}`);
    await uploadBytes(ref, file);
    comprobanteURL = await getDownloadURL(ref);
  }

  const email = (auth.currentUser?.email || '').toLowerCase();
  const base = {
    servicioId,
    fecha: data.fecha || nowISODate(),
    moneda: normalizarMoneda(data.moneda || 'CLP'),
    monto: Number(data.monto || 0),
    nota: data.nota || '',
    comprobanteURL: comprobanteURL || '',
    estado: data.estado || 'ORIGINAL',
    tcSnapshot: currentTCSnapshot(),
  };

  if (!abonoId) {
    await addDoc(collection(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos`), {
      ...base,
      createdAt: serverTimestamp(),
      createdByEmail: email,
      version: 1,
      historial: [],
    });
  } else {
    const docRef = doc(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos/${abonoId}`);
    await updateDoc(docRef, {
      ...base,
      updatedAt: serverTimestamp(),
      updatedByEmail: email,
      estado: (data.estado || 'EDITADO'),
      version: (Number(data.version || 1) + 1),
    });
  }
}
async function archivarAbono({ destinoId, servicioId, abonoId }) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const docRef = doc(db, `${RUTA_SERVICIOS}/${destinoId}/Listado/${servicioId}/Abonos/${abonoId}`);
  await updateDoc(docRef, {
    estado: 'ARCHIVADO',
    archivedAt: serverTimestamp(),
    archivedByEmail: email,
  });
}

// -------------------------------
// 8) Modal — UI
// -------------------------------
function buildModalShell() {
  const cont = $('.fin-modal-body', el('modal'));
  cont.innerHTML = `
    <div class="modal-toolbar">
      <input id="modalSearch" type="search" placeholder="BUSCAR EN ABONOS Y DETALLE…" />
      <label class="switch">
        <input type="checkbox" id="chkVerArchivados" />
        <span>VER ARCHIVADOS</span>
      </label>
      <div class="spacer"></div>
      <button class="btn btn-excel" id="btnExportXLS">EXPORTAR EXCEL</button>
      <button class="btn" id="btnAbonar">ABONAR</button>
    </div>

    <div class="scroll-x" style="margin-bottom:.5rem;">
      <table class="fin-table upper" id="tblProvResumen">
        <thead>
          <tr>
            <th>SERVICIO</th>
            <th class="right">CLP</th>
            <th class="right">USD</th>
            <th class="right">BRL</th>
            <th class="right">ARS</th>
            <th class="right"># ÍTEMS</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <section class="panel abonos-panel">
      <div class="abonos-header upper">
        <span><b>ABONOS</b></span>
      </div>
      <div class="scroll-x">
        <table class="fin-table upper" id="tblAbonos">
          <thead>
            <tr>
              <th>SERVICIO</th>
              <th>RESPONSABLE</th>
              <th>FECHA</th>
              <th>MONEDA</th>
              <th class="right">MONTO</th>
              <th class="right">CLP</th>
              <th class="right">USD</th>
              <th class="right">BRL</th>
              <th class="right">ARS</th>
              <th>NOTA</th>
              <th>COMPROBANTE</th>
              <th>ACCIONES</th>
              <th>ESTADO</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot>
            <tr class="bold">
              <th colspan="5" class="right">TOTALES</th>
              <th id="abTotCLP" class="right">$0</th>
              <th id="abTotUSD" class="right">0</th>
              <th id="abTotBRL" class="right">0</th>
              <th id="abTotARS" class="right">0</th>
              <th colspan="4"></th>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <section class="panel">
      <h4 class="upper bold">SALDO POR PAGAR</h4>
      <div class="scroll-x">
        <table class="fin-table upper" id="tblSaldo">
          <thead>
            <tr>
              <th></th>
              <th class="right">CLP</th>
              <th class="right">USD</th>
              <th class="right">BRL</th>
              <th class="right">ARS</th>
            </tr>
          </thead>
          <tbody>
            <tr class="bold">
              <td>SALDO TOTAL</td>
              <td id="saldoCLP" class="right">$0</td>
              <td id="saldoUSD" class="right">0</td>
              <td id="saldoBRL" class="right">0</td>
              <td id="saldoARS" class="right">0</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="scroll-x">
      <table class="fin-table upper" id="tblDetalleProv">
        <thead>
          <tr>
            <th>FECHA</th>
            <th>NEGOCIO-ID</th>
            <th>GRUPO</th>
            <th>SERVICIO</th>
            <th class="right">PAX</th>
            <th>MODALIDAD</th>
            <th>MONEDA</th>
            <th class="right">TARIFA</th>
            <th class="right">USD</th>
            <th class="right">BRL</th>
            <th class="right">ARS</th>
            <th class="right">CLP</th>
          </tr>
        </thead>
        <tbody></tbody>
        <tfoot>
          <tr class="bold">
            <th colspan="11" class="right">TOTAL CLP</th>
            <th id="modalTotalCLP" class="right">$0</th>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Submodal Abono -->
    <div id="submodalAbono" class="submodal" hidden>
      <div class="card">
        <header class="upper bold">ABONO</header>
        <div class="grid">
          <label>FECHA
            <input type="date" id="abFecha" />
          </label>
          <label>MONEDA
            <select id="abMoneda">
              <option>CLP</option><option>USD</option><option>BRL</option><option>ARS</option>
            </select>
          </label>
          <label>MONTO
            <input type="number" id="abMonto" step="0.01" />
          </label>
          <label>NOTA
            <input type="text" id="abNota" maxlength="140" />
          </label>
          <label>COMPROBANTE (IMAGEN/PDF)
            <input type="file" id="abFile" accept="image/*,application/pdf" />
          </label>
        </div>
        <footer>
          <button class="btn secondary" id="abCancelar">CANCELAR</button>
          <button class="btn" id="abGuardar">GUARDAR</button>
        </footer>
      </div>
    </div>
  `;
  return cont;
}
function paintSaldoCells({ clp, usd, brl, ars }) {
  const neg = (v) => v && Math.abs(v) > 0.0001;
  const set = (id, val, isMoney=false) => {
    const cell = el(id);
    cell.textContent = isMoney ? money(val||0) : fmt(val||0);
    cell.classList.toggle('saldo-rojo', neg(val));
  };
  set('saldoCLP', clp, true);
  set('saldoUSD', usd);
  set('saldoBRL', brl);
  set('saldoARS', ars);
}

// -------------------------------
// 9) Modal — Abrir
// -------------------------------
function agruparItemsPorServicio(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.servicio || '(sin nombre)';
    const acc = map.get(key) || { usdEq:0, brlEq:0, arsEq:0, clpEq:0, count:0, items:[], servicioId: it.servicioId || null };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpEq += conv.CLP;
    if (conv.USD != null) acc.usdEq  += conv.USD;
    if (conv.BRL != null) acc.brlEq  += conv.BRL;
    if (conv.ARS != null) acc.arsEq  += conv.ARS;
    acc.count++; acc.items.push(it);
    acc.servicioId = acc.servicioId || it.servicioId || null;
    map.set(key, acc);
  }
  return [...map.entries()].map(([servicio,v])=>({servicio,...v})).sort((a,b)=>b.clpEq - a.clpEq);
}

async function openModalProveedor(slugProv, data) {
  const modal = el('modal');
  const dests = [...data.destinos];
  const gruposSet = new Set(data.items.map(i => i.grupoId));
  const paxTotal = data.items.reduce((s,i)=> s + (Number(i.pax||0)), 0);
  el('modalTitle').textContent =
    `DETALLE — ${ (data?.nombre || slugProv).toUpperCase() }`;
  el('modalSub').textContent =
    `DESTINOS: ${dests.join(', ').toUpperCase()} • GRUPOS: ${gruposSet.size} • PAX: ${fmt(paxTotal)};

  const cont = buildModalShell();

  // —— Resumen por servicio
  const resumen = agruparItemsPorServicio(data.items);
  const tbRes = $('#tblProvResumen tbody', cont);
  tbRes.innerHTML = '';
  for (const r of resumen) {
    tbRes.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.servicio}">${r.servicio}</td>
        <td class="right bold" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
        <td class="right"><button class="btn secondary btn-det-svc" data-svc="${slug(r.servicio)}">VER DETALLE</button></td>
      </tr>
    `);
  }

  // —— Detalle (moneda nativa en NARANJO)
  const tb = $('#tblDetalleProv tbody', cont);
  tb.innerHTML = '';
  const rows = [...data.items].sort((a,b) =>
    (a.fecha || '').localeCompare(b.fecha || '') ||
    (a.nombreGrupo || '').localeCompare(b.nombreGrupo || '')
  );

  let totCLP = 0;
  for (const it of rows) {
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (typeof conv.CLP === 'number') totCLP += conv.CLP;
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const negocioId = (it.numeroNegocio || it.grupoId || '') + (it.identificador ? `-${it.identificador}`:'');
    const grupoTxt  = it.nombreGrupo || '';
    const nativeClass = (m) => (normalizarMoneda(it.moneda) === m ? 'is-native-service' : '');
    tb.insertAdjacentHTML('beforeend', `
      <tr data-svc="${slug(it.servicio || '')}">
        <td title="${it.fecha || ''}">${it.fecha || ''}</td>
        <td title="${negocioId}">${negocioId}</td>
        <td title="${grupoTxt}">${grupoTxt}</td>
        <td title="${it.servicio || ''}">${it.servicio || ''}</td>
        <td class="right" title="${it.pax || 0}">${fmt(it.pax || 0)}</td>
        <td title="${it.pagoTipo === 'por_pax' ? 'POR PAX' : 'POR GRUPO'} — ${ (it.pagoFrecuencia || 'UNITARIO').toUpperCase() }">
          ${(it.pagoTipo === 'por_pax' ? 'POR PAX' : 'POR GRUPO')} — ${(it.pagoFrecuencia || 'unitario').toUpperCase()}
        </td>
        <td title="${(it.moneda || 'CLP').toUpperCase()}">${(it.moneda || 'CLP').toUpperCase()}</td>
        <td class="right" title="${it.tarifa || 0}">${fmt(it.tarifa || 0)}</td>
        <td class="right ${nativeClass('USD')}" title="${conv.USD==null?'':fmt(conv.USD)}">${conv.USD==null?'—':fmt(conv.USD)}</td>
        <td class="right ${nativeClass('BRL')}" title="${conv.BRL==null?'':fmt(conv.BRL)}">${conv.BRL==null?'—':fmt(conv.BRL)}</td>
        <td class="right ${nativeClass('ARS')}" title="${conv.ARS==null?'':fmt(conv.ARS)}">${conv.ARS==null?'—':fmt(conv.ARS)}</td>
        <td class="right ${nativeClass('CLP')}" title="${conv.CLP==null?'':fmt(conv.CLP)}">${conv.CLP==null?'—':fmt(conv.CLP)}</td>
      </tr>
    `);
  }
  $('#modalTotalCLP', cont).textContent = money(totCLP);

  // —— Filtro desde resumen
  const btnClear = document.createElement('button');
  btnClear.className = 'btn ghost';
  btnClear.id = 'btnDetClear';
  btnClear.textContent = 'VER TODOS';
  btnClear.style.display = 'none';
  $('.modal-toolbar', cont).prepend(btnClear);

  cont.querySelectorAll('.btn-det-svc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const svcSlug = btn.getAttribute('data-svc');
      // filtrar detalle
      const rows = $$('#tblDetalleProv tbody tr', cont);
      let hayFiltro = false;
      rows.forEach(tr => {
        const ok = tr.getAttribute('data-svc') === svcSlug;
        tr.style.display = ok ? '' : 'none';
        if (ok) hayFiltro = true;
      });
      btnClear.style.display = hayFiltro ? '' : 'none';

      // cargar abonos del servicio seleccionado (tomar primer item de ese servicio)
      const itemSvc = data.items.find(i => slug(i.servicio||'') === svcSlug);
      if (itemSvc?.servicioId && itemSvc?.destinoGrupo) {
        await pintarAbonos({
          destinoId: itemSvc.destinoGrupo,     // OJO: destinoGrupo es nombre; en SERVICIOS usamos doc.id del destino (igual a nombre). Si tus doc ids difieren, mapea aquí.
          servicioId: itemSvc.servicioId,
          servicioNombre: itemSvc.servicio || '',
          cont,
        });
      }
    });
  });
  btnClear.addEventListener('click', () => {
    $$('#tblDetalleProv tbody tr', cont).forEach(tr => tr.style.display = '');
    btnClear.style.display = 'none';
    // limpiar abonos/saldo
    limpiarAbonos(cont);
  });

  // —— Buscador global (abonos + detalle)
  $('#modalSearch', cont).addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const match = (txt) => txt.toLowerCase().includes(q);
    // detalle
    $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
      const txt = tr.textContent || '';
      tr.style.display = match(txt) ? '' : 'none';
    });
    // abonos
    $$('#tblAbonos tbody tr', cont).forEach(tr => {
      const txt = tr.textContent || '';
      tr.style.display = match(txt) ? '' : 'none';
    });
  });

  // —— Export Excel
  $('#btnExportXLS', cont).addEventListener('click', () => exportModalToExcel(cont, (data?.nombre||'proveedor')));

  // —— Mostrar
  el('backdrop').style.display = 'block';
  modal.style.display = 'block';
  document.body.classList.add('modal-open');
}
window.openModalProveedor = openModalProveedor;

// -------------------------------
// 10) Modal — Abonos render/acciones
// -------------------------------
function limpiarAbonos(cont){
  $('#tblAbonos tbody', cont).innerHTML = '';
  $('#abTotCLP', cont).textContent = '$0';
  $('#abTotUSD', cont).textContent = '0';
  $('#abTotBRL', cont).textContent = '0';
  $('#abTotARS', cont).textContent = '0';
  paintSaldoCells({clp:0,usd:0,brl:0,ars:0});
  // también limpiar botones de contexto de ABONAR
  $('#btnAbonar', cont).onclick = null;
  $('#chkVerArchivados', cont).checked = false;
}
async function pintarAbonos({ destinoId, servicioId, servicioNombre, cont }) {
  const verArch = $('#chkVerArchivados', cont).checked;
  const tbody = $('#tblAbonos tbody', cont);
  tbody.innerHTML = '';

  let abonos = await loadAbonos(destinoId, servicioId);
  // ordenar por fecha desc
  abonos.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));

  let tCLP=0, tUSD=0, tBRL=0, tARS=0;

  for (const ab of abonos) {
    const eq = abonoEquivalentes(ab);
    const incluir = abonoIncluido(ab) || verArch;
    const estado = abonoEstadoLabel(ab);

    if (abonoIncluido(ab)) {
      tCLP += (eq.CLP || 0);
      tUSD += (eq.USD || 0);
      tBRL += (eq.BRL || 0);
      tARS += (eq.ARS || 0);
    }

    const tr = document.createElement('tr');
    if (estado === 'ARCHIVADO') tr.classList.add('abono-archivado');
    tr.innerHTML = `
      <td title="${servicioNombre}">${servicioNombre}</td>
      <td title="${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}">
        <span class="email-normal">${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}</span>
      </td>
      <td title="${ab.fecha || ''}">${ab.fecha || ''}</td>
      <td title="${(ab.moneda||'CLP').toUpperCase()}"><span class="abono-blue bold">${(ab.moneda||'CLP').toUpperCase()}</span></td>
      <td class="right" title="${ab.monto || 0}"><span class="abono-blue bold">${fmt(ab.monto || 0)}</span></td>
      <td class="right" title="${eq.CLP==null?'':fmt(eq.CLP)}">${eq.CLP==null?'—':fmt(eq.CLP)}</td>
      <td class="right" title="${eq.USD==null?'':fmt(eq.USD)}">${eq.USD==null?'—':fmt(eq.USD)}</td>
      <td class="right" title="${eq.BRL==null?'':fmt(eq.BRL)}">${eq.BRL==null?'—':fmt(eq.BRL)}</td>
      <td class="right" title="${eq.ARS==null?'':fmt(eq.ARS)}">${eq.ARS==null?'—':fmt(eq.ARS)}</td>
      <td title="${ab.nota || ''}">${ab.nota || ''}</td>
      <td>${ab.comprobanteURL ? `<a href="${ab.comprobanteURL}" target="_blank" rel="noopener">VER</a>` : '—'}</td>
      <td class="actions">
        <button class="btn ghost btn-edit"   title="EDITAR">EDITAR</button>
        <button class="btn ghost btn-arch"   title="ARCHIVAR">ARCHIVAR</button>
      </td>
      <td title="${estado}">${estado}</td>
    `;
    if (incluir) tbody.appendChild(tr);

    // acciones fila
    tr.querySelector('.btn-edit').addEventListener('click', () => abrirSubmodalAbono({
      cont, destinoId, servicioId, abono: { ...ab, id: ab.id }
    }));
    tr.querySelector('.btn-arch').addEventListener('click', async () => {
      if (!confirm('¿ARCHIVAR ESTE ABONO?')) return;
      await archivarAbono({ destinoId, servicioId, abonoId: ab.id });
      await pintarAbonos({ destinoId, servicioId, servicioNombre, cont });
      // recalcular saldo
      calcSaldoDesdeTablas(cont);
    });
  }

  // Pintar totales abonos
  $('#abTotCLP', cont).textContent = money(tCLP);
  $('#abTotUSD', cont).textContent = fmt(tUSD);
  $('#abTotBRL', cont).textContent = fmt(tBRL);
  $('#abTotARS', cont).textContent = fmt(tARS);

  // Botón Abonar (abre submodal)
  $('#btnAbonar', cont).onclick = () =>
    abrirSubmodalAbono({ cont, destinoId, servicioId, abono: null });

  // switch ver archivados
  $('#chkVerArchivados', cont).onchange = () =>
    pintarAbonos({ destinoId, servicioId, servicioNombre, cont });

  // Recalcular saldo
  calcSaldoDesdeTablas(cont);
}
function calcSaldoDesdeTablas(cont){
  // Totales servicio (del resumen filtrado si lo hay) → sumamos filas visibles de detalle
  let sCLP=0, sUSD=0, sBRL=0, sARS=0;
  $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
    if (tr.style.display === 'none') return;
    const cols = tr.querySelectorAll('td');
    const usd = Number((cols[8].textContent || '0').replaceAll('.','').replace(',','.')) || 0;
    const brl = Number((cols[9].textContent || '0').replaceAll('.','').replace(',','.')) || 0;
    const ars = Number((cols[10].textContent|| '0').replaceAll('.','').replace(',','.')) || 0;
    const clp = Number((cols[11].textContent|| '0').replaceAll('.','').replace(',','.')) || 0;
    sUSD += usd; sBRL += brl; sARS += ars; sCLP += clp;
  });

  // Totales abonos visibles
  let aCLP=0,aUSD=0,aBRL=0,aARS=0;
  $$('#tblAbonos tbody tr', cont).forEach(tr => {
    if (tr.style.display === 'none') return;
    if (tr.classList.contains('abono-archivado')) return; // excluye archivados
    const cols = tr.querySelectorAll('td');
    const clp = Number((cols[5].textContent||'0').replaceAll('.','').replace(',','.')) || 0;
    const usd = Number((cols[6].textContent||'0').replaceAll('.','').replace(',','.')) || 0;
    const brl = Number((cols[7].textContent||'0').replaceAll('.','').replace(',','.')) || 0;
    const ars = Number((cols[8].textContent||'0').replaceAll('.','').replace(',','.')) || 0;
    aCLP += clp; aUSD += usd; aBRL += brl; aARS += ars;
  });

  // Saldo = servicio - abonos
  paintSaldoCells({
    clp: sCLP - aCLP,
    usd: sUSD - aUSD,
    brl: sBRL - aBRL,
    ars: sARS - aARS,
  });
}

// Submodal (crear/editar) — emails en minúsculas, estado EDITADO al guardar si ya existía
function abrirSubmodalAbono({ cont, destinoId, servicioId, abono }) {
  const box = $('#submodalAbono', cont);
  box.hidden = false;
  $('#abFecha',  box).value = abono?.fecha || nowISODate();
  $('#abMoneda', box).value = (abono?.moneda || 'CLP').toUpperCase();
  $('#abMonto',  box).value = abono?.monto || '';
  $('#abNota',   box).value = abono?.nota  || '';
  $('#abFile',   box).value = '';

  const close = () => { box.hidden = true; };
  $('#abCancelar', box).onclick = close;

  $('#abGuardar', box).onclick = async () => {
    const data = {
      fecha: $('#abFecha', box).value,
      moneda: $('#abMoneda', box).value,
      monto: Number($('#abMonto', box).value || 0),
      nota:  $('#abNota', box).value.trim(),
      estado: abono ? 'EDITADO' : 'ORIGINAL',
      version: abono?.version || 1,
      comprobanteURL: abono?.comprobanteURL || '',
    };
    const file = $('#abFile', box).files[0] || null;

    await guardarAbono({
      destinoId, servicioId,
      abonoId: abono?.id || null,
      data, file
    });

    close();

    // Volver a pintar abonos de ese servicio
    await pintarAbonos({
      destinoId, servicioId,
      servicioNombre: '', cont
    });
    calcSaldoDesdeTablas(cont);
  };
}

// -------------------------------
// 11) Export Excel (HTML Workbook compatible)
// -------------------------------
function exportModalToExcel(cont, nombre) {
  // Construye un Workbook HTML con las 3 tablas
  const tables = [
    { title:'RESUMEN',  el: $('#tblProvResumen', cont) },
    { title:'ABONOS',   el: $('#tblAbonos', cont) },
    { title:'DETALLE',  el: $('#tblDetalleProv', cont) },
    { title:'SALDO',    el: $('#tblSaldo', cont) },
  ];
  const htmlSheets = tables.map(t => `
    <h2>${t.title}</h2>
    ${t.el.outerHTML}
    <br/>
  `).join('\n');

  const html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel"
          xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <!-- Excel-compatible -->
      <meta charset="UTF-8" />
    </head>
    <body>
      ${htmlSheets}
    </body>
    </html>
  `;
  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `finanzas_${slug(nombre)}_${new Date().toISOString().slice(0,10)}.xls`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// -------------------------------
// 12) Recalcular
// -------------------------------
function getDestinosSeleccionados() {
  const sel = el('filtroDestino');
  return new Set([...sel.selectedOptions].map(o => o.value));
}
function poblarFiltrosBasicos() {
  const anios = new Set();
  const hoy = new Date();
  const anioActual = hoy.getFullYear();

  for (const g of GRUPOS) {
    const a = Number(g.anoViaje || g.anio || g.year || anioActual);
    if (a) anios.add(a);
  }
  if (!anios.size) { anios.add(anioActual); anios.add(anioActual + 1); }
  const arrAnios = [...anios].sort((a,b)=>a-b);
  el('filtroAnio').innerHTML = arrAnios
    .map(a => `<option value="${a}" ${a===anioActual?'selected':''}>${a}</option>`).join('');

  const dests = [...new Set(GRUPOS.map(g => g.destino).filter(Boolean))]
                 .sort((a,b)=>a.localeCompare(b));
  el('filtroDestino').innerHTML = dests.map(d => `<option value="${d}">${d}</option>`).join('');
}
function aplicarRangoPorAnio() {
  const anio = el('filtroAnio').value;
  if (!anio) return;
  el('fechaDesde').value = `${anio}-01-01`;
  el('fechaHasta').value = `${anio}-12-31`;
}

// Log auxiliar
function logDiagnostico(items){
  const faltantes = items.filter(x => x.servicioId == null);
  if (faltantes.length){
    const top = {};
    for (const f of faltantes){
      const k = `${norm(f.destinoGrupo)} | ${norm(f.servicio)}`;
      top[k] = (top[k]||0)+1;
    }
    console.group('Actividades SIN match en Servicios (destino+actividad)');
    console.table(Object.entries(top).map(([k,v]) => ({ clave:k, ocurrencias:v })));
    console.groupEnd();
  }
}

function recalcular() {
  const fechaDesde = el('fechaDesde').value || null;
  const fechaHasta = el('fechaHasta').value || null;
  const destinosSel = getDestinosSeleccionados();
  const inclAct = el('inclActividades').checked;
  const inclHot = el('inclHoteles').checked;

  LINE_ITEMS = construirLineItems(fechaDesde, fechaHasta, destinosSel, inclAct);
  LINE_HOTEL = construirLineItemsHotel(fechaDesde, fechaHasta, destinosSel, inclHot);

  logDiagnostico(LINE_ITEMS);

  renderKPIs(LINE_ITEMS, LINE_HOTEL);

  const mapDest = agruparPorDestino([...LINE_ITEMS, ...LINE_HOTEL]);
  renderTablaDestinos(mapDest);

  const mapProv = agruparPorProveedor(LINE_ITEMS);
  renderTablaProveedores(mapProv);

  const secH = el('secHoteles');
  if (LINE_HOTEL.length) {
    secH.style.display = '';
    const mapHot = agruparPorHotel(LINE_HOTEL);
    renderTablaHoteles(mapHot);
  } else {
    secH.style.display = 'none';
  }
}

// -------------------------------
// 13) Export general (CSV) — igual que antes
// -------------------------------
function exportCSV() {
  const header = ['Fecha','Proveedor','Servicio','Grupo','Destino','Pax','Modalidad','Moneda','Tarifa','TotalMoneda','TotalCLP'];
  const rows = [header.join(',')];

  for (const it of LINE_ITEMS) {
    const modalidad = `${it.pagoTipo||''}/${it.pagoFrecuencia||''}`;
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    rows.push([
      it.fecha || '',
      (it.proveedor || '').replaceAll(',',' '),
      (it.servicio || '').replaceAll(',',' '),
      ((cod ? `${cod} — ` : '') + (it.nombreGrupo || '')).replaceAll(',',' '),
      (it.destinoGrupo || '').replaceAll(',',' '),
      it.pax || 0,
      modalidad,
      it.moneda || 'CLP',
      it.tarifa || 0,
      it.totalMoneda || 0,
      (typeof conv.CLP === 'number' ? Math.round(conv.CLP) : '')
    ].join(','));
  }

  for (const it of LINE_HOTEL) {
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    rows.push([
      '',
      (it.hotel || '').replaceAll(',',' '),
      `HOTEL (${it.tipoCobro})`,
      ((cod ? `${cod} — ` : '') + (it.nombreGrupo || '')).replaceAll(',',' '),
      (it.destinoGrupo || '').replaceAll(',',' '),
      it.noches || 0,
      it.tipoCobro || '',
      it.moneda || 'CLP',
      it.tarifa || 0,
      it.totalMoneda || 0,
      (typeof conv.CLP === 'number' ? Math.round(conv.CLP) : '')
    ].join(','));
  }

  const blob = new Blob([rows.join('\n')], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `finanzas_RT_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// -------------------------------
function closeModal() {
  el('backdrop').style.display = 'none';
  el('modal').style.display = 'none';
  document.body.classList.remove('modal-open');
}
window.closeModal = closeModal;

// -------------------------------
// 14) Boot
// -------------------------------
function bindUI() {
  el('filtroAnio').addEventListener('change', () => { aplicarRangoPorAnio(); recalcular(); });
  el('filtroDestino').addEventListener('change', recalcular);
  el('fechaDesde').addEventListener('change', recalcular);
  el('fechaHasta').addEventListener('change', recalcular);
  el('inclActividades').addEventListener('change', recalcular);
  el('inclHoteles').addEventListener('change', recalcular);
  el('tcUSD').addEventListener('change', recalcular);
  el('tcBRL').addEventListener('change', recalcular);
  const tcARS = el('tcARS'); if (tcARS) tcARS.addEventListener('change', recalcular);

  el('btnRecalcular').addEventListener('click', recalcular);
  el('btnExportCSV').addEventListener('click', exportCSV);

  el('modalClose').addEventListener('click', closeModal);
  el('backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

async function boot() {
  onAuthStateChanged(auth, async () => {
    try {
      await Promise.all([loadGrupos(), loadServicios(), loadProveedores(), loadHotelesYAsignaciones()]);
      poblarFiltrosBasicos();
      aplicarRangoPorAnio();
      bindUI();
      recalcular();
    } catch (e) {
      console.error('Error cargando datos', e);
    }
  });
}
boot();
