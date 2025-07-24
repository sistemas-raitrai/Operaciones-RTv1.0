import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
let grupos = [], hoteles = [];
let isEdit=false, editId=null, choiceGrupos, currentUserEmail, dtHist=null;

// 1) Autenticación y arranque
onAuthStateChanged(auth, user => {
  if (!user) return location.href='login.html';
  currentUserEmail = user.email;
  init();
});

async function init(){
  await loadGrupos();
  bindUI();
  initModal();
  await renderHoteles();

  // Grupo modal
  document.getElementById('group-cancel').onclick = closeGroupModal;
  document.getElementById('group-form').onsubmit = onSubmitGroup;

  // Historial modal
  document.getElementById('btnHistorial').onclick = showHistorialModal;
  document.getElementById('hist-close').onclick  = closeHistorialModal;
  document.getElementById('hist-refresh').onclick= loadHistorial;
  document.getElementById('hist-start').onchange = loadHistorial;
  document.getElementById('hist-end').onchange   = loadHistorial;
}

// 2) Cargo grupos de Firestore
async function loadGrupos(){
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// 3) Botones principales
function bindUI(){
  document.getElementById('btnAddHotel').onclick    = ()=>openModal();
  document.getElementById('btnExportExcel').onclick = exportToExcel;
}

// 4) Modal Hotel + Choices.js
function initModal(){
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit  = onSubmitHotel;
  choiceGrupos = new Choices(
    document.getElementById('h-grupos'),
    { removeItemButton:true }
  );
  choiceGrupos.setChoices(
    grupos.map(g=>({ value:g.id, label:`${g.numeroNegocio} – ${g.nombreGrupo}` })),
    'value','label', false
  );
}

// 5) Render de hoteles
async function renderHoteles(){
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';

  const snap = await getDocs(collection(db,'hoteles'));
  hoteles = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  hoteles.sort((a,b)=>new Date(a.fechaIn)-new Date(b.fechaIn));

  for(const h of hoteles){
    let totA=0, totE=0, totC=0, confA=0, confE=0, confC=0;

    const filas = (h.grupos||[]).map((gObj, idx) => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      const a = parseInt(g.adultos||0,10);
      const e = parseInt(g.estudiantes||0,10);
      const nombresArr = Array.isArray(g.nombresCoordinadores)
        ? g.nombresCoordinadores
        : (g.nombresCoordinadores
           ? g.nombresCoordinadores.split(',').map(s=>s.trim())
           : ['']);
      const c = nombresArr.length||1;

      totA += a; totE += e; totC += c;
      if(gObj.status==='confirmado'){
        confA += a; confE += e; confC += c;
      }

      const totalRow = a+e+c;
      const mail = gObj.changedBy||'–';

      return `
        <div class="group-item">
          <div class="num">${g.numeroNegocio}</div>
          <div class="name">
            <span class="group-name"
                  onclick="openGroupModal('${g.id}')">
              ${g.nombreGrupo}
            </span>
            <span class="pax-inline">
              ${totalRow} (A:${a} E:${e} C:${c})
            </span>
          </div>
          <div class="status-cell">
            <span>${gObj.status==='confirmado'?'✅':'🕗'}</span>
            <span class="by-email">${mail}</span>
            <button class="btn-small"
                    onclick="toggleStatus('${h.id}',${idx})">🔄</button>
          </div>
          <div class="delete-cell">
            <button class="btn-small"
                    onclick="removeGroup('${h.id}',${idx})">🗑️</button>
          </div>
        </div>`;
    }).join('');

    const fmt = iso => new Date(iso).toLocaleDateString('es-CL',{
      weekday:'short',day:'2-digit',month:'short'
    });

    const card = document.createElement('div');
    card.className='hotel-card';
    card.innerHTML=`
      <h4>🏨 ${h.nombre}</h4>
      <p class="dates">
        In: ${fmt(h.fechaIn)} ↔️ Out: ${fmt(h.fechaOut)}
      </p>
      <p>
        Capacidad: Sng:${h.single} Dob:${h.double}
        Tri:${h.triple} Cuad:${h.quad}
      </p>
      <div>${filas||'<p>— Sin grupos —</p>'}</div>
      <p>
        <strong>Total Pax:</strong> ${totA+totE+totC}
         – Conf: ${confA+confE+confC}
      </p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    card.querySelector('.btn-edit').onclick = ()=>openModal(h);
    card.querySelector('.btn-del' ).onclick = ()=>deleteHotel(h.id);
    cont.appendChild(card);
  }
}

// 6) Abrir modal Hotel
function openModal(h=null){
  isEdit = !!h;
  editId = h?.id||null;
  document.getElementById('modal-title').textContent = h?'Editar Hotel':'Nuevo Hotel';
  ['nombre','fechaIn','fechaOut','single','double','triple','quad'].forEach(k=>
    document.getElementById(`h-${k}`).value = h?.[k]||''
  );
  document.getElementById('h-statusDefault').value = h?.grupos?.[0]?.status||'confirmado';
  choiceGrupos.removeActiveItems();
  if(h?.grupos) choiceGrupos.setChoiceByValue(h.grupos.map(x=>x.id));
  document.getElementById('modal-backdrop').style.display='block';
  document.getElementById('modal-hotel').style.display   ='block';
}

// 7) Guardar/Editar Hotel + Historial
async function onSubmitHotel(evt){
  evt.preventDefault();
  const sel = choiceGrupos.getValue(true);
  const defaultStatus = document.getElementById('h-statusDefault').value;
  const gruposArr = sel.map(id=>({
    id, status:defaultStatus, changedBy: currentUserEmail
  }));
  const pay = {
    nombre:     document.getElementById('h-nombre').value.trim(),
    fechaIn:    document.getElementById('h-fechaIn').value,
    fechaOut:   document.getElementById('h-fechaOut').value,
    single:     +document.getElementById('h-single').value||0,
    double:     +document.getElementById('h-double').value||0,
    triple:     +document.getElementById('h-triple').value||0,
    quad:       +document.getElementById('h-quad').value||0,
    grupos:     gruposArr
  };

  if(isEdit){
    const before = (await getDoc(doc(db,'hoteles',editId))).data();
    await updateDoc(doc(db,'hoteles',editId), pay);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-edit', hotelId:editId,
      antes:before, despues:pay,
      usuario:currentUserEmail, ts:serverTimestamp()
    });
  } else {
    const ref = await addDoc(collection(db,'hoteles'), pay);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-new', hotelId:ref.id,
      antes:null, despues:pay,
      usuario:currentUserEmail, ts:serverTimestamp()
    });
  }
  closeModal();
  renderHoteles();
}

// 8) Eliminar Hotel
async function deleteHotel(id){
  if(!confirm('¿Eliminar hotel completo?')) return;
  const before = (await getDoc(doc(db,'hoteles',id))).data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'),{
    tipo:'hotel-del', hotelId:id,
    antes, despues:null,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  renderHoteles();
}

// 9) Quitar Grupo
window.removeGroup = async(hId, idx) => {
  const ref = doc(db,'hoteles',hId);
  const snap = await getDoc(ref), data = snap.data();
  const before = data.grupos[idx];
  data.grupos.splice(idx,1);
  await updateDoc(ref,{ grupos:data.grupos });
  await addDoc(collection(db,'historial'),{
    tipo:'grupo-remove', hotelId:hId,
    grupoId:before.id, antes:before, despues:null,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  renderHoteles();
};

// 10) Toggle Estado
window.toggleStatus = async(hId, idx) => {
  const ref = doc(db,'hoteles',hId);
  const snap = await getDoc(ref), data = snap.data();
  const old = data.grupos[idx];
  const neu = { 
    ...old,
    status: old.status==='pendiente'?'confirmado':'pendiente',
    changedBy: currentUserEmail
  };
  data.grupos[idx] = neu;
  await updateDoc(ref,{ grupos:data.grupos });
  await addDoc(collection(db,'historial'),{
    tipo:'grupo-status', hotelId:hId,
    grupoId:old.id, antes:old, despues:neu,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  renderHoteles();
};

// 11) Cerrar modal
function closeModal(){
  document.getElementById('modal-backdrop').style.display='none';
  document.getElementById('modal-hotel').style.display   ='none';
}

// 12) Grupo modal & guardar grupo: copia desde viajes.js **literal**

async function onSubmitGroup(evt){
  evt.preventDefault();
  const form = document.getElementById('group-form');
  const id   = form.dataset.grupoId;
  const before = (await getDoc(doc(db,'grupos',id))).data();
  const nombresArr = document.getElementById('g-nombresCoordinadores').value
    .split(',').map(s=>s.trim()).filter(Boolean);
  const data = {
    empresaBus: document.getElementById('g-empresaBus').value.trim(),
    adultos:    +document.getElementById('g-adultos').value||0,
    estudiantes:+document.getElementById('g-estudiantes').value||0,
    nombresCoordinadores: nombresArr
  };
  await updateDoc(doc(db,'grupos',id), data);
  await addDoc(collection(db,'historial'),{
    tipo:'grupo-edit', grupoId:id,
    antes:before, despues:data,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  await loadGrupos();
  renderHoteles();
  closeGroupModal();
}

// 13) Historial: copia loadHistorial() de viajes.js sin cambios.

// 14) Exportar a Excel (Opción A: detalle por grupo)
function exportToExcel(){
  const data = [];
  hoteles.forEach(h => {
    h.grupos.forEach(gObj => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      const a = parseInt(g.adultos||0,10);
      const e = parseInt(g.estudiantes||0,10);
      const nombresArr = Array.isArray(g.nombresCoordinadores)
        ? g.nombresCoordinadores
        : (g.nombresCoordinadores
           ? g.nombresCoordinadores.split(',').map(s=>s.trim())
           : []);
      const c = nombresArr.length||1;
      data.push({
        Hotel:      h.nombre,
        CheckIn:    h.fechaIn,
        CheckOut:   h.fechaOut,
        Grupo_Num:  g.numeroNegocio,
        Grupo_Nom:  g.nombreGrupo,
        Adultos:    a,
        Estudiantes:e,
        Coordinadores:c,
        TotalPax:   a+e+c,
        Estado:     gObj.status,
        Usuario:    gObj.changedBy||''
      });
    });
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "DetalleHoteles");
  XLSX.writeFile(wb, "hoteles_detalle.xlsx");
}
