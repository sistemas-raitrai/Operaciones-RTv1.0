// viajes.js (antes nombrado viajes-por-vuelo.js)
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

// —————————————————————————————————
// 1) Autenticación y arranque
// —————————————————————————————————
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

// —————————————————————————————————
// 2) Carga de grupos para asignar a vuelos
// —————————————————————————————————
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// —————————————————————————————————
// 3) Render de tarjetas de vuelo
// —————————————————————————————————
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db, 'vuelos'));
  vuelos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'activity-card';
    // calcular totales
    let adultos = 0, estudi = 0;
    const lista = (v.grupos || []).map(gid => {
      const g = grupos.find(x => x.id === gid);
      const a = g?.adultos || 0, e = g?.estudiantes || 0;
      adultos += a; estudi += e;
      return `<li>${g.numeroNegocio} – ${g.nombreGrupo} (A:${a} E:${e})</li>`;
    }).join('');

    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p>Ida: ${v.fechaIda} • Vuelta: ${v.fechaVuelta}</p>
      <ul>${lista || '<li>— Sin grupos —</li>'}</ul>
      <p>Total Pax: ${adultos + estudi} (A:${adultos} E:${estudi})</p>
      <div class="actions">
        <button data-id="${v.id}" class="btn-edit">✏️</button>
        <button data-id="${v.id}" class="btn-del">🗑️</button>
      </div>`;

    cont.appendChild(card);
    card.querySelector('.btn-edit').onclick = () => openModal(v);
    card.querySelector('.btn-del').onclick = () => deleteVuelo(v.id);
  });
}

// —————————————————————————————————
// 4) Inicialización del modal
// —————————————————————————————————
function initModal() {
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit = onSubmit;
  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton: true }
  );
  choiceGrupos.setChoices(
    grupos.map(g => ({ value: g.id, label: `${g.numeroNegocio} – ${g.nombreGrupo}` })),
    'value', 'label', false
  );
}

// —————————————————————————————————
// 5) Apertura del modal para nuevo/edición
// —————————————————————————————————
function openModal(v) {
  isEdit = !!v; editId = v?.id || null;
  document.getElementById('modal-title').textContent = v ? 'Editar Vuelo' : 'Nuevo Vuelo';

  // Rellenar campos
  ['proveedor', 'numero', 'fechaIda', 'fechaVuelta']
    .forEach(key => {
      document.getElementById(`m-${key}`)
        .value = v?.[key] || '';
    });
  document.getElementById('m-tipoVuelo').value = v?.tipoVuelo || 'regular';

  // Grupos
  choiceGrupos.removeActiveItems();
  if (v?.grupos) choiceGrupos.setChoiceByValue(v.grupos);

  updateTotals();
  choiceGrupos.passedElement.element.addEventListener('choice', updateTotals);

  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// —————————————————————————————————
// 6) Cálculo automático de totales
// —————————————————————————————————
function updateTotals() {
  const sel = choiceGrupos.getValue(true);
  let a = 0, e = 0;
  sel.forEach(id => {
    const g = grupos.find(x => x.id === id);
    a += g?.adultos || 0;
    e += g?.estudiantes || 0;
  });
  document.getElementById('m-adultosTotal').value = a;
  document.getElementById('m-estudiantesTotal').value = e;
}

// —————————————————————————————————
// 7) Guardar o actualizar vuelo
// —————————————————————————————————
async function onSubmit(evt) {
  evt.preventDefault();
  const v = {
    proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:      document.getElementById('m-numero').value.trim(),
    tipoVuelo:   document.getElementById('m-tipoVuelo').value,
    fechaIda:    document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:      choiceGrupos.getValue(true)
  };

  if (isEdit) {
    await updateDoc(doc(db,'vuelos',editId), v);
  } else {
    await addDoc(collection(db,'vuelos'), v);
  }
  closeModal();
  renderVuelos();
}

// —————————————————————————————————
// 8) Borrar vuelo
// —————————————————————————————————
async function deleteVuelo(id) {
  if (!confirm('¿Eliminar vuelo?')) return;
  await deleteDoc(doc(db,'vuelos',id));
  renderVuelos();
}

// —————————————————————————————————
// 9) Cerrar modal
// —————————————————————————————————
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}
