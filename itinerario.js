// itinerario.js — Editor de Itinerarios (RT v1.0)

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, query, where, getDocs,
  doc, getDoc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 0.1) Utilidades de normalización (evita fallos por mayúsculas/tildes)
// —————————————————————————————————
const K = s => (s ?? '')
  .toString()
  .normalize('NFD').replace(/\p{Diacritic}/gu,'')
  .replace(/\s+/g,' ')
  .trim()
  .toUpperCase();

// —————————————————————————————————
// 1) Referencias DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");
const qaHoraInicio   = document.getElementById("qa-horaInicio");
const qaAct          = document.getElementById("qa-actividad");
const qaAddBtn       = document.getElementById("qa-add");

const btnGuardarTpl  = document.getElementById("btnGuardarTpl");
const btnCargarTpl   = document.getElementById("btnCargarTpl");
const selPlantillas  = document.getElementById("sel-plantillas");

// —— Historial (modal + filtros)
const btnHistorial        = document.getElementById("btnHistorial");
const modalHistorial      = document.getElementById("modal-historial");
const btnCloseHistorial   = document.getElementById("historial-close");
const listHistorial       = document.getElementById("historial-list");
const filtroHistorial     = document.getElementById("historial-filter");

// cache en memoria para filtrar sin reconsultar
let historialCache = [];

// —— Estado revisión (banda)
const estadoBadge    = document.getElementById("estado-badge");

// —— Botón Alertas y badge
const btnAlertas     = document.getElementById("btnAlertas");
const alertasBadge   = document.getElementById("alertasBadge");

// —— Modal actividad
const modalBg        = document.getElementById("modal-backdrop");
const modal          = document.getElementById("modal");
const formModal      = document.getElementById("modal-form");
const fldFecha       = document.getElementById("m-fecha");
const fldHi          = document.getElementById("m-horaInicio");
const fldHf          = document.getElementById("m-horaFin");
const fldAct         = document.getElementById("m-actividad");
const fldAdultos     = document.getElementById("m-adultos");
const fldEstudiantes = document.getElementById("m-estudiantes");
const fldPax         = document.getElementById("m-pax");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

// [NUEVO] opciones de notas cuando el servicio usa voucher "TICKET"
const TICKET_NOTAS_OPCIONES = [
  "PEDIR TICKETS A CDRA. GENERAL",
  "COORDINADOR(A) LLEVA LOS TICKETS",
  "PEDIR TICKETS EN VENTANILLA",
  "OTRO"
];

let notasTicketSelect = null;  // se crea bajo demanda en el modal

// —— Modal Alertas
const modalAlertas       = document.getElementById("modal-alertas");
const btnCloseAlertas    = document.getElementById("alertas-close");
const listAlertasActual  = document.getElementById("alertas-actual");
const listAlertasOtros   = document.getElementById("alertas-otros");
const listAlertasLeidas   = document.getElementById("alertas-actual-leidas");
const listAlertasPend     = document.getElementById("alertas-pendientes");

/* [ADD] Refs Modal Estadísticas */
const modalStats   = document.getElementById("modal-estadisticas");
const bgStats      = document.getElementById("modal-backdrop-stats");
const btnStats     = document.getElementById("btnEstadisticas");
const btnStatsClose= document.getElementById("stats-close");
const selAno       = document.getElementById("fAno");
const selDestino   = document.getElementById("fDestino");
const selPrograma  = document.getElementById("fPrograma");
const inpDiaDesde  = document.getElementById("fDiaDesde");
const inpDiaHasta  = document.getElementById("fDiaHasta");
const selBaseGrupo = document.getElementById("fBaseGrupo");
const chkPares     = document.getElementById("fPares");
const rngWOrden    = document.getElementById("wOrden");
const rngWSet      = document.getElementById("wSet");
const rngWMeta     = document.getElementById("wMeta");
const btnRunStats  = document.getElementById("btnRunStats");
const btnExportCSV = document.getElementById("btnExportCSV");
const kpisDiv      = document.getElementById("stats-kpis");
const resultsDiv   = document.getElementById("stats-results");
const detailDiv    = document.getElementById("stats-detail");
const inpUmbral   = document.getElementById("fUmbral"); // ← NUEVO (0..1, ej: 0.70)

/* [ADD] Cache para estadísticas */
let STATS_GROUPS_CACHE = null;  // [{id, ...data}]
let STATS_SIGS_CACHE   = new Map(); // grupoId -> firma calculada
let STATS_LAST_ROWS    = [];    // última tabla para export CSV
let STATS_LAST_CONSENSUS = null; // ← NUEVO: última plantilla-consenso para exportar


let editData    = null;    // { fecha, idx, ...act }
let choicesDias = null;    // Choices.js instance
let choicesGrupoNum = null;
let choicesGrupoNom = null;
let editMode    = false;
let swapOrigin  = null;    // selección inicial para intercambio
const hotelCache = new Map(); // hotelId -> { nombre, destino }

// —————————————————————————————————
// Helper: suma pax en el modal
// —————————————————————————————————
function actualizarPax() {
  const a = parseInt(fldAdultos.value, 10) || 0;
  const e = parseInt(fldEstudiantes.value, 10) || 0;
  fldPax.value = a + e;
}
fldAdultos.addEventListener('input', actualizarPax);
fldEstudiantes.addEventListener('input', actualizarPax);

// Evita submits/bubbling accidentales
function stopAll(e) {
  if (e) { e.preventDefault?.(); e.stopPropagation?.(); }
}

// —————————————————————————————————
// Revisión a nivel de DÍA (bandera independiente de las actividades)
// guarda en grupos.revisionDias[fecha] = { estado, motivo, usuario, timestamp }
// —————————————————————————————————
function getRevisionDia(g, fecha) {
  return (g.revisionDias && g.revisionDias[fecha]) || null;
}

async function setRevisionDia(grupoId, fecha, estado, motivo = '') {
  const ref  = doc(db, 'grupos', grupoId);
  const snap = await getDoc(ref);
  const g    = snap.data() || {};
  const rev  = { ...(g.revisionDias || {}) };

  if (!estado) {
    delete rev[fecha]; // limpiar
  } else {
    rev[fecha] = {
      estado,                 // 'pendiente' | 'ok' | 'rechazado'
      motivo: (motivo || '').trim(),
      usuario: (auth.currentUser && auth.currentUser.email) || '',
      timestamp: new Date()
    };
  }
  await updateDoc(ref, { revisionDias: rev });
  return rev; // mapa actualizado
}

// —————————————————————————————————
/** Helper unificado para HISTORIAL **/
// —————————————————————————————————
async function logHist(grupoId, accion, extra = {}) {
  try {
    let g = extra._group;
    if (!g) {
      const s = await getDoc(doc(db,'grupos',grupoId));
      g = s.exists() ? s.data() : {};
    }
    const base = {
      grupoId,
      numeroNegocio: g.numeroNegocio || grupoId,
      nombreGrupo: (g.nombreGrupo || '').toString(),
      accion,
      usuario: (auth.currentUser && auth.currentUser.email) || '',
      timestamp: new Date()
    };
    const payload = { ...base, ...extra };
    delete payload._group; // no persistir helper
    await addDoc(collection(db,'historial'), payload);
  } catch (e) {
    console.warn('Historial no registrado:', e);
  }
}

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 2.1) Cargo todos los grupos
  const snap   = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  
  // 2.2) Poblamos selects
  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${(g.nombreGrupo||'').toString().toUpperCase()}</option>`
  ).join('');
  
  // 2.2.1) Inicializa Choices.js
  if (!choicesGrupoNum) {
    choicesGrupoNum = new Choices(selectNum, {
      searchEnabled: true,
      itemSelectText: '',
      placeholderValue: 'Buscar número de negocio',
      shouldSort: false
    });
  } else {
    choicesGrupoNum.setChoices(grupos.map(g=>({value: g.id, label: g.numeroNegocio})), 'value', 'label', true);
  }
  
  if (!choicesGrupoNom) {
    choicesGrupoNom = new Choices(selectName, {
      searchEnabled: true,
      itemSelectText: '',
      placeholderValue: 'Buscar nombre de grupo',
      shouldSort: false
    });
  } else {
    choicesGrupoNom.setChoices(grupos.map(g=>({value: g.id, label: (g.nombreGrupo||'').toString().toUpperCase()})), 'value', 'label', true);
  }
  
  // 2.3) Sincronizo ambos selects
  choicesGrupoNum.passedElement.element.onchange = () => {
    choicesGrupoNom.setChoiceByValue(selectNum.value);
    renderItinerario();
  };
  choicesGrupoNom.passedElement.element.onchange = () => {
    choicesGrupoNum.setChoiceByValue(selectName.value);
    renderItinerario();
  };
  
  // 2.4) Quick-Add, Modal, Plantillas, Alertas
  qaAddBtn.onclick        = (e)=>{ stopAll(e); quickAddActivity(); };
  btnCancel.onclick       = (e)=>{ stopAll(e); closeModal(); };
  formModal.onsubmit      = onSubmitModal;
  btnGuardarTpl.onclick   = (e)=>{ stopAll(e); guardarPlantilla(); };
  btnCargarTpl.onclick    = (e)=>{ stopAll(e); cargarPlantilla(); };

  if (btnAlertas) {
    btnAlertas.onclick      = (e)=>{ stopAll(e); openAlertasPanel(); };
  }
  if (btnCloseAlertas) {
    btnCloseAlertas.onclick = (e)=>{ 
      stopAll(e);
      modalAlertas.style.display = "none"; 
      document.getElementById("modal-backdrop").style.display="none";
      document.body.classList.remove('modal-open');
    };
  }

  // Historial
  if (btnHistorial) {
    btnHistorial.onclick = (e) => { stopAll(e); openHistorialPanel(); };
  }
  if (btnCloseHistorial) {
    btnCloseHistorial.onclick = (e) => {
      stopAll(e);
      if (modalHistorial) modalHistorial.style.display = "none";
      if (modalBg)        modalBg.style.display = "none";
      document.body.classList.remove('modal-open');  // <- importante
    };
  }
  // filtro en vivo
  if (filtroHistorial) {
    filtroHistorial.oninput = () => {
      const q = (filtroHistorial.value || '').trim().toLowerCase();
      const data = !q ? historialCache : historialCache.filter(it => {
        const campos = [
          it.accion, it.usuario, it.motivo, it.detalle,
          it.anterior, it.nuevo, it.path, it.nombreGrupo,
          it.numeroNegocio
        ].map(x => (x ?? '').toString().toLowerCase());
        return campos.some(c => c.includes(q));
      });
      renderHistorialList(data);
    };
  }

  // ⬇️⬇️⬇️ PONER AQUÍ EL PUNTO 4 (listeners del modal de estadísticas) ⬇️⬇️⬇️
  if (btnStats) {
    btnStats.onclick = (e)=>{ stopAll(e); openStatsModal(); };
  }
  if (btnStatsClose) {
    btnStatsClose.onclick = (e)=>{ stopAll(e); closeStatsModal(); };
  }
  if (bgStats) {
    bgStats.onclick = (e)=>{ stopAll(e); closeStatsModal(); };
  }
  if (btnRunStats) {
    btnRunStats.onclick = async (e)=>{ stopAll(e); await runStats(); };
  }
  if (btnExportCSV) {
    btnExportCSV.onclick = (e)=>{ stopAll(e); exportStatsCSV(); };
  }
  // ⬆️⬆️⬆️ FIN PUNTO 4 ⬆️⬆️⬆️

  await cargarListaPlantillas();

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// ————— Botón Activar/Desactivar edición —————
const btnToggleEdit = document.getElementById("btnToggleEdit");
btnToggleEdit.onclick = (e) => {
  stopAll(e);
  editMode = !editMode;
  btnToggleEdit.textContent = editMode ? "🔒 Desactivar edición" : "🔓 Activar edición";
  document.getElementById("quick-add").style.display = editMode ? "none" : "";
  btnGuardarTpl.disabled = editMode;
  btnCargarTpl.disabled  = editMode;
  renderItinerario();
};

// —————————————————————————————————
// Autocomplete de actividades
// —————————————————————————————————
async function obtenerActividadesPorDestino(destino) {
  if (!destino) return [];
  const colecServicios = "Servicios";
  const colecListado   = "Listado";
  const partes = destino.toString()
    .split(/\s+Y\s+/i)
    .map(s => s.trim().toUpperCase());
  const todas = [];
  for (const parte of partes) {
    const ref = collection(db, colecServicios, parte, colecListado);
    try {
      const snap = await getDocs(ref);
      snap.docs.forEach(ds =>
        todas.push(((ds.data().nombre || ds.data().servicio || ds.id) || '').toString().toUpperCase())
      );
    } catch (_) { /* subcolección inexistente: ignorar */ }
  }
  return [...new Set(todas)].sort();
}

async function prepararCampoActividad(inputId, destino) {
  const input = document.getElementById(inputId);
  const acts  = await obtenerActividadesPorDestino(destino);
  const oldList = document.getElementById("lista-" + inputId);
  if (oldList) oldList.remove();
  const dl = document.createElement("datalist");
  dl.id = "lista-" + inputId;
  acts.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a;
    dl.appendChild(opt);
  });
  document.body.appendChild(dl);
  input.setAttribute("list", "lista-" + inputId);
}

// ======================================================
// Catálogo de servicios por destino (con alias + normalización)
// ======================================================
async function getServiciosMaps(destinoStr) {
  const partes = destinoStr
    ? destinoStr.toString().split(/\s+Y\s+/i).map(s => s.trim().toUpperCase())
    : [];
  const byId = new Map();
  const byName = new Map();
  const packs = [];

  for (const parte of partes) {
    try {
      const snap = await getDocs(collection(db, 'Servicios', parte, 'Listado'));
      snap.forEach(ds => {
        const id   = ds.id;
        const data = ds.data() || {};
        const visible = ((data.nombre || data.servicio || id) || '').toString();
        const pack = { id, destino: parte, nombre: visible.toUpperCase(), nombreK: K(visible), data };
        byId.set(id, pack);
        packs.push(pack);
        byName.set(pack.nombreK, pack);
        byName.set(K(id), pack);
        if (data.servicio) byName.set(K(data.servicio), pack);
        if (Array.isArray(data.aliases)) {
          data.aliases.forEach(a => { const key = K(a); if (key) byName.set(key, pack); });
        }
      });
    } catch (_) { /* destino no existente: ignorar */ }
  }
  return { byId, byName, packs };
}

// ===================================================================
/** Sincroniza actividades con Servicios (si aplica) y asegura campo revision **/
// ===================================================================
async function syncItinerarioServicios(grupoId, g, svcMaps) {
  const it = g.itinerario || {};
  const fechas = Object.keys(it).sort((a,b)=> new Date(a) - new Date(b));
  let hayCambios = false;
  const nuevo = {};

  for (const f of fechas) {
    const arr = (it[f] || []);
    const nuevoArr = arr.map(act => {
      const res = { ...act };
      const keyName = K(res.actividad || '');

      if (res.servicioId && svcMaps.byId.has(res.servicioId)) {
        const sv = svcMaps.byId.get(res.servicioId);
        if (res.actividad !== sv.nombre || res.servicioNombre !== sv.nombre || res.servicioDestino !== sv.destino) {
          res.actividad = sv.nombre;
          res.servicioNombre = sv.nombre;
          res.servicioDestino = sv.destino;
          hayCambios = true;
        }
      } else if (svcMaps.byName.has(keyName)) {
        const sv = svcMaps.byName.get(keyName);
        if (res.servicioId !== sv.id || res.servicioNombre !== sv.nombre || res.servicioDestino !== sv.destino || res.actividad !== sv.nombre) {
          res.servicioId = sv.id;
          res.servicioNombre = sv.nombre;
          res.servicioDestino = sv.destino;
          res.actividad = sv.nombre;
          hayCambios = true;
        }
      }
      if (!res.revision) res.revision = 'pendiente'; // asegurar revisión
      return res;
    });
    nuevo[f] = nuevoArr;
  }

  if (hayCambios) {
    await updateDoc(doc(db,'grupos',grupoId), { itinerario: nuevo });
  }
  return { it: hayCambios ? nuevo : it, changed: hayCambios };
}

// —————————————————————————————————
// Estado Revisión + Alertas (helpers)
// —————————————————————————————————
function computeEstadoFromItinerario(IT, revDias = {}) {
  let anyAct = false, anyX = false, allOK = true;

  // 2.1) Estado por actividad
  for (const f of Object.keys(IT || {})) {
    for (const act of (IT[f] || [])) {
      anyAct = true;
      const r = act.revision || 'pendiente';
      if (r === 'rechazado') anyX = true;
      if (r !== 'ok') allOK = false;
    }
  }

  // 2.2) Estado por DÍA (independiente de actividades)
  const dias = Object.keys(revDias || {});
  for (const f of dias) {
    const st = (revDias[f] && revDias[f].estado) || 'pendiente';
    if (st === 'rechazado') anyX = true;
    if (st !== 'ok') allOK = false;
  }

  // 2.3) Resolución final
  if (!anyAct && dias.length === 0) return 'PENDIENTE';
  if (anyX)  return 'RECHAZADO';
  return allOK ? 'OK' : 'PENDIENTE';
}

function setEstadoBadge(estado) {
  if (!estadoBadge) return;
  estadoBadge.textContent = estado;
  estadoBadge.classList.remove('badge-ok','badge-pendiente','badge-rechazado');
  if (estado === 'OK') estadoBadge.classList.add('badge-ok');
  else if (estado === 'RECHAZADO') estadoBadge.classList.add('badge-rechazado');
  else estadoBadge.classList.add('badge-pendiente');
}

// Reemplazo total de refreshAlertasBadge(...)
async function refreshAlertasCounts(grupoId) {
  let noVistasActual = 0; // (Y) no leídas del grupo en foco
  let totalRech = 0;      // (X) total de grupos con revisión RECHAZADA

  // No leídas del grupo actual
  try {
    const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
    noVistasActual = qs.docs.filter(d => !((d.data()||{}).visto)).length;
  } catch(_) {}

  // Total de grupos RECHAZADOS
  try {
    const qsRech = await getDocs(query(
      collection(db,'grupos'),
      where('estadoRevisionItinerario','==','RECHAZADO')
    ));
    totalRech = qsRech.size;
  } catch(_) {}

  // Actualiza el texto del botón: "⚠️ Alertas | X (Y)"
  const label = `⚠️ Alertas | ${totalRech} (${noVistasActual})`;
  if (btnAlertas) btnAlertas.textContent = label;

  // Compatibilidad con el badge antiguo (si existe en el HTML)
  if (alertasBadge) alertasBadge.textContent = String(noVistasActual);

  return { totalRech, noVistasActual };
}

// Crea/actualiza una barrita de resumen dentro del modal
function upsertResumenOK(count){
  if (!modalAlertas) return;
  let bar = modalAlertas.querySelector('.alertas-resumen');
  if (!bar){
    bar = document.createElement('div');
    bar.className = 'alertas-resumen';
    // La insertamos al inicio del contenido del modal (debajo del título)
    modalAlertas.insertBefore(bar, modalAlertas.firstChild ? modalAlertas.firstChild.nextSibling : null);
  }
  bar.innerHTML = `<span class="pill pill-ok">Grupos OK: <b>${count}</b></span>`;
}

async function updateEstadoRevisionAndBadge(grupoId, ITopt = null) {
  const gSnap = await getDoc(doc(db, 'grupos', grupoId));
  const g     = gSnap.data() || {};
  const IT    = ITopt || g.itinerario || {};
  const rev   = g.revisionDias || {};

  const nuevoEstado = computeEstadoFromItinerario(IT, rev);
  if (g.estadoRevisionItinerario !== nuevoEstado) {
    await updateDoc(doc(db,'grupos',grupoId), { estadoRevisionItinerario: nuevoEstado });
  }
  setEstadoBadge(nuevoEstado);
  await refreshAlertasCounts(grupoId);
}

// —————————————————————————————————
// Panel de Alertas
// —————————————————————————————————
async function openAlertasPanel() {
  const grupoId = selectNum.value;
  if (!grupoId) return alert("Selecciona un grupo");

  if (!modalAlertas) return; // por si no existe en el HTML actual

  modalAlertas.style.display = "block";
  document.getElementById("modal-backdrop").style.display = "block";
  modalAlertas.style.display = "block";
  document.getElementById("modal-backdrop").style.display = "block";
  document.body.classList.add('modal-open'); // (si ya lo tienes, déjalo)
  
  /* ——— NUEVO: contar grupos en estado OK y mostrarlo ——— */
  let okCount = 0;
  try {
    const qsOK = await getDocs(query(
      collection(db,'grupos'),
      where('estadoRevisionItinerario','==','OK')
    ));
    okCount = qsOK.size;
  } catch(_) {}
  upsertResumenOK(okCount);

  document.body.classList.add('modal-open');

  // 1) Alertas del grupo (separadas)
  if (listAlertasActual) listAlertasActual.innerHTML = "Cargando…";
  if (listAlertasLeidas) listAlertasLeidas.innerHTML = "";
  
  try {
    const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
    const arr = qs.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => new Date(b.creadoEn || 0) - new Date(a.creadoEn || 0));
  
    const noVistas = arr.filter(a => !a.visto);
    const vistas   = arr.filter(a =>  a.visto);
  
    // No leídas
    listAlertasActual.innerHTML = noVistas.length
      ? noVistas.map(a => `
          <li class="alert-item">
            <div>
              <strong>${a.actividad || '(actividad)'}</strong>
              <small> · ${a.fecha || ''} ${a.horaInicio ? `· ${a.horaInicio}${a.horaFin ? '–'+a.horaFin : ''}` : ''}</small>
              ${a.motivo ? `<div class="motivo">Motivo: ${a.motivo}</div>`:''}
              ${a.creadoPor ? `<div class="meta" style="opacity:.7;">Rechazado por: ${a.creadoPor}</div>`:''}
            </div>
            <div class="actions">
              <button type="button" data-id="${a.id}" class="btn-ver-alerta">Marcar visto</button>
            </div>
          </li>
        `).join('')
      : `<li class="alert-item"><div>— Sin alertas —</div></li>`;
  
    // Leídas
    listAlertasLeidas.innerHTML = vistas.length
      ? vistas.map(a => `
          <li class="alert-item visto">
            <div>
              <strong>${a.actividad || '(actividad)'}</strong>
              <small> · ${a.fecha || ''} ${a.horaInicio ? `· ${a.horaInicio}${a.horaFin ? '–'+a.horaFin : ''}` : ''}</small>
              ${a.motivo ? `<div class="motivo">Motivo: ${a.motivo}</div>`:''}
              ${a.creadoPor ? `<div class="meta" style="opacity:.7;">Rechazado por: ${a.creadoPor}</div>`:''}
              ${(a.leidoPor || a.leidoEn) ? `<div class="meta" style="opacity:.7;">Leído por: ${a.leidoPor || '—'} · ${a.leidoEn ? new Date(a.leidoEn.seconds ? a.leidoEn.seconds*1000 : a.leidoEn).toLocaleString('es-CL') : ''}</div>` : ''}
            </div>
            <div class="actions"></div>
          </li>
        `).join('')
      : `<li class="alert-item"><div>— No hay alertas leídas —</div></li>`;
  
    // Handler "Marcar visto" (guarda quién la leyó + cuándo)
    listAlertasActual.querySelectorAll('.btn-ver-alerta').forEach(btn=>{
      btn.onclick = async (e) => {
        stopAll(e);
        const id = btn.getAttribute('data-id');
        await updateDoc(doc(db,'grupos',grupoId,'alertas',id), {
          visto: true,
          leidoPor: auth.currentUser.email,
          leidoEn: new Date()
        });
        await refreshAlertasCounts(grupoId);
        openAlertasPanel(); // recarga
      };
    });
  } catch (e) {
    if (listAlertasActual) listAlertasActual.innerHTML = `<li class="empty">Error al cargar alertas.</li>`;
    if (listAlertasLeidas) listAlertasLeidas.innerHTML = ``;
  }


  // 2) Otros grupos con estado RECHAZADO
  if (listAlertasOtros) listAlertasOtros.innerHTML = "Cargando…";
  try {
    const qsRech = await getDocs(query(collection(db,'grupos'), where('estadoRevisionItinerario','==','RECHAZADO')));
    const otros = qsRech.docs
      .filter(d => d.id !== grupoId)
      .map(d => ({ id: d.id, ...(d.data()||{}) }));
    if (!otros.length) {
      if (listAlertasOtros) listAlertasOtros.innerHTML = `<li class="empty">— No hay otros grupos con revisión rechazada —</li>`;
    } else {
      if (listAlertasOtros) {
        listAlertasOtros.innerHTML = otros.map(g=>`
          <li class="alert-item">
            <div>
              <strong>${(g.nombreGrupo||'').toString().toUpperCase()}</strong>
              <small> · #${g.numeroNegocio||g.id} · ${g.estadoRevisionItinerario||''}</small>
            </div>
            <div class="actions">
              <button type="button" class="btn-ir-grupo" data-id="${g.id}">Ir al itinerario</button>
            </div>
          </li>
        `).join('');
        listAlertasOtros.querySelectorAll('.btn-ir-grupo').forEach(btn=>{
          btn.onclick = (e) => {
            stopAll(e);
            const id = btn.getAttribute('data-id');
            choicesGrupoNum.setChoiceByValue(id);
            choicesGrupoNom.setChoiceByValue(id);
            modalAlertas.style.display = "none";
            document.getElementById("modal-backdrop").style.display = "none";
            document.body.classList.remove('modal-open');
            renderItinerario();
          };
        });
      }
    }
  } catch (e) {
    if (listAlertasOtros) listAlertasOtros.innerHTML = `<li class="empty">Error al cargar otros grupos.</li>`;
  }
}

// 3) Otros grupos con estado PENDIENTE
if (listAlertasPend) listAlertasPend.innerHTML = "Cargando…";
try {
  const qsPend = await getDocs(query(collection(db,'grupos'), where('estadoRevisionItinerario','==','PENDIENTE')));
  const otrosP = qsPend.docs
    .filter(d => d.id !== grupoId)
    .map(d => ({ id: d.id, ...(d.data()||{}) }));
  listAlertasPend.innerHTML = otrosP.length
    ? otrosP.map(g=>`
        <li class="alert-item">
          <div>
            <strong>${(g.nombreGrupo||'').toString().toUpperCase()}</strong>
            <small> · #${g.numeroNegocio||g.id} · ${g.estadoRevisionItinerario||''}</small>
          </div>
          <div class="actions">
            <button type="button" class="btn-ir-grupo" data-id="${g.id}">Ir al itinerario</button>
          </div>
        </li>
      `).join('')
    : `<li class="alert-item"><div>— No hay otros grupos pendientes —</div></li>`;

  listAlertasPend.querySelectorAll('.btn-ir-grupo').forEach(btn=>{
    btn.onclick = (e) => {
      stopAll(e);
      const id = btn.getAttribute('data-id');
      choicesGrupoNum.setChoiceByValue(id);
      choicesGrupoNom.setChoiceByValue(id);
      modalAlertas.style.display = "none";
      document.getElementById("modal-backdrop").style.display = "none";
      document.body.classList.remove('modal-open');
      renderItinerario();
    };
  });
} catch (e) {
  if (listAlertasPend) listAlertasPend.innerHTML = `<li class="empty">Error al cargar grupos pendientes.</li>`;
}

// —————————————————————————————————
/** 3) renderItinerario(): dibuja grilla (sincronizado) **/
// —————————————————————————————————

// —————————————————————————————————
// HOTELS: asignaciones por día para el grupo
// —————————————————————————————————

// Genera lista de días ISO en el rango [ini, fin) (excluye checkOut)
function isoDaysHalfOpen(checkInISO, checkOutISO) {
  const out = [];
  if (!checkInISO || !checkOutISO) return out;
  const start = new Date(checkInISO + 'T00:00:00');
  const end   = new Date(checkOutISO + 'T00:00:00');
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

// Carga nombres de hoteles faltantes al cache
async function loadHotelsByIds(ids) {
  const missing = [...ids].filter(id => id && !hotelCache.has(id));
  if (!missing.length) return;
  for (const hid of missing) {
    try {
      const snap = await getDoc(doc(db, 'hoteles', hid));
      const data = snap.data() || {};
      hotelCache.set(hid, { nombre: (data.nombre || '').toString(), destino: (data.destino || '').toString() });
    } catch (_) {
      hotelCache.set(hid, { nombre: '', destino: '' });
    }
  }
}

// Devuelve un mapa { 'YYYY-MM-DD': [ asignacionesDeEseDía ] } para el grupo
async function buildHotelDayMapForGroup(grupoId) {
  const qs = await getDocs(query(collection(db, 'hotelAssignments'), where('grupoId', '==', grupoId)));
  const assigns = qs.docs.map(d => ({ id: d.id, ...d.data() }));

  // Pre-cargar nombres de hoteles usados por este grupo
  const hotelIds = new Set(assigns.map(a => a.hotelId).filter(Boolean));
  await loadHotelsByIds(hotelIds);

  // Expandir a días
  const dayMap = {};
  for (const a of assigns) {
    const days = isoDaysHalfOpen(a.checkIn, a.checkOut);
    for (const iso of days) {
      if (!dayMap[iso]) dayMap[iso] = [];
      dayMap[iso].push(a);
    }
  }
  return dayMap;
}

async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data() || {};

  // Título
  titleGrupo.textContent = (g.programa||"–").toUpperCase();

  // Autocomplete
  await prepararCampoActividad("qa-actividad", g.destino);

  // Inicializar itinerario si no existe O si existe vacío
  if (!g.itinerario || Object.keys(g.itinerario || {}).length === 0) {
    let rango = getDateRange(g.fechaInicio, g.fechaFin);
  
    // Si no hay fechas reales, usar cantidad de días/noches
    if (!rango.length) {
      rango = getDiasRelativos(g);
    }
  
    const init = {};
    rango.forEach(d => init[d] = []);
  
    await updateDoc(doc(db, 'grupos', grupoId), { itinerario: init });
    g.itinerario = init;
  }

  // Sincronizar con Servicios
  const svcMaps = await getServiciosMaps(g.destino || '');
  const syncRes = await syncItinerarioServicios(grupoId, g, svcMaps);
  const IT = syncRes.it;

  // Estado + alertas badge
  await updateEstadoRevisionAndBadge(grupoId, IT);

  // Fechas ordenadas
  const fechas = Object.keys(IT).sort(sortDiasItinerario);

  // —— Hoteles por día para este grupo ——
  const hotelByDay = await buildHotelDayMapForGroup(grupoId);
  const lastFecha = fechas[fechas.length - 1] || null;

  // Choices días
  const opts = fechas.map((d,i)=>({ value: i, label: `Día ${i+1} – ${formatDiaItinerario(d)}` }));
  if (choicesDias) { choicesDias.clearChoices(); choicesDias.setChoices(opts,'value','label',false); }
  else { choicesDias = new Choices(qaDia, { removeItemButton: true, placeholderValue: 'Selecciona día(s)', choices: opts }); }

  // Select fecha del modal
  fldFecha.innerHTML = fechas.map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDiaItinerario(d)}</option>`).join('');

  // Helper botón
  function createBtn(icon, cls, title='') { const b = document.createElement("span"); b.className = cls; b.textContent = icon; b.title = title; b.style.cursor = "pointer"; return b; }

  // Pintar días
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    const [yyyy, mm, dd] = fecha.split('-').map(Number);
    const d = new Date(yyyy, mm - 1, dd);
    if (d.getDay() === 0) sec.classList.add('domingo');

    sec.innerHTML = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button type="button" class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    
    if (editMode) {
      const h3 = sec.querySelector("h3");
    
      // Badge de estado del DÍA (independiente de actividades)
      const revDia = getRevisionDia(g, fecha);
      const badge = document.createElement('span');
      badge.style.marginLeft = '8px';
      badge.className = 'badge ' + (
        revDia?.estado === 'rechazado' ? 'badge-rechazado' :
        revDia?.estado === 'ok'        ? 'badge-ok' :
                                         'badge-pendiente'
      );
      badge.textContent = (revDia?.estado || 'pendiente').toUpperCase();
      h3.appendChild(badge);
    
      // Si está rechazado, mostrar motivo debajo del título
      if (revDia?.estado === 'rechazado' && revDia?.motivo) {
        const p = document.createElement('p');
        p.className = 'rechazo-motivo';
        p.style.margin = '.25rem 0 0';
        p.textContent = `❌ Día rechazado: ${revDia.motivo}`;
        h3.appendChild(p);
      }
    
      // Botones
      const btnSwapDay   = createBtn("🔄", "btn-swap-day", "Intercambiar día");
      const btnEditDate  = createBtn("✏️", "btn-edit-date", "Editar fecha base");
      const btnRejectDay = createBtn("❌", "btn-reject-day", "Rechazar DÍA (sin tocar actividades)");
      const btnClearDay  = createBtn("🧹", "btn-clear-day", "Quitar rechazo de DÍA");
      const btnHardDay   = createBtn("⛔", "btn-reject-hard", "Rechazar DÍA + marcar TODAS ❌");
    
      btnSwapDay.dataset.fecha   = fecha;
      btnEditDate.dataset.fecha  = fecha;
      btnRejectDay.dataset.fecha = fecha;
      btnClearDay.dataset.fecha  = fecha;
      btnHardDay.dataset.fecha   = fecha;
    
      h3.appendChild(btnSwapDay);
      h3.appendChild(btnEditDate);
      h3.appendChild(btnRejectDay);
      h3.appendChild(btnClearDay);
      h3.appendChild(btnHardDay);
    
      btnSwapDay.onclick   = (e) => { stopAll(e); handleSwapClick("dia", fecha); };
      btnEditDate.onclick  = (e) => { stopAll(e); handleDateEdit(fecha); };
      btnRejectDay.onclick = (e) => { stopAll(e); handleRejectDayFlag(fecha); };
      btnClearDay.onclick  = (e) => { stopAll(e); handleClearRejectDay(fecha); };
      btnHardDay.onclick   = (e) => { stopAll(e); handleRejectDayHard(fecha); };
    }

    // —— Caja ALOJAMIENTO (bajo el título del día) ——
    {
      const ulAnchor = sec.querySelector(".activity-list");
    
      const asigns = hotelByDay[fecha] || [];
      const prefer = asigns.filter(a => (a.status || '').toLowerCase() === 'confirmado');
      const use    = prefer.length ? prefer : asigns;
    
      const names = [...new Set(use.map(a => {
        const h  = hotelCache.get(a.hotelId) || {};
        const nm = (h.nombre || '').toString().toUpperCase() || '(SIN NOMBRE)';
        return (a.status && a.status.toLowerCase() !== 'confirmado') ? `${nm} (PENDIENTE)` : nm;
      }))];
    
      const box = document.createElement('div');
      box.className = 'hotel-box';
      box.innerHTML = `
        <div><strong>ALOJAMIENTO:</strong></div>
        ${
          names.length
            ? names.map(n => `<div>– ${n}</div>`).join('')
            : (fecha === lastFecha
                ? `<div>– ÚLTIMO DÍA DEL VIAJE</div>`
                : `<div>– (SIN ASIGNACIÓN)</div>`
              )
        }
      `;
    
      // Insertar inmediatamente debajo del título, antes de la lista
      sec.insertBefore(box, ulAnchor);
    }

    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = (e)=> { stopAll(e); openModal({ fecha }, false); };

    const ul  = sec.querySelector(".activity-list");
    const original = IT[fecha] || [];
    const withIndex = original.map((act, originalIdx) => ({ act, originalIdx }));

    // Ordenar visualmente por hora
    const sorted = withIndex.slice().sort((a, b) => ((a.act.horaInicio||'').localeCompare(b.act.horaInicio||'')));

    // Pax centrales
    const A = parseInt(g.adultos, 10) || 0;
    const E = parseInt(g.estudiantes, 10) || 0;
    const totalGrupo = (() => { const t = parseInt(g.cantidadgrupo, 10); return Number.isFinite(t) ? t : (A + E); })();

    if (!sorted.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      sorted.forEach(({ act, originalIdx }) => {
        // Nombre visible
        let visibleName = act.actividad || '';
        if (act.servicioId && svcMaps.byId.has(act.servicioId)) {
          visibleName = svcMaps.byId.get(act.servicioId).nombre;
        } else {
          const key = K(act.actividad || ''); if (svcMaps.byName.has(key)) visibleName = svcMaps.byName.get(key).nombre;
        }

        const revision = act.revision || 'pendiente';
        const iconRev  = revision === 'ok' ? '✅' : (revision === 'rechazado' ? '❌' : '⭕');
        const motivoHTML = (revision === 'rechazado' && (act.rechazoMotivo || '').trim())
          ? `<p class="rechazo-motivo">❌ Motivo: ${(act.rechazoMotivo || '').trim()}</p>`
          : '';
        const titleRev = revision === 'ok' ? 'Revisado (OK)' : (revision === 'rechazado' ? 'Rechazado' : 'Pendiente');

        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio || '--:--'} – ${act.horaFin || '--:--'}</h4>
          <p><strong>${visibleName}</strong></p>
          <p>👥 ${totalGrupo} pax (A:${A} E:${E})</p>
          ${motivoHTML}
          <div class="actions">
            ${editMode
              ? `<button type="button" class="btn-edit">✏️</button>
                 <button type="button" class="btn-del">🗑️</button>`
              : `<span class="rev-static" title="${titleRev}">${iconRev}</span>`}
          </div>
        `;

        if (editMode) {
          // Editar
          li.querySelector(".btn-edit").onclick = (e) => {
            stopAll(e);
            openModal({ ...act, fecha, idx: originalIdx }, true);
          };

          // Borrar
          li.querySelector(".btn-del").onclick  = async (e) => {
            stopAll(e);
            if (!confirm("¿Eliminar actividad?")) return;
            const beforeObj = original[originalIdx];
            const arr = original.slice();
            arr.splice(originalIdx, 1);

            await logHist(grupoId, 'BORRAR ACTIVIDAD', {
              _group: g,
              fecha, idx: originalIdx,
              anterior: beforeObj?.actividad || '',
              nuevo: '',
              antesObj: beforeObj || null,
              despuesObj: null,
              path: `itinerario.${fecha}[${originalIdx}]`
            });

            await updateDoc(doc(db, 'grupos', grupoId), { [`itinerario.${fecha}`]: arr });
            await updateEstadoRevisionAndBadge(grupoId, { ...IT, [fecha]: arr });
            renderItinerario();
          };

          // Botón tri-estado (⭕/✅/❌)
          const btnRev = createBtn(iconRev, "btn-revision", `Cambiar estado: ${titleRev}`);
          li.querySelector(".actions").appendChild(btnRev);
          btnRev.onclick = async (e) => {
            stopAll(e);
            // Pasamos referencias UI para actualizar SOLO esta tarjeta, sin re-render global.
            await toggleRevisionEstado(grupoId, fecha, originalIdx, act, visibleName, IT, { li, btn: btnRev });
          };

          // Swap de actividad
          const btnSwapAct = createBtn("🔄", "btn-swap-act", "Intercambiar actividad");
          btnSwapAct.dataset.fecha = fecha;
          btnSwapAct.dataset.idx   = originalIdx;
          li.querySelector(".actions").appendChild(btnSwapAct);
          btnSwapAct.onclick = (e) => {
            stopAll(e);
            handleSwapClick("actividad", { fecha, idx: originalIdx });
          };
        }

        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
/** 4) quickAddActivity(): añade en varios días (enlazando servicio) **/
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = (choicesDias.getValue(true) || []).map(x => parseInt(x,10));
  const horaInicio = qaHoraInicio.value;
  const textRaw    = qaAct.value.trim();
  const textUpper  = textRaw.toUpperCase();
  if (!selIdx.length || !textUpper) return alert("Selecciona día(s) y escribe la actividad");

  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};
  const totalAdults   = parseInt(g.adultos, 10)     || 0;
  const totalStudents = parseInt(g.estudiantes, 10) || 0;

  const svcMaps = await getServiciosMaps(g.destino || '');
  const key = K(textUpper);
  const sv  = svcMaps.byName.get(key) || null;

  // ¿Este servicio usa voucher TICKET?
  const isTicketService = !!(sv && sv.data && String(sv.data.voucher || '').toUpperCase() === 'TICKET');
  const actNameUpperForTicket = ((sv ? sv.nombre : textUpper) || '').toString().toUpperCase();

  const fechas = Object.keys(g.itinerario).sort(sortDiasItinerario);

  for (let idx of selIdx) {
    const f   = fechas[idx];
    const arr = g.itinerario[f]||[];

    // Nota por defecto para servicios TICKET
    let notaDefault = "";
    if (isTicketService) {
      if (actNameUpperForTicket === 'BIG WHEEL (RUEDA GIGANTE)') {
        notaDefault = 'PEDIR TICKETS EN VENTANILLA';
      } else {
        notaDefault = 'PEDIR TICKETS A CDRA. GENERAL';
      }
    }

    const item = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  sv ? sv.nombre : textUpper,
      pasajeros:  totalAdults + totalStudents,
      adultos:    totalAdults,
      estudiantes:totalStudents,
      notas:      notaDefault,
      servicioId:       sv ? sv.id : null,
      servicioNombre:   sv ? sv.nombre : null,
      servicioDestino:  sv ? sv.destino : null,
      revision: 'pendiente'
    };

    const newIdx = arr.length;
    await logHist(grupoId, 'CREAR ACTIVIDAD', {
      _group: g,
      fecha: f, idx: newIdx,
      anterior: '',
      nuevo: item.actividad,
      antesObj: null,
      despuesObj: item,
      path: `itinerario.${f}[${newIdx}]`
    });

    arr.push(item);
    await updateDoc(doc(db,'grupos',grupoId), { [`itinerario.${f}`]: arr });
  }

  const newSnap = await getDoc(doc(db,'grupos',grupoId));
  await updateEstadoRevisionAndBadge(grupoId, newSnap.data().itinerario || {});
  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// Notas especiales para servicios con voucher "TICKET"
// —————————————————————————————————

// Crea (una sola vez) el <select> con las 4 opciones y lo inserta después del input de notas.
function ensureNotasTicketSelect() {
  if (notasTicketSelect && notasTicketSelect.isConnected) return notasTicketSelect;
  if (!fldNotas) return null;

  const sel = document.createElement('select');
  sel.id = 'm-notas-ticket';
  sel.className = fldNotas.className || '';
  sel.style.marginTop = '0.25rem';

  // Opción placeholder
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '(selecciona una opción)';
  sel.appendChild(opt0);

  // Las 4 opciones requeridas
  TICKET_NOTAS_OPCIONES.forEach(txt => {
    const opt = document.createElement('option');
    opt.value = txt;
    opt.textContent = txt;
    sel.appendChild(opt);
  });

  // Insertar justo después del input de notas
  fldNotas.insertAdjacentElement('afterend', sel);
  sel.style.display = 'none';

  notasTicketSelect = sel;
  return notasTicketSelect;
}

/**
 * Activa / desactiva el modo "TICKET" en el modal:
 * - Si el servicio tiene voucher TICKET → se muestra el <select> y se oculta el input.
 * - Si no → solo se muestra el input normal.
 *
 * Reglas de default:
 * - TICKET + sin nota previa:
 *     - BIG WHEEL (RUEDA GIGANTE) → PEDIR TICKETS EN VENTANILLA
 *     - Otros TICKET → PEDIR TICKETS A CDRA. GENERAL
 */
async function applyNotasTicketMode(destino, actividad, servicioId, notasCrudas) {
  if (!fldNotas) return;

  const rawNota   = (notasCrudas || '').toString();
  const notaTrim  = rawNota.trim();
  const notaUpper = notaTrim.toUpperCase();
  const selNotas  = ensureNotasTicketSelect();

  let esTicket     = false;
  let actNameUpper = (actividad || '').toString().toUpperCase();

  try {
    const svcMaps = await getServiciosMaps(destino || '');
    let pack = null;

    // 1) Preferimos servicioId si viene en la actividad
    if (servicioId && svcMaps.byId.has(servicioId)) {
      pack = svcMaps.byId.get(servicioId);
    } else if (actividad) {
      // 2) Si no, buscamos por nombre normalizado
      const key = K(actividad);
      if (svcMaps.byName.has(key)) {
        pack = svcMaps.byName.get(key);
      }
    }

    if (pack) {
      actNameUpper = (pack.nombre || actNameUpper || '').toString().toUpperCase();
      if (pack.data && typeof pack.data.voucher !== 'undefined') {
        esTicket = (pack.data.voucher || '').toString().toUpperCase() === 'TICKET';
      }
    }
  } catch (_) {
    esTicket = false;
  }

  if (esTicket && selNotas) {
    // Mostrar el select y ocultar el input libre
    fldNotas.style.display = 'none';
    selNotas.style.display = '';

    let selValue;

    if (notaTrim) {
      // Ya había una nota guardada
      if (TICKET_NOTAS_OPCIONES.includes(notaUpper)) {
        selValue = notaUpper;
      } else {
        selValue = 'OTRO';
      }
    } else {
      // Sin nota previa → aplicar DEFAULT según actividad
      if (actNameUpper === 'BIG WHEEL (RUEDA GIGANTE)') {
        selValue = 'PEDIR TICKETS EN VENTANILLA';
      } else {
        selValue = 'PEDIR TICKETS A CDRA. GENERAL';
      }
    }

    selNotas.value = selValue;

    if (selValue === 'OTRO') {
      // Dejamos el texto libre como estaba (posiblemente vacío)
      fldNotas.value = notaTrim;
    } else {
      fldNotas.value = selValue;
    }
  } else {
    // Modo normal: sin select, solo input texto
    fldNotas.style.display = '';
    if (selNotas) selNotas.style.display = 'none';
    fldNotas.value = notaTrim;
  }
}

// —————————————————————————————————
/** 5) openModal(): precarga datos en el modal **/
// —————————————————————————————————
async function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  const snapG = await getDoc(doc(db,"grupos",selectNum.value));
  const g     = snapG.data()||{};
  const A = parseInt(g.adultos, 10) || 0;
  const E = parseInt(g.estudiantes, 10) || 0;
  const T = (() => {
    const t = parseInt(g.cantidadgrupo, 10);
    return Number.isFinite(t) ? t : (A + E);
  })();
  
  // Datos base del modal
  fldFecha.value    = data.fecha;
  fldHi.value       = data.horaInicio || "07:00";
  fldHf.value       = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value      = data.actividad  || "";
  await prepararCampoActividad("m-actividad", g.destino);

  // Notas (texto que venía en la actividad, si existía)
  const notasCrudas = (data.notas || "").toString();

  // Aplica modo "TICKET" (select) o modo normal según el servicio
  await applyNotasTicketMode(
    g.destino || '',
    data.actividad || '',
    data.servicioId || null,
    notasCrudas
  );

  // Además, si el usuario cambia la actividad dentro del modal,
  // volvemos a evaluar si corresponde usar el select de TICKET o no.
  fldAct.onchange = () => {
    applyNotasTicketMode(
      g.destino || '',
      fldAct.value || '',
      editData?.servicioId || null,
      fldNotas.value || ''
    );
  };

  // Pax
  fldAdultos.value     = A;
  fldEstudiantes.value = E;
  fldPax.value         = T;

  // Al cambiar hora inicio, ajustamos hora fin
  fldHi.onchange = () => { fldHf.value = sumarUnaHora(fldHi.value); };

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
/** 6) closeModal(): cierra el modal **/
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
/** 7) onSubmitModal(): guarda/actualiza + historial (enlazando servicio) **/
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10) || 0;
  const e       = parseInt(fldEstudiantes.value,10) || 0;
  const pax     = parseInt(fldPax.value,10)       || 0;

  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};

  const suma = a + e;
  if (pax !== suma) return alert(`La suma Adultos (${a}) + Estudiantes (${e}) = ${suma} debe ser igual a Total (${pax}).`);
  if (a < 0 || e < 0 || pax < 0) return alert("Los valores no pueden ser negativos.");

  const svcMaps = await getServiciosMaps(g.destino || '');
  const typedUpper = (fldAct.value || '').trim().toUpperCase();
  const key = K(typedUpper);
  const sv = svcMaps.byName.get(key) || null;

  // === NUEVO: determinar notas teniendo en cuenta el select especial de TICKETS ===
  let notasValor = '';
  if (notasTicketSelect && notasTicketSelect.style.display !== 'none') {
    // Estamos en modo "voucher TICKET": usar el valor del <select>
    const selVal = (notasTicketSelect.value || '').toString().toUpperCase();
    if (selVal === 'OTRO') {
      // Si elige OTRO, usamos lo que haya escrito en el input (si hay), o la palabra OTRO
      const libre = (fldNotas.value || '').trim().toUpperCase();
      notasValor = libre || 'OTRO';
    } else {
      notasValor = selVal;
      // Sincroniza el input oculto para que el objeto actividad también tenga ese texto
      fldNotas.value = selVal;
    }
  } else {
    // Modo normal: se guarda lo que haya escrito en el input de notas
    notasValor = (fldNotas.value || '').trim().toUpperCase();
  }
  // ================================================================================

  const payloadBase = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  sv ? sv.nombre : typedUpper,
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      notasValor,
    servicioId:       sv ? sv.id : (editData?.servicioId || null),
    servicioNombre:   sv ? sv.nombre : (editData?.servicioNombre || null),
    servicioDestino:  sv ? sv.destino : (editData?.servicioDestino || null)
  };

  const arr = (g.itinerario?.[fecha]||[]).slice();

  if (editData) {
    const beforeObj = arr[editData.idx];
    const afterObj  = { ...payloadBase, revision: editData.revision || 'pendiente', rechazoMotivo: (beforeObj?.rechazoMotivo || '') };
    arr[editData.idx] = afterObj;

    await logHist(grupoId, 'MODIFICAR ACTIVIDAD', {
      _group: g,
      fecha, idx: editData.idx,
      anterior: beforeObj?.actividad || '',
      nuevo: afterObj.actividad || '',
      antesObj: beforeObj || null,
      despuesObj: afterObj || null,
      path: `itinerario.${fecha}[${editData.idx}]`
    });
  } else {
    const newIdx = arr.length;
    const afterObj = { ...payloadBase, revision: 'pendiente' };
    arr.push(afterObj);
    await logHist(grupoId, 'CREAR ACTIVIDAD', {
      _group: g,
      fecha, idx: newIdx,
      anterior: '',
      nuevo: afterObj.actividad || '',
      antesObj: null,
      despuesObj: afterObj,
      path: `itinerario.${fecha}[${newIdx}]`
    });
  }

  await updateDoc(doc(db,'grupos',grupoId), {
    adultos: a, estudiantes: e, cantidadgrupo: pax,
    [`itinerario.${fecha}`]: arr
  });

  await updateEstadoRevisionAndBadge(grupoId, { ...(g.itinerario||{}), [fecha]: arr });
  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// NUEVO — Toggle tri-estado revisión (⭕→✅→❌→⭕)
// con motivo obligatorio al pasar a ❌ y escritura en historial + alertas
// —————————————————————————————————
// —————————————————————————————————
// Toggle tri-estado revisión (⭕→✅→❌→⭕) SIN re-render global
// Actualiza solo la tarjeta tocada; mantiene alertas e historial.
// —————————————————————————————————
async function toggleRevisionEstado(grupoId, fecha, idx, act, visibleName, ITfull, ui = null) {
  const old  = act.revision || 'pendiente';
  const next = (old === 'pendiente') ? 'ok' : (old === 'ok' ? 'rechazado' : 'pendiente');

  const gSnap = await getDoc(doc(db,'grupos',grupoId));
  const g     = gSnap.data() || {};
  const arr   = (g.itinerario?.[fecha]||[]).slice();

  // Si vamos a RECHAZADO, pedir motivo (obligatorio)
  let motivo = act.rechazoMotivo || '';
  if (next === 'rechazado') {
    motivo = prompt("Motivo del rechazo (obligatorio):", motivo || '') || '';
    motivo = motivo.trim();
    if (!motivo) return; // cancelar cambio si no hay motivo
  }

  // Construir objetos antes/después
  const beforeObj = arr[idx] || {};
  const updated   = { ...beforeObj, revision: next };
  if (next === 'rechazado') updated.rechazoMotivo = motivo;
  else if (old === 'rechazado') updated.rechazoMotivo = ''; // limpiar motivo al salir de ❌
  arr[idx] = updated;

  // Historial
  await logHist(grupoId, 'CAMBIAR REVISION ACTIVIDAD', {
    _group: g,
    fecha, idx,
    anterior: old,
    nuevo: next,
    motivo: updated.rechazoMotivo || '',
    detalle: `${visibleName} (${fecha})`,
    antesObj: beforeObj || null,
    despuesObj: updated || null,
    path: `itinerario.${fecha}[${idx}]`
  });

  // Persistir cambio
  await updateDoc(doc(db,'grupos',grupoId), { [`itinerario.${fecha}`]: arr });

  // Alertas on/off
  if (next === 'rechazado' && old !== 'rechazado') {
    await addDoc(collection(db,'grupos',grupoId,'alertas'), {
      fecha,
      horaInicio: beforeObj?.horaInicio || act?.horaInicio || '',
      horaFin:    beforeObj?.horaFin    || act?.horaFin    || '',
      actividad:  visibleName,
      motivo,
      creadoPor:  auth.currentUser.email,
      creadoEn:   new Date(),
      visto:      false
    });
  } else if (old === 'rechazado' && next !== 'rechazado') {
    // marcar alertas relacionadas como vistas
    try {
      const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
      const toClose = qs.docs.filter(d => {
        const a = d.data()||{};
        return (a.fecha===fecha && (a.actividad||'')===visibleName && !a.visto);
      });
      await Promise.all(toClose.map(d => updateDoc(doc(db,'grupos',grupoId,'alertas',d.id), { visto: true, leidoPor: auth.currentUser.email, leidoEn: new Date() })));
    } catch(_) {}
  }

  // Recalcular estado + badge (sin re-render de cards)
  const ITnext = { ...(ITfull||{}), [fecha]: arr };
  await updateEstadoRevisionAndBadge(grupoId, ITnext);

  // ——— Actualización UI puntual (sin "parpadeo") ———
  if (ui && ui.li && ui.btn) {
    // icono + title del botón
    ui.btn.textContent = (next === 'ok') ? '✅' : (next === 'rechazado' ? '❌' : '⭕');
    ui.btn.title       = (next === 'ok') ? 'Revisado (OK)' : (next === 'rechazado' ? 'Rechazado' : 'Pendiente');

    // motivo (crear/actualizar/eliminar)
    const existing = ui.li.querySelector('.rechazo-motivo');
    if (next === 'rechazado') {
      if (existing) {
        existing.textContent = `❌ Motivo: ${motivo}`;
      } else {
        const p = document.createElement('p');
        p.className = 'rechazo-motivo';
        p.textContent = `❌ Motivo: ${motivo}`;
        const actions = ui.li.querySelector('.actions');
        ui.li.insertBefore(p, actions || null);
      }
    } else if (existing) {
      existing.remove();
    }
  } else {
    // fallback (no UI pasada): refresco completo
    renderItinerario();
  }
}

// —————————————————————————————————
// Utilidades fecha/hora
// —————————————————————————————————
function getDateRange(startStr, endStr) {
  const out = [];
  const [sy, sm, sd] = (startStr || '').split("-").map(Number);
  const [ey, em, ed] = (endStr || '').split("-").map(Number);

  if (!sy || !sm || !sd || !ey || !em || !ed) return out;

  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);

  if (end < start) return out;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
  }

  return out;
}

function getDiasRelativos(g) {
  const noches = parseInt(
    g.cantidadNoches || g.noches || g.cantidadNochesViaje || 0,
    10
  );

  const dias = parseInt(
    g.cantidadDias || g.dias || g.cantidadDeDias || 0,
    10
  );

  let totalDias = 0;

  if (Number.isFinite(dias) && dias > 0) {
    totalDias = dias;
  } else if (Number.isFinite(noches) && noches > 0) {
    totalDias = noches + 1;
  }

  if (!totalDias) return [];

  return Array.from({ length: totalDias }, (_, i) => `DIA_${i + 1}`);
}

function isFechaReal(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function sortDiasItinerario(a, b) {
  const aReal = isFechaReal(a);
  const bReal = isFechaReal(b);

  if (aReal && bReal) return new Date(a) - new Date(b);
  if (aReal) return -1;
  if (bReal) return 1;

  const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
  const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
  return na - nb;
}

function formatDiaItinerario(key) {
  if (isFechaReal(key)) return formatDateReadable(key);

  const n = parseInt(String(key).replace(/\D/g, ""), 10) || "";
  return `Día ${n} (sin fecha)`;
}

function formatDateReadable(isoStr) {
  const [yyyy, mm, dd] = isoStr.split('-').map(Number);
  const d  = new Date(yyyy, mm - 1, dd);
  const wd = d.toLocaleDateString("es-CL", { weekday: "long" });
  const dayName = wd.charAt(0).toUpperCase() + wd.slice(1);
  const ddp = String(dd).padStart(2, '0');
  const mmp = String(mm).padStart(2, '0');
  return `${dayName} ${ddp}/${mmp}`;
}

function sumarUnaHora(hhmm) {
  const [h,m] = (hhmm||'00:00').split(":").map(Number);
  const d = new Date();
  d.setHours((h||0)+1, (m||0));
  return d.toTimeString().slice(0,5);
}

// —————————————————————————————————
/** Plantillas: guardar **/
// —————————————————————————————————
async function guardarPlantilla() {
  const nombre = prompt("Nombre de la plantilla:");
  if (!nombre) return;
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};

  // Guardar como objeto por día
  const actividadesPorDia = {};
  const fechas = Object.keys(g.itinerario || {})
    .sort(sortDiasItinerario);
  fechas.forEach((fecha, idx) => {
    actividadesPorDia[`dia${idx+1}`] =
      (g.itinerario[fecha]||[]).map(act => ({
        horaInicio: act.horaInicio,
        horaFin:    act.horaFin,
        actividad:  act.actividad,
        notas:      act.notas
      }));
  });

  await addDoc(collection(db,'plantillasItinerario'), {
    nombre,
    creador:   auth.currentUser.email,
    createdAt: new Date(),
    dias: actividadesPorDia
  });

  await logHist(grupoId, 'GUARDAR PLANTILLA ITINERARIO', {
    _group: g,
    anterior: '',
    nuevo: nombre
  });

  alert("Plantilla guardada");
  await cargarListaPlantillas();
}

// —————————————————————————————————
/** Plantillas: cargar **/
// —————————————————————————————————
async function cargarListaPlantillas() {
  selPlantillas.innerHTML = "";
  const snap = await getDocs(collection(db, 'plantillasItinerario'));
  snap.docs.forEach(d => {
    const data = d.data() || {};
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = data.nombre || d.id;
    selPlantillas.appendChild(opt);
  });
}

async function cargarPlantilla() {
  const tplId = selPlantillas.value;
  if (!tplId) return alert("Selecciona una plantilla");

  const [tplSnap, grpSnap] = await Promise.all([
    getDoc(doc(db, 'plantillasItinerario', tplId)),
    getDoc(doc(db, 'grupos', selectNum.value))
  ]);
  if (!tplSnap.exists()) return alert("Plantilla no encontrada");

  const diasPlantilla = tplSnap.data().dias || {};
  const nombreTpl     = tplSnap.data().nombre || tplId;
  const grupoId       = selectNum.value;
  const g             = grpSnap.data() || {};

  const fechas = Object.keys(g.itinerario || {})
    .sort(sortDiasItinerario);

  const ok = confirm(
    "¿Seguro que quieres cargar un nuevo itinerario?\n" +
    "Pulsa [OK] para continuar, [Cancelar] para volver al editor."
  );
  if (!ok) return;
  const reemplazar = confirm(
    "Pulsa [OK] para REEMPLAZAR todas las actividades,\n" +
    "[Cancelar] para AGREGAR las de la plantilla al itinerario actual."
  );

  // Conteo anterior
  const countBefore = Object.values(g.itinerario||{}).reduce((acc,arr)=>acc+(arr?.length||0),0);

  const nuevoIt = {};
  if (reemplazar) {
    fechas.forEach((fecha, idx) => {
      const acts = Array.isArray(diasPlantilla[`dia${idx+1}`]) ? diasPlantilla[`dia${idx+1}`] : [];
      nuevoIt[fecha] = acts.map(act => ({
        horaInicio: act.horaInicio,
        horaFin:    act.horaFin,
        actividad:  act.actividad,
        notas:      act.notas,
        pasajeros:   (parseInt(g.adultos,10)||0) + (parseInt(g.estudiantes,10)||0),
        adultos:     parseInt(g.adultos,10) || 0,
        estudiantes: parseInt(g.estudiantes,10) || 0,
        revision:    'pendiente'
      }));
    });
  } else {
    for (const fecha in g.itinerario || {}) {
      nuevoIt[fecha] = (g.itinerario[fecha]||[]).slice();
    }
    fechas.forEach((fecha, idx) => {
      const extras = Array.isArray(diasPlantilla[`dia${idx+1}`]) ? diasPlantilla[`dia${idx+1}`] : [];
      nuevoIt[fecha] = (nuevoIt[fecha]||[]).concat(
        extras.map(act => ({
          horaInicio: act.horaInicio,
          horaFin:    act.horaFin,
          actividad:  act.actividad,
          notas:      act.notas,
          pasajeros:   (parseInt(g.adultos,10)||0) + (parseInt(g.estudiantes,10)||0),
          adultos:     parseInt(g.adultos,10) || 0,
          estudiantes: parseInt(g.estudiantes,10) || 0,
          revision:    'pendiente'
        }))
      );
    });
  }

  // Conteo nuevo
  const countAfter = Object.values(nuevoIt||{}).reduce((acc,arr)=>acc+(arr?.length||0),0);

  await updateDoc(doc(db, 'grupos', grupoId), { itinerario: nuevoIt });
  await logHist(grupoId, `CARGAR PLANTILLA (${reemplazar ? 'REEMPLAZAR' : 'AGREGAR'})`, {
    _group: g,
    anterior: `Actividades: ${countBefore}`,
    nuevo:    `Actividades: ${countAfter}`,
    detalle:  `Plantilla: ${nombreTpl}`
  });
  await updateEstadoRevisionAndBadge(grupoId, nuevoIt);
  renderItinerario();
}

// —————————————————————————————————
// Calendario modal
// —————————————————————————————————
document.getElementById("btnAbrirCalendario")
  .addEventListener("click", (e) => {
    stopAll(e);
    const grupoTxt = selectNum.options[selectNum.selectedIndex].text;
    if (!selectNum.value) return alert("Selecciona un grupo");
    const iframe = document.getElementById("iframe-calendario");
    iframe.src = `calendario.html?busqueda=${encodeURIComponent(grupoTxt)}`;
    document.getElementById("modal-calendario").style.display   = "block";
    document.getElementById("modal-backdrop").style.display    = "block";
  });

window.cerrarCalendario = () => {
  document.getElementById("modal-calendario").style.display   = "none";
  document.getElementById("modal-backdrop").style.display    = "none";
  document.getElementById("iframe-calendario").src           = "";
};

// —————————————————————————————————
/** Swap (actividad o día) + historial **/
// —————————————————————————————————
async function handleSwapClick(type, info) {
  // 1) Selección origen
  if (!swapOrigin) {
    swapOrigin = { type, info };
    const fechaKey = (typeof info === 'string') ? info : info.fecha;
    const el = document.querySelector(`[data-fecha="${fechaKey}"]`);
    if (el) el.classList.add("swap-selected");
    return;
  }
  // 2) Debe coincidir el tipo
  if (swapOrigin.type !== type) {
    alert("Debe intercambiar dos elementos del mismo tipo.");
    resetSwap();
    return;
  }

  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data() || {};
  const it      = { ...(g.itinerario || {}) };
  
  if (type === "dia") {
    const f1 = (typeof swapOrigin.info === 'string') ? swapOrigin.info : swapOrigin.info.fecha;
    const f2 = (typeof info === 'string') ? info : info.fecha;

    const antes = { f1, f2, a1Count: (it[f1]||[]).length, a2Count: (it[f2]||[]).length };
    [ it[f1], it[f2] ] = [ it[f2], it[f1] ];

    await updateDoc(doc(db,'grupos',grupoId), { itinerario: it });
    await logHist(grupoId, 'SWAP DIA', {
      _group: g,
      anterior: `${f1} ↔ ${f2} (antes a1:${antes.a1Count} a2:${antes.a2Count})`,
      nuevo:    `${f1} ↔ ${f2} (después a1:${(it[f1]||[]).length} a2:${(it[f2]||[]).length})`
    });
  } else {
    // actividad ↔ actividad
    const { fecha: f1, idx: i1 } = swapOrigin.info;
    const { fecha: f2, idx: i2 } = info;

    const a1 = (it[f1]||[])[i1];
    const a2 = (it[f2]||[])[i2];
    const antesStr = `${a1?.actividad || ''} ↔ ${a2?.actividad || ''}`;

    [ it[f1][i1], it[f2][i2] ] = [ it[f2][i2], it[f1][i1] ];

    const despuesStr = `${it[f1][i1]?.actividad || ''} ↔ ${it[f2][i2]?.actividad || ''}`;

    await updateDoc(doc(db,'grupos',grupoId), { itinerario: it });
    await logHist(grupoId, 'SWAP ACTIVIDAD', {
      _group: g,
      anterior: antesStr,
      nuevo:    despuesStr,
      detalle:  `A: ${f1}[${i1}] ↔ B: ${f2}[${i2}]`,
      antesObj: { A: a1 || null, B: a2 || null },
      despuesObj: { A: it[f1][i1] || null, B: it[f2][i2] || null }
    });
  }
  
  await updateEstadoRevisionAndBadge(grupoId, it);
  resetSwap();
  renderItinerario();
}

function resetSwap() {
  swapOrigin = null;
  document.querySelectorAll(".swap-selected").forEach(el => el.classList.remove("swap-selected"));
}

// —————————————————————————————————
/** Editar fecha base (recalcula el rango) + historial **/
// —————————————————————————————————
async function handleDateEdit(oldFecha) {
  const nueva1 = prompt("Nueva fecha para este día (YYYY-MM-DD):", oldFecha);
  if (!nueva1) return;

  const grupoId = selectNum.value;
  if (!grupoId) { alert("Selecciona primero un grupo."); return; }
  const snapG = await getDoc(doc(db, 'grupos', grupoId));
  const g     = snapG.data();

  const fechas = Object.keys(g.itinerario || {}).sort((a, b) => new Date(a) - new Date(b));
  const diasCount = fechas.length;
  const newRango  = [];
  const [yy, mm, dd] = nueva1.split("-").map(Number);
  for (let i = 0; i < diasCount; i++) {
    const d = new Date(yy, mm - 1, dd);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const m2   = String(d.getMonth() + 1).padStart(2, "0");
    const d2   = String(d.getDate()     ).padStart(2, "0");
    newRango.push(`${yyyy}-${m2}-${d2}`);
  }

  const newIt = {};
  fechas.forEach((fAnt, idx) => { newIt[newRango[idx]] = g.itinerario[fAnt]; });

  await updateDoc(doc(db, 'grupos', grupoId), { itinerario: newIt });
  await logHist(grupoId, 'EDITAR FECHA BASE', {
    _group: g,
    anterior: fechas[0],
    nuevo:    newRango[0],
    detalle:  `Map: ${JSON.stringify(fechas.map((f,i)=>`${f}→${newRango[i]}`))}`
  });
  await updateEstadoRevisionAndBadge(grupoId, newIt);
  renderItinerario();
}

// —————————————————————————————————
// (A) Rechazar DÍA (solo bandera de día, NO toca actividades)
// —————————————————————————————————
async function handleRejectDayFlag(fecha) {
  const grupoId = selectNum.value;
  if (!grupoId) return alert("Selecciona un grupo");
  const motivo = (prompt("Motivo del rechazo del DÍA (obligatorio):", "") || "").trim();
  if (!motivo) return;

  // Guardar bandera de día
  await setRevisionDia(grupoId, fecha, 'rechazado', motivo);

  // Una alerta breve solo de "día"
  await addDoc(collection(db,'grupos',grupoId,'alertas'), {
    fecha,
    horaInicio: '',
    horaFin:    '',
    actividad:  '(DÍA)',
    motivo,
    creadoPor:  auth.currentUser.email,
    creadoEn:   new Date(),
    visto:      false
  });

  // Historial
  const gSnap = await getDoc(doc(db,'grupos',grupoId));
  const g     = gSnap.data() || {};
  await logHist(grupoId, 'RECHAZAR DÍA (BANDERA)', {
    _group: g, fecha, anterior: '', nuevo: 'RECHAZADO', motivo
  });

  await updateEstadoRevisionAndBadge(grupoId);
  renderItinerario(); // refresco moderado del día
}

// —————————————————————————————————
// (B) Quitar rechazo del DÍA (vuelve a 'pendiente' eliminando la bandera)
// —————————————————————————————————
async function handleClearRejectDay(fecha) {
  const grupoId = selectNum.value;
  if (!grupoId) return alert("Selecciona un grupo");

  const gSnap = await getDoc(doc(db,'grupos',grupoId));
  const g     = gSnap.data() || {};
  const rev   = getRevisionDia(g, fecha);
  if (!rev || rev.estado !== 'rechazado') return; // nada que limpiar

  await setRevisionDia(grupoId, fecha, null); // elimina el registro

  await logHist(grupoId, 'LIMPIAR RECHAZO DÍA', {
    _group: g, fecha, anterior: 'RECHAZADO', nuevo: 'PENDIENTE'
  });

  await updateEstadoRevisionAndBadge(grupoId);
  renderItinerario();
}

// —————————————————————————————————
// (C) Rechazar DÍA + marcar TODAS las actividades en ❌
// (usa el mismo motivo para cada actividad) — opción "dura"
// —————————————————————————————————
async function handleRejectDayHard(fecha) {
  const grupoId = selectNum.value;
  if (!grupoId) return alert("Selecciona un grupo");
  const motivo = (prompt("Motivo del rechazo del DÍA (obligatorio):", "") || "").trim();
  if (!motivo) return;

  const gSnap = await getDoc(doc(db,'grupos',grupoId));
  const g     = gSnap.data() || {};
  const arr   = (g.itinerario?.[fecha] || []).slice();

  // 1) Bandera de día
  await setRevisionDia(grupoId, fecha, 'rechazado', motivo);

  // 2) Todas las actividades a ❌
  const nuevoArr = arr.map(a => ({ ...a, revision: 'rechazado', rechazoMotivo: motivo }));
  await updateDoc(doc(db,'grupos',grupoId), { [`itinerario.${fecha}`]: nuevoArr });

  // 3) Alertas por actividad
  await Promise.all(
    nuevoArr.map(a => addDoc(collection(db,'grupos',grupoId,'alertas'), {
      fecha,
      horaInicio: a.horaInicio || '',
      horaFin:    a.horaFin    || '',
      actividad:  a.actividad  || '',
      motivo,
      creadoPor:  auth.currentUser.email,
      creadoEn:   new Date(),
      visto:      false
    }))
  );

  // 4) Historial
  await logHist(grupoId, 'RECHAZAR DÍA (DURO)', {
    _group: g, fecha,
    anterior: `Actividades afectadas: ${arr.length}`,
    nuevo:    `DÍA y TODAS en RECHAZADO`,
    motivo
  });

  await updateEstadoRevisionAndBadge(grupoId, { ...(g.itinerario||{}), [fecha]: nuevoArr });
  renderItinerario();
}

// ===== MIGRACIÓN/UTILIDADES (se mantienen) =====

// Índices de reparación global (sin cambios de lógica principal)
const KNOWN_DESTINOS_REPAIR = ['BRASIL','BARILOCHE','SUR DE CHILE','SUR DE CHILE Y BARILOCHE','NORTE DE CHILE'];

async function buildServiciosIndex(includeAll = true, destinosStr = '') {
  const destinos = includeAll ? KNOWN_DESTINOS_REPAIR :
    (destinosStr ? destinosStr.split(/\s+Y\s+/i).map(s => s.trim().toUpperCase()) : []);
  const byId = new Map(), byName = new Map(), packs = [];
  for (const dest of destinos) {
    try {
      const snap = await getDocs(collection(db, 'Servicios', dest, 'Listado'));
      snap.forEach(ds => {
        const id   = ds.id;
        const data = ds.data() || {};
        const visible = ((data.nombre || data.servicio || id) || '').toString();
        const pack = { id, destino: dest, nombre: visible.toUpperCase(), nombreK: K(visible), data };
        byId.set(id, pack);
        byName.set(pack.nombreK, pack);
        byName.set(K(id), pack);
        if (data.servicio) byName.set(K(data.servicio), pack);
        if (Array.isArray(data.aliases)) data.aliases.forEach(a => { const key = K(a); if (key) byName.set(key, pack); });
        packs.push(pack);
      });
    } catch (_) { /* destino inexistente */ }
  }
  return { byId, byName, packs };
}

function fuzzyFindService(packs, rawName) {
  const tgt = K(rawName);
  const tset = new Set(tgt.split(' ').filter(w => w.length > 2));
  let best = null, bestScore = 0, second = 0;
  for (const p of packs) {
    const pset = new Set(p.nombreK.split(' ').filter(w => w.length > 2));
    const inter = [...tset].filter(x => pset.has(x)).length;
    if (!inter) continue;
    const union = new Set([...tset, ...pset]).size || 1;
    const score = inter / union;
    if (score > bestScore) { second = bestScore; bestScore = score; best = p; }
    else if (score > second) { second = score; }
  }
  if (best && (bestScore >= 0.8 || (bestScore >= 0.65 && (bestScore - second) >= 0.2))) return best;
  return null;
}

window.diagnosticarServicios = async function() {
  const out = [];
  const snapG = await getDocs(collection(db, 'grupos'));
  const idx = await buildServiciosIndex(true);

  for (const d of snapG.docs) {
    const g = { id: d.id, ...(d.data() || {}) };
    const it = g.itinerario || {};
    const fechas = Object.keys(it).sort((a,b)=> new Date(a) - new Date(b));
    for (const f of fechas) {
      (it[f] || []).forEach((act, i) => {
        const nameK = K(act.actividad || '');
        const hasId = !!act.servicioId && idx.byId.has(act.servicioId);
        const byNm  = idx.byName.get(nameK);
        if (!hasId && !byNm) {
          out.push({ grupoId: g.id, numeroNegocio: g.numeroNegocio || '', nombreGrupo: g.nombreGrupo || '', fecha: f, idx: i, actividad: act.actividad || '' });
        }
      });
    }
  }
  console.table(out);
  console.log(`Total sin resolver: ${out.length}`);
  return out;
};

window.repararServiciosAntiguos = async function(opts = {}) {
  const dryRun    = (opts.dryRun   !== undefined) ? opts.dryRun   : true;
  const includeAll= (opts.includeAll !== undefined) ? opts.includeAll : true;
  const fuzzy     = (opts.fuzzy    !== undefined) ? opts.fuzzy    : true;

  const idx = await buildServiciosIndex(includeAll);
  const packs = idx.packs;

  const qs = await getDocs(collection(db,'grupos'));
  let gruposProc = 0, gruposMod = 0, actsMod = 0, actsFuzzy = 0, actsNoMatch = 0;

  for (const docG of qs.docs) {
    const g   = { id: docG.id, ...(docG.data() || {}) };
    const it  = g.itinerario || {};
    const fechas = Object.keys(it).sort((a,b)=> new Date(a) - new Date(b));

    let cambiosEnGrupo = false;
    const nuevoIt = {};

    for (const f of fechas) {
      const arr = (it[f] || []);
      const nuevoArr = arr.map(act => {
        const out = { ...act };
        const nameK = K(out.actividad || '');

        if (out.servicioId && idx.byId.has(out.servicioId)) {
          const sv = idx.byId.get(out.servicioId);
          const necesita = out.actividad !== sv.nombre || out.servicioNombre !== sv.nombre || out.servicioDestino !== sv.destino;
          if (necesita) { out.actividad = sv.nombre; out.servicioNombre = sv.nombre; out.servicioDestino = sv.destino; cambiosEnGrupo = true; actsMod++; }
          if (!out.revision) out.revision = 'pendiente';
          return out;
        }

        const byName = idx.byName.get(nameK);
        if (byName) {
          if (out.servicioId !== byName.id || out.servicioNombre !== byName.nombre || out.servicioDestino !== byName.destino || out.actividad !== byName.nombre) {
            out.servicioId = byName.id; out.servicioNombre = byName.nombre; out.servicioDestino = byName.destino; out.actividad = byName.nombre;
            cambiosEnGrupo = true; actsMod++;
          }
          if (!out.revision) out.revision = 'pendiente';
          return out;
        }

        if (fuzzy) {
          const guess = fuzzyFindService(packs, out.actividad || '');
          if (guess) {
            out.servicioId = guess.id; out.servicioNombre = guess.nombre; out.servicioDestino = guess.destino; out.actividad = guess.nombre;
            cambiosEnGrupo = true; actsMod++; actsFuzzy++;
            if (!out.revision) out.revision = 'pendiente';
            return out;
          }
        }

        if (!out.revision) out.revision = 'pendiente';
        actsNoMatch++;
        return out;
      });

      nuevoIt[f] = nuevoArr;
    }

    if (!dryRun && cambiosEnGrupo) {
      await updateDoc(doc(db,'grupos',g.id), { itinerario: nuevoIt });
      try {
        await logHist(g.id, 'REPARAR ITINERARIO SERVICIOS', {
          _group: g,
          anterior: '',
          nuevo: 'Se actualizaron actividades automáticamente'
        });
      } catch(_) {}
      gruposMod++;
    }

    gruposProc++;
    if (dryRun && cambiosEnGrupo) console.log(`(DRY) ${g.id} — actividades actualizadas (pendiente de escribir)`);
  }

  console.log(`FIN Reparación — grupos procesados: ${gruposProc}, grupos modificados: ${gruposMod}, acts modificadas: ${actsMod} (fuzzy:${actsFuzzy}), sin match: ${actsNoMatch}, dryRun: ${dryRun}`);
  return { gruposProc, gruposMod, actsMod, actsFuzzy, actsNoMatch, dryRun };
};

// ===========================================================
// APLICAR DEFAULT DE NOTAS PARA SERVICIOS CON VOUCHER "TICKET"
// - Rellena SOLO actividades TICKET que NO tengan nota.
// - BIG WHEEL (RUEDA GIGANTE) → PEDIR TICKETS EN VENTANILLA
// - Otros TICKET → PEDIR TICKETS A CDRA. GENERAL
// - Respeta actividades que ya tienen nota (aunque sea texto libre).
// Uso desde consola:
//   await aplicarNotasDefaultTickets({ dryRun: true  });  // solo muestra
//   await aplicarNotasDefaultTickets({ dryRun: false });  // escribe en Firestore
// ===========================================================
window.aplicarNotasDefaultTickets = async function(opts = {}) {
  const dryRun = (opts.dryRun !== undefined) ? !!opts.dryRun : true;

  const qs = await getDocs(collection(db,'grupos'));
  const gruposDocs = qs.docs;

  let gruposProc  = 0;
  let gruposMod   = 0;
  let actsModTot  = 0;

  for (const d of gruposDocs) {
    const g = { id: d.id, ...(d.data() || {}) };
    const it = g.itinerario || {};
    const fechas = Object.keys(it);
    if (!fechas.length) { gruposProc++; continue; }

    const svcMaps = await getServiciosMaps(g.destino || '');
    let cambiosEnGrupo = false;
    let actsModGrupo   = 0;
    const nuevoIt      = {};

    for (const f of fechas) {
      const arr = it[f] || [];
      const nuevoArr = arr.map(act => {
        if (!act) return act;

        // Localizar el servicio en el índice
        let pack = null;
        if (act.servicioId && svcMaps.byId.has(act.servicioId)) {
          pack = svcMaps.byId.get(act.servicioId);
        } else if (act.actividad || act.servicioNombre) {
          const nombreBase = (act.servicioNombre || act.actividad || '').toString();
          const key = K(nombreBase);
          if (svcMaps.byName.has(key)) {
            pack = svcMaps.byName.get(key);
          }
        }

        let esTicket = false;
        if (pack && pack.data && typeof pack.data.voucher !== 'undefined') {
          esTicket = (pack.data.voucher || '').toString().toUpperCase() === 'TICKET';
        }
        if (!esTicket) return act; // no es TICKET → no tocar

        const notaRaw   = (act.notas || '').toString().trim();
        const notaUpper = notaRaw.toUpperCase();

        // Si ya tiene una de las 4 opciones → respetar
        if (notaUpper && TICKET_NOTAS_OPCIONES.includes(notaUpper)) return act;

        // Si tiene otro texto libre → no tocar (solo rellenamos vacíos)
        if (notaUpper) return act;

        // Sin nota → aplicar default según actividad
        const nombreActUpper = ((act.servicioNombre || act.actividad || '') || '')
          .toString()
          .toUpperCase();

        let nuevaNota;
        if (nombreActUpper === 'BIG WHEEL (RUEDA GIGANTE)') {
          nuevaNota = 'PEDIR TICKETS EN VENTANILLA';
        } else {
          nuevaNota = 'PEDIR TICKETS A CDRA. GENERAL';
        }

        const nuevoAct = { ...act, notas: nuevaNota };
        cambiosEnGrupo = true;
        actsModGrupo++;
        actsModTot++;
        return nuevoAct;
      });

      nuevoIt[f] = nuevoArr;
    }

    gruposProc++;

    if (cambiosEnGrupo) {
      console.log(`${dryRun ? '[DRY] ' : '[APLICADO] '}Grupo ${g.id} (${g.numeroNegocio || ''}) — actividades TICKET actualizadas: ${actsModGrupo}`);

      if (!dryRun) {
        await updateDoc(doc(db,'grupos',g.id), { itinerario: nuevoIt });
        try {
          await logHist(g.id, 'APLICAR DEFAULT NOTAS TICKET', {
            _group: g,
            anterior: '',
            nuevo: `Actividades TICKET actualizadas: ${actsModGrupo}`
          });
        } catch (_) {}
        gruposMod++;
      }
    }
  }

  console.log(
    `FIN aplicarNotasDefaultTickets — ` +
    `grupos procesados: ${gruposProc}, grupos modificados: ${gruposMod}, ` +
    `actividades modificadas: ${actsModTot}, dryRun: ${dryRun}`
  );
  return { gruposProc, gruposMod, actsMod: actsModTot, dryRun };
};

// ===== UTILIDAD: Sincronizar TODOS los itinerarios con Servicios (concurrencia limitada) =====
// Ejecuta en consola:  await syncAllItinerariosConServicios(4)
window.syncAllItinerariosConServicios = async function(limit = 4) {
  try {
    const qs = await getDocs(collection(db, 'grupos'));
    const grupos = qs.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    let ok = 0, changed = 0, fail = 0;

    async function worker(g) {
      try {
        const svcMaps = await getServiciosMaps(g.destino || '');
        const res = await syncItinerarioServicios(g.id, g, svcMaps); // { it, changed }
        ok++; if (res.changed) changed++;

        // Recalcular estado/badge con el itinerario resultante
        try { await updateEstadoRevisionAndBadge(g.id, res.it); } catch(_) {}

        console.log(`✓ ${g.id} — ${(g.nombreGrupo || g.numeroNegocio || '').toString()} ${res.changed ? '— actualizado' : ''}`);
      } catch (e) {
        fail++;
        console.error(`✗ ${g.id}`, e);
      }
    }

    // Concurrencia simple para no saturar Firestore
    const queue = grupos.slice();
    const n = Math.max(1, Math.min(limit, 6));
    const runners = Array.from({ length: n }, async () => {
      while (queue.length) {
        const g = queue.shift();
        await worker(g);
      }
    });

    await Promise.all(runners);
    console.log(`FIN — procesados:${ok}, actualizados:${changed}, errores:${fail}`);
    return { procesados: ok, actualizados: changed, errores: fail };
  } catch (e) {
    console.error('Error en syncAllItinerariosConServicios:', e);
    throw e;
  }
};


/** =========================
 *  HISTORIAL (UI + datos)
 *  ========================= */

/** Formatea timestamp Firestore/Date a 'dd/mm/yyyy HH:MM:ss' */
function fmtTS(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
    if (!d || isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return ''; }
}

/** Renderiza la lista del historial */
function renderHistorialList(arr) {
  if (!listHistorial) return;
  if (!arr?.length) {
    listHistorial.innerHTML = `<li class="hist-item"><div class="meta">— Sin eventos —</div></li>`;
    return;
  }
  listHistorial.innerHTML = arr.map(h => {
    const ts = fmtTS(h.timestamp);
    const anterior = (h.anterior ?? '').toString();
    const nuevo    = (h.nuevo ?? '').toString();
    const tieneDiff = anterior || nuevo;
    const motivo   = (h.motivo ?? '').toString();
    const detalle  = (h.detalle ?? '').toString();
    const path     = (h.path ?? '').toString();

    return `
      <li class="hist-item">
        <div class="line1">
          <strong>${(h.accion || '').toString().toUpperCase()}</strong>
          <span class="meta">· ${h.usuario || ''}</span>
          <span class="meta">· ${ts}</span>
        </div>
        <div class="line2">
          ${tieneDiff ? `<div><span class="meta">Cambio:</span> <code>${anterior || '—'}</code> → <code>${nuevo || '—'}</code></div>` : ''}
          ${motivo ? `<div><span class="meta">Motivo:</span> ${motivo}</div>` : ''}
          ${detalle ? `<div><span class="meta">Detalle:</span> ${detalle}</div>` : ''}
          ${path ? `<div class="meta">Path: ${path}</div>` : ''}
        </div>
      </li>
    `;
  }).join('');
}

/** Abre el modal y consulta la colección 'historial' para el grupo actual */
async function openHistorialPanel() {
  const grupoId = selectNum?.value;
  if (!grupoId || !modalHistorial) return;

  modalHistorial.style.display = "block";
  if (modalBg) modalBg.style.display = "block";
  document.body.classList.add('modal-open');   // <- importante

  // Estado de carga
  if (listHistorial) listHistorial.innerHTML = `<li class="hist-item"><div class="meta">Cargando…</div></li>`;

  try {
    // Trae TODO el historial del grupo y ordena por timestamp desc en cliente
    const qs = await getDocs(query(
      collection(db, 'historial'),
      where('grupoId','==', grupoId)
    ));
    historialCache = qs.docs.map(d => ({ id: d.id, ...(d.data()||{}) }))
      .sort((a,b) => {
        const ta = (a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp || 0)).getTime();
        const tb = (b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp || 0)).getTime();
        return tb - ta;
      });

    // Render inicial y reset de filtro
    if (filtroHistorial) filtroHistorial.value = '';
    renderHistorialList(historialCache);
  } catch (e) {
    console.warn('Error cargando historial:', e);
    if (listHistorial) listHistorial.innerHTML = `<li class="hist-item"><div class="meta">Error al cargar el historial.</div></li>`;
  }
}

/* ===========================================================
   ESTADÍSTICAS DE ITINERARIOS — v1
   - Cálculo de similitud por orden (LCS), set (Jaccard) y meta.
   - Filtros por Año, Destino, Programa, rango de días.
   - Modos: uno vs muchos (base) y pares (top).
   =========================================================== */

/* Helpers UI modal */
function openStatsModal(){
  if (!modalStats) return;
  modalStats.style.display = "block";
  if (bgStats) bgStats.style.display = "block";
  document.body.classList.add("modal-open");
  hydrateStatsFilters().catch(console.warn);
}
function closeStatsModal(){
  if (!modalStats) return;
  modalStats.style.display = "none";
  if (bgStats) bgStats.style.display = "none";
  document.body.classList.remove("modal-open");
}

/* --- Lectura de grupos y armado de opciones --- */
async function getAllGroupsForStats(){
  if (STATS_GROUPS_CACHE) return STATS_GROUPS_CACHE;
  const qs = await getDocs(collection(db,'grupos'));
  STATS_GROUPS_CACHE = qs.docs.map(d => ({ id:d.id, ...(d.data()||{}) }));
  return STATS_GROUPS_CACHE;
}

function uniqueSorted(arr){
  return [...new Set(arr.filter(Boolean).map(x=>x.toString()))].sort((a,b)=> (a>b?1:-1));
}

async function hydrateStatsFilters(){
  const grupos = await getAllGroupsForStats();

  // Opciones Año/Destino/Programa
  const anos     = uniqueSorted(grupos.map(g=>g.anoViaje));
  const destinos = uniqueSorted(grupos.map(g=> (g.destino||'').toString().toUpperCase()));
  const programas= uniqueSorted(grupos.map(g=> (g.programa||'').toString().toUpperCase()));

  selAno.innerHTML = `<option value="">(todos)</option>` + anos.map(a=>`<option>${a}</option>`).join('');
  selDestino.innerHTML = `<option value="">(todos)</option>` + destinos.map(d=>`<option>${d}</option>`).join('');
  selPrograma.innerHTML = `<option value="">(todos)</option>` + programas.map(p=>`<option>${p}</option>`).join('');

  // Base (solo dentro del filtro actual básico: por ahora, todos)
  selBaseGrupo.innerHTML = `<option value="">(ninguno)</option>` +
    grupos.map(g=>`<option value="${g.id}">#${g.numeroNegocio||g.id} — ${(g.nombreGrupo||'').toString().toUpperCase()}</option>`).join('');

  // Ajuste rango de días por defecto
  const maxDias = Math.max(...grupos.map(g=> Object.keys(g.itinerario||{}).length || 0), 8);
  inpDiaHasta.value = Math.max(1, maxDias);
  // [CONSENSO-ADD] umbral por defecto si está vacío
  if (inpUmbral && !String(inpUmbral.value).trim()) inpUmbral.value = 0.70;
}

/* --------- Firma de un grupo (secuencias por día + meta) --------- */
function seqFromDayActivities(arr){
  // token preferente: servicioId; fallback a K(actividad)
  const ordered = (arr||[]).slice().sort((a,b)=> (a.horaInicio||'').localeCompare(b.horaInicio||''));
  return ordered.map(a => (a.servicioId || K(a.actividad||'')));
}

async function getFlightsSetForGroup(grupoId){
  // Opcional: estructura de vuelos puede variar; intentar 'vuelos' o 'horarios_publicos'
  const set = new Set();
  try {
    let qs = await getDocs(query(collection(db,'vuelos'), where('grupoId','==',grupoId)));
    if (!qs.empty) {
      qs.forEach(d => {
        const v = d.data()||{};
        const aer = (v.aerolinea || v.airline || '').toString().toUpperCase();
        if (aer) set.add(aer);
      });
      return set;
    }
  } catch(_) {}
  try {
    let qs = await getDocs(query(collection(db,'horarios_publicos'), where('grupoId','==',grupoId)));
    qs.forEach(d=>{
      const v = d.data()||{};
      const aer = (v.aerolinea || v.airline || '').toString().toUpperCase();
      if (aer) set.add(aer);
    });
  } catch(_) {}
  return set;
}

// ===================
// [CONSENSO-REPLACE] buildSignature(grupo)
// ===================
async function buildSignature(grupo){
  // Cache
  if (STATS_SIGS_CACHE.has(grupo.id)) return STATS_SIGS_CACHE.get(grupo.id);

  const it = grupo.itinerario || {};
  const fechas = Object.keys(it).sort(sortDiasItinerario);

  // Secuencias por día (tokens) y sus etiquetas visibles (labels)
  const diasSeq  = [];
  const diasLbls = [];
  for (const f of fechas){
    const arr  = (it[f]||[]).slice().sort((a,b)=> (a.horaInicio||'').localeCompare(b.horaInicio||''));
    const seq  = arr.map(a => (a.servicioId || K(a.actividad||'')));
    const lbls = arr.map(a => ((a.servicioNombre || a.actividad || '').toString().toUpperCase()));
    diasSeq.push(seq);
    diasLbls.push(lbls);
  }

  // Set global de servicios (tokens)
  const setGlobal = new Set();
  diasSeq.forEach(seq => seq.forEach(tok => setGlobal.add(tok)));

  // Hoteles (por viaje completo)
  const dayMap = await buildHotelDayMapForGroup(grupo.id);
  const hotelesSet = new Set();
  for (const iso of Object.keys(dayMap)){
    for (const a of (dayMap[iso]||[])){
      const h  = hotelCache.get(a.hotelId) || {};
      const nm = (h.nombre || '').toString().toUpperCase();
      if (nm) hotelesSet.add(nm);
    }
  }

  // Vuelos (aerolíneas)
  const vuelosSet = await getFlightsSetForGroup(grupo.id);

  const firma = {
    id: grupo.id,
    numeroNegocio: grupo.numeroNegocio || grupo.id,
    nombreGrupo: (grupo.nombreGrupo||'').toString(),
    destino: (grupo.destino||'').toString().toUpperCase(),
    programa: (grupo.programa||'').toString().toUpperCase(),
    coordinador: (grupo.coordinador || grupo.coordinadorNombre || grupo.asignadoCoordinador || '').toString().toUpperCase(),
    diasSeq,                           // Array<Array<token>>
    diasLbls,                          // Array<Array<label>>
    setGlobal,                         // Set<token>
    meta: { hotelesSet, vuelosSet }    // Set<string>, Set<string>
  };

  STATS_SIGS_CACHE.set(grupo.id, firma);
  return firma;
}

/* ------------- Métricas de similitud ------------- */
function jaccard(setA, setB){
  const a = setA || new Set();
  const b = setB || new Set();
  if (!a.size && !b.size) return 1;
  let inter = 0;
  a.forEach(x => { if (b.has(x)) inter++; });
  const union = a.size + b.size - inter;
  return union ? (inter/union) : 0;
}

function lcsLen(a, b){
  const n=a.length, m=b.length;
  if (!n && !m) return 1; // ambos vacíos = máximo parecido
  const dp = Array(n+1).fill(null).map(()=>Array(m+1).fill(0));
  for (let i=1;i<=n;i++){
    for (let j=1;j<=m;j++){
      dp[i][j] = (a[i-1]===b[j-1]) ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  const denom = Math.max(1, Math.max(n,m));
  return dp[n][m] / denom;
}

function avg(nums){
  if (!nums.length) return 0;
  return nums.reduce((s,x)=>s+x,0)/nums.length;
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function normalizeWeights(wOrden, wSet, wMeta){
  const s = Math.max(1, wOrden + wSet + wMeta);
  return { wO: wOrden/s, wS: wSet/s, wM: wMeta/s };
}

/* Cálculo entre dos firmas */
function computePairSimilarity(sigA, sigB, params){
  const d1 = Math.max(1, parseInt(params.diaDesde||1,10));
  const d2 = Math.max(d1, parseInt(params.diaHasta||999,10));

  const maxIdx = Math.max(sigA.diasSeq.length, sigB.diasSeq.length);
  const from = Math.max(1, Math.min(d1, maxIdx));
  const to   = Math.max(from, Math.min(d2, maxIdx));

  const orderScores = [];
  const setScores   = [];

  for (let day=from; day<=to; day++){
    const i = day-1;
    const sa = sigA.diasSeq[i] || [];
    const sb = sigB.diasSeq[i] || [];
    orderScores.push(lcsLen(sa, sb));
    setScores.push(jaccard(new Set(sa), new Set(sb)));
  }

  const orderAvg = avg(orderScores);
  const setAvg   = avg(setScores);

  // Meta: destino/programa/coordinador + Jaccard de vuelos/hoteles si existen
  const metaPieces = [];
  if (sigA.destino && sigB.destino)   metaPieces.push(sigA.destino===sigB.destino ? 1:0);
  if (sigA.programa && sigB.programa) metaPieces.push(sigA.programa===sigB.programa ? 1:0);
  if (sigA.coordinador && sigB.coordinador) metaPieces.push(sigA.coordinador===sigB.coordinador ? 1:0);
  if (sigA.meta && sigB.meta){
    const hJ = jaccard(sigA.meta.hotelesSet, sigB.meta.hotelesSet);
    const vJ = jaccard(sigA.meta.vuelosSet, sigB.meta.vuelosSet);
    if (!Number.isNaN(hJ)) metaPieces.push(hJ);
    if (!Number.isNaN(vJ)) metaPieces.push(vJ);
  }
  const metaAvg = metaPieces.length ? avg(metaPieces) : 0;

  const { wO, wS, wM } = normalizeWeights(params.wOrden, params.wSet, params.wMeta);
  const finalScore = clamp01(wO*orderAvg + wS*setAvg + wM*metaAvg);

  return {
    pair: [sigA, sigB],
    days: { from, to },
    orderAvg, setAvg, metaAvg,
    finalScore,
    perDay: orderScores.map((o,i)=>({ day: from+i, order:o, set:setScores[i] }))
  };
}

// ===========================================================
// [CONSENSO-ADD] CONSENSO / MODO "ITINERARIO QUE MÁS SE REPITE"
// ===========================================================

/** Construye corpus de etiquetas por token (serviceId o K(actividad)) */
function buildTokenLabelCorpus(sigs){
  const map = new Map(); // token -> Map<label, count>
  for (const sig of sigs){
    const L = sig.diasLbls || [];
    const S = sig.diasSeq  || [];
    for (let i=0;i<Math.max(L.length, S.length);i++){
      const labels = L[i] || [];
      const tokens = S[i] || [];
      const n = Math.min(tokens.length, labels.length);
      for (let j=0;j<n;j++){
        const tok = tokens[j];
        const lab = (labels[j] || String(tok)).toString().toUpperCase();
        if (!map.has(tok)) map.set(tok, new Map());
        const mm = map.get(tok);
        mm.set(lab, (mm.get(lab)||0)+1);
      }
    }
  }
  function best(token){
    const mm = map.get(token);
    if (!mm) return String(token);
    let bestL = '', bestC = -1;
    mm.forEach((c,lab)=>{ if (c>bestC){ bestC=c; bestL=lab; } });
    return bestL || String(token);
  }
  return { map, best };
}

/** Encuentra el medoide: la firma con menor suma de distancias (1-sim) */
function findMedoidSig(sigs, params){
  if (!sigs.length) return { index:-1, sig:null, avgSim:0 };
  let bestIdx = 0, bestSum = Infinity, bestAvg = 0;
  for (let i=0;i<sigs.length;i++){
    let sum = 0;
    for (let j=0;j<sigs.length;j++){
      if (i===j) continue;
      const r = computePairSimilarity(sigs[i], sigs[j], params);
      sum += (1 - r.finalScore);
    }
    if (sum < bestSum){
      bestSum = sum;
      bestIdx = i;
      bestAvg = 1 - (sum / Math.max(1, sigs.length-1));
    }
  }
  return { index: bestIdx, sig: sigs[bestIdx], avgSim: bestAvg };
}

/**
 * Consenso por día, basado en el medoide:
 * Para cada token del día D en el medoide, soporte = (#grupos con ese token en D)/N.
 * Mantiene tokens con soporte >= umbral (0..1). Orden del medoide.
 */
function buildConsensusFromMedoid(medoidSig, sigs, params, umbral, labeler){
  const N = sigs.length;
  const from = Math.max(1, parseInt(params.diaDesde||1,10));
  const to   = Math.max(from, parseInt(params.diaHasta||999,10));

  const days = [];
  for (let day=from; day<=to; day++){
    const i = day-1;
    const baseSeq = medoidSig.diasSeq[i] || [];
    const baseOrder = baseSeq.slice();
    const baseSet = new Set(baseSeq);

    // Conteo de soporte por token del medoide
    const supportMap = new Map(); // token -> count
    baseSet.forEach(tok => supportMap.set(tok, 0));
    for (const s of sigs){
      const sSet = new Set((s.diasSeq[i] || []));
      supportMap.forEach((cnt, tok)=>{
        if (sSet.has(tok)) supportMap.set(tok, cnt+1);
      });
    }

    // Filtrar por umbral y etiquetar con la mejor etiqueta
    const chosen = [];
    const supportArr = [];
    const labelArr = [];
    baseOrder.forEach(tok=>{
      const cnt = supportMap.get(tok)||0;
      const frac = cnt / N;
      if (frac >= umbral){
        chosen.push(tok);
        supportArr.push(frac);
        labelArr.push(labeler.best(tok));
      }
    });

    days.push({
      day,
      tokens: chosen,
      labels: labelArr,
      support: supportArr   // fracciones 0..1 por cada token en 'labels'
    });
  }

  // Cobertura global: promedio del soporte medio por día
  const dayMeans = days.map(d => d.support.length ? d.support.reduce((a,x)=>a+x,0)/d.support.length : 0);
  const coverage = dayMeans.length ? dayMeans.reduce((a,x)=>a+x,0)/dayMeans.length : 0;

  return { days, coverage, N, from, to, umbral };
}

/* Filtro de grupos */
function filterGroupsForStats(grupos, f){
  return grupos.filter(g=>{
    if (f.ano && String(g.anoViaje||'') !== String(f.ano)) return false;
    if (f.dest && (g.destino||'').toString().toUpperCase() !== f.dest) return false;
    if (f.prog && (g.programa||'').toString().toUpperCase() !== f.prog) return false;
    return true;
  });
}

/* Render UI */
function renderKPIs(info){
  const pills = [
    `Grupos: ${info.count}`,
    `Días: ${info.from}–${info.to}`,
    `Pesos → Orden:${Math.round(info.wO*100)}% Set:${Math.round(info.wS*100)}% Meta:${Math.round(info.wM*100)}%`
  ];
  kpisDiv.innerHTML = pills.map(t=>`<span class="pill">${t}</span>`).join('');
}

function renderResultsTable(rows, mode){
  STATS_LAST_CONSENSUS = null; // ← limpia consenso previo si se muestran pares/base
  STATS_LAST_ROWS = rows || [];
  btnExportCSV.disabled = !rows?.length;

  if (!rows?.length){
    resultsDiv.innerHTML = `<p>— Sin resultados —</p>`;
    detailDiv.innerHTML = '';
    return;
  }

  const thPair = (mode==='pares') ? 'Grupo A ↔ Grupo B' : 'Base ↔ Grupo';
  resultsDiv.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>${thPair}</th>
          <th>Score</th>
          <th>Orden</th>
          <th>Set</th>
          <th>Meta</th>
          <th>Acción</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r,i)=>`
          <tr>
            <td>${i+1}</td>
            <td>
              <span class="badge">#${r.a.numeroNegocio}</span> ${(r.a.nombreGrupo||'').toUpperCase()} 
              &nbsp;↔&nbsp; 
              <span class="badge">#${r.b.numeroNegocio}</span> ${(r.b.nombreGrupo||'').toUpperCase()}
            </td>
            <td class="score">${(r.final*100).toFixed(1)}%</td>
            <td>${(r.order*100).toFixed(0)}%</td>
            <td>${(r.set*100).toFixed(0)}%</td>
            <td>${(r.meta*100).toFixed(0)}%</td>
            <td><button data-i="${i}" class="btnVerDetalle">Ver</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  resultsDiv.querySelectorAll('.btnVerDetalle').forEach(btn=>{
    btn.onclick = (e)=>{
      const i = parseInt(btn.getAttribute('data-i'),10);
      showPairDetail(rows[i]);
    };
  });

  // Render del primer detalle por conveniencia
  showPairDetail(rows[0]);
}

function showPairDetail(row){
  if (!row){
    detailDiv.innerHTML = '';
    return;
  }
  const a = row.a, b=row.b;
  const pd = row.perDay || [];
  const daysHtml = pd.map(x=>{
    const seqA = (a.sig.diasSeq[x.day-1] || []).join(' · ') || '(sin actividades)';
    const seqB = (b.sig.diasSeq[x.day-1] || []).join(' · ') || '(sin actividades)';
    return `
      <div class="day">
        <div><strong>Día ${x.day}</strong> — Orden: ${(x.order*100).toFixed(0)}% · Set: ${(x.set*100).toFixed(0)}%</div>
        <div><span class="badge">A</span> <code>${seqA}</code></div>
        <div><span class="badge">B</span> <code>${seqB}</code></div>
      </div>
    `;
  }).join('');
  detailDiv.innerHTML = `
    <h4>Detalle</h4>
    <p><b>#${a.numeroNegocio}</b> ${(a.nombreGrupo||'').toUpperCase()} ↔ 
       <b>#${b.numeroNegocio}</b> ${(b.nombreGrupo||'').toUpperCase()}</p>
    <p>Score ${(row.final*100).toFixed(1)}% 
       — Orden ${(row.order*100).toFixed(0)}% 
       — Set ${(row.set*100).toFixed(0)}% 
       — Meta ${(row.meta*100).toFixed(0)}%</p>
    ${daysHtml}
  `;
}

/* Export CSV — ranking (base/pares) y, si existe, también PLANTILLA-CONSENSO */
function exportStatsCSV(){
  const haveRanking = STATS_LAST_ROWS && STATS_LAST_ROWS.length;
  const haveCons    = !!STATS_LAST_CONSENSUS;

  if (!haveRanking && !haveCons){
    alert('— No hay datos para exportar —');
    return;
  }

  // Helper para descargar
  function downloadCSV(text, filename){
    const blob = new Blob([text], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 1) Export CONSENSO (si existe): un archivo con los días/actividades + metadatos
  if (haveCons){
    const C = STATS_LAST_CONSENSUS;
    const linesC = [];
    linesC.push('tipo,valor');
    linesC.push(`medoide_numero,${C.head.medoidNum}`);
    linesC.push(`medoide_nombre,"${(C.head.medoidNombre||'').replace(/"/g,'""')}"`);
    linesC.push(`grupos_analizados,${C.head.N}`);
    linesC.push(`umbral,${Math.round(C.head.umbral*100)}%`);
    linesC.push(`cobertura_promedio,${Math.round(C.head.coverage*100)}%`);
    linesC.push(`rango_dias,${C.head.from}-${C.head.to}`);
    linesC.push('');
    linesC.push('dia,orden,label,soporte_pct');

    (C.days||[]).forEach(d=>{
      if (!d.labels?.length){
        linesC.push(`${d.day},,,""`);
      } else {
        d.labels.forEach((lab,idx)=>{
          const pct = (d.support[idx]*100).toFixed(0);
          linesC.push(`${d.day},${idx+1},"${(lab||'').replace(/"/g,'""')}",${pct}%`);
        });
      }
    });

    downloadCSV(linesC.join('\n'), 'consenso_itinerarios.csv');
  }

  // 2) Export RANKING (si existe): como antes
  if (haveRanking){
    const headers = ['rank','A_numero','A_nombre','B_numero','B_nombre','score','orden','set','meta','dias_from','dias_to'];
    const lines = [headers.join(',')];
    STATS_LAST_ROWS.forEach((r,i)=>{
      lines.push([
        i+1,
        r.a.numeroNegocio, `"${(r.a.nombreGrupo||'').replace(/"/g,'""')}"`,
        r.b.numeroNegocio, `"${(r.b.nombreGrupo||'').replace(/"/g,'""')}"`,
        (r.final*100).toFixed(1),
        (r.order*100).toFixed(0),
        (r.set*100).toFixed(0),
        (r.meta*100).toFixed(0),
        r.days.from, r.days.to
      ].join(','));
    });
    downloadCSV(lines.join('\n'), 'estadisticas_itinerarios.csv');
  }
}

/* Run */
async function runStats(){
  resultsDiv.innerHTML = 'Calculando…';
  detailDiv.innerHTML = '';
  kpisDiv.innerHTML = '';

  const gruposAll = await getAllGroupsForStats();
  const f = {
    ano: (selAno?.value||'').trim(),
    dest: (selDestino?.value||'').trim().toUpperCase(),
    prog: (selPrograma?.value||'').trim().toUpperCase()
  };
  const candidatos = filterGroupsForStats(gruposAll, f);
  if (!candidatos.length){
    resultsDiv.innerHTML = '— No hay grupos que cumplan los filtros —';
    return;
  }

  const diaDesde = Math.max(1, parseInt(inpDiaDesde.value||1,10));
  const diaHasta = Math.max(diaDesde, parseInt(inpDiaHasta.value||999,10));

  const wOrden = Math.max(0, parseInt(rngWOrden.value||60,10));
  const wSet   = Math.max(0, parseInt(rngWSet.value||30,10));
  const wMeta  = Math.max(0, parseInt(rngWMeta.value||10,10));
  const weights = { wOrden, wSet, wMeta };
  const normW = normalizeWeights(wOrden,wSet,wMeta);

  renderKPIs({ count: candidatos.length, from: diaDesde, to: diaHasta, ...normW });

  // Construye firmas
  const sigs = [];
  for (const g of candidatos){
    sigs.push(await buildSignature(g));
  }

  const baseId = (selBaseGrupo?.value||'').trim();
  let rows = [];

  if (baseId){
    const base = sigs.find(s => s.id===baseId);
    if (!base){
      resultsDiv.innerHTML = '— El grupo base no está dentro del filtro actual —';
      return;
    }
    const others = sigs.filter(s => s.id!==baseId);
    for (const other of others){
      const res = computePairSimilarity(base, other, { diaDesde, diaHasta, ...weights });
      rows.push({
        a:{ numeroNegocio: base.numeroNegocio, nombreGrupo: base.nombreGrupo, sig: base },
        b:{ numeroNegocio: other.numeroNegocio, nombreGrupo: other.nombreGrupo, sig: other },
        order: res.orderAvg, set: res.setAvg, meta: res.metaAvg, final: res.finalScore, days: res.days, perDay: res.perDay
      });
    }
    rows.sort((x,y)=> y.final - x.final);
    rows = rows.slice(0, 50);
    renderResultsTable(rows, 'base');
    return;
  }

  // Pares (si está marcado)
  if (chkPares?.checked){
    const MAX = 150; // seguridad
    if (sigs.length > MAX){
      resultsDiv.innerHTML = `Demasiados grupos (${sigs.length}). Reduce filtros o desmarca "pares". (Límite ${MAX})`;
      return;
    }
    for (let i=0;i<sigs.length;i++){
      for (let j=i+1;j<sigs.length;j++){
        const A = sigs[i], B=sigs[j];
        const res = computePairSimilarity(A, B, { diaDesde, diaHasta, ...weights });
        rows.push({
          a:{ numeroNegocio: A.numeroNegocio, nombreGrupo: A.nombreGrupo, sig:A },
          b:{ numeroNegocio: B.numeroNegocio, nombreGrupo: B.nombreGrupo, sig:B },
          order: res.orderAvg, set: res.setAvg, meta: res.metaAvg, final: res.finalScore, days: res.days, perDay: res.perDay
        });
      }
    }
    rows.sort((x,y)=> y.final - x.final);
    rows = rows.slice(0, 50);
    renderResultsTable(rows, 'pares');
    return;
  }

  // ===================
  // [CONSENSO-REPLACE] Modo CONSENSO (itinerario que más se repite)
  // ===================
  
  // Si no hay base ni pares: calculamos el medoide y el consenso
  const umbral = Math.max(0, Math.min(1, parseFloat(String(inpUmbral?.value||'0.70')) || 0.70));
  
  // 1) Etiquetador: corpus para mostrar nombres legibles por token
  const labelCorpus = buildTokenLabelCorpus(sigs);
  
  // 2) Medoide en el rango y con los pesos
  const med = findMedoidSig(sigs, { diaDesde, diaHasta, ...weights });
  
  // 3) Plantilla-consenso (actividades que están en ≥ umbral de grupos por día)
  const consenso = buildConsensusFromMedoid(med.sig, sigs, { diaDesde, diaHasta, ...weights }, umbral, labelCorpus);
  
  // 4) Render cabecera + plantilla por día
  const baseInfo = {
    numero: med.sig?.numeroNegocio || '—',
    nombre: (med.sig?.nombreGrupo || '').toString().toUpperCase()
  };
  
  const headHtml = `
    <div class="consensus-box">
      <h3>Itinerario más representativo (Medoide)</h3>
      <p><b>#${baseInfo.numero}</b> ${baseInfo.nombre}</p>
      <p>Cobertura promedio ≥ ${Math.round(consenso.umbral*100)}%: <b>${Math.round(consenso.coverage*100)}%</b> 
         · Grupos analizados: <b>${consenso.N}</b> · Días: <b>${consenso.from}–${consenso.to}</b></p>
    </div>
  `;
  
  const daysHtml = consenso.days.map(d=>{
    if (!d.labels.length){
      return `<div class="day"><strong>Día ${d.day}:</strong> <em>(sin consenso suficiente)</em></div>`;
    }
    const line = d.labels.map((lab,i)=> `${lab} <span class="meta">(${Math.round(d.support[i]*100)}%)</span>`).join(' · ');
    return `<div class="day"><strong>Día ${d.day}:</strong> ${line}</div>`;
  }).join('');
  
  resultsDiv.innerHTML = headHtml + daysHtml;
  
  // 5) Ranking de grupos más parecidos al medoide (y cuántos superan el umbral)
  rows.length = 0; // reutiliza la 'rows' ya declarada arriba en runStats()
  for (const other of sigs){
    if (other.id === med.sig.id) continue;
    const r = computePairSimilarity(med.sig, other, { diaDesde, diaHasta, ...weights });
    rows.push({
      a:{ numeroNegocio: med.sig.numeroNegocio, nombreGrupo: med.sig.nombreGrupo, sig: med.sig },
      b:{ numeroNegocio: other.numeroNegocio,   nombreGrupo: other.nombreGrupo,   sig: other   },
      order: r.orderAvg, set: r.setAvg, meta: r.metaAvg, final: r.finalScore, days: r.days, perDay: r.perDay
    });
  }
  rows.sort((x,y)=> y.final - x.final);
  
  // 6) Estado para exportación
  STATS_LAST_ROWS = rows.slice(0, 50);  // ranking (para CSV)
  STATS_LAST_CONSENSUS = {
    head: {
      medoidNum: baseInfo.numero,
      medoidNombre: baseInfo.nombre,
      N: consenso.N,
      umbral: consenso.umbral,
      coverage: consenso.coverage,
      from: consenso.from,
      to: consenso.to
    },
    days: consenso.days  // [{ day, labels[], support[] }]
  };
  if (btnExportCSV) btnExportCSV.disabled = false;
  
  // 7) Render detalle compacto
  const sobreUmbral = rows.filter(r => r.final >= umbral);
  const listaSobre = sobreUmbral.map(r => `#${r.b.numeroNegocio} ${(r.b.nombreGrupo||'').toUpperCase()} — ${(r.final*100).toFixed(0)}%`).join('<br>');
  
  detailDiv.innerHTML = `
    <h4>Más parecidos al medoide</h4>
    <p><small>Grupos con similitud ≥ ${Math.round(umbral*100)}%: <b>${sobreUmbral.length}</b></small></p>
    ${sobreUmbral.length ? `<div class="box">${listaSobre}</div>` : ``}
    <table>
      <thead><tr><th>#</th><th>Grupo</th><th>Score</th><th>Orden</th><th>Set</th><th>Meta</th></tr></thead>
      <tbody>
        ${rows.slice(0, 10).map((r,i)=>`
          <tr>
            <td>${i+1}</td>
            <td><span class="badge">#${r.b.numeroNegocio}</span> ${(r.b.nombreGrupo||'').toUpperCase()}</td>
            <td class="score">${(r.final*100).toFixed(1)}%</td>
            <td>${(r.order*100).toFixed(0)}%</td>
            <td>${(r.set*100).toFixed(0)}%</td>
            <td>${(r.meta*100).toFixed(0)}%</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  }
