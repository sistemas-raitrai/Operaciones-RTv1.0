// giradeestudio.js
import { app, db } from './firebase-init.js';
import { doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// Utilidad: extrae numeroNegocio desde /giradeestudio/1001 o como ?numeroNegocio=1001
function getNumeroNegocio() {
  const parts = window.location.pathname.split('/');
  // Busca si está como /giradeestudio/1001
  let n = parts[parts.length-1] || parts[parts.length-2];
  // O por query ?numeroNegocio=1001
  if (!/^\d+$/.test(n)) {
    n = new URLSearchParams(window.location.search).get('numeroNegocio');
  }
  return n;
}

// Utilidad: fecha bonita
function fechaBonita(iso) {
  if(!iso) return "";
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const d = new Date(iso);
  return `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
}

async function main() {
  const numeroNegocio = getNumeroNegocio();
  if (!numeroNegocio) {
    document.getElementById("grupo-info").innerHTML = "<b>No se especificó el número de negocio.</b>";
    return;
  }

  // Buscar grupo por numeroNegocio
  const gruposRef = collection(db, "grupos");
  const q = query(gruposRef, where("numeroNegocio", "==", numeroNegocio));
  const snap = await getDocs(q);
  if (snap.empty) {
    document.getElementById("grupo-info").innerHTML = `<b>No se encontró la información del grupo para N° de Negocio: ${numeroNegocio}</b>`;
    return;
  }
  // Solo debería haber uno
  const data = snap.docs[0].data();

  // Pintar datos generales
  document.getElementById("info-nombreGrupo").textContent  = data.nombreGrupo || "—";
  document.getElementById("info-colegio").textContent      = data.colegio     || "—";
  document.getElementById("info-curso").textContent        = data.curso       || "—";
  document.getElementById("info-anoViaje").textContent     = data.anoViaje    || "—";
  document.getElementById("info-destino").textContent      = data.destino     || "—";
  document.getElementById("info-vendedora").textContent    = data.vendedora   || "—";
  document.getElementById("info-cantidadgrupo").textContent = data.cantidadgrupo ?? "—";
  document.getElementById("info-adultos").textContent      = data.adultos     ?? "—";
  document.getElementById("info-estudiantes").textContent  = data.estudiantes ?? "—";

  let fechaIni = data.fechaInicio ? fechaBonita(data.fechaInicio) : "";
  let fechaFin = data.fechaFin ? fechaBonita(data.fechaFin) : "";
  document.getElementById("info-fechas").textContent = (fechaIni && fechaFin) ? `${fechaIni} al ${fechaFin}` : (fechaIni||fechaFin||"—");

  // Pintar itinerario (por fecha, ordenado)
  const itinerario = data.itinerario || {};
  const fechas = Object.keys(itinerario).sort();
  const cont = document.getElementById("itinerario-container");
  cont.innerHTML = "";
  if (fechas.length === 0) {
    cont.innerHTML = "<div>No hay actividades registradas para este grupo.</div>";
    return;
  }
  fechas.forEach(fecha => {
    const acts = itinerario[fecha] || [];
    // Día visual bonito (ej. "Lun 2 dic 2025")
    const d = new Date(fecha);
    const diaTxt = d.toLocaleDateString("es-CL", { weekday:"short", day:"numeric", month:"short", year:"numeric" });
    const col1 = document.createElement("div");
    col1.className = "itinerario-dia";
    col1.textContent = diaTxt.charAt(0).toUpperCase() + diaTxt.slice(1);
    cont.appendChild(col1);

    const col2 = document.createElement("div");
    acts.forEach(act => {
      const div = document.createElement("div");
      div.className = "itinerario-act";
      div.innerHTML = `
        <div><b>Hora:</b> ${act.horaInicio || "—"}</div>
        <div><b>Actividad:</b> ${act.actividad || "—"}</div>
        <div><b>Notas:</b> ${act.notas || ""}</div>
      `;
      col2.appendChild(div);
    });
    cont.appendChild(col2);
  });
}

main();
