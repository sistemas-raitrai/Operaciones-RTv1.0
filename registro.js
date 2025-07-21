// registro.js

import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db }   from "./firebase-init.js";
import {
  doc, setDoc, getDoc,
  collection, addDoc
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// ——————————————————————————————————————————————————————————————
// 1) Constantes y mapeo de campos
// ——————————————————————————————————————————————————————————————
const auth     = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// Campos que vamos a guardar
const campos = [
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora'
];

// Catálogos canónicos
const DESTINOS_CANONICOS = [
  'SUR DE CHILE',
  'NORTE DE CHILE',
  'BARILOCHE',
  'BRASIL',
  'SUR DE CHILE Y BARILOCHE',
  'OTRO'
];
const PROGRAMAS_POR_DESTINO = {
  'SUR DE CHILE': [
    'SUR DE CHILE 7/6',
    'SUR DE CHILE HUILO HUILO 7/6',
    'SUR DE CHILE PUCON 7/6'
  ],
  'NORTE DE CHILE': [
    'SAN PEDRO DE ATACAMA 7/6'
  ],
  'BARILOCHE': [
    'BARILOCHE 6/5',
    'BARILOCHE 7/6'
  ],
  'BRASIL': [
    'CAMBORIÚ ECO 8/7',
    'CAMBORIÚ VUELO DIRECTO 6/5',
    'CAMBORIÚ VUELO DIRECTO 8/7'
  ],
  'SUR DE CHILE Y BARILOCHE': [
    'SUR DE CHILE Y BARILOCHE 7/6',
    'SUR DE CHILE Y BARILOCHE 8/7'
  ],
  'OTRO': []
};
let manualMode = false;

// DOM shortcuts
const elems = {};
[
  'filtroAno','negocioList','nombreList',
  'destinosList','programasList','hoteles',
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','formRegistro','tbodyTabla'
].forEach(id => elems[id] = document.getElementById(id));

// ——————————————————————————————————————————————————————————————
// 2) Autenticación y arranque
// ——————————————————————————————————————————————————————————————
auth.onAuthStateChanged(user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    init();
  }
});

// ——————————————————————————————————————————————————————————————
// 3) Inicialización de toda la UI
// ——————————————————————————————————————————————————————————————
async function init() {
  // 3.1) Cargo todas las filas de Ventas del Sheet
  const ventas = await (await fetch(sheetURL)).json();

  // 3.2) Filtro de años para datalists de negocio/nombre
  const anos = [...new Set(ventas.map(r => r.anoViaje))].sort();
  elems.filtroAno.innerHTML =
    `<option value="">Todos</option>` +
    anos.map(a => `<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();
  elems.filtroAno.onchange = () => {
    const y = elems.filtroAno.value;
    const list = y ? ventas.filter(r => r.anoViaje == y) : ventas;
    elems.negocioList.innerHTML =
      list.map(r => `<option value="${r.numeroNegocio}"></option>`).join('');
    elems.nombreList.innerHTML =
      list.map(r => `<option value="${r.nombreGrupo}"></option>`).join('');
  };
  elems.filtroAno.dispatchEvent(new Event('change'));

  // 3.3) Carga destinos canónicos
  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d => `<option>${d}</option>`).join('');

  // 3.4) Listeners
  ['numeroNegocio','nombreGrupo'].forEach(id => {
    elems[id].onchange = () => loadVenta(ventas);
  });
  elems.destino.onchange      = handleDestinoChange;
  elems.programa.onchange     = handleProgramaChange;
  elems.fechaInicio.onchange  = calcularFin;
  elems.adultos.oninput       = ajustComp;
  elems.estudiantes.oninput   = ajustComp;
  elems.formRegistro.onsubmit = e => { e.preventDefault(); guardar(); };
}

// ——————————————————————————————————————————————————————————————
// 4) Cuando cambia el DESTINO
// ——————————————————————————————————————————————————————————————
function handleDestinoChange() {
  const d = elems.destino.value;
  manualMode = (d === 'OTRO');
  // Listado de programas canónicos para este destino
  elems.programasList.innerHTML =
    (PROGRAMAS_POR_DESTINO[d] || []).map(p => `<option>${p}</option>`).join('');
  // Listado de hoteles canónicos para este destino
  elems.hoteles.innerHTML =
    (HOTELES_POR_DESTINO[d] || []).map(h => `<option value="${h}">${h}</option>`).join('');
}

// ——————————————————————————————————————————————————————————————
// 5) Cuando cambia el PROGRAMA
// ——————————————————————————————————————————————————————————————
function handleProgramaChange() {
  if (!manualMode) {
    const p = elems.programa.value;
    // Si el programa coincide con uno canónico, forzamos el destino
    const dest = Object.entries(PROGRAMAS_POR_DESTINO)
      .find(([, arr]) => arr.includes(p))?.[0];
    if (dest && elems.destino.value !== dest) {
      elems.destino.value = dest;
      handleDestinoChange();
    }
    // Extraigo días/noches de “X/Y”
    const m = p.match(/(\d+)\/(\d+)$/);
    if (m) {
      elems.duracion.value = m[1];
      elems.noches.value   = m[2];
    }
    calcularFin();
  }
}

// ——————————————————————————————————————————————————————————————
// 6) Calcular fecha de término = inicio + días - 1
// ——————————————————————————————————————————————————————————————
function calcularFin() {
  const inicio = elems.fechaInicio.value;
  const dias   = Number(elems.duracion.value) || 0;
  if (inicio && dias) {
    const d = new Date(inicio);
    d.setDate(d.getDate() + dias - 1);
    elems.fechaFin.value = d.toISOString().slice(0,10);
  } else {
    elems.fechaFin.value = '';
  }
}

// ——————————————————————————————————————————————————————————————
// 7) Ajustar Adultos/Estudiantes para no superar pax
// ——————————————————————————————————————————————————————————————
function ajustComp(e) {
  const total = Number(elems.cantidadgrupo.value) || 0;
  const val   = Number(e.target.value) || 0;
  if (e.target === elems.adultos) {
    elems.estudiantes.value = Math.max(0, total - val);
  } else {
    elems.adultos.value     = Math.max(0, total - val);
  }
}

// ——————————————————————————————————————————————————————————————
// 8) Cargar un registro EXISTENTE de Ventas
// ——————————————————————————————————————————————————————————————
async function loadVenta(ventas) {
  const v = ventas.find(r =>
    String(r.numeroNegocio) === elems.numeroNegocio.value ||
    r.nombreGrupo === elems.nombreGrupo.value
  );
  if (!v) return;

  // 8.1) Rellenar campos básicos (excepto días/noches/fechaFin)
  campos.forEach(c => {
    if (!['duracion','noches','fechaFin'].includes(c)) {
      elems[c].value = v[c] || '';
    }
  });

  // 8.2) Normalizar destino: si el texto libre incluye un canónico, lo usamos
  const dn = DESTINOS_CANONICOS.find(d =>
    v.destino?.toUpperCase().includes(d)
  ) || 'OTRO';
  elems.destino.value = dn;
  handleDestinoChange();

  // 8.3) Normalizar programa: buscar substring en la lista canónica
  const pn = (PROGRAMAS_POR_DESTINO[dn] || [])
    .find(p => v.programa?.toUpperCase().includes(p)) || v.programa || '';
  elems.programa.value = pn;
  handleProgramaChange();

  // 8.4) Calcular fechaFin
  calcularFin();

  // 8.5) Prepara el listado FINAL de hoteles:
  //     Unión de hoteles canónicos + texto libre de Ventas
  const origText = (v.hotel || v.hoteles?.join(' , ') || '').toUpperCase();
  // Extraigo cada hotel libre por comas o “ Y ”
  const libres = origText
    .split(/,| Y /i)
    .map(h => h.trim())
    .filter(Boolean);

  // Mapa de canónicos
  const canónicos = HOTELES_POR_DESTINO[dn] || [];

  // Unión sin duplicados, respetando mayúsculas
  const unión = Array.from(new Set([
    ...libres,
    ...canónicos
  ]));

  // Renderizo <option> para cada uno
  elems.hoteles.innerHTML = unión
    .map(h => `<option value="${h}"${libres.includes(h) ? ' selected' : ''}>${h}</option>`)
    .join('');

  // 8.6) Pinto la tabla histórica
  paintTable(v.numeroNegocio);
}

// ——————————————————————————————————————————————————————————————
// 9) Guardar en Firestore + Historial
// ——————————————————————————————————————————————————————————————
async function guardar() {
  const id   = elems.numeroNegocio.value;
  const ref  = doc(db, 'grupos', id);
  const user = auth.currentUser.email;
  const payload = {};

  // 9.1) Armo payload con todos los campos
  campos.forEach(c => payload[c] = elems[c].value);
  payload.hoteles        = [...elems.hoteles.selectedOptions].map(o => o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();

  // 9.2) Grabo en Firestore (merge para no borrar otros campos)
  await setDoc(ref, payload, { merge: true });

  // 9.3) Registro de historial de cambios
  const snapBefore = await getDoc(ref);
  const before     = snapBefore.exists() ? snapBefore.data() : {};
  const cambios    = [];
  Object.keys(payload).forEach(k => {
    if (JSON.stringify(before[k] || '') !== JSON.stringify(payload[k] || '')) {
      cambios.push({
        campo: k,
        anterior: before[k] || null,
        nuevo: payload[k]
      });
    }
  });
  if (cambios.length) {
    const col = collection(db, 'historial');
    await Promise.all(cambios.map(c =>
      addDoc(col, {
        numeroNegocio: id,
        campo:         c.campo,
        anterior:      c.anterior,
        nuevo:         c.nuevo,
        modificadoPor: user,
        timestamp:     new Date()
      })
    ));
  }

  alert('✅ Datos guardados en Firestore');
  paintTable(id);
}

// ——————————————————————————————————————————————————————————————
// 10) Mostrar en la tabla lo que hay en Firestore
// ——————————————————————————————————————————————————————————————
async function paintTable(id) {
  const snap = await getDoc(doc(db, 'grupos', id));
  if (!snap.exists()) return;
  const d     = snap.data();
  const tbody = elems.tbodyTabla;
  tbody.innerHTML = '';
  const tr = document.createElement('tr');

  [
    d.numeroNegocio, d.nombreGrupo, d.cantidadgrupo,
    d.colegio,       d.curso,       d.anoViaje,
    d.destino,       d.programa,    d.fechaInicio,
    d.duracion,      d.noches,      d.fechaFin,
    d.adultos,       d.estudiantes,
    d.asistenciaEnViajes, d.autorizacion, d.fechaDeViaje,
    d.vendedora,     (d.hoteles || []).join(', '),
    d.actualizadoPor, d.actualizadoEn.toLocaleString()
  ].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });

  tbody.appendChild(tr);
}
