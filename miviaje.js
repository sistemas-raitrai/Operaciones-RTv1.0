// miviaje.js — visor SOLO LECTURA (sin autenticación)
// - Lee un grupo por ?id=<docId> (único) o por ?numeroNegocio=
// - Soporta números compuestos (1475 / 1411, 1475-1411, 1475,1411, 1475 y 1411)
// - Si hay varios matches, muestra un selector con links ?id=
// - Botones: Copiar enlace, Imprimir (con formato textual limpio para PDF)
// - Flag &notas=0 para ocultar notas en pantalla/impresión

import { app, db } from './firebase-core.js';
import {
  collection, doc, getDoc, getDocs, query, where, limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ──────────────────────────────────────────────────────────────────────────
   Lectura de parámetros:
   - /miviaje/<numero> como segmento
   - ?numeroNegocio= y ?id= (insensible a mayúsculas)
────────────────────────────────────────────────────────────────────────── */
function getParamsFromURL() {
  const parts = location.pathname.split('/').filter(Boolean);
  const i = parts.findIndex(p => p.toLowerCase().includes('miviaje'));
  const seg = (i >= 0 && parts[i + 1]) ? decodeURIComponent(parts[i + 1]) : null;

  const qs = new URLSearchParams(location.search);

  // numeroNegocio
  const numeroKey = [...qs.keys()].find(k => k.toLowerCase() === 'numeronegocio');
  const numero = (seg || (numeroKey ? qs.get(numeroKey) : '') || '').trim();

  // id
  const idKey = [...qs.keys()].find(k => k.toLowerCase() === 'id');
  const id = idKey ? qs.get(idKey).trim() : '';

  return { numeroNegocio: numero, id };
}

/* ──────────────────────────────────────────────────────────────────────────
   Tokenizador de números compuestos:
   "1475 / 1411", "1475-1411", "1475, 1411", "1475 y 1411"
────────────────────────────────────────────────────────────────────────── */
function splitNumeroCompuesto(value) {
  if (!value) return [];
  // separadores: / , -  o la palabra " y " (con espacios alrededor)
  return value
    .split(/(?:\s*[\/,-]\s*|\s+y\s+)/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/* ──────────────────────────────────────────────────────────────────────────
   Variantes compuestas con/sin espacios y distintos separadores:
   "1417/1419", "1417 / 1419", "1417-1419", "1417, 1419", etc.
────────────────────────────────────────────────────────────────────────── */
function buildCompositeVariants(value) {
  const partes = splitNumeroCompuesto(value);
  if (partes.length < 2) return [];
  const seps = ['/', '-', ','];
  const variants = new Set();

  for (const sep of seps) {
    variants.add(partes.join(sep));           // sin espacios
    variants.add(partes.join(` ${sep} `));    // espacios ambos lados
    variants.add(partes.join(` ${sep}`));     // espacio izq
    variants.add(partes.join(`${sep} `));     // espacio der
  }
  return [...variants];
}

/* ──────────────────────────────────────────────────────────────────────────
   Búsquedas
────────────────────────────────────────────────────────────────────────── */
async function fetchGrupoById(id) {
  if (!id) return null;
  const s = await getDoc(doc(db, 'grupos', id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

// Busca coincidencias por numeroNegocio (maneja compuestos y variantes)
async function buscarGruposPorNumero(numeroNegocio) {
  if (!numeroNegocio) return [];

  const vistos = new Map();          // id -> doc (dedup)
  const push = snap => snap.forEach(d => vistos.set(d.id, { id: d.id, ...d.data() }));

  // 0) Igualdad exacta al string recibido
  let snap = await getDocs(query(
    collection(db, 'grupos'),
    where('numeroNegocio', '==', numeroNegocio),
    limit(10)
  ));
  push(snap);

  // 0.b) Variantes compuestas
  const variantes = buildCompositeVariants(numeroNegocio);
  for (const v of variantes) {
    const s = await getDocs(query(
      collection(db, 'grupos'),
      where('numeroNegocio', '==', v),
      limit(10)
    ));
    push(s);
  }

  // 1) Igualdad como número (si aplica)
  const asNum = Number(numeroNegocio);
  if (!Number.isNaN(asNum)) {
    snap = await getDocs(query(
      collection(db, 'grupos'),
      where('numeroNegocio', '==', asNum),
      limit(10)
    ));
    push(snap);
  }

  // 2) Cada parte del compuesto (string y number)
  const partes = splitNumeroCompuesto(numeroNegocio);
  for (const p of partes) {
    const s1 = await getDocs(query(
      collection(db, 'grupos'),
      where('numeroNegocio', '==', p),
      limit(10)
    ));
    push(s1);

    const pn = Number(p);
    if (!Number.isNaN(pn)) {
      const s2 = await getDocs(query(
        collection(db, 'grupos'),
        where('numeroNegocio', '==', pn),
        limit(10)
      ));
      push(s2);
    }
  }

  return [...vistos.values()];
}

/* ──────────────────────────────────────────────────────────────────────────
   Selector cuando hay múltiples coincidencias
────────────────────────────────────────────────────────────────────────── */
function renderSelector(lista, cont) {
  const hideNotes = new URLSearchParams(location.search).get('notas') === '0';
  cont.innerHTML = `
    <div style="padding:1rem;">
      <h3>Selecciona tu grupo (${lista.length} encontrados):</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:8px;">
        ${lista.map(g => `
          <a class="activity-card" style="display:block;padding:12px;text-decoration:none;border:1px solid #ddd;border-radius:12px"
             href="?id=${encodeURIComponent(g.id)}${hideNotes ? '&notas=0' : ''}">
            <div style="font-weight:700;margin-bottom:4px;">${(g.nombreGrupo || '—')}</div>
            <div>Programa: ${(g.programa || '—')}</div>
            <div>N° Negocio: ${(g.numeroNegocio ?? g.id)}</div>
            <div>Fechas: ${(g.fechaInicio || '—')} — ${(g.fechaFin || '—')}</div>
          </a>
        `).join('')}
      </div>
    </div>
  `;
}

/* ──────────────────────────────────────────────────────────────────────────
   Helpers de formato
────────────────────────────────────────────────────────────────────────── */
function formatDateRange(ini, fin) {
  if (!ini || !fin) return '—';
  try {
    const [iy, im, id] = ini.split('-').map(Number);
    const [fy, fm, fd] = fin.split('-').map(Number);
    const di = new Date(iy, im - 1, id);
    const df = new Date(fy, fm - 1, fd);
    const fmt = d => d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${fmt(di)} — ${fmt(df)}`;
  } catch { return '—'; }
}

function formatDateReadable(isoStr) {
  const [yyyy, mm, dd] = isoStr.split('-').map(Number);
  const d = new Date(yyyy, mm - 1, dd);
  const wd = d.toLocaleDateString('es-CL', { weekday: 'long' });
  const name = wd.charAt(0).toUpperCase() + wd.slice(1);
  const ddp = String(dd).padStart(2, '0');
  const mmp = String(mm).padStart(2, '0');
  return `${name} ${ddp}/${mmp}`;
}

function getDateRange(startStr, endStr) {
  const out = [];
  if (!startStr || !endStr) return out;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Texto de impresión (formato solicitado)
────────────────────────────────────────────────────────────────────────── */
function buildPrintText(grupo, fechasOrdenadas) {
  let out = '';

  fechasOrdenadas.forEach((fecha, idx) => {
    // Título del día
    out += `Día ${idx + 1} – ${formatDateReadable(fecha)}\n`;

    // Actividades ordenadas
    const arr = (grupo.itinerario?.[fecha] || []).slice()
      .sort((a, b) => (a?.horaInicio || '99:99').localeCompare(b?.horaInicio || '99:99'));

    if (!arr.length) {
      out += '— Sin actividades —\n\n';
      return;
    }

    arr.forEach(act => {
      const hi = act.horaInicio || '--:--';
      const hf = act.horaFin ? ` – ${act.horaFin}` : '';
      const name = (act.actividad || '').toString().toUpperCase();

      const a = parseInt(act.adultos, 10) || 0;
      const e = parseInt(act.estudiantes, 10) || 0;
      const pax = (a + e) || act.pasajeros || 0;

      out += `${hi}${hf}  ${name} 👥 ${pax} pax (A:${a} E:${e})\n\n`;
    });

    out += '\n';
  });

  return out.trimEnd();
}

/* ──────────────────────────────────────────────────────────────────────────
   Render principal
────────────────────────────────────────────────────────────────────────── */
async function main() {
  const { numeroNegocio, id } = getParamsFromURL();

  const titleEl   = document.getElementById('grupo-title');
  const nombreEl  = document.getElementById('grupo-nombre');
  const numEl     = document.getElementById('grupo-numero');
  const destinoEl = document.getElementById('grupo-destino');
  const fechasEl  = document.getElementById('grupo-fechas');
  const resumenPax= document.getElementById('resumen-pax');
  const cont      = document.getElementById('itinerario-container');
  const printEl   = document.getElementById('print-block');

  // Flags + botones
  const hideNotes = new URLSearchParams(location.search).get('notas') === '0';
  const btnPrint  = document.getElementById('btnPrint');
  const btnShare  = document.getElementById('btnShare');

  btnPrint?.addEventListener('click', () => window.print());

  if (!numeroNegocio && !id) {
    cont.innerHTML = `<p style="padding:1rem;">Falta <code>numeroNegocio</code> o <code>id</code> en la URL.</p>`;
    return;
  }

  // 1) Preferir id (único)
  let g = await fetchGrupoById(id);

  // 2) Buscar por número si no había id o no se encontró
  if (!g) {
    const lista = await buscarGruposPorNumero(numeroNegocio);

    if (lista.length === 0) {
      cont.innerHTML = `<p style="padding:1rem;">No se encontró el grupo ${numeroNegocio}.</p>`;
      return;
    }
    if (lista.length > 1) {
      renderSelector(lista, cont);

      // Enlace para compartir manteniendo el número original
      const shareUrl = `${location.origin}${location.pathname}?numeroNegocio=${encodeURIComponent(numeroNegocio)}${hideNotes ? '&notas=0' : ''}`;
      btnShare?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(shareUrl);
        alert('Enlace copiado');
      });
      return; // se corta aquí (el usuario elige)
    }
    g = lista[0];
  }

  // Enlace para compartir (preferir id)
  const idLink   = g?.id ? `?id=${encodeURIComponent(g.id)}` 
                         : `?numeroNegocio=${encodeURIComponent(numeroNegocio || '')}`;
  const shareUrl = `${location.origin}${location.pathname}${idLink}${hideNotes ? '&notas=0' : ''}`;
  btnShare?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      alert('Enlace copiado');
    } catch {
      const i = document.createElement('input');
      i.value = shareUrl;
      document.body.appendChild(i);
      i.select(); document.execCommand('copy'); i.remove();
      alert('Enlace copiado');
    }
  });

  // Cabecera del grupo
  titleEl.textContent   = ` ${(g.programa || '—').toUpperCase()}`;
  nombreEl.textContent  = g.nombreGrupo || '—';
  numEl.textContent     = g.numeroNegocio ?? g.id ?? '—';
  destinoEl.textContent = g.destino || '—';
  fechasEl.textContent  = formatDateRange(g.fechaInicio, g.fechaFin);

  const totalA = parseInt(g.adultos, 10) || 0;
  const totalE = parseInt(g.estudiantes, 10) || 0;
  resumenPax.textContent = `👥 Total pax: ${totalA + totalE} (A:${totalA} · E:${totalE})`;

  // Armar listado de fechas
  let fechas = [];
  if (g.itinerario && typeof g.itinerario === 'object') {
    fechas = Object.keys(g.itinerario).sort((a, b) => new Date(a) - new Date(b));
  } else if (g.fechaInicio && g.fechaFin) {
    fechas = getDateRange(g.fechaInicio, g.fechaFin);
  }

  if (!fechas.length) {
    cont.innerHTML = `<p style="padding:1rem;">No hay itinerario disponible.</p>`;
    if (printEl) printEl.textContent = '';
    return;
  }

  // Render visual (tarjetas)
  cont.innerHTML = '';
  fechas.forEach((fecha, idx) => {
    const sec = document.createElement('section');
    sec.className = 'dia-seccion';
    sec.dataset.fecha = fecha;

    sec.innerHTML = `
      <h3>Día ${idx + 1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
    `;

    const ul = sec.querySelector('.activity-list');
    const arr = (g.itinerario?.[fecha] || []).slice();

    // Orden por hora de inicio (los vacíos al final)
    arr.sort((a, b) => (a?.horaInicio || '99:99').localeCompare(b?.horaInicio || '99:99'));

    if (!arr.length) {
      ul.innerHTML = `<li class="empty">— Sin actividades —</li>`;
    } else {
      arr.forEach(act => {
        const paxCalc = (parseInt(act.adultos, 10) || 0) + (parseInt(act.estudiantes, 10) || 0);
        const li = document.createElement('li');
        li.className = 'activity-card';

        const notesHtml = (!hideNotes && act.notas)
          ? `<p style="opacity:.85;">📝 ${act.notas}</p>`
          : '';

        li.innerHTML = `
          // <h4>${act.horaInicio || '--:--'}${act.horaFin ? ' – ' + act.horaFin : ''}</h4>
          <p><strong>${(act.actividad || '').toString().toUpperCase()}</strong></p>
          // <p>👥 ${paxCalc || act.pasajeros || 0} pax${(act.adultos || act.estudiantes) ? ` (A:${act.adultos || 0} E:${act.estudiantes || 0})` : ''}</p>
          ${notesHtml}
        `;
        ul.appendChild(li);
      });
    }

    cont.appendChild(sec);
  });

  // Texto de impresión
  if (printEl) {
    printEl.textContent = buildPrintText(g, fechas);
  }
}

main().catch(err => {
  console.error('Firestore error:', err?.code || err?.message, err);
  document.getElementById('itinerario-container').innerHTML =
    `<p style="padding:1rem;color:#b00;">Error cargando el itinerario.</p>`;
  const printEl = document.getElementById('print-block');
  if (printEl) printEl.textContent = '';
});
