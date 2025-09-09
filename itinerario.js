// itinerario.js — Editor de Itinerarios (RT v1.0)
// ======================================================================
// Novedades en esta versión:
//  • Botón tri-estado por actividad (⭕/✅/❌) SOLO en edición (editMode).
//  • Estado global del itinerario: OK / PENDIENTE / RECHAZADO.
//  • Persistencia en grupo: grupos.{estadoRevisionItinerario}.
//  • Botón "⚠️ Alertas (n)" + Panel de alertas (grupo actual y otros).
//  • Motivo obligatorio al pasar a ❌ (rechazado) → queda en actividad y alerta.
//  • Historial DETALLADO para todas las acciones: crear, editar, borrar,
//    cambiar revisión, swap día/actividad, editar fecha base, cargar plantilla.
//  • Se mantiene TODO lo funcional previo.
// ======================================================================

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

// —— Modal Alertas
const modalAlertas       = document.getElementById("modal-alertas");
const btnCloseAlertas    = document.getElementById("alertas-close");
const listAlertasActual  = document.getElementById("alertas-actual");
const listAlertasOtros   = document.getElementById("alertas-otros");
const listAlertasLeidas   = document.getElementById("alertas-actual-leidas");
const listAlertasPend     = document.getElementById("alertas-pendientes");


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

async function refreshAlertasBadge(grupoId) {
  if (!alertasBadge) return;
  try {
    const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
    const pendientes = qs.docs.filter(d => !((d.data()||{}).visto)).length;
    alertasBadge.textContent = String(pendientes);
  } catch (_) {
    alertasBadge.textContent = "0";
  }
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
  await refreshAlertasBadge(grupoId);
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
        await refreshAlertasBadge(grupoId);
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

  // Inicializar itinerario si no existe
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(d=> init[d]=[]);
    await updateDoc(doc(db,'grupos',grupoId),{ itinerario:init });
    g.itinerario = init;
  }

  // Sincronizar con Servicios
  const svcMaps = await getServiciosMaps(g.destino || '');
  const syncRes = await syncItinerarioServicios(grupoId, g, svcMaps);
  const IT = syncRes.it;

  // Estado + alertas badge
  await updateEstadoRevisionAndBadge(grupoId, IT);

  // Fechas ordenadas
  const fechas = Object.keys(IT).sort((a,b)=> new Date(a)-new Date(b));

  // —— Hoteles por día para este grupo ——
  const hotelByDay = await buildHotelDayMapForGroup(grupoId);
  const lastFecha = fechas[fechas.length - 1] || null;

  // Choices días
  const opts = fechas.map((d,i)=>({ value: i, label: `Día ${i+1} – ${formatDateReadable(d)}` }));
  if (choicesDias) { choicesDias.clearChoices(); choicesDias.setChoices(opts,'value','label',false); }
  else { choicesDias = new Choices(qaDia, { removeItemButton: true, placeholderValue: 'Selecciona día(s)', choices: opts }); }

  // Select fecha del modal
  fldFecha.innerHTML = fechas.map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`).join('');

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
      // Prioriza confirmados; si no hay, muestra pendientes/otros
      const prefer = asigns.filter(a => (a.status || '').toLowerCase() === 'confirmado');
      const use    = prefer.length ? prefer : asigns;
    
      const names = [...new Set(use.map(a => {
        const h  = hotelCache.get(a.hotelId) || {};
        const nm = (h.nombre || '').toString().toUpperCase() || '(SIN NOMBRE)';
        return (a.status && a.status.toLowerCase() !== 'confirmado') ? `${nm} (PENDIENTE)` : nm;
      }))];
    
      const box = document.createElement('div');
      box.className = 'hotel-box'; // puedes mantener el estilo existente
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

  const fechas = Object.keys(g.itinerario).sort((a,b)=> new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const f   = fechas[idx];
    const arr = g.itinerario[f]||[];

    const item = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  sv ? sv.nombre : textUpper,
      pasajeros:  totalAdults + totalStudents,
      adultos:    totalAdults,
      estudiantes:totalStudents,
      notas:      "",
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
/** 5) openModal(): precarga datos en el modal **/
// —————————————————————————————————
async function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  const snapG = await getDoc(doc(db,"grupos",selectNum.value));
  const g     = snapG.data()||{};
  const A = parseInt(g.adultos, 10) || 0;
  const E = parseInt(g.estudiantes, 10) || 0;
  const T = (() => { const t = parseInt(g.cantidadgrupo, 10); return Number.isFinite(t) ? t : (A + E); })();
  
  fldFecha.value    = data.fecha;
  fldHi.value       = data.horaInicio || "07:00";
  fldHf.value       = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value      = data.actividad  || "";
  await prepararCampoActividad("m-actividad", g.destino);
  fldNotas.value    = data.notas      || "";
  fldAdultos.value     = A;
  fldEstudiantes.value = E;
  fldPax.value         = T;
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

  const payloadBase = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  sv ? sv.nombre : typedUpper,
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      (fldNotas.value || '').trim().toUpperCase(),
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
  const [sy, sm, sd] = (startStr||'').split("-").map(Number);
  const [ey, em, ed] = (endStr||'').split("-").map(Number);
  if (!sy || !ey) return out;
  const start = new Date(sy, sm - 1, sd || 1);
  const end   = new Date(ey, em - 1, ed || 1);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()     ).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
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
    .sort((a,b)=> new Date(a)-new Date(b));
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
    .sort((a,b)=> new Date(a)-new Date(b));

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
  if (!grupoId) { alert("Selecciona un grupo"); return; }
  if (!modalHistorial) return;

  // Mostrar modal + backdrop
  modalHistorial.style.display = "block";
  if (modalBg) modalBg.style.display = "block";

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
