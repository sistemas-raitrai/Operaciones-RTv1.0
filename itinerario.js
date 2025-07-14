// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs,
  doc, getDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias al DOM
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");           // ahora <select multiple>
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
const fldAdultos     = document.getElementById("m-adultos");      // nuevo
const fldEstudiantes = document.getElementById("m-estudiantes");  // nuevo
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let editData = null; // para saber si editamos (tiene { fecha, idx })

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 2.1) Traer TODOS los grupos
  const snap   = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  // 2.2) Llenar selects de nombre y número
  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 2.3) Sincronizar selects y lanzar render al cambiar
  selectNum.onchange  = ()=>{ selectName.value=selectNum.value; renderItinerario(); };
  selectName.onchange = ()=>{ selectNum.value=selectName.value; renderItinerario(); };

  // 2.4) Configurar Quick-Add (multi-día) y Modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): muestra carrusel de días y actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data()||{};

  // 3.1) Mostrar nombre de programa
  titleGrupo.textContent = g.programa||"–";

  // 3.2) Si aún no hay `itinerario` en el doc, lo inicializo con un array vacío por fecha
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(f=> init[f]=[]);
    await updateDoc(refG,{ itinerario: init });
    g.itinerario = init;
  }

  // 3.3) Ordenar las fechas ISO
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // 3.4) Preparar Quick-Add (ahora multiple) y opciones de fecha legibles
  qaDia.innerHTML = fechas
    .map((_,i)=> `<option value="${i}">Día ${i+1}</option>`)
    .join('');
  fldFecha.innerHTML = fechas
    .map(d=> `<option value="${d}">Día ${fechas.indexOf(d)+1} – ${formatDateReadable(d)}</option>`)
    .join('');

  // 3.5) Construir la grilla de secciones, una por día
  fechas.forEach((fecha,idx)=>{
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML     = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    // Botón interno abre modal para ese día
    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    // Pinto la lista de actividades
    const ul = sec.querySelector(".activity-list");
    const arr = g.itinerario[fecha]||[];
    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act,i)=>{
        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio||"–"}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${act.pasajeros||0} pax</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // Editar
        li.querySelector(".btn-edit").onclick = ()=> {
          openModal({ ...act, fecha, idx:i }, true);
        };
        // Borrar
        li.querySelector(".btn-del").onclick = async ()=> {
          if (!confirm("¿Eliminar actividad?")) return;
          arr.splice(i,1);
          await updateDoc(refG,{ [`itinerario.${fecha}`]:arr });
          renderItinerario();
        };
        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 4) quickAddActivity(): añadir la misma actividad en uno o varios días
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  // tomo todos los índices seleccionados
  const indices    = Array.from(qaDia.selectedOptions)
                          .map(o=>parseInt(o.value,10));
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim();
  if (!indices.length||!text) {
    return alert("Selecciona uno o más días y escribe la actividad");
  }

  const refG  = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g     = snapG.data();
  const fechas= Object.keys(g.itinerario)
                      .sort((a,b)=>new Date(a)-new Date(b));

  // repito push en cada día elegido
  for (let idx of indices) {
    const fecha = fechas[idx];
    const arr   = g.itinerario[fecha]||[];
    arr.push({
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  (g.adultos||0)+(g.estudiantes||0),
      adultos:    g.adultos||0,
      estudiantes:g.estudiantes||0,
      notas:""
    });
    await updateDoc(refG,{ [`itinerario.${fecha}`]:arr });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): preparar formulario de crear o editar
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  // Cargo valores existentes o por defecto
  fldFecha.value       = data.fecha;
  fldHi.value          = data.horaInicio || "07:00";
  fldHf.value          = isEdit
    ? (data.horaFin||sumarUnaHora(fldHi.value))
    : sumarUnaHora(fldHi.value);
  fldAct.value         = data.actividad||"";
  fldAdultos.value     = data.adultos    ?? ((data.pasajeros)||0);
  fldEstudiantes.value = data.estudiantes ?? 0;
  fldNotas.value       = data.notas      || "";

  // si cambian horaInicio, auto-ajusto fin = +1h
  fldHi.onchange = ()=> { fldHf.value = sumarUnaHora(fldHi.value); };

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal(): cerrar formulario
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guardar o actualizar en Firestore
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId   = selectNum.value;
  const fecha     = fldFecha.value;
  const a         = parseInt(fldAdultos.value,10)    || 0;
  const e         = parseInt(fldEstudiantes.value,10)|| 0;
  const pax       = a + e;
  const refG      = doc(db,'grupos',grupoId);
  const snapG     = await getDoc(refG);
  const g         = snapG.data();
  const maxPax    = (g.adultos||0)+(g.estudiantes||0);

  // Validación: sumatorio no exceda total de grupo
  if (pax > maxPax) {
    return alert(`La suma adultos+estudiantes (${pax}) no puede exceder ${maxPax}`);
  }

  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value
  };

  // actualizo el array correspondiente
  const arr = g.itinerario[fecha]||[];
  if (editData) {
    arr[editData.idx] = payload;
  } else {
    arr.push(payload);
  }
  await updateDoc(refG,{ [`itinerario.${fecha}`]:arr });

  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Util: devuelve array ISO entre dos fechas inclusive
// —————————————————————————————————
function getDateRange(startStr,endStr) {
  const out = [], start=new Date(startStr), end=new Date(endStr);
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1))
    out.push(d.toISOString().slice(0,10));
  return out;
}

// —————————————————————————————————
// Util: ISO → “Lunes DD/MM” en español
// —————————————————————————————————
function formatDateReadable(iso) {
  const d  = new Date(iso);
  const wd = d.toLocaleDateString("es-CL",{ weekday:"long" });
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}

// —————————————————————————————————
// Util: sumar 1 hora a un “HH:MM”
// —————————————————————————————————
function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h+1, m);
  return d.toTimeString().slice(0,5);
}
