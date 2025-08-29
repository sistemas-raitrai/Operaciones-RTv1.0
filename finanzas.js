// finanzas.js — Finanzas Operaciones RT (USD/BRL/ARS + modal por servicio)
// ===============================================================

import { app, db } from './firebase-init.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

// ---------------------------------------------------------------
// 0) Rutas raíz (según tu estructura en Firestore)
// ---------------------------------------------------------------
const RUTA_SERVICIOS  = 'Servicios';   // Servicios/{DESTINO}/Listado/*
const RUTA_PROV_ROOT  = 'Proveedores'; // Proveedores/{DESTINO}/Listado/* (opcional)
const RUTA_HOTEL_ROOT = 'Hoteles';     // Hoteles/{DESTINO}/(Listado|Asignaciones)/*
const RUTA_GRUPOS     = 'grupos';      // grupos/*

// ---------------------------------------------------------------
// 1) Estado + helpers
// ---------------------------------------------------------------
const auth = getAuth(app);

let GRUPOS = [];
let SERVICIOS = [];
let PROVEEDORES = {};
let HOTELES = [];
let ASIGNACIONES = [];

let LINE_ITEMS = []; // actividades
let LINE_HOTEL = []; // hoteles

const el    = id => document.getElementById(id);
const fmt   = n => (n ?? 0).toLocaleString('es-CL');
const money = n => '$' + fmt(Math.round(n || 0));
const slug  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');
const norm  = s => (s || '').toString().normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();

// Unifica variantes de moneda de la BD → USD/BRL/ARS/CLP
function normalizarMoneda(m){
  const M = (m||'').toString().toUpperCase().trim();
  if (['REAL','REALES','R$','BRL'].includes(M)) return 'BRL';
  if (['ARS','AR$','ARG','PESO ARGENTINO','PESOS ARGENTINOS','ARGENTINOS','ARGENTINO'].includes(M)) return 'ARS';
  if (['USD','US$','DOLAR','DÓLAR','DOLLAR'].includes(M)) return 'USD';
  return 'CLP';
}

// pax de grupo
function paxDeGrupo(g) {
  const a = Number(g.adultos || g.ADULTOS || 0);
  const e = Number(g.estudiantes || g.ESTUDIANTES || 0);
  const cg = Number(g.cantidadgrupo || g.CANTIDADGRUPO || g.pax || g.PAX || 0);
  return (a + e) || cg || 0;
}

// YYYY-MM-DD ∈ [d1, d2]
function within(dateISO, d1, d2) {
  if (!dateISO) return false;
  const t  = new Date(dateISO + 'T00:00:00').getTime();
  const t1 = d1 ? new Date(d1 + 'T00:00:00').getTime() : -Infinity;
  const t2 = d2 ? new Date(d2 + 'T00:00:00').getTime() : Infinity;
  return t >= t1 && t <= t2;
}

// Tipo de cambio → CLP (null si no hay)
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

/**
 * Conversión total a TODAS las monedas usando CLP como pivote.
 * Devuelve { USD:null|number, BRL:null|number, ARS:null|number, CLP:null|number }
 * - Siempre respeta la moneda nativa (si no hay TC, al menos esa se ve).
 */
function convertirTodas(monedaOrigen, monto){
  const from = normalizarMoneda(monedaOrigen);
  const tcFrom = pickTC(from);
  const tcUSD  = pickTC('USD');
  const tcBRL  = pickTC('BRL');
  const tcARS  = pickTC('ARS');

  // a CLP: si no hay TC pero es CLP nativo, usamos monto.
  const totalCLP = (from === 'CLP')
    ? (monto ?? null)
    : (tcFrom ? (monto * tcFrom) : null);

  const conv = { USD:null, BRL:null, ARS:null, CLP:totalCLP };

  // helper: CLP → target
  const toTarget = (tcTarget) => (totalCLP != null && tcTarget) ? (totalCLP / tcTarget) : null;

  conv.USD = (from === 'USD') ? (monto ?? null) : toTarget(tcUSD);
  conv.BRL = (from === 'BRL') ? (monto ?? null) : toTarget(tcBRL);
  conv.ARS = (from === 'ARS') ? (monto ?? null) : toTarget(tcARS);

  return conv;
}

// ---------------------------------------------------------------
// 2) Carga de datos
// ---------------------------------------------------------------
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
// 3) Resolver Servicio (match por destino+servicio; desempate por proveedor)
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
// 4) Construcción de line items (actividades y hoteles)
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
            destinoGrupo, fecha: fechaISO,
            grupoId: g.id,
            nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
            numeroNegocio: g.numeroNegocio || g.id,
            identificador: g.identificador || g.IDENTIFICADOR || '',
            pax, moneda:'CLP', tarifa:0,
            pagoTipo:'por_grupo', pagoFrecuencia:'unitario',
            totalMoneda:0, totalCLP:0,
            totalUSD:null, totalBRL:null, totalARS:null,
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

        // conversión total a todas las monedas
        const conv = convertirTodas(moneda, totalMoneda);

        out.push({
          tipo:'actividad',
          proveedor, proveedorSlug:slug(proveedor),
          servicio: svc.servicio || item.actividad || '(sin nombre)',
          destinoGrupo, fecha: fechaISO,
          grupoId: g.id,
          nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
          numeroNegocio: g.numeroNegocio || g.id,
          identificador: g.identificador || g.IDENTIFICADOR || '',
          pax, moneda, tarifa: valor,
          pagoTipo: esPorPersona ? 'por_pax' : 'por_grupo',
          pagoFrecuencia:'unitario',
          totalMoneda,
          totalCLP: conv.CLP,
          totalUSD: conv.USD,
          totalBRL: conv.BRL,
          totalARS: conv.ARS,
          nota:''
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

    const totalMoneda = totalPorNoche * nights.length;
    const conv = convertirTodas(moneda, totalMoneda);

    out.push({
      tipo:'hotel',
      hotel:hotelNombre, destinoGrupo,
      grupoId:g.id, nombreGrupo:g.nombreGrupo || '',
      numeroNegocio:g.numeroNegocio || g.id,
      identificador:g.identificador || g.IDENTIFICADOR || '',
      noches:nights.length,
      moneda, tarifa, tipoCobro,
      totalMoneda,
      totalCLP: conv.CLP,
      totalUSD: conv.USD,
      totalBRL: conv.BRL,
      totalARS: conv.ARS,
    });
  }
  return out;
}

// ---------------------------------------------------------------
// 5) Agregaciones (incluye ARS)
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
// 6) Render UI (kpis + tablas + modal)
// ---------------------------------------------------------------
function renderChipsDestino(destinos) {
  const cont = document.getElementById('chipsDestino');
  if (!cont) return;
  cont.innerHTML = '';
  for (const d of destinos) cont.insertAdjacentHTML('beforeend', `<span class="chip">${d}</span>`);
}

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

// —— Tablas
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

// —— Resumen por servicio (para modal)
function agruparItemsPorServicio(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.servicio || '(sin nombre)';
    const o = map.get(key) || { clp:0, usd:0, brl:0, ars:0, clpConv:0, count:0, items:[] };
    if (it.moneda === 'CLP' && it.totalMoneda) o.clp += it.totalMoneda;
    if (it.moneda === 'USD' && it.totalMoneda) o.usd += it.totalMoneda;
    if (it.moneda === 'BRL' && it.totalMoneda) o.brl += it.totalMoneda;
    if (it.moneda === 'ARS' && it.totalMoneda) o.ars += it.totalMoneda;
    if (typeof it.totalCLP === 'number') o.clpConv += it.totalCLP;
    o.count++; o.items.push(it);
    map.set(key, o);
  }
  return [...map.entries()].map(([servicio,v])=>({servicio,...v}))
                           .sort((a,b)=>b.clpConv - a.clpConv);
}

// Modal detalle proveedor (resumen + detalle CON TODAS LAS MONEDAS)
function openModalProveedor(slugProv, data) {
  const backdrop = el('backdrop');
  const modal = el('modal');

  el('modalTitle').textContent = `Detalle — ${data?.nombre || slugProv}`;
  el('modalSub').textContent   = `Destinos: ${[...data.destinos].join(', ')} • Azul = moneda nativa del ítem`;

  const cont = modal.querySelector('.fin-modal-body');
  const resumen = agruparItemsPorServicio(data.items);

  cont.innerHTML = `
    <div class="scroll-x" style="margin-bottom:.5rem;">
      <table class="fin-table" id="tblProvResumen">
        <thead>
          <tr>
            <th>Servicio</th>
            <th class="right">CLP</th>
            <th class="right">USD</th>
            <th class="right">BRL</th>
            <th class="right">ARS</th>
            <th class="right">Total CLP (conv.)</th>
            <th class="right"># Ítems</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="row" id="detToolbar" style="justify-content:flex-end;margin:.25rem 0 .5rem 0;">
      <button class="btn ghost" id="btnDetClear" style="display:none;">Ver todos</button>
    </div>

    <div class="scroll-x">
      <table class="fin-table" id="tblDetalleProv">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Grupo</th>
            <th>Destino</th>
            <th>Servicio</th>
            <th class="right">Pax</th>
            <th>Modalidad</th>
            <th class="right">Tarifa</th>
            <th class="right">USD</th>
            <th class="right">BRL</th>
            <th class="right">ARS</th>
            <th class="right">CLP</th>
          </tr>
        </thead>
        <tbody></tbody>
        <tfoot><tr>
          <th colspan="10" class="right">Total CLP</th>
          <th id="modalTotalCLP" class="right">$0</th>
        </tr></tfoot>
      </table>
    </div>
  `;

  // Resumen por servicio
  const tbRes = cont.querySelector('#tblProvResumen tbody');
  for (const r of resumen) {
    tbRes.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.servicio}">${r.servicio}</td>
        <td class="right" title="${r.clp}">${fmt(r.clp)}</td>
        <td class="right" title="${r.usd}">${fmt(r.usd)}</td>
        <td class="right" title="${r.brl}">${fmt(r.brl)}</td>
        <td class="right" title="${r.ars}">${fmt(r.ars)}</td>
        <td class="right" title="${r.clpConv}">${money(r.clpConv)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
        <td class="right"><button class="btn secondary btn-det-svc" data-svc="${slug(r.servicio)}">Ver detalle</button></td>
      </tr>
    `);
  }

  // Detalle (con conversiones y azul en nativa)
  const tb = cont.querySelector('#tblDetalleProv tbody');
  tb.innerHTML = '';
  const rows = [...data.items].sort((a,b) =>
    (a.fecha || '').localeCompare(b.fecha || '') ||
    (a.nombreGrupo || '').localeCompare(b.nombreGrupo || '')
  );

  let totCLP = 0;
  for (const it of rows) {
    // recalculamos por si cambió TC en UI:
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (typeof conv.CLP === 'number') totCLP += conv.CLP;

    const cod = [it.numeroNegocio || it.grupoId, it.identificador].filter(Boolean).join('-');
    const grupoTxt = cod ? `${cod} — ${it.nombreGrupo || ''}` : (it.nombreGrupo || it.grupoId || '');

    const cell = (val, isNative) =>
      `<td class="right ${isNative ? 'is-native' : ''}" title="${val==null?'':fmt(val)}">${val==null?'—':fmt(val)}</td>`;

    tb.insertAdjacentHTML('beforeend', `
      <tr data-svc="${slug(it.servicio || '')}">
        <td title="${it.fecha || ''}">${it.fecha || ''}</td>
        <td title="${grupoTxt}">${grupoTxt}</td>
        <td title="${it.destinoGrupo || ''}">${it.destinoGrupo || ''}</td>
        <td title="${it.servicio || ''}">${it.servicio || ''}</td>
        <td class="right" title="${it.pax || 0}">${fmt(it.pax || 0)}</td>
        <td title="${it.pagoTipo === 'por_pax' ? 'por pax' : 'por grupo'} — ${it.pagoFrecuencia || 'unitario'}">
          ${it.pagoTipo === 'por_pax' ? 'por pax' : 'por grupo'} — ${it.pagoFrecuencia || 'unitario'}
        </td>
        <td class="right" title="${it.tarifa || 0}">${fmt(it.tarifa || 0)}</td>
        ${cell(conv.USD, it.moneda==='USD')}
        ${cell(conv.BRL, it.moneda==='BRL')}
        ${cell(conv.ARS, it.moneda==='ARS')}
        ${cell(conv.CLP, it.moneda==='CLP')}
      </tr>
    `);
  }
  el('modalTotalCLP').textContent = money(totCLP);

  // Filtro desde resumen
  const btnClear = cont.querySelector('#btnDetClear');
  cont.querySelectorAll('.btn-det-svc').forEach(btn => {
    btn.addEventListener('click', () => {
      const svc = btn.getAttribute('data-svc');
      const rows = cont.querySelectorAll('#tblDetalleProv tbody tr');
      let hayFiltro = false;
      rows.forEach(tr => {
        const ok = tr.getAttribute('data-svc') === svc;
        tr.style.display = ok ? '' : 'none';
        if (ok) hayFiltro = true;
      });
      btnClear.style.display = hayFiltro ? '' : 'none';
    });
  });
  btnClear.addEventListener('click', () => {
    cont.querySelectorAll('#tblDetalleProv tbody tr').forEach(tr => tr.style.display = '');
    btnClear.style.display = 'none';
  });

  backdrop.style.display = 'block';
  modal.style.display = 'block';
  document.body.classList.add('modal-open');
}

function closeModal() {
  el('backdrop').style.display = 'none';
  el('modal').style.display = 'none';
  document.body.classList.remove('modal-open');
}

// ---------------------------------------------------------------
// 7) Recalcular
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

  if (document.getElementById('chipsDestino')) {
    renderChipsDestino(dests.slice(0,6));
  }
}

function aplicarRangoPorAnio() {
  const anio = el('filtroAnio').value;
  if (!anio) return;
  el('fechaDesde').value = `${anio}-01-01`;
  el('fechaHasta').value = `${anio}-12-31`;
}

// Log auxiliar
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
// 8) Export CSV (mantenemos columnas actuales)
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
// 9) Boot
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

window.closeModal = closeModal;
window.openModalProveedor = openModalProveedor;
