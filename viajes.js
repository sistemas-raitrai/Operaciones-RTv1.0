import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } 
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, Timestamp
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
  bindUI();
  initModal();
  renderVuelos();
  // listeners para modal de grupo
  document.getElementById('group-cancel')
          .addEventListener('click', closeGroupModal);
  document.getElementById('group-form')
          .addEventListener('submit', onSubmitGroup);
}

// ——————————————————————————
// 2) Carga grupos desde Firestore
// ——————————————————————————
async function loadGrupos() {
  const snap = await getDocs(collection(db, 'grupos'));
  grupos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ——————————————————————————
// 3) Bind de UI
// ——————————————————————————
function bindUI() {
  document.getElementById('btnAddVuelo')
          .onclick = () => openModal();
  const btnHist = document.getElementById('btnHistorial');
  if (btnHist) btnHist.onclick = () => location.href = 'historial.html';
}

// ——————————————————————————
// 4) Inicializar modal de Vuelo + Choices.js
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
  choiceGrupos.setChoices(
    grupos.map(g => ({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.nombreGrupo}`
    })),
    'value','label', false
  );
}

// ——————————————————————————
// 5) Renderizar tarjetas (ordenadas por fecha de ida)
// ——————————————————————————
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  // 5.1) Leer & ordenar
  const snap = await getDocs(collection(db, 'vuelos'));
  vuelos = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => new Date(a.fechaIda) - new Date(b.fechaIda));

  // 5.2) Pintar cada vuelo
  vuelos.forEach(v => {
    const userEmail = auth.currentUser.email;
    const card = document.createElement('div');
    card.className = 'flight-card';

    // helper de fecha
    const fmt = iso => new Date(iso)
      .toLocaleDateString('es-CL', {
        weekday:'long', day:'2-digit',
        month:'long', year:'numeric'
      }).replace(/(^\w)/,m=>m.toUpperCase());

    // contadores generales y confirmados
    let totA=0, totE=0, cA=0, cE=0;

    // 5.3) filas de grupos
    const rows = (v.grupos||[]).map((gObj,idx) => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      const A = g.adultos||0, E = g.estudiantes||0;
      totA+=A; totE+=E;
      const confirmed = gObj.status!=='pendiente';
      if(confirmed){ cA+=A; cE+=E; }

      return `
        <div class="group-item">
          <div class="num">${g.numeroNegocio}</div>
          <div class="name">
            <span class="group-name"
                  onclick="openGroupModal('${g.id}')">
              ${g.nombreGrupo}
            </span>
            <span class="pax-inline">${A+E} (A:${A} E:${E})</span>
          </div>
          <div class="status-cell">
            <span>
              ${confirmed?'✅ Confirmado':'🕗 Pendiente'}
            </span>
            <!-- email de quien cambió el estado -->
            <small style="margin-left:.3em; font-size:.85em; color:#666;">
              ${gObj.lastBy||userEmail}
            </small>
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

    // 5.4) HTML completo de la tarjeta
    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p class="dates">
        Ida: ${fmt(v.fechaIda)}
        <span class="arrow">↔️</span>
        Vuelta: ${fmt(v.fechaVuelta)}
      </p>
      <div>${rows||'<p>— Sin grupos —</p>'}</div>
      <p>
        <strong>Total Pax:</strong> ${totA+totE}
        (A:${totA} E:${totE})
        – Confirmados: ${cA+cE}
        (A:${cA} E:${cE})
      </p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    cont.appendChild(card);
    card.querySelector('.btn-edit')
        .addEventListener('click', () => openModal(v));
    card.querySelector('.btn-del')
        .addEventListener('click', () => deleteVuelo(v.id));
  });
}

// ——————————————————————————
// 6) Abrir modal de Vuelo
// ——————————————————————————
function openModal(v=null) {
  isEdit = !!v; editId = v?.id||null;
  document.getElementById('modal-title')
          .textContent = v ? 'Editar Vuelo' : 'Nuevo Vuelo';
  ['proveedor','numero','tipoVuelo','fechaIda','fechaVuelta']
    .forEach(k => document.getElementById(`m-${k}`).value = v?.[k]||'');

  // estado por defecto
  document.getElementById('m-statusDefault').value =
    v?.grupos?.[0]?.status||'confirmado';

  choiceGrupos.removeActiveItems();
  if(v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));

  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// ——————————————————————————
// 7) Guardar/actualizar Vuelo + historial
// ——————————————————————————
async function onSubmit(evt) {
  evt.preventDefault();
  const userEmail = auth.currentUser.email;
  const sel = choiceGrupos.getValue(true);
  const st0 = document.getElementById('m-statusDefault').value;
  // array de grupos con estado y quien lo puso
  const groupArr = sel.map(id => ({
    id, status: st0, lastBy: userEmail
  }));

  const payload = {
    proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:      document.getElementById('m-numero').value.trim(),
    tipoVuelo:   document.getElementById('m-tipoVuelo').value,
    fechaIda:    document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:      groupArr
  };

  // antes de salvar, registro en historial
  for (let gObj of groupArr) {
    const g = grupos.find(x=>x.id===gObj.id);
    await addDoc(collection(db,'historial'), {
      tipo: isEdit?'edit-vuelo':'new-vuelo',
      vueloId: editId||null,
      grupoId: g.id,
      numeroNegocio: g.numeroNegocio,
      nombreGrupo: g.nombreGrupo,
      campo: 'status',
      anterior: null,
      nuevo: gObj.status,
      by: userEmail,
      timestamp: Timestamp.now()
    });
  }

  if(isEdit) await updateDoc(doc(db,'vuelos',editId), payload);
  else       await addDoc(collection(db,'vuelos'), payload);

  closeModal();
  renderVuelos();
}

// ——————————————————————————
// 8) Eliminar vuelo + historial
// ——————————————————————————
async function deleteVuelo(id) {
  if (!confirm('¿Eliminar vuelo completo?')) return;
  const userEmail = auth.currentUser.email;
  // guardo histórico de cada grupo
  const snap = await getDoc(doc(db,'vuelos',id));
  for (let gObj of snap.data().grupos || []) {
    const g = grupos.find(x=>x.id===gObj.id);
    await addDoc(collection(db,'historial'), {
      tipo: 'del-vuelo',
      vueloId: id,
      grupoId: gObj.id,
      numeroNegocio: g.numeroNegocio,
      nombreGrupo: g.nombreGrupo,
      anterior: gObj.status,
      nuevo: null,
      by: userEmail,
      timestamp: Timestamp.now()
    });
  }
  await deleteDoc(doc(db,'vuelos',id));
  renderVuelos();
}

// ——————————————————————————
// 9) Quitar grupo de un vuelo + historial
// ——————————————————————————
window.removeGroup = async (vueloId, idx) => {
  const userEmail = auth.currentUser.email;
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const v = snap.data();
  const removed = v.grupos.splice(idx,1)[0];
  // historial
  const g = grupos.find(x=>x.id===removed.id);
  await addDoc(collection(db,'historial'), {
    tipo: 'remove-group',
    vueloId, grupoId: g.id,
    numeroNegocio: g.numeroNegocio,
    nombreGrupo: g.nombreGrupo,
    anterior: removed.status,
    nuevo: null,
    by: userEmail,
    timestamp: Timestamp.now()
  });
  await updateDoc(ref, { grupos: v.grupos });
  renderVuelos();
};

// ——————————————————————————
// 10) Alternar estado + historial
// ——————————————————————————
window.toggleGroupStatus = async (vueloId, idx) => {
  const userEmail = auth.currentUser.email;
  const ref = doc(db,'vuelos',vueloId);
  const snap = await getDoc(ref);
  const v = snap.data();
  const before = v.grupos[idx].status;
  v.grupos[idx].status = before==='pendiente'?'confirmado':'pendiente';
  v.grupos[idx].lastBy = userEmail;
  // historial
  const g = grupos.find(x=>x.id===v.grupos[idx].id);
  await addDoc(collection(db,'historial'), {
    tipo: 'toggle-status',
    vueloId, grupoId: g.id,
    numeroNegocio: g.numeroNegocio,
    nombreGrupo: g.nombreGrupo,
    anterior: before,
    nuevo: v.grupos[idx].status,
    by: userEmail,
    timestamp: Timestamp.now()
  });
  await updateDoc(ref, { grupos: v.grupos });
  renderVuelos();
};

// ——————————————————————————
// 11) Cerrar modal Vuelo
// ——————————————————————————
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}

// ——————————————————————————
// 12) Modal editar Grupo (coordinadores)
// ——————————————————————————
window.openGroupModal = (grupoId) => {
  const g = grupos.find(x=>x.id===grupoId);
  if(!g) return alert('Grupo no encontrado');
  document.getElementById('g-numeroNegocio').value = g.numeroNegocio;
  document.getElementById('g-nombreGrupo').value   = g.nombreGrupo;
  document.getElementById('g-adultos').value      = g.adultos||0;
  document.getElementById('g-estudiantes').value  = g.estudiantes||0;
  // coordinadores: campo nuevo
  document.getElementById('g-coordinadores').value = g.coordinadores||1;

  document.getElementById('group-form').dataset.grupoId = grupoId;
  document.getElementById('group-backdrop').style.display = 'block';
  document.getElementById('group-modal').style.display    = 'block';
};

function closeGroupModal() {
  document.getElementById('group-backdrop').style.display = 'none';
  document.getElementById('group-modal').style.display    = 'none';
}

// ——————————————————————————
// 13) Guardar cambios Grupo en Firestore + historial
// ——————————————————————————
async function onSubmitGroup(evt) {
  evt.preventDefault();
  const form = document.getElementById('group-form');
  const id   = form.dataset.grupoId;
  const data = {
    nombreGrupo: document.getElementById('g-nombreGrupo').value.trim(),
    adultos:     parseInt(document.getElementById('g-adultos').value,10)||0,
    estudiantes: parseInt(document.getElementById('g-estudiantes').value,10)||0,
    coordinadores: parseInt(document.getElementById('g-coordinadores').value,10)||1
  };
  // historial
  const gOld = grupos.find(x=>x.id===id);
  await addDoc(collection(db,'historial'), {
    tipo: 'edit-grupo',
    grupoId: id,
    numeroNegocio: gOld.numeroNegocio,
    nombreGrupo: gOld.nombreGrupo,
    anterior: {
      adultos: gOld.adultos,
      estudiantes: gOld.estudiantes,
      coordinadores: gOld.coordinadores||1
    },
    nuevo: data,
    by: auth.currentUser.email,
    timestamp: Timestamp.now()
  });
  // actualizar Firestore
  await updateDoc(doc(db,'grupos',id), data);
  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}
