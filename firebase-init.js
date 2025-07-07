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

// 4️⃣ Observador de sesión: si no hay user, redirige al login
onAuthStateChanged(auth, user => {
  if (!user) {
    console.warn("⛔ Usuario no autenticado, redirigiendo a login…");
    // Si estamos en una página distinta de login, volvemos al login
    if (!location.pathname.endsWith("login.html")) {
      location.href = "login.html";
    }
  } else {
    console.log("✅ Usuario autenticado:", user.email);
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
