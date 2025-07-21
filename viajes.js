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
// 1) Autenticación y arranque
// ——————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  init();
});

async function init() {
  await loadGrupos();
  document.getElementById('btnAddVuelo').onclick = () => openModal();
  initModal();
  renderVuelos();
}

// ——————————————————————————
// 2) Carga de grupos
// ——————————————————————————
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ——————————————————————————
// 3) Render de tarjetas de vuelo
// ——————————————————————————
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db, 'vuelos'));
  vuelos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'activity-card';

    // Formateo fechas
    const fmt = d => {
      const date = new Date(d);
      return date.toLocaleDateString('es-CL', {
        weekday: 'long', day: '2-digit',
        month: 'long', year: 'numeric'
      })
      .replace(/(^\w)/, m => m.toUpperCase());
    };

    // Lista de grupos con estado y botones
    let adultos = 0, estudi = 0;
    const items = (v.grupos || []).map((gObj, idx) => {
      const g = grupos.find(x => x.id === gObj.id) || {};
      const a = g.adultos || 0, e = g.estudiantes || 0;
      adultos += a; estudi += e;
      return `
      <div class="group-item">
        <div class="group-info">
          • <strong>${g.numeroNegocio} – ${g.nombreGrupo}</strong>
            (A:${a} E:${e})
          <span class="status">
            ${gObj.status === 'pendiente' ? '🕗 Pendiente' : '✅ Confirmado'}
          </span>
        </div>
        <div>
          <button class="btn-small" onclick="toggleGroupStatus('${v.id}', ${idx})">
            🔄
          </button>
          <button class="btn-small" onclick="removeGroup('${v.id}', ${idx})">
            🗑️
          </button>
        </div>
      </div>`;
    }).join('');

    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p>Ida: ${fmt(v.fechaIda)}</p>
      <p>Vuelta: ${fmt(v.fechaVuelta)}</p>
      <div>${items || '<p>— Sin grupos —</p>'}</div>
      <p><strong>Total Pax:</strong> ${adultos + estudi}
         (A:${adultos} E:${estudi})</p>
      <div class="actions">
        <button class="btn-edit" data-id="${v.id}">✏️ Editar</button>
        <button class="btn-del"  data-id="${v.id}">🗑️ Eliminar vuelo</button>
      </div>`;
    cont.appendChild(card);

    // handlers edición/vuelo completo
    card.querySelector('.btn-edit')
      .onclick = () => openModal(v);
    card.querySelector('.btn-del')
      .onclick = () => deleteVuelo(v.id);
  });
}

// ——————————————————————————
// 4) Modal: creación / edición
// ——————————————————————————
function initModal() {
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit = onSubmit;

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

function openModal(v = null) {
  isEdit = !!v;
  editId = v?.id || null;
  document.getElementById('modal-title').textContent =
    v ? 'Editar Vuelo' : 'Nuevo Vuelo';

  ['proveedor','numero','fechaIda','fechaVuelta']
    .forEach(key =>
      document.getElementById(`m-${key}`)
        .value = v?.[key] || ''
    );
  document.getElementById('m-tipoVuelo').value = v?.tipoVuelo || 'regular';
  document.getElementById('m-statusDefault').value =
    v?.grupos?.[0]?.status || 'confirmado';

  choiceGrupos.removeActiveItems();
  if (v?.grupos) {
    choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));
  }

  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// ——————————————————————————
// 5) Guardar/actualizar en Firestore
// ——————————————————————————
async function onSubmit(e) {
  e.preventDefault();
  // recojo los ids seleccionados
  const selIds = choiceGrupos.getValue(true);
  const statusDefault = document.getElementById('m-statusDefault').value;
  // construyo array de objetos {id, status}
  const gruposArr = selIds.map(id => ({ id, status: statusDefault }));

  const v = {
    proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:      document.getElementById('m-numero').value.trim(),
    tipoVuelo:   document.getElementById('m-tipoVuelo').value,
    fechaIda:    document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:      gruposArr
  };

  if (isEdit) {
    await updateDoc(doc(db,'vuelos',editId), v);
  } else {
    await addDoc(collection(db,'vuelos'), v);
  }
  closeModal();
  renderVuelos();
}

// ——————————————————————————
// 6) Eliminar vuelo
// ——————————————————————————
async function deleteVuelo(id) {
  if (!confirm('¿Eliminar vuelo completo?')) return;
  await deleteDoc(doc(db,'vuelos',id));
  renderVuelos();
}

// ——————————————————————————
// 7) Quitar un grupo de un vuelo
// ——————————————————————————
window.removeGroup = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const v = snap.data();
  v.grupos.splice(idx,1);
  await updateDoc(ref,{ grupos: v.grupos });
  renderVuelos();
};

// ——————————————————————————
// 8) Alternar estado confirmado/pendiente
// ——————————————————————————
window.toggleGroupStatus = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const v = snap.data();
  const g = v.grupos[idx];
  g.status = g.status === 'pendiente' ? 'confirmado' : 'pendiente';
  await updateDoc(ref,{ grupos: v.grupos });
  renderVuelos();
};

// ——————————————————————————
// 9) Cerrar modal
// ——————————————————————————
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}
