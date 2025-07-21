// viajes.js
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
let grupos = [], vuelos = [];
let isEdit = false, editId = null;
let choiceGrupos;

// ——————————————————————————
// 1) Inicialización tras DOMContentLoaded
// ——————————————————————————
document.addEventListener('DOMContentLoaded', () => {
  onAuthStateChanged(auth, user => {
    if (!user) return location.href = 'login.html';
    init();
  });
});

// ——————————————————————————
// 2) Init: carga grupos, enlaza botón y modal, y render
// ——————————————————————————
async function init() {
  await loadGrupos();
  document.getElementById('btnAddVuelo').onclick = () => openModal();
  initModal();
  renderVuelos();
}

// ——————————————————————————
// 3) loadGrupos()
// ——————————————————————————
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ——————————————————————————
// 4) initModal(): enlaza eventos del modal
// ——————————————————————————
function initModal() {
  const btnCancel = document.getElementById('modal-cancel');
  if (btnCancel) btnCancel.onclick = closeModal;

  const form = document.getElementById('modal-form');
  if (form) form.onsubmit = onSubmit;

  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton: true }
  );
  choiceGrupos.setChoices(
    grupos.map(g => ({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.nombreGrupo}`
    })),
    'value', 'label', false
  );
}

// ——————————————————————————
// 5) renderVuelos(): dibuja cada vuelo como bloque
// ——————————————————————————
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db, 'vuelos'));
  vuelos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // header
    card.innerHTML = `
      <div class="flight-header">
        <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
        <p>Ida: ${fmtFecha(v.fechaIda)}</p>
        <p>Vuelta: ${fmtFecha(v.fechaVuelta)}</p>
      </div>
      <div class="flight-groups">${renderGrupos(v.grupos)}</div>
      <div class="flight-footer">
        <div><strong>Total Pax:</strong> ${calculaTotal(v.grupos)}</div>
        <div>
          <button class="btn-add" onclick="openModal(${JSON.stringify(v)})">✏️ Editar</button>
          <button class="btn-add" onclick="deleteVuelo('${v.id}')">🗑️ Eliminar</button>
        </div>
      </div>
    `;
    cont.appendChild(card);
  });
}

// ——————————————————————————
// Helper: formatea fecha
// ——————————————————————————
function fmtFecha(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-CL', {
    weekday: 'long', day: '2-digit',
    month: 'long', year: 'numeric'
  }).replace(/(^\w)/, m => m.toUpperCase());
}

// ——————————————————————————
// Helper: renderiza lista de grupos
// ——————————————————————————
function renderGrupos(arr = []) {
  if (!arr.length) return '<p>— Sin grupos —</p>';
  return arr.map((gObj, idx) => {
    const g = grupos.find(x => x.id === gObj.id) || {};
    const a = g.adultos||0, e = g.estudiantes||0;
    const status = gObj.status==='pendiente'
      ? '🕗 Pendiente' : '✅ Confirmado';
    return `
      <div class="group-item">
        <div class="group-info">
          • <strong>${g.numeroNegocio} – ${g.nombreGrupo}</strong>
          (A:${a} E:${e}) <span class="status">${status}</span>
        </div>
        <div>
          <button class="btn-small" onclick="toggleGroupStatus('${gObj.id}', ${idx})">🔄</button>
          <button class="btn-small" onclick="removeGroup('${gObj.id}', ${idx})">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

// ——————————————————————————
// Helper: calcula total pax
// ——————————————————————————
function calculaTotal(arr = []) {
  let a=0,e=0;
  arr.forEach(gObj => {
    const g = grupos.find(x => x.id===gObj.id) || {};
    a += g.adultos||0; e += g.estudiantes||0;
  });
  return `${a+e} (A:${a} E:${e})`;
}

// ——————————————————————————
// openModal(v?) y onSubmit() (idénticos a antes)
// ——————————————————————————
function openModal(v = null) {
  isEdit = !!v; editId = v?.id||null;
  document.getElementById('modal-title').textContent =
    v?'Editar Vuelo':'Nuevo Vuelo';
  ['proveedor','numero','fechaIda','fechaVuelta']
    .forEach(key => document.getElementById(`m-${key}`).value = v?.[key]||'');
  document.getElementById('m-tipoVuelo').value = v?.tipoVuelo||'regular';
  document.getElementById('m-statusDefault').value =
    v?.grupos?.[0]?.status||'confirmado';

  choiceGrupos.removeActiveItems();
  if (v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));

  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

async function onSubmit(evt) {
  evt.preventDefault();
  const sel = choiceGrupos.getValue(true);
  const st  = document.getElementById('m-statusDefault').value;
  const gruposArr = sel.map(id=>({ id, status: st }));
  const v = {
    proveedor: document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:    document.getElementById('m-numero').value.trim(),
    tipoVuelo: document.getElementById('m-tipoVuelo').value,
    fechaIda:  document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:    gruposArr
  };
  if (isEdit) await updateDoc(doc(db,'vuelos',editId), v);
  else        await addDoc(collection(db,'vuelos'), v);
  closeModal(); renderVuelos();
}

// ——————————————————————————
// deleteVuelo, removeGroup, toggleGroupStatus, closeModal
// ——————————————————————————
async function deleteVuelo(id) {
  if (!confirm('Eliminar vuelo?')) return;
  await deleteDoc(doc(db,'vuelos',id));
  renderVuelos();
}

window.removeGroup = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId), snap = await getDoc(ref), v = snap.data();
  v.grupos.splice(idx,1);
  await updateDoc(ref,{ grupos: v.grupos });
  renderVuelos();
};

window.toggleGroupStatus = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId), snap = await getDoc(ref), v = snap.data();
  v.grupos[idx].status = v.grupos[idx].status==='pendiente' ? 'confirmado':'pendiente';
  await updateDoc(ref,{ grupos: v.grupos });
  renderVuelos();
};

function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}
