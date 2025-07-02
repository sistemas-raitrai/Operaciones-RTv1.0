// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

// ① URLs de tus fuentes de datos
const GAS_URL   = 'https://script.google.com/macros/s/.../exec';
const OPENSHEET = 'https://opensheet.elk.sh/124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI/LecturaBaseOperaciones';

// ② Referencias al DOM
const selNum      = document.getElementById('grupo-select-num');
const selName     = document.getElementById('grupo-select-name');
const titleGrupo  = document.getElementById('grupo-title');
const titleDest   = document.getElementById('destino-title');
const titleProg   = document.getElementById('programa-title');
const contItin    = document.getElementById('itinerario-container');

// Modal
const modalBg     = document.getElementById('modal-backdrop');
const modal       = document.getElementById('modal');
const formModal   = document.getElementById('modal-form');
const fldFecha    = document.getElementById('m-fecha');
const fldHi       = document.getElementById('m-horaInicio');
const fldHf       = document.getElementById('m-horaFin');
const fldAct      = document.getElementById('m-actividad');
const fldPas      = document.getElementById('m-pasajeros');
const fldNotas    = document.getElementById('m-notas');
let editData      = null; // Para determinar si estamos editando

// ③ Espera a DOM y auth
document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, user => {
    if (!user) return location.href = 'login.html';
    init();  
  });
});

// ④ Carga inicial: datos y llenado de selects
let gruposData = [];
async function init() {
  console.log('▶️ init');
  // 1) Fetch de hoja
  const datos = await (await fetch(OPENSHEET)).json();
  // 2) Mapea a objetos útiles (uno por primer aparición de cada grupo)
  const seen = new Set();
  gruposData = datos.filter(r => {
    if (!seen.has(r.numeroNegocio)) {
      seen.add(r.numeroNegocio);
      return true;
    }
    return false;
  }).map(r => ({
    numero:     r.numeroNegocio,
    nombre:     r.nombreGrupo || r.numeroNegocio,
    destino:    r.destino,
    programa:   r.programa,
    fechaInicio:r.fechaInicio,
    fechaFin:   r.fechaFin
  }));

  // 3) Rellenar ambos selects
  selNum.innerHTML  = gruposData.map(g => `<option value="${g.numero}">${g.numero}</option>`).join('');
  selName.innerHTML = gruposData.map(g => `<option value="${g.numero}">${g.nombre}</option>`).join('');
  // 4) Sincronizar cambios
  selNum.onchange  = () => {
    selName.value = selNum.value;
    renderItinerario();
  };
  selName.onchange = () => {
    selNum.value = selName.value;
    renderItinerario();
  };
  // 5) Primera carga
  selNum.value = gruposData[0].numero;
  selName.value = gruposData[0].numero;
  await renderItinerario();
}

// ►►► Helpers

/** Convierte "DD-MM-YYYY" a Date */
function parseDdMmYyyy(s) {
  const [d,m,y] = s.split('-').map(n=>parseInt(n,10));
  return new Date(y, m-1, d);
}

/** Devuelve array de YYYY-MM-DD entre inicio y fin */
async function getRangoFechas(grupoNum) {
  const g = gruposData.find(x=>x.numero===grupoNum);
  const inicio = parseDdMmYyyy(g.fechaInicio);
  const fin    = parseDdMmYyyy(g.fechaFin);
  const dias = [];
  for (let d=new Date(inicio); d<=fin; d.setDate(d.getDate()+1)) {
    dias.push(d.toISOString().slice(0,10));
  }
  return dias;
}

// ⑤ Renderiza todo el itinerario
async function renderItinerario() {
  const num = selNum.value;
  const grp = gruposData.find(g=>g.numero===num);
  // Actualiza encabezado
  titleGrupo.textContent = num;
  titleDest.textContent  = grp.destino;
  titleProg.textContent  = grp.programa;

  contItin.innerHTML = '';  // limpia carrusel

  // obtiene días
  let fechas = [];
  try {
    fechas = await getRangoFechas(num);
  } catch (e) {
    contItin.innerHTML = `<p style="color:red;">Error fechas: ${e.message}</p>`;
    return;
  }

  // llena el dropdown de fecha en el modal
  fldFecha.innerHTML = fechas.map(f=>`<option>${f}</option>`).join('');

  // por cada día, crea tarjeta
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
    sec.querySelector('.btn-add').onclick = () => openModal({ fecha }, false);
    await loadActivities(num, fecha);
  }
}

// ⑥ Carga y pinta actividades para un día
async function loadActivities(grupo, fecha) {
  const res = await fetch(`${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`);
  const { valores } = await res.json();
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
    // eliminar
    li.querySelector('.btn-del').onclick = async () => {
      if (!confirm('¿Eliminar actividad?')) return;
      await fetch(GAS_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ datos:{ ...act, borrar:true } })
      });
      loadActivities(grupo, fecha);
    };

    ul.appendChild(li);
  });
}

// ⑦ Abre modal (nueva o edición)
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById('modal-title').textContent = isEdit ? 'Editar actividad' : 'Nueva actividad';
  fldFecha.value  = data.fecha;
  fldHi.value     = data.horaInicio || '';
  fldHf.value     = data.horaFin    || '';
  fldAct.value    = data.actividad  || '';
  fldPas.value    = data.pasajeros  || 1;
  fldNotas.value  = data.notas      || '';
  modalBg.style.display = modal.style.display = 'block';
}

// ⑧ Cierra modal
function closeModal() {
  modalBg.style.display = modal.style.display = 'none';
}

// ⑨ Guardar desde modal
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
    notas:         fldNotas.value
  };
  if (editData) payload.id = editData.id;

  await fetch(GAS_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ datos: payload })
  });

  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// ⑩ Eventos para cerrar modal al hacer clic fuera o en “Cancelar”
document.getElementById('modal-cancel').onclick = closeModal;
modalBg.onclick = closeModal;
