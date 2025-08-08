// miviaje.js — visor SOLO LECTURA por numeroNegocio (sin autenticación)

import { app, db } from './firebase-init.js';
import {
  collection, doc, getDoc, getDocs, query, where, limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// -------------------------------
// Utiles de URL (soporta /miviaje/1383 o ?numeroNegocio=1383)
// -------------------------------
function getNumeroNegocioFromURL() {
  const parts = location.pathname.split('/').filter(Boolean);
  // /miviaje/1383 -> ["miviaje","1383"] (si index.html dentro de carpeta miviaje/)
  const maybe = parts.length >= 2 && parts[0].toLowerCase().includes('miviaje') ? parts[1] : null;
  const qs = new URLSearchParams(location.search).get('numeroNegocio');
  return (maybe || qs || '').trim();
}

// -------------------------------
// Render helpers (sin escritura)
// -------------------------------
function formatDateRange(ini, fin) {
  if (!ini || !fin) return '—';
  try {
    const [iy, im, id] = ini.split('-').map(Number);
    const [fy, fm, fd] = fin.split('-').map(Number);
    const di = new Date(iy, im - 1, id);
    const df = new Date(fy, fm - 1, fd);
    const fmt = (d) => d.toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric' });
    return `${fmt(di)} — ${fmt(df)}`;
  } catch { return '—'; }
}

function formatDateReadable(isoStr) {
  const [yyyy, mm, dd] = isoStr.split('-').map(Number);
  const d  = new Date(yyyy, mm - 1, dd);
  const wd = d.toLocaleDateString('es-CL', { weekday: 'long' });
  const name = wd.charAt(0).toUpperCase() + wd.slice(1);
  const ddp = String(dd).padStart(2, '0');
  const mmp = String(mm).padStart(2, '0');
  return `${name} ${ddp}/${mmp}`;
}

function getDateRange(startStr, endStr) {
  const out = [];
  if (!startStr || !endStr) return out;
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end   = new Date(ey, em - 1, ed);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const dd   = String(d.getDate()     ).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}

// -------------------------------
// Carga de grupo por numeroNegocio (string o num) o por docId directo
// -------------------------------
async function fetchGrupoByNumeroNegocio(numeroNegocio) {
  // 1) Intento docId == numeroNegocio
  const tryDoc = await getDoc(doc(db, 'grupos', numeroNegocio));
  if (tryDoc.exists()) return { id: tryDoc.id, ...tryDoc.data() };

  // 2) Intento where numeroNegocio == string
  let snap = await getDocs(query(
    collection(db, 'grupos'),
    where('numeroNegocio', '==', numeroNegocio),
    limit(1)
  ));
  if (!snap.empty) {
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  }

  // 3) Intento where numeroNegocio == número
  const asNum = Number(numeroNegocio);
  if (!Number.isNaN(asNum)) {
    snap = await getDocs(query(
      collection(db, 'grupos'),
      where('numeroNegocio', '==', asNum),
      limit(1)
    ));
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
  }

  return null;
}

// -------------------------------
// Render principal (solo lectura)
// -------------------------------
async function main() {
  const numeroNegocio = getNumeroNegocioFromURL();
  const titleEl   = document.getElementById('grupo-title');
  const nombreEl  = document.getElementById('grupo-nombre');
  const numEl     = document.getElementById('grupo-numero');
  const destinoEl = document.getElementById('grupo-destino');
  const fechasEl  = document.getElementById('grupo-fechas');
  const resumenPax= document.getElementById('resumen-pax');
  const cont      = document.getElementById('itinerario-container');

  if (!numeroNegocio) {
    cont.innerHTML = `<p style="padding:1rem;">Falta el número de negocio en la URL.</p>`;
    return;
  }

  const g = await fetchGrupoByNumeroNegocio(numeroNegocio);
  if (!g) {
    cont.innerHTML = `<p style="padding:1rem;">No se encontró el grupo ${numeroNegocio}.</p>`;
    return;
  }

  // Cabecera
  titleEl.textContent   = ` ${ (g.programa || '—').toUpperCase() }`;
  nombreEl.textContent  = g.nombreGrupo || '—';
  numEl.textContent     = g.numeroNegocio ?? g.id ?? '—';
  destinoEl.textContent = g.destino || '—';
  fechasEl.textContent  = formatDateRange(g.fechaInicio, g.fechaFin);

  const totalA = parseInt(g.adultos,10) || 0;
  const totalE = parseInt(g.estudiantes,10) || 0;
  const totalP = totalA + totalE;
  resumenPax.textContent = `👥 Total pax: ${totalP} (A:${totalA} · E:${totalE})`;

  // Itinerario (sin escribir si falta)
  let fechas = [];
  if (g.itinerario && typeof g.itinerario === 'object') {
    fechas = Object.keys(g.itinerario).sort((a,b) => new Date(a) - new Date(b));
  } else if (g.fechaInicio && g.fechaFin) {
    // Render de días vacíos si no hay itinerario cargado
    fechas = getDateRange(g.fechaInicio, g.fechaFin);
  }

  if (!fechas.length) {
    cont.innerHTML = `<p style="padding:1rem;">No hay itinerario disponible.</p>`;
    return;
  }

  cont.innerHTML = ''; // limpiar

  fechas.forEach((fecha, idx) => {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.dataset.fecha = fecha;

    // Encabezado día
    sec.innerHTML = `
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
    `;

    const ul = sec.querySelector('.activity-list');
    const arr = (g.itinerario?.[fecha] || []).slice();

    // Ordenamos por horaInicio, vacíos al final
    arr.sort((a,b) => {
      const ai = a?.horaInicio || '99:99';
      const bi = b?.horaInicio || '99:99';
      return ai.localeCompare(bi);
    });

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach(act => {
        const paxCalc = (parseInt(act.adultos,10)||0) + (parseInt(act.estudiantes,10)||0);
        const li = document.createElement('li');
        li.className = 'activity-card';
        li.innerHTML = `
          <h4>${act.horaInicio || '--:--'}${act.horaFin ? ' – ' + act.horaFin : ''}</h4>
          <p><strong>${(act.actividad||'').toString().toUpperCase()}</strong></p>
          <p>👥 ${paxCalc || act.pasajeros || 0} pax${(act.adultos||act.estudiantes)?` (A:${act.adultos||0} E:${act.estudiantes||0})`:''}</p>
          ${ act.notas ? `<p style="opacity:.85;">📝 ${act.notas}</p>` : '' }
        `;
        ul.appendChild(li);
      });
    }

    cont.appendChild(sec);
  });
}

main().catch(err => {
  console.error(err);
  document.getElementById('itinerario-container').innerHTML =
    `<p style="padding:1rem;color:#b00;">Error cargando el itinerario.</p>`;
});
