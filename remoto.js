// remoto.js — Usuario remoto (jornada + tareas + modal check-in)
// ✅ NO muestra historial de check-ins ni fotos
// ✅ NO muestra "próximo check-in"
// ✅ Check-in aleatorio 30–60 min, y autorización interna de 60s

import { app, db } from './firebase-init.js';

import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

import {
  collection, doc, addDoc, updateDoc, getDocs, getDoc,
  query, orderBy, limit, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const auth = getAuth(app);
const storage = getStorage(app);

const state = {
  user: null,
  sessionId: null,
  sessionActive: false,
  paused: false,
  nextTimer: null,
  countdownTimer: null,
  countdownLeft: 60,
  currentCheckinId: null,
  stream: null
};

/* =========================
   UI helpers
========================= */
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

function clearTimers(){
  if(state.nextTimer) clearTimeout(state.nextTimer);
  state.nextTimer = null;

  if(state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

/* =========================
   Firestore paths
========================= */
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
   Cámara / captura
========================= */
async function ensureCamera(){
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

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b)=> resolve(b), 'image/jpeg', 0.72);
  });
  if(!blob) throw new Error('No se pudo generar blob');
  return blob;
}

function showCheckinModal(){
  $('checkinBackdrop').style.display = 'flex';
}
function hideCheckinModal(){
  $('checkinBackdrop').style.display = 'none';
  setText('modalMsg', '—');
  setText('countdown', '60');
  state.countdownLeft = 60;
}

/* =========================
   Scheduler 30–60 min (sin mostrar al usuario)
========================= */
function randomMs(minMin, maxMin){
  return Math.floor((minMin + Math.random() * (maxMin - minMin)) * 60 * 1000);
}

function scheduleNextCheckin(){
  if(!state.sessionActive || state.paused) return;
  const delay = randomMs(30, 60);
  state.nextTimer = setTimeout(openCheckin, delay);
}

/* =========================
   Check-in: crear / countdown / OK / DENY
========================= */
async function createPendingCheckin(){
  const openedAt = new Date();
  const expiresAt = new Date(openedAt.getTime() + 60*1000);

  const ref = await addDoc(checkinsCol(), {
    openedAt: Timestamp.fromDate(openedAt),
    expiresAt: Timestamp.fromDate(expiresAt),
    status: 'pending',
    respondedAt: null,
    photoPath: null,
    photoURL: null,
    createdAt: serverTimestamp()
  });

  state.currentCheckinId = ref.id;
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

async function markStatus(status, extra = {}){
  if(!state.currentCheckinId) return;
  await updateDoc(doc(db, 'remote_sessions', state.sessionId, 'checkins', state.currentCheckinId), {
    status,
    respondedAt: serverTimestamp(),
    ...extra
  });
}

async function openCheckin(){
  if(!state.sessionActive || state.paused) return;

  await createPendingCheckin();

  showCheckinModal();
  setText('modalMsg', 'Solicitando cámara…');

  try{
    await ensureCamera();
    setText('modalMsg', 'Cámara lista. Presiona OK para capturar.');
  }catch(err){
    console.error('ensureCamera error', err);
    setText('modalMsg', '❌ No se pudo acceder a la cámara. Puedes Denegar o esperar (timeout).');
  }

  startCountdown(async () => {
    await markStatus('denied_timeout');
    hideCheckinModal();
    scheduleNextCheckin();
  });
}

async function handleOkShot(){
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

    await markStatus('approved', { photoPath: path, photoURL: url });
    setText('modalMsg', '✅ Check-in registrado.');
  }catch(err){
    console.error('handleOkShot error', err);
    await markStatus('camera_error');
    setText('modalMsg', '❌ Error capturando/subiendo. Quedó registrado como camera_error.');
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    $('btnOkShot').disabled = false;
    $('btnDenyShot').disabled = false;

    hideCheckinModal();
    scheduleNextCheckin();
  }
}

async function handleDenyShot(){
  $('btnOkShot').disabled = true;
  $('btnDenyShot').disabled = true;

  try{
    await markStatus('denied');
    setText('modalMsg', '⛔ Denegado.');
  }catch(err){
    console.error('deny error', err);
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    $('btnOkShot').disabled = false;
    $('btnDenyShot').disabled = false;

    hideCheckinModal();
    scheduleNextCheckin();
  }
}

/* =========================
   Sesión: start/pause/end
========================= */
async function startSession(){
  if(!state.user) return;

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

  // (opcional) preparar cámara para que luego no falle
  try{
    await ensureCamera();
    setText('sessionStatus', 'Estado: ✅ Jornada activa · Cámara OK');
  }catch{
    setText('sessionStatus', 'Estado: ✅ Jornada activa · Cámara se pedirá en el check-in');
  }

  await loadTasks();
  scheduleNextCheckin();
}

async function pauseSession(){
  if(!state.sessionActive) return;

  state.paused = !state.paused;
  await updateDoc(sessionRef(), { paused: state.paused, updatedAt: serverTimestamp() });

  if(state.paused){
    clearTimers();
    setText('sessionStatus', 'Estado: ⏸️ Pausado');
    $('btnPause').textContent = 'Reanudar';
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
    setText('taskMsg', '⚠️ Debes iniciar jornada para registrar tareas.');
    return;
  }
  if(!title){
    setText('taskMsg', '⚠️ Falta el título.');
    return;
  }

  setText('taskMsg', 'Guardando…');

  await addDoc(tasksCol(), {
    period, priority, status,
    title, detail,
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

  await updateDoc(ref, { status: nxt, updatedAt: serverTimestamp() });
  await loadTasks();
}

async function loadTasks(){
  const tbody = $('tasksTbody');
  if(!tbody) return;

  if(!state.sessionActive){
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Inicia jornada para ver/crear tareas.</td></tr>`;
    return;
  }

  const filter = $('filterPeriod')?.value || 'all';
  const q = query(tasksCol(), orderBy('createdAt', 'desc'), limit(200));
  const snap = await getDocs(q);

  const rows = [];
  snap.forEach(docu => {
    const d = docu.data();
    if(filter !== 'all' && d.period !== filter) return;

    const evidence = d.evidenceLink
      ? `<a href="${d.evidenceLink}" target="_blank" rel="noopener">Abrir</a>`
      : `<span class="muted">—</span>`;

    rows.push(`
      <tr>
        <td>${escapeHtml(d.period || '—')}</td>
        <td>
          <div><b>${escapeHtml(d.title || '')}</b></div>
          <div class="muted">${escapeHtml(d.detail || '')}</div>
        </td>
        <td>${escapeHtml(d.status || '')}</td>
        <td>${escapeHtml(d.priority || '')}</td>
        <td>${evidence}</td>
        <td><button class="btn" data-act="cycle" data-id="${docu.id}">Cambiar estado</button></td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="6" class="muted">No hay tareas.</td></tr>`;

  tbody.querySelectorAll('button[data-act="cycle"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      await cycleTaskStatus(id);
    });
  });
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

  $('btnOkShot')?.addEventListener('click', handleOkShot);
  $('btnDenyShot')?.addEventListener('click', handleDenyShot);

  // no cerrar clic fuera
  $('checkinBackdrop')?.addEventListener('click', (e) => {
    if(e.target?.id === 'checkinBackdrop'){
      // no-op
    }
  });
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
    setText('pillUser', `Usuario: ${u.email || '—'}`);
    setText('sessionStatus', 'Estado: Listo. Inicia jornada.');
  });
}

wireUI();
initAuth();
