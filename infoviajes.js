// Importes de Firebase
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, setDoc,
  collection,   
  getDocs  
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ————————————————————————————————————————————————————————————
// Elementos del DOM
// ————————————————————————————————————————————————————————————
const selNum       = document.getElementById('numeroNegocio');
const inpNombre    = document.getElementById('nombreGrupo');
const inpDestino   = document.getElementById('destino');
const inpPrograma  = document.getElementById('programa');
const inpInicio    = document.getElementById('fechaInicio');
const inpDuracion  = document.getElementById('duracion');
const inpFin       = document.getElementById('fechaFin');
const inpTotal     = document.getElementById('totalPax');
const inpAdultos   = document.getElementById('adultos');
const inpEst       = document.getElementById('estudiantes');
const selTran      = document.getElementById('transporte');
const seccionTramos= document.getElementById('seccionTramos');
const contTramos   = document.getElementById('tramosDetalle');
const btnAddTramo  = document.getElementById('btnAddTramo');
const inpHoteles   = document.getElementById('hoteles');
const inpCiudades  = document.getElementById('ciudades');
const inpObs       = document.getElementById('observaciones');
const form         = document.getElementById('formInfoViaje');

let tramoCount = 0;  // para numerar dinámicamente los tramos

// ————————————————————————————————————————————————————————————
// 1) Autenticación y arranque
// ————————————————————————————————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  initForm();
});

// ————————————————————————————————————————————————————————————
// 2) Carga inicial: leer 'grupos' para poblar select
// ————————————————————————————————————————————————————————————
async function initForm() {
  const snap = await getDocs(collection(db, 'grupos'));
  // Pobla Número de Negocio
  selNum.innerHTML = snap.docs.map(d=>`
    <option value="${d.id}">${d.data().numeroNegocio}</option>
  `).join('');
  // al cambiar grupo:
  selNum.onchange = cargarGrupo;
  // y disparar la primera carga:
  selNum.dispatchEvent(new Event('change'));

  // Duración o fecha inicio recalcular fecha fin:
  inpDuracion.oninput = calcularFin;
  inpInicio.onchange  = calcularFin;

  // Adultos/Estudiantes deben sumar total:
  inpAdultos.oninput = ajustarComp;
  inpEst.oninput     = ajustarComp;

  // Transporte -> toggle de sección tramos
  selTran.onchange   = toggleTramos;
  btnAddTramo.onclick= addTramo;

  // Guardar formulario
  form.onsubmit      = guardarInfo;
}

// ————————————————————————————————————————————————————————————
// 3) Carga datos del grupo seleccionado
// ————————————————————————————————————————————————————————————
async function cargarGrupo() {
  const id = selNum.value;
  const ref = doc(db,'grupos',id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const d = snap.data();

  inpNombre.value   = d.nombreGrupo      || '';
  inpDestino.value  = d.destino          || '';
  inpPrograma.value = d.programa         || '';
  inpTotal.value    = d.cantidadgrupo    || '';

  // si ya hay un documento en 'viajes', cargarlo:
  const vref = doc(db,'viajes', id);
  const vsnap= await getDoc(vref);
  if (vsnap.exists()) {
    const v = vsnap.data();
    inpInicio.value   = v.fechaInicio   || '';
    inpDuracion.value = v.duracion      || '';
    inpAdultos.value  = v.adultos       || '';
    inpEst.value      = v.estudiantes   || '';
    selTran.value     = v.transporte    || '';
    inpHoteles.value  = v.hoteles       || '';
    inpCiudades.value = v.ciudades      || '';
    inpObs.value      = v.observaciones || '';
    // render tramos si los hay:
    toggleTramos();
    if (v.tramos) renderTramos(v.tramos);
  } else {
    // limpiar antiguo
    inpInicio.value= inpDuracion.value= '';
    inpAdultos.value= inpEst.value= '';
    selTran.value='';
    inpHoteles.value= inpCiudades.value= inpObs.value='';
    contTramos.innerHTML='';
    seccionTramos.style.display='none';
  }
  calcularFin();
}

// ————————————————————————————————————————————————————————————
// 4) Calcular Fecha Fin = inicio + duración -1
// ————————————————————————————————————————————————————————————
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = '';
    return;
  }
  const inicio = new Date(inpInicio.value);
  inicio.setDate(inicio.getDate() + parseInt(inpDuracion.value,10) - 1);
  inpFin.value = inicio.toISOString().slice(0,10);
}

// ————————————————————————————————————————————————————————————
// 5) Adultos/Estudiantes mutuamente condicionados
// ————————————————————————————————————————————————————————————
function ajustarComp(e) {
  const total = parseInt(inpTotal.value,10)||0;
  const a = parseInt(inpAdultos.value,10)||0;
  const s = parseInt(inpEst.value,10)||0;
  if (e.target===inpAdultos) {
    inpEst.value = total - a;
  } else {
    inpAdultos.value = total - s;
  }
}

// ————————————————————————————————————————————————————————————
// 6) Mostrar/ocultar sección de Tramos según transporte
// ————————————————————————————————————————————————————————————
function toggleTramos() {
  const t = selTran.value;
  // si es aéreo o mixto mostramos
  if (t==='aereo' || t==='mixto' || t==='terrestre' || t==='mixto') {
    seccionTramos.style.display = 'block';
    // si cambiamos tipo, borramos viejos tramos:
    contTramos.innerHTML = '';
    tramoCount = 0;
  } else {
    seccionTramos.style.display = 'none';
    contTramos.innerHTML = '';
    tramoCount = 0;
  }
}

// ————————————————————————————————————————————————————————————
// 7) Agregar un bloque de Tramo (aéreo o bus) dinámico
// ————————————————————————————————————————————————————————————
function addTramo() {
  const tipo = selTran.value;
  tramoCount++;
  const idx = tramoCount;
  let html = '';

  if (tipo==='aereo' || tipo==='mixto') {
    html += `
      <fieldset class="tramo" data-idx="${idx}">
        <legend>Vuelo ${idx}</legend>
        <label>Aeropuerto origen:</label><input /><br/>
        <label>Hora salida:</label><input type="time" /><br/>
        <label>Aerolínea:</label>
        <select>
          <option>LATAM</option><option>SKY</option><option>OTRO</option>
        </select><br/>
        <label>N° vuelo:</label><input /><br/>
        <label>Hora llegada:</label><input type="time" /><br/>
        <button type="button" class="delTramo">Eliminar</button>
      </fieldset>
    `;
  }
  if (tipo==='terrestre' || tipo==='mixto') {
    html += `
      <fieldset class="tramo" data-idx="${idx}">
        <legend>Bus ${idx}</legend>
        <label>Empresa buses:</label><input /><br/>
        <label>Conductor 1:</label><input /><br/>
        <label>Conductor 2:</label><input /><br/>
        <label>Lugar salida:</label><input /><br/>
        <label>Hora ida:</label><input type="time" /><br/>
        <label>Lugar retorno:</label><input /><br/>
        <label>Hora regreso:</label><input type="time" /><br/>
        <button type="button" class="delTramo">Eliminar</button>
      </fieldset>
    `;
  }

  const div = document.createElement('div');
  div.innerHTML = html;
  // botón eliminar tramo
  div.querySelectorAll('.delTramo').forEach(b => {
    b.onclick = _=> b.closest('fieldset').remove();
  });
  contTramos.appendChild(div);
}

// ————————————————————————————————————————————————————————————
// 8) Rellenar tramos existentes al cargar
// ————————————————————————————————————————————————————————————
function renderTramos(tramos) {
  tramos.forEach((t,i) => {
    // simula addTramo y luego rellenar inputs con t.*
    addTramo();
    // aquí podrías mapear cada campo de 'tramosDetalle'…
  });
}

// ————————————————————————————————————————————————————————————
// 9) Guardar toda la info en Firestore (“viajes”)
// ————————————————————————————————————————————————————————————
async function guardarInfo(evt) {
  evt.preventDefault();
  const id = selNum.value;
  const payload = {
    fechaInicio:   inpInicio.value,
    duracion:      parseInt(inpDuracion.value,10),
    fechaFin:      inpFin.value,
    adultos:       parseInt(inpAdultos.value,10),
    estudiantes:   parseInt(inpEst.value,10),
    transporte:    selTran.value,
    // recoger todos los tramos:
    tramos: Array.from(contTramos.querySelectorAll('.tramo')).map(fs => {
      const vals = [...fs.querySelectorAll('input,select')].map(i=>i.value);
      return vals; // ajusta a un objeto más legible si quieres
    }),
    hoteles:       inpHoteles.value.split(';').map(s=>s.trim()).filter(Boolean),
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn: new Date().toISOString()
  };

  await setDoc(doc(db,'viajes', id), payload, { merge: true });
  alert('Información guardada ✅');
}
