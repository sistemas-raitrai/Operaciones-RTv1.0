// remoto.js — Trabajo Remoto (tareas + check-ins con OK 1 minuto)
// ✅ Random check-in: 30–60 min
// ✅ Modal visible con countdown (60s)
// ✅ Si no aprueba => denied_timeout
// ✅ Si aprueba => captura 1 foto + sube a Storage + log Firestore
// ✅ Usa encabezado común (script.js ya se carga en HTML)

import { app, db } from './firebase-init.js';

import {
  getAuth,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  getStorage,
  ref as sRef,
  uploadBytes,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  getDocs,
  getDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const $ = (id) => document.getElementById(id);

const auth = getAuth(app);
const storage = getStorage(app);

const state = {
  user: null,

  // sesión remota
  sessionId: null,
  sessionActive: false,
  paused: false,

  // timers
  nextTimer: null,
  countdownTimer: null,

  // modal check-in
  currentCheckinId: null,
  currentCheckinRef: null,
  countdownLeft: 60,

  // media
  stream: null
};

/* =========================
   Helpers UI
========================= */
function setText(id, txt){
  const el = $(id);
  if(el) el.textContent = txt;
}

function fmtTime(d){
  try{
    return new Intl.DateTimeFormat('es-CL', { hour:'2-digit', minute:'2-digit' }).format(d);
  }catch{
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }
}

function todayRange(){
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59,999);
  return { start, end };
}

function randomBetween(min, max){
  return min + Math.random() * (max - min);
}

function randomMs(minMin, maxMin){
  return Math.floor(randomBetween(minMin, maxMin) * 60 * 1000);
}

function clearTimers(){
  if(state.nextTimer) clearTimeout(state.nextTimer);
  state.nextTimer = null;

  if(state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

/* =========================
   Firestore paths
========================= */
/**
 * Estructura:
 * remote_sessions/{sessionId}
 * remote_sessions/{sessionId}/tasks/{taskId}
 * remote_sessions/{sessionId}/checkins/{checkinId}
 *
 * (Así todo queda “por jornada”; simple de auditar)
 */
function sessionRef(){
  return doc(db, 'remote_sessions', state.sessionId);
}
function tasksCol(){
  return collection(db, 'remote_sessions', state.sessionId, 'tasks');
}
function checkinsCol(){
  return collection(db, 'remote_sessions', state.sessionId, 'checkins');
}

/* =========================
   Media / Cámara
========================= */
async function ensureCamera(){
  // ✅ pide stream solo cuando sea necesario (o al iniciar jornada)
  if(state.stream) return state.stream;

  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
    audio: false
  });

  const video = $('video');
  if(video){
    video.srcObject = state.stream;
    await video.play().catch(()=>{});
  }

  return state.stream;
}

async function capturePhotoBlob(){
  const video = $('video');
  const canvas = $('canvas');
  if(!video || !canvas) throw new Error('video/canvas no disponible');

  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  // ✅ JPEG comprimido (reduce peso en Storage)
  const blob = await new Promise((resolve) => {
    canvas.toBlob((b)=> resolve(b), 'image/jpeg', 0.72);
  });

  if(!blob) throw new Error('No se pudo generar blob');
  return blob;
}

/* =========================
   Sesión: start/pause/end
========================= */
async function startSession(){
  if(!state.user) return;

  // Crea doc sesión
  const ref = await addDoc(collection(db, 'remote_sessions'), {
    uid: state.user.uid,
    email: state.user.email || '',
    displayName: state.user.displayName || '',
    startedAt: serverTimestamp(),
    endedAt: null,
    active: true,
    paused: false
  });

  state.sessionId = ref.id;
  state.sessionActive = true;
  state.paused = false;

  setText('pillSession', `Sesión: ${state.sessionId}`);
  setText('sessionStatus', 'Estado: ✅ Jornada activa');

  $('btnStart').disabled = true;
  $('btnPause').disabled = false;
  $('btnEnd').disabled = false;

  // (Opcional) pide cámara al inicio para evitar sorpresas después
  try{
    setText('sessionStatus', 'Estado: ✅ Jornada activa · Preparando cámara…');
    await ensureCamera();
    setText('sessionStatus', 'Estado: ✅ Jornada activa · Cámara OK');
  }catch(err){
    console.warn('ensureCamera error', err);
    setText('sessionStatus', 'Estado: ✅ Jornada activa · ⚠️ Cámara no disponible (se pedirá en el check-in)');
  }

  // Carga tablas
  await loadTasks();
  await loadTodayCheckins();

  // Agenda primer check-in
  scheduleNextCheckin();
}

async function pauseSession(){
  if(!state.sessionActive) return;
  state.paused = !state.paused;

  await updateDoc(sessionRef(), {
    paused: state.paused,
    updatedAt: serverTimestamp()
  });

  if(state.paused){
    clearTimers();
    setText('sessionStatus', 'Estado: ⏸️ Pausado');
    $('btnPause').textContent = 'Reanudar';
    setText('pillNext', 'Próximo check-in: — (pausado)');
  }else{
    setText('sessionStatus', 'Estado: ✅ Jornada activa');
    $('btnPause').textContent = 'Pausar';
    scheduleNextCheckin();
  }
}

async function endSession(){
  if(!state.sessionActive) return;

  clearTimers();
  hideCheckinModal();

  await updateDoc(sessionRef(), {
    endedAt: serverTimestamp(),
    active: false,
    paused: false
  });

  state.sessionActive = false;
  state.paused = false;

  $('btnStart').disabled = false;
  $('btnPause').disabled = true;
  $('btnEnd').disabled = true;

  setText('sessionStatus', 'Estado: 🛑 Jornada terminada');
  setText('pillNext', 'Próximo check-in: —');

  // (Opcional) apaga stream
  stopCameraStream();
}

function stopCameraStream(){
  if(state.stream){
    try{
      state.stream.getTracks().forEach(t => t.stop());
    }catch{}
  }
  state.stream = null;

  const video = $('video');
  if(video) video.srcObject = null;
}

/* =========================
   Check-in Scheduler
========================= */
function scheduleNextCheckin(){
  if(!state.sessionActive || state.paused) return;

  const delay = randomMs(30, 60);
  const nextAt = new Date(Date.now() + delay);
  setText('pillNext', `Próximo check-in: ${fmtTime(nextAt)}`);

  state.nextTimer = setTimeout(() => {
    openCheckin();
  }, delay);
}

/* =========================
   Check-in Modal + lógica 60s
========================= */
function showCheckinModal(){
  $('checkinBackdrop').style.display = 'flex';
}
function hideCheckinModal(){
  $('checkinBackdrop').style.display = 'none';
  setText('modalMsg', '—');
  setText('countdown', '60');
  state.countdownLeft = 60;
}

async function createPendingCheckin(){
  const openedAt = new Date();
  const expiresAt = new Date(openedAt.getTime() + 60*1000);

  const ref = await addDoc(checkinsCol(), {
    scheduledAt: serverTimestamp(),
    openedAt: Timestamp.fromDate(openedAt),
    expiresAt: Timestamp.fromDate(expiresAt),
    status: 'pending',
    respondedAt: null,
    photoPath: null,
    photoURL: null,
    createdAt: serverTimestamp()
  });

  state.currentCheckinId = ref.id;
  state.currentCheckinRef = ref;

  return { openedAt, expiresAt };
}

function startCountdown(onTimeout){
  state.countdownLeft = 60;
  setText('countdown', String(state.countdownLeft));

  state.countdownTimer = setInterval(async () => {
    state.countdownLeft -= 1;
    setText('countdown', String(state.countdownLeft));

    if(state.countdownLeft <= 0){
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      await onTimeout();
    }
  }, 1000);
}

async function openCheckin(){
  if(!state.sessionActive || state.paused) return;

  // ✅ crea check-in pendiente
  await createPendingCheckin();

  // ✅ abre modal y prepara cámara
  showCheckinModal();
  setText('modalMsg', 'Solicitando cámara…');

  try{
    await ensureCamera();
    setText('modalMsg', 'Cámara lista. Presiona OK para capturar.');
  }catch(err){
    console.error('ensureCamera error', err);
    setText('modalMsg', '❌ No se pudo acceder a la cámara. Puedes Denegar o Cerrar.');
    // Igual dejamos countdown para registrar timeout si el usuario no actúa
  }

  // ✅ countdown 60s
  startCountdown(async () => {
    await markDenied('denied_timeout');
    hideCheckinModal();
    await loadTodayCheckins();
    scheduleNextCheckin();
  });
}

async function markDenied(type){
  if(!state.currentCheckinRef) return;
  await updateDoc(doc(db, 'remote_sessions', state.sessionId, 'checkins', state.currentCheckinId), {
    status: type, // 'denied' o 'denied_timeout'
    respondedAt: serverTimestamp()
  });
}

async function markApprovedWithPhoto(photoPath, photoURL){
  await updateDoc(doc(db, 'remote_sessions', state.sessionId, 'checkins', state.currentCheckinId), {
    status: 'approved',
    respondedAt: serverTimestamp(),
    photoPath,
    photoURL
  });
}

async function handleOkShot(){
  if(!state.currentCheckinId) return;
  $('btnOkShot').disabled = true;
  $('btnDenyShot').disabled = true;

  try{
    setText('modalMsg', 'Capturando…');
    const blob = await capturePhotoBlob();

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const dd = String(now.getDate()).padStart(2,'0');
    const hh = String(now.getHours()).padStart(2,'0');
    const mi = String(now.getMinutes()).padStart(2,'0');
    const ss = String(now.getSeconds()).padStart(2,'0');

    const path = `remote_checkins/${state.user.uid}/${yyyy}/${mm}/${dd}/${state.sessionId}_${state.currentCheckinId}_${hh}${mi}${ss}.jpg`;
    const ref = sRef(storage, path);

    setText('modalMsg', 'Subiendo foto…');
    await uploadBytes(ref, blob, { contentType:'image/jpeg' });
    const url = await getDownloadURL(ref);

    await markApprovedWithPhoto(path, url);

    setText('modalMsg', '✅ Check-in aprobado y guardado.');
  }catch(err){
    console.error('handleOkShot error', err);
    setText('modalMsg', '❌ Error capturando/subiendo. Se registrará como camera_error.');
    await updateDoc(doc(db, 'remote_sessions', state.sessionId, 'checkins', state.currentCheckinId), {
      status: 'camera_error',
      respondedAt: serverTimestamp()
    });
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    $('btnOkShot').disabled = false;
    $('btnDenyShot').disabled = false;

    hideCheckinModal();
    await loadTodayCheckins();
    scheduleNextCheckin();
  }
}

async function handleDenyShot(){
  if(!state.currentCheckinId) return;

  $('btnOkShot').disabled = true;
  $('btnDenyShot').disabled = true;

  try{
    await markDenied('denied');
    setText('modalMsg', '⛔ Denegado.');
  }catch(err){
    console.error('deny error', err);
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    $('btnOkShot').disabled = false;
    $('btnDenyShot').disabled = false;

    hideCheckinModal();
    await loadTodayCheckins();
    scheduleNextCheckin();
  }
}

/* =========================
   Tareas
========================= */
async function addTask(){
  const period = $('taskPeriod').value;
  const priority = $('taskPriority').value;
  const status = $('taskStatus').value;
  const title = ($('taskTitle').value || '').trim();
  const detail = ($('taskDetail').value || '').trim();
  const evidence = ($('taskEvidence').value || '').trim();

  if(!state.sessionActive){
    setText('taskMsg', '⚠️ Debes iniciar jornada para registrar tareas en esta sesión.');
    return;
  }
  if(!title){
    setText('taskMsg', '⚠️ Falta el título.');
    return;
  }

  setText('taskMsg', 'Guardando…');

  await addDoc(tasksCol(), {
    period,
    priority,
    status,
    title,
    detail,
    evidenceLink: evidence || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  $('taskTitle').value = '';
  $('taskDetail').value = '';
  $('taskEvidence').value = '';
  setText('taskMsg', '✅ Tarea agregada.');

  await loadTasks();
}

async function loadTasks(){
  const tbody = $('tasksTbody');
  if(!tbody) return;

  if(!state.sessionActive){
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Inicia jornada para ver/crear tareas de esta sesión.</td></tr>`;
    return;
  }

  const filter = $('filterPeriod')?.value || 'all';

  const q = query(tasksCol(), orderBy('createdAt', 'desc'), limit(200));
  const snap = await getDocs(q);

  let rows = [];
  snap.forEach(docu => {
    const d = docu.data();
    if(filter !== 'all' && d.period !== filter) return;

    const evidence = d.evidenceLink
      ? `<a href="${d.evidenceLink}" target="_blank" rel="noopener">Abrir</a>`
      : `<span class="muted">—</span>`;

    rows.push(`
      <tr>
        <td>${d.period || '—'}</td>
        <td>
          <div><b>${escapeHtml(d.title || '')}</b></div>
          <div class="muted">${escapeHtml(d.detail || '')}</div>
        </td>
        <td>${escapeHtml(d.status || '')}</td>
        <td>${escapeHtml(d.priority || '')}</td>
        <td>${evidence}</td>
        <td>
          <button class="btn" data-act="cycle" data-id="${docu.id}">Cambiar estado</button>
        </td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="6" class="muted">No hay tareas.</td></tr>`;

  // acciones
  tbody.querySelectorAll('button[data-act="cycle"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      await cycleTaskStatus(id);
    });
  });
}

function nextStatus(s){
  const order = ['pendiente', 'en_progreso', 'bloqueada', 'lista'];
  const i = order.indexOf(s);
  return order[(i + 1 + order.length) % order.length];
}

async function cycleTaskStatus(taskId){
  const ref = doc(db, 'remote_sessions', state.sessionId, 'tasks', taskId);
  const snap = await getDoc(ref);
  if(!snap.exists()) return;

  const cur = snap.data().status || 'pendiente';
  const nxt = nextStatus(cur);

  await updateDoc(ref, {
    status: nxt,
    updatedAt: serverTimestamp()
  });

  await loadTasks();
}

/* =========================
   Check-ins list (hoy)
========================= */
async function loadTodayCheckins(){
  const tbody = $('checkinsTbody');
  if(!tbody) return;

  if(!state.sessionActive){
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Inicia jornada para registrar check-ins.</td></tr>`;
    return;
  }

  const { start, end } = todayRange();

  // Filtra por openedAt hoy (si no existe, igual caerá por createdAt)
  const q = query(
    checkinsCol(),
    where('openedAt', '>=', Timestamp.fromDate(start)),
    where('openedAt', '<=', Timestamp.fromDate(end)),
    orderBy('openedAt', 'desc'),
    limit(120)
  );

  let snap;
  try{
    snap = await getDocs(q);
  }catch(err){
    // Si Firestore te reclama índice por openedAt, lo evitamos y cargamos por desc sin where
    console.warn('loadTodayCheckins: fallback sin where (posible índice)', err);
    snap = await getDocs(query(checkinsCol(), orderBy('createdAt','desc'), limit(120)));
  }

  const rows = [];
  snap.forEach(docu => {
    const d = docu.data();
    const openedAt = d.openedAt?.toDate ? d.openedAt.toDate() : null;

    const hora = openedAt ? fmtTime(openedAt) : '—';
    const status = d.status || '—';
    const foto = d.photoURL
      ? `<a href="${d.photoURL}" target="_blank" rel="noopener">Ver</a>`
      : `<span class="muted">—</span>`;

    const detail = d.expiresAt?.toDate
      ? `Expira: ${fmtTime(d.expiresAt.toDate())}`
      : '';

    rows.push(`
      <tr>
        <td>${hora}</td>
        <td>${escapeHtml(status)}</td>
        <td>${foto}</td>
        <td class="muted">${escapeHtml(detail)}</td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="4" class="muted">No hay check-ins hoy.</td></tr>`;
}

/* =========================
   Seguridad básica XSS
========================= */
function escapeHtml(str){
  return String(str || '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

/* =========================
   Boot
========================= */
function wireUI(){
  $('btnStart')?.addEventListener('click', startSession);
  $('btnPause')?.addEventListener('click', pauseSession);
  $('btnEnd')?.addEventListener('click', endSession);

  $('btnAddTask')?.addEventListener('click', addTask);
  $('filterPeriod')?.addEventListener('change', loadTasks);

  $('btnReloadCheckins')?.addEventListener('click', loadTodayCheckins);

  $('btnOkShot')?.addEventListener('click', handleOkShot);
  $('btnDenyShot')?.addEventListener('click', handleDenyShot);

  $('btnCloseModal')?.addEventListener('click', async () => {
    // Cerrar no marca deny; si se cierra y expira => timeout (queda trazado)
    hideCheckinModal();
  });

  // Evita click fuera
  $('checkinBackdrop')?.addEventListener('click', (e) => {
    if(e.target?.id === 'checkinBackdrop'){
      // no cerrar al click fuera; forzamos acción consciente
    }
  });
}

function setUserPills(u){
  setText('pillUser', `Usuario: ${u.email || '—'}`);
}

function initAuth(){
  onAuthStateChanged(auth, async (u) => {
    if(!u){
      state.user = null;
      setText('pillUser', 'Usuario: —');
      setText('sessionStatus', 'Estado: Debes iniciar sesión.');
      return;
    }

    state.user = u;
    setUserPills(u);
    setText('sessionStatus', 'Estado: Listo. Inicia jornada para comenzar.');
  });
}

wireUI();
initAuth();
