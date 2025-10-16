// viajes.js — Planificación de Viajes (aéreos/terrestres) RT + TRANSFERS

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, setDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ======= Estado global =======
const COLLECTION_HORARIOS_DRAFT    = 'horarios_draft';
const COLLECTION_HORARIOS_PUBLICOS = 'horarios_publicos';
const auth = getAuth(app);
let grupos = [];               // cache de grupos (para pintar pax/labels)
let vuelos = [];               // cache de docs (aéreo/terrestre)
let isEdit = false;            // flag modal vuelo
let editId = null;             // id del vuelo en edición
let choiceGrupos;              // Choices.js del selector múltiple de grupos
let currentUserEmail;          // email del usuario autenticado
let dtHist = null;             // DataTable historial
let editingTramos = [];        // tramos en el modal (REGULAR)
let paxExtraEditMode = false;  // edición de pax extra
let paxExtraEditIdx = null;    // índice de pax extra en edición
let editingVueloId = null;     // id del vuelo actual para el modal de pax extra

// Índices para transfers (se llenan en renderVuelos)
let transfersByGroup = new Map();              // groupId -> [transferDocs]
let transfersByGroupAndVuelo = new Map();      // `${groupId}__${vueloId}` -> [transferDocs]

// referencias
let transporteEl, tipoVueloEl, multitramoChkEl, camposSimpleEl, multitramoOpEl, tramosSectionEl;
let publicarOpEl; // cache del bloque PUBLICAR

function refreshUI(){
  const t    = transporteEl?.value || 'aereo';
  const tipo = tipoVueloEl?.value  || 'charter';
  const usarMulti = (t === 'aereo' && tipo === 'regular' && !!multitramoChkEl?.checked);

  // 0) PUBLICAR: SIEMPRE visible
  (publicarOpEl ||= document.getElementById('publicacion-opcion'));
  if (publicarOpEl) publicarOpEl.style.display = '';

  // 1) Habilitar/Deshabilitar selector de tipo
  if (tipoVueloEl) tipoVueloEl.disabled = (t !== 'aereo');

  // 2) Mostrar opción Multitramos solo si AÉREO REGULAR
  if (multitramoOpEl) {
    multitramoOpEl.style.display = (t === 'aereo' && tipo === 'regular') ? '' : 'none';
  }

  // 3) Si NO es AÉREO o NO es REGULAR, apaga el check de multitramos
  if ((t !== 'aereo' || tipo !== 'regular') && multitramoChkEl) {
    multitramoChkEl.checked = false;
  }

  // 4) Conmutar “simple” vs “tramos”
  if (camposSimpleEl)  camposSimpleEl.style.display  = usarMulti ? 'none'  : 'block';
  if (tramosSectionEl) tramosSectionEl.style.display = usarMulti ? 'block' : 'none';
}

// ======= Helpers de normalización =======

const pad2 = (n) => String(n).padStart(2,'0');
function toUpper(x){ return (typeof x === 'string') ? x.toUpperCase() : x; }

// Normaliza fecha a 'YYYY-MM-DD' (acepta string/Date)
function toISO(x){
  if (!x) return '';
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const d = new Date(x);
  return isNaN(d) ? '' : d.toISOString().slice(0,10);
}

// Convierte "ABC123, xyz-9  DEF" -> ["ABC123", "XYZ-9", "DEF"] (sin duplicados)
function parseRecordsInput(x){
  return Array.from(new Set(
    String(x || '')
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
  )).map(toUpper);
}

// Normaliza hora a 'HH:MM' 24h (si viene mal/empty -> '')
function toHHMM(x){
  if (!x) return '';
  let s = String(x).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  let hh = Math.max(0, Math.min(23, parseInt(m[1],10)));
  let mm = Math.max(0, Math.min(59, parseInt(m[2],10)));
  return `${pad2(hh)}:${pad2(mm)}`;
}

// Denormaliza array de grupos → grupoIds: string[]
function buildGrupoIds(gruposArr){
  return Array.from(new Set(
    (Array.isArray(gruposArr) ? gruposArr : [])
      .map(g => String(g?.id || '').trim())
      .filter(Boolean)
  )).sort();
}

// Helper nombres de grupo (para pintar/filtrar)
function groupDisplay(gId){
  const g = grupos.find(x => x.id === gId);
  if (!g) return gId;
  return `${toUpper(g.numeroNegocio)} - ${toUpper(g.identificador)} – ${toUpper(g.nombreGrupo)}`;
}

// Normaliza payload de doc (aéreo/terrestre)
function normalizeVueloPayload(pay){
  // Transporte por defecto
  pay.tipoTransporte = pay.tipoTransporte || 'aereo';

  // ===== Normalización por tramos (regular multitramo) =====
  if (Array.isArray(pay.tramos)){
    pay.tramos = pay.tramos.map(t => {
      const nt = {
        ...t,
        aerolinea: toUpper(t.aerolinea || ''),
        numero:    toUpper(t.numero || ''),
        origen:    toUpper(t.origen || ''),
        destino:   toUpper(t.destino || ''),
        fechaIda:    toISO(t.fechaIda),
        fechaVuelta: toISO(t.fechaVuelta),
        presentacionIdaHora:     toHHMM(t.presentacionIdaHora),
        vueloIdaHora:            toHHMM(t.vueloIdaHora),
        presentacionVueltaHora:  toHHMM(t.presentacionVueltaHora),
        vueloVueltaHora:         toHHMM(t.vueloVueltaHora),
      };
      let tipoTramo = (t.tipoTramo || '').toLowerCase();
      if (!tipoTramo){
        const hasIda    = !!nt.fechaIda;
        const hasVuelta = !!nt.fechaVuelta;
        if (hasIda && hasVuelta) tipoTramo = 'ida+vuelta';
        else if (hasIda)         tipoTramo = 'ida';
        else if (hasVuelta)      tipoTramo = 'vuelta';
        else                     tipoTramo = 'ida+vuelta';
      }
      nt.tipoTramo = tipoTramo;
      if (nt.tipoTramo === 'ida'){
        nt.fechaVuelta = '';
        nt.presentacionVueltaHora = '';
        nt.vueloVueltaHora = '';
      } else if (nt.tipoTramo === 'vuelta'){
        nt.fechaIda = '';
        nt.presentacionIdaHora = '';
        nt.vueloIdaHora = '';
      }
      return nt;
    });
  }

  // ===== Top-level fechas/origen/destino =====
  if (pay.tipoTransporte === 'aereo' && pay.tipoVuelo === 'regular' && pay.tramos && pay.tramos.length){
    const idas    = pay.tramos.map(t => toISO(t.fechaIda)).filter(Boolean).sort();
    const vueltas = pay.tramos.map(t => toISO(t.fechaVuelta)).filter(Boolean).sort();
    pay.fechaIda    = idas[0] || toISO(pay.fechaIda);
    pay.fechaVuelta = vueltas.length ? vueltas[vueltas.length - 1] : toISO(pay.fechaVuelta);
    const tPrimIda = pay.tramos.find(t => t.fechaIda);
    const tPrim    = pay.tramos[0];
    const tUltVta  = [...pay.tramos].reverse().find(t => t.fechaVuelta);
    const tUltIda  = [...pay.tramos].reverse().find(t => t.fechaIda);
    const tUlt     = pay.tramos[pay.tramos.length - 1];
    pay.origen  = pay.origen  || (tPrimIda?.origen || tPrim?.origen || '');
    pay.destino = pay.destino || (tUltVta?.destino || tUltIda?.destino || tUlt?.destino || '');
  } else {
    pay.fechaIda    = toISO(pay.fechaIda);
    pay.fechaVuelta = toISO(pay.fechaVuelta);
  }

  // ===== Top-level horas según transporte/tipo =====
  if (pay.tipoTransporte === 'aereo'){
    pay.presentacionIdaHora     = toHHMM(pay.presentacionIdaHora);
    pay.vueloIdaHora            = toHHMM(pay.vueloIdaHora);
    pay.presentacionVueltaHora  = toHHMM(pay.presentacionVueltaHora);
    pay.vueloVueltaHora         = toHHMM(pay.vueloVueltaHora);
  } else if (pay.tipoTransporte === 'terrestre'){
    pay.idaHora    = toHHMM(pay.idaHora);
    pay.vueltaHora = toHHMM(pay.vueltaHora);
  }

  // ===== Grupos (para docs que los tengan en-línea, p.ej. aéreos) =====
  pay.grupos = Array.isArray(pay.grupos) ? pay.grupos.map(g => ({
    id: g.id,
    status: g.status || 'confirmado',
    changedBy: g.changedBy || '',
    reservas: Array.isArray(g.reservas) ? g.reservas.filter(Boolean) : []
  })) : [];

  // ===== Flags transfer (solo para terrestres, pero no estorban)
  pay.isTransfer = !!pay.isTransfer;
  if (pay.isTransfer){
    const leg = (pay.transferLeg || '').toLowerCase();
    pay.transferLeg = ['ida','vuelta','ida+vuelta'].includes(leg) ? leg : 'ida';
    // Evitar doble contabilización en totales del aéreo
    pay.excludeFromTotals = true;
  } else {
    // por defecto no excluir
    pay.excludeFromTotals = !!pay.excludeFromTotals;
  }

  // Vínculos
  if (Array.isArray(pay.grupoIds)){
    pay.grupoIds = pay.grupoIds.filter(Boolean).map(String).sort();
  }

  return pay;
}

// ======= Helpers de UI/formatos =======

function fmtFecha(iso){
  const dt = new Date(iso + 'T00:00:00');
  return dt.toLocaleDateString('es-CL', {
    weekday:'long', day:'2-digit', month:'long', year:'numeric'
  }).replace(/(^\w)/, m => m.toUpperCase());
}

function fmtFechaLarga(iso){
  if (!iso) return '';
  const dt = new Date(iso + 'T00:00:00');
  return dt.toLocaleDateString('es-CL', {
    weekday:'long', day:'2-digit', month:'long', year:'numeric'
  }).toUpperCase();
}

// ======= Chips de reserva =======

function daysUntil(iso){
  if (!iso) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(iso + 'T00:00:00');
  const diffMs = d - today;
  return Math.floor(diffMs / (1000*60*60*24));
}

function reservaChipMeta(v){
  const estado = (v.reservaEstado || 'pendiente').toLowerCase();
  if (estado === 'enviada') return { texto:'📨 RESERVA ENVIADA', claseExtra:'chip-verde' };
  const dd = daysUntil(v.reservaFechaLimite);
  if (dd === null) return { texto:'⏳ RESERVA PENDIENTE', claseExtra:'chip-gris' };
  if (dd < 0)      return { texto:'⏳ RESERVA PENDIENTE', claseExtra:'chip-rojo' };
  if (dd <= 7)     return { texto:'⏳ RESERVA PENDIENTE', claseExtra:'chip-ambar' };
  return { texto:'⏳ RESERVA PENDIENTE', claseExtra:'chip-gris' };
}

// ======= Autenticación y arranque =======

onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  currentUserEmail = user.email;
  init();
});

async function init(){
  await loadGrupos();
  bindUI();
  initModal();
  await renderVuelos();

  // Modales de grupo e historial
  document.getElementById('group-cancel').onclick = closeGroupModal;
  document.getElementById('group-form').onsubmit  = onSubmitGroup;

  document.getElementById('btnHistorial').onclick = showHistorialModal;
  document.getElementById('hist-close').onclick   = closeHistorialModal;
  document.getElementById('hist-refresh').onclick = loadHistorial;
  document.getElementById('hist-start').onchange  = loadHistorial;
  document.getElementById('hist-end').onchange    = loadHistorial;
}

async function loadGrupos(){
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

// ======= UI principal =======

function bindUI(){
  document.getElementById('btnAddVuelo').onclick    = () => openModal();
  document.getElementById('btnExportExcel').onclick = exportToExcel;

  const searchEl = document.getElementById('search-input');
  searchEl.oninput = () => filterVuelos(searchEl.value.trim().toLowerCase());
}

// Filtro simple (muestra/oculta cards por términos separados por coma)
function filterVuelos(rawQuery){
  const terms = rawQuery.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  document.querySelectorAll('.flight-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    const match = terms.length === 0 ? true : terms.some(term => text.includes(term));
    card.style.display = match ? '' : 'none';
  });
}

// Permite filtrar rápidamente al hacer clic en una chip de RECORD
window.filterByRecord = (rec) => {
  const searchEl = document.getElementById('search-input');
  if (searchEl){
    searchEl.value = rec;
    filterVuelos(rec.toLowerCase());
  }
};

// Lista “resumen” opcional (si usas las 3 tablas)
function renderFlightsList(){
  const tables = document.querySelectorAll('.flights-list');
  if (!tables.length) return;
  const perColumn = Math.ceil(vuelos.length / tables.length);
  const searchEl = document.getElementById('search-input');

  tables.forEach((table, colIdx) => {
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    const start = colIdx * perColumn;
    const end   = start + perColumn;
    const chunk = vuelos.slice(start, end);

    chunk.forEach(v => {
      const airline   = v.proveedor || v.tramos?.[0]?.aerolinea || '–';
      const flightNum = v.numero    || v.tramos?.[0]?.numero    || '–';
      const date      = v.tramos?.[0]?.fechaIda || v.fechaIda || '–';

      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td style="padding:.3em .5em;">${airline}</td>
        <td style="padding:.3em .5em;">${flightNum}</td>
        <td style="padding:.3em .5em;">${date}</td>
      `;
      tr.onclick = () => {
        searchEl.value = flightNum;
        filterVuelos(flightNum.toLowerCase());
        const selector = `.flight-card[data-flight="${flightNum}"][data-date="${date}"]`;
        const target = document.querySelector(selector);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.classList.add('highlight');
          setTimeout(() => target.classList.remove('highlight'), 1500);
        }
      };
      tbody.appendChild(tr);
    });
  });
}

// ======= Modal vuelo =======

function initModal(){
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit  = onSubmitVuelo;

  // Referencias del modal
  transporteEl    = document.getElementById('m-transporte');   // aereo | terrestre
  tipoVueloEl     = document.getElementById('m-tipoVuelo');    // charter | regular
  multitramoChkEl = document.getElementById('m-multitramo');   // checkbox
  camposSimpleEl  = document.getElementById('campos-vuelo-simple');
  multitramoOpEl  = document.getElementById('multitramo-opcion');
  tramosSectionEl = document.getElementById('tramos-section');

  // Choices.js (GRUPOS)
  choiceGrupos = new Choices(document.getElementById('m-grupos'), { removeItemButton:true });
  choiceGrupos.setChoices(
    grupos.map(g => ({
      value: g.id,
      label: toUpper(`${g.numeroNegocio} - ${g.identificador} – ${g.nombreGrupo}`)
    })),
    'value','label', false
  );

  // Listeners → delega comportamiento a refreshUI()
  if (transporteEl)    transporteEl.addEventListener('change', refreshUI);
  if (tipoVueloEl)     tipoVueloEl.addEventListener('change', refreshUI);
  if (multitramoChkEl) multitramoChkEl.addEventListener('change', refreshUI);

  // Estado inicial del modal
  if (transporteEl)    transporteEl.value = 'aereo';
  if (tipoVueloEl)     tipoVueloEl.value  = 'charter';
  if (multitramoChkEl) multitramoChkEl.checked = false;

  // Pinta visibilidad inicial (simple vs tramos, etc.)
  refreshUI();

  // Botón agregar tramo (en modo multitramos)
  const addTramoBtn = document.getElementById('btnAddTramo');
  if (addTramoBtn) addTramoBtn.onclick = addTramoRow;

  // PAX extra
  const addPaxBtn = document.getElementById('btnAddPaxExtra');
  if (addPaxBtn) addPaxBtn.onclick = () => openPaxExtraModal(editingVueloId);

  document.getElementById('paxextra-cancel').onclick = closePaxExtraModal;
  document.getElementById('paxextra-form').onsubmit  = onSubmitPaxExtra;
}

function openModal(v=null){
  isEdit = !!v;
  editId = v?.id || null;
  editingVueloId = v?.id || null;
  document.getElementById('modal-title').textContent = v ? 'EDITAR VUELO/TRAYECTO' : 'NUEVO VUELO/TRAYECTO';

  // Transporte + Tipo
  const mTrans = document.getElementById('m-transporte');
  if (mTrans) mTrans.value = v?.tipoTransporte || 'aereo';

  const publicarChk = document.getElementById('m-publicar');
  if (publicarChk){
    publicarChk.checked = !!(v?.publicar);
  }

  ['proveedor','numero','tipoVuelo','origen','destino','fechaIda','fechaVuelta']
    .forEach(k => {
      const el = document.getElementById(`m-${k}`);
      if (el) el.value = v?.[k] || '';
    });

  const f = (id) => document.getElementById(id);
  if (f('m-presentacionIdaHora'))    f('m-presentacionIdaHora').value    = v?.presentacionIdaHora || '';
  if (f('m-vueloIdaHora'))           f('m-vueloIdaHora').value           = v?.vueloIdaHora || '';
  if (f('m-presentacionVueltaHora')) f('m-presentacionVueltaHora').value = v?.presentacionVueltaHora || '';
  if (f('m-vueloVueltaHora'))        f('m-vueloVueltaHora').value        = v?.vueloVueltaHora || '';

  if (f('m-idaHora'))    f('m-idaHora').value    = v?.idaHora || '';
  if (f('m-vueltaHora')) f('m-vueltaHora').value = v?.vueltaHora || '';

  if (f('m-reservaFechaLimite')) f('m-reservaFechaLimite').value = v?.reservaFechaLimite || '';
  if (f('m-reservaEstado'))      f('m-reservaEstado').value      = v?.reservaEstado || 'pendiente';

  if (tipoVueloEl) tipoVueloEl.value = v?.tipoVuelo || 'charter';
  if (camposSimpleEl)  camposSimpleEl.style.display = 'block';
  if (multitramoOpEl)  multitramoOpEl.style.display = (v?.tipoVuelo === 'regular') ? 'block' : 'none';
  if (tramosSectionEl) tramosSectionEl.style.display = 'none';
  if (multitramoChkEl) multitramoChkEl.checked = false;

  if (v && v.tipoTransporte !== 'terrestre' && v.tipoVuelo === 'regular'){
    if (multitramoOpEl) multitramoOpEl.style.display = 'block';
    if (v.tramos && v.tramos.length){
      if (multitramoChkEl) multitramoChkEl.checked = true;
      if (camposSimpleEl)  camposSimpleEl.style.display = 'none';
      if (tramosSectionEl) tramosSectionEl.style.display = 'block';
      editingTramos = v.tramos.map(t => ({
        aerolinea: t.aerolinea || '',
        numero: t.numero || '',
        origen: t.origen || '',
        destino: t.destino || '',
        tipoTramo: (t.tipoTramo || '').toLowerCase() || (t.fechaIda && t.fechaVuelta ? 'ida+vuelta' : (t.fechaIda ? 'ida' : (t.fechaVuelta ? 'vuelta' : 'ida+vuelta'))),
        fechaIda: t.fechaIda || '',
        presentacionIdaHora: t.presentacionIdaHora || '',
        vueloIdaHora: t.vueloIdaHora || '',
        fechaVuelta: t.fechaVuelta || '',
        presentacionVueltaHora: t.presentacionVueltaHora || '',
        vueloVueltaHora: t.vueloVueltaHora || ''
      }));
      renderTramosList();
    } else {
      if (multitramoChkEl) multitramoChkEl.checked = false;
      if (camposSimpleEl)  camposSimpleEl.style.display = 'block';
      if (tramosSectionEl) tramosSectionEl.style.display = 'none';
      editingTramos = [];
      renderTramosList();
    }
  } else {
    editingTramos = [];
    renderTramosList();
  }

  // Grupos y estado por defecto
  choiceGrupos.removeActiveItems();
  if (v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g => g.id));
  if (f('m-statusDefault')) f('m-statusDefault').value = v?.grupos?.[0]?.status || 'confirmado';

  // Mostrar modal
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-vuelo').style.display    = 'block';
}

function closeModal(){
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-vuelo').style.display    = 'none';
}

// ======= Tramos (UI dinámico) =======
function renderTramosList(){
  const cont = document.getElementById('tramos-list');
  if (!cont) return;
  cont.innerHTML = '';

  editingTramos.forEach((t,i) => {
    const tipo = (t.tipoTramo || 'ida+vuelta').toLowerCase();
    const row = document.createElement('div');
    row.className = 'tramo-block';
    row.innerHTML = `
      <div class="tramo-head">
        <input class="long" type="text"  value="${toUpper(t.aerolinea||'')}" placeholder="AEROLÍNEA" data-t="aerolinea" data-i="${i}"/>
        <input type="text"              value="${toUpper(t.numero||'')}"    placeholder="N°"        data-t="numero" data-i="${i}"/>
        <input class="long" type="text"  value="${toUpper(t.origen||'')}"    placeholder="ORIGEN"    data-t="origen" data-i="${i}"/>
        <input class="long" type="text"  value="${toUpper(t.destino||'')}"   placeholder="DESTINO"   data-t="destino" data-i="${i}"/>
        <button type="button" class="tramo-remove" onclick="removeTramo(${i})">X</button>
      </div>
      <div class="tramo-type">
        <label><input type="radio" name="tipoTramo_${i}" value="ida" ${tipo==='ida'?'checked':''}/> Solo IDA</label>
        <label><input type="radio" name="tipoTramo_${i}" value="vuelta" ${tipo==='vuelta'?'checked':''}/> Solo REGRESO</label>
        <label><input type="radio" name="tipoTramo_${i}" value="ida+vuelta" ${tipo==='ida+vuelta'?'checked':''}/> IDA + REGRESO</label>
      </div>
      <div class="tramo-body">
        <div class="tramo-line tramo-ida">
          <span class="tag">IDA</span>
          <input type="date" value="${t.fechaIda||''}" data-t="fechaIda" data-i="${i}"/>
          <input type="time" value="${t.presentacionIdaHora||''}" title="Presentación IDA" data-t="presentacionIdaHora" data-i="${i}"/>
          <input type="time" value="${t.vueloIdaHora||''}"        title="Vuelo IDA"        data-t="vueloIdaHora"        data-i="${i}"/>
        </div>
        <div class="tramo-line tramo-vuelta">
          <span class="tag">REGRESO</span>
          <input type="date" value="${t.fechaVuelta||''}" data-t="fechaVuelta" data-i="${i}"/>
          <input type="time" value="${t.presentacionVueltaHora||''}" title="Presentación REGRESO" data-t="presentacionVueltaHora" data-i="${i}"/>
          <input type="time" value="${t.vueloVueltaHora||''}"        title="Vuelo REGRESO"       data-t="vueloVueltaHora"        data-i="${i}"/>
        </div>
      </div>
    `;

    row.querySelectorAll('input[type="text"], input[type="date"], input[type="time"]').forEach(inp => {
      const key = inp.dataset.t;
      const idx = +inp.dataset.i;
      if (!key) return;
      inp.onchange = () => {
        if (key === 'fechaIda' || key === 'fechaVuelta') {
          editingTramos[idx][key] = toISO(inp.value);
        } else if (key.endsWith('Hora')) {
          editingTramos[idx][key] = toHHMM(inp.value);
        } else {
          editingTramos[idx][key] = toUpper(inp.value);
        }
      };
    });

    row.querySelectorAll(`input[name="tipoTramo_${i}"]`).forEach(r => {
      r.onchange = () => {
        editingTramos[i].tipoTramo = r.value;
        const idaRow    = row.querySelector('.tramo-ida');
        const vueltaRow = row.querySelector('.tramo-vuelta');
        if (r.value === 'ida'){
          vueltaRow.style.display = 'none';
          editingTramos[i].fechaVuelta = '';
          editingTramos[i].presentacionVueltaHora = '';
          editingTramos[i].vueloVueltaHora = '';
          vueltaRow.querySelectorAll('input').forEach(x => x.value = '');
          idaRow.style.display = '';
        } else if (r.value === 'vuelta'){
          idaRow.style.display = 'none';
          editingTramos[i].fechaIda = '';
          editingTramos[i].presentacionIdaHora = '';
          editingTramos[i].vueloIdaHora = '';
          idaRow.querySelectorAll('input').forEach(x => x.value = '');
          vueltaRow.style.display = '';
        } else {
          idaRow.style.display = '';
          vueltaRow.style.display = '';
        }
      };
    });

    const idaRow    = row.querySelector('.tramo-ida');
    const vueltaRow = row.querySelector('.tramo-vuelta');
    if (tipo === 'ida'){ vueltaRow.style.display = 'none'; }
    else if (tipo === 'vuelta'){ idaRow.style.display = 'none'; }
    else { idaRow.style.display = ''; vueltaRow.style.display = ''; }

    cont.appendChild(row);
  });
}

window.removeTramo = (idx) => {
  editingTramos.splice(idx,1);
  renderTramosList();
};

function addTramoRow(){
  editingTramos.push({
    aerolinea:'', numero:'', origen:'', destino:'',
    tipoTramo:'ida+vuelta',
    fechaIda:'', presentacionIdaHora:'', vueloIdaHora:'',
    fechaVuelta:'', presentacionVueltaHora:'', vueloVueltaHora:''
  });
  renderTramosList();
}

// ======= Guardar / Editar doc (vuelo/trayecto) =======

async function onSubmitVuelo(evt){
  evt.preventDefault();
  const f = (id) => document.getElementById(id);
  const reservaFechaLimite = f('m-reservaFechaLimite')?.value || null;
  const reservaEstadoForm  = (f('m-reservaEstado')?.value) || 'pendiente';
  const tipoVuelo = f('m-tipoVuelo')?.value || 'charter';
  const tipoTransporte = f('m-transporte')?.value || 'aereo';
  const publicar = !!document.getElementById('m-publicar')?.checked;

  // Grupos seleccionados (preserva records al editar)
  const sel = choiceGrupos.getValue(true);
  const defaultStatus = f('m-statusDefault')?.value || 'confirmado';

  let prevDoc = null;
  if (isEdit && editId){
    const prevSnap = await getDoc(doc(db,'vuelos', editId));
    prevDoc = prevSnap.exists() ? prevSnap.data() : null;
  }

  const gruposArr = sel.map(id => {
    const prevG = prevDoc?.grupos?.find(g => g.id === id);
    return {
      id,
      status: prevG?.status ?? defaultStatus,
      changedBy: currentUserEmail,
      reservas: Array.isArray(prevG?.reservas) ? prevG.reservas : []
    };
  });

  let pay = {};
  const multitramo = multitramoChkEl && multitramoChkEl.checked;

  // Validación: al menos una pierna real (tramos) en aéreo regular multi
  if (tipoTransporte === 'aereo' && tipoVuelo === 'regular' && multitramo){
    const hasAnyLeg = editingTramos.some(t => toISO(t.fechaIda) || toISO(t.fechaVuelta));
    if (!hasAnyLeg){
      alert('Debes ingresar al menos una IDA o una VUELTA en los tramos.');
      return;
    }
  }

  if (tipoTransporte === 'aereo' && tipoVuelo === 'regular' && multitramo){
    pay = {
      tipoTransporte: 'aereo',
      tipoVuelo: 'regular',
      tramos: editingTramos.map(t => {
        const tipo = (t.tipoTramo || 'ida+vuelta').toLowerCase();
        const base = {
          aerolinea: toUpper(t.aerolinea),
          numero:    toUpper(t.numero),
          origen:    toUpper(t.origen),
          destino:   toUpper(t.destino),
          tipoTramo: tipo,
          fechaIda:  toISO(t.fechaIda),
          presentacionIdaHora: toHHMM(t.presentacionIdaHora),
          vueloIdaHora:        toHHMM(t.vueloIdaHora),
          fechaVuelta:  toISO(t.fechaVuelta),
          presentacionVueltaHora: toHHMM(t.presentacionVueltaHora),
          vueloVueltaHora:        toHHMM(t.vueloVueltaHora)
        };
        if (tipo === 'ida'){
          base.fechaVuelta = '';
          base.presentacionVueltaHora = '';
          base.vueloVueltaHora = '';
        } else if (tipo === 'vuelta'){
          base.fechaIda = '';
          base.presentacionIdaHora = '';
          base.vueloIdaHora = '';
        }
        return base;
      }),
      grupos: gruposArr,
      reservaFechaLimite,
      reservaEstado: reservaEstadoForm
    };
  } else if (tipoTransporte === 'aereo' && tipoVuelo === 'regular'){ // regular simple
    pay = {
      tipoTransporte: 'aereo',
      tipoVuelo: 'regular',
      tramos: [],
      proveedor: toUpper(f('m-proveedor')?.value?.trim() || ''),
      numero:    toUpper(f('m-numero')?.value?.trim() || ''),
      origen:    toUpper(f('m-origen')?.value?.trim() || ''),
      destino:   toUpper(f('m-destino')?.value?.trim() || ''),
      fechaIda:  f('m-fechaIda')?.value || '',
      fechaVuelta: f('m-fechaVuelta')?.value || '',
      presentacionIdaHora:     toHHMM(f('m-presentacionIdaHora')?.value || ''),
      vueloIdaHora:            toHHMM(f('m-vueloIdaHora')?.value || ''),
      presentacionVueltaHora:  toHHMM(f('m-presentacionVueltaHora')?.value || ''),
      vueloVueltaHora:         toHHMM(f('m-vueloVueltaHora')?.value || ''),
      grupos: gruposArr,
      reservaFechaLimite,
      reservaEstado: reservaEstadoForm
    };
  } else if (tipoTransporte === 'aereo') { // CHARTER
    pay = {
      tipoTransporte: 'aereo',
      proveedor: toUpper(f('m-proveedor')?.value?.trim() || ''),
      numero:    toUpper(f('m-numero')?.value?.trim() || ''),
      tipoVuelo,
      origen:    toUpper(f('m-origen')?.value?.trim() || ''),
      destino:   toUpper(f('m-destino')?.value?.trim() || ''),
      fechaIda:  f('m-fechaIda')?.value || '',
      fechaVuelta: f('m-fechaVuelta')?.value || '',
      presentacionIdaHora:     toHHMM(f('m-presentacionIdaHora')?.value || ''),
      vueloIdaHora:            toHHMM(f('m-vueloIdaHora')?.value || ''),
      presentacionVueltaHora:  toHHMM(f('m-presentacionVueltaHora')?.value || ''),
      vueloVueltaHora:         toHHMM(f('m-vueloVueltaHora')?.value || ''),
      grupos: gruposArr,
      reservaFechaLimite,
      reservaEstado: reservaEstadoForm
    };
  } else {
    // TERRESTRE (bus) normal (no transfer)
    pay = {
      tipoTransporte: 'terrestre',
      proveedor: toUpper(f('m-proveedor')?.value?.trim() || ''),
      numero:    toUpper(f('m-numero')?.value?.trim() || ''),
      origen:    toUpper(f('m-origen')?.value?.trim() || ''),
      destino:   toUpper(f('m-destino')?.value?.trim() || ''),
      fechaIda:  f('m-fechaIda')?.value || '',
      fechaVuelta: f('m-fechaVuelta')?.value || '',
      idaHora:    toHHMM(f('m-idaHora')?.value || ''),
      vueltaHora: toHHMM(f('m-vueltaHora')?.value || ''),
      grupos: gruposArr,
      reservaFechaLimite,
      reservaEstado: reservaEstadoForm,
      isTransfer: false,
      excludeFromTotals: false
    };
  }

  // Normaliza + agrega claves mínimas
  pay = normalizeVueloPayload(pay);
  // Marcas de publicación en el doc de 'vuelos'
  pay.publicar      = publicar;
  pay.publishScope  = publicar ? 'PUBLICA' : 'PRIVADA';
  pay.publicUpdatedBy = currentUserEmail;

  pay.grupoIds  = buildGrupoIds(pay.grupos);
  pay.updatedAt = serverTimestamp();

  if (isEdit){
    const ref = doc(db,'vuelos', editId);
    const before = prevDoc ?? (await getDoc(ref)).data();
    if ((before?.reservaEstado || 'pendiente') !== (pay.reservaEstado || 'pendiente')){
      pay.reservaChangedBy = currentUserEmail;
      pay.reservaTs = serverTimestamp();
    }
    await updateDoc(ref, pay);
    await addDoc(collection(db,'historial'), {
      tipo:'vuelo-edit', vueloId:editId,
      antes: before, despues: pay,
      usuario: currentUserEmail, ts: serverTimestamp()
    });
    // ⇢ Mantener espejo de horarios (draft + público opcional)
    await upsertHorarios(pay, editId, publicar, !!before?.publicar);

  } else {
    pay.createdAt = serverTimestamp();
    const ref = await addDoc(collection(db,'vuelos'), pay);
    await addDoc(collection(db,'historial'), {
      tipo:'vuelo-new', vueloId: ref.id,
      antes: null, despues: pay,
      usuario: currentUserEmail, ts: serverTimestamp()
    });
    // ⇢ Mantener espejo de horarios (draft + público opcional)
    await upsertHorarios(pay, ref.id, publicar, false);
  }

  closeModal();
  renderVuelos();
}

// ======= Pax Extra =======

function openPaxExtraModal(vueloId){
  editingVueloId = vueloId;
  paxExtraEditMode = false;
  paxExtraEditIdx = null;
  document.getElementById('paxextra-nombre').value   = '';
  document.getElementById('paxextra-cantidad').value = 1;
  document.getElementById('paxextra-status').value   = 'pendiente';
  document.getElementById('paxextra-records').value  = '';
  document.getElementById('paxextra-backdrop').style.display = 'block';
  document.getElementById('paxextra-modal').style.display    = 'block';
}
window.openPaxExtraModal = openPaxExtraModal;

window.editPaxExtra = (vueloId, idx) => {
  paxExtraEditMode = true;
  paxExtraEditIdx  = idx;
  editingVueloId   = vueloId;
  getDoc(doc(db,'vuelos', vueloId)).then(snap => {
    const data = snap.data() || {};
    const pax = (data.paxExtras || [])[idx] || {};
    document.getElementById('paxextra-nombre').value   = pax.nombre || '';
    document.getElementById('paxextra-cantidad').value = pax.cantidad || 1;
    document.getElementById('paxextra-status').value   = pax.status || 'pendiente';
    document.getElementById('paxextra-records').value  = (pax.records || []).join(', ');
    document.getElementById('paxextra-backdrop').style.display = 'block';
    document.getElementById('paxextra-modal').style.display    = 'block';
  });
};

function closePaxExtraModal(){
  document.getElementById('paxextra-backdrop').style.display = 'none';
  document.getElementById('paxextra-modal').style.display    = 'none';
}

async function onSubmitPaxExtra(evt){
  evt.preventDefault();
  const nombre   = toUpper((document.getElementById('paxextra-nombre').value || '').trim());
  const cantidad = parseInt(document.getElementById('paxextra-cantidad').value, 10);
  const status   = document.getElementById('paxextra-status').value;
  const records  = parseRecordsInput(document.getElementById('paxextra-records').value);
  if (!nombre || cantidad < 1) return alert('Completa todos los campos correctamente');

  const ref = doc(db,'vuelos', editingVueloId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  let paxExtrasArr = data.paxExtras || [];
  const pax = { nombre, cantidad, status, records, changedBy: currentUserEmail };

  if (paxExtraEditMode && paxExtraEditIdx !== null){
    const antes = paxExtrasArr[paxExtraEditIdx];
    paxExtrasArr[paxExtraEditIdx] = pax;
    await updateDoc(ref, { paxExtras: paxExtrasArr, updatedAt: serverTimestamp() });
    await addDoc(collection(db,'historial'), {
      tipo:'pax-extra-edit', vueloId: editingVueloId,
      antes, despues: pax, usuario: currentUserEmail, ts: serverTimestamp()
    });
  } else {
    paxExtrasArr.push(pax);
    await updateDoc(ref, { paxExtras: paxExtrasArr, updatedAt: serverTimestamp() });
    await addDoc(collection(db,'historial'), {
      tipo:'pax-extra-add', vueloId: editingVueloId,
      antes: null, despues: pax, usuario: currentUserEmail, ts: serverTimestamp()
    });
  }

  paxExtraEditMode = false; paxExtraEditIdx = null;
  closePaxExtraModal();
  renderVuelos();
}

window.removePaxExtra = async (vueloId, idx) => {
  const ref = doc(db,'vuelos', vueloId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  const arr  = data.paxExtras || [];
  const antes = arr[idx];
  arr.splice(idx,1);
  await updateDoc(ref, { paxExtras: arr, updatedAt: serverTimestamp() });
  await addDoc(collection(db,'historial'), {
    tipo:'pax-extra-del', vueloId, antes, despues:null,
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

window.togglePaxExtraStatus = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  const arr = data.paxExtras || [];
  const old = arr[idx];
  arr[idx] = { ...old, status: old.status === 'pendiente' ? 'confirmado' : 'pendiente', changedBy: currentUserEmail };
  await updateDoc(ref, { paxExtras: arr, updatedAt: serverTimestamp() });
  await addDoc(collection(db,'historial'), {
    tipo:'pax-extra-status', vueloId, antes:old, despues:arr[idx],
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

// Toggle de estado de la reserva (chip)
window.toggleReservaEstado = async (vueloId) => {
  const ref = doc(db,'vuelos', vueloId);
  const snap = await getDoc(ref);
  const before = snap.data() || {};
  const old = (before.reservaEstado || 'pendiente').toLowerCase();
  const neu = old === 'pendiente' ? 'enviada' : 'pendiente';

  await updateDoc(ref, {
    reservaEstado: neu,
    reservaChangedBy: currentUserEmail,
    reservaTs: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  await addDoc(collection(db,'historial'), {
    tipo:'reserva-status', vueloId,
    antes:{ reservaEstado: old }, despues:{ reservaEstado: neu },
    usuario: currentUserEmail, ts: serverTimestamp()
  });

  renderVuelos();
};

// ======= Records por grupo (add/remove) =======

window.addReserva = async (vueloId, idxGrupo) => {
  const rec = prompt('Ingrese N° de reserva (record):');
  if (!rec) return;
  const recNorm = toUpper(rec.trim());
  const ref = doc(db,'vuelos', vueloId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  const arr = Array.isArray(data.grupos) ? data.grupos : [];
  const g = arr[idxGrupo];
  if (!g) return;
  const reservas = Array.isArray(g.reservas) ? g.reservas : [];
  if (!reservas.includes(recNorm)) reservas.push(recNorm);
  arr[idxGrupo] = { ...g, reservas, changedBy: currentUserEmail };
  await updateDoc(ref, { grupos: arr, updatedAt: serverTimestamp() });
  await addDoc(collection(db,'historial'), {
    tipo:'grupo-record-add', vueloId, grupoId: g.id, despues: { record: rec },
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

window.removeReserva = async (vueloId, idxGrupo, idxRec) => {
  if (!confirm('¿Quitar este record del grupo?')) return;
  const ref = doc(db,'vuelos', vueloId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  const arr = Array.isArray(data.grupos) ? data.grupos : [];
  const g = arr[idxGrupo];
  if (!g) return;
  const reservas = Array.isArray(g.reservas) ? [...g.reservas] : [];
  const antes = reservas[idxRec];
  reservas.splice(idxRec,1);
  arr[idxGrupo] = { ...g, reservas, changedBy: currentUserEmail };
  await updateDoc(ref, { grupos: arr, updatedAt: serverTimestamp() });
  await addDoc(collection(db,'historial'), {
    tipo:'grupo-record-del', vueloId, grupoId: g.id, antes: { record: antes }, despues:null,
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

// ======= Modal editar grupo (pax de grupo) =======

window.openGroupModal = (grupoId) => {
  const g = grupos.find(x => x.id === grupoId);
  if (!g) return alert('Grupo no encontrado');

  document.getElementById('g-numeroNegocio').value = g.numeroNegocio;
  document.getElementById('g-identificador').value = g.identificador;
  document.getElementById('g-nombreGrupo').value   = g.nombreGrupo;
  document.getElementById('g-cantidadGrupo').value = g.cantidadGrupo || 0;
  document.getElementById('g-adultos').value       = g.adultos || 0;
  document.getElementById('g-estudiantes').value   = g.estudiantes || 0;
  document.getElementById('g-coordinadores').value = (!g.coordinadores || g.coordinadores === 0) ? 1 : g.coordinadores;

  document.getElementById('group-form').dataset.grupoId = grupoId;
  document.getElementById('group-backdrop').style.display = 'block';
  document.getElementById('group-modal').style.display    = 'block';

  ['g-adultos','g-estudiantes'].forEach(id => {
    document.getElementById(id).oninput = () => ajustarPAXdesdeAdultosEstudiantes();
  });
  document.getElementById('g-cantidadGrupo').oninput = () => ajustarAdultosEstudiantesDesdePAX();

  ['g-adultos','g-estudiantes','g-coordinadores'].forEach(id => {
    document.getElementById(id).oninput = recalcularTotalFinal;
  });
  recalcularTotalFinal();

  if (!g.cantidadGrupo || g.cantidadGrupo === 0) ajustarPAXdesdeAdultosEstudiantes();
};

function closeGroupModal(){
  document.getElementById('group-backdrop').style.display = 'none';
  document.getElementById('group-modal').style.display    = 'none';
}

function ajustarPAXdesdeAdultosEstudiantes(){
  const a = +document.getElementById('g-adultos').value || 0;
  const e = +document.getElementById('g-estudiantes').value || 0;
  document.getElementById('g-cantidadGrupo').value = a + e;
}
function ajustarAdultosEstudiantesDesdePAX(){
  const pax = +document.getElementById('g-cantidadGrupo').value || 0;
  const a   = +document.getElementById('g-adultos').value || 0;
  let e     = pax - a;
  e = e >= 0 ? e : 0;
  document.getElementById('g-estudiantes').value = e;
}
function recalcularTotalFinal(){
  const a = +document.getElementById('g-adultos').value || 0;
  const e = +document.getElementById('g-estudiantes').value || 0;
  const c = +document.getElementById('g-coordinadores').value || 0;
  document.getElementById('g-cantidadTotal').value = a + e + c;
}

async function onSubmitGroup(evt){
  evt.preventDefault();
  const form = document.getElementById('group-form');
  const id   = form.dataset.grupoId;
  const before = (await getDoc(doc(db,'grupos', id))).data();

  const data = {
    cantidadGrupo: +document.getElementById('g-cantidadGrupo').value || 0,
    adultos:       +document.getElementById('g-adultos').value || 0,
    estudiantes:   +document.getElementById('g-estudiantes').value || 0,
    coordinadores: Math.max(+document.getElementById('g-coordinadores').value || 1, 1),
  };
  data.cantidadTotal = data.adultos + data.estudiantes + data.coordinadores;

  await updateDoc(doc(db,'grupos', id), data);
  await addDoc(collection(db,'historial'), {
    tipo:'grupo-edit', grupoId: id, antes: before, despues: data,
    usuario: currentUserEmail, ts: serverTimestamp()
  });

  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}

// ======= Acciones de grupo dentro del vuelo =======

window.removeGroup = async (vId, idx) => {
  const ref  = doc(db,'vuelos', vId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  const arr  = Array.isArray(data.grupos) ? [...data.grupos] : [];
  const antes = arr[idx];
  arr.splice(idx,1);

  const grupoIds = buildGrupoIds(arr);
  await updateDoc(ref, { grupos: arr, grupoIds, updatedAt: serverTimestamp() });

  await addDoc(collection(db,'historial'), {
    tipo:'grupo-remove', vueloId: vId, grupoId: antes?.id || '',
    antes, despues: null, usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

window.toggleStatus = async (vId, idx) => {
  const ref  = doc(db,'vuelos', vId);
  const snap = await getDoc(ref);
  const data = snap.data() || {};
  const old  = data.grupos[idx];
  const neu  = { ...old, status: old.status === 'pendiente' ? 'confirmado' : 'pendiente', changedBy: currentUserEmail };
  data.grupos[idx] = neu;

  await updateDoc(ref, { grupos: data.grupos, updatedAt: serverTimestamp() });
  await addDoc(collection(db,'historial'), {
    tipo:'grupo-status', vueloId: vId, grupoId: old.id,
    antes: old, despues: neu, usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

// ======= TRANSFERS: creación / vínculo / desvínculo / util =======

// Wizard mínimo (prompt) para crear un TRANSFER desde una fila de grupo
window.createTransferForGroup = async (vueloId, grupoId) => {
  try{
    const vuelo = vuelos.find(v => v.id === vueloId);
    if (!vuelo) return alert('Vuelo no encontrado');
    const g = grupos.find(x => x.id === grupoId);
    if (!g) return alert('Grupo no encontrado');

    // Sugerencias desde vuelo
    const legDefault = (vuelo.presentacionVueltaHora || vuelo.vueloVueltaHora) ? 'ida+vuelta' : 'ida';
    const transferLeg = (prompt(`Leg del transfer (ida|vuelta|ida+vuelta). Sugerido: ${legDefault}`, legDefault) || '').toLowerCase();
    if (!['ida','vuelta','ida+vuelta'].includes(transferLeg)) return alert('Leg inválido');

    const proveedor = toUpper(prompt('Proveedor (empresa de bus):', '') || '');
    if (!proveedor) return alert('Proveedor requerido');

    const numero = toUpper(prompt('Código/servicio (opcional):', '') || '');

    const origen = toUpper(prompt('Origen (ej: COLEGIO X / SCL T1):', vuelo.origen || '') || '');
    const destino = toUpper(prompt('Destino (ej: SCL T1 / COLEGIO X):', vuelo.destino || '') || '');
    if (!origen || !destino) return alert('Origen y Destino son requeridos');

    let fechaIda = '', idaHora = '', fechaVuelta = '', vueltaHora = '';
    if (transferLeg === 'ida' || transferLeg === 'ida+vuelta'){
      fechaIda = toISO(prompt('Fecha IDA (YYYY-MM-DD):', vuelo.fechaIda || '') || '');
      idaHora  = toHHMM(prompt('Hora IDA (HH:MM) (sugerencia: presentación o vuelo):', vuelo.presentacionIdaHora || vuelo.vueloIdaHora || '') || '');
    }
    if (transferLeg === 'vuelta' || transferLeg === 'ida+vuelta'){
      fechaVuelta = toISO(prompt('Fecha REGRESO (YYYY-MM-DD):', vuelo.fechaVuelta || '') || '');
      vueltaHora  = toHHMM(prompt('Hora REGRESO (HH:MM) (sugerencia: presentación regreso o vuelo):', vuelo.presentacionVueltaHora || vuelo.vueloVueltaHora || '') || '');
    }

    // Opcionales
    const capacidadMaxStr = prompt('Capacidad máxima (opcional, numérico):', '');
    const capacidadMax = capacidadMaxStr ? Math.max(parseInt(capacidadMaxStr,10) || 0,0) : null;
    const categoriaTarifa = toUpper(prompt('Categoría Tarifa (ej: TRANSFER-AEROPUERTO, INTERURBANO) (opcional):','TRANSFER-AEROPUERTO') || '');

    let pay = normalizeVueloPayload({
      tipoTransporte: 'terrestre',
      proveedor, numero, origen, destino,
      fechaIda, fechaVuelta, idaHora, vueltaHora,
      isTransfer: true,
      transferLeg,
      relatedVueloId: vueloId,
      grupoIds: [grupoId],
      excludeFromTotals: true,
      capacidadMax: capacidadMax ?? null,
      categoriaTarifa: categoriaTarifa || null,
      // Para UI/búsqueda
      // (sin grupos inline: los transfers viven con grupoIds, no con objetos grupo completos)
    });

    pay.createdAt = serverTimestamp();
    pay.updatedAt = serverTimestamp();

    const ref = await addDoc(collection(db,'vuelos'), pay);
    await addDoc(collection(db,'historial'), {
      tipo:'transfer-new', vueloId: ref.id,
      antes: null, despues: pay, usuario: currentUserEmail, ts: serverTimestamp()
    });

    alert('Transfer creado y vinculado al grupo ✅');
    renderVuelos();
  } catch(e){
    console.error(e);
    alert('No se pudo crear el transfer.');
  }
};

// Desvincular grupo de un transfer (sin borrar el doc, a menos que quede vacío)
window.unlinkTransferFromGroup = async (transferId, grupoId) => {
  const ref = doc(db,'vuelos', transferId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return alert('Transfer no encontrado');
  const t = snap.data();

  const arr = Array.isArray(t.grupoIds) ? [...t.grupoIds] : [];
  const idx = arr.indexOf(grupoId);
  if (idx === -1) return;
  arr.splice(idx,1);

  const updates = {
    grupoIds: arr,
    updatedAt: serverTimestamp()
  };

  // Si queda sin grupos, preguntar si eliminar
  if (arr.length === 0){
    const del = confirm('Este transfer quedará sin grupos. ¿Eliminar documento?');
    if (del){
      await deleteDoc(ref);
      await addDoc(collection(db,'historial'), {
        tipo:'transfer-del', vueloId: transferId,
        antes: t, despues: null, usuario: currentUserEmail, ts: serverTimestamp()
      });
      renderVuelos();
      return;
    }
  }

  await updateDoc(ref, updates);
  await addDoc(collection(db,'historial'), {
    tipo:'transfer-link-del', vueloId: transferId,
    antes: { grupoId }, despues: { grupoIds: arr },
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
};

// ======= Eliminar doc =======

async function deleteVuelo(id){
  if (!confirm('¿Eliminar vuelo/trayecto completo?')) return;
  const before = (await getDoc(doc(db,'vuelos', id))).data();

  await deleteDoc(doc(db,'vuelos', id));

  // Limpieza de espejos
  try { await deleteDoc(doc(db, COLLECTION_HORARIOS_DRAFT, id)); } catch(_) {}
  try { await deleteDoc(doc(db, COLLECTION_HORARIOS_PUBLICOS, id)); } catch(_) {}

  await addDoc(collection(db,'historial'), {
    tipo: before?.isTransfer ? 'transfer-del' : 'vuelo-del',
    vueloId: id, antes: before, despues: null,
    usuario: currentUserEmail, ts: serverTimestamp()
  });
  renderVuelos();
}

// ======= Render principal de cards =======

function buildTransfersIndexes(){
  transfersByGroup.clear();
  transfersByGroupAndVuelo.clear();
  const transfers = vuelos.filter(v => (v.tipoTransporte || 'aereo') === 'terrestre' && v.isTransfer);
  for (const t of transfers){
    const gids = Array.isArray(t.grupoIds) ? t.grupoIds : [];
    for (const gId of gids){
      // index por grupo
      if (!transfersByGroup.has(gId)) transfersByGroup.set(gId, []);
      transfersByGroup.get(gId).push(t);
      // index por grupo + vuelo asociado (si tiene)
      if (t.relatedVueloId){
        const key = `${gId}__${t.relatedVueloId}`;
        if (!transfersByGroupAndVuelo.has(key)) transfersByGroupAndVuelo.set(key, []);
        transfersByGroupAndVuelo.get(key).push(t);
      }
    }
  }
}

function transferBadgeHTML(){
  return `<span class="chip" style="background:#ffe7b8;border:1px solid #d6a106;color:#663c00;padding:.05em .45em;border-radius:8px;margin-left:.35em;">🚌 TRANSFER</span>`;
}

function transferDetailLine(t){
  const legTxt = t.transferLeg ? toUpper(t.transferLeg) : '';
  const idaTxt = t.fechaIda ? `${fmtFechaLarga(t.fechaIda)} ${t.idaHora || ''}` : '';
  const vtaTxt = t.fechaVuelta ? `${fmtFechaLarga(t.fechaVuelta)} ${t.vueltaHora || ''}` : '';
  const lados = [idaTxt, vtaTxt].filter(Boolean).join(' / ');
  const prov = toUpper(t.proveedor || '');
  const num  = toUpper(t.numero || '');
  return `${prov}${num ? ' '+num : ''} · ${toUpper(t.origen||'')} → ${toUpper(t.destino||'')} · ${lados} ${legTxt ? ' · '+legTxt : ''}`;
}

async function renderVuelos(){
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  const snap = await getDocs(collection(db,'vuelos'));
  vuelos = snap.docs.map(d => ({ id:d.id, ...d.data() }));

  // Ordena por fechaIda normalizada (si no existe, muy al futuro)
  vuelos.sort((a,b) => {
    const fa = toISO(a.fechaIda) || '9999-12-31';
    const fb = toISO(b.fechaIda) || '9999-12-31';
    if (fa !== fb) return fa.localeCompare(fb);
    const tsa = a.ts?.seconds || 0;
    const tsb = b.ts?.seconds || 0;
    return tsa - tsb;
  });

  // Construye índices de transfers
  buildTransfersIndexes();

  for (const v of vuelos){
    const tipoTrans = v.tipoTransporte || 'aereo';
    const isAereo   = tipoTrans === 'aereo';
    const isRegMT   = isAereo && v.tipoVuelo === 'regular' && Array.isArray(v.tramos) && v.tramos.length > 0;

    const icono     = isAereo ? '✈️' : '🚌';
    const airline   = v.proveedor || v.tramos?.[0]?.aerolinea || '';
    const flightNum = v.numero    || v.tramos?.[0]?.numero    || '';
    const date      = v.tramos?.[0]?.fechaIda || v.fechaIda || '';

    let totA = 0, totE = 0, totC = 0, totX = 0;
    let confA = 0, confE = 0, confC = 0, confX = 0;
    let paxExtrasArr = v.paxExtras || [];
    let cardBody = '';

    // ===== Bloque tramos (AÉREO REGULAR multitramo) =====
    if (isRegMT){
      cardBody += `<div class="tramos" style="margin-bottom:0.7em;">`;
      v.tramos.forEach((tramo, idxT) => {
        const hasIda    = !!toISO(tramo.fechaIda);
        const hasVuelta = !!toISO(tramo.fechaVuelta);

        const lineaIda = hasIda ? `
          <div><strong>IDA:</strong> ${fmtFechaLarga(tramo.fechaIda)}
            ${tramo.presentacionIdaHora ? ` · Presentación ${tramo.presentacionIdaHora}` : ''} 
            ${tramo.vueloIdaHora ? ` · Vuelo ${tramo.vueloIdaHora}` : ''}</div>
        ` : '';

        const lineaVta = hasVuelta ? `
          <div><strong>REGRESO:</strong> ${fmtFechaLarga(tramo.fechaVuelta)}
            ${tramo.presentacionVueltaHora ? ` · Presentación ${tramo.presentacionVueltaHora}` : ''} 
            ${tramo.vueloVueltaHora ? ` · Vuelo ${tramo.vueloVueltaHora}` : ''}</div>
        ` : '';

        const horasLine = (lineaIda || lineaVta)
          ? `<div style="font-size:.92em; color:#333; margin-top:.2em;">${lineaIda}${lineaVta}</div>`
          : '';

        cardBody += `
          <div class="tramo" style="margin-bottom:0.6em;">
            <span style="font-weight:bold;font-size:1.05em;">${icono} ${toUpper(tramo.aerolinea)} ${toUpper(tramo.numero)}</span> 
            <span style="font-size:.97em;">(REGULAR · TRAMO ${idxT+1}${tramo.tipoTramo ? ' · ' + toUpper(tramo.tipoTramo) : ''})</span><br>
            <span style="color:#444;">${toUpper(tramo.origen)} → ${toUpper(tramo.destino)}</span>
            ${horasLine}
          </div>
        `;
      });
      cardBody += `</div>`;
    }

    // ===== Filas por grupo (con chips de RECORDS) + TRANSFER badge/detalle =====
    const filas = (v.grupos || []).map((gObj, idx) => {
      const g = grupos.find(x => x.id === gObj.id) || {};
      const a = parseInt(g.adultos     || 0, 10);
      const e = parseInt(g.estudiantes || 0, 10);
      const c = Math.max(parseInt(g.coordinadores ?? 1, 10), 1);
      const totalRow = a + e + c;
      totA += a; totE += e; totC += c;
      if (gObj.status === 'confirmado'){ confA += a; confE += e; confC += c; }
      const mail = gObj.changedBy || '–';
      const reservas = Array.isArray(gObj.reservas) ? gObj.reservas : [];
      const chips = reservas.map((r,ri) =>
        `<span class="chip" style="background:#eef;border:1px solid #99c;padding:.05em .4em;border-radius:8px;margin-left:.25em;">
           ${toUpper(r)} <a href="javascript:void(0)" title="Quitar" onclick="removeReserva('${v.id}', ${idx}, ${ri})" style="text-decoration:none;margin-left:.25em;">✖</a>
         </span>`
      ).join('');

      // Transfers vinculados a este grupo y a este vuelo:
      const key = `${gObj.id}__${v.id}`;
      const transfers = transfersByGroupAndVuelo.get(key) || [];
      const hasTransfers = transfers.length > 0;

      const transferBadge = hasTransfers ? transferBadgeHTML() : '';
      const transferLines = hasTransfers ? `
        <div class="transfer-lines" style="margin-top:.35em;">
          ${transfers.map(t => `
            <div style="font-size:.92em;color:#333;display:flex;gap:.4em;align-items:center;">
              <span>🚌 ${transferDetailLine(t)}</span>
              <button class="btn-small" onclick="focusCard('${t.id}', '${toUpper(t.numero||'')}','${t.fechaIda||t.fechaVuelta||''}')">👁️</button>
              <button class="btn-small" onclick="unlinkTransferFromGroup('${t.id}', '${gObj.id}')">🚫</button>
            </div>
          `).join('')}
        </div>
      ` : '';

      return `
        <div class="group-item">
          <div class="num">${toUpper(g.numeroNegocio)} - ${toUpper(g.identificador)}</div>
          <div class="name">
            <span class="group-name" onclick="openGroupModal('${g.id}')">${toUpper(g.nombreGrupo || '')}</span>
            ${transferBadge}
            <span class="pax-inline">${totalRow} (A:${a} E:${e} C:${c})</span>
            <div class="records-line" style="margin-top:.15em;">
              <strong>Record(s):</strong> ${chips || '—'}
              <button class="btn-small" style="margin-left:.4em" onclick="addReserva('${v.id}', ${idx})">➕</button>
              <button class="btn-small" style="margin-left:.4em;background:#ffc107;border:1px solid #d39e00" 
                title="Agregar traslado terrestre (TRANSFER) a este grupo" 
                onclick="createTransferForGroup('${v.id}', '${gObj.id}')">🚌➕</button>
            </div>
            ${transferLines}
          </div>
          <div class="status-cell">
            <span>${gObj.status === 'confirmado' ? '✅ CONFIRMADO' : '🕗 PENDIENTE'}</span>
            <span class="by-email">${toUpper(mail)}</span>
            <button class="btn-small" onclick="toggleStatus('${v.id}', ${idx})">🔄</button>
          </div>
          <div class="delete-cell">
            <button class="btn-small" onclick="removeGroup('${v.id}', ${idx})">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    // ===== Filas de pax extra =====
    let filasExtras = '';
    if (paxExtrasArr.length){
      filasExtras = paxExtrasArr.map((pax, idx) => {
        const val = parseInt(pax.cantidad || 0, 10);
        totX += val;
        if (pax.status === 'confirmado') confX += val;

        const recs = Array.isArray(pax.records) ? pax.records : [];
        const chips = recs.length
          ? `<div class="records-line">${recs.map(r => `<span class="chip chip-rec" onclick="window.filterByRecord('${r.replace(/'/g,"\\'")}')">${toUpper(r)}</span>`).join(' ')}</div>`
          : '';

        return `
          <div class="group-item" style="background:#ffebe7">
            <div class="num">–</div>
            <div class="name">
              <span class="group-name" style="cursor:pointer;text-decoration:underline;" onclick="window.editPaxExtra('${v.id}', ${idx})">${toUpper(pax.nombre||'')}</span>
              <span class="pax-inline">${val}</span>
              ${chips}
            </div>
            <div class="status-cell">
              <span>${pax.status === 'confirmado' ? '✅ CONFIRMADO' : '🕗 PENDIENTE'}</span>
              <span class="by-email">${toUpper(pax.changedBy||'')}</span>
              <button class="btn-small" onclick="togglePaxExtraStatus('${v.id}', ${idx})">🔄</button>
            </div>
            <div class="delete-cell">
              <button class="btn-small" onclick="removePaxExtra('${v.id}', ${idx})">🗑️</button>
            </div>
          </div>
        `;
      }).join('');
    }

    // ===== Cabecera (título/fechas/origen-destino + horarios top-level) =====
    let fechaCard = '';
    if (isRegMT){
      const idas    = v.tramos.map(t => toISO(t.fechaIda)).filter(Boolean).sort();
      const vueltas = v.tramos.map(t => toISO(t.fechaVuelta)).filter(Boolean).sort();
      const fechaIda    = idas.length ? fmtFechaLarga(idas[0]) : '';
      const fechaVuelta = vueltas.length ? fmtFechaLarga(vueltas[vueltas.length - 1]) : '';
      const primerTramo = v.tramos[0];

      fechaCard = `
        <div class="titulo-vuelo" style="margin-bottom:.5em;">
          <div style="font-size:1.1em; font-weight:bold;">
            <span style="margin-right:.4em;">${icono}</span>
            ${toUpper(primerTramo.aerolinea || v.proveedor)} ${toUpper(primerTramo.numero || v.numero)} (REGULAR · MULTITRAMO)
          </div>
          <div style="font-weight:bold; margin:.15em 0 .6em 0; font-size:.98em;">
            <span style="color:red">${fechaIda}</span>${fechaVuelta ? ' / <span style="color:red">' + fechaVuelta + '</span>' : ''}
          </div>
          <div style="font-size:.97em; color:#444; margin-bottom:.7em;">
            <span>Origen: ${toUpper(primerTramo.origen || v.origen || '')}</span>
            &nbsp;&nbsp;
            <span>Destino: ${toUpper(primerTramo.destino || v.destino || '')}</span>
          </div>
        </div>
      `;
    } else {
      const fechaIda    = fmtFechaLarga(v.fechaIda);
      const fechaVuelta = fmtFechaLarga(v.fechaVuelta);

      // Etiqueta “TRANSFER” visible en cabecera de card terrestre que es transfer
      const transferHeader = (!isAereo && v.isTransfer) ? ` ${transferBadgeHTML()}` : '';

      // Línea de horarios top-level
      let horariosTL = '';
      if (isAereo){
        const l1 = (v.presentacionIdaHora || v.vueloIdaHora) ?
          `<div><strong>IDA:</strong> ${v.presentacionIdaHora ? 'Presentación ' + v.presentacionIdaHora : ''}${v.vueloIdaHora ? (v.presentacionIdaHora ? ' · ' : '') + 'Vuelo ' + v.vueloIdaHora : ''}</div>` : '';
        const l2 = (v.presentacionVueltaHora || v.vueloVueltaHora) ?
          `<div><strong>REGRESO:</strong> ${v.presentacionVueltaHora ? 'Presentación ' + v.presentacionVueltaHora : ''}${v.vueloVueltaHora ? (v.presentacionVueltaHora ? ' · ' : '') + 'Vuelo ' + v.vueloVueltaHora : ''}</div>` : '';
        horariosTL = (l1 || l2) ? `<div style="font-size:.92em; color:#333; margin-top:.2em;">${l1}${l2}</div>` : '';
      } else {
        const lbus = (v.idaHora || v.vueltaHora) ?
          `<div style="font-size:.92em; color:#333; margin-top:.2em;">
            <div><strong>Salida Bus (ida):</strong> ${v.idaHora || '—'}</div>
            <div><strong>Regreso Bus:</strong> ${v.vueltaHora || '—'}</div>
          </div>` : '';
        horariosTL = lbus;
      }

      fechaCard = `
        <div class="titulo-vuelo" style="margin-bottom:.5em;">
          <div style="font-size:1.1em; font-weight:bold;">
            <span style="margin-right:.4em;">${icono}</span>
            ${toUpper(v.proveedor || '')} ${toUpper(v.numero || '')} (${isAereo ? toUpper(v.tipoVuelo || 'AÉREO') : 'TERRESTRE'})${transferHeader}
          </div>
          <div style="font-weight:bold; margin:.15em 0 .6em 0; font-size:.98em;">
            <span style="color:red">${fechaIda}</span>${fechaVuelta ? ' / <span style="color:red">' + fechaVuelta + '</span>' : ''}
          </div>
          <div style="font-size:.97em; color:#444;">
            <span>Origen: ${toUpper(v.origen || '')}</span>
            &nbsp;&nbsp;
            <span>Destino: ${toUpper(v.destino || '')}</span>
          </div>
          ${horariosTL}
        </div>
      `;
    }

    const exclude = !!v.excludeFromTotals;
    const totalPax  = (exclude ? 0 : (totA + totE + totC)) + totX;
    const totalConf = (exclude ? 0 : (confA + confE + confC)) + confX;

    const reservaFechaTxt = v.reservaFechaLimite ? fmtFechaLarga(v.reservaFechaLimite) : '—';
    const chip = reservaChipMeta(v);
    const changedByTxt = v.reservaChangedBy ? ` <span class="by-email">${toUpper(v.reservaChangedBy)}</span>` : '';
    const lineaReservaHTML = `
      <div style="display:flex; align-items:center; gap:.6em; margin:.4em 0 .2em 0;">
        <div><strong>Fecha Límite:</strong> ${reservaFechaTxt}</div>
        <button class="chip-reserva ${chip.claseExtra}" onclick="toggleReservaEstado('${v.id}')">${chip.texto}</button>
        ${changedByTxt}
      </div>
    `;

    // Inyecta palabra "TRANSFER" en el textContent de la card para que el buscador lo encuentre
    const transferSearchTag = (!isAereo && v.isTransfer) ? `<span style="display:none">TRANSFER</span>` : '';

    const card = document.createElement('div');
    card.className = 'flight-card';
    card.dataset.vueloId = v.id;
    card.dataset.airline = airline;
    card.dataset.flight  = flightNum;
    card.dataset.date    = date;
    card.innerHTML = `
      ${transferSearchTag}
      <h4>${fechaCard}</h4>
      ${cardBody}
      <div>${filas || '<p>— SIN GRUPOS —</p>'}</div>
      ${filasExtras}
      <p><strong>TOTAL PAX:</strong> ${totalPax} (A:${exclude?0:totA} E:${exclude?0:totE} C:${exclude?0:totC} X:${totX}) – CONFIRMADOS: ${totalConf}</p>
      ${lineaReservaHTML}
      <div class="actions">
        <button class="btn-add btn-edit">✏️ EDITAR</button>
        <button class="btn-add btn-del">🗑️ ELIMINAR</button>
        ${isAereo ? `<button class="btn-add btn-pax" style="background:green;color:white;" onclick="openPaxExtraModal('${v.id}')">+ AGREGAR PAX</button>` : ''}
      </div>
    `;
    card.querySelector('.btn-edit').onclick = () => openModal(v);
    card.querySelector('.btn-del' ).onclick = () => deleteVuelo(v.id);

    cont.appendChild(card);
  }

  renderFlightsList();
}

// Foco en una card por id / n° / fecha (para botones de "👁️" en transfers)
window.focusCard = (docId, numero, fecha) => {
  const selector = `.flight-card[data-vuelo-id="${docId}"], .flight-card[data-flight="${numero}"][data-date="${fecha}"]`;
  const target = document.querySelector(selector);
  if (target){
    target.scrollIntoView({ behavior:'smooth', block:'start' });
    target.classList.add('highlight');
    setTimeout(() => target.classList.remove('highlight'), 1500);
  }
};

// ======= Historial (modal) =======

async function showHistorialModal(){
  document.getElementById('hist-backdrop').style.display = 'block';
  document.getElementById('hist-modal').style.display    = 'block';
  await loadHistorial();
}

function closeHistorialModal(){
  document.getElementById('hist-backdrop').style.display = 'none';
  document.getElementById('hist-modal').style.display    = 'none';
}

async function loadHistorial(){
  const tbody = document.querySelector('#hist-table tbody');
  tbody.innerHTML = '';

  const start = document.getElementById('hist-start').value;
  const end   = document.getElementById('hist-end').value;

  const qSnap = query(collection(db,'historial'), orderBy('ts','desc'));
  const snap = await getDocs(qSnap);

  for (const dSnap of snap.docs){
    const d  = dSnap.data();
    const ts = d.ts?.toDate?.();
    if (start && ts && ts < new Date(start + 'T00:00:00')) continue;
    if (end   && ts && ts > new Date(end   + 'T23:59:59')) continue;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ts ? ts.toLocaleString('es-CL') : ''}</td>
      <td>${d.usuario || ''}</td>
      <td>${d.vueloId || d.grupoId || ''}</td>
      <td>${d.tipo || ''}</td>
      <td>${d.antes ? JSON.stringify(d.antes) : ''}</td>
      <td>${d.despues ? JSON.stringify(d.despues) : ''}</td>
    `;
    tbody.appendChild(tr);
  }

  if (dtHist) dtHist.destroy();
  dtHist = $('#hist-table').DataTable({
    language: { url: 'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json' },
    order: [[0,'desc']]
  });
}

async function upsertHorarios(v, vueloId, publicar, prevPublicar){
  // Construye un doc “seguro” para publicar: sólo horarios y metadatos mínimos
  const isAereo = (v.tipoTransporte || 'aereo') === 'aereo';

  const toSafeUpper = (s) => toUpper(String(s || '').trim());
  const firstTramo  = Array.isArray(v.tramos) && v.tramos.length ? v.tramos[0] : null;
  const lastTramo   = Array.isArray(v.tramos) && v.tramos.length ? v.tramos[v.tramos.length - 1] : null;

  const base = {
    tipoTransporte: v.tipoTransporte || 'aereo',
    proveedor: toSafeUpper(v.proveedor || (firstTramo?.aerolinea || '')),
    numero:    toSafeUpper(v.numero    || (firstTramo?.numero    || '')),
    origen:    toSafeUpper(v.origen    || (firstTramo?.origen    || '')),
    destino:   toSafeUpper(v.destino   || (firstTramo?.destino   || '')),
    fechaIda:     toISO(v.fechaIda     || (firstTramo?.fechaIda    || '')),
    fechaVuelta:  toISO(v.fechaVuelta  || (lastTramo?.fechaVuelta  || '')),
    updatedAt: serverTimestamp(),
    updatedBy: currentUserEmail,
    sourceVueloId: vueloId
  };

  if (isAereo){
    base.tipoVuelo = v.tipoVuelo || '';
    base.presentacionIdaHora     = toHHMM(v.presentacionIdaHora || '');
    base.vueloIdaHora            = toHHMM(v.vueloIdaHora || '');
    base.presentacionVueltaHora  = toHHMM(v.presentacionVueltaHora || '');
    base.vueloVueltaHora         = toHHMM(v.vueloVueltaHora || '');

    if (Array.isArray(v.tramos) && v.tramos.length){
      base.tramos = v.tramos.map(t => ({
        aerolinea: toSafeUpper(t.aerolinea),
        numero:    toSafeUpper(t.numero),
        origen:    toSafeUpper(t.origen),
        destino:   toSafeUpper(t.destino),
        tipoTramo: (t.tipoTramo || '').toLowerCase(),
        fechaIda:  toISO(t.fechaIda || ''),
        presentacionIdaHora: toHHMM(t.presentacionIdaHora || ''),
        vueloIdaHora:        toHHMM(t.vueloIdaHora || ''),
        fechaVuelta:         toISO(t.fechaVuelta || ''),
        presentacionVueltaHora: toHHMM(t.presentacionVueltaHora || ''),
        vueloVueltaHora:        toHHMM(t.vueloVueltaHora || '')
      }));
    }
  } else {
    base.idaHora    = toHHMM(v.idaHora || '');
    base.vueltaHora = toHHMM(v.vueltaHora || '');
  }

  base.publicar     = !!publicar;
  base.publishScope = publicar ? 'PUBLICA' : 'PRIVADA';

  // Siempre mantenemos el draft
  await setDoc(doc(db, COLLECTION_HORARIOS_DRAFT, vueloId), base, { merge: true });

  // Y publicamos / despublicamos según corresponda
  if (publicar){
    await setDoc(doc(db, COLLECTION_HORARIOS_PUBLICOS, vueloId), base, { merge: true });
    await addDoc(collection(db,'historial'), {
      tipo:'horario-publicar', vueloId, despues: base,
      usuario: currentUserEmail, ts: serverTimestamp()
    });
  } else if (prevPublicar){
    try {
      await deleteDoc(doc(db, COLLECTION_HORARIOS_PUBLICOS, vueloId));
      await addDoc(collection(db,'historial'), {
        tipo:'horario-despublicar', vueloId,
        usuario: currentUserEmail, ts: serverTimestamp()
      });
    } catch(_) {}
  }
}

// ======= Exportar a Excel =======
function exportToExcel(){
  // Hoja 1: Resumen de viajes/trayectos (sin duplicar PAX por transfers)
  const resumen = vuelos.map(v => {
    const isAereo = (v.tipoTransporte || 'aereo') === 'aereo';
    const exclude = !!v.excludeFromTotals;

    let totA=0, totE=0, totC=0, totX=0;
    if (!exclude){
      (v.grupos || []).forEach(gObj => {
        const g = grupos.find(x => x.id === gObj.id) || {};
        totA += parseInt(g.adultos || 0, 10);
        totE += parseInt(g.estudiantes || 0, 10);
        totC += parseInt(g.coordinadores || 0, 10);
      });
    }
    (v.paxExtras || []).forEach(x => { totX += parseInt(x.cantidad || 0, 10); });

    let detallesTramos = '';
    if (isAereo && v.tipoVuelo === 'regular' && v.tramos && v.tramos.length){
      detallesTramos = v.tramos.map((t,i) => {
        const tipo = (t.tipoTramo || '').toLowerCase();
        const p = [];
        if (tipo === 'ida' || tipo === 'ida+vuelta'){
          if (toISO(t.fechaIda)){
            p.push(`IDA:${t.fechaIda}${t.vueloIdaHora ? ' ' + t.vueloIdaHora : ''} | PRES:${t.presentacionIdaHora || '-'}`);
          }
        }
        if (tipo === 'vuelta' || tipo === 'ida+vuelta'){
          if (toISO(t.fechaVuelta)){
            p.push(`REGRESO:${t.fechaVuelta}${t.vueloVueltaHora ? ' ' + t.vueloVueltaHora : ''} | PRES:${t.presentacionVueltaHora || '-'}`);
          }
        }
        const lado = p.join(' · ');
        return `${i+1}) ${toUpper(t.aerolinea)} ${toUpper(t.numero)}: ${toUpper(t.origen)}→${toUpper(t.destino)} ${lado ? '['+lado+']' : ''}`;
      }).join('\n');
    }

    return {
      Transporte: (v.tipoTransporte || 'aereo').toUpperCase(),
      Es_Transfer: v.isTransfer ? 'Sí' : 'No',
      Aerolínea_Empresa: v.proveedor || (v.tramos?.[0]?.aerolinea || ''),
      Numero:     v.numero    || (v.tramos?.[0]?.numero    || ''),
      TipoVuelo:  isAereo ? (v.tipoVuelo || '') : '',
      Origen:     v.origen    || (v.tramos?.[0]?.origen    || ''),
      Destino:    v.destino   || (v.tramos?.[0]?.destino   || ''),
      Fecha_Ida:  v.fechaIda  || (v.tramos?.[0]?.fechaIda  || ''),
      Fecha_Vuelta: v.fechaVuelta || (v.tramos?.[0]?.fechaVuelta || ''),
      Presentacion_Ida:    isAereo ? (v.presentacionIdaHora || '') : '',
      Vuelo_Ida:           isAereo ? (v.vueloIdaHora || '') : '',
      Presentacion_Vuelta: isAereo ? (v.presentacionVueltaHora || '') : '',
      Vuelo_Vuelta:        isAereo ? (v.vueloVueltaHora || '') : '',
      Hora_Ida_Bus:        isAereo ? '' : (v.idaHora || ''),
      Hora_Vuelta_Bus:     isAereo ? '' : (v.vueltaHora || ''),
      Transfer_Leg:        v.isTransfer ? (v.transferLeg || '') : '',
      Related_Vuelo:       v.isTransfer ? (v.relatedVueloId || '') : '',
      Tramos:    detallesTramos,
      Total_Adultos:       totA,
      Total_Estudiantes:   totE,
      Total_Coordinadores: totC,
      Total_Pax_Extra:     totX,
      Total_Pax:           totA + totE + totC + totX
    };
  });

  // Hoja 2: Detalle por grupo (incluye transfers)
  const detalle = [];
  vuelos.forEach(v => {
    const isTransfer = !!v.isTransfer;
    const gids = Array.isArray(v.grupoIds) ? v.grupoIds : (v.grupos || []).map(x => x.id);

    // Detalle de grupos inline (aéreos) — respeta excludeFromTotals solo en totales, no en detalle
    (v.grupos || []).forEach(gObj => {
      const g = grupos.find(x => x.id === gObj.id) || {};
      detalle.push({
        Transporte: (v.tipoTransporte || 'aereo').toUpperCase(),
        Es_Transfer: isTransfer ? 'Sí' : 'No',
        Fecha_Ida: v.fechaIda,
        Numero: v.numero || (v.tramos?.[0]?.numero || ''),
        Grupo_Numero: g.numeroNegocio,
        Grupo_Identificador: g.identificador,
        Grupo_Nombre: g.nombreGrupo,
        Adultos: g.adultos || 0,
        Estudiantes: g.estudiantes || 0,
        Coordinadores: g.coordinadores || 0,
        Total: (g.adultos||0) + (g.estudiantes||0) + (g.coordinadores||0),
        Estado: gObj.status,
        Records: (Array.isArray(gObj.reservas) ? gObj.reservas.join(', ') : ''),
        Cambiado_Por: gObj.changedBy || '',
        Related_Vuelo: isTransfer ? (v.relatedVueloId || '') : ''
      });
    });

    // Detalle de grupoIds (transfers)
    if (isTransfer && gids.length){
      gids.forEach(gId => {
        const g = grupos.find(x => x.id === gId);
        detalle.push({
          Transporte: (v.tipoTransporte || 'aereo').toUpperCase(),
          Es_Transfer: 'Sí',
          Fecha_Ida: v.fechaIda,
          Numero: v.numero || '',
          Grupo_Numero: g?.numeroNegocio || gId,
          Grupo_Identificador: g?.identificador || '',
          Grupo_Nombre: g?.nombreGrupo || '',
          Adultos: '-', Estudiantes: '-', Coordinadores: '-',
          Total: '-', Estado: '-', Records: '',
          Cambiado_Por: '',
          Related_Vuelo: v.relatedVueloId || ''
        });
      });
    }

    (v.paxExtras || []).forEach(x => {
      detalle.push({
        Transporte: (v.tipoTransporte || 'aereo').toUpperCase(),
        Es_Transfer: isTransfer ? 'Sí' : 'No',
        Fecha_Ida: v.fechaIda,
        Numero: v.numero || (v.tramos?.[0]?.numero || ''),
        Grupo_Numero: '-',
        Grupo_Identificador: '-',
        Grupo_Nombre: x.nombre,
        Adultos: '-',
        Estudiantes: '-',
        Coordinadores: '-',
        Total: x.cantidad,
        Estado: x.status,
        Cambiado_Por: x.changedBy || '',
        Records: Array.isArray(x.records) ? x.records.join(', ') : '',
        Related_Vuelo: isTransfer ? (v.relatedVueloId || '') : ''
      });
    });
  });

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen_Viajes');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle_Grupos');
  XLSX.writeFile(wb, 'planificacion_viajes.xlsx');
}

// ======= Cierre de modales al clickear backdrop =======
document.body.addEventListener('click', function(e){
  if (e.target.classList.contains('modal-backdrop')){
    e.target.style.display = 'none';
    const modal = document.querySelector('.modal[style*="display: block"]');
    if (modal) modal.style.display = 'none';
  }
}, true);
