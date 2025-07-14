// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias al DOM
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");
const qaHoraInicio   = document.getElementById("qa-horaInicio");
const qaAct          = document.getElementById("qa-actividad");
const qaAddBtn       = document.getElementById("qa-add");

const modalBg        = document.getElementById("modal-backdrop");
const modal          = document.getElementById("modal");
const formModal      = document.getElementById("modal-form");
const fldFecha       = document.getElementById("m-fecha");
const fldHi          = document.getElementById("m-horaInicio");
const fldHf          = document.getElementById("m-horaFin");
const fldAct         = document.getElementById("m-actividad");
const fldPas         = document.getElementById("m-pasajeros");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

// Para saber si estamos editando (y posición en el array)
let editData = null;

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = "login.html";
  } else {
    initItinerario();
  }
});

// —————————————————————————————————
// 3) initItinerario(): carga grupos y configura selects
// —————————————————————————————————
async function initItinerario() {
  // 3.1) Traer TODOS los grupos
  const snap = await getDocs(collection(db, 'grupos'));
  const grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 3.2) Llenar selects
  selectNum.innerHTML  = grupos.map(g =>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 3.3) Sincronizar selects y disparar render
  selectNum.onchange  = () => { selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = () => { selectNum.value = selectName.value; renderItinerario(); };

  // 3.4) Configurar quick-add y modal
  qaAddBtn.onclick    = quickAddActivity;
  btnCancel.onclick   = closeModal;
  formModal.onsubmit  = onSubmitModal;

  // 3.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 4) renderItinerario(): muestra días y actividades
// —————————————————————————————————
async function renderItinerario() {
  // Limpio
  contItinerario.innerHTML = "";

  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data() || {};

  // 4.1) Título con nombre de programa
  titleGrupo.textContent = g.programa || "–";

  // 4.2) Si no existe `itinerario`, lo inicializo con un objeto
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(fecha => init[fecha] = []);
    await updateDoc(refG, { itinerario: init });
    g.itinerario = init;
  }

  // 4.3) Fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a) - new Date(b));

  // 4.4) Preparar quick-add
  qaDia.innerHTML = fechas
    .map((_,i)=> `<option value="${i}">Día ${i+1}</option>`).join('');
  fldFecha.innerHTML = fechas
    .map(d=> `<option value="${d}">${formatDateReadable(d)}</option>`).join('');

  // 4.5) Para cada fecha, construyo sección y lista
  fechas.forEach((fecha, idx) => {
    const titulo = `Día ${idx+1} – ${formatDateReadable(fecha)}`;
    const sec = document.createElement("section");
    sec.className       = "dia-seccion";
    sec.dataset.fecha   = fecha;
    sec.innerHTML       = `
      <h3>${titulo}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    // Botón dentro de la sección
    sec.querySelector(".btn-add")
       .onclick = () => openModal({ fecha }, false);

    // Renderizar actividades en UL
    const ul   = sec.querySelector(".activity-list");
    const arr  = g.itinerario[fecha] || [];
    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act, i) => {
        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio || "–"}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${act.pasajeros||0} pax</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // Editar
        li.querySelector(".btn-edit").onclick = () =>
          openModal({ ...act, fecha, idx:i }, true);
        // Borrar
        li.querySelector(".btn-del").onclick = async () => {
          if (!confirm("¿Eliminar actividad?")) return;
          arr.splice(i,1);
          await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
          renderItinerario();
        };
        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 5) quickAddActivity(): añadir sin modal
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId  = selectNum.value;
  const idx      = parseInt(qaDia.value,10);
  const fecha    = fldFecha.options[idx]?.value;
  const horaInicio = qaHoraInicio.value;
  const actividad  = qaAct.value.trim();
  if (!fecha || !actividad) {
    return alert("Selecciona día y escribe actividad");
  }
  const refG   = doc(db,'grupos',grupoId);
  const snapG  = await getDoc(refG);
  const g      = snapG.data();
  const arr    = g.itinerario[fecha] || [];
  arr.push({ horaInicio, horaFin:"", actividad, pasajeros:0, notas:"" });
  await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 6) openModal(): preparar modal para crear/editar
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent =
    isEdit ? "Editar actividad" : "Nueva actividad";
  fldFecha.value   = data.fecha;
  fldHi.value      = data.horaInicio || "";
  fldHf.value      = data.horaFin    || "";
  fldAct.value     = data.actividad  || "";
  fldPas.value     = data.pasajeros  || 0;
  fldNotas.value   = data.notas      || "";
  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 7) closeModal(): cerrar modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 8) onSubmitModal(): crear o actualizar
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value,
    pasajeros:  parseInt(fldPas.value,10)||0,
    notas:      fldNotas.value
  };
  const refG   = doc(db,'grupos',grupoId);
  const snapG  = await getDoc(refG);
  const g      = snapG.data();
  const arr    = g.itinerario[fecha] || [];

  if (editData) {
    // Reemplazo el índice
    arr[editData.idx] = payload;
  } else {
    arr.push(payload);
  }
  await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// 9) getDateRange(): ISO entre dos fechas
// —————————————————————————————————
function getDateRange(startStr, endStr) {
  const start = new Date(startStr);
  const end   = new Date(endStr);
  const out   = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

// —————————————————————————————————
// 10) formatDateReadable(): ISO → “Lunes DD/MM”
// —————————————————————————————————
function formatDateReadable(iso) {
  const d  = new Date(iso);
  const wd = d.toLocaleDateString("es-CL",{ weekday:"long" });
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}
