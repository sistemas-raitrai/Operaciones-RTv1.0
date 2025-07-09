// itinerario.js
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection,
  getDocs,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// DOM elements
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia       = document.getElementById("qa-dia");
const qaHoraInicio= document.getElementById("qa-horaInicio");
const qaAct       = document.getElementById("qa-actividad");
const qaAddBtn    = document.getElementById("qa-add");

const modalBg     = document.getElementById("modal-backdrop");
const modal       = document.getElementById("modal");
const formModal   = document.getElementById("modal-form");
const fldFecha    = document.getElementById("m-fecha");
const fldHi       = document.getElementById("m-horaInicio");
const fldHf       = document.getElementById("m-horaFin");
const fldAct      = document.getElementById("m-actividad");
const fldPas      = document.getElementById("m-pasajeros");
const fldNotas    = document.getElementById("m-notas");
const btnCancel   = document.getElementById("modal-cancel");

let editData = null; // si estamos editando, guardamos aquí el docRef

// 1) Autenticación y arranque
onAuthStateChanged(auth, user => {
  if (!user) return location.href = "login.html";
  initItinerario();
});

async function initItinerario() {
  // 2) Cargamos todos los grupos de Firestore
  const snap = await getDocs(collection(db, "grupos"));
  const grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // 3) Poblar selectNum y selectName
  selectNum.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join("");
  selectName.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join("");
  // 4) Sincronizar ambos selects
  selectNum.onchange = () => {
    selectName.value = selectNum.value;
    renderItinerario();
  };
  selectName.onchange = () => {
    selectNum.value = selectName.value;
    renderItinerario();
  };
  // 5) Quick-add
  qaAddBtn.onclick = quickAddActivity;
  // 6) Modal cancel
  btnCancel.onclick = closeModal;
  formModal.onsubmit = onSubmitModal;
  // 7) Primer render
  selectNum.dispatchEvent(new Event("change"));
}

/**
 * 8) Render carrusel:
 *    - Lee el documento grupo seleccionado
 *    - Saca rango de fechas
 *    - Por cada día crea sección y carga actividades
 */
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  // 8.1) Leer datos del grupo
  const docG = await getDocs(query(collection(db, "grupos"), where("__name__", "==", grupoId)));
  const data = docG.docs[0].data();
  titleGrupo.textContent = data.programa || "–";
  // 8.2) Rango de fechas entre fechaInicio y fechaFin (formato ISO yyyy-mm-dd)
  const dias = getDateRange(data.fechaInicio, data.fechaFin);
  // 8.3) Poblar quick-add día select y modal fecha select
  qaDia.innerHTML = dias.map((_,i) => `<option value="${i}">Día ${i+1}</option>`).join("");
  fldFecha.innerHTML = dias.map(d => `<option value="${d}">${d}</option>`).join("");
  // 8.4) Crear sección por día
  for (let i = 0; i < dias.length; i++) {
    const fecha = dias[i];
    const title = `Día ${i+1} – ${formatDateReadable(fecha)}`;
    const sec = document.createElement("section");
    sec.className = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>${title}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = () =>
      openModal({ fecha }, false);
    await loadActivities(grupoId, fecha);
  }
}

/** Quick-add: crea nueva actividad con horaInicio y descripción */
async function quickAddActivity() {
  const grupoId = selectNum.value;
  const diaIndex = parseInt(qaDia.value, 10);
  const fecha = fldFecha.options[diaIndex].value;
  const actividad = qaAct.value.trim();
  if (!actividad) return alert("Escribe una actividad");
  await addDoc(collection(db, "actividades"), {
    numeroNegocio: grupoId,
    fecha,
    horaInicio: qaHoraInicio.value,
    horaFin: "",
    actividad,
    pasajeros: 0,
    notas: ""
  });
  qaAct.value = "";
  await loadActivities(grupoId, fecha);
}

/**
 * loadActivities:
 *   Lee de Firestore todas las actividades para un grupo+fecha
 *   y las pinta en el <ul> correspondiente
 */
async function loadActivities(grupoId, fecha) {
  const q = query(
    collection(db, "actividades"),
    where("numeroNegocio", "==", grupoId),
    where("fecha", "==", fecha),
    orderBy("horaInicio")
  );
  const snap = await getDocs(q);
  const ul = document.querySelector(`section[data-fecha="${fecha}"] .activity-list`);
  ul.innerHTML = "";
  if (snap.empty) {
    ul.innerHTML = `<li style="text-align:center; color:#666">— Sin actividades —</li>`;
    return;
  }
  snap.docs.forEach(docSnap => {
    const a = { id: docSnap.id, ...docSnap.data() };
    const li = document.createElement("li");
    li.className = "activity-card";
    li.innerHTML = `
      <h4>${a.horaInicio || "–"}</h4>
      <p><strong>${a.actividad}</strong></p>
      <p>👥 ${a.pasajeros || 0} pax</p>
      <div style="text-align:right">
        <button class="btn-edit">✏️</button>
        <button class="btn-del">🗑️</button>
      </div>`;
    // edit
    li.querySelector(".btn-edit").onclick = () => openModal(a, true);
    // delete
    li.querySelector(".btn-del").onclick = async () => {
      if (!confirm("¿Eliminar actividad?")) return;
      await deleteDoc(doc(db, "actividades", a.id));
      loadActivities(grupoId, fecha);
    };
    ul.appendChild(li);
  });
}

/** Abre modal para nueva o editar */
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent = isEdit ? "Editar actividad" : "Nueva actividad";
  fldFecha.value = data.fecha;
  fldHi.value = data.horaInicio || "";
  fldHf.value = data.horaFin || "";
  fldAct.value = data.actividad || "";
  fldPas.value = data.pasajeros || 0;
  fldNotas.value = data.notas || "";
  modalBg.style.display = modal.style.display = "block";
}

/** Cierra modal */
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

/** Form modal submit: guarda o actualiza */
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const payload = {
    numeroNegocio: grupoId,
    fecha: fldFecha.value,
    horaInicio: fldHi.value,
    horaFin: fldHf.value,
    actividad: fldAct.value,
    pasajeros: parseInt(fldPas.value, 10),
    notas: fldNotas.value
  };
  if (editData) {
    // update
    await updateDoc(doc(db, "actividades", editData.id), payload);
  } else {
    // nuevo
    await addDoc(collection(db, "actividades"), payload);
  }
  closeModal();
  await loadActivities(grupoId, payload.fecha);
}

/** Util: rango de fechas ISO entre dos "DD-MM-YYYY" o "YYYY-MM-DD" */
function getDateRange(startStr, endStr) {
  const start = new Date(startStr);
  const end   = new Date(endStr);
  const arr = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    arr.push(d.toISOString().slice(0,10));
  }
  return arr;
}

/** Util: formatea "YYYY-MM-DD" a "Lunes 01/02" */
function formatDateReadable(iso) {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("es-CL", { weekday:"long" });
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${weekday.charAt(0).toUpperCase()+weekday.slice(1)} ${dd}/${mm}`;
}
