// remoto.js — Jornada + Tareas + Check-ins (OK por defecto) + Pausa configurable
// ✅ Iniciar jornada => consentimiento + foto inicial OBLIGATORIA (si no, no inicia)
// ✅ Check-in aleatorio (30–60 min) => DENEGAR opcional, si no responde => captura automática
// ✅ Pausa 15/20/30/45/60 => al reanudar se toma foto automáticamente (sí o sí)
// ✅ Usuario NO ve historial; solo auditoría en revisionremoto.html

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

const CHECKIN_COUNTDOWN_SEC = 20; // ✅ auto-OK en 20s (puedes cambiar a 60 si quieres)

const state = {
  user: null,

  sessionId: null,
  sessionActive: false,
  paused: false,

  nextTimer: null,
  resumeTimer: null,

  countdownTimer: null,
  countdownLeft: CHECKIN_COUNTDOWN_SEC,

  currentCheckinId: null,
  currentCheckinType: null,   // 'initial_start' | 'random' | 'resume_mandatory'
  currentCheckinMode: null,   // 'mandatory' | 'default' | 'manual'

  stream: null,
  stream2: null,

  tabTitleBase: document.title
};

/* =========================
   Helpers UI
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

  if(state.resumeTimer) clearTimeout(state.resumeTimer);
  state.resumeTimer = null;

  if(state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

function randomMs(minMin, maxMin){
  return Math.floor((minMin + Math.random() * (maxMin - minMin)) * 60 * 1000);
}

function beep(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.06;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ o.stop(); ctx.close(); }, 180);
  }catch{}
}

async function notifySystem(title, body){
  // ✅ Notificación del sistema (si el usuario la habilita)
  try{
    if(!('Notification' in window)) return false;
    if(Notification.permission === 'granted'){
      new Notification(title, { body });
      return true;
    }
    // No pedimos permiso de golpe acá; lo hacemos al aceptar consentimiento (opcional)
    return false;
  }catch{
    return false;
  }
}

function blinkTabTitle(on){
  if(!on){
    document.title = state.tabTitleBase;
    return;
  }
  let flip = false;
  const id = setInterval(() => {
    if(!state.sessionActive){ clearInterval(id); document.title = state.tabTitleBase; return; }
    flip = !flip;
    document.title = flip ? '⚠️ CHECK-IN (auto OK)' : state.tabTitleBase;
  }, 700);
  setTimeout(()=>{ clearInterval(id); document.title = state.tabTitleBase; }, 8000);
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
   Cámara
========================= */
async function ensureCamera1(){
  // Consentimiento / foto inicial
  if(state.stream) return state.stream;

  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
    audio: false
  });

  const v = $('video');
  if(v){
    v.srcObject = state.stream;
    await v.play().catch(()=>{});
  }
  return state.stream;
}

async function ensureCamera2(){
  // Check-in modal
  if(state.stream2) return state.stream2;

  state.stream2 = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
    audio: false
  });

  const v = $('video2');
  if(v){
    v.srcObject = state.stream2;
    await v.play().catch(()=>{});
  }
  return state.stream2;
}

async function captureBlobFrom(videoId, canvasId){
  const video = $(videoId);
  const canvas = $(canvasId);
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

/* =========================
   Modales
========================= */
function show(id){ $(id).style.display = 'flex'; }
function hide(id){ $(id).style.display = 'none'; }

function resetCheckinCountdown(){
  state.countdownLeft = CHECKIN_COUNTDOWN_SEC;
  setText('countdown', String(state.countdownLeft));
  setText('countdown2', String(state.countdownLeft));
}

function startCountdown(onAuto){
  resetCheckinCountdown();

  state.countdownTimer = setInterval(async () => {
    state.countdownLeft -= 1;
    setText('countdown', String(state.countdownLeft));
    setText('countdown2', String(state.countdownLeft));

    if(state.countdownLeft <= 0){
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      await onAuto();
    }
  }, 1000);
}

/* =========================
   Check-ins (registro + subida)
========================= */
async function createCheckinDoc({ type, mode }){
  // type: 'initial_start' | 'random' | 'resume_mandatory'
  // mode: 'mandatory' | 'default' | 'manual'
  const openedAt = new Date();

  const ref = await addDoc(checkinsCol(), {
    type,
    mode,
    openedAt: Timestamp.fromDate(openedAt),
    status: 'pending',
    respondedAt: null,
    photoPath: null,
    photoURL: null,
    createdAt: serverTimestamp()
  });

  state.currentCheckinId = ref.id;
  state.currentCheckinType = type;
  state.currentCheckinMode = mode;
}

async function markCheckin(status, extra = {}){
  if(!state.currentCheckinId) return;
  await updateDoc(doc(db, 'remote_sessions', state.sessionId, 'checkins', state.currentCheckinId), {
    status,
    respondedAt: serverTimestamp(),
    ...extra
  });
}

async function uploadPhotoForCurrentCheckin(blob){
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');
  const hh = String(now.getHours()).padStart(2,'0');
  const mi = String(now.getMinutes()).padStart(2,'0');
  const ss = String(now.getSeconds()).padStart(2,'0');

  const path = `remote_checkins/${state.user.uid}/${yyyy}/${mm}/${dd}/${state.sessionId}_${state.currentCheckinId}_${hh}${mi}${ss}.jpg`;
  const ref = sRef(storage, path);

  await uploadBytes(ref, blob, { contentType:'image/jpeg' });
  const url = await getDownloadURL(ref);

  return { path, url };
}

/* =========================
   Scheduler
========================= */
function scheduleNextRandomCheckin(){
  if(!state.sessionActive || state.paused) return;
  const delay = randomMs(30, 60);
  state.nextTimer = setTimeout(openRandomCheckin, delay);
}

/* =========================
   Inicio jornada (consentimiento + foto obligatoria)
========================= */
async function openConsent(){
  if(!state.user){
    setText('sessionStatus', 'Estado: Debes iniciar sesión.');
    return;
  }
  setText('consentMsg', '—');
  show('consentBackdrop');

  // intenta preparar cámara para que el usuario vea preview
  try{
    await ensureCamera1();
  }catch(err){
    console.warn('consent camera error', err);
    setText('consentMsg', '⚠️ No se pudo abrir cámara aún. Al aceptar se volverá a intentar.');
  }
}

async function consentReject(){
  hide('consentBackdrop');
  setText('sessionStatus', 'Estado: Jornada no iniciada (no aceptó).');
}

async function consentAcceptAndStart(){
  $('btnConsentAccept').disabled = true;
  $('btnConsentReject').disabled = true;
  setText('consentMsg', 'Iniciando… solicitando permisos');

  try{
    // (Opcional) pedir notificaciones en este momento, sin obligar
    try{
      if('Notification' in window && Notification.permission === 'default'){
        await Notification.requestPermission();
      }
    }catch{}

    // 1) crea sesión "starting"
    const sref = await addDoc(collection(db, 'remote_sessions'), {
      uid: state.user.uid,
      email: state.user.email || '',
      displayName: state.user.displayName || '',
      startedAt: serverTimestamp(),
      endedAt: null,
      active: false,
      paused: false,
      consentAcceptedAt: serverTimestamp(),
      consentVersion: 'v1_initial+optout',
      createdAt: serverTimestamp()
    });

    state.sessionId = sref.id;
    setText('pillSession', `Sesión: ${state.sessionId}`);

    // 2) asegura cámara y captura obligatoria
    await ensureCamera1();
    setText('consentMsg', 'Capturando foto inicial…');

    await createCheckinDoc({ type: 'initial_start', mode: 'mandatory' });

    const blob = await captureBlobFrom('video', 'canvas');
    const { path, url } = await uploadPhotoForCurrentCheckin(blob);

    await markCheckin('approved_mandatory', { photoPath: path, photoURL: url });

    // 3) ahora sí, activa sesión
    await updateDoc(sessionRef(), {
      active: true,
      paused: false,
      updatedAt: serverTimestamp()
    });

    state.sessionActive = true;
    state.paused = false;

    $('btnStart').disabled = true;
    $('btnPause').disabled = false;
    $('btnEnd').disabled = false;

    setText('sessionStatus', 'Estado: ✅ Jornada activa (foto inicial OK)');
    hide('consentBackdrop');

    // carga tareas vacías
    await loadTasks();

    // programa primer check-in aleatorio
    scheduleNextRandomCheckin();
  }catch(err){
    console.error('consentAcceptAndStart error', err);
    setText('consentMsg', '❌ No se pudo iniciar (cámara o permisos). La jornada NO se inicia.');
    // si ya se creó sessionId, la dejamos como no activa (auditable)
    try{
      if(state.sessionId){
        await updateDoc(sessionRef(), {
          active: false,
          endedAt: serverTimestamp(),
          endedReason: 'start_failed',
          updatedAt: serverTimestamp()
        });
      }
    }catch{}
    state.sessionActive = false;
    state.paused = false;
    state.sessionId = null;
    setText('pillSession', 'Sesión: —');
  }finally{
    $('btnConsentAccept').disabled = false;
    $('btnConsentReject').disabled = false;
  }
}

/* =========================
   Check-in aleatorio (OK por defecto)
========================= */
async function openRandomCheckin(){
  if(!state.sessionActive || state.paused) return;

  // crea doc y abre modal
  try{
    await createCheckinDoc({ type: 'random', mode: 'default' });
  }catch(err){
    console.error('create random checkin error', err);
    scheduleNextRandomCheckin();
    return;
  }

  // alerta fuerte
  beep();
  blinkTabTitle(true);
  await notifySystem('Check-in requerido', `Se tomará foto automáticamente en ${CHECKIN_COUNTDOWN_SEC}s. Puedes denegar.`);

  setText('checkinMsg', '—');
  show('checkinBackdrop');

  // prepara cámara para el modal
  try{
    await ensureCamera2();
    setText('checkinMsg', `Se tomará foto automáticamente en ${CHECKIN_COUNTDOWN_SEC}s (si no deniegas).`);
  }catch(err){
    console.error('ensureCamera2 error', err);
    setText('checkinMsg', '⚠️ No se pudo abrir cámara. Se intentará igual al final.');
  }

  startCountdown(async () => {
    // auto OK por defecto
    await autoCaptureDefaultOk();
  });
}

async function autoCaptureDefaultOk(){
  $('btnOkNow').disabled = true;
  $('btnDeny').disabled = true;

  try{
    // intenta abrir cámara si no estaba
    if(!state.stream2){
      await ensureCamera2();
    }

    setText('checkinMsg', 'Capturando automáticamente…');
    const blob = await captureBlobFrom('video2', 'canvas2');
    const { path, url } = await uploadPhotoForCurrentCheckin(blob);

    await markCheckin('approved_default', { photoPath: path, photoURL: url });
    setText('checkinMsg', '✅ Check-in registrado.');
  }catch(err){
    console.error('autoCaptureDefaultOk error', err);
    await markCheckin('camera_error');
    setText('checkinMsg', '❌ Error de cámara. Registrado como camera_error.');
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    hide('checkinBackdrop');
    $('btnOkNow').disabled = false;
    $('btnDeny').disabled = false;

    scheduleNextRandomCheckin();
  }
}

async function takeNowManual(){
  if(!state.sessionActive || state.paused) return;

  $('btnOkNow').disabled = true;
  $('btnDeny').disabled = true;

  try{
    // cambia mode a manual (para auditoría)
    await updateDoc(doc(db, 'remote_sessions', state.sessionId, 'checkins', state.currentCheckinId), {
      mode: 'manual',
      updatedAt: serverTimestamp()
    });

    if(!state.stream2) await ensureCamera2();

    setText('checkinMsg', 'Capturando…');
    const blob = await captureBlobFrom('video2', 'canvas2');
    const { path, url } = await uploadPhotoForCurrentCheckin(blob);

    await markCheckin('approved_manual', { photoPath: path, photoURL: url });
    setText('checkinMsg', '✅ Check-in registrado.');
  }catch(err){
    console.error('takeNowManual error', err);
    await markCheckin('camera_error');
    setText('checkinMsg', '❌ Error de cámara. Registrado como camera_error.');
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    hide('checkinBackdrop');
    $('btnOkNow').disabled = false;
    $('btnDeny').disabled = false;

    scheduleNextRandomCheckin();
  }
}

async function denyThisTime(){
  $('btnOkNow').disabled = true;
  $('btnDeny').disabled = true;

  try{
    await markCheckin('denied');
    setText('checkinMsg', '⛔ Denegado.');
  }catch(err){
    console.error('denyThisTime error', err);
  }finally{
    if(state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    hide('checkinBackdrop');
    $('btnOkNow').disabled = false;
    $('btnDeny').disabled = false;

    scheduleNextRandomCheckin();
  }
}

/* =========================
   Pausa configurable + reanudación con foto obligatoria
========================= */
function openPauseModal(){
  if(!state.sessionActive) return;
  setText('pauseMsg', '—');
  show('pauseBackdrop');
}

function closePauseModal(){
  hide('pauseBackdrop');
}

async function confirmPause(){
  const mins = parseInt($('pauseMinutes').value, 10) || 30;
  const ms = mins * 60 * 1000;

  try{
    state.paused = true;
    clearTimers();

    await updateDoc(sessionRef(), {
      paused: true,
      pauseUntil: Timestamp.fromDate(new Date(Date.now() + ms)),
      updatedAt: serverTimestamp()
    });

    setText('sessionStatus', `Estado: ⏸️ Pausado (${mins} min)`);
    $('btnPause').textContent = 'Pausado…';
    $('btnPause').disabled = true;

    closePauseModal();

    state.resumeTimer = setTimeout(async () => {
      await resumeFromPauseMandatoryPhoto();
    }, ms);

  }catch(err){
    console.error('confirmPause error', err);
    setText('pauseMsg', '❌ Error pausando (ver consola).');
  }
}

async function resumeFromPauseMandatoryPhoto(){
  // Reanuda y toma foto sí o sí
  try{
    state.paused = false;

    await updateDoc(sessionRef(), {
      paused: false,
      pauseUntil: null,
      updatedAt: serverTimestamp()
    });

    $('btnPause').textContent = 'Pausar';
    $('btnPause').disabled = false;
    setText('sessionStatus', 'Estado: ✅ Reanudando… (foto obligatoria)');

    // crea checkin "resume"
    await createCheckinDoc({ type: 'resume_mandatory', mode: 'mandatory' });

    // alerta para que no sea “sorpresa”, pero igual obligatoria
    beep();
    blinkTabTitle(true);
    await notifySystem('Reanudación', 'Se tomará foto obligatoria al reanudar la jornada.');

    // Intento con cámara 2 (la del modal)
    try{ await ensureCamera2(); }catch{}

    // Captura sin pedir ok
    const blob = await captureBlobFrom('video2', 'canvas2');
    const { path, url } = await uploadPhotoForCurrentCheckin(blob);
    await markCheckin('approved_mandatory', { photoPath: path, photoURL: url });

    setText('sessionStatus', 'Estado: ✅ Jornada activa (reentrada OK)');

  }catch(err){
    console.error('resumeFromPauseMandatoryPhoto error', err);
    try{ await markCheckin('camera_error'); }catch{}
    setText('sessionStatus', 'Estado: ✅ Jornada activa (⚠️ error cámara en reentrada)');
  }finally{
    scheduleNextRandomCheckin();
  }
}

/* =========================
   Terminar jornada
========================= */
async function endSession(){
  if(!state.sessionActive) return;

  clearTimers();
  hide('checkinBackdrop');
  hide('pauseBackdrop');
  hide('consentBackdrop');

  try{
    await updateDoc(sessionRef(), {
      endedAt: serverTimestamp(),
      active: false,
      paused: false,
      updatedAt: serverTimestamp()
    });
  }catch(err){
    console.error('endSession update error', err);
  }

  state.sessionActive = false;
  state.paused = false;

  $('btnStart').disabled = false;
  $('btnPause').disabled = true;
  $('btnEnd').disabled = true;

  setText('sessionStatus', 'Estado: 🛑 Jornada terminada');
  setText('pillSession', 'Sesión: —');
  state.sessionId = null;
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
   UI wiring + Auth
========================= */
function wireUI(){
  $('btnStart')?.addEventListener('click', openConsent);
  $('btnEnd')?.addEventListener('click', endSession);

  $('btnPause')?.addEventListener('click', openPauseModal);
  $('btnPauseCancel')?.addEventListener('click', closePauseModal);
  $('btnPauseConfirm')?.addEventListener('click', confirmPause);

  $('btnConsentReject')?.addEventListener('click', consentReject);
  $('btnConsentAccept')?.addEventListener('click', consentAcceptAndStart);

  $('btnAddTask')?.addEventListener('click', addTask);
  $('filterPeriod')?.addEventListener('change', loadTasks);

  $('btnOkNow')?.addEventListener('click', takeNowManual);
  $('btnDeny')?.addEventListener('click', denyThisTime);

  // bloquear cerrar click fuera (para que no “escape”)
  ['consentBackdrop','checkinBackdrop','pauseBackdrop'].forEach(id => {
    $(id)?.addEventListener('click', (e) => {
      if(e.target?.id === id){
        // no-op
      }
    });
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

    // reset estado UI
    state.sessionActive = false;
    state.paused = false;
    state.sessionId = null;

    $('btnStart').disabled = false;
    $('btnPause').disabled = true;
    $('btnEnd').disabled = true;

    setText('pillSession', 'Sesión: —');
  });
}

wireUI();
initAuth();
