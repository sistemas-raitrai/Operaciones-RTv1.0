// ✅ script.js: Acciones globales compartidas en todas las páginas (excepto login)

import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";

const auth = getAuth(app);

// 🟢 Mostrar usuario conectado
onAuthStateChanged(auth, user => {
  const userDiv = document.getElementById("usuario-conectado");
  if (userDiv) userDiv.textContent = user ? user.email : "";
});

// 🕒 Mostrar hora actual en <div id="reloj">
function actualizarReloj() {
  const ahora = new Date();
  const hora = ahora.toLocaleTimeString("es-CL", { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fecha = ahora.toLocaleDateString("es-CL", {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const reloj = document.getElementById("reloj");
  if (reloj) reloj.textContent = `${hora} | ${fecha}`;
  else console.warn("⚠️ No se encontró el div #reloj");
}
setInterval(actualizarReloj, 1000);
actualizarReloj();

// 🏠 Home dinámico (soporta Vercel y GitHub Pages)
const btnHome = document.getElementById("btn-home");
if (btnHome) {
  btnHome.addEventListener("click", function (e) {
    e.preventDefault();
    if (location.hostname.includes("github.io")) {
      window.location.href = "https://sistemas-raitrai.github.io/Operaciones-RTv1.0/";
    } else {
      window.location.href = "/";
    }
  });
}

// ⏏️ Función global para cerrar sesión
window.logout = async function () {
  try {
    await signOut(auth);
    window.location.href = "login.html";
  } catch (error) {
    alert("Error al cerrar sesión: " + error.message);
  }
};
