// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

console.log("▶️ itinerario.js cargado");

// 1) URLs de datos
const OPENSHEET = "https://opensheet.elk.sh/124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI/LecturaBaseOperaciones";
const GAS_URL   = "https://script.google.com/macros/s/AKfycbwkyIMHb_bzAzMWoO3Yte2a6aFtVDguFGsiL0aaG6Tupn8B807oovR34S0YbR9I9mz0/exec";

// 2) Elementos principales del DOM
const selectNum      = document.getElementById("grupo-select-num");   // selector por código
const selectName     = document.getElementById("grupo-select-name");  // selector por nombre
const titleGrupo     = document.getElementById("grupo-title");       
const contItinerario = document.getElementById("itinerario-container");

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

// 4) Cuando el DOM esté listo, comprobamos sesión y arrancamos
document.addEventListener("DOMContentLoaded", () => {
  console.log("▶️ DOM listo");
  onAuthStateChanged(auth, user => {
    console.log("▶️ Usuario:", user?.email);
    if (!user) return location.href = "login.html";
    init();
  });
});

async function init() {
  console.log("▶️ init()");
  // 5.1) Leer toda la hoja
  const datos = await (await fetch(OPENSHEET)).json();

  // 5.2) Extraer pares únicos {numeroNegocio, nombreGrupo}
  const mapa = new Map();
  datos.forEach(r => {
    if (r.numeroNegocio && r.nombreGrupo && !mapa.has(r.numeroNegocio)) {
      mapa.set(r.numeroNegocio, r.nombreGrupo);
    }
  });
  const grupos = Array.from(mapa.entries());

  // 5.3) Poblar los dos <select>
  selectNum.innerHTML  = grupos.map(([num])    => `<option value="${num}">${num}</option>`).join("");
  selectName.innerHTML = grupos.map(([num,n]) => `<option value="${num}">${n}</option>`).join("");

  // 5.4) Listeners “espejo”
  selectNum.onchange  = () => { selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = () => { selectNum.value  = selectName.value; renderItinerario(); };

  // 5.5) Primer render
  await renderItinerario();
}

/**
 * 6) parseDdMmYyyy(s)
 *    Convierte "DD-MM-YYYY" → Date
 */
function parseDdMmYyyy(s) {
  const [d, m, y] = s.split("-").map(n => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

/**
 * 7) getRangoFechas(grupo)
 *    Devuelve array de fechas ISO entre fechaInicio y fechaFin
 */
async function getRangoFechas(grupo) {
  const datos = await (await fetch(OPENSHEET)).json();
  const fila  = datos.find(r => r.numeroNegocio === grupo);
  if (!fila) throw new Error(`No datos para ${grupo}`);
  const inicio = parseDdMmYyyy(fila.fechaInicio);
  const fin    = parseDdMmYyyy(fila.fechaFin);
  const dias = [];
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
    dias.push(d.toISOString().slice(0, 10));
  }
  return dias;
}

/**
 * 8) renderItinerario()
 *    Dibuja carrusel de “Día N – Nombre día dd/mm”
 *    y carga sus actividades
 */
async function renderItinerario() {
  const grupo  = selectNum.value;
  const nombre = selectName.options[selectName.selectedIndex].text;
  console.log("▶️ renderItinerario", grupo, nombre);

  // 8.1) Recuperar el programa de la hoja
  const datos = await (await fetch(OPENSHEET)).json();
  const fila  = datos.find(r => r.numeroNegocio === grupo);

  //8.1.a
  if (!fila) {
  titleGrupo.textContent = "Programa no encontrado";
  return;
  }
  
  // Calculamos el total de pax desde la hoja
  const totalPax = parseInt(fila.cantidadgrupo, 10) || 0;
  titleGrupo.textContent = fila?.programa || "Programa no encontrado";

  // 8.2) Limpiar contenedor y obtener fechas
  contItinerario.innerHTML = "";
  const fechas = await getRangoFechas(grupo);

  const qaDia = document.getElementById("qa-dia");
  qaDia.innerHTML = fechas
  .map((_, i) => `<option value="${i}">Día ${i+1}</option>`)
  .join("");

  // 8.3) Rellenar el select de fecha en el modal
  fldFecha.innerHTML = fechas.map(f => `<option value="${f}">${f}</option>`).join("");

  // 8.4) Recorremos cada fecha con índice para el “Día N”
  for (let i = 0; i < fechas.length; i++) {
    const fecha = fechas[i];
    const dObj   = new Date(fecha);
    const weekday= dObj.toLocaleDateString("es-CL", { weekday:"long" });
    const dia    = String(dObj.getDate()).padStart(2,"0");
    const mes    = String(dObj.getMonth()+1).padStart(2,"0");
    const titulo = `Día ${i+1} – ${weekday.charAt(0).toUpperCase()+weekday.slice(1)} ${dia}/${mes}`;

    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML     = `
      <h3>${titulo}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = () => openModal({ fecha, totalPax }, false);
    await loadActivities(grupo, fecha);
  }
}

/**
 * 9) loadActivities(grupo, fecha)
 *    Lee actividades de tu WebApp y las pinta
 */
async function loadActivities(grupo, fecha) {
  const res    = await fetch(`${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`);
  const { valores } = await res.json();
  const ul     = document.querySelector(`section[data-fecha="${fecha}"] .activity-list`);
  ul.innerHTML = "";

  if (!valores.length) {
    ul.innerHTML = `<li class="activity-card" style="text-align:center;color:#666">— Sin actividades —</li>`;
    return;
  }

  valores.forEach(act => {
    const li = document.createElement("li");
    li.className = "activity-card";
    li.innerHTML = `
      <h4>${act.horaInicio||"–"}</h4>
      <p><strong>${act.actividad}</strong></p>
      <p>👥 ${act.pasajeros||0} pax</p>
      <div style="text-align:right">
        <button class="btn-edit">✏️</button>
        <button class="btn-del">🗑️</button>
      </div>
    `;
    if (act.alerta) li.style.border = "2px solid red";

    li.querySelector(".btn-edit").onclick = () => openModal(act, true);
    li.querySelector(".btn-del").onclick = async () => {
      if (!confirm("¿Eliminar actividad?")) return;
      await fetch(GAS_URL, {
        method:  "POST",
        headers: { "Content-Type":"application/json" },
        body:    JSON.stringify({ datos:{ ...act, borrar:true } })
      });
      loadActivities(grupo, fecha);
    };

    ul.appendChild(li);
  });
}

// 10) openModal(data, isEdit)
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title").textContent = isEdit ? "Editar actividad" : "Nueva actividad";
  fldFecha.value  = data.fecha;
  fldHi.value     = data.horaInicio  || "";
  fldHf.value     = data.horaFin     || "";
  fldAct.value    = data.actividad   || "";
  fldPas.value    = isEdit
                  ? data.pasajeros
                  : data.totalPax;
  fldNotas.value  = data.notas       || "";
  modalBg.style.display = modal.style.display = "block";
}

// 11) closeModal()
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// 12) formModal.onsubmit
formModal.onsubmit = async e => {
  e.preventDefault();
  const grupo = selectNum.value;
  const payload = {
    numeroNegocio: grupo,
    fecha:         fldFecha.value,
    horaInicio:    fldHi.value,
    horaFin:       fldHf.value,
    actividad:     fldAct.value,
    pasajeros:     parseInt(fldPas.value,10),
    notas:         fldNotas.value
  };
  if (editData) payload.id = editData.id;

  await fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type":"application/json" },
    body:    JSON.stringify({ datos: payload })
  });

  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// 13) Cerrar modal
document.getElementById("modal-cancel").onclick = closeModal;
modalBg.onclick = closeModal;
