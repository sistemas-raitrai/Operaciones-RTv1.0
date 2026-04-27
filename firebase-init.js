// firebase-init.js — Sistema principal (Operaciones RT)

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// --- Firebase config (mismo proyecto)
const firebaseConfig = {
  apiKey: "AIzaSyAdx9nVcV-UiGER3mcz-w9BcSSIZd-t5nE",
  authDomain: "sist-op-rt.firebaseapp.com",
  projectId: "sist-op-rt",
  storageBucket: "sist-op-rt.firebasestorage.app",
  messagingSenderId: "438607695630",
  appId: "1:438607695630:web:f5a16f319e3ea17fbfd15f"
};

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true
});

// 👉 URL del portal (GitHub Pages o dominio propio)
const PORTAL_URL = "https://sistemas-raitrai.github.io/portal-coordinadores-rt/";

// 👉 Lista blanca de correos que SÍ pueden usar el sistema principal
const STAFF_EMAILS = new Set([
  "aleoperaciones@raitrai.cl",
  "tomas@raitrai.cl",
  "operaciones@raitrai.cl",
  "anamaria@raitrai.cl",
  "sistemas@raitrai.cl",
  "yenny@raitrai.cl",
  "patricia@raitrai.cl",
  "administracion@raitrai.cl",
  "administracion@hotelbordeandino.cl",
  "secretaria@raitrai.cl",
  "contacto@raitrai.cl",
  "giras@raitrai.cl",
].map(e => e.toLowerCase()));

// Páginas públicas del sistema principal
const PUBLIC = new Set(["login.html"]);

// --- Guardia global
onAuthStateChanged(auth, async (user) => {
  const current = (location.pathname.split("/").pop() || "index.html").toLowerCase();

  // No logueado → solo páginas públicas
  if (!user) {
    if (!PUBLIC.has(current)) location.href = "login.html";
    return;
  }

  const email = (user.email || "").toLowerCase();
  const isStaff = STAFF_EMAILS.has(email);

  if (!isStaff) {
    // Usuario autenticado que NO es staff → enviar al portal
    // replace() para que no vuelva con "atrás"
    location.replace(PORTAL_URL);
    return;
  }

  // (Opcional) Si un staff está en login.html, llévalo al home
  if (current === "login.html") location.href = "index.html";
});

// Helpers de login/logout
window.login = async (email, password) => {
  await signInWithEmailAndPassword(auth, email, password);
};
window.logout = async () => {
  await signOut(auth);
};
