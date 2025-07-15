// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase + Choices.js
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from
  'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import Choices from 'https://unpkg.com/choices.js@10.2.0/public/assets/scripts/choices.min.mjs';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias al DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");
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
const fldAdultos     = document.getElementById("m-adultos");
const fldEstudiantes = document.getElementById("m-estudiantes");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let editData    = null;   // { fecha, idx } cuando editamos
let choicesDias = null;   // instancia de Choices.js

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // 2.1) Cargo todos los grupos
  const snap   = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  // 2.2) Pueblan selects Nombre y N°
  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo}</option>`
  ).join('');

  // 2.3) Sincronizar selects y render inicial
  selectNum.onchange  = ()=>{ selectName.value=selectNum.value; renderItinerario(); };
  selectName.onchange = ()=>{ selectNum.value=selectName.value; renderItinerario(); };

  // 2.4) Configurar Quick-Add y Modal
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  // 2.5) Primera carga
  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario(): muestra días y actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data() || {};

  // 3.1) Título con programa (MAYÚSCULAS)
  titleGrupo.textContent = (g.programa || "–").toUpperCase();

  // 3.2) Si no existe `itinerario`, inicializo
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(f=> init[f]=[]);
    await updateDoc(refG,{ itinerario: init });
    g.itinerario = init;
  }

  // 3.3) Fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // 3.4) Inicializar / actualizar Choices.js
  const opts = fechas.map((d,i)=>({
    value: i,
    label: `Día ${i+1} – ${formatDateReadable(d)}`
  }));
  if (choicesDias) {
    choicesDias.clearChoices();
    choicesDias.setChoices(opts,'value','label',false);
  } else {
    choicesDias = new Choices(qaDia, {
      removeItemButton: true,
      placeholderValue: 'Selecciona día(s)',
      choices: opts
    });
  }

  // 3.5) Pueblar <select> del modal (MAYÚSCULAS en label)
  fldFecha.innerHTML = fechas
    .map(d=>
      `<option value="${d}">Día ${fechas.indexOf(d)+1} – ${formatDateReadable(d)}</option>`
    ).join('');

  // 3.6) Construir grilla de secciones por día
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML     = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    // botón interno → modal nuevo
    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    // Pinto actividades ordenadas por hora
    const ul  = sec.querySelector(".activity-list");
    const arr = (g.itinerario[fecha]||[]).slice()
      .sort((a,b)=> a.horaInicio.localeCompare(b.horaInicio));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach((act,i)=> {
        const li = document.createElement("li");
        li.className = "activity-card";
        li.innerHTML = `
          <h4>${act.horaInicio} – ${act.horaFin}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${act.pasajeros} pax (A:${act.adultos} E:${act.estudiantes})</p>
          <div class="actions">
            <button class="btn-edit" data-idx="${i}">✏️</button>
            <button class="btn-del"  data-idx="${i}">🗑️</button>
          </div>
        `;
        // editar
        li.querySelector(".btn-edit").onclick = ()=>
          openModal({ ...act, fecha, idx:i }, true);
        // borrar + historial
        li.querySelector(".btn-del").onclick = async ()=> {
          if (!confirm("¿Eliminar actividad?")) return;
          // antes: lista de descripciones
          const antes = arr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                           .join(' - ');
          arr.splice(i,1);
          // guardo
          await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
          // historial: BORRAR ACTIVIDAD
          const despues = arr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                             .join(' - ');
          await addDoc(collection(db,'historial'),{
            timestamp:      new Date(),
            modificadoPor:  auth.currentUser.email,
            numeroNegocio:  grupoId,
            accion:         'BORRAR ACTIVIDAD',
            campo:          'itinerario',
            anterior:       antes,
            nuevo:          despues
          });
          renderItinerario();
        };
        ul.appendChild(li);
      });
    }
  });
}

// —————————————————————————————————
// 4) quickAddActivity(): crea en varios días + historial
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = choicesDias.getValue(true); // [0,2,...]
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim().toUpperCase();
  if (!selIdx.length || !text) {
    return alert("Selecciona día(s) y escribe la actividad");
  }

  const refG   = doc(db,'grupos',grupoId);
  const snapG  = await getDoc(refG);
  const g      = snapG.data()||{};
  const fechas = Object.keys(g.itinerario)
                       .sort((a,b)=>new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const f    = fechas[idx];
    const arr  = g.itinerario[f]||[];
    const antes = arr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                     .join(' - ');
    const nuevaAct = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  (g.adultos||0)+(g.estudiantes||0),
      adultos:    g.adultos||0,
      estudiantes:g.estudiantes||0,
      notas:      ""
    };
    arr.push(nuevaAct);
    await updateDoc(refG, { [`itinerario.${f}`]: arr });
    const despues = arr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                       .join(' - ');
    // historial: CREAR ACTIVIDAD
    await addDoc(collection(db,'historial'),{
      timestamp:      new Date(),
      modificadoPor:  auth.currentUser.email,
      numeroNegocio:  grupoId,
      accion:         'CREAR ACTIVIDAD',
      campo:          'itinerario',
      anterior:       antes,
      nuevo:          despues
    });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): preparar formulario
// —————————————————————————————————
function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  // precarga valores (MAYÚSCULAS en texto)
  fldFecha.value       = data.fecha;
  fldHi.value          = data.horaInicio || "07:00";
  fldHf.value          = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value         = (data.actividad||"").toUpperCase();
  fldAdultos.value     = data.adultos    ?? (data.pasajeros||0);
  fldEstudiantes.value = data.estudiantes?? 0;
  fldNotas.value       = (data.notas||"").toUpperCase();

  // al cambiar horaInicio, auto-ajusto horaFin = +1h
  fldHi.onchange = ()=> fldHf.value = sumarUnaHora(fldHi.value);

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal(): cerrar formulario
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): crea o actualiza + historial
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();

  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10)||0;
  const e       = parseInt(fldEstudiantes.value,10)||0;
  const pax     = a + e;

  // validación: no exceder total de grupo
  const refG   = doc(db,'grupos',grupoId);
  const snapG  = await getDoc(refG);
  const g      = snapG.data()||{};
  const maxP   = (g.adultos||0)+(g.estudiantes||0);
  if (pax > maxP) {
    return alert(`Adultos+Estudiantes (${pax}) excede total del grupo (${maxP}).`);
  }

  // payload
  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim().toUpperCase(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value.trim().toUpperCase()
  };

  // carga array existente
  const arr = g.itinerario[fecha] || [];
  let antes, despues;

  if (editData) {
    // **EDICIÓN** (posible cambio de fecha)
    const origFecha = editData.fecha;
    const origIdx   = editData.idx;
    const origArr   = [...(g.itinerario[origFecha]||[])];

    // lista antes en origen
    antes = origArr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                   .join(' - ');

    // si cambió de día, quito de origen
    if (origFecha !== fecha) {
      origArr.splice(origIdx,1);
      await updateDoc(refG, { [`itinerario.${origFecha}`]: origArr });
    } else {
      // solo reemplazo
      origArr[origIdx] = payload;
      await updateDoc(refG, { [`itinerario.${origFecha}`]: origArr });
    }

    // ahora la lista después en destino
    const destArr = [...(g.itinerario[fecha]||[])];
    if (origFecha !== fecha) {
      destArr.push(payload);
      await updateDoc(refG, { [`itinerario.${fecha}`]: destArr });
    }
    despues = destArr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                     .join(' - ');

    // acción
    await addDoc(collection(db,'historial'),{
      timestamp:      new Date(),
      modificadoPor:  auth.currentUser.email,
      numeroNegocio:  grupoId,
      accion:         'EDITAR ACTIVIDAD',
      campo:          'itinerario',
      anterior:       antes,
      nuevo:          despues
    });

  } else {
    // **CREAR** un nuevo payload
    antes = arr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
               .join(' - ');  // vacío si no hay
    arr.push(payload);
    await updateDoc(refG, { [`itinerario.${fecha}`]: arr });
    despues = arr.map(a=>`${a.horaInicio}-${a.horaFin}: ${a.actividad}`)
                 .join(' - ');
    await addDoc(collection(db,'historial'),{
      timestamp:      new Date(),
      modificadoPor:  auth.currentUser.email,
      numeroNegocio:  grupoId,
      accion:         'CREAR ACTIVIDAD',
      campo:          'itinerario',
      anterior:       antes,
      nuevo:          despues
    });
  }

  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// UTIL: rango de fechas ISO inclusive
// —————————————————————————————————
function getDateRange(startStr,endStr) {
  const out = [];
  for (let d=new Date(startStr); d<=new Date(endStr); d.setDate(d.getDate()+1)) {
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

// —————————————————————————————————
// UTIL: "Lunes DD/MM" en español
// —————————————————————————————————
function formatDateReadable(iso) {
  const d  = new Date(iso);
  const wd = d.toLocaleDateString("es-CL",{ weekday:"long" });
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd}/${mm}`;
}

// —————————————————————————————————
// UTIL: sumar 1 hora a "HH:MM"
// —————————————————————————————————
function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d     = new Date();
  d.setHours(h+1,m);
  return d.toTimeString().slice(0,5);
}
