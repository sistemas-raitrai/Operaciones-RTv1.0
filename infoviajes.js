// Importes de Firebase
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// Elementos del DOM
const numeroNegocio  = document.getElementById('numeroNegocio');
const nombreGrupo    = document.getElementById('nombreGrupo');
const destino        = document.getElementById('destino');
const programa       = document.getElementById('programa');
const fechaInicio    = document.getElementById('fechaInicio');
const duracion       = document.getElementById('duracion');
const fechaFin       = document.getElementById('fechaFin');
const totalPax       = document.getElementById('totalPax');
const adultos        = document.getElementById('adultos');
const estudiantes    = document.getElementById('estudiantes');
const transporte     = document.getElementById('transporte');
const subformVuelos  = document.getElementById('subformVuelos');
const vuelosContainer= document.getElementById('vuelosContainer');
const btnAddVuelo    = document.getElementById('btnAddVuelo');
const subformBuses   = document.getElementById('subformBuses');
const busesContainer = document.getElementById('busesContainer');
const btnAddBus      = document.getElementById('btnAddBus');
const hoteles        = document.getElementById('hoteles');
const ciudades       = document.getElementById('ciudades');
const observaciones  = document.getElementById('observaciones');
const form           = document.getElementById('formInfoViaje');

// Autenticación
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
  else init();
});

// Carga select grupos y pone listeners
async function init() {
  // Leer documento de “grupos” para poblar el select
  // (aquí puedes listar todos o filtrar)
  const grupoDoc = await getDoc(doc(db, 'grupos', /* ID fijo o listado */ 'lista'));
  const grupos   = grupoDoc.data().todos || [];
  numeroNegocio.innerHTML = grupos.map(g =>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  // Al cambiar de grupo, cargo sus datos:
  numeroNegocio.onchange = loadGrupo;
  numeroNegocio.dispatchEvent(new Event('change'));
}

// Carga datos del grupo y llena campos
async function loadGrupo() {
  const id = numeroNegocio.value;
  if (!id) return;
  const snap = await getDoc(doc(db, 'grupos', id));
  const d    = snap.data() || {};
  nombreGrupo.value = d.nombreGrupo || '';
  destino.value     = d.destino         || '';
  programa.value    = d.programa        || '';
  fechaInicio.value = d.fechaInicio     || '';
  duracion.value    = d.duracion        || '';
  calcularFechaFin();
  totalPax.value    = d.cantidadgrupo   || '';
  adultos.value     = d.adultos         || '';
  estudiantes.value = d.estudiantes     || '';
  transporte.value  = d.transporte      || '';
  hoteles.value     = (d.hoteles || []).join('; ');
  ciudades.value    = (d.ciudades || []).join('; ');
  observaciones.value = d.observaciones || '';
  // Ajustar sección logística:
  transporte.dispatchEvent(new Event('change'));
}

// Recalcula fechaFin cuando cambian inicio/duración
fechaInicio.onchange = calcularFechaFin;
duracion.oninput    = calcularFechaFin;
function calcularFechaFin() {
  const start = fechaInicio.valueAsDate;
  const days  = parseInt(duracion.value, 10) || 0;
  if (start && days>0) {
    const end = new Date(start);
    end.setDate(end.getDate() + days - 1);
    fechaFin.valueAsDate = end;
  }
}

// Mostrar/ocultar subformularios según transporte
transporte.onchange = () => {
  const t = transporte.value;
  subformVuelos.style.display = (t==='aereo' || t==='mixto') ? 'block' : 'none';
  subformBuses .style.display = (t==='terrestre' || t==='mixto') ? 'block' : 'none';
};

// Agregar dinámicamente tramo de vuelo
btnAddVuelo.onclick = () => addVueloTramo();
function addVueloTramo(data={}) {
  const div = document.createElement('div');
  div.classList.add('tramo');
  div.innerHTML = `
    <fieldset>
      <legend>Vuelo</legend>
      <label>Origen: <input name="vueloOrigen" value="${data.origen||''}"></label>
      <label>Salida: <input type="time" name="vueloSalida" value="${data.salida||''}"></label>
      <label>Aerolínea:
        <select name="vueloAerolinea">
          <option${data.aerolinea==='LATAM'?' selected':''}>LATAM</option>
          <option${data.aerolinea==='SKY'  ?' selected':''}>SKY</option>
          <option${data.aerolinea==='OTRO' ?' selected':''}>OTRO</option>
        </select>
      </label>
      <label>Nº vuelo: <input name="vueloNum" value="${data.numero||''}"></label>
      <label>Llegada: <input type="time" name="vueloLlegada" value="${data.llegada||''}"></label>
      <button type="button" class="remove">Eliminar</button>
    </fieldset>`;
  vuelosContainer.appendChild(div);
  div.querySelector('.remove').onclick = () => div.remove();
}

// Agregar dinámicamente tramo de bus
btnAddBus.onclick = () => addBusTramo();
function addBusTramo(data={}) {
  const div = document.createElement('div');
  div.classList.add('tramo');
  div.innerHTML = `
    <fieldset>
      <legend>Bus</legend>
      <label>Empresa: <input name="busEmpresa" value="${data.empresa||''}"></label>
      <label>Cond. 1: <input name="busConductor1" value="${data.conductor1||''}"></label>
      <label>Cond. 2: <input name="busConductor2" value="${data.conductor2||''}"></label>
      <label>Ida - Lugar: <input name="busSalidaLugar" value="${data.lugarIda||''}"></label>
      <label>Ida - Hora: <input type="time" name="busSalidaHora" value="${data.horaIda||''}"></label>
      <label>Vta - Lugar: <input name="busRetornoLugar" value="${data.lugarVta||''}"></label>
      <label>Vta - Hora: <input type="time" name="busRetornoHora" value="${data.horaVta||''}"></label>
      <button type="button" class="remove">Eliminar</button>
    </fieldset>`;
  busesContainer.appendChild(div);
  div.querySelector('.remove').onclick = () => div.remove();
}

// Enviar / guardar todo en Firestore
form.onsubmit = async e => {
  e.preventDefault();
  const id = numeroNegocio.value;
  // Recoger vuelos
  const vuelos = [...vuelosContainer.querySelectorAll('.tramo')].map(fs => ({
    origen: fs.querySelector('[name=vueloOrigen]').value,
    salida: fs.querySelector('[name=vueloSalida]').value,
    aerolinea: fs.querySelector('[name=vueloAerolinea]').value,
    numero: fs.querySelector('[name=vueloNum]').value,
    llegada: fs.querySelector('[name=vueloLlegada]').value
  }));
  // Recoger buses
  const buses = [...busesContainer.querySelectorAll('.tramo')].map(fs => ({
    empresa: fs.querySelector('[name=busEmpresa]').value,
    conductor1: fs.querySelector('[name=busConductor1]').value,
    conductor2: fs.querySelector('[name=busConductor2]').value,
    lugarIda: fs.querySelector('[name=busSalidaLugar]').value,
    horaIda: fs.querySelector('[name=busSalidaHora]').value,
    lugarVta: fs.querySelector('[name=busRetornoLugar]').value,
    horaVta: fs.querySelector('[name=busRetornoHora]').value
  }));
  // Payload
  const payload = {
    fechaInicio: fechaInicio.value,
    duracion:    Number(duracion.value),
    fechaFin:    fechaFin.value,
    adultos:     Number(adultos.value),
    estudiantes: Number(estudiantes.value),
    transporte:  transporte.value,
    vuelos, buses,
    hoteles: hoteles.value.split(';').map(s=>s.trim()).filter(Boolean),
    ciudades: ciudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: observaciones.value,
    modificadoPor: auth.currentUser.email,
    fechaMod: new Date().toISOString()
  };
  // Guardar / merge
  await setDoc(doc(db, 'viajes', id), payload, { merge: true });
  alert('Información guardada ✅');
};
