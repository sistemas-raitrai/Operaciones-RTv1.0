// estadisticas.js
// Totales PAX esperados vs declarados + filtros (coordinador, grupo, destino, programa, año, fechaInicio)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== STATE ====================== */
const state = {
  user: null,
  all: [],      // grupos normalizados (cache)
  view: [],     // filtrados
  catalogs: {
    coords: new Set(),
    destinos: new Set(),
    programas: new Set(),
    anos: new Set(),
    grupos: new Set(),
  },
  filtros: {
    q: '',
    coord: '',
    grupo: '',
    destino: '',
    programa: '',
    ano: '',
    inicioDesde: '',
    inicioHasta: '',
  }
};

/* ====================== UTILS ====================== */
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

function toDateFromAny(v) {
  if (!v) return null;
  // Firestore Timestamp
  if (typeof v === 'object' && typeof v.toDate === 'function') {
    try { return v.toDate(); } catch (_) { return null; }
  }
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  return null;
}

function yyyyMmDd(d) {
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${yy}-${mm}-${dd}`;
}

function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function norm(s='') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .trim();
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type:'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ====================== NORMALIZADOR DE GRUPO ====================== */
function normalizeGrupo(docId, x = {}) {
  const gid = docId;

  const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
  const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);

  const coordEmail = coalesce(
    x.coordinadorEmail, x.coordinador?.email, x.coordinador,
    x.coord, x.responsable, x.owner, ''
  ).toLowerCase();

  const destino = coalesce(x.destino, x.lugar, '');
  const programa = coalesce(x.programa, x.plan, '');

  // PAX esperados
  const paxEsperados = safeNum(
    x.cantidadGrupo ??
    x.paxTotal ??
    x.pax ??
    x.pax_total ??
    0
  );

  // PAX declarados (al iniciar viaje)
  const paxDeclarados =
    (x?.paxViajando && typeof x.paxViajando.total === 'number')
      ? safeNum(x.paxViajando.total)
      : (
          (x?.paxViajando && (typeof x.paxViajando.A === 'number' || typeof x.paxViajando.E === 'number'))
            ? safeNum(x.paxViajando.A || 0) + safeNum(x.paxViajando.E || 0)
            : null
        );

  // Fecha inicio (para año / rangos)
  const fIni = toDateFromAny(x.fechaInicio ?? x.fechaInicioViaje ?? null);
  const fIniISO = fIni ? yyyyMmDd(fIni) : '';
  const ano = fIni ? String(fIni.getFullYear()) : '';

  return {
    gid,
    numero,
    nombre,
    coordEmail,
    destino,
    programa,

    paxEsperados,
    paxDeclarados, // null si no existe

    fechaInicioISO: fIniISO,
    ano,

    // precomputed para búsqueda rápida
    _q: norm([gid, numero, nombre, coordEmail, destino, programa].join(' ')),
  };
}

/* ====================== CARGA + CATALOGOS ====================== */
async function loadAllGrupos() {
  const status = document.getElementById('status');
  if (status) status.textContent = 'Cargando grupos…';

  state.all = [];
  state.catalogs.coords.clear();
  state.catalogs.destinos.clear();
  state.catalogs.programas.clear();
  state.catalogs.anos.clear();
  state.catalogs.grupos.clear();

  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d => {
    const x = d.data() || {};
    const g = normalizeGrupo(d.id, x);
    state.all.push(g);

    if (g.coordEmail) state.catalogs.coords.add(g.coordEmail);
    if (g.destino) state.catalogs.destinos.add(g.destino);
    if (g.programa) state.catalogs.programas.add(g.programa);
    if (g.ano) state.catalogs.anos.add(g.ano);
    state.catalogs.grupos.add(g.gid);
  });

  // sort estable para UI
  state.all.sort((a,b) => String(a.numero).localeCompare(String(b.numero)));

  rebuildCatalogUI();

  if (status) status.textContent = `Listo. ${state.all.length} grupos cargados.`;
}

/* ====================== UI: CATALOGOS ====================== */
function rebuildCatalogUI() {
  // datalist coords / grupos
  const dlCoords = document.getElementById('dlCoords');
  const dlGrupos = document.getElementById('dlGrupos');
  if (dlCoords) dlCoords.innerHTML = '';
  if (dlGrupos) dlGrupos.innerHTML = '';

  if (dlCoords) {
    [...state.catalogs.coords].sort().forEach(email => {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlCoords.appendChild(opt);
    });
  }

  if (dlGrupos) {
    state.all.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.gid;
      opt.label = `${g.numero} — ${g.nombre}`;
      dlGrupos.appendChild(opt);
    });
  }

  // selects destino / programa / año
  const selDestino = document.getElementById('fDestino');
  const selPrograma = document.getElementById('fPrograma');
  const selAno = document.getElementById('fAno');

  const fillSelect = (sel, values) => {
    if (!sel) return;
    const cur = sel.value || '';
    sel.innerHTML = '<option value="">(Todos)</option>';
    [...values].sort().forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    sel.value = cur; // intenta conservar selección
  };

  fillSelect(selDestino, state.catalogs.destinos);
  fillSelect(selPrograma, state.catalogs.programas);

  // año orden desc
  if (selAno) {
    const cur = selAno.value || '';
    selAno.innerHTML = '<option value="">(Todos)</option>';
    [...state.catalogs.anos].sort((a,b)=> Number(b)-Number(a)).forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      selAno.appendChild(o);
    });
    selAno.value = cur;
  }
}

/* ====================== FILTROS ====================== */
function readFiltrosFromUI() {
  state.filtros.q = (document.getElementById('q')?.value || '').trim();
  state.filtros.coord = (document.getElementById('fCoord')?.value || '').trim().toLowerCase();
  state.filtros.grupo = (document.getElementById('fGrupo')?.value || '').trim();
  state.filtros.destino = (document.getElementById('fDestino')?.value || '').trim();
  state.filtros.programa = (document.getElementById('fPrograma')?.value || '').trim();
  state.filtros.ano = (document.getElementById('fAno')?.value || '').trim();
  state.filtros.inicioDesde = (document.getElementById('fInicioDesde')?.value || '').trim();
  state.filtros.inicioHasta = (document.getElementById('fInicioHasta')?.value || '').trim();
}

function applyFiltros() {
  readFiltrosFromUI();

  const fq = norm(state.filtros.q);
  const fCoord = state.filtros.coord;
  const fGrupo = state.filtros.grupo;
  const fDestino = state.filtros.destino;
  const fPrograma = state.filtros.programa;
  const fAno = state.filtros.ano;
  const fDesde = state.filtros.inicioDesde; // YYYY-MM-DD
  const fHasta = state.filtros.inicioHasta;

  state.view = state.all.filter(g => {
    if (fq && !g._q.includes(fq)) return false;
    if (fCoord && g.coordEmail !== fCoord) return false;
    if (fGrupo && g.gid !== fGrupo) return false;
    if (fDestino && g.destino !== fDestino) return false;
    if (fPrograma && g.programa !== fPrograma) return false;
    if (fAno && g.ano !== fAno) return false;

    // rango fechaInicio
    if (fDesde) {
      if (!g.fechaInicioISO) return false;
      if (g.fechaInicioISO < fDesde) return false;
    }
    if (fHasta) {
      if (!g.fechaInicioISO) return false;
      if (g.fechaInicioISO > fHasta) return false;
    }

    return true;
  });

  render();
}

/* ====================== RENDER ====================== */
function renderKPIs(rows) {
  const kGrupos = document.getElementById('kGrupos');
  const kGruposSub = document.getElementById('kGruposSub');
  const kEsperados = document.getElementById('kEsperados');
  const kDeclarados = document.getElementById('kDeclarados');
  const kDelta = document.getElementById('kDelta');

  const nGrupos = rows.length;

  let totalEsperados = 0;
  let totalDeclarados = 0;
  let conDeclarados = 0;

  for (const g of rows) {
    totalEsperados += safeNum(g.paxEsperados);
    if (typeof g.paxDeclarados === 'number') {
      totalDeclarados += safeNum(g.paxDeclarados);
      conDeclarados++;
    }
  }

  const delta = totalDeclarados - totalEsperados;

  if (kGrupos) kGrupos.textContent = String(nGrupos);
  if (kGruposSub) kGruposSub.textContent = `${conDeclarados} con PAX declarados`;
  if (kEsperados) kEsperados.textContent = String(totalEsperados);
  if (kDeclarados) kDeclarados.textContent = String(totalDeclarados);
  if (kDelta) kDelta.textContent = String(delta);
}

function renderTabla(rows) {
  const tbody = document.querySelector('#tbl tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.innerHTML = `<div class="muted">Sin resultados.</div>`;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  // ordenar por delta desc (para ver los “problemas” arriba)
  const sorted = rows.slice().sort((a,b) => {
    const da = (typeof a.paxDeclarados === 'number') ? (a.paxDeclarados - a.paxEsperados) : -999999;
    const db = (typeof b.paxDeclarados === 'number') ? (b.paxDeclarados - b.paxEsperados) : -999999;
    return db - da;
  });

  const frag = document.createDocumentFragment();

  for (const g of sorted) {
    const tr = document.createElement('tr');

    const declaradosTxt = (typeof g.paxDeclarados === 'number') ? String(g.paxDeclarados) : '—';
    const deltaVal = (typeof g.paxDeclarados === 'number') ? (g.paxDeclarados - g.paxEsperados) : null;

    const tdGrupo = document.createElement('td');
    tdGrupo.innerHTML = `<div><strong>${g.numero} — ${g.nombre}</strong></div><div class="muted mono">${g.gid}</div>`;

    const tdCoord = document.createElement('td');
    tdCoord.textContent = g.coordEmail || '—';

    const tdDest = document.createElement('td');
    tdDest.textContent = g.destino || '—';

    const tdProg = document.createElement('td');
    tdProg.textContent = g.programa || '—';

    const tdExp = document.createElement('td');
    tdExp.className = 'right mono';
    tdExp.textContent = String(g.paxEsperados || 0);

    const tdDec = document.createElement('td');
    tdDec.className = 'right mono';
    tdDec.textContent = declaradosTxt;

    const tdDelta = document.createElement('td');
    tdDelta.className = 'right mono';
    tdDelta.innerHTML = deltaVal == null
      ? `<span class="pill muted">—</span>`
      : `<span class="pill">${deltaVal >= 0 ? '+' : ''}${deltaVal}</span>`;

    const tdIni = document.createElement('td');
    tdIni.textContent = g.fechaInicioISO || '—';

    tr.append(tdGrupo, tdCoord, tdDest, tdProg, tdExp, tdDec, tdDelta, tdIni);
    frag.appendChild(tr);
  }

  tbody.appendChild(frag);
}

function render() {
  const rows = state.view.length ? state.view : state.all;
  renderKPIs(rows);
  renderTabla(rows);

  const status = document.getElementById('status');
  if (status) status.textContent = `Mostrando ${rows.length} de ${state.all.length} grupos.`;
}

/* ====================== EXPORT CSV ====================== */
function exportCSV() {
  const rows = state.view.length ? state.view : state.all;

  const head = [
    'gid','numeroNegocio','nombreGrupo','coordinadorEmail','destino','programa',
    'paxEsperados','paxDeclarados','delta','fechaInicio'
  ];

  const lines = [];
  lines.push(head.map(csvEscape).join(','));

  for (const g of rows) {
    const delta = (typeof g.paxDeclarados === 'number') ? (g.paxDeclarados - g.paxEsperados) : '';
    const row = [
      g.gid, g.numero, g.nombre, g.coordEmail, g.destino, g.programa,
      g.paxEsperados, (g.paxDeclarados ?? ''), delta, g.fechaInicioISO
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  const fname = `estadisticas_pax_${new Date().toISOString().slice(0,10)}.csv`;
  downloadText(fname, lines.join('\n'));
}

/* ====================== WIRE UI ====================== */
function wireUI() {
  // header actions
  document.getElementById('btnHome')?.addEventListener('click', () => {
    // Ajusta si tu home es distinto
    location.href = 'index.html';
  });
  document.getElementById('btnReload')?.addEventListener('click', () => location.reload());
  document.getElementById('btnBack')?.addEventListener('click', () => history.back());

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await signOut(auth);
    location.href = 'login.html';
  });

  document.getElementById('btnAplicar')?.addEventListener('click', applyFiltros);

  // aplicar con Enter en buscador
  document.getElementById('q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFiltros();
  });

  // cambios de selects -> aplica al tiro (rico para UX)
  ['fDestino','fPrograma','fAno'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyFiltros);
  });

  // cambios en inputs (coord/grupo/date) -> aplica al tiro cuando salen del campo
  ['fCoord','fGrupo','fInicioDesde','fInicioHasta'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyFiltros);
  });

  document.getElementById('btnLimpiar')?.addEventListener('click', () => {
    // reset UI
    const ids = ['q','fCoord','fGrupo','fInicioDesde','fInicioHasta'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const selIds = ['fDestino','fPrograma','fAno'];
    selIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // reset state
    state.view = [];
    state.filtros = {
      q:'', coord:'', grupo:'', destino:'', programa:'', ano:'', inicioDesde:'', inicioHasta:''
    };

    render();
  });

  document.getElementById('btnExportCSV')?.addEventListener('click', exportCSV);
}

/* ====================== ARRANQUE ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;

  const who = document.getElementById('whoami');
  if (who) who.textContent = user.email || '';

  wireUI();
  await loadAllGrupos();

  // primera pinta
  state.view = [];
  render();
});
