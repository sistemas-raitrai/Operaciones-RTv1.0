// firebase-init.js
// Inicialización de Firebase (Auth + Firestore) para todas las páginas

// 1️⃣ Importa los SDKs desde la CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// 2️⃣ Tu configuración de Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAdx9nVcV-UiGER3mcz-w9BcSSIZd-t5nE",
  authDomain: "sist-op-rt.firebaseapp.com",
  projectId: "sist-op-rt",
  storageBucket: "sist-op-rt.firebasestorage.app",
  messagingSenderId: "438607695630",
  appId: "1:438607695630:web:f5a16f319e3ea17fbfd15f"
};

// 3️⃣ Inicializa Firebase App, Auth y Firestore
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// 👇 URL del portal (GitHub Pages o tu subdominio)
const PORTAL_URL = "https://sistemas-raitrai.github.io/portal-coordinadores-rt/";

// 4️⃣ Observador de sesión + guardia por rol/página
onAuthStateChanged(auth, async (user) => {
  const current = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // Páginas públicas (no chequean sesión)
  const PUBLIC = new Set(['login.html']);
  if (!user) {
    if (!PUBLIC.has(current)) location.href = 'login.html';
    return;
  }

  //  ✅ Obtener rol desde custom claims
  const token = await user.getIdTokenResult(true);
  const role  = token.claims.role || 'usuario'; // fallback para cuentas antiguas

  //  ✅ Allowed roles por PÁGINA (automático):
  //     Por defecto TODA página es sólo del sistema principal
  //     (admin/supervisor/usuario) y NO permite coordinador,
  //     a menos que la página lo indique en <body data-roles="...">
  const rolesFromDom = (document.body?.dataset?.roles || 'admin,supervisor,usuario')
    .split(',').map(s => s.trim().toLowerCase());

  if (!rolesFromDom.includes(role)) {
    if (role === 'coordinador') {
      // 👇 usa replace para que no pueda volver con “atrás”
      location.replace(PORTAL_URL);
    } else {
      location.href = 'login.html';
    }
  }
});

// 5️⃣ Función para iniciar sesión (usada en login.html)
window.login = async function (email, password) {
  await signInWithEmailAndPassword(auth, email, password);
  // Tras el login, el onAuthStateChanged redirigirá automáticamente
};

// 6️⃣ Función para cerrar sesión (puedes llamarla desde script.js o un botón)
window.logout = async function () {
  await signOut(auth);
  // onAuthStateChanged también se encargará de la redirección al login
};

// 7️⃣ Exporta los objetos para usarlos en tus otros módulos
export { app, auth, db };
