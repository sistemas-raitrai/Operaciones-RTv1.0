// registro.js

// 1️⃣ IMPORTS DE FIREBASE
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";
import {
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// 2️⃣ CONSTANTES Y CATÁLOGOS
const auth     = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// Campos relevantes del formulario
const campos = [
  'numeroNegocio','identificador','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','observaciones'
];

const DESTINOS_CANONICOS = [
  'SUR DE CHILE', 'NORTE DE CHILE', 'BARILOCHE',
  'BRASIL', 'SUR DE CHILE Y BARILOCHE', 'OTRO'
];

const PROGRAMAS_POR_DESTINO = {
  'SUR DE CHILE': [
    'SUR DE CHILE 7/6', 'SUR DE CHILE HUILO HUILO 7/6', 'SUR DE CHILE PUCON 7/6'
  ],
  'NORTE DE CHILE': ['SAN PEDRO DE ATACAMA 7/6'],
  'BARILOCHE': ['BARILOCHE 6/5', 'BARILOCHE 7/6'],
  'BRASIL': [
    'CAMBORIÚ ECO 8/7', 'CAMBORIÚ VUELO DIRECTO 6/5', 'CAMBORIÚ VUELO DIRECTO 8/7'
  ],
  'SUR DE CHILE Y BARILOCHE': [
    'SUR DE CHILE Y BARILOCHE 7/6', 'SUR DE CHILE Y BARILOCHE 8/7'
  ],
  'OTRO': []
};

const HOTELES_POR_DESTINO = {
  'SUR DE CHILE': ['HOTEL BORDELAGO','HOTEL VIENTOS DEL SUR'],
  'NORTE DE CHILE': ['HOTEL LA ALDEA'],
  'BARILOCHE': ['HOTEL PIONEROS VILLA HUINID','HOTEL ECOMAX'],
  'BRASIL': ['HOTEL MARIMAR','HOTEL PLAZA CAMBORIÚ','HOTEL BRUT','HOTEL HM','HOTEL GERANIUM','HOTEL MARAMBAIA'],
  'SUR DE CHILE Y BARILOCHE': ['HOTEL BORDELAGO','HOTEL VIENTOS DEL SUR','HOTEL PIONEROS VILLA HUINID','HOTEL ECOMAX'],
  'OTRO': []
};

let manualMode = false;

// 3️⃣ REFERENCIAS AL DOM
const elems = {};
[
  'filtroAno','negocioList','identificador','nombreList',
  'destinosList','programasList','hoteles',
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','observaciones',
  'formRegistro','tbodyTabla'
].forEach(id => elems[id] = document.getElementById(id));

elems.btnGuardar = document.getElementById('btnGuardar');

// 4️⃣ AUTENTICACIÓN Y ARRANQUE
auth.onAuthStateChanged(user => {
  if (!user) location.href = 'login.html';
  else init();
});

// 5️⃣ INICIALIZACIÓN
async function init() {
  const ventas = await (await fetch(sheetURL)).json();
  const anos = [...new Set(ventas.map(r => r.anoViaje))].sort();

  elems.filtroAno.innerHTML =
    `<option value="">Todos</option>` +
    anos.map(a => `<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();
  elems.filtroAno.onchange = () => {
    const y = elems.filtroAno.value;
    const list = y ? ventas.filter(r => r.anoViaje == y) : ventas;
    elems.negocioList.innerHTML = list.map(r => `<option value="${r.numeroNegocio}">`).join('');
    elems.nombreList.innerHTML  = list.map(r => `<option value="${r.nombreGrupo}">`).join('');
  };
  elems.filtroAno.dispatchEvent(new Event('change'));

  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d => `<option>${d}</option>`).join('');

  ['numeroNegocio','nombreGrupo'].forEach(id => {
    elems[id].onchange = () => loadDatos(ventas);
  });

  elems.destino.onchange      = handleDestinoChange;
  elems.programa.onchange     = handleProgramaChange;
  elems.fechaInicio.onchange  = calcularFin;
  elems.adultos.oninput       = ajustComp;
  elems.estudiantes.oninput   = ajustComp;
  elems.formRegistro.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault();
  });
  elems.btnGuardar.onclick = guardar;
}

// 6️⃣ FUNCIONES DE CAMBIO
function handleDestinoChange() {
  const d = elems.destino.value;
  manualMode = (d === 'OTRO');
  elems.programasList.innerHTML = (PROGRAMAS_POR_DESTINO[d] || []).map(p => `<option>${p}</option>`).join('');
  elems.hoteles.innerHTML = (HOTELES_POR_DESTINO[d] || []).map(h => `<option value="${h}">${h}</option>`).join('');
}

function handleProgramaChange() {
  if (!manualMode) {
    const p = elems.programa.value;
    const dest = Object.entries(PROGRAMAS_POR_DESTINO).find(([, arr]) => arr.includes(p))?.[0];
    if (dest && elems.destino.value !== dest) {
      elems.destino.value = dest;
      handleDestinoChange();
    }
    const m = p.match(/(\d+)\/(\d+)$/);
    if (m) { elems.duracion.value = m[1]; elems.noches.value = m[2]; }
    calcularFin();
  }
}

function calcularFin() {
  const inicio = elems.fechaInicio.value;
  const dias = Number(elems.duracion.value) || 0;
  if (inicio && dias) {
    const d = new Date(inicio);
    d.setDate(d.getDate() + dias - 1);
    elems.fechaFin.value = d.toISOString().slice(0,10);
  } else elems.fechaFin.value = '';
}

function ajustComp(e) {
  const total = Number(elems.cantidadgrupo.value) || 0;
  const val = Number(e.target.value) || 0;
  if (e.target === elems.adultos) elems.estudiantes.value = Math.max(0, total - val);
  else elems.adultos.value = Math.max(0, total - val);
}

// 7️⃣ CARGAR DATOS DESDE VENTAS Y FIREBASE
async function loadDatos(ventas) {
  let id = elems.numeroNegocio.value || '';
  const nombre = elems.nombreGrupo.value || '';

  // Buscar coincidencia en ventas
  const venta = ventas.find(r =>
    String(r.numeroNegocio) === id || r.nombreGrupo === nombre
  );
  if (venta) {
    elems.numeroNegocio.value = venta.numeroNegocio;
    id = String(venta.numeroNegocio);
    campos.forEach(c => {
      if (c === 'identificador') return;  
      if (!['duracion','noches','fechaFin'].includes(c)) {
        const tmp = document.createElement('div');
        tmp.innerHTML = venta[c] || '';
        elems[c].value = tmp.textContent || '';
      }
    });

    const dn = DESTINOS_CANONICOS.find(d => venta.destino?.toUpperCase().includes(d)) || 'OTRO';
    elems.destino.value = dn;
    handleDestinoChange();

    const pn = (PROGRAMAS_POR_DESTINO[dn] || []).find(p => venta.programa?.toUpperCase().includes(p)) || venta.programa || '';
    elems.programa.value = pn;
    handleProgramaChange();

    calcularFin();

    const origText = (venta.hotel || '').toUpperCase();
    const libres = origText.split(/,| Y /i).map(h => h.trim()).filter(Boolean);
    const canonicos = HOTELES_POR_DESTINO[dn] || [];
    const union = Array.from(new Set([...libres, ...canonicos]));
    elems.hoteles.innerHTML = union.map(h => `<option value="${h}" ${libres.includes(h) ? 'selected' : ''}>${h}</option>`).join('');
  }

  // 7.2) luego Firebase
  const ref  = doc(db, 'grupos', elems.numeroNegocio.value);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    if (data.identificador) elems.identificador.value = data.identificador;
    paintTable(elems.numeroNegocio.value);
  }
}

// 8️⃣ GUARDAR EN FIREBASE Y REGISTRAR HISTORIAL
async function guardar() {
  const id = elems.numeroNegocio.value;
  const ref = doc(db, 'grupos', id);
  const user = auth.currentUser.email;
  const payload = {};
  campos.forEach(c => payload[c] = elems[c].value);
  payload.hoteles = [...elems.hoteles.selectedOptions].map(o => o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn = new Date();

  const snapB = await getDoc(ref);
  const before = snapB.exists() ? snapB.data() : {};

  await setDoc(ref, payload, { merge: true });

  const cambios = [];
  Object.keys(payload).forEach(k => {
    if (JSON.stringify(before[k] || '') !== JSON.stringify(payload[k] || '')) {
      cambios.push({ campo: k, anterior: before[k] || null, nuevo: payload[k] });
    }
  });
  if (cambios.length) {
    const col = collection(db, 'historial');
    await Promise.all(cambios.map(c =>
      addDoc(col, {
        numeroNegocio: id,
        campo: c.campo,
        anterior: c.anterior,
        nuevo: c.nuevo,
        modificadoPor: user,
        timestamp: new Date()
      })
    ));
  }

  alert('✅ Datos guardados en Firestore');
  paintTable(id);
}

// 9️⃣ PINTAR TABLA INFERIOR
async function paintTable(id) {
  const snap = await getDoc(doc(db, 'grupos', id));
  if (!snap.exists()) return;
  const d = snap.data();
  const tbody = elems.tbodyTabla;
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  [
    d.numeroNegocio, d.identificador, d.nombreGrupo, d.cantidadgrupo,
    d.colegio, d.curso, d.anoViaje,
    d.destino, d.programa, d.fechaInicio,
    d.duracion, d.noches, d.fechaFin,
    d.adultos, d.estudiantes,
    d.asistenciaEnViajes, d.autorizacion, d.fechaDeViaje,
    d.vendedora, d.observaciones,
    (d.hoteles || []).join('; '),
    d.actualizadoPor, d.actualizadoEn.toLocaleString()
  ].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
