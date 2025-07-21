// registro.js

// 1️⃣ IMPORTACIONES DE FIREBASE
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";
import {
  doc, setDoc, getDoc,
  collection, addDoc
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// 2️⃣ CONSTANTES Y CATÁLOGOS

// 2.1 👉 Autenticación
const auth = getAuth(app);

// 2.2 👉 URL de tu Web App de Apps Script (idéntica a la que ya funcionaba)
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// 2.3 👉 Campos que leemos del Sheet y guardamos en Firestore
const campos = [
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora'
];

// 2.4 👉 Destinos “canónicos” fijos
const DESTINOS_CANONICOS = [
  'SUR DE CHILE',
  'NORTE DE CHILE',
  'BARILOCHE',
  'BRASIL',
  'SUR DE CHILE Y BARILOCHE',
  'OTRO'
];

// 2.5 👉 Programas permitidos por destino
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

// 2.6 👉 Hoteles permitidos por destino
const HOTELES_POR_DESTINO = {
  'SUR DE CHILE':      ['BORDELAGO','VIENTOS DEL SUR'],
  'NORTE DE CHILE':    ['LA ALDEA'],
  'BARILOCHE':         ['VILLA HUINID','ECOMAX'],
  'BRASIL':            ['MARIMAR','PLAZA CAMBORIÚ','BRUT','HM','GERANIUM','MARAMBAIA'],
  'SUR DE CHILE Y BARILOCHE': ['BORDELAGO','VIENTOS DEL SUR','VILLA HUINID','ECOMAX'],
  'OTRO':               []
};

// Cuando el usuario elige “OTRO” destino, desactivamos la normalización automática
let manualMode = false;

// 3️⃣ REFERENCIAS AL DOM
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

// 4️⃣ AUTENTICACIÓN Y ARRANQUE
auth.onAuthStateChanged(user => {
  if (!user) {
    // Si no está autenticado, vamos a login
    location.href = 'login.html';
  } else {
    // Si hay usuario, inicializamos la UI
    init();
  }
});

// 5️⃣ INICIALIZACIÓN: datalists, listeners, etc.
async function init() {
  // 5.1) Traer todas las filas de Ventas desde Google Sheets
  const ventas = await (await fetch(sheetURL)).json();

  // 5.2) Construir filtro de años
  const anos = [...new Set(ventas.map(r => r.anoViaje))].sort();
  elems.filtroAno.innerHTML =
    `<option value="">Todos</option>` +
    anos.map(a => `<option>${a}</option>`).join('');
  // Por defecto al año actual
  elems.filtroAno.value = new Date().getFullYear();

  // Al cambiar el año, actualizamos los datalists
  elems.filtroAno.onchange = () => {
    const y = elems.filtroAno.value;
    const list = y ? ventas.filter(r => r.anoViaje == y) : ventas;
    elems.negocioList.innerHTML = list
      .map(r => `<option value="${r.numeroNegocio}"></option>`).join('');
    elems.nombreList.innerHTML = list
      .map(r => `<option value="${r.nombreGrupo}"></option>`).join('');
  };
  // Disparamos una vez para cargar inicialmente
  elems.filtroAno.dispatchEvent(new Event('change'));

  // 5.3) Poner destinos canónicos en el datalist
  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d => `<option>${d}</option>`).join('');

  // 5.4) Listeners sobre inputs clave
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

// 6️⃣ Cuando cambia el DESTINO
function handleDestinoChange() {
  const d = elems.destino.value;
  manualMode = (d === 'OTRO');
  // 6.1) Poblamos programas válidos para ese destino
  elems.programasList.innerHTML =
    (PROGRAMAS_POR_DESTINO[d] || [])
      .map(p => `<option>${p}</option>`).join('');
  // 6.2) Poblamos hoteles canónicos para ese destino
  elems.hoteles.innerHTML =
    (HOTELES_POR_DESTINO[d] || [])
      .map(h => `<option value="${h}">${h}</option>`).join('');
}

// 7️⃣ Cuando cambia el PROGRAMA
function handleProgramaChange() {
  if (!manualMode) {
    const p = elems.programa.value;
    // 7.1) Si el programa coincide con uno canónico, forzamos el destino
    const dest = Object.entries(PROGRAMAS_POR_DESTINO)
      .find(([, arr]) => arr.includes(p))?.[0];
    if (dest && elems.destino.value !== dest) {
      elems.destino.value = dest;
      handleDestinoChange();
    }
    // 7.2) Extraemos días y noches de “X/Y”
    const m = p.match(/(\d+)\/(\d+)$/);
    if (m) {
      elems.duracion.value = m[1];
      elems.noches.value   = m[2];
    }
    // 7.3) Recalculamos la fecha de término
    calcularFin();
  }
}

// 8️⃣ Fecha de término = fechaInicio + días - 1
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

// 9️⃣ Ajuste entre adultos y estudiantes para que no excedan PAX total
function ajustComp(e) {
  const total = Number(elems.cantidadgrupo.value) || 0;
  const val   = Number(e.target.value) || 0;
  if (e.target === elems.adultos) {
    elems.estudiantes.value = Math.max(0, total - val);
  } else {
    elems.adultos.value     = Math.max(0, total - val);
  }
}

// 🔟 Cargar un registro EXISTENTE de Ventas y normalizar
async function loadVenta(ventas) {
  const v = ventas.find(r =>
    String(r.numeroNegocio) === elems.numeroNegocio.value ||
    r.nombreGrupo === elems.nombreGrupo.value
  );
  if (!v) return;

  // 10.1) Rellenar campos (excepto duracion, noches, fechaFin)
  campos.forEach(c => {
    if (!['duracion','noches','fechaFin'].includes(c)) {
      elems[c].value = v[c] || '';
    }
  });

  // 10.2) Normalizar destino (buscar substring en canónicos)
  const dn = DESTINOS_CANONICOS.find(d =>
    v.destino?.toUpperCase().includes(d)
  ) || 'OTRO';
  elems.destino.value = dn;
  handleDestinoChange();

  // 10.3) Normalizar programa (buscar substring en lista del destino)
  const pn = (PROGRAMAS_POR_DESTINO[dn] || [])
    .find(p => v.programa?.toUpperCase().includes(p)) || v.programa || '';
  elems.programa.value = pn;
  handleProgramaChange();

  // 10.4) Recalcular fechaFin
  calcularFin();

  // 10.5) LÓGICA DE HOTELES:
  //      • Partir el texto libre de v.hotel por comas o " Y "
  //      • Unir ese array con los hoteles canónicos del destino
  const origText = (v.hotel || '').toUpperCase();
  const libres = origText
    .split(/,| Y /i)
    .map(h => h.trim())
    .filter(Boolean);
  const canonicos = HOTELES_POR_DESTINO[dn] || [];
  const union = Array.from(new Set([...libres, ...canonicos]));

  // Renderizamos el <select multiple> con las opciones y pre-seleccionamos las libres
  elems.hoteles.innerHTML = union
    .map(h => {
      const sel = libres.includes(h) ? ' selected' : '';
      return `<option value="${h}"${sel}>${h}</option>`;
    })
    .join('');

  // 10.6) Mostrar el histórico en la tabla
  paintTable(v.numeroNegocio);
}

// 1️⃣1️⃣ Guardar en Firestore y registrar historial de cambios
async function guardar() {
  const id   = elems.numeroNegocio.value;
  const ref  = doc(db, 'grupos', id);
  const user = auth.currentUser.email;
  const payload = {};

  // 11.1) Leer todos los campos en el payload
  campos.forEach(c => payload[c] = elems[c].value);
  // 11.2) Hoteles seleccionados
  payload.hoteles        = [...elems.hoteles.selectedOptions].map(o => o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();

  // 11.3) Set (merge) en Firestore
  await setDoc(ref, payload, { merge: true });

  // 11.4) Registrar cada campo cambiado en colección “historial”
  const beforeSnap = await getDoc(ref);
  const before     = beforeSnap.exists() ? beforeSnap.data() : {};
  const cambios = [];
  Object.keys(payload).forEach(k => {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({
        campo:    k,
        anterior: before[k] || null,
        nuevo:    payload[k]
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

// 1️⃣2️⃣ Pintar la tabla con el registro actual de Firestore
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
    d.vendedora,     (d.hoteles||[]).join(', '),
    d.actualizadoPor, d.actualizadoEn.toLocaleString()
  ].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });

  tbody.appendChild(tr);
}
