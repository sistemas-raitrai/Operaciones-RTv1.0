// finanzas.js — Finanzas Operaciones RT (USD/BRL/ARS + Abonos + XLSX)
// ===================================================================
// Mantiene tu lógica, suma ARS, tooltips/azul, prefijo numeroNegocio-identificador,
// modal de abonos con Storage, y exportación XLSX (SheetJS por CDN).

// Firebase
import { app, db } from './firebase-init.js';
import { collection, getDocs, addDoc } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

// ---------------------------------------------------------------
// 0) Rutas raíz
// ---------------------------------------------------------------
const RUTA_SERVICIOS  = 'Servicios';   // Servicios/{DESTINO}/Listado/*
const RUTA_PROV_ROOT  = 'Proveedores'; // Proveedores/{DESTINO}/Listado/* (opcional)
const RUTA_HOTEL_ROOT = 'Hoteles';     // Hoteles/{DESTINO}/(Listado|Asignaciones)/*
const RUTA_GRUPOS     = 'grupos';      // grupos/*

const auth = getAuth(app);
const storage = getStorage(app);

// ---------------------------------------------------------------
// 1) Estado + helpers
// ---------------------------------------------------------------
let GRUPOS = [];
let SERVICIOS = [];
let PROVEEDORES = {};
let HOTELES = [];
let ASIGNACIONES = [];

let LINE_ITEMS = []; // actividades
let LINE_HOTEL = []; // hoteles

// Estado del modal proveedor
const MODAL = {
  provSlug: null,
  provNombre: null,
  items: [],
  resumenServicios: [], // [{ servicioId, servicioNombre, destinoId, monedaNativa, totalsEq, count }]
  current: null,        // { servicioId, servicioNombre, destinoId, monedaNativa }
  abonosPorServicio: {} // { `${destinoId}|${servicioId}`: [abono,...] }
};

const el    = id => document.getElementById(id);
const fmt   = n => (n ?? 0).toLocaleString('es-CL');
const money = n => '$' + fmt(Math.round(n || 0));
const slug  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');
const norm  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();

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

// Tipos de cambio actuales (inputs)
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

// Equivalencias a todas las monedas usando TC actual (CLP como pivote)
function eqAll(monto, monedaOrigen){
  const mo = normalizarMoneda(monedaOrigen);
  const tc = { CLP:1, USD: pickTC('USD')||0, BRL: pickTC('BRL')||0, ARS: pickTC('ARS')||0 };
  if (mo === 'CLP'){
    return {
      CLP: monto,
      USD: tc.USD ? monto / tc.USD : 0,
      BRL: tc.BRL ? monto / tc.BRL : 0,
      ARS: tc.ARS ? monto / tc.ARS : 0
    };
  } else {
    const toCLP = pickTC(mo) ? monto * pickTC(mo) : 0;
    return {
      CLP: toCLP,
      USD: tc.USD ? toCLP / tc.USD : 0,
      BRL: tc.BRL ? toCLP / tc.BRL : 0,
      ARS: tc.ARS ? toCLP / tc.ARS : 0
    };
  }
}

// Suma equivalentes de una lista de items ({totalMoneda, moneda}) a cada moneda
function sumEq(items){
  const out = { CLP:0, USD:0, BRL:0, ARS:0 };
  for (const it of items){
    const e = eqAll(Number(it.totalMoneda || 0), it.moneda || 'CLP');
    out.CLP += e.CLP; out.USD += e.USD; out.BRL += e.BRL; out.ARS += e.ARS;
  }
  return out;
}

// ---------------------------------------------------------------
// 2) Carga de datos
// ---------------------------------------------------------------

// Servicios/{DESTINO}/Listado/*
async function loadServicios() {
  const rootSnap = await getDocs(collection(db, RUTA_SERVICIOS));
  const promSub = [];
  for (const doc of rootSnap.docs) {
    const destinoId = doc.id;
    promSub.push(
      getDocs(collection(doc.ref, 'Listado'))
        .then(snap => snap.docs.map(d => {
          const data = d.data() || {};
          return { id:d.id, destino:destinoId, servicio:data.servicio || d.id, ...data };
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
    for (const doc of rootSnap.docs) {
      promSub.push(
        getDocs(collection(doc.ref, 'Listado'))
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

// Hoteles/{DESTINO}/(Listado|Asignaciones)/*
async function loadHotelesYAsignaciones() {
  HOTELES = []; ASIGNACIONES = [];
  try {
    const rootSnap = await getDocs(collection(db, RUTA_HOTEL_ROOT));
    const promListado = [], promAsign = [];
    for (const doc of rootSnap.docs) {
      const destinoId = doc.id;
      promListado.push(
        getDocs(collection(doc.ref, 'Listado'))
          .then(snap => snap.docs.map(d => ({ id:d.id, destino:destinoId, ...d.data() })))
          .catch(() => [])
      );
      promAsign.push(
        getDocs(collection(doc.ref, 'Asignaciones'))
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

// ---------------------------------------------------------------
// 3) Resolver Servicio
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// 4) Construcción de line items
// ---------------------------------------------------------------
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

        if (!svc) {
          out.push({
            tipo:'actividad',
            proveedor: item.proveedor || '(desconocido)',
            proveedorSlug: slug(item.proveedor || '(desconocido)'),
            servicio: item.actividad || item.servicio || '(sin nombre)',
            servicioId: null, servicioDestino: null, monedaNativa: 'CLP',
            destinoGrupo, fecha: fechaISO,
            grupoId: g.id,
            nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
            numeroNegocio: g.numeroNegocio || g.id,
            identificador: g.identificador || g.IDENTIFICADOR || '',
            pax, moneda:'CLP', tarifa:0,
            pagoTipo:'por_grupo', pagoFrecuencia:'unitario',
            totalMoneda:0, totalCLP:0,
            nota:'Sin tarifario en Servicios (destino+actividad no encontrado)'
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
        const tc            = pickTC(moneda);
        const totalCLP      = (tc ? totalMoneda * tc : null);

        out.push({
          tipo:'actividad',
          proveedor, proveedorSlug:slug(proveedor),
          servicio: svc.servicio || item.actividad || '(sin nombre)',
          servicioId: svc.id || null,
          servicioDestino: svc.destino || null,
          monedaNativa: moneda,
          destinoGrupo, fecha: fechaISO,
          grupoId: g.id,
          nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
          numeroNegocio: g.numeroNegocio || g.id,
          identificador: g.identificador || g.IDENTIFICADOR || '',
          pax, moneda, tarifa: valor,
          pagoTipo: esPorPersona ? 'por_pax' : 'por_grupo',
          pagoFrecuencia:'unitario',
          totalMoneda, totalCLP, nota:''
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

    const tc          = pickTC(moneda);
    const totalMoneda = totalPorNoche * nights.length;
    const totalCLP    = (tc ? totalMoneda * tc : null);

    out.push({
      tipo:'hotel',
      hotel:hotelNombre, destinoGrupo,
      grupoId:g.id, nombreGrupo:g.nombreGrupo || '',
      numeroNegocio:g.numeroNegocio || g.id,
      identificador:g.identificador || g.IDENTIFICADOR || '',
      noches:nights.length,
      moneda, tarifa, tipoCobro,
      totalMoneda, totalCLP,
    });
  }
  return out;
}

// ---------------------------------------------------------------
// 5) Agregaciones
// ---------------------------------------------------------------
function agruparPorDestino(items) {
  const r = new Map();
  for (const it of items) {
    const key = it.destinoGrupo || it.destino || '(sin destino)';
    const o = r.get(key) || { clp:0, usd:0, brl:0, ars:0, clpConvertido:0, count:0 };
    if (it.moneda === 'CLP' && it.totalMoneda) o.clp += it.totalMoneda;
    if (it.moneda === 'USD' && it.totalMoneda) o.usd += it.totalMoneda;
    if (it.moneda === 'BRL' && it.totalMoneda) o.brl += it.totalMoneda;
    if (it.moneda === 'ARS' && it.totalMoneda) o.ars += it.totalMoneda;
    if (typeof it.totalCLP === 'number') o.clpConvertido += it.totalCLP;
    o.count++;
    r.set(key, o);
  }
  return r;
}

function agruparPorProveedor(items) {
  const r = new Map();
  for (const it of items) {
    const slugProv = it.proveedorSlug || slug(it.proveedor || '(sin proveedor)');
    const nombre   = it.proveedor || '(sin proveedor)';
    const o = r.get(slugProv) || { nombre, destinos:new Set(), clp:0, usd:0, brl:0, ars:0, clpConv:0, count:0, items:[] };
    o.destinos.add(it.destinoGrupo || '(sin destino)');
    if (it.moneda === 'CLP' && it.totalMoneda) o.clp += it.totalMoneda;
    if (it.moneda === 'USD' && it.totalMoneda) o.usd += it.totalMoneda;
    if (it.moneda === 'BRL' && it.totalMoneda) o.brl += it.totalMoneda;
    if (it.moneda === 'ARS' && it.totalMoneda) o.ars += it.totalMoneda;
    if (typeof it.totalCLP === 'number') o.clpConv += it.totalCLP;
    o.count++;
    o.items.push(it);
    r.set(slugProv, o);
  }
  return r;
}

function agruparPorHotel(itemsHotel) {
  const r = new Map();
  for (const it of itemsHotel) {
    const key = it.hotel || '(hotel)';
    const o = r.get(key) || { destino: it.destinoGrupo || '(sin destino)', clp:0, usd:0, brl:0, ars:0, clpConv:0, noches:0 };
    if (it.moneda === 'CLP' && it.totalMoneda) o.clp += it.totalMoneda;
    if (it.moneda === 'USD' && it.totalMoneda) o.usd += it.totalMoneda;
    if (it.moneda === 'BRL' && it.totalMoneda) o.brl += it.totalMoneda;
    if (it.moneda === 'ARS' && it.totalMoneda) o.ars += it.totalMoneda;
    if (typeof it.totalCLP === 'number') o.clpConv += it.totalCLP;
    o.noches += (it.noches || 0);
    r.set(key, o);
  }
  return r;
}

// ---------------------------------------------------------------
// 6) Render UI (kpis + tablas principales)
// ---------------------------------------------------------------
function renderKPIs(items, itemsHotel) {
  const all = [...items, ...itemsHotel];

  const totCLP = all.reduce((acc, it) => acc + (typeof it.totalCLP === 'number' ? it.totalCLP : 0), 0);
  el('kpiTotCLP').textContent = money(totCLP);

  const restUSD = all.filter(it => it.moneda === 'USD' && it.totalCLP == null).reduce((s, it) => s + (it.totalMoneda || 0), 0);
  const restBRL = all.filter(it => it.moneda === 'BRL' && it.totalCLP == null).reduce((s, it) => s + (it.totalMoneda || 0), 0);
  const restARS = all.filter(it => it.moneda === 'ARS' && it.totalCLP == null).reduce((s, it) => s + (it.totalMoneda || 0), 0);

  el('kpiOtrosMon').textContent =
    `USD no conv.: ${fmt(restUSD)} — BRL no conv.: ${fmt(restBRL)} — ARS no conv.: ${fmt(restARS)}`;

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
    clpConv:v.clpConvertido||0,
    clp:v.clp||0, usd:v.usd||0, brl:v.brl||0, ars:v.ars||0,
    count:v.count||0
  }));
  rows.sort((a,b)=>b.clpConv - a.clpConv);
  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.destino}">${r.destino || '(sin destino)'}</td>
        <td class="right" title="${r.clpConv}">${money(r.clpConv)}</td>
        <td class="right" title="${r.usd}">${fmt(r.usd)}</td>
        <td class="right" title="${r.brl}">${fmt(r.brl)}</td>
        <td class="right" title="${r.ars}">${fmt(r.ars)}</td>
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
    clpConv:v.clpConv||0,
    clp:v.clp||0, usd:v.usd||0, brl:v.brl||0, ars:v.ars||0,
    count:v.count||0, items:v.items
  }));
  rows.sort((a,b)=>b.clpConv - a.clpConv);

  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.nombre}">${r.nombre}</td>
        <td title="${r.destinos}">${r.destinos}</td>
        <td class="right" title="${r.clpConv}">${money(r.clpConv)}</td>
        <td class="right" title="${r.usd}">${fmt(r.usd)}</td>
        <td class="right" title="${r.brl}">${fmt(r.brl)}</td>
        <td class="right" title="${r.ars}">${fmt(r.ars)}</td>
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
    clpConv:v.clpConv||0,
    clp:v.clp||0, usd:v.usd||0, brl:v.brl||0, ars:v.ars||0,
    noches:v.noches||0
  }));
  rows.sort((a,b)=>b.clpConv - a.clpConv);
  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.hotel}">${r.hotel}</td>
        <td title="${r.destino || ''}">${r.destino || ''}</td>
        <td class="right" title="${r.clpConv}">${money(r.clpConv)}</td>
        <td class="right" title="${r.usd}">${fmt(r.usd)}</td>
        <td class="right" title="${r.brl}">${fmt(r.brl)}</td>
        <td class="right" title="${r.ars}">${fmt(r.ars)}</td>
        <td class="right" title="${r.noches}">${fmt(r.noches)}</td>
      </tr>
    `);
  }
}

// ---------------------------------------------------------------
// 7) Modal proveedor (Resumen+Detalle+Abonos)
// ---------------------------------------------------------------

// Agrupar por servicio conservando servicioId/destino y moneda nativa (la más común)
function agruparItemsPorServicioConEq(items) {
  const map = new Map();
  for (const it of items) {
    const key = (it.servicioId || slug(it.servicio)) + '|' + (it.servicioDestino || it.destinoGrupo || '');
    const o = map.get(key) || {
      servicioId: it.servicioId,
      servicioNombre: it.servicio,
      destinoId: it.servicioDestino || it.destinoGrupo || '',
      count:0, items:[], monedaCount:{}
    };
    o.items.push(it);
    o.count++;
    o.monedaCount[it.moneda] = (o.monedaCount[it.moneda]||0)+1;
    map.set(key, o);
  }
  // producir arreglo con totales equivalentes
  const rows = [];
  map.forEach(o => {
    // moneda nativa = la más frecuente en ese servicio
    let mon = 'CLP', mmax=0;
    Object.entries(o.monedaCount).forEach(([k,v]) => { if(v>mmax){ mmax=v; mon=k; } });
    const totalsEq = sumEq(o.items);
    rows.push({
      servicioId: o.servicioId || null,
      servicioNombre: o.servicioNombre || '(sin servicio)',
      destinoId: o.destinoId || '',
      monedaNativa: mon,
      totalsEq,
      count: o.count,
      items: o.items
    });
  });
  // orden por CLP eq (desc)
  rows.sort((a,b)=> (b.totalsEq.CLP - a.totalsEq.CLP));
  return rows;
}

async function loadAbonosServicio(destinoId, servicioId){
  if (!destinoId || !servicioId) return [];
  const key = `${destinoId}|${servicioId}`;
  if (MODAL.abonosPorServicio[key]) return MODAL.abonosPorServicio[key];

  try{
    const snap = await getDocs(collection(db, RUTA_SERVICIOS, destinoId, 'Listado', servicioId, 'Abonos'));
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    MODAL.abonosPorServicio[key] = arr;
    return arr;
  }catch(e){
    console.warn('Error cargando abonos', e);
    MODAL.abonosPorServicio[key] = [];
    return [];
  }
}

function pintarResumenServicios(){
  const tb = el('tblProvResumen').querySelector('tbody');
  tb.innerHTML = '';

  for (const r of MODAL.resumenServicios){
    // columna nativa azul: lo marcamos con <span class="is-native">
    const usdHTML = `<span class="${r.monedaNativa==='USD'?'is-native':''}">${fmt(r.totalsEq.USD)}</span>`;
    const brlHTML = `<span class="${r.monedaNativa==='BRL'?'is-native':''}">${fmt(r.totalsEq.BRL)}</span>`;
    const arsHTML = `<span class="${r.monedaNativa==='ARS'?'is-native':''}">${fmt(r.totalsEq.ARS)}</span>`;
    const clpHTML = `<span class="${r.monedaNativa==='CLP'?'is-native':''}">${money(r.totalsEq.CLP)}</span>`;

    tb.insertAdjacentHTML('beforeend', `
      <tr data-svcid="${r.servicioId||''}" data-dest="${r.destinoId||''}">
        <td title="${r.servicioNombre}">${r.servicioNombre}</td>
        <td class="right">${clpHTML}</td>
        <td class="right">${usdHTML}</td>
        <td class="right">${brlHTML}</td>
        <td class="right">${arsHTML}</td>
        <td class="right" data-saldo="clp">—</td>
        <td class="right">${fmt(r.count)}</td>
        <td class="right"><button class="btn secondary btn-det-svc" data-svc="${slug(r.servicioNombre)}">Ver detalle</button></td>
      </tr>
    `);
  }

  // precalcular saldos CLP de cada fila (after abonos fetch al seleccionar)
}

function pintarDetalleFiltrado(items, monedaNativa){
  const cont = el('tblDetalleProv').querySelector('tbody');
  cont.innerHTML = '';
  let totCLP = 0;

  const rows = [...items].sort((a,b)=>
    (a.fecha || '').localeCompare(b.fecha || '') ||
    (a.nombreGrupo || '').localeCompare(b.nombreGrupo || '')
  );

  for (const it of rows){
    if (typeof it.totalCLP === 'number') totCLP += it.totalCLP;

    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const negocioId = cod || (it.grupoId || '');
    const grupoTxt = it.nombreGrupo || '';

    cont.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${it.fecha || ''}">${it.fecha || ''}</td>
        <td title="${negocioId}">${negocioId}</td>
        <td title="${grupoTxt}">${grupoTxt}</td>
        <td title="${it.servicio || ''}">${it.servicio || ''}</td>
        <td class="right" title="${it.pax || 0}">${fmt(it.pax || 0)}</td>
        <td title="${it.pagoTipo === 'por_pax' ? 'por pax' : 'por grupo'} — ${it.pagoFrecuencia || 'unitario'}">
          ${it.pagoTipo === 'por_pax' ? 'por pax' : 'por grupo'} — ${it.pagoFrecuencia || 'unitario'}
        </td>
        <td>${it.moneda || 'CLP'}</td>
        <td class="right">${fmt(it.tarifa || 0)}</td>
        <td class="right">${fmt(it.totalMoneda || 0)}</td>
        <td class="right">
          ${typeof it.totalCLP === 'number' ? fmt(it.totalCLP) : '—'}
        </td>
      </tr>
    `);
  }
  el('modalTotalCLP').textContent = money(totCLP);

  // resaltar columna nativa en detalle: marcamos todas las celdas de esa moneda con .is-native via CSS? Aquí ya marcamos en resumen; en detalle lo lógico es el valor en USD/BRL/ARS/CLP
  // Como en detalle sólo mostramos “Moneda” y “Total”, se entiende por contexto.
}

// Rellena tarjetas + abonos + saldo (tras seleccionar servicio)
function pintarFinanzasServicio(svc){
  const items = svc.items;
  const tot = sumEq(items);

  // Abonos (ya deben estar en MODAL.abonosPorServicio[key])
  const key = `${svc.destinoId}|${svc.servicioId}`;
  const abonos = MODAL.abonosPorServicio[key] || [];
  const abEqItems = abonos.map(a => ({
    totalMoneda: Number(a.monto || 0),
    moneda: a.moneda || 'CLP'
  }));
  const abo = sumEq(abEqItems);
  const sal = {
    CLP: tot.CLP - abo.CLP,
    USD: tot.USD - abo.USD,
    BRL: tot.BRL - abo.BRL,
    ARS: tot.ARS - abo.ARS
  };

  // Tarjetas
  const native = svc.monedaNativa;
  const setVal = (id, value, makeBlue=false) => {
    const node = el(id);
    node.textContent = id.includes('CLP') ? money(value) : fmt(value);
    node.classList.toggle('is-native', !!makeBlue);
  };
  setVal('totCLP', tot.CLP, native==='CLP'); setVal('totUSD', tot.USD, native==='USD');
  setVal('totBRL', tot.BRL, native==='BRL'); setVal('totARS', tot.ARS, native==='ARS');

  setVal('aboCLP', abo.CLP); setVal('aboUSD', abo.USD); setVal('aboBRL', abo.BRL); setVal('aboARS', abo.ARS);

  setVal('salCLP', sal.CLP, native==='CLP'); setVal('salUSD', sal.USD, native==='USD');
  setVal('salBRL', sal.BRL, native==='BRL'); setVal('salARS', sal.ARS, native==='ARS');

  // Tabla Saldo compacta
  el('saldoCLP').textContent = money(sal.CLP);
  el('saldoUSD').textContent = fmt(sal.USD);
  el('saldoBRL').textContent = fmt(sal.BRL);
  el('saldoARS').textContent = fmt(sal.ARS);

  // Tabla de Abonos (fila “monto” en azul en su moneda)
  const tb = el('tblAbonos').querySelector('tbody');
  tb.innerHTML = '';
  let totAboEq = { CLP:0, USD:0, BRL:0, ARS:0 };
  for (const a of abonos){
    const e = eqAll(Number(a.monto||0), a.moneda||'CLP');
    totAboEq.CLP += e.CLP; totAboEq.USD += e.USD; totAboEq.BRL += e.BRL; totAboEq.ARS += e.ARS;

    const isC = (m)=> (a.moneda===m?'is-abono':'');
    tb.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${a.fecha || ''}</td>
        <td>${a.moneda || 'CLP'}</td>
        <td class="right ${isC('CLP')}">${fmt(a.monto || 0)}</td>
        <td class="right">${money(e.CLP)}</td>
        <td class="right">${fmt(e.USD)}</td>
        <td class="right">${fmt(e.BRL)}</td>
        <td class="right">${fmt(e.ARS)}</td>
        <td>${(a.nota || '').toString().slice(0,120)}</td>
        <td>${a.fileUrl ? `<a href="${a.fileUrl}" target="_blank">ver</a>` : ''}</td>
      </tr>
    `);
  }
  el('aboTotCLP').textContent = money(totAboEq.CLP);
  el('aboTotUSD').textContent = fmt(totAboEq.USD);
  el('aboTotBRL').textContent = fmt(totAboEq.BRL);
  el('aboTotARS').textContent = fmt(totAboEq.ARS);

  // Mostrar secciones
  el('resumenTotales').style.display = '';
  el('secAbonos').style.display = '';
  el('secSaldo').style.display  = '';
}

// Abre modal proveedor
function openModalProveedor(slugProv, data) {
  MODAL.provSlug = slugProv;
  MODAL.provNombre = data?.nombre || slugProv;
  MODAL.items = data.items || [];
  MODAL.resumenServicios = agruparItemsPorServicioConEq(MODAL.items);
  MODAL.current = null;

  // Title con destinos + tot grupos/pax
  const destinosTxt = [...(data.destinos||[])].join(', ');
  const grupos = new Set(MODAL.items.map(i => i.grupoId));
  const paxTot = MODAL.items.reduce((s,i)=> s + (Number(i.pax||0)), 0);

  el('modalTitle').textContent = `Detalle — ${MODAL.provNombre} · Destinos: ${destinosTxt} · Grupos: ${fmt(grupos.size)} · Pax: ${fmt(paxTot)}`;
  el('modalSub').textContent = 'Los montos muestran equivalentes en CLP, USD, BRL y ARS según los tipos de cambio indicados en la cabecera. En azul se resalta la moneda original del servicio y la moneda del abono. El “saldo” = Total − Abonos (mismos TC actuales).';

  // Resumen por servicio
  pintarResumenServicios();

  // Detalle completo (sin filtro)
  const tbody = el('tblDetalleProv').querySelector('tbody');
  tbody.innerHTML = '';
  el('modalTotalCLP').textContent = money(0);
  pintarDetalleFiltrado(MODAL.items, null);

  // Ocultar secciones finanzas (hasta que elijan “Ver detalle”)
  el('resumenTotales').style.display = 'none';
  el('secAbonos').style.display = 'none';
  el('secSaldo').style.display  = 'none';
  el('btnAbonar').disabled = true;
  el('btnExportModal').disabled = true;

  // Eventos
  const cont = el('tblProvResumen').querySelector('tbody');
  cont.querySelectorAll('.btn-det-svc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const servicioId = tr.getAttribute('data-svcid');
      const destinoId  = tr.getAttribute('data-dest') || '';
      const row = MODAL.resumenServicios.find(r => (r.servicioId||'') === (servicioId||'') && (r.destinoId||'') === destinoId);

      if (!row){ return; }

      MODAL.current = {
        servicioId: row.servicioId, servicioNombre: row.servicioNombre,
        destinoId: row.destinoId, monedaNativa: row.monedaNativa,
        items: row.items
      };

      // Cargar abonos del servicio
      await loadAbonosServicio(row.destinoId, row.servicioId);

      // Pintar tarjetas, abonos, saldo y detalle filtrado
      pintarFinanzasServicio(MODAL.current);
      pintarDetalleFiltrado(row.items, row.monedaNativa);

      // Recalcular saldo CLP eq. de esa fila (ahora que tenemos abonos)
      const key = `${row.destinoId}|${row.servicioId}`;
      const abonos = MODAL.abonosPorServicio[key] || [];
      const aboCLP = abonos.reduce((s,a)=> s + (eqAll(Number(a.monto||0), a.moneda||'CLP').CLP), 0);
      const saldoCLP = row.totalsEq.CLP - aboCLP;
      tr.querySelector('[data-saldo="clp"]').textContent = money(saldoCLP);

      // Habilitar botones
      el('btnDetClear').style.display = '';
      el('btnAbonar').disabled = false;
      el('btnExportModal').disabled = false;
    });
  });

  el('btnDetClear').onclick = () => {
    // Quitar filtro
    MODAL.current = null;
    pintarDetalleFiltrado(MODAL.items, null);
    el('resumenTotales').style.display = 'none';
    el('secAbonos').style.display = 'none';
    el('secSaldo').style.display  = 'none';
    el('btnDetClear').style.display = 'none';
    el('btnAbonar').disabled = true;
    el('btnExportModal').disabled = true;
    // Reset saldos a “—”
    el('tblProvResumen').querySelectorAll('tbody [data-saldo="clp"]').forEach(td=> td.textContent='—');
  };

  // Exportación XLSX (modal)
  el('btnExportModal').onclick = () => exportModalXLSX();

  // Abonar
  el('btnAbonar').onclick = () => openAbonoModal();

  // Mostrar modal
  el('backdrop').style.display = 'block';
  el('modal').style.display = 'block';
  document.body.classList.add('modal-open');
}

function closeModal() {
  el('backdrop').style.display = 'none';
  el('modal').style.display = 'none';
  document.body.classList.remove('modal-open');
}

// ---------------------------------------------------------------
// 8) Export CSV (pantalla principal)
// ---------------------------------------------------------------
function exportCSV() {
  const header = ['Fecha','Proveedor','Servicio','Grupo','Destino','Pax','Modalidad','Moneda','Tarifa','TotalMoneda','TotalCLP'];
  const rows = [header.join(',')];

  for (const it of LINE_ITEMS) {
    const modalidad = `${it.pagoTipo||''}/${it.pagoFrecuencia||''}`;
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
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
      (typeof it.totalCLP === 'number' ? it.totalCLP : '')
    ].join(','));
  }

  for (const it of LINE_HOTEL) {
    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
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
      (typeof it.totalCLP === 'number' ? it.totalCLP : '')
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

// ---------------------------------------------------------------
// 9) Exportación XLSX (contenido del modal)
// ---------------------------------------------------------------
function exportModalXLSX(){
  if (typeof XLSX === 'undefined'){ alert('Librería XLSX no disponible.'); return; }

  // 1) Resumen por servicio
  const res = [['Servicio','CLP (eq.)','USD','BRL','ARS','Saldo CLP','Items']];
  el('tblProvResumen').querySelectorAll('tbody tr').forEach(tr=>{
    const tds = tr.querySelectorAll('td');
    res.push([
      tds[0]?.textContent?.trim() || '',
      tds[1]?.textContent?.trim() || '',
      tds[2]?.textContent?.trim() || '',
      tds[3]?.textContent?.trim() || '',
      tds[4]?.textContent?.trim() || '',
      tds[5]?.textContent?.trim() || '',
      tds[6]?.textContent?.trim() || ''
    ]);
  });

  // 2) Abonos
  const abo = [['Fecha','Moneda','Monto','CLP (eq.)','USD (eq.)','BRL (eq.)','ARS (eq.)','Nota','Comprobante']];
  el('tblAbonos').querySelectorAll('tbody tr').forEach(tr=>{
    const tds = tr.querySelectorAll('td');
    abo.push([
      tds[0]?.textContent?.trim() || '',
      tds[1]?.textContent?.trim() || '',
      tds[2]?.textContent?.trim() || '',
      tds[3]?.textContent?.trim() || '',
      tds[4]?.textContent?.trim() || '',
      tds[5]?.textContent?.trim() || '',
      tds[6]?.textContent?.trim() || '',
      tds[7]?.textContent?.trim() || '',
      tds[8]?.textContent?.trim() || ''
    ]);
  });

  // 3) Detalle
  const det = [['Fecha','Negocio-ID','Grupo','Servicio','Pax','Modalidad','Moneda','Tarifa','Total (mon)','Total CLP']];
  el('tblDetalleProv').querySelectorAll('tbody tr').forEach(tr=>{
    const tds = tr.querySelectorAll('td');
    det.push([
      tds[0]?.textContent?.trim() || '',
      tds[1]?.textContent?.trim() || '',
      tds[2]?.textContent?.trim() || '',
      tds[3]?.textContent?.trim() || '',
      tds[4]?.textContent?.trim() || '',
      tds[5]?.textContent?.trim() || '',
      tds[6]?.textContent?.trim() || '',
      tds[7]?.textContent?.trim() || '',
      tds[8]?.textContent?.trim() || '',
      tds[9]?.textContent?.trim() || ''
    ]);
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(res), 'Resumen');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(abo), 'Abonos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(det), 'Detalle');

  XLSX.writeFile(wb, `finanzas_modal_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ---------------------------------------------------------------
// 10) Modal Abono (crud mínimo: create)
// ---------------------------------------------------------------
function openAbonoModal(){
  if (!MODAL.current || !MODAL.current.servicioId){ alert('Selecciona un servicio con "Ver detalle".'); return; }
  el('abonoServicio').textContent = `${MODAL.current.servicioNombre} · ${MODAL.current.destinoId}`;
  el('abonoFecha').value = new Date().toISOString().slice(0,10);
  el('abonoMoneda').value = 'CLP';
  el('abonoMonto').value = '';
  el('abonoNota').value  = '';
  el('abonoFile').value  = '';
  el('abonoError').style.display = 'none';

  el('abonoBackdrop').style.display = 'block';
  el('abonoModal').style.display = 'block';

  // Cerrar
  const close = ()=>{ el('abonoBackdrop').style.display='none'; el('abonoModal').style.display='none'; };
  el('abonoClose').onclick = close;
  el('abonoCancel').onclick = close;

  // Guardar
  el('abonoSave').onclick = async () => {
    try{
      const fecha   = el('abonoFecha').value;
      const moneda  = el('abonoMoneda').value;
      const monto   = Number(el('abonoMonto').value || 0);
      const nota    = el('abonoNota').value || '';
      const file    = el('abonoFile').files[0] || null;

      if (!fecha || !moneda || !monto || monto<=0){
        el('abonoError').textContent = 'Fecha, moneda y monto son obligatorios.';
        el('abonoError').style.display = 'block';
        return;
      }

      const { destinoId, servicioId } = MODAL.current;
      const data = {
        proveedor: MODAL.provNombre,
        destino: destinoId,
        servicio: MODAL.current.servicioNombre,
        fecha, moneda, monto, nota,
        tcUSD: pickTC('USD')||0, tcBRL: pickTC('BRL')||0, tcARS: pickTC('ARS')||0,
        createdAt: new Date().toISOString(),
      };

      // Adjuntar (opcional)
      if (file){
        const path = `abonos/${destinoId}/${servicioId}/${Date.now()}_${file.name}`;
        const r = sRef(storage, path);
        await uploadBytes(r, file);
        const url = await getDownloadURL(r);
        data.fileUrl = url;
        data.filePath = path;
      }

      await addDoc(collection(db, RUTA_SERVICIOS, destinoId, 'Listado', servicioId, 'Abonos'), data);

      // refrescar abonos + tarjetas
      await loadAbonosServicio(destinoId, servicioId);
      pintarFinanzasServicio(MODAL.current);

      // cerrar
      el('abonoBackdrop').style.display = 'none';
      el('abonoModal').style.display   = 'none';
    }catch(e){
      console.error(e);
      el('abonoError').textContent = 'Error guardando el abono.';
      el('abonoError').style.display = 'block';
    }
  };
}

// ---------------------------------------------------------------
// 11) Recalcular (pantalla principal)
// ---------------------------------------------------------------
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

function logDiagnostico(items){
  const faltantes = items.filter(x => x.nota && x.nota.includes('Sin tarifario'));
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

// ---------------------------------------------------------------
// 12) Boot
// ---------------------------------------------------------------
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
      await Promise.all([
        loadGrupos(),
        loadServicios(),
        loadProveedores(),
        loadHotelesYAsignaciones()
      ]);
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

// Exponer closeModal, openModalProveedor si lo necesitas fuera
window.closeModal = closeModal;
window.openModalProveedor = openModalProveedor;
