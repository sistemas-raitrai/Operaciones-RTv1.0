// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

console.log("▶️ itinerario.js cargado");

// 1) URLs de datos
//    - OPENSHEET: tu hoja pública como JSON (solo lectura masiva)
//    - GAS_URL:   tu WebApp de Apps Script para CRUD de actividades
const OPENSHEET = "https://opensheet.elk.sh/124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI/LecturaBaseOperaciones";
const GAS_URL   = "https://script.google.com/macros/s/AKfycbwkyIMHb_bzAzMWoO3Yte2a6aFtVDguFGsiL0aaG6Tupn8B807oovR34S0YbR9I9mz0/exec";

// 2) Elementos principales del DOM
const selectNum     = document.getElementById("grupo-select-num");   // selector por código
const selectName    = document.getElementById("grupo-select-name");  // selector por nombre
const titleGrupo    = document.getElementById("grupo-title");       
const contItinerario= document.getElementById("itinerario-container");

// 3) Elementos del modal de actividad
const modalBg   = document.getElementById("modal-backdrop");
const modal     = document.getElementById("modal");
const formModal = document.getElementById("modal-form");
const fldFecha  = document.getElementById("m-fecha");
const fldHi     = document.getElementById("m-horaInicio");
const fldHf     = document.getElementById("m-horaFin");
const fldAct    = document.getElementById("m-actividad");
const fldPas    = document.getElementById("m-pasajeros");
const fldNotas  = document.getElementById("m-notas");
let editData    = null;  // guarda la actividad en edición

// 4) Al cargar el DOM, comprobamos sesión y arrancamos
document.addEventListener("DOMContentLoaded", () => {
  console.log("▶️ DOM listo");
  onAuthStateChanged(auth, user => {
    console.log("▶️ Usuario:", user?.email);
    if (!user) {
      console.warn("⚠️ Sin sesión, redirigiendo a login");
      return location.href = "login.html";
    }
    init();
  });
});

async function init() {
  console.log("▶️ init()");
  // 5.1) Traer todos los registros de la hoja
  const datos = await (await fetch(OPENSHEET)).json();

  // 5.2) Extraer pares únicos {numeroNegocio, nombreGrupo}
  const mapa = new Map();
  datos.forEach(r => {
    if (r.numeroNegocio && r.nombreGrupo && !mapa.has(r.numeroNegocio)) {
      mapa.set(r.numeroNegocio, r.nombreGrupo);
    }
  });
  const grupos = Array.from(mapa.entries());
  // → [ ["1511","ALTAMIRA 2B"], ["1373","LINCOLN COLL."], … ]

  // 5.3) Poblar ambos <select>
  selectNum.innerHTML = grupos
    .map(([num])    => `<option value="${num}">${num}</option>`)
    .join("");
  selectName.innerHTML = grupos
    .map(([num,n]) => `<option value="${num}">${n}</option>`)
    .join("");

  // 5.4) Listeners “espejo”
  selectNum.onchange = () => {
    selectName.value = selectNum.value;
    renderItinerario();
  };
  selectName.onchange = () => {
    selectNum.value = selectName.value;
    renderItinerario();
  };

  // 5.5) Primer render
  await renderItinerario();
}

/**
 * 6) parseDdMmYyyy(s)
 *    Convierte string "DD-MM-YYYY" → Date
 */
function parseDdMmYyyy(s) {
  const [d, m, y] = s.split("-").map(n => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

// 7) getRangoFechas(grupo)
//    Calcula array de fechas entre fechaInicio y fechaFin
async function getRangoFechas(grupo) {
  console.log("▶️ getRangoFechas", grupo);
  const datos = await (await fetch(OPENSHEET)).json();
  const fila  = datos.find(r => r.numeroNegocio === grupo);
  if (!fila) throw new Error(`No encontré datos para ${grupo}`);
  const inicio = parseDdMmYyyy(fila.fechaInicio);
  const fin    = parseDdMmYyyy(fila.fechaFin);
  const dias = [];
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
    dias.push(d.toISOString().slice(0, 10));
  }
  return dias;
}

// 8) renderItinerario()
//    Dibuja carrusel de días y carga sus actividades
async function renderItinerario() {
  const grupo  = selectNum.value;
  const nombre = selectName.options[selectName.selectedIndex].text;
  console.log("▶️ renderItinerario", grupo, nombre);

  // 8.1) Actualizo título
  titleGrupo.textContent = fila.programa;

  // 8.2) Limpio y obtengo rango de fechas
  contItinerario.innerHTML = "";
  const fechas = await getRangoFechas(grupo);

  // 8.3) Llenar select de fecha en el modal
  fldFecha.innerHTML = fechas
    .map(f => `<option value="${f}">${f}</option>`)
    .join("");

  // 8.4) Por cada fecha, crear tarjeta y cargar actividades
  for (const fecha of fechas) {
    const sec = document.createElement("section");
    sec.className = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>${fecha}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = () => openModal({ fecha }, false);
    await loadActivities(grupo, fecha);
  }
}

// 9) loadActivities(grupo, fecha)
//    Lee de GAS_URL las actividades y las pinta
async function loadActivities(grupo, fecha) {
  console.log("▶️ loadActivities", grupo, fecha);
  const res = await fetch(
    `${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`
  );
  const { valores } = await res.json();
  const ul = document.querySelector(
    `section[data-fecha="${fecha}"] .activity-list`
  );
  ul.innerHTML = "";

  if (!valores.length) {
    ul.innerHTML = `
      <li class="activity-card" style="text-align:center;color:#666">
        — Sin actividades —
      </li>
    `;
    return;
  }

  valores.forEach(act => {
    const li = document.createElement("li");
    li.className = "activity-card";
    li.innerHTML = `
      <h4>${act.horaInicio || "–"} → ${act.horaFin || "–"}</h4>
      <p><strong>${act.actividad}</strong></p>
      <p>👥 ${act.pasajeros || 0} pax</p>
      <div style="text-align:right">
        <button class="btn-edit">✏️</button>
        <button class="btn-del">🗑️</button>
      </div>
    `;
    if (act.alerta) li.style.border = "2px solid red";

    // editar
    li.querySelector(".btn-edit").onclick = () => openModal(act, true);
    // borrar
    li.querySelector(".btn-del").onclick = async () => {
      if (!confirm("¿Eliminar actividad?")) return;
      await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datos: { ...act, borrar: true } })
      });
      loadActivities(grupo, fecha);
    };

    ul.appendChild(li);
  });
}

// 10) openModal(data, isEdit)
//     Rellena y muestra el modal para crear/editar
function openModal(data, isEdit) {
  console.log("▶️ openModal", data, isEdit);
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent = isEdit
    ? "Editar actividad"
    : "Nueva actividad";
  fldFecha.value  = data.fecha;
  fldHi.value     = data.horaInicio || "";
  fldHf.value     = data.horaFin    || "";
  fldAct.value    = data.actividad  || "";
  fldPas.value    = data.pasajeros  || 1;
  fldNotas.value  = data.notas      || "";
  modalBg.style.display = modal.style.display = "block";
}

// 11) closeModal()
//     Oculta el modal
function closeModal() {
  console.log("▶️ closeModal");
  modalBg.style.display = modal.style.display = "none";
}

// 12) formModal.onsubmit
//     Envía nueva actividad o edición
formModal.onsubmit = async e => {
  e.preventDefault();
  const grupo = selectNum.value;
  const payload = {
    numeroNegocio: grupo,
    fecha:         fldFecha.value,
    horaInicio:    fldHi.value,
    horaFin:       fldHf.value,
    actividad:     fldAct.value,
    pasajeros:     parseInt(fldPas.value, 10),
    notas:         fldNotas.value
  };
  if (editData) payload.id = editData.id;
  console.log("▶️ Guardando payload", payload);

  await fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ datos: payload })
  });

  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// 13) Cerrar modal al clicar fuera o en “Cancelar”
document.getElementById("modal-cancel").onclick = closeModal;
modalBg.onclick = closeModal;
