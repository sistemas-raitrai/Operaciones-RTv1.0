// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs,
  doc, getDoc, updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");
const qaHoraInicio   = document.getElementById("qa-horaInicio");
const qaAct          = document.getElementById("qa-actividad");
const qaAddBtn       = document.getElementById("qa-add");

const btnGuardarTpl  = document.getElementById("btnGuardarTpl");
const btnCargarTpl   = document.getElementById("btnCargarTpl");
const selPlantillas  = document.getElementById("sel-plantillas");

const modalBg        = document.getElementById("modal-backdrop");
const modal          = document.getElementById("modal");
const formModal      = document.getElementById("modal-form");
const fldFecha       = document.getElementById("m-fecha");
const fldHi          = document.getElementById("m-horaInicio");
const fldHf          = document.getElementById("m-horaFin");
const fldAct         = document.getElementById("m-actividad");
const fldAdultos     = document.getElementById("m-adultos");
const fldEstudiantes = document.getElementById("m-estudiantes");
const fldPax         = document.getElementById("m-pax");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let editData    = null;   // { fecha, idx }
let choicesDias = null;   // Choices.js instance
let choicesGrupoNum = null;  // Choices para selectNum (número de negocio)
let choicesGrupoNom = null;  // Choices para selectName (nombre de grupo)

// —————————————————————————————————
// Función global para sumar numéricamente
// —————————————————————————————————
function actualizarPax() {
  const a = parseInt(fldAdultos.value, 10) || 0;
  const e = parseInt(fldEstudiantes.value, 10) || 0;
  fldPax.value = a + e;
}
fldAdultos.addEventListener('input', actualizarPax);
fldEstudiantes.addEventListener('input', actualizarPax);

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
  
  // 2.2) Poblamos selects
  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo.toUpperCase()}</option>`
  ).join('');
  
  // 2.2.1) Inicializa Choices.js para autocompletar/búsqueda (solo una vez)
  if (!choicesGrupoNum) {
    choicesGrupoNum = new Choices(selectNum, {
      searchEnabled: true,
      itemSelectText: '',
      placeholderValue: 'Buscar número de negocio',
      shouldSort: false
    });
  } else {
    choicesGrupoNum.setChoices(grupos.map(g=>({value: g.id, label: g.numeroNegocio})), 'value', 'label', true);
  }
  
  if (!choicesGrupoNom) {
    choicesGrupoNom = new Choices(selectName, {
      searchEnabled: true,
      itemSelectText: '',
      placeholderValue: 'Buscar nombre de grupo',
      shouldSort: false
    });
  } else {
    choicesGrupoNom.setChoices(grupos.map(g=>({value: g.id, label: g.nombreGrupo.toUpperCase()})), 'value', 'label', true);
  }
  
    // 2.3) Sincronizo ambos Choices.js
    choicesGrupoNum.passedElement.element.onchange = () => {
      choicesGrupoNom.setChoiceByValue(selectNum.value);
      renderItinerario();
    };
    choicesGrupoNom.passedElement.element.onchange = () => {
      choicesGrupoNum.setChoiceByValue(selectName.value);
      renderItinerario();
    };
  
    // 2.4) Quick-Add, Modal y Plantillas
    qaAddBtn.onclick   = quickAddActivity;
    btnCancel.onclick  = closeModal;
    formModal.onsubmit = onSubmitModal;
    btnGuardarTpl.onclick = guardarPlantilla;
    btnCargarTpl.onclick  = cargarPlantilla;
    await cargarListaPlantillas();
  
    // 2.5) Primera carga
    selectNum.dispatchEvent(new Event('change'));
  }

// —————————————————————————————————
// 3) renderItinerario(): crea grilla y pinta actividades
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data() || {};

  // Título
  titleGrupo.textContent = (g.programa||"–").toUpperCase();

  // Preparo autocomplete
  await prepararCampoActividad("qa-actividad", g.destino);

  // Inicializo itinerario si no existe
  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init  = {};
    rango.forEach(d=> init[d]=[]);
    await updateDoc(doc(db,'grupos',grupoId),{ itinerario:init });
    g.itinerario = init;
  }

  // Fechas ordenadas
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  // Choices.js multi-select
  const opts = fechas.map((d,i)=>({
    value: i, label: `Día ${i+1} – ${formatDateReadable(d)}`
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

  // Select para modal
  fldFecha.innerHTML = fechas
    .map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`)
    .join('');

  // Pinto cada día
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    const [yyyy, mm, dd] = fecha.split('-').map(Number);
    const d = new Date(yyyy, mm - 1, dd);  // constructor en zona local
    if (d.getDay() === 0) 
      sec.classList.add('domingo');

    sec.innerHTML = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);

    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    const ul  = sec.querySelector(".activity-list");
    // 1) Array original y auxiliar con su índice real
    const original = g.itinerario[fecha] || [];
    const withIndex = original.map((act, idx) => ({ act, originalIdx: idx }));
    
    // 2) Array ordenado solo para mostrar, sin alterar el original
    const sorted = withIndex.slice().sort((a, b) =>
      a.act.horaInicio.localeCompare(b.act.horaInicio)
    );
    
    if (!sorted.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      sorted.forEach(({ act, originalIdx }) => {
        const li = document.createElement("li");
        li.className = "activity-card";
        const paxCalc = (parseInt(act.adultos, 10) || 0)
                      + (parseInt(act.estudiantes, 10) || 0);
    
        li.innerHTML = `
          <h4>${act.horaInicio} – ${act.horaFin}</h4>
          <p><strong>${act.actividad}</strong></p>
          <p>👥 ${paxCalc} pax (A:${act.adultos} E:${act.estudiantes})</p>
          <div class="actions">
            <button class="btn-edit">✏️</button>
            <button class="btn-del">🗑️</button>
          </div>
        `;
    
        // Editar usando originalIdx
        li.querySelector(".btn-edit")
          .onclick = () => openModal({ ...act, fecha, idx: originalIdx }, true);
    
        // Borrar usando originalIdx
        li.querySelector(".btn-del")
          .onclick = async () => {
            if (!confirm("¿Eliminar actividad?")) return;
            // Registro en historial (opcional)
            await addDoc(collection(db, 'historial'), {
              numeroNegocio: grupoId,
              accion:        'BORRAR ACTIVIDAD',
              anterior:      original.map(a => a.actividad).join(' – '),
              nuevo:         '',
              usuario:       auth.currentUser.email,
              timestamp:     new Date()
            });
            // Elimino del array original en la posición correcta
            original.splice(originalIdx, 1);
            await updateDoc(doc(db, 'grupos', grupoId), {
              [`itinerario.${fecha}`]: original
            });
            renderItinerario();
          };
    
        ul.appendChild(li);
      });
    }
        
  });     // ← cierra fechas.forEach

} 

// —————————————————————————————————
// 4) quickAddActivity(): añade en varios días
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId    = selectNum.value;
  const selIdx     = choicesDias.getValue(true);
  const horaInicio = qaHoraInicio.value;
  const text       = qaAct.value.trim().toUpperCase();
  if (!selIdx.length || !text) {
    return alert("Selecciona día(s) y escribe la actividad");
  }

  // –– Parséo numérico de pax del grupo:
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};
  const totalAdults   = parseInt(g.adultos, 10)     || 0;
  const totalStudents = parseInt(g.estudiantes, 10) || 0;

  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const f   = fechas[idx];
    const arr = g.itinerario[f]||[];

    const item = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  text,
      pasajeros:  totalAdults + totalStudents,  // ahora suma numérica
      adultos:    totalAdults,
      estudiantes:totalStudents,
      notas:      ""
    };

    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'CREAR ACTIVIDAD',
      anterior:      '',
      nuevo:         item.actividad,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });

    arr.push(item);
    await updateDoc(doc(db,'grupos',grupoId), {
      [`itinerario.${f}`]: arr
    });
  }

  qaAct.value = "";
  renderItinerario();
}

// —————————————————————————————————
// 5) openModal(): precarga datos en el modal
// —————————————————————————————————
async function openModal(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById("modal-title")
          .textContent = isEdit ? "Editar actividad" : "Nueva actividad";

  const snapG = await getDoc(doc(db,"grupos",selectNum.value));
  const g     = snapG.data()||{};
  // —– Parséo numérico de totales:
  const totalAdults   = parseInt(g.adultos, 10)     || 0;
  const totalStudents = parseInt(g.estudiantes, 10) || 0;

  fldFecha.value    = data.fecha;
  fldHi.value       = data.horaInicio || "07:00";
  fldHf.value       = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value      = data.actividad  || "";
  await prepararCampoActividad("m-actividad", g.destino);
  fldNotas.value    = data.notas      || "";

  if (isEdit) {
    fldAdultos.value     = data.adultos     ?? totalAdults;
    fldEstudiantes.value = data.estudiantes ?? totalStudents;
  } else {
    fldAdultos.value     = totalAdults;
    fldEstudiantes.value = totalStudents;
  }
  actualizarPax();

  fldHi.onchange = () => {
    fldHf.value = sumarUnaHora(fldHi.value);
  };

  modalBg.style.display = modal.style.display = "block";
}

// —————————————————————————————————
// 6) closeModal(): cierra el modal
// —————————————————————————————————
function closeModal() {
  modalBg.style.display = modal.style.display = "none";
}

// —————————————————————————————————
// 7) onSubmitModal(): guarda o actualiza y registra historial
// —————————————————————————————————
async function onSubmitModal(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const fecha   = fldFecha.value;
  const a       = parseInt(fldAdultos.value,10) || 0;
  const e       = parseInt(fldEstudiantes.value,10) || 0;
  const pax     = parseInt(fldPax.value,10)       || 0;

  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};
  // valida maxP con parseInt
  const maxP  = (parseInt(g.adultos,10)||0) + (parseInt(g.estudiantes,10)||0);
  if (pax > maxP) {
    return alert(`Adultos+Estudiantes (${pax}) no puede exceder total de grupo (${maxP}).`);
  }

  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  fldAct.value.trim().toUpperCase(),
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      fldNotas.value.trim().toUpperCase()
  };

  const arr = (g.itinerario?.[fecha]||[]).slice();

  if (editData) {
    const antes   = arr.map(x=>x.actividad).join(' – ');
    arr[editData.idx] = payload;
    const despues = arr.map(x=>x.actividad).join(' – ');
    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'MODIFICAR ACTIVIDAD',
      anterior:      antes,
      nuevo:         despues,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });
  } else {
    arr.push(payload);
    await addDoc(collection(db,'historial'), {
      numeroNegocio: grupoId,
      accion:        'CREAR ACTIVIDAD',
      anterior:      '',
      nuevo:         payload.actividad,
      usuario:       auth.currentUser.email,
      timestamp:     new Date()
    });
  }

  await updateDoc(doc(db,'grupos',grupoId), {
    [`itinerario.${fecha}`]: arr
  });
  closeModal();
  renderItinerario();
}

// —————————————————————————————————
// Utilidades de fecha y hora
// —————————————————————————————————
function getDateRange(startStr, endStr) {
  const out = [];
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()     ).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}

function formatDateReadable(isoStr) {
  const [yyyy, mm, dd] = isoStr.split('-').map(Number);
  const d  = new Date(yyyy, mm - 1, dd);
  const wd = d.toLocaleDateString("es-CL", { weekday: "long" });
  const dayName = wd.charAt(0).toUpperCase() + wd.slice(1);
  const ddp = String(dd).padStart(2, '0');
  const mmp = String(mm).padStart(2, '0');
  return `${dayName} ${ddp}/${mmp}`;
}  // ← ¡Cierre de formato de función aquí!

function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h+1, m);
  return d.toTimeString().slice(0,5);
}

// —————————————————————————————————
// Plantillas: guardar
// —————————————————————————————————
async function guardarPlantilla() {
  const nombre = prompt("Nombre de la plantilla:");
  if (!nombre) return;
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const g       = snapG.data()||{};

  // Guardar como objeto por día
  const actividadesPorDia = {};
  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));
  fechas.forEach((fecha, idx) => {
    actividadesPorDia[`dia${idx+1}`] =
      (g.itinerario[fecha]||[]).map(act => ({
        horaInicio: act.horaInicio,
        horaFin:    act.horaFin,
        actividad:  act.actividad,
        notas:      act.notas
      }));
  });

  await addDoc(collection(db,'plantillasItinerario'), {
    nombre,
    creador:   auth.currentUser.email,
    createdAt: new Date(),
    dias: actividadesPorDia  // Ahora es objeto, no array de arrays
  });
  alert("Plantilla guardada");
  await cargarListaPlantillas();
}

// —————————————————————————————————
// Función para cargar las plantillas en el select
// —————————————————————————————————
async function cargarListaPlantillas() {
  selPlantillas.innerHTML = "";
  const snap = await getDocs(collection(db, 'plantillasItinerario'));
  snap.docs.forEach(d => {
    const data = d.data();
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = data.nombre;
    selPlantillas.appendChild(opt);
  });
}

// ——— CARGAR PLANTILLA ———
async function cargarPlantilla() {
  const tplId = selPlantillas.value;
  if (!tplId) return alert("Selecciona una plantilla");

  const [tplSnap, grpSnap] = await Promise.all([
    getDoc(doc(db, 'plantillasItinerario', tplId)),
    getDoc(doc(db, 'grupos', selectNum.value))
  ]);
  if (!tplSnap.exists()) return alert("Plantilla no encontrada");

  const diasPlantilla = tplSnap.data().dias;
  const g   = grpSnap.data() || {};

  const fechas = Object.keys(g.itinerario || {})
    .sort((a,b)=> new Date(a)-new Date(b));

  const ok = confirm(
    "¿Seguro que quieres cargar un nuevo itinerario?\n" +
    "Pulsa [OK] para continuar, [Cancelar] para volver al editor."
  );
  if (!ok) return;
  const reemplazar = confirm(
    "Pulsa [OK] para REEMPLAZAR todas las actividades,\n" +
    "[Cancelar] para AGREGAR las de la plantilla al itinerario actual."
  );

  const nuevoIt = {};
  if (reemplazar) {
    fechas.forEach((fecha, idx) => {
      const acts = Array.isArray(diasPlantilla[`dia${idx+1}`]) ? diasPlantilla[`dia${idx+1}`] : [];
      nuevoIt[fecha] = acts.map(act => ({
        ...act,
        pasajeros:   (g.adultos||0) + (g.estudiantes||0),
        adultos:     g.adultos || 0,
        estudiantes: g.estudiantes || 0
      }));
    });
  } else {
    for (const fecha in g.itinerario) {
      nuevoIt[fecha] = (g.itinerario[fecha]||[]).slice();
    }
    fechas.forEach((fecha, idx) => {
      const extras = Array.isArray(diasPlantilla[`dia${idx+1}`]) ? diasPlantilla[`dia${idx+1}`] : [];
      nuevoIt[fecha] = (nuevoIt[fecha]||[]).concat(
        extras.map(act => ({
          ...act,
          pasajeros:   (g.adultos||0) + (g.estudiantes||0),
          adultos:     g.adultos || 0,
          estudiantes: g.estudiantes || 0
        }))
      );
    });
  }

  await updateDoc(doc(db, 'grupos', selectNum.value), { itinerario: nuevoIt });
  renderItinerario();
}


// —————————————————————————————————
// Autocomplete de actividades
// —————————————————————————————————
async function obtenerActividadesPorDestino(destino) {
  if (!destino) return [];
  const colecServicios = "Servicios";
  const colecListado   = "Listado";
  // el destino puede tener varios separados por “ Y ”
  const partes = destino.toString()
    .split(/\s+Y\s+/i)
    .map(s => s.trim().toUpperCase());
  const todas = [];
  for (const parte of partes) {
    const ref = collection(db, colecServicios, parte, colecListado);
    try {
      const snap = await getDocs(ref);
      snap.docs.forEach(ds =>
        todas.push((ds.data().nombre || ds.id).toUpperCase())
      );
    } catch (e) {
      // si no existe esa sub-colección, ignoramos
    }
  }
  // sin duplicados y ordenado
  return [...new Set(todas)].sort();
}

async function prepararCampoActividad(inputId, destino) {
  const input = document.getElementById(inputId);
  const acts  = await obtenerActividadesPorDestino(destino);
  // elimino el datalist anterior si existía
  const oldList = document.getElementById("lista-" + inputId);
  if (oldList) oldList.remove();

  // creo uno nuevo
  const dl = document.createElement("datalist");
  dl.id = "lista-" + inputId;
  acts.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a;
    dl.appendChild(opt);
  });
  document.body.appendChild(dl);
  input.setAttribute("list", "lista-" + inputId);
}

// —————————————————————————————————
// Calendario modal
// —————————————————————————————————
document.getElementById("btnAbrirCalendario")
  .addEventListener("click", () => {
    const grupoTxt = selectNum
      .options[selectNum.selectedIndex]
      .text;
    if (!selectNum.value) {
      return alert("Selecciona un grupo");
    }
    const iframe = document.getElementById("iframe-calendario");
    iframe.src = `calendario.html?busqueda=${encodeURIComponent(grupoTxt)}`;
    document.getElementById("modal-calendario").style.display   = "block";
    document.getElementById("modal-backdrop").style.display    = "block";
  });

window.cerrarCalendario = () => {
  document.getElementById("modal-calendario").style.display   = "none";
  document.getElementById("modal-backdrop").style.display    = "none";
  document.getElementById("iframe-calendario").src           = "";
};

