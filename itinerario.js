// itinerario.js

// Importes de Firebase
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// 0) Instancia de Auth
const auth = getAuth(app);

// ————————————————————————————————————————————————————————————
// Elementos del DOM
// ————————————————————————————————————————————————————————————
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

// Guarda la actividad que se está editando (si hay)
let editData = null;

// ————————————————————————————————————————————————————————————
// 1) Espera autenticación y arranca
// ————————————————————————————————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    // Redirige a login si no hay usuario
    location.href = "login.html";
  } else {
    // Si está logueado, inicializa
    initItinerario();
  }
});

// ————————————————————————————————————————————————————————————
// 2) Inicialización general
// ————————————————————————————————————————————————————————————
async function initItinerario() {
  // 2.1) Cargar todos los grupos de Firestore
  const snap = await getDocs(collection(db, "grupos"));
  const grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2.2) Poblar selects de número y nombre de grupo
  selectNum.innerHTML  = grupos.map(g =>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join("");
  selectName.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join("");

  // 2.3) Sincronizar ambos selects
  selectNum.onchange  = () => {
    selectName.value = selectNum.value;
    renderItinerario();
  };
  selectName.onchange = () => {
    selectNum.value = selectName.value;
    renderItinerario();
  };

  // 2.4) Quick-add botón
  qaAddBtn.onclick = quickAddActivity;

  // 2.5) Modal: cancelar y submit
  btnCancel.onclick    = closeModal;
  formModal.onsubmit   = onSubmitModal;

  // 2.6) Dispara el primer render
  selectNum.dispatchEvent(new Event("change"));
}

// ————————————————————————————————————————————————————————————
// 3) Render del carrusel de días y actividades
// ————————————————————————————————————————————————————————————
async function renderItinerario() {
  // Limpio contenedor
  contItinerario.innerHTML = "";

  const grupoId = selectNum.value;
  // 3.1) Leo datos del grupo
  const docG = await getDocs(query(collection(db, "grupos"), where("__name__", "==", grupoId)));
  const data = docG.docs[0]?.data() || {};
  titleGrupo.textContent = data.programa || "–";

  // 3.2) Genero rango de fechas ISO
  const dias = getDateRange(data.fechaInicio, data.fechaFin);

  // 3.3) Poblar quick-add y modal fecha
  qaDia.innerHTML = dias.map((_,i) => `<option value="${i}">Día ${i+1}</option>`).join("");
  fldFecha.innerHTML = dias.map(d => `<option value="${d}">${d}</option>`).join("");

  // 3.4) Para cada día, creo sección y cargo actividades
  for (let i = 0; i < dias.length; i++) {
    const fecha = dias[i];
    const titulo = `Día ${i+1} – ${formatDateReadable(fecha)}`;
    const sec = document.createElement("section");
    sec.className = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>${titulo}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    // Botón interno de añadir
    sec.querySelector(".btn-add").onclick = () => openModal({ fecha }, false);
    // Cargo actividades de ese día
    await loadActivities(grupoId, fecha);
  }
}

// ————————————————————————————————————————————————————————————
// 4) Quick-add: crear actividad rápida
// ————————————————————————————————————————————————————————————
async function quickAddActivity() {
  try {
    console.log("▶️ quickAddActivity iniciada");

    const grupoId    = selectNum.value;
    const diaIndex   = parseInt(qaDia.value, 10);
    const fechaOpt   = fldFecha.options[diaIndex];
    console.log("   • selectNum:", grupoId);
    console.log("   • qaDia.value (índice):", diaIndex);
    console.log("   • fldFecha.options.length:", fldFecha.options.length);
    console.log("   • opción seleccionada de fldFecha:", fechaOpt);

    if (!fechaOpt) {
      console.error("❌ No existe opción en fldFecha para el índice", diaIndex);
      return alert("Error interno: día no válido");
    }
    const fecha      = fechaOpt.value;
    const horaInicio = qaHoraInicio.value;
    const actividad  = qaAct.value.trim();

    console.log("   • fecha:", fecha);
    console.log("   • horaInicio:", horaInicio);
    console.log("   • actividad:", actividad);

    if (!actividad) {
      console.warn("⚠️ quickAddActivity: falta el nombre de actividad");
      return alert("Escribe una actividad");
    }

    // Insert en Firestore
    console.log("   • Agregando a Firestore...");
    await addDoc(collection(db, "actividades"), {
      numeroNegocio: grupoId,
      fecha,
      horaInicio,
      horaFin: "",
      actividad,
      pasajeros: 0,
      notas: ""
    });
    console.log("   ✔️ Documento creado");

    // Limpio input y recargo lista del día
    qaAct.value = "";
    await loadActivities(grupoId, fecha);
    console.log("▶️ quickAddActivity completada");
  } catch (e) {
    console.error("❌ quickAddActivity error:", e);
    alert("Ocurrió un error al agregar la actividad, mira la consola");
  }
}

// ————————————————————————————————————————————————————————————
// 5) loadActivities: lee y pinta actividades de un día
// ————————————————————————————————————————————————————————————
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
    ul.innerHTML = `<li style="text-align:center;color:#666">— Sin actividades —</li>`;
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
    // editar
    li.querySelector(".btn-edit").onclick = () => openModal(a, true);
    // borrar
    li.querySelector(".btn-del").onclick = async () => {
      if (!confirm("¿Eliminar actividad?")) return;
      await deleteDoc(doc(db, "actividades", a.id));
      loadActivities(grupoId, fecha);
    };
    ul.appendChild(li);
  });
}

// ————————————————————————————————————————————————————————————
// 6) openModal: abre el formulario para nueva/editar
// ————————————————————————————————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent = isEdit ? "Editar actividad" : "Nueva actividad";
  fldFecha.value = data.fecha;
  fldHi.value    = data.horaInicio || "";
  fldHf.value    = data.horaFin    || "";
  fldAct.value   = data.actividad  || "";
  fldPas.value   = data.pasajeros  || 0;
  fldNotas.value = data.notas      || "";
  modalBg.style.display = modal.style.display = "block";
}

// ————————————————————————————————————————————————————————————
// 7) closeModal: cierra el modal
// ————————————————————————————————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// ————————————————————————————————————————————————————————————
// 8) onSubmitModal: guarda o actualiza al enviar el formulario
// ————————————————————————————————————————————————————————————
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
    // actualizar
    await updateDoc(doc(db, "actividades", editData.id), payload);
  } else {
    // crear nuevo
    await addDoc(collection(db, "actividades"), payload);
  }
  closeModal();
  await loadActivities(grupoId, payload.fecha);
}

// ————————————————————————————————————————————————————————————
// 9) util: genera array ISO de fechas entre dos fechas
// ————————————————————————————————————————————————————————————
function getDateRange(startStr, endStr) {
  const start = new Date(startStr);
  const end   = new Date(endStr);
  const arr = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    arr.push(d.toISOString().slice(0,10));
  }
  return arr;
}

// ————————————————————————————————————————————————————————————
// 10) util: convierte ISO a "Lunes DD/MM"
// ————————————————————————————————————————————————————————————
function formatDateReadable(iso) {
  const d = new Date(iso);
  const wd = d.toLocaleDateString("es-CL", { weekday:"long" });
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}
