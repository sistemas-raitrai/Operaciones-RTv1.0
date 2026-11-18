// firebase-init.js — Operaciones RT · corrección de acceso a firmas v17.1
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdx9nVcV-UiGER3mcz-w9BcSSIZd-t5nE",
  authDomain: "sist-op-rt.firebaseapp.com",
  projectId: "sist-op-rt",
  storageBucket: "sist-op-rt.firebasestorage.app",
  messagingSenderId: "438607695630",
  appId: "1:438607695630:web:f5a16f319e3ea17fbfd15f"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true
});

const PORTAL_URL = "https://sistemas-raitrai.github.io/portal-coordinadores-rt/";
const CUENTA_FIRMA = "coordinador@raitrai.cl";
const CONTROL_URL = new URL("./control-coordinadores.html", import.meta.url).href;

// La cuenta de firma NO se agrega al staff.
const STAFF_EMAILS = new Set([
  "aleoperaciones@raitrai.cl",
  "tomas@raitrai.cl",
  "operaciones@raitrai.cl",
  "victoria@raitrai.cl",
  "anamaria@raitrai.cl",
  "sistemas@raitrai.cl",
  "yenny@raitrai.cl",
  "patricia@raitrai.cl",
  "administracion@raitrai.cl",
  "administracion@hotelbordeandino.cl",
  "secretaria@raitrai.cl",
  "contacto@raitrai.cl",
  "giras@raitrai.cl"
].map(e => e.toLowerCase()));

export function isOperationsStaff(user) {
  return STAFF_EMAILS.has(String(user?.email || "").trim().toLowerCase());
}

const PUBLIC = new Set(["login.html"]);

// Solo se reconoce el formato del enlace. El backend valida documento,
// autenticación, token, vencimiento y si ya está firmado.
function esEnlaceFirma(current) {
  if (current !== "control-coordinadores.html") return false;
  return /^#(?:firmar-contrato=[a-f0-9]{48}|firmar-manual=[a-f0-9]{48}|firmar-guia=[a-f0-9]{32,64})$/.test(location.hash);
}

onAuthStateChanged(auth, (user) => {
  const current = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const esControl = current === "control-coordinadores.html";

  // Contrato y anexos tienen su propio login en la página. Conservar la URL
  // completa, incluido el hash: no enviarlos a login.html, index o al portal.
  if (esEnlaceFirma(current)) return;

  // Control de Coordinadores también tiene un login propio para administración.
  if (!user) {
    if (esControl || PUBLIC.has(current)) return;
    location.href = "login.html";
    return;
  }

  const email = String(user.email || "").trim().toLowerCase();

  // Esta cuenta solo utiliza la pantalla de firma. Sin enlace, control-coordinadores.js
  // muestra el mensaje para abrir el enlace recibido y permite cerrar sesión.
  if (email === CUENTA_FIRMA) {
    if (!esControl) location.replace(CONTROL_URL);
    return;
  }

  // Los demás coordinadores conservan su acceso habitual al portal.
  if (!isOperationsStaff(user)) {
    location.replace(PORTAL_URL);
    return;
  }

  // El staff conserva el comportamiento habitual fuera de los enlaces de firma.
  if (current === "login.html") location.href = "index.html";
});

window.login = async (email, password) => {
  await signInWithEmailAndPassword(auth, email, password);
};
window.logout = async () => {
  await signOut(auth);
};
