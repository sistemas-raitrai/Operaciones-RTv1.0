import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
let grupos = [], vuelos = [];
let isEdit = false, editId = null;
let choiceGrupos;
let currentUserEmail;

// ――― 1) Autenticación y arranque ―――
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  currentUserEmail = user.email;  // capturamos email
  init();
});

async function init() {
  await loadGrupos();
  bindUI();
  initModal();
  renderVuelos();
  // Listeners Modal Grupo
  document.getElementById('group-cancel')
          .onclick = closeGroupModal;
  document.getElementById('group-form')
          .onsubmit = onSubmitGroup;
}

// ――― 2) Carga todos los grupos ―――
async function loadGrupos() {
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// ――― 3) Botones “+ Agregar” y “Historial” ―――
function bindUI() {
  document.getElementById('btnAddVuelo')
          .onclick = () => openModal();
  document.getElementById('btnHistorial')
          .onclick = () => window.open('historial.html','_blank');
}

// ――― 4) Modal Vuelo + Choices.js ―――
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
    grupos.map(g=>({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.nombreGrupo}`
    })), 'value','label', false
  );
}

// ――― 5) Render de tarjetas, ordenadas por fechaIda ―――
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  // obtenemos, mapeamos y ordenamos
  const snap = await getDocs(collection(db,'vuelos'));
  vuelos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  vuelos.sort((a,b) => new Date(a.fechaIda) - new Date(b.fechaIda));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // helper formateo fecha
    const fmt = iso => new Date(iso)
      .toLocaleDateString('es-CL',{ weekday:'long',day:'2-digit',month:'long',year:'numeric' })
      .replace(/(^\w)/,m=>m.toUpperCase());

    // contadores globales: Adultos, Estudiantes, Coordinadores
    let totA=0, totE=0, totC=0;
    let confA=0, confE=0, confC=0;

    // filas de grupos
    const gruposHtml = (v.grupos||[]).map((gObj,idx)=>{
      const g = grupos.find(x=>x.id===gObj.id) || {};
      const a = g.adultos     || 0;
      const e = g.estudiantes || 0;
      const c = g.coordinadores != null ? g.coordinadores : 1;

      // acumula totales
      totA += a; totE += e; totC += c;
      const isConf = (gObj.status==='confirmado');
      if(isConf) { confA+=a; confE+=e; confC+=c; }

      const mail = gObj.changedBy || '–';

      return `
        <div class="group-item">
          <div class="num">${g.numeroNegocio}</div>
          <div class="name">
            <span class="group-name" onclick="openGroupModal('${g.id}')">
              ${g.nombreGrupo}
            </span>
            <span class="pax-inline">
              ${a+e+c} (A:${a} E:${e} C:${c})
            </span>
          </div>
          <div class="status-cell">
            <span>${isConf ? '✅ Confirmado' : '🕗 Pendiente'}</span>
            <span class="by-email">${mail}</span>
            <button class="btn-small"
                    onclick="toggleStatus('${v.id}',${idx})">🔄</button>
          </div>
          <div class="delete-cell">
            <button class="btn-small"
                    onclick="removeGroup('${v.id}',${idx})">🗑️</button>
          </div>
        </div>`;
    }).join('');

    // HTML completa la tarjeta
    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p class="dates">
        Origen: ${v.origen || '–'}  ↔️  Destino: ${v.destino || '–'}
      </p>
      <p class="dates">
        Ida: ${fmt(v.fechaIda)} ↔️ Vuelta: ${fmt(v.fechaVuelta)}
      </p>
      <div>${gruposHtml || '<p>— Sin grupos —</p>'}</div>
      <p>
        <strong>Total Pax:</strong> ${totA+totE+totC}
        (A:${totA} E:${totE} C:${totC})
        – Confirmados: ${confA+confE+confC}
        (A:${confA} E:${confE} C:${confC})
      </p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    cont.appendChild(card);
    card.querySelector('.btn-edit')
        .onclick = () => openModal(v);
    card.querySelector('.btn-del')
        .onclick = () => deleteVuelo(v.id);
  });
}

// ――― 6) Abrir Modal Vuelo (nuevo/editar) ―――
function openModal(v=null) {
  isEdit = !!v; editId = v?.id || null;
  document.getElementById('modal-title')
          .textContent = v ? 'Editar Vuelo' : 'Nuevo Vuelo';

  // precarga valores
  ['proveedor','numero','origen','destino','tipoVuelo','fechaIda','fechaVuelta']
    .forEach(k => document.getElementById(`m-${k}`).value = v?.[k]||'');

  // estado y grupos
  document.getElementById('m-statusDefault').value = v?.grupos?.[0]?.status || 'confirmado';
  choiceGrupos.removeActiveItems();
  if(v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));

  // muestro
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// ――― 7) Envío formulario Vuelo + Historial ―――
async function onSubmit(evt) {
  evt.preventDefault();
  const sel = choiceGrupos.getValue(true);
  const defaultStatus = document.getElementById('m-statusDefault').value;

  // construye array grupos con changedBy
  const gruposArr = sel.map(id=>({
    id,
    status:    defaultStatus,
    changedBy: currentUserEmail
  }));

  const payload = {
    proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:      document.getElementById('m-numero').value.trim(),
    origen:      document.getElementById('m-origen').value.trim(),
    destino:     document.getElementById('m-destino').value.trim(),
    tipoVuelo:   document.getElementById('m-tipoVuelo').value,
    fechaIda:    document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:      gruposArr
  };

  if(isEdit) {
    const before = (await getDoc(doc(db,'vuelos', editId))).data();
    await updateDoc(doc(db,'vuelos', editId), payload);
    await addDoc(collection(db,'historial'), {
      tipo:    'vuelo-edit',
      vueloId: editId,
      antes:   before,
      despues: payload,
      usuario: currentUserEmail,
      ts:      serverTimestamp()
    });
  } else {
    const ref = await addDoc(collection(db,'vuelos'), payload);
    await addDoc(collection(db,'historial'), {
      tipo:    'vuelo-new',
      vueloId: ref.id,
      antes:   null,
      despues: payload,
      usuario: currentUserEmail,
      ts:      serverTimestamp()
    });
  }

  closeModal();
  renderVuelos();
}

// ――― 8) Eliminar Vuelo + Historial ―――
async function deleteVuelo(id) {
  if(!confirm('¿Eliminar vuelo completo?')) return;
  const before = (await getDoc(doc(db,'vuelos', id))).data();
  await deleteDoc(doc(db,'vuelos', id));
  await addDoc(collection(db,'historial'), {
    tipo:    'vuelo-del',
    vueloId: id,
    antes:   before,
    despues: null,
    usuario: currentUserEmail,
    ts:      serverTimestamp()
  });
  renderVuelos();
}

// ――― 9) Quitar Grupo + Historial ―――
window.removeGroup = async (vueloId, idx) => {
  const ref  = doc(db,'vuelos', vueloId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const before = data.grupos[idx];
  data.grupos.splice(idx,1);
  await updateDoc(ref, { grupos: data.grupos });
  await addDoc(collection(db,'historial'), {
    tipo:    'grupo-remove',
    vueloId,
    grupoId: before.id,
    antes:   before,
    despues: null,
    usuario: currentUserEmail,
    ts:      serverTimestamp()
  });
  renderVuelos();
};

// ――― 10) Alternar Estado + Historial ―――
window.toggleStatus = async (vueloId, idx) => {
  const ref  = doc(db,'vuelos', vueloId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const old  = data.grupos[idx];
  const neu  = {
    ...old,
    status:    old.status==='pendiente'?'confirmado':'pendiente',
    changedBy: currentUserEmail
  };
  data.grupos[idx] = neu;
  await updateDoc(ref, { grupos: data.grupos });
  await addDoc(collection(db,'historial'), {
    tipo:    'grupo-status',
    vueloId,
    grupoId: old.id,
    antes:   old,
    despues: neu,
    usuario: currentUserEmail,
    ts:      serverTimestamp()
  });
  renderVuelos();
};

// ――― 11) Cierra Modal Vuelo ―――
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}

// ――― 12) Abrir Modal Grupo ―――
window.openGroupModal = grupoId => {
  const g = grupos.find(x=>x.id===grupoId);
  if(!g) return alert('Grupo no encontrado');
  // precarga campos (solo lectura N° y nombre)
  document.getElementById('g-numeroNegocio').value = g.numeroNegocio;
  document.getElementById('g-nombreGrupo').value   = g.nombreGrupo;
  document.getElementById('g-adultos').value      = g.adultos     || 0;
  document.getElementById('g-estudiantes').value  = g.estudiantes || 0;
  document.getElementById('g-coordinadores').value= g.coordinadores|| 1;
  document.getElementById('g-nombresCoordinadores').value = (g.nombresCoordinadores||'').join(', ');
  document.getElementById('g-empresaBus').value = g.empresaBus||'';
  document.getElementById('group-form').dataset.grupoId = grupoId;
  document.getElementById('group-backdrop').style.display = 'block';
  document.getElementById('group-modal').style.display    = 'block';
};

// ――― 13) Cierra Modal Grupo ―――
function closeGroupModal() {
  document.getElementById('group-backdrop').style.display = 'none';
  document.getElementById('group-modal').style.display    = 'none';
}

// ――― 14) Envío Modal Grupo + Historial ―――
async function onSubmitGroup(evt) {
  evt.preventDefault();
  const form   = document.getElementById('group-form');
  const id     = form.dataset.grupoId;
  const before = (await getDoc(doc(db,'grupos', id))).data();

  // parseo nombres coordinadores
  const nombresCSV = document.getElementById('g-nombresCoordinadores').value.trim();
  const nombresArr = nombresCSV
    ? nombresCSV.split(',').map(s=>s.trim()).filter(Boolean)
    : [];

  const data = {
    adultos:                +document.getElementById('g-adultos').value     || 0,
    estudiantes:            +document.getElementById('g-estudiantes').value || 0,
    coordinadores:          +document.getElementById('g-coordinadores').value|| 1,
    nombresCoordinadores:   nombresArr,
    empresaBus:             document.getElementById('g-empresaBus').value.trim()
  };

  // actualizo Firestore
  await updateDoc(doc(db,'grupos', id), data);
  // log historial
  await addDoc(collection(db,'historial'), {
    tipo:        'grupo-edit',
    grupoId:     id,
    antes:       before,
    despues:     data,
    usuario:     currentUserEmail,
    ts:          serverTimestamp()
  });

  // refresco y cierro
  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}
