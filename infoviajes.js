// Importes de Firebase
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ——————————————————————————————
// 1) Referencias a los elementos del DOM
// ——————————————————————————————
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

let tramoCount = 0; // para numerar tramos

// ——————————————————————————————
// 2) Esperar autenticación y arrancar
// ——————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    initForm();
  }
});

// ——————————————————————————————
// 3) Inicializar: poblar select y poner listeners
// ——————————————————————————————
async function initForm() {
  // 3.1) Leer todos los grupos de Firestore
  const snap = await getDocs(collection(db, 'grupos'));
  // 3.2) Poblar el select de númeroNegocio
  selNum.innerHTML = snap.docs.map(d => {
    const data = d.data();
    return `<option value="${d.id}">${data.numeroNegocio}</option>`;
  }).join('');
  // 3.3) Al cambiar de grupo, recarga datos
  selNum.onchange = cargarGrupo;
  selNum.dispatchEvent(new Event('change'));

  // 3.4) Fechas: recálculo de fin
  inpInicio.onchange   = calcularFin;
  inpDuracion.oninput  = calcularFin;

  // 3.5) Composición: ajusta adultos/estudiantes mutuamente
  inpAdultos.oninput   = ajustarComp;
  inpEst.oninput       = ajustarComp;

  // 3.6) Transporte: mostrar/ocultar tramos
  selTran.onchange      = toggleTramos;
  btnAddTramo.onclick   = addTramo;

  // 3.7) Envío de formulario
  form.onsubmit         = guardarInfo;
}

// ——————————————————————————————
// 4) Cargar datos del grupo y su “viaje”
// ——————————————————————————————
async function cargarGrupo() {
  const id   = selNum.value;
  const refG = doc(db, 'grupos', id);
  const snapG= await getDoc(refG);
  if (!snapG.exists()) return;
  const g = snapG.data();

  // campos base de “grupos”
  inpNombre.value   = g.nombreGrupo    || '';
  inpDestino.value  = g.destino        || '';
  inpPrograma.value = g.programa       || '';
  inpTotal.value    = g.cantidadgrupo  || '';

  // intento leer doc “viajes” (antes existía)
  const refV = doc(db, 'viajes', id);
  const snapV= await getDoc(refV);

  if (snapV.exists()) {
    const v = snapV.data();
    inpInicio.value    = v.fechaInicio   || '';
    inpDuracion.value  = v.duracion      || '';
    inpAdultos.value   = v.adultos       || '';
    inpEst.value       = v.estudiantes   || '';
    selTran.value      = v.transporte    || '';
    inpHoteles.value   = (v.hoteles || []).join('; ');
    inpCiudades.value  = (v.ciudades || []).join('; ');
    inpObs.value       = v.observaciones || '';
    // mostrar tramos previos
    toggleTramos();
    if (v.tramos) renderTramos(v.tramos);
  } else {
    // limpiar si no hay “viaje”
    inpInicio.value = inpDuracion.value = '';
    inpAdultos.value = inpEst.value = '';
    selTran.value = '';
    inpHoteles.value = inpCiudades.value = inpObs.value = '';
    contTramos.innerHTML = '';
    seccionTramos.style.display = 'none';
  }

  calcularFin();
}

// ——————————————————————————————
// 5) Fecha Fin = Fecha Inicio + Duración – 1
// ——————————————————————————————
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = '';
    return;
  }
  const dt = new Date(inpInicio.value);
  dt.setDate(dt.getDate() + Number(inpDuracion.value) - 1);
  inpFin.value = dt.toISOString().slice(0,10);
}

// ——————————————————————————————
// 6) Adultos y Estudiantes se auto-ajustan
// ——————————————————————————————
function ajustarComp(e) {
  const total = Number(inpTotal.value) || 0;
  const a     = Number(inpAdultos.value) || 0;
  const s     = Number(inpEst.value)     || 0;
  if (e.target === inpAdultos) {
    inpEst.value = total - a;
  } else {
    inpAdultos.value = total - s;
  }
}

// ——————————————————————————————
// 7) Mostrar/ocultar sección de tramos
// ——————————————————————————————
function toggleTramos() {
  const t = selTran.value;
  if (t === 'aereo' || t === 'terrestre' || t === 'mixto') {
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
// 8) Añadir un bloque de “Tramo” (vuelo o bus)
// ——————————————————————————————
function addTramo(data = {}) {
  const tipo = selTran.value;
  tramoCount++;
  const idx = tramoCount;
  let html = '';

  // si incluye aéreo
  if (tipo === 'aereo' || tipo === 'mixto') {
    html += `
      <fieldset class="tramo">
        <legend>Vuelo ${idx}</legend>
        <label>Aeropuerto Origen:</label>
        <input value="${data.origen||''}" /><br/>
        <label>Salida (hora):</label>
        <input type="time" value="${data.salida||''}" /><br/>
        <label>Aerolínea:</label>
        <select>
          <option${data.aerolinea==='LATAM'?' selected':''}>LATAM</option>
          <option${data.aerolinea==='SKY'?' selected':''}>SKY</option>
          <option${data.aerolinea==='OTRO'?' selected':''}>OTRO</option>
        </select><br/>
        <label>N° Vuelo:</label><input value="${data.numero||''}" /><br/>
        <label>Llegada (hora):</label><input type="time" value="${data.llegada||''}" /><br/>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>
    `;
  }

  // si incluye terrestre
  if (tipo === 'terrestre' || tipo === 'mixto') {
    html += `
      <fieldset class="tramo">
        <legend>Bus ${idx}</legend>
        <label>Empresa buses:</label><input value="${data.empresa||''}" /><br/>
        <label>Conductor 1:</label><input value="${data.cond1||''}" /><br/>
        <label>Conductor 2:</label><input value="${data.cond2||''}" /><br/>
        <label>Salida lugar:</label><input value="${data.lugarIda||''}" /><br/>
        <label>Hora ida:</label><input type="time" value="${data.horaIda||''}" /><br/>
        <label>Retorno lugar:</label><input value="${data.lugarVta||''}" /><br/>
        <label>Hora regreso:</label><input type="time" value="${data.horaVta||''}" /><br/>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>
    `;
  }

  const div = document.createElement('div');
  div.innerHTML = html;
  // conectar botón eliminar
  div.querySelectorAll('.btn-del').forEach(b => {
    b.onclick = () => b.closest('fieldset').remove();
  });
  contTramos.appendChild(div);
}

// ——————————————————————————————
// 9) Renderizar tramos previos
// ——————————————————————————————
function renderTramos(tramos) {
  tramos.forEach(t => addTramo(t));
}

// ——————————————————————————————
// 10) Guardar todo en Firestore + historial
// ——————————————————————————————
async function guardarInfo(evt) {
  evt.preventDefault();
  const id     = selNum.value;
  const docG   = doc(db,'grupos',id);
  const snapG  = await getDoc(docG);
  const before = snapG.exists() ? snapG.data() : {};

  // Recojo todos los tramos como objetos
  const tramos = [...contTramos.querySelectorAll('fieldset.tramo')].map(fs=>{
    const inputs = fs.querySelectorAll('input,select');
    return {
      origen:     inputs[0].value,
      salida:     inputs[1].value,
      aerolinea:  inputs[2]?.value||'',
      numero:     inputs[3]?.value||'',
      llegada:    inputs[4]?.value||'',
      empresa:    inputs[5]?.value||'',
      cond1:      inputs[6]?.value||'',
      cond2:      inputs[7]?.value||'',
      lugarIda:   inputs[8]?.value||'',
      horaIda:    inputs[9]?.value||'',
      lugarVta:   inputs[10]?.value||'',
      horaVta:    inputs[11]?.value||''
    };
  });

  // Payload completo
  const payload = {
    fechaInicio:   inpInicio.value,
    duracion:      Number(inpDuracion.value),
    fechaFin:      inpFin.value,
    adultos:       Number(inpAdultos.value),
    estudiantes:   Number(inpEst.value),
    transporte:    selTran.value,
    tramos,
    hoteles:       inpHoteles.value.split(';').map(s=>s.trim()).filter(x=>x),
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(x=>x),
    observaciones: inpObs.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn:  new Date()
  };

  // 10.1) Actualiza el doc de grupos
  await updateDoc(docG, payload);

  // 10.2) Comparar y registrar en historial
  const cambios = [];
  for (const k of Object.keys(payload)) {
    const oldV = JSON.stringify(before[k]||'');
    const newV = JSON.stringify(payload[k]||'');
    if (oldV !== newV) {
      cambios.push({ campo:k, anterior: before[k]||null, nuevo: payload[k] });
    }
  }
  if (cambios.length) {
    await Promise.all(cambios.map(c =>
      addDoc(collection(db,'historial'), {
        numeroNegocio: id,
        campo:         c.campo,
        anterior:      c.anterior,
        nuevo:         c.nuevo,
        modificadoPor: auth.currentUser.email,
        timestamp:     new Date()
      })
    ));
  }

  alert('✅ Datos guardados y registrados en historial');
}
