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

// ——————————————————————————
// 2) Init: carga datos y enlaza UI
// ——————————————————————————
async function init() {
  await loadGrupos();
  bindUI();
  initModal();
  renderVuelos();
}

// ——————————————————————————
// 3) Cargo todos los grupos a memoria
// ——————————————————————————
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ——————————————————————————
// 4) Botones principales
// ——————————————————————————
function bindUI() {
  const btnAdd = document.getElementById('btnAddVuelo');
  if (btnAdd) btnAdd.onclick = () => openModal();

  const btnHist = document.getElementById('btnHistorial');
  if (btnHist) btnHist.onclick = () => abrirHistorial();
}

// ——————————————————————————
// 5) Inicializo Choices.js y modal de vuelo
// ——————————————————————————
function initModal() {
  document.getElementById('modal-cancel')
          .onclick = closeModal;
  document.getElementById('modal-form')
          .onsubmit = onSubmit;

  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton: true }
  );
  // precargo opciones de grupos
  choiceGrupos.setChoices(
    grupos.map(g => ({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.nombreGrupo}`
    })),
    'value','label', false
  );
}

// ——————————————————————————
// 6) Render de tarjetas, ordenadas por fechaIda
// ——————————————————————————
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  // traigo y ordeno
  const snap = await getDocs(collection(db, 'vuelos'));
  vuelos = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => new Date(a.fechaIda) - new Date(b.fechaIda));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // helper para fechas
    const fmt = iso => {
      const D = new Date(iso);
      return D.toLocaleDateString('es-CL',{
        weekday:'long', day:'2-digit',
        month:'long', year:'numeric'
      }).replace(/(^\w)/, m=>m.toUpperCase());
    };

    // contadores totales y confirmados
    let adultos=0, estudi=0, adultosC=0, estudiC=0;

    // filas de grupos
    const gruposHtml = (v.grupos||[]).map((gObj, idx) => {
      const g = grupos.find(x=>x.id===gObj.id) || {};
      const a = g.adultos||0, e = g.estudiantes||0;
      adultos += a; estudi += e;
      const confirmado = gObj.status!=='pendiente';
      if (confirmado) { adultosC+=a; estudiC+=e; }

      return `
        <div class="group-item">
          <div class="num">${g.numeroNegocio}</div>
          <div class="name">
            <span 
              class="group-name" 
              style="cursor:pointer; text-decoration:underline;"
              onclick="openGroupModal('${g.id}')">
              ${g.nombreGrupo}
            </span>
            <span class="pax-inline">${a+e} (A:${a} E:${e})</span>
          </div>
          <div class="status-cell">
            <span title="Últ. cambio: ${gObj.user||'–'}">
              ${confirmado?'✅ Confirmado':'🕗 Pendiente'}
            </span>
            <button class="btn-small"
                    onclick="toggleGroupStatus('${v.id}',${idx})">
              🔄
            </button>
          </div>
          <div class="delete-cell">
            <button class="btn-small"
                    onclick="removeGroup('${v.id}',${idx})">
              🗑️
            </button>
          </div>
        </div>`;
    }).join('');

    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p class="dates">
        Ida: ${fmt(v.fechaIda)}
        <span class="arrow">↔️</span>
        Vuelta: ${fmt(v.fechaVuelta)}
      </p>
      <div>${gruposHtml || '<p>— Sin grupos —</p>'}</div>
      <p>
        <strong>Total Pax:</strong> ${adultos+estudi}
        (A:${adultos} E:${estudi})
        – Confirmados: ${adultosC+estudiC}
        (A:${adultosC} E:${estudiC})
      </p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    cont.appendChild(card);
    // handlers
    card.querySelector('.btn-edit')
        .addEventListener('click', ()=>openModal(v));
    card.querySelector('.btn-del')
        .addEventListener('click', ()=>deleteVuelo(v.id));
  });
}

// ——————————————————————————
// 7) Abrir modal de Vuelo (nuevo/editar)
// ——————————————————————————
function openModal(v=null) {
  isEdit = !!v; editId = v?.id||null;
  document.getElementById('modal-title')
          .textContent = v?'Editar Vuelo':'Nuevo Vuelo';

  // pre-llenar campos
  ['proveedor','numero','tipoVuelo','fechaIda','fechaVuelta']
    .forEach(k => document.getElementById(`m-${k}`).value = v?.[k]||'');

  // estado por defecto
  document.getElementById('m-statusDefault').value =
    v?.grupos?.[0]?.status||'confirmado';

  // grupos seleccionados
  choiceGrupos.removeActiveItems();
  if (v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));

  // muestro modal
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// ——————————————————————————
// 8) Guardar/actualizar en Firestore + historial
// ——————————————————————————
async function onSubmit(evt) {
  evt.preventDefault();
  const user = auth.currentUser.email;
  const sel = choiceGrupos.getValue(true);
  const statusDefault = document.getElementById('m-statusDefault').value;
  const gruposArr = sel.map(id => ({
    id,
    status: statusDefault,
    user,                     // quien lo configuró
    timestamp: new Date()     // marca temporal
  }));

  const payload = {
    proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:      document.getElementById('m-numero').value.trim(),
    tipoVuelo:   document.getElementById('m-tipoVuelo').value,
    fechaIda:    document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:      gruposArr
  };

  if (isEdit) {
    // antes: carga para historial
    const before = (await getDoc(doc(db,'vuelos',editId))).data();
    await updateDoc(doc(db,'vuelos',editId), payload);
    // historial: cambio de todo el vuelo
    await addDoc(collection(db,'historial'), {
      type: 'vuelo-update',
      vueloId: editId,
      before,
      after: payload,
      user,
      timestamp: new Date()
    });
  } else {
    const ref = await addDoc(collection(db,'vuelos'), payload);
    // historial: creación
    await addDoc(collection(db,'historial'), {
      type: 'vuelo-create',
      vueloId: ref.id,
      data: payload,
      user,
      timestamp: new Date()
    });
  }

  closeModal();
  renderVuelos();
}

// ——————————————————————————
// 9) Eliminar vuelo completo
// ——————————————————————————
async function deleteVuelo(id) {
  if (!confirm('¿Eliminar vuelo completo?')) return;
  await deleteDoc(doc(db,'vuelos',id));
  // historial
  await addDoc(collection(db,'historial'), {
    type: 'vuelo-delete',
    vueloId: id,
    user: auth.currentUser.email,
    timestamp: new Date()
  });
  renderVuelos();
}

// ——————————————————————————
// 10) Quitar un grupo de un vuelo + historial
// ——————————————————————————
window.removeGroup = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const removed = data.grupos.splice(idx,1)[0];
  await updateDoc(ref,{ grupos: data.grupos });
  // historial
  await addDoc(collection(db,'historial'), {
    type: 'remove-group',
    vueloId, group: removed,
    user: auth.currentUser.email,
    timestamp: new Date()
  });
  renderVuelos();
};

// ——————————————————————————
// 11) Alternar estado (+user+timestamp) + historial
// ——————————————————————————
window.toggleGroupStatus = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const old = { ...data.grupos[idx] };
  data.grupos[idx].status = old.status==='pendiente' ? 'confirmado' : 'pendiente';
  data.grupos[idx].user = auth.currentUser.email;
  data.grupos[idx].timestamp = new Date();
  await updateDoc(ref,{ grupos: data.grupos });
  // historial
  await addDoc(collection(db,'historial'), {
    type: 'toggle-status',
    vueloId,
    before: old,
    after: data.grupos[idx],
    user: auth.currentUser.email,
    timestamp: new Date()
  });
  renderVuelos();
};

// ——————————————————————————
// 12) Cerrar modal de vuelo
// ——————————————————————————
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}

// ——————————————————————————
// 13) Modal de Grupo: abrir con datos + editar
// ——————————————————————————
window.openGroupModal = grupoId => {
  const g = grupos.find(x=>x.id===grupoId);
  if (!g) return alert('Grupo no encontrado');
  // relleno
  document.getElementById('g-numeroNegocio').value = g.numeroNegocio;
  document.getElementById('g-nombreGrupo').value   = g.nombreGrupo;
  document.getElementById('g-adultos').value      = g.adultos||0;
  document.getElementById('g-estudiantes').value  = g.estudiantes||0;
  // guardo id
  document.getElementById('group-form').dataset.grupoId = grupoId;
  // muestro modal
  document.getElementById('group-backdrop').style.display = 'block';
  document.getElementById('group-modal').style.display    = 'block';
};
function closeGroupModal() {
  document.getElementById('group-backdrop').style.display = 'none';
  document.getElementById('group-modal').style.display    = 'none';
}
// ——————————————————————————
// 14) Submit grupo + historial
// ——————————————————————————
async function onSubmitGroup(evt) {
  evt.preventDefault();
  const form = document.getElementById('group-form');
  const id   = form.dataset.grupoId;
  const docRef = doc(db,'grupos',id);
  const before = (await getDoc(docRef)).data();

  const data = {
    nombreGrupo: document.getElementById('g-nombreGrupo').value.trim(),
    adultos:     parseInt(document.getElementById('g-adultos').value,10)||0,
    estudiantes: parseInt(document.getElementById('g-estudiantes').value,10)||0
  };
  await updateDoc(docRef, data);

  // historial
  await addDoc(collection(db,'historial'), {
    type: 'grupo-update',
    groupId: id,
    before, after: data,
    user: auth.currentUser.email,
    timestamp: new Date()
  });

  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}
