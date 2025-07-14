// itinerario.js

// —————————————————————————————————
// 0) Importes Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { collection, getDocs, doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias DOM
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

let editData = null; // para saber si estamos editando

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 1) Cargar todos los grupos
  const snap = await getDocs(collection(db, 'grupos'));
  const grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2) Poblar selects de nombre y número
  selectNum.innerHTML  = grupos.map(g =>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 3) Sincronizar ambos selects
  selectNum.onchange  = () => { selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = () => { selectNum.value = selectName.value; renderItinerario(); };

  // 4) Quick-add y modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 5) Primera render
  selectNum.dispatchEvent(new Event('change'));
}

  // 2.3) Quick-add y modal
  qaAddBtn.onclick    = quickAddActivity;
  btnCancel.onclick   = closeModal;
  formModal.onsubmit  = onSubmitModal;

  // 2.4) Primera carga
  selectNum.dispatchEvent(new Event("change"));

// —————————————————————————————————
// 3) Renderizar todo el itinerario desde `grupos/{id}.itinerario`
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const refG = doc(db,'grupos',grupoId);
  const snap = await getDoc(refG);
  const g    = snap.data() || {};

  titleGrupo.textContent = g.programa || "–";

  // si no existe el campo itinerario, lo inicializo según rango de fechas
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init = {};
    rango.forEach(f => init[f] = []);
    await updateDoc(refG, { itinerario: init });
    g.itinerario = init;
  }

  // obtengo las fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a) - new Date(b));

  // Quick-add: montar opciones de día y fecha
  qaDia.innerHTML = fechas
    .map((_,i)=> `<option value="${i}">Día ${i+1}</option>`).join("");
  fldFecha.innerHTML = fechas
    .map(d=> `<option value="${d}">${d}</option>`).join("");

  // para cada fecha, crear sección y listar actividades
  fechas.forEach((fecha,idx) => {
    const titulo = `Día ${idx+1} – ${formatDateReadable(fecha)}`;
    const sec = document.createElement("section");
    sec.className = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>${titulo}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    // botón interno para abrir modal
    sec.querySelector(".btn-add")
       .onclick = () => openModal({ fecha }, false);

    // renderizar actividades guardadas
    const ul = sec.querySelector(".activity-list");
    const acts = g.itinerario[fecha] || [];
    if (!acts.length) {
      ul.innerHTML = `<li style="text-align:center;color:#666">— Sin actividades —</li>`;
    } else {
      acts.forEach((a,i) => {
        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${a.horaInicio || "–"}</h4>
          <p><strong>${a.actividad}</strong></p>
          <p>👥 ${a.pasajeros||0} pax</p>
          <div style="text-align:right">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // editar
        li.querySelector(".btn-edit").onclick = () => openModal({ ...a, fecha, idx:i }, true);
        // borrar
        li.querySelector(".btn-del").onclick = async () => {
          if (!confirm("¿Eliminar actividad?")) return;
          const arr = g.itinerario[fecha];
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
// 4) Quick-add: añade sin modal
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId  = selectNum.value;
  const diaIndex = +qaDia.value;
  const fecha    = fldFecha.options[diaIndex]?.value;
  const horaInicio = qaHoraInicio.value;
  const actividad  = qaAct.value.trim();
  if (!fecha || !actividad) {
    return alert("Selecciona día y escribe actividad");
  }
  const refG = doc(db,'grupos',grupoId);
  const snap = await getDoc(refG);
  const g    = snap.data();
  const arr  = g.itinerario[fecha] || [];
  arr.push({ horaInicio, horaFin:"", actividad, pasajeros:0, notas:"" });
  await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) Modal: abrir para nueva/editar
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent =
    isEdit ? "Editar actividad" : "Nueva actividad";
  fldFecha.value     = data.fecha;
  fldHi.value        = data.horaInicio || "";
  fldHf.value        = data.horaFin    || "";
  fldAct.value       = data.actividad  || "";
  fldPas.value       = data.pasajeros  || 0;
  fldNotas.value     = data.notas      || "";
  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) Cerrar modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) Submit modal: crea o actualiza
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
  const refG = doc(db,'grupos',grupoId);
  const snap = await getDoc(refG);
  const g    = snap.data();

  const arr = g.itinerario[fecha] || [];
  if (editData) {
    // editar
    arr[editData.idx] = payload;
  } else {
    // nuevo
    arr.push(payload);
  }
  await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Util: rango de fechas ISO
// —————————————————————————————————
function getDateRange(startStr, endStr) {
  const start = new Date(startStr);
  const end   = new Date(endStr);
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

// —————————————————————————————————
// Util: ISO → “Lunes DD/MM”
// —————————————————————————————————
function formatDateReadable(iso) {
  const d = new Date(iso);
  const wd = d.toLocaleDateString("es-CL",{weekday:"long"});
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}
