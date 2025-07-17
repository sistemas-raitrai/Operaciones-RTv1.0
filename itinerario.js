// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs,
  doc, getDoc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias DOM + estado
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
const fldPax         = document.getElementById("m-pax");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let editData    = null;   // { fecha, idx } cuando editamos
let choicesDias = null;   // instancia global de Choices.js

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
    `<option value="${g.id}">${g.nombreGrupo.toUpperCase()}</option>`
  ).join('');

  // 2.3) Sincronizo selects y render inicial
  selectNum.onchange  = ()=>{ selectName.value=selectNum.value; renderItinerario(); };
  selectName.onchange = ()=>{ selectNum.value=selectName.value; renderItinerario(); };

  // 2.4) Quick-Add y Modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): crea grilla de días y pinta actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data() || {};

  // 3.1) Título (en mayúsculas)
  titleGrupo.textContent = (g.programa||"–").toUpperCase();

  // 3.2) Si no existe `itinerario`, lo inicializo como objeto de arrays
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(d=> init[d]=[]);
    await updateDoc(refG,{ itinerario:init });
    g.itinerario = init;
  }

  // 3.3) Array de fechas ISO, ordenado
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // 3.4) Choices.js para multi-select de días
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

  // 3.5) <select> de fechas para el modal (edición)
  fldFecha.innerHTML = fechas
    .map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`)
    .join('');

  // 3.6) Construyo una sección por cada día
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

    // botón interno para añadir
    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    // Pinto las actividades, ordenadas por horaInicio
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
          <p>👥 ${act.pasajeros} pax (A:${act.adultos} E:${act.estudiantes})</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // editar
        li.querySelector(".btn-edit").onclick = ()=> openModal({ ...act, fecha, idx:i }, true);
        // borrar
        li.querySelector(".btn-del").onclick = async ()=>{
          if(!confirm("¿Eliminar actividad?")) return;
          const orig = g.itinerario[fecha];
          // registro historial
          await addDoc(collection(db,'historial'), {
            numeroNegocio: grupoId,
            accion:        'BORRAR ACTIVIDAD',
            anterior:      orig.map(a=>a.actividad).join(' – '),
            nuevo:         '', 
            usuario:       auth.currentUser.email,
            timestamp:     new Date()
          });
          orig.splice(i,1);
          await updateDoc(refG,{ [`itinerario.${fecha}`]:orig });
          renderItinerario();
        };
        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 4) quickAddActivity(): crea una misma actividad en varios días
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = choicesDias.getValue(true); // ej. [0,2,4]
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim().toUpperCase();
  if (!selIdx.length || !text) {
    return alert("Selecciona día(s) y escribe la actividad");
  }

  const refG  = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g     = snapG.data()||{};
  const fechas= Object.keys(g.itinerario)
                      .sort((a,b)=>new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const f   = fechas[idx];
    const arr = g.itinerario[f]||[];
    // payload
    const item = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  (g.adultos||0)+(g.estudiantes||0),
      adultos:    g.adultos||0,
      estudiantes:g.estudiantes||0,
      notas:      ""
    };
    // historial CREAR
    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'CREAR ACTIVIDAD',
      anterior:      '',
      nuevo:         item.actividad,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });
    arr.push(item);
    await updateDoc(refG,{ [`itinerario.${f}`]:arr });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): precarga modal para crear o editar
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  fldFecha.value       = data.fecha;
  fldHi.value          = data.horaInicio  || "07:00";
  fldHf.value          = data.horaFin     || sumarUnaHora(fldHi.value);
  fldAct.value         = data.actividad   || "";
  fldAdultos.value     = data.adultos     ?? ((data.pasajeros)||0);
  fldEstudiantes.value = data.estudiantes ?? 0;
  fldPax.value         = data.pasajeros   ?? ((data.adultos||0)+(data.estudiantes||0));
  fldNotas.value       = data.notas       || "";

  // si cambian horaInicio, actualizamos horaFin = +1h
  fldHi.onchange = ()=> fldHf.value = sumarUnaHora(fldHi.value);

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal(): cierra el modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guarda o actualiza y registra historial
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10)||0;
  const e       = parseInt(fldEstudiantes.value,10)||0;
  const pax     = parseInt(fldPax.value,10)||0;

  // validación de pax
  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};
  const maxP  = (g.adultos||0)+(g.estudiantes||0);
  if (pax>maxP) {
    return alert(`Adultos+Estudiantes (${pax}) no puede exceder total de grupo (${maxP}).`);
  }

  // compongo payload
  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim().toUpperCase(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value.trim().toUpperCase()
  };

  const refG = doc(db,'grupos',grupoId);
  // array actual
  const arr = (g.itinerario?.[fecha]||[]).slice();

  if (editData) {
    // historial MODIFICAR: guardo lista anterior y nueva
    const antes = arr.map(x=>x.actividad).join(' – ');
    arr[editData.idx] = payload;
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
    // nunca debería llegar aquí: crear_ solo en quickAdd
    arr.push(payload);
    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'CREAR ACTIVIDAD',
      anterior:      '',
      nuevo:         payload.actividad,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });
  }

  // guardo en Firestore y recargo UI
  await updateDoc(refG,{ [`itinerario.${fecha}`]:arr });
  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Utilidades de fecha y hora
// —————————————————————————————————
function getDateRange(startStr,endStr) {
  const out=[];
  for(let d=new Date(startStr); d<=new Date(endStr); d.setDate(d.getDate()+1)){
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

// —————————————————————————————————
// 8) obtenerActividadesPorDestino(): busca sugerencias según destino
// —————————————————————————————————
async function obtenerActividadesPorDestino(destino) {
  if (!destino) return [];
  const ref = collection(db, "proveedores");
  const snap = await getDocs(ref);
  const actividades = [];
  snap.forEach(doc => {
    const data = doc.data();
    if (
      data.destino?.toUpperCase() === destino.toUpperCase() &&
      data.actividad
    ) {
      actividades.push(data.actividad.toUpperCase());
    }
  });
  return [...new Set(actividades)].sort();
}


