// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs,
  doc, getDoc, updateDoc, addDoc, deleteDoc
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

let editData    = null;   // { fecha, idx, ...act }
let choicesDias = null;   // Choices.js instance
let choicesGrupoNum = null;  // Choices para selectNum (número de negocio)
let choicesGrupoNom = null;  // Choices para selectName (nombre de grupo)
let editMode     = false;  // indica si estamos en modo edición
let swapOrigin   = null;   // punto de partida para intercambio


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
    `<option value="${g.id}">${(g.nombreGrupo||'').toString().toUpperCase()}</option>`
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
    choicesGrupoNom.setChoices(grupos.map(g=>({value: g.id, label: (g.nombreGrupo||'').toString().toUpperCase()})), 'value', 'label', true);
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

// ————— Botón Activar/Desactivar edición —————
const btnToggleEdit = document.getElementById("btnToggleEdit");
btnToggleEdit.onclick = () => {
  editMode = !editMode;
  btnToggleEdit.textContent = editMode ? "🔒 Desactivar edición" : "🔓 Activar edición";
  // deshabilitamos Quick-Add y modal para evitar conflictos
  document.getElementById("quick-add").style.display = editMode ? "none" : "";
  btnGuardarTpl.disabled = editMode;
  btnCargarTpl.disabled  = editMode;
  renderItinerario();
};


// —————————————————————————————————
// Autocomplete de actividades (para inputs)
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
        todas.push(((ds.data().nombre || ds.data().servicio || ds.id) || '').toString().toUpperCase())
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


// ======================================================
// NUEVO — Catálogo de servicios por destino (con alias)
// ======================================================
async function getServiciosMaps(destinoStr) {
  const partes = destinoStr
    ? destinoStr.toString().split(/\s+Y\s+/i).map(s => s.trim().toUpperCase())
    : [];
  const byId = new Map();    // idDoc  -> { id, destino, nombre, data }
  const byName = new Map();  // NOMBRE -> { id, destino, nombre, data }

  for (const parte of partes) {
    try {
      const snap = await getDocs(collection(db, 'Servicios', parte, 'Listado'));
      snap.forEach(ds => {
        const id = ds.id;
        const data = ds.data() || {};
        // Nombre visible: prioriza `nombre`, luego `servicio`, luego id
        const visible = ((data.nombre || data.servicio || id) || '').toString().toUpperCase();

        const pack = { id, destino: parte, nombre: visible, data };
        byId.set(id, pack);
        byName.set(visible, pack);

        // Si usas alias en Servicios (array), también mapéalos:
        if (Array.isArray(data.aliases)) {
          data.aliases.forEach(a => {
            const k = (a || '').toString().toUpperCase();
            if (k) byName.set(k, pack);
          });
        }
      });
    } catch (e) {
      // Si el destino no existe aún, lo ignoramos
    }
  }
  return { byId, byName };
}

// ===================================================================
// NUEVO — Sincroniza actividades del itinerario con la colección Servicios
// - Devuelve { it: objetoItinerarioActualizado, changed: boolean }
// - Si detecta diferencias, actualiza Firestore UNA sola vez.
// ===================================================================
async function syncItinerarioServicios(grupoId, g, svcMaps) {
  const it = g.itinerario || {};
  const fechas = Object.keys(it).sort((a,b)=> new Date(a) - new Date(b));

  let hayCambios = false;
  const nuevo = {};

  for (const f of fechas) {
    const arr = (it[f] || []);
    const nuevoArr = arr.map(act => {
      const res = { ...act };
      const keyName = (res.actividad || '').toString().toUpperCase();

      // 1) Si tiene servicioId y existe → tomar nombre vigente
      if (res.servicioId && svcMaps.byId.has(res.servicioId)) {
        const sv = svcMaps.byId.get(res.servicioId);
        if (res.actividad !== sv.nombre || res.servicioNombre !== sv.nombre || res.servicioDestino !== sv.destino) {
          res.actividad = sv.nombre;
          res.servicioNombre = sv.nombre;
          res.servicioDestino = sv.destino;
          hayCambios = true;
        }
      } else {
        // 2) Resolver por nombre actual (y fijar el id si lo encontramos)
        if (svcMaps.byName.has(keyName)) {
          const sv = svcMaps.byName.get(keyName);
          if (res.servicioId !== sv.id || res.servicioNombre !== sv.nombre || res.servicioDestino !== sv.destino) {
            res.servicioId = sv.id;
            res.servicioNombre = sv.nombre;
            res.servicioDestino = sv.destino;
            res.actividad = sv.nombre; // alinear texto mostrado
            hayCambios = true;
          }
        }
      }
      return res;
    });

    nuevo[f] = nuevoArr;
  }

  if (hayCambios) {
    await updateDoc(doc(db,'grupos',grupoId), { itinerario: nuevo });
  }
  return { it: hayCambios ? nuevo : it, changed: hayCambios };
}


// —————————————————————————————————
// 3) renderItinerario(): crea grilla y pinta actividades (SINCRONIZADA)
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

  // ====== NUEVO: traigo el catálogo y sincronizo ======
  const svcMaps = await getServiciosMaps(g.destino || '');
  const syncRes = await syncItinerarioServicios(grupoId, g, svcMaps);
  const IT = syncRes.it; // itinerario ya sincronizado en memoria (y DB si hizo falta)

  // Fechas ordenadas
  const fechas = Object.keys(IT)
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

  // Helper para crear un elemento con clase y texto
  function createBtn(icon, cls) {
    const b = document.createElement("span");
    b.className = cls;
    b.textContent = icon;
    b.style.cursor = "pointer";
    return b;
  }

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

    if (editMode) {
      // 1) Añadimos iconos al <h3> para swap-dia y editar fecha
      const h3 = sec.querySelector("h3");
      const btnSwapDay = createBtn("🔄", "btn-swap-day");
      const btnEditDate = createBtn("✏️", "btn-edit-date");
      btnSwapDay.dataset.fecha = fecha;
      btnEditDate.dataset.fecha = fecha;
      h3.appendChild(btnSwapDay);
      h3.appendChild(btnEditDate);
    
      // 2) Handler intercambio de días
      btnSwapDay.onclick = () => handleSwapClick("dia", fecha);
      // 3) Handler edición de fecha
      btnEditDate.onclick = () => handleDateEdit(fecha);
    }
   
    contItinerario.appendChild(sec);

    sec.querySelector(".btn-add")
       .onclick = ()=> openModal({ fecha }, false);

    const ul  = sec.querySelector(".activity-list");
    // 1) Array original y auxiliar con su índice real
    const original = IT[fecha] || [];
    const withIndex = original.map((act, idx) => ({ act, originalIdx: idx }));
    
    // 2) Array ordenado solo para mostrar, sin alterar el original
    const sorted = withIndex.slice().sort((a, b) =>
      ((a.act.horaInicio||'').localeCompare(b.act.horaInicio||''))
    );
    
    // 👇 VALORES CENTRALIZADOS DESDE EL GRUPO
    const A = parseInt(g.adultos, 10) || 0;
    const E = parseInt(g.estudiantes, 10) || 0;
    const totalGrupo = (() => {
      const t = parseInt(g.cantidadgrupo, 10);
      return Number.isFinite(t) ? t : (A + E);
    })();
    
    if (!sorted.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      sorted.forEach(({ act, originalIdx }) => {
        // Nombre visible resuelto en vivo
        let visibleName = act.actividad || '';
        if (act.servicioId && svcMaps.byId.has(act.servicioId)) {
          visibleName = svcMaps.byId.get(act.servicioId).nombre;
        } else {
          const key = (act.actividad || '').toString().toUpperCase();
          if (svcMaps.byName.has(key)) {
            visibleName = svcMaps.byName.get(key).nombre;
          }
        }

        const li = document.createElement("li");
        li.className = "activity-card";
    
        li.innerHTML = `
          <h4>${act.horaInicio || '--:--'} – ${act.horaFin || '--:--'}</h4>
          <p><strong>${visibleName}</strong></p>
          <p>👥 ${totalGrupo} pax (A:${A} E:${E})</p>
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
            await addDoc(collection(db, 'historial'), {
              numeroNegocio: grupoId,
              accion:        'BORRAR ACTIVIDAD',
              anterior:      original.map(a => a.actividad).join(' – '),
              nuevo:         '',
              usuario:       auth.currentUser.email,
              timestamp:     new Date()
            });
            original.splice(originalIdx, 1);
            await updateDoc(doc(db, 'grupos', grupoId), {
              [`itinerario.${fecha}`]: original
            });
            renderItinerario();
          };
    
        if (editMode) {
          const btnSwapAct = createBtn("🔄", "btn-swap-act");
          btnSwapAct.dataset.fecha = fecha;
          btnSwapAct.dataset.idx   = originalIdx;
          li.querySelector(".actions").appendChild(btnSwapAct);
          btnSwapAct.onclick = () => handleSwapClick("actividad", { fecha, idx: originalIdx });
        }
    
        ul.appendChild(li);
      });
    }
  });     // ← cierra fechas.forEach

} 

// —————————————————————————————————
// 4) quickAddActivity(): añade en varios días (ENLAZANDO SERVICIO)
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

  // Resolver servicio por destino
  const svcMaps = await getServiciosMaps(g.destino || '');
  const key = text.toUpperCase();
  const sv  = svcMaps.byName.get(key) || null;

  const fechas = Object.keys(g.itinerario)
    .sort((a,b)=> new Date(a)-new Date(b));

  for (let idx of selIdx) {
    const f   = fechas[idx];
    const arr = g.itinerario[f]||[];

    const item = {
      horaInicio,
      horaFin:    sumarUnaHora(horaInicio),
      actividad:  sv ? sv.nombre : text,   // nombre vigente si existe
      pasajeros:  totalAdults + totalStudents,  // suma numérica
      adultos:    totalAdults,
      estudiantes:totalStudents,
      notas:      "",
      // Enlace al servicio
      servicioId:       sv ? sv.id : null,
      servicioNombre:   sv ? sv.nombre : null,
      servicioDestino:  sv ? sv.destino : null
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
  // —– Parséo numérico desde el GRUPO (no desde la actividad)
  const A = parseInt(g.adultos, 10) || 0;
  const E = parseInt(g.estudiantes, 10) || 0;
  const T = (() => {
    const t = parseInt(g.cantidadgrupo, 10);
    return Number.isFinite(t) ? t : (A + E);
  })();
  
  fldFecha.value    = data.fecha;
  fldHi.value       = data.horaInicio || "07:00";
  fldHf.value       = data.horaFin    || sumarUnaHora(fldHi.value);
  fldAct.value      = data.actividad  || "";
  await prepararCampoActividad("m-actividad", g.destino);
  fldNotas.value    = data.notas      || "";
  
  // 👇 SIEMPRE precargar desde el GRUPO
  fldAdultos.value     = A;
  fldEstudiantes.value = E;
  fldPax.value         = T;
  
  // Cuando cambia la hora de inicio, ajusta fin
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
// 7) onSubmitModal(): guarda o actualiza y registra historial (ENLAZANDO SERVICIO)
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

  const suma = a + e;
  if (pax !== suma) {
    return alert(`La suma Adultos (${a}) + Estudiantes (${e}) = ${suma} debe ser igual a Total (${pax}).`);
    }
  if (a < 0 || e < 0 || pax < 0) {
    return alert("Los valores no pueden ser negativos.");
  }

  // Resolver servicio por destino, en base al texto del modal
  const svcMaps = await getServiciosMaps(g.destino || '');
  const typedName = (fldAct.value || '').trim().toUpperCase();
  const sv = svcMaps.byName.get(typedName) || null;

  const payload = {
    horaInicio: fldHi.value,
    horaFin:    fldHf.value,
    actividad:  sv ? sv.nombre : typedName,  // nombre vigente si existe
    pasajeros:  pax,
    adultos:    a,
    estudiantes:e,
    notas:      (fldNotas.value || '').trim().toUpperCase(),
    // Enlace al servicio
    servicioId:       sv ? sv.id : (editData?.servicioId || null),
    servicioNombre:   sv ? sv.nombre : (editData?.servicioNombre || null),
    servicioDestino:  sv ? sv.destino : (editData?.servicioDestino || null)
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
    adultos: a,
    estudiantes: e,
    cantidadgrupo: pax,         // 👈 total centralizado
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
  const [sy, sm, sd] = (startStr||'').split("-").map(Number);
  const [ey, em, ed] = (endStr||'').split("-").map(Number);
  if (!sy || !ey) return out;
  const start = new Date(sy, sm - 1, sd || 1);
  const end   = new Date(ey, em - 1, ed || 1);
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
}

function sumarUnaHora(hhmm) {
  const [h,m] = (hhmm||'00:00').split(":").map(Number);
  const d = new Date();
  d.setHours((h||0)+1, (m||0));
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
  const fechas = Object.keys(g.itinerario || {})
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
    dias: actividadesPorDia  // objeto por día
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
    const data = d.data() || {};
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = data.nombre || d.id;
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

  const diasPlantilla = tplSnap.data().dias || {};
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
        pasajeros:   (parseInt(g.adultos,10)||0) + (parseInt(g.estudiantes,10)||0),
        adultos:     parseInt(g.adultos,10) || 0,
        estudiantes: parseInt(g.estudiantes,10) || 0
      }));
    });
  } else {
    for (const fecha in g.itinerario || {}) {
      nuevoIt[fecha] = (g.itinerario[fecha]||[]).slice();
    }
    fechas.forEach((fecha, idx) => {
      const extras = Array.isArray(diasPlantilla[`dia${idx+1}`]) ? diasPlantilla[`dia${idx+1}`] : [];
      nuevoIt[fecha] = (nuevoIt[fecha]||[]).concat(
        extras.map(act => ({
          ...act,
          pasajeros:   (parseInt(g.adultos,10)||0) + (parseInt(g.estudiantes,10)||0),
          adultos:     parseInt(g.adultos,10) || 0,
          estudiantes: parseInt(g.estudiantes,10) || 0
        }))
      );
    });
  }

  await updateDoc(doc(db, 'grupos', selectNum.value), { itinerario: nuevoIt });
  renderItinerario();
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

// Manejador de clics de swap (actividad o día)
async function handleSwapClick(type, info) {
  // 1) Si no hay origen, lo registramos y resaltamos
  if (!swapOrigin) {
    swapOrigin = { type, info };
    const fechaKey = (typeof info === 'string') ? info : info.fecha;
    const el = document.querySelector(`[data-fecha="${fechaKey}"]`);
    if (el) el.classList.add("swap-selected");
    return;
  }
  // 2) Si el tipo no coincide, ignorar y resetear
  if (swapOrigin.type !== type) {
    alert("Debe intercambiar dos elementos del mismo tipo.");
    resetSwap();
    return;
  }
  // 3) Ejecutar intercambio
  const grupoId = selectNum.value;
  const snapG   = await getDoc(doc(db,'grupos',grupoId));
  const it      = { ...(snapG.data().itinerario || {}) };
  
  if (type === "dia") {
    const f1 = (typeof swapOrigin.info === 'string') ? swapOrigin.info : swapOrigin.info.fecha;
    const f2 = (typeof info === 'string') ? info : info.fecha;
    [ it[f1], it[f2] ] = [ it[f2], it[f1] ];  // swap arrays
  } else {
    // actividad ↔ actividad
    const { fecha: f1, idx: i1 } = swapOrigin.info;
    const { fecha: f2, idx: i2 } = info;
    [ it[f1][i1], it[f2][i2] ] = [ it[f2][i2], it[f1][i1] ];
  }
  
  await updateDoc(doc(db,'grupos',grupoId), { itinerario: it });
  resetSwap();
  renderItinerario();
}

// Limpia el estado de swap y quita resaltados
function resetSwap() {
  swapOrigin = null;
  document.querySelectorAll(".swap-selected")
    .forEach(el => el.classList.remove("swap-selected"));
}

// Editar fecha base (recalcula el rango consecutivo)
async function handleDateEdit(oldFecha) {
  const nueva1 = prompt("Nueva fecha para este día (YYYY-MM-DD):", oldFecha);
  if (!nueva1) return;

  const grupoId = selectNum.value;
  if (!grupoId) {
    alert("Selecciona primero un grupo.");
    return;
  }
  const snapG = await getDoc(doc(db, 'grupos', grupoId));
  const g     = snapG.data();

  const fechas = Object.keys(g.itinerario || {})
    .sort((a, b) => new Date(a) - new Date(b));

  const diasCount = fechas.length;
  const newRango  = [];
  const [yy, mm, dd] = nueva1.split("-").map(Number);
  for (let i = 0; i < diasCount; i++) {
    const d = new Date(yy, mm - 1, dd);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const m2   = String(d.getMonth() + 1).padStart(2, "0");
    const d2   = String(d.getDate()     ).padStart(2, "0");
    newRango.push(`${yyyy}-${m2}-${d2}`);
  }

  const newIt = {};
  fechas.forEach((fAnt, idx) => {
    newIt[newRango[idx]] = g.itinerario[fAnt];
  });

  await updateDoc(doc(db, 'grupos', grupoId), { itinerario: newIt });
  renderItinerario();
}


// ===== MIGRACIÓN OPCIONAL: sincronizar TODOS los itinerarios con Servicios =====
// Pégalo (ya está pegado aquí), recarga la página logueado y ejecútalo en consola:
//   syncAllItinerariosConServicios(4)   // 4 = nivel de concurrencia sugerido
// Luego puedes eliminar este bloque si ya no lo necesitas.
window.syncAllItinerariosConServicios = async function(limit = 3){
  const qs = await getDocs(collection(db,'grupos'));
  const grupos = qs.docs.map(d => ({ id: d.id, ...d.data() }));
  let ok=0, changed=0, fail=0;

  async function worker(g) {
    try {
      const svcMaps = await getServiciosMaps(g.destino || '');
      const res = await syncItinerarioServicios(g.id, g, svcMaps);
      ok++; if (res.changed) changed++;
      console.log(`✓ ${g.id} (${g.nombreGrupo || g.numeroNegocio || ''}) ${res.changed ? '— actualizado' : ''}`);
    } catch(e) {
      fail++; console.error(`✗ ${g.id}`, e);
    }
  }

  // Concurrencia simple (evita saturar Firestore)
  const queue = grupos.slice();
  const run = async () => { while(queue.length){ await worker(queue.shift()); } };
  const n = Math.max(1, Math.min(limit, 6));
  await Promise.all(Array.from({length:n}, run));

  console.log(`FIN — procesados:${ok}, actualizados:${changed}, errores:${fail}`);
};
