// itinerario.js

// —————————————————————————————————
// 0) Importes Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import {
  getAuth,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias al DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");           // rápido
const qaHoraInicio   = document.getElementById("qa-horaInicio");
const qaAct          = document.getElementById("qa-actividad");
const qaAddBtn       = document.getElementById("qa-add");

const modalBg        = document.getElementById("modal-backdrop");
const modal          = document.getElementById("modal");
const formModal      = document.getElementById("modal-form");
const fldFecha       = document.getElementById("m-fecha");         // edición
const fldHoraIni     = document.getElementById("m-horaInicio");
const fldHoraFin     = document.getElementById("m-horaFin");
const fldAct         = document.getElementById("m-actividad");
const fldAdultos     = document.getElementById("m-adultos");
const fldEstudiantes = document.getElementById("m-estudiantes");
const fldPax         = document.getElementById("m-pax");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let choicesQuick = null;   // Choices.js para el quick‐add
let choicesEdit  = null;   // Choices.js para el modal
let editData     = null;   // { fecha, idx } si estamos editando

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  initItinerario();
});

async function initItinerario() {
  // 2.1) Cargar TODOS los grupos
  const snap   = await getDocs(collection(db, 'grupos'));
  const grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2.2) Llenar selects de nombre y número
  selectNum.innerHTML  = grupos.map(g =>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 2.3) Sincronizar selects → render
  selectNum.onchange  = () => { selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = () => { selectNum.value = selectName.value; renderItinerario(); };

  // 2.4) Quick‐Add y Modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): muestra días y actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = '';
  const grupoId = selectNum.value;
  const refG    = doc(db, 'grupos', grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data() || {};

  // 3.1) Título en mayúsculas
  titleGrupo.textContent = (g.programa || '–').toUpperCase();

  // 3.2) Inicializar itinerario si no existe
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(d => init[d] = []);
    await updateDoc(refG, { itinerario: init });
    g.itinerario = init;
  }

  // 3.3) Ordenar fechas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b) => new Date(a) - new Date(b));

  // 3.4) Preparar Choices.js en Quick‐Add
  const optsQuick = fechas.map((d,i)=>({
    value: i,
    label: `Día ${i+1} – ${formatDateReadable(d)}`
  }));
  if (choicesQuick) {
    choicesQuick.clearChoices();
    choicesQuick.setChoices(optsQuick,'value','label',false);
  } else {
    choicesQuick = new Choices(qaDia,{
      removeItemButton: true,
      placeholderValue: 'Selecciona día(s)',
      choices: optsQuick
    });
  }

  // 3.5) Preparar Choices.js en Modal
  const optsEdit = fechas.map((d,i)=>({
    value: d,
    label: `Día ${i+1} – ${formatDateReadable(d)}`
  }));
  if (choicesEdit) {
    choicesEdit.clearChoices();
    choicesEdit.setChoices(optsEdit,'value','label',false);
  } else {
    choicesEdit = new Choices(fldFecha,{
      removeItemButton: true,
      placeholderValue: 'Mover a día(s)',
      choices: optsEdit
    });
  }

  // 3.6) Construir grilla de días
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement('section');
    sec.className     = 'dia-seccion';
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">
        + Añadir actividad
      </button>
    `;
    contItinerario.appendChild(sec);

    // al pulsar “+ Añadir” abre modal en modo “nuevo”
    sec.querySelector('.btn-add')
       .onclick = () => openModal({ fecha }, false);

    // pintar actividades, ordenadas por horaInicio
    const ul  = sec.querySelector('.activity-list');
    const arr = (g.itinerario[fecha]||[])
      .slice()
      .sort((a,b) => a.horaInicio.localeCompare(b.horaInicio));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act,i) => {
        const li = document.createElement('li');
        li.className = 'activity-card';
        li.innerHTML = `
          <h4>${act.horaInicio} – ${act.horaFin}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${act.pax} pax (A:${act.adultos} E:${act.estudiantes})</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // editar
        li.querySelector('.btn-edit').onclick = () =>
          openModal({ ...act, fecha, idx:i }, true);
        // borrar
        li.querySelector('.btn-del').onclick = async () => {
          if (!confirm('¿Eliminar actividad?')) return;
          const orig = g.itinerario[fecha];
          orig.splice(i,1);
          await updateDoc(refG, { [`itinerario.${fecha}`]: orig });
          // ← registro en historial
          await addDoc(collection(db,'historial'),{
            numeroNegocio: grupoId,
            accion:        'BORRAR',
            fecha,
            actividad:     act.actividad,
            detalles:      act,
            timestamp:     new Date()
          });
          renderItinerario();
        };
        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 4) quickAddActivity(): añade en varios días
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = choicesQuick.getValue(true).map(i=>parseInt(i,10));
  const hi         = qaHoraInicio.value;
  const txt        = qaAct.value.trim().toUpperCase();
  if (!selIdx.length || !txt) {
    return alert('Selecciona día(s) y escribe actividad');
  }

  const refG  = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g     = snapG.data() || {};
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const fecha = fechas[idx];
    const arr   = g.itinerario[fecha]||[];
    const nueva = {
      horaInicio: hi,
      horaFin:    sumarUnaHora(hi),
      actividad:  txt,
      pax:        (g.adultos||0)+(g.estudiantes||0),
      adultos:    g.adultos||0,
      estudiantes:g.estudiantes||0,
      notas:      ''
    };
    arr.push(nueva);
    await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
    // ← registro en historial
    await addDoc(collection(db,'historial'),{
      numeroNegocio: grupoId,
      accion:        'CREAR',
      fecha,
      actividad:     txt,
      detalles:      nueva,
      timestamp:     new Date()
    });
  }

  qaAct.value = '';
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): abrir formulario
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById('modal-title')
          .textContent = isEdit ? 'Editar actividad' : 'Nueva actividad';

  // precarga multi‐select de fechas
  choicesEdit.setChoiceByValue(data.fecha);

  // precarga resto de campos
  fldHoraIni.value     = data.horaInicio || '07:00';
  fldHoraFin.value     = data.horaFin    || sumarUnaHora(fldHoraIni.value);
  fldAct.value         = (data.actividad||'').toUpperCase();
  fldAdultos.value     = data.adultos    ?? 0;
  fldEstudiantes.value = data.estudiantes?? 0;
  fldPax.value         = data.pax        ?? 0;
  fldNotas.value       = (data.notas||'').toUpperCase();

  // auto‐sumar +1h al cambiar inicio
  fldHoraIni.onchange = ()=> fldHoraFin.value = sumarUnaHora(fldHoraIni.value);

  modalBg.style.display = modal.style.display = 'block';
}

// —————————————————————————————————
// 6) closeModal(): cierra el modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = 'none';
}

// —————————————————————————————————
// 7) onSubmitModal(): guarda o actualiza
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fechas  = choicesEdit.getValue(true); // ['2025-12-01', ...]
  const a       = parseInt(fldAdultos.value,10)||0;
  const e       = parseInt(fldEstudiantes.value,10)||0;
  const pax     = parseInt(fldPax.value,10)||0;
  const hi      = fldHoraIni.value;
  const hf      = fldHoraFin.value;
  const txt     = fldAct.value.trim().toUpperCase();
  const note    = fldNotas.value.trim().toUpperCase();

  // validaciones
  if (a + e !== pax) {
    return alert('Total Pax debe ser suma de Adultos + Estudiantes');
  }
  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};
  const maxP  = (g.adultos||0)+(g.estudiantes||0);
  if (pax > maxP) {
    return alert(`Pax (${pax}) excede el total de grupo (${maxP})`);
  }

  // payload común
  const payload = { horaInicio:hi, horaFin:hf, actividad:txt, pax, adultos:a, estudiantes:e, notas:note };
  const refG    = doc(db,'grupos',grupoId);

  // 1) si cambio de fechas origen, eliminar viejo
  if (editData) {
    const origArr = g.itinerario[editData.fecha];
    origArr.splice(editData.idx,1);
    await updateDoc(refG, { [`itinerario.${editData.fecha}`]: origArr });
    // ← historial BORRAR
    await addDoc(collection(db,'historial'),{
      numeroNegocio: grupoId,
      accion:        'BORRAR',
      fecha:         editData.fecha,
      actividad:     editData.actividad,
      detalles:      editData,
      timestamp:     new Date()
    });
  }

  // 2) para cada fecha destino, insertar o reemplazar
  for (let f of fechas) {
    const arr = g.itinerario[f]||[];
    if (editData && f === editData.fecha) {
      arr[editData.idx] = payload;
    } else {
      arr.push(payload);
    }
    await updateDoc(refG, { [`itinerario.${f}`]: arr });
    // ← historial CREAR o EDITAR
    await addDoc(collection(db,'historial'),{
      numeroNegocio: grupoId,
      accion:        editData ? 'EDITAR' : 'CREAR',
      fecha:         f,
      actividad:     txt,
      detalles:      payload,
      timestamp:     new Date()
    });
  }

  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Utilidades
// —————————————————————————————————
function getDateRange(s,e) {
  const out = [];
  for (let d = new Date(s); d <= new Date(e); d.setDate(d.getDate()+1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

function formatDateReadable(iso) {
  const d  = new Date(iso);
  const wd = d.toLocaleDateString("es-CL",{ weekday:"long" });
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}

function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d     = new Date();
  d.setHours(h+1, m);
  return d.toTimeString().slice(0,5);
}
