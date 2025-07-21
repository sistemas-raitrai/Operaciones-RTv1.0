// viajes.js
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// Estado global
const auth = getAuth(app);
let grupos = [], transportes = [];
let isEdit = false, editId = null;
let choiceGrupos;

// ——————————————————————————
// 1) Auth y arranque en init()
// ——————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  init();
});

async function init() {
  await loadGrupos();
  bindUI();
  initModal();
  renderTransportes();
}

// ——————————————————————————
// 2) Bind de UI estática
// ——————————————————————————
function bindUI() {
  document.getElementById('btnAddVuelo')
    .onclick = () => openModal();
}

// ——————————————————————————
// 3) Carga grupos desde Firestore
// ——————————————————————————
async function loadGrupos() {
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// ——————————————————————————
// 4) Inicializa el modal y Choices.js
// ——————————————————————————
function initModal() {
  // Cancelar
  document.getElementById('modal-cancel')
    .onclick = closeModal;
  // Submit
  document.getElementById('modal-form')
    .onsubmit = onSubmit;

  // Choices para grupos
  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton: true }
  );
  choiceGrupos.setChoices(
    grupos.map(g=>({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.nombreGrupo}`
    })),
    'value','label',false
  );

  // Toggle campos tipo
  document.getElementById('m-tipo').onchange = e =>
    toggleFields(e.target.value);
}

// ——————————————————————————
// 5) Mostrar/ocultar campos Aéreo vs Terrestre
// ——————————————————————————
function toggleFields(tipo) {
  document.getElementById('fields-aereo').style.display =
    tipo === 'aereo' ? 'block' : 'none';
  document.getElementById('fields-terrestre').style.display =
    tipo === 'terrestre' ? 'block' : 'none';
}

// ——————————————————————————
// 6) Render transportes como tarjetas
// ——————————————————————————
async function renderTransportes() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db,'vuelos'));
  transportes = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  transportes.forEach(t => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // Cabecera con datos
    card.innerHTML = `
      <div>
        <h4>✈️ ${t.proveedor||t.empresa} ${t.numero||''}
           (${t.tipo==='aereo'? t.tipoVuelo:t.tipo})</h4>
        ${t.tipo==='aereo'
          ? `<p>Ida: ${fmtFecha(t.fechaIda)}</p>
             <p>Vuelta: ${fmtFecha(t.fechaVuelta)}</p>`
          : `<p>${t.horaInicio} – ${t.horaFin}</p>
             <p>Cond: ${t.conductor1||'-'} / ${t.conductor2||'-'}</p>`}
      </div>
      <div>${renderGrupos(t.grupos,t.id)}</div>
      <div><strong>Total Pax:</strong> ${calculaTotal(t.grupos)}</div>
      <div class="actions">
        <button class="btn-add" onclick="openModal(${JSON.stringify(t)})">
          ✏️ Editar
        </button>
        <button class="btn-add" onclick="deleteTransporte('${t.id}')">
          🗑️ Eliminar
        </button>
      </div>
    `;
    cont.appendChild(card);
  });
}

// ——————————————————————————
// 7) Formatea fecha «X, DD de MMMM YYYY»
// ——————————————————————————
function fmtFecha(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-CL',{
    weekday:'long', day:'2-digit',
    month:'long', year:'numeric'
  }).replace(/(^\w)/,m=>m.toUpperCase());
}

// ——————————————————————————
// 8) Renderiza cada grupo dentro de un transporte
// ——————————————————————————
function renderGrupos(arr = [], transporteId) {
  if (!arr.length) return '<p>— Sin grupos —</p>';
  return arr.map((gObj,idx) => {
    const g = grupos.find(x=>x.id===gObj.id) || {};
    const a=g.adultos||0, e=g.estudiantes||0;
    return `
      <div class="group-item">
        <div class="group-info">
          • <strong>${g.numeroNegocio} – ${g.nombreGrupo}</strong>
            (A:${a} E:${e})
          <span class="status">
            ${gObj.status==='pendiente'?'🕗 Pendiente':'✅ Confirmado'}
          </span>
        </div>
        <div>
          <button class="btn-small"
            onclick="toggleGroupStatus('${transporteId}',${idx})">
            🔄
          </button>
          <button class="btn-small"
            onclick="removeGroup('${transporteId}',${idx})">
            🗑️
          </button>
        </div>
      </div>`;
  }).join('');
}

// ——————————————————————————
// 9) Calcula y muestra totals pax
// ——————————————————————————
function calculaTotal(arr=[]) {
  let a=0,e=0;
  arr.forEach(gObj=>{
    const g = grupos.find(x=>x.id===gObj.id)||{};
    a+=g.adultos||0; e+=g.estudiantes||0;
  });
  return `${a+e} (A:${a} E:${e})`;
}

// ——————————————————————————
// 10) Abre modal para nuevo/editar
// ——————————————————————————
function openModal(t=null) {
  isEdit = !!t; editId = t?.id||null;
  document.getElementById('modal-title').textContent =
    t ? 'Editar Transporte' : 'Nuevo Transporte';

  // Rellenar campos comunes
  document.getElementById('m-tipo').value = t?.tipo||'aereo';
  toggleFields(t?.tipo||'aereo');

  // Aéreo
  document.getElementById('m-proveedor').value = t?.proveedor||'';
  document.getElementById('m-numero').value    = t?.numero||'';
  document.getElementById('m-tipoVuelo').value = t?.tipoVuelo||'regular';
  document.getElementById('m-fechaIda').value  = t?.fechaIda||'';
  document.getElementById('m-fechaVuelta').value = t?.fechaVuelta||'';

  // Terrestre
  document.getElementById('m-empresa').value    = t?.empresa||'';
  document.getElementById('m-horaInicio').value = t?.horaInicio||'';
  document.getElementById('m-horaFin').value    = t?.horaFin||'';
  document.getElementById('m-conductor1').value = t?.conductor1||'';
  document.getElementById('m-conductor2').value = t?.conductor2||'';

  // Grupos + estado
  choiceGrupos.removeActiveItems();
  if (t?.grupos) {
    choiceGrupos.setChoiceByValue(t.grupos.map(g=>g.id));
    document.getElementById('m-statusDefault').value = t.grupos[0].status;
  }

  // Mostrar modal
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// ——————————————————————————
// 11) Submit: crea o actualiza en Firestore
// ——————————————————————————
async function onSubmit(evt) {
  evt.preventDefault();
  const tipo = document.getElementById('m-tipo').value;
  // Recojo valores según tipo
  const base = {
    tipo,
    grupos: choiceGrupos.getValue(true)
      .map(id=>({ id, status: document.getElementById('m-statusDefault').value }))
  };
  const payload = tipo==='aereo'
    ? {
        ...base,
        proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
        numero:      document.getElementById('m-numero').value.trim(),
        tipoVuelo:   document.getElementById('m-tipoVuelo').value,
        fechaIda:    document.getElementById('m-fechaIda').value,
        fechaVuelta: document.getElementById('m-fechaVuelta').value
      }
    : {
        ...base,
        empresa:     document.getElementById('m-empresa').value.trim(),
        horaInicio:  document.getElementById('m-horaInicio').value,
        horaFin:     document.getElementById('m-horaFin').value,
        conductor1:  document.getElementById('m-conductor1').value.trim(),
        conductor2:  document.getElementById('m-conductor2').value.trim()
      };

  const ref = doc(db,'vuelos', editId || '');
  if (isEdit) {
    await updateDoc(ref, payload);
  } else {
    await addDoc(collection(db,'vuelos'), payload);
  }

  closeModal();
  renderTransportes();
}

// ——————————————————————————
// 12) Eliminar transporte completo
// ——————————————————————————
async function deleteTransporte(id) {
  if (!confirm('¿Eliminar este transporte?')) return;
  await deleteDoc(doc(db,'vuelos',id));
  renderTransportes();
}

// ——————————————————————————
// 13) Remove single group
// ——————————————————————————
window.removeGroup = async (transpId, idx) => {
  const ref = doc(db,'vuelos',transpId);
  const snap = await getDoc(ref), data = snap.data();
  data.grupos.splice(idx,1);
  await updateDoc(ref,{ grupos: data.grupos });
  renderTransportes();
};

// ——————————————————————————
// 14) Toggle group status
// ——————————————————————————
window.toggleGroupStatus = async (transpId, idx) => {
  const ref = doc(db,'vuelos',transpId);
  const snap = await getDoc(ref), data = snap.data();
  data.grupos[idx].status = data.grupos[idx].status==='pendiente' 
    ? 'confirmado' : 'pendiente';
  await updateDoc(ref,{ grupos: data.grupos });
  renderTransportes();
};

// ——————————————————————————
// 15) Cerrar modal
// ——————————————————————————
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}
