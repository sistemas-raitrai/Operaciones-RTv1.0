// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

// ① Módulo cargado
console.log("▶️ itinerario.js cargado");

// URLs
const GAS_URL   = 'https://script.google.com/macros/s/AKfycbzr12TXE8-lFd86P1yK_yRSVyyFFSuUnAHY_jOefJHYQZCQ5yuQGQsoBP2OWh699K22/exec';
const OPENSHEET = 'https://opensheet.elk.sh/124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI/LecturaBaseOperaciones';

// DOM elements
const selectGrupo    = document.getElementById('grupo-select');
const titleGrupo     = document.getElementById('grupo-title');
const contItinerario = document.getElementById('itinerario-container');

// Modal elements
const modalBg   = document.getElementById('modal-backdrop');
const modal     = document.getElementById('modal');
const formModal = document.getElementById('modal-form');
const fldFecha  = document.getElementById('m-fecha');
const fldHi     = document.getElementById('m-horaInicio');
const fldHf     = document.getElementById('m-horaFin');
const fldAct    = document.getElementById('m-actividad');
const fldPas    = document.getElementById('m-pasajeros');
const fldNotas  = document.getElementById('m-notas');
let editData    = null; // guarda la actividad en edición

// ② Espera a DOM listo
document.addEventListener('DOMContentLoaded', () => {
  console.log("▶️ DOMContentLoaded");
  onAuthStateChanged(auth, user => {
    console.log("▶️ onAuthStateChanged:", user);
    if (!user) {
      console.warn("⚠️ No hay sesión, redirigiendo a login");
      return location.href = 'login.html';
    }
    init();
  });
});

async function init() {
  console.log("▶️ init() arrancando");
  try {
    // ③ Cargo grupos desde Opensheet
    const res   = await fetch(OPENSHEET);
    const datos = await res.json();
    console.log("▶️ Datos Opensheet:", datos);

    if (!Array.isArray(datos) || datos.length === 0) {
      throw new Error("No hay datos en LecturaBaseOperaciones");
    }

    // ④ Extraigo grupos únicos
    const grupos = [...new Set(datos.map(r => r.numeroNegocio))];
    console.log("▶️ Grupos únicos:", grupos);

    if (grupos.length === 0) {
      throw new Error("La clave numeroNegocio no existe o está vacía");
    }

    // ⑤ Relleno el <select>
    selectGrupo.innerHTML = grupos.map(g => `<option>${g}</option>`).join('');
    selectGrupo.addEventListener('change', renderItinerario);
    selectGrupo.value = grupos[0];

    // Pinto primero
    await renderItinerario();
  } catch (err) {
    console.error("❌ Error en init():", err);
    contItinerario.innerHTML = `<p style="color:red;">Error cargando grupos: ${err.message}</p>`;
  }
}

// Genera rango de fechas
async function getRangoFechas(grupo) {
  console.log(`▶️ getRangoFechas(${grupo})`);
  const res   = await fetch(OPENSHEET);
  const datos = await res.json();
  const fila  = datos.find(r => r.numeroNegocio === grupo);
  if (!fila) throw new Error(`No encontré datos para grupo ${grupo}`);
  const inicio = new Date(fila.fechaInicio);
  const fin    = new Date(fila.fechaFin);
  const arr    = [];
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate()+1)) {
    arr.push(d.toISOString().slice(0,10));
  }
  console.log("▶️ Fechas:", arr);
  return arr;
}

// Pinta el itinerario
async function renderItinerario() {
  const grupo = selectGrupo.value;
  console.log(`▶️ renderItinerario() grupo ${grupo}`);
  titleGrupo.textContent = grupo;
  contItinerario.innerHTML = '';

  let fechas;
  try {
    fechas = await getRangoFechas(grupo);
  } catch (err) {
    console.error("❌ getRangoFechas falló:", err);
    contItinerario.innerHTML = `<p style="color:red;">No pude calcular fechas: ${err.message}</p>`;
    return;
  }

  // Preparo modal
  fldFecha.innerHTML = fechas.map(f => `<option>${f}</option>`).join('');

  // Por día...
  for (const fecha of fechas) {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>${fecha}</h3>
      <table class="tabla-itinerario">
        <thead>
          <tr>
            <th>Inicio</th><th>Fin</th><th>Actividad</th><th>Pasajeros</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);
    sec.querySelector('.btn-add').onclick = () => openModal({ fecha }, false);
    await loadActivities(grupo, fecha);
  }
}

// Carga actividades
async function loadActivities(grupo, fecha) {
  console.log(`▶️ loadActivities(${grupo}, ${fecha})`);
  try {
    const res  = await fetch(`${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`);
    const json = await res.json();
    console.log(`▶️ Actividades ${grupo}/${fecha}:`, json.valores);
    const rows = json.valores || [];
    const tbody = document.querySelector(`section[data-fecha="${fecha}"] tbody`);
    tbody.innerHTML = '';

    rows.forEach(act => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${act.horaInicio}</td>
        <td>${act.horaFin}</td>
        <td>${act.actividad}</td>
        <td>${act.pasajeros}</td>
        <td>
          <button class="btn-edit">✏️</button>
          <button class="btn-del">🗑️</button>
        </td>
      `;
      if (act.alerta) tr.style.border = '2px solid red';
      tbody.appendChild(tr);

      tr.querySelector('.btn-edit').onclick = () => openModal(act, true);
      tr.querySelector('.btn-del').onclick = async () => {
        if (!confirm('¿Eliminar actividad?')) return;
        await fetch(GAS_URL, {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ datos:{ ...act, borrar:true } })
        });
        loadActivities(grupo, fecha);
      };
    });
  } catch (err) {
    console.error("❌ Error en loadActivities:", err);
  }
}

// Abre modal
function openModal(data, isEdit) {
  console.log("▶️ openModal:", data, isEdit);
  editData = isEdit ? data : null;
  document.getElementById('modal-title').textContent = isEdit ? 'Editar actividad' : 'Nueva actividad';
  fldFecha.value = data.fecha;
  fldHi.value    = data.horaInicio || '';
  fldHf.value    = data.horaFin    || '';
  fldAct.value   = data.actividad  || '';
  fldPas.value   = data.pasajeros  || 1;
  fldNotas.value = data.notas      || '';
  modalBg.style.display = modal.style.display = 'block';
}

// Cierra modal
function closeModal() {
  console.log("▶️ closeModal");
  modalBg.style.display = modal.style.display = 'none';
}

// Guarda modal
formModal.onsubmit = async e => {
  e.preventDefault();
  const grupo = selectGrupo.value;
  const payload = {
    numeroNegocio: grupo,
    fecha: fldFecha.value,
    horaInicio: fldHi.value,
    horaFin: fldHf.value,
    actividad: fldAct.value,
    pasajeros: parseInt(fldPas.value,10),
    notas: fldNotas.value
  };
  if (editData) payload.id = editData.id;
  console.log("▶️ Guardando payload:", payload);

  await fetch(GAS_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ datos: payload })
  });

  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// Carga eventos de cierre del modal
document.getElementById('modal-cancel').onclick = closeModal;
modalBg.onclick = closeModal;
