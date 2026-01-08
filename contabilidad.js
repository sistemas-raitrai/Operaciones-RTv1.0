// contador.js (COMPLETO)
// Contador de actividades por fecha (columnas dinámicas) con cruce:
// grupos.itinerario[*].(servicioId / actividad) -> Servicios/{DEST}/Listado/{id} -> proveedor
// + Soporta aliases: Servicios doc puede tener aliases[] y prevIds[] (como tu servicios.js)
// Estética / Auth gate: igual patrón que estadisticas.html

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* =========================
   0) Helpers
========================= */
const $ = (id) => document.getElementById(id);

function normU(s=''){
  return (s ?? '')
    .toString()
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu,'')
    .toUpperCase();
}
function isoToday(){
  const d = new Date();
  const z = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return z.toISOString().slice(0,10);
}
function inRange(dateISO, desde, hasta){
  if (desde && dateISO < desde) return false;
  if (hasta && dateISO > hasta) return false;
  return true;
}
function safeNum(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function setStatus(msg){
  const el = $('status');
  if (el) el.textContent = msg || '';
}

/* =========================
   1) Auth gate
========================= */
onAuthStateChanged(auth, (u) => {
  if (!u) return (location.href = 'login.html');
  init().catch(err => {
    console.error(err);
    alert('Error: ' + (err?.message || err));
  });
});

/* =========================
   2) State + caches
========================= */
const state = {
  loaded: false,
  grupos: [],        // [{id, data}]
  servicesByKey: new Map(), // key -> { destino, id, nombre, proveedor, ciudad, aliases:Set }
  servicesIndex: new Map(), // destino -> Map(key -> serviceObj) (para lookup rápido)
  destinos: ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE','OTRO'],
};

/* =========================
   3) Init UI
========================= */
async function init(){
  setupFilters();
  bindUI();
  await preloadAll();      // carga grupos + servicios
  state.loaded = true;

  // primer render (sin filtros)
  await aplicar();
}

function setupFilters(){
  // destino
  const sel = $('fDestino');
  sel.innerHTML = '';
  sel.appendChild(new Option('— Todos —', 'ALL'));
  state.destinos.forEach(d => sel.appendChild(new Option(d, d)));
  sel.value = 'ALL';

  // fechas por defecto (vacías)
  $('fDesde').value = '';
  $('fHasta').value = '';
}

function bindUI(){
  $('btnAplicar').addEventListener('click', () => aplicar());
  $('btnLimpiar').addEventListener('click', () => {
    $('q').value = '';
    $('fDestino').value = 'ALL';
    $('fDesde').value = '';
    $('fHasta').value = '';
    aplicar();
  });
  $('btnExportar').addEventListener('click', exportXLS);
  $('q').addEventListener('input', () => debounceApply());
  $('fDestino').addEventListener('change', () => aplicar());
  $('fDesde').addEventListener('change', () => aplicar());
  $('fHasta').addEventListener('change', () => aplicar());
  $('btnHoy').addEventListener('click', () => {
    const t = isoToday();
    $('fDesde').value = t;
    $('fHasta').value = t;
    aplicar();
  });
}

let _debT = null;
function debounceApply(){
  clearTimeout(_debT);
  _debT = setTimeout(aplicar, 180);
}

/* =========================
   4) Data loading
========================= */
async function preloadAll(){
  setStatus('Cargando grupos...');
  const gSnap = await getDocs(collection(db, 'grupos'));
  state.grupos = gSnap.docs.map(d => ({ id: d.id, data: d.data() || {} }));

  setStatus('Cargando servicios (para cruce proveedor)...');
  await loadAllServicios();

  setStatus(`Listo ✅ (${state.grupos.length} grupos / ${state.servicesByKey.size} servicios)`);
}

async function loadAllServicios(){
  state.servicesByKey.clear();
  state.servicesIndex.clear();

  // destinos fijos + OTRO (si existe como doc)
  const destinos = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE','OTRO'];

  for (const dest of destinos){
    const idx = new Map();
    state.servicesIndex.set(dest, idx);

    // servicios: Servicios/{dest}/Listado/*
    // Si no existe, simplemente sigue.
    try {
      const snap = await getDocs(query(
        collection(db, 'Servicios', dest, 'Listado'),
        orderBy('servicio','asc')
      ));

      snap.forEach(docSnap => {
        const o = docSnap.data() || {};
        const id = docSnap.id;

        const nombre = normU(o.nombre || o.servicio || id);
        const proveedor = normU(o.proveedor || '');
        const ciudad = normU(o.ciudad || '');
        const aliases = new Set(
          []
            .concat(o.aliases || [])
            .concat(o.prevIds || [])
            .concat([id, nombre])
            .map(normU)
            .filter(Boolean)
        );

        const svc = {
          destino: dest,
          id,
          nombre,          // visible
          proveedor,
          ciudad,
          aliases
        };

        // index por id y por nombre/aliases
        idx.set(normU(id), svc);
        idx.set(nombre, svc);
        aliases.forEach(a => idx.set(a, svc));

        // global map (clave compuesta para no pisar entre destinos)
        // (pero mantenemos también una “vista” por clave simple para export/tabla)
        const globalKey = `${dest}::${normU(id)}`;
        state.servicesByKey.set(globalKey, svc);
      });
    } catch (e) {
      // destino sin colección -> ignora
    }
  }
}

/* =========================
   5) Lookup Servicio (cruce)
========================= */
function findServicio({ destinoHint, servicioId, actividadTxt }){
  const idU = normU(servicioId);
  const actU = normU(actividadTxt);

  // 1) Si tengo destino sugerido, pruebo ahí primero
  if (destinoHint){
    const d = normU(destinoHint);
    const idx = state.servicesIndex.get(d);
    if (idx){
      if (idU && idx.has(idU)) return idx.get(idU);
      if (actU && idx.has(actU)) return idx.get(actU);
    }
  }

  // 2) Sin destino: buscar en todos (primero por ID, luego por texto)
  if (idU){
    for (const idx of state.servicesIndex.values()){
      if (idx.has(idU)) return idx.get(idU);
    }
  }
  if (actU){
    for (const idx of state.servicesIndex.values()){
      if (idx.has(actU)) return idx.get(actU);
    }
  }

  return null;
}

/* =========================
   6) Construcción del “cubo”
   - filas: servicio (actividad)
   - cols: fecha
   - celdas: pax total + #grupos
========================= */
function buildCube({ q, destino, desde, hasta }){
  const qU = normU(q);

  // recolectar fechas (ordenadas)
  const fechasSet = new Set();

  // map filaKey -> filaData
  // filaKey: servicioNombre (visible) + proveedor (para estabilidad)
  const rows = new Map();

  for (const g of state.grupos){
    const G = g.data || {};
    const it = G.itinerario || {};
    if (!it || typeof it !== 'object') continue;

    const gid = g.id;
    const grupoTxt = normU(G.nombreGrupo || G.numeroNegocio || '');

    // destino del grupo (puede existir)
    const grupoDestino = normU(G.destino || G.Destino || '');

    for (const fechaISO of Object.keys(it)){
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) continue;
      if (!inRange(fechaISO, desde, hasta)) continue;

      const acts = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];
      if (!acts.length) continue;

      for (const a0 of acts){
        const A = a0 || {};
        const servicioId = A.servicioId || A.servicio || '';
        const actividad = A.actividad || A.servicioNombre || A.nombre || '';
        const destinoAct = normU(A.servicioDestino || A.destino || grupoDestino || '');

        // filtro destino (sin mostrar columna)
        const destFiltro = normU(destino || 'ALL');
        if (destFiltro !== 'ALL'){
          if (destinoAct !== destFiltro) continue;
        }

        const svc = findServicio({
          destinoHint: destinoAct || null,
          servicioId,
          actividadTxt: actividad
        });

        const nombreVis = normU(
          svc?.nombre ||
          A.servicioNombre ||
          actividad ||
          (servicioId ? servicioId : 'SIN NOMBRE')
        );
        const proveedor = normU(
          svc?.proveedor ||
          A.proveedor ||
          '' // si no hay, queda vacío
        );
        const ciudad = normU(
          svc?.ciudad ||
          A.ciudad ||
          ''
        );

        // pax (intenta varios campos típicos)
        const adultos = safeNum(A.adultos ?? A.Adultos);
        const estudiantes = safeNum(A.estudiantes ?? A.Estudiantes ?? A.paxEstudiantes);
        const pax = safeNum(A.pax ?? A.Pax ?? (adultos + estudiantes));
        const paxTotal = pax || (adultos + estudiantes);

        // buscador (texto concatenado)
        if (qU){
          const hay = normU(
            [
              nombreVis, proveedor, ciudad,
              gid, grupoTxt,
              servicioId
            ].join(' ')
          ).includes(qU);
          if (!hay) continue;
        }

        fechasSet.add(fechaISO);

        const filaKey = `${nombreVis}||${proveedor}||${ciudad}`; // estable
        if (!rows.has(filaKey)){
          rows.set(filaKey, {
            servicio: nombreVis,
            proveedor,
            ciudad,
            // para render / export
            counts: new Map(),        // fecha -> { pax, grupos:Set, hits:number }
            totals: { pax: 0, hits: 0, grupos: new Set() }
          });
        }

        const row = rows.get(filaKey);
        if (!row.counts.has(fechaISO)){
          row.counts.set(fechaISO, { pax: 0, hits: 0, grupos: new Set() });
        }
        const cell = row.counts.get(fechaISO);

        cell.pax += paxTotal;
        cell.hits += 1;
        cell.grupos.add(gid);

        row.totals.pax += paxTotal;
        row.totals.hits += 1;
        row.totals.grupos.add(gid);
      }
    }
  }

  const fechas = [...fechasSet].sort();
  const outRows = [...rows.values()]
    .sort((a,b) => (b.totals.pax - a.totals.pax) || (a.servicio.localeCompare(b.servicio)));

  return { fechas, rows: outRows };
}

/* =========================
   7) Render
========================= */
async function aplicar(){
  if (!state.loaded) return;

  const q = $('q').value || '';
  const destino = $('fDestino').value || 'ALL';
  const desde = $('fDesde').value || '';
  const hasta = $('fHasta').value || '';

  setStatus('Aplicando filtros...');
  const cube = buildCube({ q, destino, desde, hasta });
  renderTable(cube);
  setStatus(`OK ✅ Filas: ${cube.rows.length} · Fechas: ${cube.fechas.length}`);
}

function renderTable({ fechas, rows }){
  const thead = $('thead');
  const tbody = $('tbody');

  // HEAD
  const trh = document.createElement('tr');

  // 3 columnas fijas
  trh.appendChild(th('Servicio', 'ct-sticky-1 ct-col-serv'));
  trh.appendChild(th('Proveedor', 'ct-sticky-2 ct-col-prov'));
  trh.appendChild(th('Ciudad', 'ct-sticky-3 ct-col-city'));

  // fechas dinámicas
  fechas.forEach(f => trh.appendChild(th(f, 'ct-col-date ct-right')));

  // total
  trh.appendChild(th('Total PAX', 'ct-right'));

  thead.innerHTML = '';
  thead.appendChild(trh);

  // BODY
  tbody.innerHTML = '';

  if (!rows.length){
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3 + Math.max(1, fechas.length) + 1;
    td.className = 'ct-empty';
    td.textContent = 'Sin resultados.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  // Totales por fecha (para fila final)
  const totByDate = new Map(fechas.map(f => [f, { pax: 0, grupos: new Set(), hits: 0 }]));
  let grandPax = 0;

  for (const r of rows){
    const tr = document.createElement('tr');

    tr.appendChild(tdTxt(r.servicio, 'ct-sticky-1 ct-col-serv'));
    tr.appendChild(tdTxt(r.proveedor || '—', 'ct-sticky-2 ct-col-prov ct-dim'));
    tr.appendChild(tdTxt(r.ciudad || '—', 'ct-sticky-3 ct-col-city ct-dim'));

    fechas.forEach(f => {
      const c = r.counts.get(f);
      const pax = c?.pax || 0;
      const nG = c?.grupos?.size || 0;

      // sumar totales
      const T = totByDate.get(f);
      T.pax += pax;
      (c?.grupos || new Set()).forEach(x => T.grupos.add(x));
      T.hits += (c?.hits || 0);

      const td = document.createElement('td');
      td.className = 'ct-right ct-mono';
      td.textContent = pax ? `${pax} (${nG})` : '';
      tr.appendChild(td);
    });

    grandPax += r.totals.pax;

    const tdTot = document.createElement('td');
    tdTot.className = 'ct-right ct-mono';
    tdTot.textContent = r.totals.pax ? `${r.totals.pax}` : '';
    tr.appendChild(tdTot);

    tbody.appendChild(tr);
  }

  // Fila totals
  const trT = document.createElement('tr');
  trT.style.background = '#fafafa';
  trT.style.fontWeight = '900';

  trT.appendChild(tdTxt('TOTAL', 'ct-sticky-1 ct-col-serv'));
  trT.appendChild(tdTxt('', 'ct-sticky-2 ct-col-prov'));
  trT.appendChild(tdTxt('', 'ct-sticky-3 ct-col-city'));

  fechas.forEach(f => {
    const T = totByDate.get(f);
    const td = document.createElement('td');
    td.className = 'ct-right ct-mono';
    td.textContent = T.pax ? `${T.pax} (${T.grupos.size})` : '';
    trT.appendChild(td);
  });

  const tdGrand = document.createElement('td');
  tdGrand.className = 'ct-right ct-mono';
  tdGrand.textContent = grandPax ? `${grandPax}` : '';
  trT.appendChild(tdGrand);

  tbody.appendChild(trT);
}

function th(txt, cls=''){
  const el = document.createElement('th');
  el.textContent = txt;
  if (cls) el.className = cls;
  return el;
}
function tdTxt(txt, cls=''){
  const el = document.createElement('td');
  el.textContent = txt ?? '';
  if (cls) el.className = cls;
  return el;
}

/* =========================
   8) Export XLSX (tabla actual)
========================= */
async function exportXLS(){
  try{
    if (!window.XLSX) throw new Error('XLSX no cargado');

    // construir AOA desde la tabla visible
    const headers = [];
    document.querySelectorAll('#thead th').forEach(th => headers.push(th.textContent.trim()));

    const aoa = [headers];
    document.querySelectorAll('#tbody tr').forEach(tr => {
      const row = [];
      tr.querySelectorAll('td').forEach(td => row.push(td.textContent.trim()));
      // evita filas vacías
      if (row.join('').trim()) aoa.push(row);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'CONTADOR');
    const fecha = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `Contador_Actividades_${fecha}.xlsx`);
  } catch(e){
    alert('No se pudo exportar XLSX: ' + (e?.message || e));
  }
}
