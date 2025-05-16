// ✅ Inicialización de Firebase Authentication para el sitio web
// Este archivo debe ser incluido en TODAS las páginas HTML que requieran autenticación

// 🔗 Importa el SDK de Firebase desde la CDN (debe ir en el HTML, no aquí)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";

// ✅ Configuración del proyecto Firebase (la que te entregó Firebase)
const firebaseConfig = {
  apiKey: "AIzaSyAdx9nVcV-UiGER3mcz-w9BcSSIzd-t5nE",
  authDomain: "sist-op-rt.firebaseapp.com",
  projectId: "sist-op-rt",
  storageBucket: "sist-op-rt.appspot.com",
  messagingSenderId: "438607695630",
  appId: "1:438607695630:web:f5a16f319e3ea17fbfd15f"
};

// ✅ Inicializa Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ✅ Observador de sesión (se ejecuta cada vez que cambia el estado de autenticación)
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("✅ Usuario autenticado:", user.email);
    // Puedes guardar datos del usuario en localStorage o mostrar contenido protegido
  } else {
    console.warn("⛔ Usuario no autenticado");
    // Opcional: redirigir a login.html o mostrar mensaje
  }
});

// ✅ Función para iniciar sesión
window.login = async function (email, password) {
  try {
    await signInWithEmailAndPassword(auth, email, password);
    alert("Inicio de sesión exitoso");
    window.location.href = "registro.html"; // o cualquier otra página
  } catch (error) {
    alert("❌ Error al iniciar sesión: " + error.message);
  }
};

// ✅ Función para cerrar sesión
window.logout = async function () {
  try {
    await signOut(auth);
    alert("Sesión cerrada");
    window.location.href = "index.html"; // o login.html
  } catch (error) {
    alert("❌ Error al cerrar sesión: " + error.message);
  }
};

// ✅ Exportar app para ser reutilizado en otras páginas
export { app };
