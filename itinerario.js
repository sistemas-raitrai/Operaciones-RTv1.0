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

const qaDia          = document.getElementById("qa-dia");
const qaHoraInicio   = document.getElementById("qa-horaInicio");
const qaAct          = document.getElementById("qa-actividad");
const qaAddBtn       = document.getElementById("qa-add");

const btnGuardarTpl  = document.getElementById("btnGuardarTpl");
const btnCargarTpl   = document.getElementById("btnCargarTpl");
const selPlantillas  = document.getElementById("sel-plantillas");

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

let editData    = null;   // { fecha, idx }
let choicesDias = null;   // Choices.js instance

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
    `<option value="${g.id}">${g.nombreGrupo.toUpperCase()}</option>`
  ).join('');

  // 2.3) Sincronizo selects y render inicial
  selectNum.onchange  = ()=>{ selectName.value=selectNum.value; renderItinerario(); };
  selectName.onchange = ()=>{ selectNum.value=selectName.value; renderItinerario(); };

  // 2.4) Quick-Add, Modal y Plantillas
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;
  btnGuardarTpl.onclick = guardarPlantilla;
  btnCargarTpl.onclick  = cargarPlantilla;
  await cargarListaPlantillas();

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): crea grilla y pinta actividades
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

  // Fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // Choices.js multi-select
  const opts = fechas.map((d,i)=>({
    value: i, label: `Día ${i+1} – ${formatDateReadable(d)}`
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

  // Select para modal
  fldFecha.innerHTML = fechas
    .map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`)
    .join('');

  // Pinto cada día
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    if (new Date(fecha).getDay()===0) sec.classList.add('domingo');

    sec.innerHTML = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    const ul  = sec.querySelector(".activity-list");
    const arr = (g.itinerario[fecha]||[]).slice()
      .sort((a,b)=> a.horaInicio.localeCompare(b.horaInicio));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act,i)=>{
        const li = document.createElement("li");
        li.className = "activity-card";
        const paxCalc = (parseInt(act.adultos, 10) || 0) + (parseInt(act.estudiantes, 10) || 0);
    
        li.innerHTML = `
          <h4>${act.horaInicio} – ${act.horaFin}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${paxCalc} pax (A:${act.adultos} E:${act.estudiantes})</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        li.querySelector(".btn-edit")
          .onclick = ()=> openModal({ ...act, fecha, idx:i }, true);
        li.querySelector(".btn-del")
          .onclick = async ()=>{
            if (!confirm("¿Eliminar actividad?")) return;
            await addDoc(collection(db,'historial'), {
              numeroNegocio: grupoId,
              accion:        'BORRAR ACTIVIDAD',
              anterior:      (g.itinerario[fecha]||[]).map(a=>a.actividad).join(' – '),
              nuevo:         '',
              usuario:       auth.currentUser.email,
              timestamp:     new Date()
            });
            g.itinerario[fecha].splice(i,1);
            await updateDoc(doc(db,'grupos',grupoId), {
              [`itinerario.${fecha}`]: g.itinerario[fecha]
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
  const selIdx     = choicesDias.getValue(true);
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim().toUpperCase();
  if (!selIdx.length || !text) {
    return alert("Selecciona día(s) y escribe la actividad");
  }

  // –– Parséo numérico de pax del grupo:
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};
  const totalAdults   = parseInt(g.adultos, 10)     || 0;
  const totalStudents = parseInt(g.estudiantes, 10) || 0;

  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const f   = fechas[idx];
    const arr = g.itinerario[f]||[];

    const item = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  totalAdults + totalStudents,  // ahora suma numérica
      adultos:    totalAdults,
      estudiantes:totalStudents,
      notas:      ""
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
    await updateDoc(doc(db,'grupos',grupoId), {
      [`itinerario.${f}`]: arr
    });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): precarga datos en el modal
// —————————————————————————————————
async function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  const snapG = await getDoc(doc(db,"grupos",selectNum.value));
  const g     = snapG.data()||{};
  // —– Parséo numérico de totales:
  const totalAdults   = parseInt(g.adultos, 10)     || 0;
  const totalStudents = parseInt(g.estudiantes, 10) || 0;

  fldFecha.value    = data.fecha;
  fldHi.value       = data.horaInicio || "07:00";
  fldHf.value       = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value      = data.actividad  || "";
  await prepararCampoActividad("m-actividad", g.destino);
  fldNotas.value    = data.notas      || "";

  if (isEdit) {
    fldAdultos.value     = data.adultos     ?? totalAdults;
    fldEstudiantes.value = data.estudiantes ?? totalStudents;
  } else {
    fldAdultos.value     = totalAdults;
    fldEstudiantes.value = totalStudents;
  }
  actualizarPax();

  fldHi.onchange = () => {
    fldHf.value = sumarUnaHora(fldHi.value);
  };

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
  const a       = parseInt(fldAdultos.value,10) || 0;
  const e       = parseInt(fldEstudiantes.value,10) || 0;
  const pax     = parseInt(fldPax.value,10)       || 0;

  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};
  // valida maxP con parseInt
  const maxP  = (parseInt(g.adultos,10)||0) + (parseInt(g.estudiantes,10)||0);
  if (pax > maxP) {
    return alert(`Adultos+Estudiantes (${pax}) no puede exceder total de grupo (${maxP}).`);
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

  const arr = (g.itinerario?.[fecha]||[]).slice();

  if (editData) {
    const antes   = arr.map(x=>x.actividad).join(' – ');
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

  await updateDoc(doc(db,'grupos',grupoId), {
    [`itinerario.${fecha}`]: arr
  });
  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Utilidades de fecha y hora
// —————————————————————————————————
function getDateRange(startStr, endStr) {
  const out = [];
  const start = new Date(startStr + "T00:00:00");
  const end   = new Date(endStr   + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth()+1).padStart(2,'0');
    const dd   = String(d.getDate()).padStart(2,'0');
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}
function formatDateReadable(isoStr) {
  const [yyyy,mm,dd] = isoStr.split('-').map(Number);
  const d  = new Date(yyyy, mm-1, dd);
  const wd = d.toLocaleDateString("es-CL", { weekday:"long" });
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd.toString().padStart(2,'0')}/${mm.toString().padStart(2,'0')}`;
}
function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h+1, m);
  return d.toTimeString().slice(0,5);
}

// —————————————————————————————————
// Plantillas: guardar y cargar
// —————————————————————————————————
async function guardarPlantilla() {
  const nombre = prompt("Nombre de la plantilla:");
  if (!nombre) return;
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};
  const datosParaPlantilla = {};
  for (const fecha in g.itinerario) {
    datosParaPlantilla[fecha] = g.itinerario[fecha].map(act=>({
      horaInicio: act.horaInicio,
      horaFin:    act.horaFin,
      actividad:  act.actividad,
      notas:      act.notas
    }));
  }
  await addDoc(collection(db,'plantillasItinerario'), {
    nombre,
    creador:   auth.currentUser.email,
    createdAt: new Date(),
    datos:     datosParaPlantilla
  });
  alert("Plantilla guardada");
  await cargarListaPlantillas();
}

async function cargarListaPlantillas() {
  selPlantillas.innerHTML = "";
  const snap = await getDocs(collection(db,'plantillasItinerario'));
  snap.docs.forEach(d => {
    const data = d.data();
    const opt  = document.createElement("option");
    opt.value  = d.id;
    opt.textContent = data.nombre;
    selPlantillas.appendChild(opt);
  });
}

async function cargarPlantilla() {
  // … lógica existente …
}

// —————————————————————————————————
// Autocomplete de actividades
// —————————————————————————————————
async function obtenerActividadesPorDestino(destino) {
  // … lógica existente …
}
async function prepararCampoActividad(inputId,destino){
  // … lógica existente …
}

// —————————————————————————————————
// Calendario modal
// —————————————————————————————————
document.getElementById("btnAbrirCalendario")
  .addEventListener("click", ()=>{
    // … lógica existente …
});
window.cerrarCalendario = () => {
  // … lógica existente …
};
