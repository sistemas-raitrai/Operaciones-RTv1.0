import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

console.log("▶️ itinerario.js cargado");

// 1) URLs de datos
const GAS_URL   = 'https://script.google.com/macros/s/.../exec';
const OPENSHEET = 'https://opensheet.elk.sh/.../LecturaBaseOperaciones';

// 2) Elementos del DOM
const selectGrupo    = document.getElementById('grupo-select');
const titleGrupo     = document.getElementById('grupo-title');
const contItinerario = document.getElementById('itinerario-container');

// 3) Modal
const modalBg   = document.getElementById('modal-backdrop');
const modal     = document.getElementById('modal');
const formModal = document.getElementById('modal-form');
const fldFecha  = document.getElementById('m-fecha');
const fldHi     = document.getElementById('m-horaInicio');
const fldHf     = document.getElementById('m-horaFin');
const fldAct    = document.getElementById('m-actividad');
const fldPas    = document.getElementById('m-pasajeros');
const fldNotas  = document.getElementById('m-notas');
let editData    = null;  // para edición

// 4) Autenticación + arranque
document.addEventListener('DOMContentLoaded', () => {
  console.log("▶️ DOM listo");
  onAuthStateChanged(auth, user => {
    console.log("▶️ Usuario:", user?.email);
    if (!user) return location.href = 'login.html';
    init();
  });
});

async function init() {
  console.log("▶️ init()");
  // 5) Cargar lista de grupos
  const datos = await (await fetch(OPENSHEET)).json();
  const grupos = [...new Set(datos.map(r => r.numeroNegocio))];
  selectGrupo.innerHTML = grupos.map(g => <option>${g}</option>).join('');
  selectGrupo.onchange = renderItinerario;
  await renderItinerario();  // primera render
}

/**
 * 6) Parsear fecha DD-MM-YYYY → Date
 */
function parseDdMmYyyy(s) {
  const [d,m,y] = s.split('-').map(n=>parseInt(n,10));
  return new Date(y, m - 1, d);
}

// 7) Obtener rango de fechas del grupo
async function getRangoFechas(grupo) {
  console.log("▶️ getRangoFechas", grupo);
  const datos = await (await fetch(OPENSHEET)).json();
  const fila  = datos.find(r => r.numeroNegocio === grupo);
  const inicio = parseDdMmYyyy(fila.fechaInicio);
  const fin    = parseDdMmYyyy(fila.fechaFin);
  const dias = [];
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate()+1)) {
    dias.push(d.toISOString().slice(0,10));
  }
  return dias;
}

// 8) Renderizar carrusel de días
async function renderItinerario() {
  const grupo = selectGrupo.value;
  console.log("▶️ renderItinerario", grupo);
  titleGrupo.textContent = grupo;
  contItinerario.innerHTML = '';

  const fechas = await getRangoFechas(grupo);
  fldFecha.innerHTML = fechas.map(f => <option>${f}</option>).join('');

  for (const fecha of fechas) {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.dataset.fecha = fecha;
    sec.innerHTML = 
      <h3>${fecha}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    ;
    contItinerario.appendChild(sec);
    sec.querySelector('.btn-add').onclick = () => openModal({ fecha }, false);
    await loadActivities(grupo, fecha);  // carga cada día
  }
}

// 9) Carga y pinta actividades de un día
async function loadActivities(grupo, fecha) {
  console.log("▶️ loadActivities", grupo, fecha);
  const res  = await fetch(${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1);
  const { valores } = await res.json();
  const ul = document.querySelector(section[data-fecha="${fecha}"] .activity-list);
  ul.innerHTML = '';

  if (!valores.length) {
    ul.innerHTML = <li class="activity-card" style="text-align:center;color:#666">— Sin actividades —</li>;
    return;
  }

  valores.forEach(act => {
    const li = document.createElement('li');
    li.className = 'activity-card';
    li.innerHTML = 
      <h4>${act.horaInicio||'–'} → ${act.horaFin||'–'}</h4>
      <p><strong>${act.actividad}</strong></p>
      <p>👥 ${act.pasajeros||0} pax</p>
      <div style="text-align:right">
        <button class="btn-edit">✏️</button>
        <button class="btn-del">🗑️</button>
      </div>
    ;
    if (act.alerta) li.style.border = '2px solid red';

    // editar
    li.querySelector('.btn-edit').onclick = () => openModal(act, true);
    // borrar
    li.querySelector('.btn-del').onclick = async () => {
      if (!confirm('¿Eliminar actividad?')) return;
      await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ datos:{ ...act, borrar:true } })
      });
      loadActivities(grupo, fecha);
    };
    ul.appendChild(li);
  });
}

// 10) Modal: abrir
function openModal(data, isEdit) {
  console.log("▶️ openModal", data, isEdit);
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

// 11) Modal: cerrar
function closeModal() {
  console.log("▶️ closeModal");
  modalBg.style.display = modal.style.display = 'none';
}

// 12) Guardar desde modal
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
  console.log("▶️ Guardando payload", payload);

  await fetch(GAS_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ datos: payload })
  });

  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// 13) Eventos para cerrar modal con clic
document.getElementById('modal-cancel').onclick = closeModal;
modalBg.onclick = closeModal;
