// itinerario.js — Editor de Itinerarios (RT v1.0)
// ======================================================================
// Cambios relevantes en esta versión:
//  • Botón tri-estado por actividad (⭕/✅/❌) SOLO en edición (editMode).
//  • Estado global del itinerario: OK / PENDIENTE / RECHAZADO.
//  • Persistencia en grupo: grupos.{estadoRevisionItinerario}.
//  • Botón "⚠️ Alertas (n)" + Panel de alertas (grupo actual y otros).
//  • Historial para cambios de revisión; creación y cierre de alertas.
//  • Se mantiene TODO lo funcional previo (render, plantillas, swap, etc.).
// ======================================================================

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, query, where, orderBy, getDocs,
  doc, getDoc, updateDoc, addDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 0.1) Utilidades de normalización (MEJORA CLAVE)
//     → evita fallos por mayúsculas, tildes o dobles espacios
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

// —— NUEVO: Estado de revisión (banda)
const estadoBox      = document.getElementById("estado-revision");
const estadoBadge    = document.getElementById("estado-badge");

// —— NUEVO: Botón Alertas y badge
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

// —— NUEVO: Modal Alertas
const modalAlertas       = document.getElementById("modal-alertas");
const btnCloseAlertas    = document.getElementById("alertas-close");
const listAlertasActual  = document.getElementById("alertas-actual");
const listAlertasOtros   = document.getElementById("alertas-otros");

let editData    = null;   // { fecha, idx, ...act }
let choicesDias = null;   // Choices.js instance
let choicesGrupoNum = null;  // Choices para selectNum (número de negocio)
let choicesGrupoNom = null;  // Choices para selectName (nombre de grupo)
let editMode     = false;  // indica si estamos en modo edición
let swapOrigin   = null;   // punto de partida para intercambio

// —————————————————————————————————
// Función global para sumar numéricamente
// —————————————————————————————————
function actualizarPax() {
  const a = parseInt(fldAdultos.value, 10) || 0;
  const e = parseInt(fldEstudiantes.value, 10) || 0;
  fldPax.value = a + e;
}
fldAdultos.addEventListener('input', actualizarPax);
fldEstudiantes.addEventListener('input', actualizarPax);

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
  
  // 2.2.1) Inicializa Choices.js (solo una vez)
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
  
  // 2.3) Sincronizo ambos Choices.js
  choicesGrupoNum.passedElement.element.onchange = () => {
    choicesGrupoNom.setChoiceByValue(selectNum.value);
    renderItinerario();
  };
  choicesGrupoNom.passedElement.element.onchange = () => {
    choicesGrupoNum.setChoiceByValue(selectName.value);
    renderItinerario();
  };
  
  // 2.4) Quick-Add, Modal, Plantillas, Alertas
  qaAddBtn.onclick      = quickAddActivity;
  btnCancel.onclick     = closeModal;
  formModal.onsubmit    = onSubmitModal;
  btnGuardarTpl.onclick = guardarPlantilla;
  btnCargarTpl.onclick  = cargarPlantilla;

  // —— NUEVO: botón Alertas
  btnAlertas.onclick    = openAlertasPanel;
  btnCloseAlertas.onclick = () => { modalAlertas.style.display = "none"; document.getElementById("modal-backdrop").style.display="none"; };

  await cargarListaPlantillas();

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// ————— Botón Activar/Desactivar edición —————
const btnToggleEdit = document.getElementById("btnToggleEdit");
btnToggleEdit.onclick = () => {
  editMode = !editMode;
  btnToggleEdit.textContent = editMode ? "🔒 Desactivar edición" : "🔓 Activar edición";
  // deshabilitamos Quick-Add y modal para evitar conflictos
  document.getElementById("quick-add").style.display = editMode ? "none" : "";
  btnGuardarTpl.disabled = editMode;
  btnCargarTpl.disabled  = editMode;
  renderItinerario();
};

// —————————————————————————————————
// Autocomplete de actividades (para inputs)
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
    } catch (e) { /* subcolección inexistente: ignorar */ }
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
// Catálogo de servicios por destino (ROBUSTO con alias + normalización)
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
    } catch (e) { /* destino no existente: ignorar */ }
  }
  return { byId, byName, packs };
}

// ===================================================================
// Sincroniza actividades con Servicios (si aplica)
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

      // si tiene servicioId válido, refrescar nombre/destino
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

      // —— NUEVO: asegurar campo revision en memoria (no escribe todavía)
      if (!res.revision) res.revision = 'pendiente';

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
// NUEVO — helpers Estado Revisión + Alertas
// —————————————————————————————————

// Calcula estado global del itinerario a partir de todas las actividades
function computeEstadoFromItinerario(IT) {
  let any = false, anyPend = false, anyX = false, allOK = true;
  for (const f of Object.keys(IT||{})) {
    for (const act of (IT[f]||[])) {
      any = true;
      const r = act.revision || 'pendiente';
      if (r === 'rechazado') anyX = true;
      if (r !== 'ok') allOK = false;
      if (r === 'pendiente') anyPend = true;
    }
  }
  if (!any) return 'PENDIENTE';            // sin actividades ⇒ pendiente
  if (anyX) return 'RECHAZADO';
  return allOK ? 'OK' : 'PENDIENTE';
}

// Setea la banda visual (no persiste)
function setEstadoBadge(estado) {
  estadoBadge.textContent = estado;
  estadoBadge.classList.remove('badge-ok','badge-pendiente','badge-rechazado');
  if (estado === 'OK') estadoBadge.classList.add('badge-ok');
  else if (estado === 'RECHAZADO') estadoBadge.classList.add('badge-rechazado');
  else estadoBadge.classList.add('badge-pendiente');
}

// Persiste estado en el doc de grupo si cambió y actualiza banda/alertas badge
async function updateEstadoRevisionAndBadge(grupoId, ITopt = null) {
  const gSnap = await getDoc(doc(db,'grupos',grupoId));
  const g = gSnap.data() || {};
  const IT = ITopt || g.itinerario || {};
  const nuevoEstado = computeEstadoFromItinerario(IT);
  if (g.estadoRevisionItinerario !== nuevoEstado) {
    await updateDoc(doc(db,'grupos',grupoId), { estadoRevisionItinerario: nuevoEstado });
  }
  setEstadoBadge(nuevoEstado);
  await refreshAlertasBadge(grupoId);
}

// Cuenta alertas no vistas y refresca badge (n)
async function refreshAlertasBadge(grupoId) {
  try {
    const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
    const pendientes = qs.docs.filter(d => !((d.data()||{}).visto)).length;
    alertasBadge.textContent = String(pendientes);
  } catch (_) {
    alertasBadge.textContent = "0";
  }
}

// Abre panel alertas, lista del grupo y otros grupos
async function openAlertasPanel() {
  const grupoId = selectNum.value;
  if (!grupoId) return alert("Selecciona un grupo");
  // Mostrar modal
  modalAlertas.style.display = "block";
  document.getElementById("modal-backdrop").style.display = "block";

  // 1) Alertas del grupo actual
  listAlertasActual.innerHTML = "Cargando…";
  try {
    const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
    const arr = qs.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => new Date(b.creadoEn || 0) - new Date(a.creadoEn || 0));
    if (!arr.length) {
      listAlertasActual.innerHTML = `<li class="empty">— Sin alertas —</li>`;
    } else {
      listAlertasActual.innerHTML = arr.map(a => `
        <li class="alert-item ${a.visto ? 'visto':''}">
          <div>
            <strong>${a.actividad || '(actividad)'}</strong>
            <small> · ${a.fecha || ''}</small>
            ${a.motivo ? `<div class="motivo">Motivo: ${a.motivo}</div>`:''}
          </div>
          <div class="actions">
            ${a.visto ? '' : `<button data-id="${a.id}" class="btn-ver-alerta">Marcar visto</button>`}
          </div>
        </li>
      `).join('');
      // bind marcar visto
      listAlertasActual.querySelectorAll('.btn-ver-alerta').forEach(btn=>{
        btn.onclick = async () => {
          const id = btn.getAttribute('data-id');
          await updateDoc(doc(db,'grupos',grupoId,'alertas',id), { visto: true });
          await refreshAlertasBadge(grupoId);
          openAlertasPanel(); // recarga panel
        };
      });
    }
  } catch (e) {
    listAlertasActual.innerHTML = `<li class="empty">Error al cargar alertas.</li>`;
  }

  // 2) Otros grupos con revisión pendiente (RECHAZADO) o alertas
  listAlertasOtros.innerHTML = "Cargando…";
  try {
    const qsRech = await getDocs(query(collection(db,'grupos'), where('estadoRevisionItinerario','==','RECHAZADO')));
    const otros = qsRech.docs
      .filter(d => d.id !== grupoId)
      .map(d => ({ id: d.id, ...(d.data()||{}) }));
    if (!otros.length) {
      listAlertasOtros.innerHTML = `<li class="empty">— No hay otros grupos con revisión rechazada —</li>`;
    } else {
      listAlertasOtros.innerHTML = otros.map(g=>`
        <li class="alert-item">
          <div>
            <strong>${(g.nombreGrupo||'').toString().toUpperCase()}</strong>
            <small> · #${g.numeroNegocio||g.id} · ${g.estadoRevisionItinerario||''}</small>
          </div>
          <div class="actions">
            <button class="btn-ir-grupo" data-id="${g.id}">Ir al itinerario</button>
          </div>
        </li>
      `).join('');
      listAlertasOtros.querySelectorAll('.btn-ir-grupo').forEach(btn=>{
        btn.onclick = (e) => {
          const id = btn.getAttribute('data-id');
          // Selecciona el grupo y renderiza
          choicesGrupoNum.setChoiceByValue(id);
          choicesGrupoNom.setChoiceByValue(id);
          modalAlertas.style.display = "none";
          document.getElementById("modal-backdrop").style.display = "none";
          renderItinerario();
        };
      });
    }
  } catch (e) {
    listAlertasOtros.innerHTML = `<li class="empty">Error al cargar otros grupos.</li>`;
  }
}

// —————————————————————————————————
// 3) renderItinerario(): crea grilla y pinta actividades (SINCRONIZADA)
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data() || {};

  // Título
  titleGrupo.textContent = (g.programa||"–").toUpperCase();

  // Preparo autocomplete
  await prepararCampoActividad("qa-actividad", g.destino);

  // Inicializo itinerario si no existe
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(d=> init[d]=[]);
    await updateDoc(doc(db,'grupos',grupoId),{ itinerario:init });
    g.itinerario = init;
  }

  // ====== traigo el catálogo y sincronizo ======
  const svcMaps = await getServiciosMaps(g.destino || '');
  const syncRes = await syncItinerarioServicios(grupoId, g, svcMaps);
  const IT = syncRes.it; // itinerario ya sincronizado

  // —— NUEVO: refrescar estado y badge alertas
  await updateEstadoRevisionAndBadge(grupoId, IT);

  // Fechas ordenadas
  const fechas = Object.keys(IT).sort((a,b)=> new Date(a)-new Date(b));

  // Choices.js multi-select
  const opts = fechas.map((d,i)=>({ value: i, label: `Día ${i+1} – ${formatDateReadable(d)}` }));
  if (choicesDias) { choicesDias.clearChoices(); choicesDias.setChoices(opts,'value','label',false); }
  else { choicesDias = new Choices(qaDia, { removeItemButton: true, placeholderValue: 'Selecciona día(s)', choices: opts }); }

  // Select para modal
  fldFecha.innerHTML = fechas.map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`).join('');

  // Helper
  function createBtn(icon, cls, title='') { const b = document.createElement("span"); b.className = cls; b.textContent = icon; b.title = title; b.style.cursor = "pointer"; return b; }

  // Pinto cada día
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
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;

    if (editMode) {
      const h3 = sec.querySelector("h3");
      const btnSwapDay  = createBtn("🔄", "btn-swap-day", "Intercambiar día");
      const btnEditDate = createBtn("✏️", "btn-edit-date", "Editar fecha base");
      btnSwapDay.dataset.fecha = fecha;
      btnEditDate.dataset.fecha = fecha;
      h3.appendChild(btnSwapDay);
      h3.appendChild(btnEditDate);
      btnSwapDay.onclick  = () => handleSwapClick("dia", fecha);
      btnEditDate.onclick = () => handleDateEdit(fecha);
    }

    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = ()=> openModal({ fecha }, false);

    const ul  = sec.querySelector(".activity-list");
    const original = IT[fecha] || [];
    const withIndex = original.map((act, originalIdx) => ({ act, originalIdx }));

    // Ordenar solo visualmente por hora
    const sorted = withIndex.slice().sort((a, b) => ((a.act.horaInicio||'').localeCompare(b.act.horaInicio||'')));

    // Pax centralizados del grupo
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

        const revision = act.revision || 'pendiente';           // ⭕ por defecto
        const iconRev  = revision === 'ok' ? '✅' : (revision === 'rechazado' ? '❌' : '⭕');
        const titleRev = revision === 'ok' ? 'Revisado (OK)' : (revision === 'rechazado' ? 'Rechazado' : 'Pendiente');

        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio || '--:--'} – ${act.horaFin || '--:--'}</h4>
          <p><strong>${visibleName}</strong></p>
          <p>👥 ${totalGrupo} pax (A:${A} E:${E})</p>
          <div class="actions">
            ${editMode ? `<button class="btn-edit">✏️</button><button class="btn-del">🗑️</button>` : `<span class="rev-static" title="${titleRev}">${iconRev}</span>`}
          </div>
        `;

        // Editar
        if (editMode) {
          li.querySelector(".btn-edit").onclick = () => openModal({ ...act, fecha, idx: originalIdx }, true);
          li.querySelector(".btn-del").onclick  = async () => {
            if (!confirm("¿Eliminar actividad?")) return;
            await addDoc(collection(db, 'historial'), {
              numeroNegocio: grupoId,
              accion:        'BORRAR ACTIVIDAD',
              anterior:      original.map(a => a.actividad).join(' – '),
              nuevo:         '',
              usuario:       auth.currentUser.email,
              timestamp:     new Date()
            });
            const arr = original.slice();
            arr.splice(originalIdx, 1);
            await updateDoc(doc(db, 'grupos', grupoId), { [`itinerario.${fecha}`]: arr });
            await updateEstadoRevisionAndBadge(grupoId, { ...IT, [fecha]: arr });
            renderItinerario();
          };

          // —— NUEVO: botón tri-estado de revisión
          const btnRev = createBtn(iconRev, "btn-revision", `Cambiar estado: ${titleRev}`);
          li.querySelector(".actions").appendChild(btnRev);
          btnRev.onclick = async () => {
            await toggleRevisionEstado(grupoId, fecha, originalIdx, act, visibleName, IT);
          };

          // Swap de actividad
          const btnSwapAct = createBtn("🔄", "btn-swap-act", "Intercambiar actividad");
          btnSwapAct.dataset.fecha = fecha;
          btnSwapAct.dataset.idx   = originalIdx;
          li.querySelector(".actions").appendChild(btnSwapAct);
          btnSwapAct.onclick = () => handleSwapClick("actividad", { fecha, idx: originalIdx });
        }

        ul.appendChild(li);
      });
    }
  }); // fechas.forEach
}

// —————————————————————————————————
// 4) quickAddActivity(): añade en varios días (ENLAZANDO SERVICIO)
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = (choicesDias.getValue(true) || []).map(x => parseInt(x,10));
  const horaInicio = qaHoraInicio.value;
  const textRaw    = qaAct.value.trim();
  const textUpper  = textRaw.toUpperCase();
  if (!selIdx.length || !textUpper) {
    return alert("Selecciona día(s) y escribe la actividad");
  }

  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};
  const totalAdults   = parseInt(g.adultos, 10)     || 0;
  const totalStudents = parseInt(g.estudiantes, 10) || 0;

  const svcMaps = await getServiciosMaps(g.destino || '');
  const key = K(textUpper);
  const sv  = svcMaps.byName.get(key) || null;

  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

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
      // —— NUEVO: revisión inicial
      revision: 'pendiente'
    };

    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'CREAR ACTIVIDAD',
      anterior:      '',
      nuevo:         item.actividad,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });

    arr.push(item);
    await updateDoc(doc(db,'grupos',grupoId), { [`itinerario.${f}`]: arr });
  }

  // Recalcular estado global
  const newSnap = await getDoc(doc(db,'grupos',grupoId));
  await updateEstadoRevisionAndBadge(grupoId, newSnap.data().itinerario || {});
  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): precarga datos en el modal
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
// 6) closeModal(): cierra el modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guarda/actualiza + historial (ENLAZANDO SERVICIO)
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
    const antes   = arr.map(x=>x.actividad).join(' – ');
    arr[editData.idx] = { ...payloadBase, revision: editData.revision || 'pendiente' }; // conserva revisión
    const despues = arr.map(x=>x.actividad).join(' – ');
    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'MODIFICAR ACTIVIDAD',
      anterior:      antes,
      nuevo:         despues,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });
  } else {
    arr.push({ ...payloadBase, revision: 'pendiente' });
    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'CREAR ACTIVIDAD',
      anterior:      '',
      nuevo:         payloadBase.actividad,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
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
// Maneja historial + alertas + recalcula estado global
// —————————————————————————————————
async function toggleRevisionEstado(grupoId, fecha, idx, act, visibleName, ITfull) {
  const old = act.revision || 'pendiente';
  const next = (old === 'pendiente') ? 'ok' : (old === 'ok' ? 'rechazado' : 'pendiente');

  const gSnap = await getDoc(doc(db,'grupos',grupoId));
  const g = gSnap.data() || {};
  const arr = (g.itinerario?.[fecha]||[]).slice();
  const updated = { ...arr[idx], revision: next };
  arr[idx] = updated;

  // Historial
  await addDoc(collection(db,'historial'), {
    numeroNegocio: grupoId,
    accion:        'CAMBIAR REVISION ACTIVIDAD',
    anterior:      old,
    nuevo:         next,
    detalle:       `${visibleName} (${fecha})`,
    usuario:       auth.currentUser.email,
    timestamp:     new Date()
  });

  // Persistir cambio
  await updateDoc(doc(db,'grupos',grupoId), { [`itinerario.${fecha}`]: arr });

  // Gestionar alertas:
  //  - Si pasa a ❌ y antes no lo era → crear alerta (no vista)
  //  - Si sale de ❌ → marcar alertas relacionadas como visto/resuelto
  if (next === 'rechazado' && old !== 'rechazado') {
    await addDoc(collection(db,'grupos',grupoId,'alertas'), {
      fecha,
      actividad: visibleName,
      motivo: '',             // puedes enriquecer a futuro
      creadoPor: auth.currentUser.email,
      creadoEn: new Date(),
      visto: false
    });
  } else if (old === 'rechazado' && next !== 'rechazado') {
    // Marcar alertas coincidentes como vistas
    try {
      const qs = await getDocs(collection(db,'grupos',grupoId,'alertas'));
      const toClose = qs.docs.filter(d => {
        const a = d.data()||{};
        return (a.fecha===fecha && (a.actividad||'')===visibleName && !a.visto);
      });
      await Promise.all(toClose.map(d => updateDoc(doc(db,'grupos',grupoId,'alertas',d.id), { visto: true })));
    } catch(_) {}
  }

  // Recalcular estado + badge alertas
  const ITnext = { ...(ITfull||{}), [fecha]: arr };
  await updateEstadoRevisionAndBadge(grupoId, ITnext);

  // Re-pintar UI
  renderItinerario();
}

// —————————————————————————————————
// Utilidades de fecha y hora
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
  const g   = grpSnap.data() || {};

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
        revision:    'pendiente' // —— NUEVO
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
          revision:    'pendiente' // —— NUEVO
        }))
      );
    });
  }

  await updateDoc(doc(db, 'grupos', selectNum.value), { itinerario: nuevoIt });
  await updateEstadoRevisionAndBadge(selectNum.value, nuevoIt);
  renderItinerario();
}

// —————————————————————————————————
// Calendario modal
// —————————————————————————————————
document.getElementById("btnAbrirCalendario")
  .addEventListener("click", () => {
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
// Swap (actividad o día)
// —————————————————————————————————
async function handleSwapClick(type, info) {
  if (!swapOrigin) {
    swapOrigin = { type, info };
    const fechaKey = (typeof info === 'string') ? info : info.fecha;
    const el = document.querySelector(`[data-fecha="${fechaKey}"]`);
    if (el) el.classList.add("swap-selected");
    return;
  }
  if (swapOrigin.type !== type) {
    alert("Debe intercambiar dos elementos del mismo tipo.");
    resetSwap();
    return;
  }
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const it      = { ...(snapG.data().itinerario || {}) };
  
  if (type === "dia") {
    const f1 = (typeof swapOrigin.info === 'string') ? swapOrigin.info : swapOrigin.info.fecha;
    const f2 = (typeof info === 'string') ? info : info.fecha;
    [ it[f1], it[f2] ] = [ it[f2], it[f1] ];
  } else {
    const { fecha: f1, idx: i1 } = swapOrigin.info;
    const { fecha: f2, idx: i2 } = info;
    [ it[f1][i1], it[f2][i2] ] = [ it[f2][i2], it[f1][i1] ];
  }
  
  await updateDoc(doc(db,'grupos',grupoId), { itinerario: it });
  await updateEstadoRevisionAndBadge(grupoId, it);
  resetSwap();
  renderItinerario();
}

function resetSwap() {
  swapOrigin = null;
  document.querySelectorAll(".swap-selected").forEach(el => el.classList.remove("swap-selected"));
}

// —————————————————————————————————
// Editar fecha base (recalcula el rango consecutivo)
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
  await updateEstadoRevisionAndBadge(grupoId, newIt);
  renderItinerario();
}

// ===== MIGRACIÓN/UTILIDADES: sincronización y reparación masiva =====

// 1) Sincronizar TODOS los itinerarios con Servicios
window.syncAllItinerariosConServicios = async function(limit = 3){
  const qs = await getDocs(collection(db,'grupos'));
  const grupos = qs.docs.map(d => ({ id: d.id, ...d.data() }));
  let ok=0, changed=0, fail=0;

  async function worker(g) {
    try {
      const svcMaps = await getServiciosMaps(g.destino || '');
      const res = await syncItinerarioServicios(g.id, g, svcMaps);
      ok++; if (res.changed) changed++;
      console.log(`✓ ${g.id} (${g.nombreGrupo || g.numeroNegocio || ''}) ${res.changed ? '— actualizado' : ''}`);
    } catch(e) { fail++; console.error(`✗ ${g.id}`, e); }
  }

  const queue = grupos.slice();
  const run = async () => { while(queue.length){ await worker(queue.shift()); } };
  const n = Math.max(1, Math.min(limit, 6));
  await Promise.all(Array.from({length:n}, run));
  console.log(`FIN — procesados:${ok}, actualizados:${changed}, errores:${fail}`);
};

// 2) Índice global de servicios para reparación masiva
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

// 3) Fuzzy simple (Jaccard por palabras)
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

// 4) Diagnóstico: actividades que no enganchan con Servicios
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

// 5) Reparación masiva (DRY RUN por defecto)
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
        await addDoc(collection(db,'historial'), {
          numeroNegocio: g.id,
          accion:        'REPARAR ITINERARIO SERVICIOS',
          anterior:      '',
          nuevo:         `Se actualizaron actividades automáticamente`,
          usuario:       (auth.currentUser && auth.currentUser.email) || 'AUTO',
          timestamp:     new Date()
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
