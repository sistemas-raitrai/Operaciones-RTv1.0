// revisionremoto.js — Auditoría trabajo remoto (sesiones + tareas + check-ins + fotos)
// ✅ Acceso por clave hardcodeada: 123456
// ✅ Filtra Hoy / Mes / Rango
// ✅ Muestra detalle expandible por sesión (tareas + check-ins + thumbnails)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection, doc, getDocs, query, where, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const auth = getAuth(app);

// ✅ clave por código (la cambias después)
const AUDIT_PASSWORD = '123456';

const state = {
  unlocked: false,
  user: null
};

function setText(id, txt){
  const el = $(id);
  if(el) el.textContent = txt;
}

function escapeHtml(str){
  return String(str || '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function fmtDT(ts){
  if(!ts?.toDate) return '—';
  const d = ts.toDate();
  return new Intl.DateTimeFormat('es-CL', { dateStyle:'short', timeStyle:'short' }).format(d);
}

function setDefaultDates(){
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');
  const today = `${yyyy}-${mm}-${dd}`;

  $('dateTo').value = today;

  // from = primer día del mes
  const first = `${yyyy}-${mm}-01`;
  $('dateFrom').value = first;
}

function rangeFromUI(){
  const mode = $('selRange').value;

  const now = new Date();
  if(mode === 'today'){
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
    const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59,999);
    return { start, end };
  }

  if(mode === 'month'){
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0,0);
    const end   = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59,999);
    return { start, end };
  }

  // custom
  const from = $('dateFrom').value;
  const to   = $('dateTo').value;
  const start = from ? new Date(from+'T00:00:00') : new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0,0);
  const end   = to   ? new Date(to+'T23:59:59')   : new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59,999);
  return { start, end };
}

/* =========================
   Password modal
========================= */
function openPwModal(){
  $('pwBackdrop').style.display = 'flex';
  $('pwInput').value = '';
  setText('pwMsg', '—');
  setTimeout(()=> $('pwInput')?.focus(), 50);
}
function closePwModal(){
  $('pwBackdrop').style.display = 'none';
}

function setUnlocked(v){
  state.unlocked = v;
  setText('pillUnlocked', v ? 'Desbloqueado' : 'Bloqueado');
}

/* =========================
   Auditoría: carga sesiones
========================= */
async function loadSessions(){
  if(!state.unlocked){
    setText('auditMsg', '⛔ Bloqueado. Ingresa clave.');
    return;
  }

  const tbody = $('sessionsTbody');
  tbody.innerHTML = `<tr><td colspan="5" class="muted">Cargando…</td></tr>`;

  const { start, end } = rangeFromUI();
  setText('auditMsg', `Cargando sesiones entre ${start.toLocaleDateString()} y ${end.toLocaleDateString()}…`);

  // Query por startedAt rango (puede pedir índice si tu proyecto tiene reglas raras; normalmente no)
  const q = query(
    collection(db, 'remote_sessions'),
    where('startedAt', '>=', start),
    where('startedAt', '<=', end),
    orderBy('startedAt', 'desc'),
    limit(200)
  );

  let snap;
  try{
    snap = await getDocs(q);
  }catch(err){
    console.warn('loadSessions index/fallback', err);
    // fallback sin where (menos exacto, pero no se cae)
    snap = await getDocs(query(collection(db, 'remote_sessions'), orderBy('startedAt','desc'), limit(200)));
  }

  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, ...d.data() }));

  setText('countSessions', String(docs.length));

  if(docs.length === 0){
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Sin sesiones en el periodo.</td></tr>`;
    setText('auditMsg', '✅ Sin sesiones.');
    return;
  }

  tbody.innerHTML = docs.map(s => {
    const active = s.active ? 'Activa' : 'Cerrada';
    const who = s.email || s.displayName || s.uid || '—';

    return `
      <tr>
        <td>${escapeHtml(fmtDT(s.startedAt))}</td>
        <td>${escapeHtml(fmtDT(s.endedAt))}</td>
        <td>${escapeHtml(who)}</td>
        <td>${escapeHtml(active)}</td>
        <td>
          <details data-sid="${s.id}">
            <summary>Ver tareas + check-ins</summary>
            <div class="grid2" style="margin-top:10px;">
              <div class="cardBox">
                <div style="font-weight:900;">Tareas</div>
                <div class="muted" id="tasks_${s.id}">Cargando…</div>
              </div>
              <div class="cardBox">
                <div style="font-weight:900;">Check-ins</div>
                <div class="muted" id="ch_${s.id}">Cargando…</div>
              </div>
            </div>
          </details>
        </td>
      </tr>
    `;
  }).join('');

  // Wire expanders
  tbody.querySelectorAll('details').forEach(det => {
    det.addEventListener('toggle', async () => {
      if(det.open){
        const sid = det.getAttribute('data-sid');
        await loadSessionDetail(sid);
      }
    });
  });

  setText('auditMsg', `✅ Sesiones cargadas: ${docs.length}`);
}

async function loadSessionDetail(sessionId){
  const tasksEl = $(`tasks_${sessionId}`);
  const chEl = $(`ch_${sessionId}`);

  if(tasksEl) tasksEl.textContent = 'Cargando tareas…';
  if(chEl) chEl.textContent = 'Cargando check-ins…';

  // Tasks
  try{
    const tSnap = await getDocs(query(
      collection(db, 'remote_sessions', sessionId, 'tasks'),
      orderBy('createdAt', 'desc'),
      limit(200)
    ));

    const rows = [];
    tSnap.forEach(d => {
      const x = d.data();
      const ev = x.evidenceLink ? `<a href="${x.evidenceLink}" target="_blank" rel="noopener">Evidencia</a>` : '—';
      rows.push(`
        <div style="border-bottom:1px solid #eee; padding:8px 0;">
          <div><b>${escapeHtml(x.title || '')}</b> <span class="muted">(${escapeHtml(x.period || '')})</span></div>
          <div class="muted">Estado: ${escapeHtml(x.status || '')} · Prioridad: ${escapeHtml(x.priority || '')}</div>
          <div class="muted">${escapeHtml(x.detail || '')}</div>
          <div class="muted">${ev}</div>
        </div>
      `);
    });

    if(tasksEl) tasksEl.innerHTML = rows.length ? rows.join('') : `<span class="muted">Sin tareas.</span>`;
  }catch(err){
    console.error('load tasks detail', err);
    if(tasksEl) tasksEl.textContent = '❌ Error cargando tareas (ver consola).';
  }

  // Check-ins
  try{
    const cSnap = await getDocs(query(
      collection(db, 'remote_sessions', sessionId, 'checkins'),
      orderBy('openedAt', 'desc'),
      limit(200)
    ));

    const rows = [];
    cSnap.forEach(d => {
      const x = d.data();
      const img = x.photoURL
        ? `<a href="${x.photoURL}" target="_blank" rel="noopener">
             <img class="thumb" src="${x.photoURL}" alt="foto check-in" />
           </a>`
        : `<span class="muted">—</span>`;

      rows.push(`
        <div style="border-bottom:1px solid #eee; padding:8px 0;">
          <div><b>${escapeHtml(fmtDT(x.openedAt))}</b></div>
          <div class="muted">Estado: ${escapeHtml(x.status || '')}</div>
          <div style="margin-top:6px;">${img}</div>
        </div>
      `);
    });

    if(chEl) chEl.innerHTML = rows.length ? rows.join('') : `<span class="muted">Sin check-ins.</span>`;
  }catch(err){
    console.error('load checkins detail', err);
    if(chEl) chEl.textContent = '❌ Error cargando check-ins (ver consola).';
  }
}

/* =========================
   Boot
========================= */
function wireUI(){
  setDefaultDates();

  $('selRange')?.addEventListener('change', () => {
    const mode = $('selRange').value;
    const show = (mode === 'custom');
    $('dateFrom').style.display = show ? 'inline-block' : 'none';
    $('dateTo').style.display = show ? 'inline-block' : 'none';
  });

  // default: month => ocultar date inputs (solo se usan si custom)
  $('dateFrom').style.display = 'none';
  $('dateTo').style.display = 'none';

  $('btnLoad')?.addEventListener('click', loadSessions);

  $('btnPwOk')?.addEventListener('click', () => {
    const v = ($('pwInput').value || '').trim();
    if(v === AUDIT_PASSWORD){
      setUnlocked(true);
      closePwModal();
      setText('auditMsg', '✅ Desbloqueado. Presiona "Cargar".');
      $('sessionsTbody').innerHTML = `<tr><td colspan="5" class="muted">Listo. Presiona "Cargar".</td></tr>`;
    }else{
      setText('pwMsg', '❌ Clave incorrecta.');
    }
  });

  $('btnPwCancel')?.addEventListener('click', () => {
    closePwModal();
    setText('auditMsg', '⛔ Auditoría bloqueada.');
  });

  // Enter en password
  $('pwInput')?.addEventListener('keydown', (e) => {
    if(e.key === 'Enter') $('btnPwOk')?.click();
  });
}

function initAuth(){
  onAuthStateChanged(auth, (u) => {
    state.user = u || null;
    setText('pillUser', `Usuario: ${u?.email || '—'}`);
    // Siempre pide clave al entrar
    setUnlocked(false);
    openPwModal();
  });
}

wireUI();
initAuth();
