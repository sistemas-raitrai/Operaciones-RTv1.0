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
// 1) Referencias al DOM
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDias         = document.getElementById("qa-dias");        // contenedor de checkboxes
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

let editData = null; // { fecha, idx } si estamos editando

// —————————————————————————————————
// 2) Auth + arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 2.1) Cargo todos los grupos
  const snap   = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  // 2.2) Completo selects de grupo
  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 2.3) Sincronizo selects => render
  selectNum.onchange  = ()=>{ selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = ()=>{ selectNum.value = selectName.value; renderItinerario(); };

  // 2.4) Quick-Add y modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.5) Primera render
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): dibuja días + actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data() || {};

  // 3.1) Muestro programa
  titleGrupo.textContent = g.programa || "–";

  // 3.2) Inicializo itinerario si no existe
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(f => init[f] = []);
    await updateDoc(refG, { itinerario: init });
    g.itinerario = init;
  }

  // 3.3) Ordeno fechas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // 3.4) Genero checkboxes Quick-Add
  qaDias.innerHTML = fechas.map((f,i)=>`
    <label>
      <input type="checkbox" value="${i}" />
      Día ${i+1}
    </label>
  `).join("");

  // y opciones del modal
  fldFecha.innerHTML = fechas.map((d,i)=>
    `<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`
  ).join("");

  // 3.5) Construyo sección por día
  fechas.forEach((fecha,idx)=>{
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML     = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">
        + Añadir actividad
      </button>
    `;
    contItinerario.appendChild(sec);

    // botón para abrir modal
    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    // Pinto las actividades, **ordenadas** por horaInicio
    const ul  = sec.querySelector(".activity-list");
    const arr = (g.itinerario[fecha]||[])
      .slice()
      .sort((a,b)=> a.horaInicio.localeCompare(b.horaInicio));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act,i)=>{
        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${act.pasajeros} pax</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        li.querySelector(".btn-edit").onclick = ()=> {
          openModal({ ...act, fecha, idx:i }, true);
        };
        li.querySelector(".btn-del").onclick = async ()=> {
          if (!confirm("¿Eliminar actividad?")) return;
          // elimino y actualizo
          const orig = g.itinerario[fecha];
          orig.splice(i,1);
          await updateDoc(refG, { [`itinerario.${fecha}`]: orig });
          renderItinerario();
        };
        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 4) quickAddActivity(): añade la misma act en varios días
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const checks     = qaDias.querySelectorAll("input:checked");
  const indices    = Array.from(checks).map(c=>parseInt(c.value,10));
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim();
  if (!indices.length || !text) {
    return alert("Marca al menos un día y escribe la actividad.");
  }

  const refG  = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g     = snapG.data();
  const fechas= Object.keys(g.itinerario)
                      .sort((a,b)=>new Date(a)-new Date(b));

  for (let idx of indices) {
    const fecha = fechas[idx];
    const arr   = g.itinerario[fecha]||[];
    arr.push({
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  (g.adultos||0) + (g.estudiantes||0),
      adultos:    g.adultos||0,
      estudiantes:g.estudiantes||0,
      notas: ""
    });
    await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): preparar formulario
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  fldFecha.value       = data.fecha;
  fldHi.value          = data.horaInicio || "07:00";
  fldHf.value          = isEdit
    ? (data.horaFin || sumarUnaHora(fldHi.value))
    : sumarUnaHora(fldHi.value);
  fldAct.value         = data.actividad  || "";
  fldAdultos.value     = data.adultos    ?? ((data.pasajeros)||0);
  fldEstudiantes.value = data.estudiantes ?? 0;
  fldNotas.value       = data.notas      || "";

  // al cambiar inicio, ajusto fin +1h
  fldHi.onchange = ()=> fldHf.value = sumarUnaHora(fldHi.value);

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal(): cerrar
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guardar/editar
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10)||0;
  const e       = parseInt(fldEstudiantes.value,10)||0;
  const pax     = a + e;

  const refG  = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g     = snapG.data();
  const maxP  = (g.adultos||0)+(g.estudiantes||0);
  if (pax>maxP) {
    return alert(`Adultos+Estudiantes (${pax}) excede total de grupo (${maxP}).`);
  }

  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value
  };

  // si cambio de fecha al editar, mover de un día a otro
  const origArr = g.itinerario[data.fecha];
  if (editData && data.fecha !== fecha) {
    origArr.splice(editData.idx, 1);
    await updateDoc(refG, { [`itinerario.${data.fecha}`]: origArr });
  }

  // inserto en fecha nueva o misma
  const arr = g.itinerario[fecha]||[];
  if (editData && data.fecha===fecha) {
    arr[editData.idx] = payload;
  } else {
    arr.push(payload);
  }
  await updateDoc(refG, { [`itinerario.${fecha}`]: arr });

  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// UTILES
// —————————————————————————————————
function getDateRange(start,end) {
  const out = [], a=new Date(start), b=new Date(end);
  for (let d=new Date(a); d<=b; d.setDate(d.getDate()+1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}
function formatDateReadable(iso) {
  const d  = new Date(iso),
        wd = d.toLocaleDateString("es-CL",{weekday:"long"}),
        dd = String(d.getDate()).padStart(2,"0"),
        mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}
function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number),
        d     = new Date();
  d.setHours(h+1,m);
  return d.toTimeString().slice(0,5);
}
