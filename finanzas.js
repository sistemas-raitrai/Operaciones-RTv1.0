// finanzas.js — Finanzas Operaciones RT (equivalentes USD/BRL/ARS/CLP + nativa en azul)
// =====================================================================================
// - Todas las tablas de totales ahora muestran equivalentes en cada moneda (USD/BRL/ARS/CLP)
//   usando CLP como pivote (TC → CLP). Si falta un TC, esa parte no se suma.
// - En el modal por proveedor, cada fila muestra USD/BRL/ARS/CLP y se pinta AZUL la moneda nativa.
// - Resto de lógica intacta.

// Firebase
import { app, db } from './firebase-init.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

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

// normaliza la moneda: USD/BRL/ARS/CLP
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
 * Convierte un monto desde su moneda nativa a USD/BRL/ARS/CLP.
 * Usa CLP como pivote (m→CLP con TC origen; CLP→target dividiendo por TC target).
 * Devuelve { USD:null|number, BRL:null|number, ARS:null|number, CLP:null|number }.
 */
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

        if (!svc) {
          out.push({
            tipo:'actividad',
            proveedor: item.proveedor || '(desconocido)',
            proveedorSlug: slug(item.proveedor || '(desconocido)'),
            servicio: item.actividad || item.servicio || '(sin nombre)',
            destinoGrupo, fecha: fechaISO,
            grupoId: g.id, nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
            numeroNegocio: g.numeroNegocio || g.id,
            identificador: g.identificador || g.IDENTIFICADOR || '',
            pax, moneda:'CLP', tarifa:0,
            pagoTipo:'por_grupo', pagoFrecuencia:'unitario',
            totalMoneda:0, totalCLP:0, totalUSD:null, totalBRL:null, totalARS:null,
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
        const conv          = convertirTodas(moneda, totalMoneda);

        out.push({
          tipo:'actividad',
          proveedor, proveedorSlug:slug(proveedor),
          servicio: svc.servicio || item.actividad || '(sin nombre)',
          destinoGrupo, fecha: fechaISO,
          grupoId: g.id, nombreGrupo: g.nombreGrupo || g.NOMBRE || '',
          numeroNegocio: g.numeroNegocio || g.id,
          identificador: g.identificador || g.IDENTIFICADOR || '',
          pax, moneda, tarifa: valor,
          pagoTipo: esPorPersona ? 'por_pax' : 'por_grupo',
          pagoFrecuencia:'unitario',
          totalMoneda,
          totalCLP: conv.CLP, totalUSD: conv.USD, totalBRL: conv.BRL, totalARS: conv.ARS,
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
      totalCLP: conv.CLP, totalUSD: conv.USD, totalBRL: conv.BRL, totalARS: conv.ARS,
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
// 6) Render UI (KPIs + tablas + modal)
// -------------------------------
function renderKPIs(items, itemsHotel) {
  const all = [...items, ...itemsHotel];
  // total CLP equivalente (solo suma donde conv.CLP existe)
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

// — Tablas
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

// — Resumen por servicio (para modal)
function agruparItemsPorServicio(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.servicio || '(sin nombre)';
    const acc = map.get(key) || { usdEq:0, brlEq:0, arsEq:0, clpConv:0, count:0, items:[] };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (conv.CLP != null) acc.clpConv += conv.CLP;
    if (conv.USD != null) acc.usdEq  += conv.USD;
    if (conv.BRL != null) acc.brlEq  += conv.BRL;
    if (conv.ARS != null) acc.arsEq  += conv.ARS;
    acc.count++; acc.items.push(it);
    map.set(key, acc);
  }
  return [...map.entries()].map(([servicio,v])=>({servicio,...v}))
                           .sort((a,b)=>b.clpConv - a.clpConv);
}

// Modal detalle proveedor (equivalentes + nativa en azul)
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
            <th class="right">CLP (eq.)</th>
            <th class="right">USD (eq.)</th>
            <th class="right">BRL (eq.)</th>
            <th class="right">ARS (eq.)</th>
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
          <th colspan="10" class="right">Total CLP (eq.)</th>
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
        <td class="right" title="${r.clpConv}">${money(r.clpConv)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
        <td class="right"><button class="btn secondary btn-det-svc" data-svc="${slug(r.servicio)}">Ver detalle</button></td>
      </tr>
    `);
  }

  // Detalle fila a fila (nativa en azul)
  const tb = cont.querySelector('#tblDetalleProv tbody');
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
    const grupoTxt = cod ? `${cod} — ${it.nombreGrupo || ''}` : (it.nombreGrupo || it.grupoId || '');

    const cell = (val, isNative) => `
      <td class="right" title="${val==null ? '' : fmt(val)}">
        ${val==null ? '—' : (isNative ? `<span class="is-native">${fmt(val)}</span>` : fmt(val))}
      </td>
    `;

    tb.insertAdjacentHTML('beforeend', `
      <tr data-svc="${slug(it.servicio || '')}">
        <td>${it.fecha || ''}</td>
        <td>${grupoTxt}</td>
        <td>${it.destinoGrupo || ''}</td>
        <td>${it.servicio || ''}</td>
        <td class="right">${fmt(it.pax || 0)}</td>
        <td>${it.pagoTipo === 'por_pax' ? 'por pax' : 'por grupo'} — ${it.pagoFrecuencia || 'unitario'}</td>
        <td class="right">${fmt(it.tarifa || 0)}</td>
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

// -------------------------------
// 7) Recalcular
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

// -------------------------------
// 8) Export CSV (igual que antes)
// -------------------------------
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

// -------------------------------
// 9) Boot
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

window.closeModal = closeModal;
window.openModalProveedor = openModalProveedor;
