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

async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db, 'vuelos'));
  vuelos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // Encabezado
    const header = document.createElement('div');
    header.className = 'flight-header';
    header.innerHTML = `<h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>`;

    // Detalles de fechas
    const fmt = d => {
      const date = new Date(d);
      return date.toLocaleDateString('es-CL', {
        weekday: 'long', day: '2-digit',
        month: 'long', year: 'numeric'
      }).replace(/(^\w)/, m => m.toUpperCase());
    };
    const details = document.createElement('div');
    details.className = 'flight-details';
    details.innerHTML = `
      <p>Ida: ${fmt(v.fechaIda)}</p>
      <p>Vuelta: ${fmt(v.fechaVuelta)}</p>`;

    // Grupos y estados
    let adultos = 0, estudi = 0;
    const groupsHtml = v.grupos.map((gObj, idx) => {
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
            <button class="btn-small" onclick="toggleGroupStatus('${v.id}', ${idx})">🔄</button>
            <button class="btn-small" onclick="removeGroup('${v.id}', ${idx})">🗑️</button>
          </div>
        </div>`;
    }).join('');

    const groupContainer = document.createElement('div');
    groupContainer.className = 'flight-groups';
    groupContainer.innerHTML = groupsHtml || '<p>— Sin grupos —</p>';

    // Pie con totales y botones
    const footer = document.createElement('div');
    footer.className = 'flight-footer';
    footer.innerHTML = `
      <div><strong>Total Pax:</strong> ${adultos + estudi}
        (A:${adultos} E:${estudi})</div>
      <div>
        <button class="btn-add" onclick="openModal(${JSON.stringify(v)})">✏️ Editar</button>
        <button class="btn-add" onclick="deleteVuelo('${v.id}')">🗑️ Eliminar</button>
      </div>`;

    // Montaje
    card.append(header, details, groupContainer, footer);
    cont.appendChild(card);
  });
}

// ... resto de funciones (initModal, openModal, onSubmit, deleteVuelo, removeGroup, toggleGroupStatus, closeModal) idénticas ...
