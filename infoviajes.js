// ——————————————————————————————
// 0) Importes Firebase (v11.7.3 modular)
// ——————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ——————————————————————————————
// 1) Referencias DOM
// ——————————————————————————————
const selNum        = document.getElementById('numeroNegocio');
const inpNombre     = document.getElementById('nombreGrupo');
const inpDestino    = document.getElementById('destino');
const inpPrograma   = document.getElementById('programa');
const inpCoord      = document.getElementById('coordinador');
const inpInicio     = document.getElementById('fechaInicio');
const inpDuracion   = document.getElementById('duracion');
const inpFin        = document.getElementById('fechaFin');
const inpTotal      = document.getElementById('totalPax');
const inpAdultos    = document.getElementById('adultos');
const inpEst        = document.getElementById('estudiantes');
const selTran       = document.getElementById('transporte');
const seccionTramos = document.getElementById('seccionTramos');
const contTramos    = document.getElementById('tramosDetalle');
const btnAddTramo   = document.getElementById('btnAddTramo');
const inpHoteles    = document.getElementById('hoteles');
const inpCiudades   = document.getElementById('ciudades');
const inpObs        = document.getElementById('observaciones');
const form          = document.getElementById('formInfoViaje');

let tramoCount = 0;

// ——————————————————————————————
// 2) Autenticación y arranque
// ——————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    initForm();
  }
});

// ——————————————————————————————
// 3) init: poblar select y listeners
// ——————————————————————————————
async function initForm() {
  // 3.1) Leer todos los grupos y poblar select
  const snap = await getDocs(collection(db, 'grupos'));
  selNum.innerHTML = snap.docs.map(d => {
    const dta = d.data();
    return `<option value="${d.id}">${dta.numeroNegocio}</option>`;
  }).join('');

  // 3.2) Listeners básicos
  selNum.onchange      = cargarGrupo;
  inpInicio.onchange   = calcularFin;
  inpDuracion.oninput  = calcularFin;
  inpAdultos.oninput   = ajustarComp;
  inpEst.oninput       = ajustarComp;
  selTran.onchange     = toggleTramos;
  btnAddTramo.onclick  = () => addTramo();
  form.onsubmit        = guardarInfo;

  // 3.3) Fuerza primera carga
  selNum.dispatchEvent(new Event('change'));
}

// ——————————————————————————————
// 4) cargarGrupo: lee ‘grupos/{id}’ y rellena form
// ——————————————————————————————
async function cargarGrupo() {
  const id    = selNum.value;
  const snapG = await getDoc(doc(db,'grupos',id));
  if (!snapG.exists()) return;
  const g = snapG.data();

  // 4.1) Campos base (solo lectura)
  inpNombre.value   = g.nombreGrupo   || '';
  inpDestino.value  = g.destino       || '';
  inpPrograma.value = g.programa      || '';
  inpTotal.value    = g.cantidadgrupo || '';

  // 4.2) Campos editables (se guardan en el mismo doc)
  inpCoord.value      = g.coordinador    || '';
  inpInicio.value     = g.fechaInicio    || '';
  inpDuracion.value   = g.duracion       || '';
  inpAdultos.value    = g.adultos        || '';
  inpEst.value        = g.estudiantes    || '';
  selTran.value       = g.transporte     || '';
  inpHoteles.value    = (g.hoteles  || []).join('; ');
  inpCiudades.value   = (g.ciudades || []).join('; ');
  inpObs.value        = g.observaciones  || '';

  // 4.3) Tramos previos
  toggleTramos();
  if (Array.isArray(g.tramos)) renderTramos(g.tramos);

  calcularFin();
}

// ——————————————————————————————
// 5) calcularFin: fechaFin = inicio + duracion - 1
// ——————————————————————————————
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = '';
    return;
  }
  const d = new Date(inpInicio.value);
  d.setDate(d.getDate() + Number(inpDuracion.value) - 1);
  inpFin.value = d.toISOString().slice(0,10);
}

// ——————————————————————————————
// 6) ajustarComp: adultos + estudiantes = total
// ——————————————————————————————
function ajustarComp(e) {
  const total = Number(inpTotal.value)||0;
  const a     = Number(inpAdultos.value)||0;
  const s     = Number(inpEst.value)||0;
  if (e.target === inpAdultos) {
    inpEst.value = total - a;
  } else {
    inpAdultos.value = total - s;
  }
}

// ——————————————————————————————
// 7) toggleTramos: mostrar/ocultar sección de tramos
// ——————————————————————————————
function toggleTramos() {
  const t = selTran.value;
  if (['aereo','terrestre','mixto'].includes(t)) {
    seccionTramos.style.display = 'block';
    contTramos.innerHTML = '';
    tramoCount = 0;
  } else {
    seccionTramos.style.display = 'none';
    contTramos.innerHTML = '';
    tramoCount = 0;
  }
}

// ——————————————————————————————
// 8) addTramo: crea un nuevo fieldset con los campos mínimos
// ——————————————————————————————
function addTramo(data = {}) {
  const tipo = selTran.value;
  tramoCount++;
  let html = '';

  // **Vuelo** (ida + vuelta)
  if (tipo === 'aereo' || tipo === 'mixto') {
    html += `
      <fieldset class="tramo">
        <legend>Vuelo ${tramoCount}</legend>
        <!-- Ida -->
        <label>Hora Salida (ida):<input type="time" value="${data.salida||''}"></label>
        <label>Origen (ida):<input value="${data.origen||''}"></label>
        <label>Aerolínea (ida):<input value="${data.aerolinea||''}"></label>
        <label>N° Vuelo (ida):<input value="${data.numero||''}"></label>
        <hr>
        <!-- Vuelta -->
        <label>Origen (vta):<input value="${data.origenVta||''}"></label>
        <label>Aerolínea (vta):<input value="${data.aerolineaVta||''}"></label>
        <label>N° Vuelo (vta):<input value="${data.numeroVta||''}"></label>
        <label>Hora Salida (vta):<input type="time" value="${data.salidaVta||''}"></label>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>
    `;
  }

  // **Bus** (terrestre)
  if (tipo === 'terrestre' || tipo === 'mixto') {
    html += `
      <fieldset class="tramo">
        <legend>Bus ${tramoCount}</legend>
        <label>Lugar Encuentro:<input value="${data.lugar||''}"></label>
        <label>Hora Inicio:<input type="time" value="${data.hora||''}"></label>
        <label>Empresa:<input value="${data.empresa||''}"></label>
        <label>Conductor 1:<input value="${data.cond1||''}"></label>
        <label>Conductor 2:<input value="${data.cond2||''}"></label>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>
    `;
  }

  // Inserto y enlazo “Eliminar”
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('.btn-del').forEach(b =>
    b.onclick = () => b.closest('fieldset').remove()
  );
  contTramos.appendChild(div);
}

// ——————————————————————————————
// 9) renderTramos: recarga tramos existentes
// ——————————————————————————————
function renderTramos(arr) {
  arr.forEach(t => addTramo(t));
}

// ——————————————————————————————
// 10) guardarInfo: updateDoc(grupos/{id}) + historial
// ——————————————————————————————
async function guardarInfo(evt) {
  evt.preventDefault();
  const id    = selNum.value;
  const refG  = doc(db,'grupos',id);
  const snapG = await getDoc(refG);
  const before = snapG.exists() ? snapG.data() : {};

  // Recojo tramos
  const tramos = [...contTramos.querySelectorAll('fieldset.tramo')].map(fs => {
    const inp = fs.querySelectorAll('input');
    return {
      salida:       inp[0].value,
      origen:       inp[1].value,
      aerolinea:    inp[2].value,
      numero:       inp[3].value,
      origenVta:    inp[5].value,
      aerolineaVta: inp[6].value,
      numeroVta:    inp[7].value,
      salidaVta:    inp[8].value,
      lugar:        inp[9]?.value   || '',
      hora:         inp[10]?.value  || '',
      empresa:      inp[11]?.value  || '',
      cond1:        inp[12]?.value  || '',
      cond2:        inp[13]?.value  || ''
    };
  });

  // Payload completo
  const payload = {
    coordinador:    inpCoord.value,
    fechaInicio:    inpInicio.value,
    duracion:       Number(inpDuracion.value),
    fechaFin:       inpFin.value,
    adultos:        Number(inpAdultos.value),
    estudiantes:    Number(inpEst.value),
    transporte:     selTran.value,
    tramos,
    hoteles:        inpHoteles.value.split(';').map(s=>s.trim()).filter(x=>x),
    ciudades:       inpCiudades.value.split(';').map(s=>s.trim()).filter(x=>x),
    observaciones:  inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn:  new Date()
  };

  // 10.1) Actualiza el doc en grupos/{id}
  await updateDoc(refG, payload);

  // 10.2) Compara y registra cada cambio en Firestore “historial”
  const cambios = [];
  for (const k in payload) {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({ campo: k, anterior: before[k]||null, nuevo: payload[k] });
    }
  }
  if (cambios.length) {
    await Promise.all(cambios.map(c =>
      addDoc(collection(db,'historial'), {
        numeroNegocio:  id,
        campo:          c.campo,
        anterior:       c.anterior,
        nuevo:          c.nuevo,
        modificadoPor:  auth.currentUser.email,
        timestamp:      new Date()
      })
    ));
  }

  alert('✅ Datos guardados y registrados');
}
