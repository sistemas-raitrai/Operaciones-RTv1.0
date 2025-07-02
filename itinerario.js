// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

console.log("▶️ itinerario.js cargado");

// ① URLs de datos
const GAS_URL   = 'https://script.google.com/macros/s/.../exec';           // tu Web App GAS
const OPENSHEET = 'https://opensheet.elk.sh/.../LecturaBaseOperaciones';  // lectura del sheet

// ② DOM elements
const selNum    = document.getElementById('grupo-select-num');
const selName   = document.getElementById('grupo-select-name');
const titleGrp  = document.getElementById('grupo-title');
const titleDest = document.getElementById('destino-title');
const titleProg = document.getElementById('programa-title');
const contItin  = document.getElementById('itinerario-container');

// ③ Modal elements
const modalBg   = document.getElementById('modal-backdrop');
const modal     = document.getElementById('modal');
const formModal = document.getElementById('modal-form');
const fldFecha  = document.getElementById('m-fecha');
const fldHi     = document.getElementById('m-horaInicio');
const fldHf     = document.getElementById('m-horaFin');
const fldAct    = document.getElementById('m-actividad');
const fldPas    = document.getElementById('m-pasajeros');
const fldNotas  = document.getElementById('m-notas');
let editData    = null;

// ④ Autenticación + arranque
document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, user => {
    if (!user) return location.href = 'login.html';
    init();
  });
});

// ⑤ Inicialización: carga datos base y llena selects
async function init() {
  const datos = await (await fetch(OPENSHEET)).json();

  // extraigo los grupos únicos y sus nombres
  const gruposNum  = [...new Set(datos.map(r => r.numeroNegocio))];
  const gruposName = [...new Set(datos.map(r => r.nombreGrupo))];

  selNum.innerHTML  = gruposNum.map(n => `<option>${n}</option>`).join('');
  selName.innerHTML = gruposName.map(n => `<option>${n}</option>`).join('');

  // mantener sincronizados ambos selects
  selNum.onchange = () => {
    const num = selNum.value;
    // busco el nombre del grupo
    const row = datos.find(r => r.numeroNegocio === num);
    selName.value = row.nombreGrupo;
    renderItinerario();
  };
  selName.onchange = () => {
    const name = selName.value;
    const row  = datos.find(r => r.nombreGrupo === name);
    selNum.value = row.numeroNegocio;
    renderItinerario();
  };

  // primera render
  selNum.value = gruposNum[0];
  selName.value = datos.find(r=>r.numeroNegocio==gruposNum[0]).nombreGrupo;
  await renderItinerario();
}

// ⑥ JSONP helper: inyecta un <script> y resuelve la Promise
function jsonpFetch(url) {
  return new Promise((resolve, reject) => {
    const cbName = `cb_${Date.now()}`;
    window[cbName] = data => {
      delete window[cbName];
      resolve(data);
    };
    const s = document.createElement('script');
    s.src = url + `&callback=${cbName}`;
    s.onerror = () => reject(new Error('JSONP load error'));
    document.body.appendChild(s);
  });
}

// ⑦ Parseo "DD-MM-YYYY" → Date
function parseDdMmYyyy(s) {
  const [d,m,y] = s.split('-').map(n=>parseInt(n,10));
  return new Date(y, m-1, d);
}

// ⑧ Obtiene rango de fechas
async function getRangoFechas(grupo) {
  const datos = await (await fetch(OPENSHEET)).json();
  const fila  = datos.find(r=>r.numeroNegocio===grupo);
  const inicio = parseDdMmYyyy(fila.fechaInicio);
  const fin    = parseDdMmYyyy(fila.fechaFin);
  // títulos del header
  titleGrp.textContent  = grupo;
  titleDest.textContent = fila.destino;
  titleProg.textContent = fila.programa;
  // construyo array de días
  const dias = [];
  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate()+1)) {
    dias.push(d.toISOString().slice(0,10));
  }
  return dias;
}

// ⑨ Renderiza el carrusel de días
async function renderItinerario() {
  const grupo  = selNum.value;
  contItin.innerHTML = '';
  const fechas = await getRangoFechas(grupo);
  // relleno opciones de fecha en el modal
  fldFecha.innerHTML = fechas.map(f=>`<option>${f}</option>`).join('');

  for (const fecha of fechas) {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.dataset.fecha = fecha;
    sec.innerHTML = `
      <h3>${fecha}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItin.appendChild(sec);
    sec.querySelector('.btn-add').onclick = () => openModal({fecha}, false);
    await loadActivities(grupo, fecha);
  }
}

// ⑩ Carga y pinta actividades usando JSONP
async function loadActivities(grupo, fecha) {
  const url = `${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`;
  const json = await jsonpFetch(url);
  const valores = json.valores || [];
  const ul = document.querySelector(`section[data-fecha="${fecha}"] .activity-list`);
  ul.innerHTML = '';

  if (!valores.length) {
    ul.innerHTML = `<li class="activity-card" style="text-align:center;color:#666">— Sin actividades —</li>`;
    return;
  }

  valores.forEach(act => {
    const li = document.createElement('li');
    li.className = 'activity-card';
    li.innerHTML = `
      <h4>${act.horaInicio||'–'} → ${act.horaFin||'–'}</h4>
      <p><strong>${act.actividad}</strong></p>
      <p>👥 ${act.pasajeros||0} pax</p>
      <div style="text-align:right">
        <button class="btn-edit">✏️</button>
        <button class="btn-del">🗑️</button>
      </div>
    `;
    if (act.alerta) li.style.border = '2px solid red';
    // editar
    li.querySelector('.btn-edit').onclick = () => openModal(act, true);
    // borrar
    li.querySelector('.btn-del').onclick = async () => {
      if (!confirm('¿Eliminar actividad?')) return;
      await jsonpFetch(`${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&borrar=1&id=${act.id}`);
      loadActivities(grupo, fecha);
    };
    ul.appendChild(li);
  });
}

// ⑪ Modal: abrir
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById('modal-title').textContent = isEdit ? 'Editar actividad' : 'Nueva actividad';
  fldFecha.value = data.fecha;
  fldHi.value    = data.horaInicio||'';
  fldHf.value    = data.horaFin   ||'';
  fldAct.value   = data.actividad ||'';
  fldPas.value   = data.pasajeros ||1;
  fldNotas.value = data.notas     ||'';
  modalBg.style.display = modal.style.display = 'block';
}

// ⑫ Modal: cerrar
function closeModal() {
  modalBg.style.display = modal.style.display = 'none';
}

// ⑬ Guardar desde modal (JSONP)
formModal.onsubmit = async e => {
  e.preventDefault();
  const grupo = selNum.value;
  const payload = {
    numeroNegocio: grupo,
    fecha:         fldFecha.value,
    horaInicio:    fldHi.value,
    horaFin:       fldHf.value,
    actividad:     fldAct.value,
    pasajeros:     parseInt(fldPas.value,10),
    notas:         fldNotas.value,
  };
  if (editData) payload.id = editData.id;

  // serializo como query params
  const qs = new URLSearchParams({ datos: JSON.stringify(payload) });
  await jsonpFetch(`${GAS_URL}?${qs.toString()}`);
  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// ⑭ Cerrar modal al clickar fuera o en “Cancelar”
document.getElementById('modal-cancel').onclick = closeModal;
modalBg.onclick = closeModal;
