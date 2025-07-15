// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase + Choices.js
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs,
  doc, getDoc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import Choices from 'https://cdn.jsdelivr.net/npm/choices.js/public/assets/scripts/choices.min.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias al DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");   // N° negocio
const selectName     = document.getElementById("grupo-select-name");  // nombre de grupo
const titleGrupo     = document.getElementById("grupo-title");        // programa X/Y
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");             // select multiple Days
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
const fldAdultos     = document.getElementById("m-adultos");
const fldEstudiantes = document.getElementById("m-estudiantes");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let editData    = null;   // { fecha, idx } cuando editamos
let choicesDias = null;   // instancia de Choices.js para multi-select de días

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 2.1) Cargo todos los grupos y completo selects
  const snap   = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 2.2) Sincronizo selects y disparo primer render
  selectNum.onchange  = ()=>{ selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = ()=>{ selectNum.value = selectName.value; renderItinerario(); };

  // 2.3) Quick-Add y modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.4) Primera carga de datos
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): dibuja carrusel de días y actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data() || {};

  // 3.1) Título (PROGRAMA en mayúsculas)
  titleGrupo.textContent = (g.programa || "–").toUpperCase();

  // 3.2) Si no existe itinerario, inicializo con fechas vacías
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(f=> init[f]=[]);
    await updateDoc(refG,{ itinerario: init });
    g.itinerario = init;
  }

  // 3.3) Array de fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a) - new Date(b));

  // 3.4) Configuro o refresco Choices.js para el <select multiple>
  const opts = fechas.map((_,i)=>({ value:i, label:`Día ${i+1} – ${formatDateReadable(fechas[i])}` }));
  if (choicesDias) {
    choicesDias.clearChoices();
    choicesDias.setChoices(opts,'value','label',false);
  } else {
    choicesDias = new Choices(qaDia, {
      removeItemButton: true,
      placeholderValue: 'Selecciona día(s)',
      choices: opts
    });
  }

  // 3.5) Pueblar <select> del modal (solo single select)
  fldFecha.innerHTML = fechas
    .map(f => `<option value="${f}">${`Día ${fechas.indexOf(f)+1} – ${formatDateReadable(f)}`}</option>`)
    .join('');

  // 3.6) Construir la grilla: un <section> por fecha
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML     = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    // Botón interno: abre modal en modo "nuevo"
    sec.querySelector(".btn-add")
       .onclick = () => openModal({ fecha }, false);

    // Pinto las tarjetas de actividad, **ordenadas por horaInicio**
    const ul  = sec.querySelector(".activity-list");
    const arr = (g.itinerario[fecha]||[]).slice()
      .sort((a,b)=> a.horaInicio.localeCompare(b.horaInicio));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act, i) => {
        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio} – ${act.horaFin}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${act.pasajeros} pax</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // EDITAR: abre modal con datos + multi-choice de días
        li.querySelector(".btn-edit").onclick = () =>
          openModal({ ...act, fecha, idx:i }, true);

        // BORRAR
        li.querySelector(".btn-del").onclick = async () => {
          if (!confirm("¿Eliminar actividad?")) return;
          const orig = g.itinerario[fecha];
          orig.splice(i,1);
          await updateDoc(refG,{ [`itinerario.${fecha}`]: orig });
          renderItinerario();
        };

        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 4) quickAddActivity(): añade misma act. en N días
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = choicesDias.getValue(true); // [0,2,4...]
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim().toUpperCase();
  if (!selIdx.length || !text) {
    return alert("Selecciona al menos un día y escribe la actividad");
  }

  const refG  = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g     = snapG.data();
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // Inserto en cada fecha seleccionada
  for (let i of selIdx) {
    const f   = fechas[i];
    const arr = g.itinerario[f]||[];
    arr.push({
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  (g.adultos||0)+(g.estudiantes||0),
      adultos:    g.adultos||0,
      estudiantes:g.estudiantes||0,
      notas:      ""
    });
    await updateDoc(refG,{ [`itinerario.${f}`]:arr });
    // Aquí podrías también agregar la entrada a 'historial'
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): preparar modal (crear o editar)
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  // Título
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  // Relleno campos, forzando UPPERCASE donde aplique
  fldFecha.value       = data.fecha;
  fldHi.value          = data.horaInicio || "07:00";
  fldHf.value          = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value         = (data.actividad||"").toUpperCase();
  fldAdultos.value     = data.adultos    ?? (data.pasajeros||0);
  fldEstudiantes.value = data.estudiantes?? 0;
  fldNotas.value       = (data.notas||"").toUpperCase();

  // Si cambias horaInicio, ajusta horaFin automáticamente
  fldHi.onchange = ()=> { fldHf.value = sumarUnaHora(fldHi.value); };

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal(): cerrar modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guardar o actualizar
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10)||0;
  const e       = parseInt(fldEstudiantes.value,10)||0;
  const pax     = a + e;

  // Validar no exceder total del grupo
  const refG  = doc(db,'grupos',grupoId);
  const g     = (await getDoc(refG)).data()||{};
  const maxP  = (g.adultos||0)+(g.estudiantes||0);
  if (pax > maxP) {
    return alert(`Adultos+Estudiantes (${pax}) no pueden exceder total del grupo (${maxP}).`);
  }

  // Preparo payload (todo UPPERCASE)
  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim().toUpperCase(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value.trim().toUpperCase()
  };

  // Inserto o actualizo en el arreglo de esa fecha
  const arr = g.itinerario[fecha]||[];
  if (editData) {
    arr[editData.idx] = payload;
  } else {
    arr.push(payload);
  }
  await updateDoc(refG,{ [`itinerario.${fecha}`]:arr });

  // Aquí puedes añadir la entrada a la colección 'historial'

  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Utilidades: fechas y formatos
// —————————————————————————————————
function getDateRange(startStr, endStr) {
  const out = [];
  for (let d=new Date(startStr); d<=new Date(endStr); d.setDate(d.getDate()+1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

function formatDateReadable(iso) {
  const d  = new Date(iso);
  const wd = d.toLocaleDateString("es-CL",{weekday:"long"});
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}

function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d     = new Date(); d.setHours(h+1,m);
  return d.toTimeString().slice(0,5);
}
