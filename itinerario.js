// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs,
  doc, getDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias al DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");           // <select multiple>
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

let editData    = null;   // { fecha, idx } para edición
let choicesDias = null;   // instancia de Choices.js

// —————————————————————————————————
// 2) Auth + arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 2.1) Cargo grupos
  const snap   = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 2.2) Sincronizo selects
  selectNum.onchange  = ()=>{ selectName.value=selectNum.value; renderItinerario() };
  selectName.onchange = ()=>{ selectNum.value=selectName.value; renderItinerario() };

  // 2.3) Quick-Add y modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.4) Primer render
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): dibuja días y actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};

  // 3.1) Título (mayúsculas)
  titleGrupo.textContent = (g.programa||"–").toUpperCase();

  // 3.2) Inicializo itinerario si no existe
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(d=> init[d]=[]);
    await updateDoc(doc(db,'grupos',grupoId),{ itinerario:init });
    g.itinerario = init;
  }

  // 3.3) Fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // 3.4) Configuro/actualizo Choices.js
  const opts = fechas.map((d,i)=>({
    value: i,
    label: `Día ${i+1} – ${formatDateReadable(d)}`
  }));
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

  // 3.5) Pueblar <select> del modal
  fldFecha.innerHTML = fechas
    .map(d=>`<option value="${d}">Día ${fechas.indexOf(d)+1} – ${formatDateReadable(d)}</option>`)
    .join('');

  // 3.6) Construyo grilla de secciones
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

    // botón interno → modal nuevo
    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    // Pinto actividades ordenadas
    const ul  = sec.querySelector(".activity-list");
    const arr = (g.itinerario[fecha]||[]).slice()
      .sort((a,b)=> a.horaInicio.localeCompare(b.horaInicio));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act,i)=>{
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
        // editar
        li.querySelector(".btn-edit").onclick = ()=> openModal({ ...act, fecha, idx:i }, true);
        // borrar
        li.querySelector(".btn-del").onclick = async ()=>{
          if(!confirm("¿Eliminar actividad?"))return;
          const orig = g.itinerario[fecha];
          orig.splice(i,1);
          await updateDoc(doc(db,'grupos',grupoId),{ [`itinerario.${fecha}`]:orig });
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
  const selIdx     = choicesDias.getValue(true); // [0,2,...]
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim().toUpperCase();
  if (!selIdx.length||!text) {
    return alert("Selecciona día(s) y escribe actividad");
  }

  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};
  const fechas  = Object.keys(g.itinerario).sort((a,b)=>new Date(a)-new Date(b));

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
    await updateDoc(doc(db,'grupos',grupoId),{ [`itinerario.${f}`]:arr });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): crear o editar
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  fldFecha.value       = data.fecha;
  fldHi.value          = data.horaInicio||"07:00";
  fldHf.value          = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value         = (data.actividad||"").toUpperCase();
  fldAdultos.value     = data.adultos    ?? (data.pasajeros||0);
  fldEstudiantes.value = data.estudiantes??0;
  fldNotas.value       = (data.notas||"").toUpperCase();

  fldHi.onchange = ()=> fldHf.value = sumarUnaHora(fldHi.value);

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal()
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guarda o actualiza
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10)||0;
  const e       = parseInt(fldEstudiantes.value,10)||0;
  const pax     = a+e;

  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};
  const maxP  = (g.adultos||0)+(g.estudiantes||0);
  if (pax>maxP) {
    return alert(`Adultos+Estudiantes (${pax}) excede total del grupo (${maxP}).`);
  }

  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim().toUpperCase(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value.trim().toUpperCase()
  };

  const arr = g.itinerario[fecha]||[];
  if (editData) arr[editData.idx] = payload;
  else          arr.push(payload);

  await updateDoc(doc(db,'grupos',grupoId),{ [`itinerario.${fecha}`]:arr });

  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Utilidades: fechas y sumas
// —————————————————————————————————
function getDateRange(startStr,endStr) {
  const out=[];
  for(let d=new Date(startStr);d<=new Date(endStr);d.setDate(d.getDate()+1))
    out.push(d.toISOString().slice(0,10));
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
