// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

console.log("▶️ itinerario.js cargado");

// 1) URLs de servicio
const GAS_URL   = 'https://script.google.com/macros/s/.../exec';           // tu Web App
const OPENSHEET = 'https://opensheet.elk.sh/.../LecturaBaseOperaciones';  // Opensheet público

// 2) Referencias al DOM
const selNum    = document.getElementById('grupo-select-num');
const selName   = document.getElementById('grupo-select-name');
const titleGrp  = document.getElementById('grupo-title');
const titleDest = document.getElementById('destino-title');
const titleProg = document.getElementById('programa-title');
const contItin  = document.getElementById('itinerario-container');

// 3) Elementos del modal
const modalBg   = document.getElementById('modal-backdrop');
const modal     = document.getElementById('modal');
const formModal = document.getElementById('modal-form');
const fldFecha  = document.getElementById('m-fecha');
const fldHi     = document.getElementById('m-horaInicio');
const fldHf     = document.getElementById('m-horaFin');
const fldAct    = document.getElementById('m-actividad');
const fldPas    = document.getElementById('m-pasajeros');
const fldNotas  = document.getElementById('m-notas');
let editData    = null;  // para saber si estamos editando

// 4) Autenticación y arranque
document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, user => {
    console.log("▶️ Usuario autenticado:", user?.email);
    if (!user) return location.href = 'login.html';
    init();
  });
});

async function init() {
  console.log("▶️ init()");
  // 5) Carga toda la hoja y extrae grupos únicos
  const datos = await (await fetch(OPENSHEET)).json();
  // Mapea sólo lo necesario
  const grupos = datos.map(r => ({
    num:       r.numeroNegocio,
    name:      r.nombreGrupo,
    destino:   r.destino,
    programa:  r.programa,
    inicio:    r.fechaInicio,
    fin:       r.fechaFin
  }));
  // Elimina duplicados por número
  const únicos = Array.from(new Map(grupos.map(g => [g.num, g])).values());

  // 6) Rellena los <select> y sincroniza
  selNum.innerHTML  = únicos.map(g => `<option value="${g.num}">${g.num}</option>`).join('');
  selName.innerHTML = únicos.map(g => `<option value="${g.num}">${g.name}</option>`).join('');
  selNum.onchange  = () => selName.value = selNum.value;
  selName.onchange = () => selNum.value  = selName.value;

  // Primera visualización
  renderItinerario();
}

// Convierte "DD-MM-YYYY" → Date
function parseDdMmYyyy(s) {
  const [d,m,y] = s.split('-').map(n => parseInt(n,10));
  return new Date(y, m-1, d);
}

// 7) Genera rango de fechas (incluye inicio y fin)
async function getRangoFechas(grupoNum) {
  const datos = await (await fetch(OPENSHEET)).json();
  const f     = datos.find(r => r.numeroNegocio === grupoNum);
  const start = parseDdMmYyyy(f.fechaInicio);
  const end   = parseDdMmYyyy(f.fechaFin);
  const dias  = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    dias.push(d.toISOString().slice(0,10));
  }
  return { dias, destino: f.destino, programa: f.programa };
}

// 8) Renderiza el carrusel de días + actualiza header
async function renderItinerario() {
  const num = selNum.value;
  const { dias, destino, programa } = await getRangoFechas(num);

  // Títulos
  titleGrp.textContent  = num;
  titleDest.textContent = destino;
  titleProg.textContent = programa;

  // Prepara fechas en el modal
  fldFecha.innerHTML = dias.map(d => `<option value="${d}">${d}</option>`).join('');
  contItin.innerHTML = '';

  // Para cada día, crea sección y carga actividades
  for (let dia of dias) {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.dataset.fecha = dia;
    sec.innerHTML = `
      <h3>${dia}</h3>
      <div class="activity-list" data-fecha="${dia}"></div>
      <button class="btn-add" data-fecha="${dia}">+ Añadir actividad</button>
    `;
    contItin.appendChild(sec);
    sec.querySelector('.btn-add').onclick = () => openModal({ fecha: dia }, false);
    await loadActivities(num, dia);
  }
}

// 9) Carga y pinta actividades divididas por bloques horarios
async function loadActivities(grupo, fecha) {
  console.log("▶️ loadActivities", grupo, fecha);
  const res   = await fetch(`${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`);
  const json  = await res.json();
  const acts  = json.valores || [];
  const cont  = document.querySelector(`.activity-list[data-fecha="${fecha}"]`);
  cont.innerHTML = '';

  // Define bloques
  const bloques = {
    Desayuno:         acts.filter(a => a.horaInicio <= '09:00'),
    "Primer Bloque":  acts.filter(a => a.horaInicio > '09:00' && a.horaInicio <= '13:00'),
    Almuerzo:         acts.filter(a => a.horaInicio > '13:00' && a.horaInicio <= '15:00'),
    "Segundo Bloque": acts.filter(a => a.horaInicio > '15:00' && a.horaInicio <= '19:00'),
    Cena:             acts.filter(a => a.horaInicio > '19:00' && a.horaInicio <= '21:00'),
    Pernocte:         acts.filter(a => a.horaInicio > '21:00')
  };

  // Pinta cada bloque
  for (let [label, lista] of Object.entries(bloques)) {
    const hdr = document.createElement('h4');
    hdr.textContent = label;
    cont.appendChild(hdr);

    if (!lista.length) {
      const msg = document.createElement('p');
      msg.textContent = '— sin actividades —';
      msg.style.color = '#666';
      cont.appendChild(msg);
      continue;
    }

    lista.forEach(act => {
      const card = document.createElement('div');
      card.className = 'activity-card';
      card.innerHTML = `
        <strong>${act.horaInicio||'–'} → ${act.horaFin||'–'}</strong>
        <div>${act.actividad}</div>
        <small>👥 ${act.pasajeros||0} pax</small>
        <div style="text-align:right; margin-top:4px">
          <button class="btn-edit">✏️</button>
          <button class="btn-del">🗑️</button>
        </div>
      `;
      if (act.alerta) card.style.border = '2px solid red';

      // editar
      card.querySelector('.btn-edit').onclick = () => openModal(act, true);
      // borrar
      card.querySelector('.btn-del').onclick = async () => {
        if (!confirm('¿Eliminar actividad?')) return;
        await fetch(GAS_URL, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ datos:{ ...act, borrar:true } })
        });
        loadActivities(grupo, fecha);
      };

      cont.appendChild(card);
    });
  }
}

// 10) Funciones del modal
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

function closeModal() {
  modalBg.style.display = modal.style.display = 'none';
}

// 11) Guardado desde el modal
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
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ datos: payload })
  });

  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// 12) Cierre del modal al clicar fuera o cancelar
document.getElementById('modal-cancel').onclick = closeModal;
modalBg.onclick = closeModal;
