// ✅ script.js: Acciones globales compartidas en todas las páginas (excepto login)

import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";

const auth = getAuth(app);

// ✅ Esperar a que cargue el DOM
document.addEventListener("DOMContentLoaded", () => {
  // 🔐 Mostrar correo del usuario conectado
  onAuthStateChanged(auth, user => {
    const userDiv = document.getElementById("usuario-conectado");
    if (user && userDiv) {
      userDiv.textContent = `${user.email}`;
    }
  });

  // 🕒 Mostrar hora actual en <div id="reloj">
  function actualizarReloj() {
    const ahora = new Date();
    const opciones = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const hora = ahora.toLocaleTimeString("es-CL", opciones);
    const fecha = ahora.toLocaleDateString("es-CL", {
      day: '2-digit', month: 'short', year: 'numeric'
    });
    const reloj = document.getElementById("reloj");
    if (reloj) reloj.textContent = `${hora} - ${fecha}`;
    else console.warn("⚠️ No se encontró el div #reloj");
  }

  // 🕒 Activar reloj cada segundo (después de 100ms)
  setTimeout(() => {
    actualizarReloj();
    setInterval(actualizarReloj, 1000);
  }, 100);

  // ⏏️ Función global para cerrar sesión
  window.logout = async function () {
    try {
      await signOut(auth);
      alert("Sesión cerrada");
      window.location.href = "login.html";
    } catch (error) {
      alert("Error al cerrar sesión: " + error.message);
    }
  };
});
