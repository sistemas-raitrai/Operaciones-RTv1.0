// ✅ infoviajes.js

document.addEventListener("DOMContentLoaded", async () => {
  const dropdownNumeroNegocio = document.getElementById("numeroNegocio");
  const form = document.getElementById("formularioViaje");

  // 🟢 1. Intentar precargar el número de negocio desde sessionStorage
  const numeroGuardado = sessionStorage.getItem("numeroNegocio");
  if (numeroGuardado) {
    const option = document.createElement("option");
    option.value = numeroGuardado;
    option.textContent = numeroGuardado;
    option.selected = true;
    dropdownNumeroNegocio.appendChild(option);
  }

  // 🟢 2. Cargar todos los números de negocio desde Google Sheets
  async function cargarNumerosDesdeSheets() {
    const respuesta = await fetch("https://script.google.com/macros/s/AKfycbxO3PXYmuKlg-UjVMMY.../exec"); // URL real de tu Apps Script
    const data = await respuesta.json();
    data.forEach(item => {
      if (!numeroGuardado || item.numero !== numeroGuardado) {
        const option = document.createElement("option");
        option.value = item.numero;
        option.textContent = item.numero;
        dropdownNumeroNegocio.appendChild(option);
      }
    });
  }

  await cargarNumerosDesdeSheets();

  // 🟢 3. Condiciones dinámicas
  const transporteSelect = document.getElementById("transporte");
  const campoTramos = document.getElementById("tramosContainer");

  transporteSelect.addEventListener("change", () => {
    campoTramos.innerHTML = ""; // Limpia anteriores
    const tipo = transporteSelect.value;

    const cantidad = prompt("¿Cuántos tramos tiene el viaje?");
    if (!cantidad || isNaN(cantidad)) return;

    for (let i = 1; i <= parseInt(cantidad); i++) {
      const div = document.createElement("div");
      div.className = "tramo";

      if (tipo.includes("Terrestre")) {
        div.innerHTML = `
          <h4>Tramo ${i} (Terrestre)</h4>
          <input placeholder="Empresa de Bus" />
          <input placeholder="Conductor 1" />
          <input placeholder="Conductor 2" />
          <input type="datetime-local" placeholder="Fecha y hora de salida" />
          <input placeholder="Terminal de salida" />
        `;
      } else if (tipo.includes("Aereo")) {
        div.innerHTML = `
          <h4>Tramo ${i} (Aéreo)</h4>
          <input placeholder="Compañía aérea" />
          <input placeholder="Número de vuelo" />
          <input type="datetime-local" placeholder="Fecha y hora de salida" />
          <input placeholder="Aeropuerto de salida" />
        `;
      }

      campoTramos.appendChild(div);
    }
  });

  // 🟢 4. Guardar al Google Sheet
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      numeroNegocio: dropdownNumeroNegocio.value,
      destino: document.getElementById("destino").value,
      fechaInicio: document.getElementById("fechaInicio").value,
      fechaFin: document.getElementById("fechaFin").value,
      adultos: document.getElementById("adultos").value,
      estudiantes: document.getElementById("estudiantes").value,
      transporte: transporteSelect.value,
      tramos: Array.from(document.querySelectorAll(".tramo")).map(div =>
        Array.from(div.querySelectorAll("input")).map(i => i.value).join(" | ")
      ).join(" || "),
      ciudades: document.getElementById("ciudades").value,
      hoteles: Array.from(document.getElementById("hoteles").selectedOptions).map(opt => opt.value).join(", "),
      observaciones: document.getElementById("observaciones").value
    };

    try {
      const resp = await fetch("https://script.google.com/macros/s/AKfycbx.../exec", {
        method: "POST",
        body: JSON.stringify({ datos: payload }),
        headers: { "Content-Type": "application/json" }
      });

      const result = await resp.json();
      alert(result.mensaje || "Datos guardados correctamente");
    } catch (err) {
      console.error("❌ Error al guardar", err);
      alert("Hubo un problema al guardar los datos.");
    }
  });
});
