<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Generador de Contratos</title>
  <!-- Tu CSS habitual -->
  <link rel="stylesheet" href="/estilos.css" />
  <link rel="icon" href="/logo.png" />
</head>
<body>

  <!-- ===========================
       ENCABEZADO
       =========================== -->
  <div style="background:#fff;padding:1rem;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ccc;">
    <div style="display:flex;align-items:center;">
      <img src="/logo.png" alt="Logo Rai Trai" style="height:60px;margin-right:1rem;">
      <div>
        <h2 style="margin:0;font-size:1.5rem;color:#2c3e50;">GENERADOR AUTOMÁTICO DE CONTRATOS</h2>
        <p style="margin:0;font-size:0.9rem;"><strong>Plantilla fija en servidor</strong></p>
      </div>
    </div>
  </div>

  <!-- ===========================
       CONTENEDOR PRINCIPAL
       =========================== -->
  <div class="contenedor">

    <!-- 1) SELECCIÓN DE GRUPO -->
    <h2>Seleccionar Grupo</h2>
    <label>
      Número de Negocio:
      <input list="businessList" id="numeroNegocio" placeholder="Buscar..." />
    </label>
    <datalist id="businessList"></datalist>

    <label>
      Nombre de Grupo:
      <input list="grupoList" id="nombreGrupo" placeholder="Buscar..." />
    </label>
    <datalist id="grupoList"></datalist>

    <!-- 2) DATOS DEL CONTRATO -->
    <h2>Datos del Contrato</h2>
    <div class="grid">
      <label>Fecha del Contrato:<input type="date" id="FECHA_CONTRATO" /></label>
      <label>Curso:<input type="text" id="CURSO" placeholder="Ej. 3B" /></label>
      <label>Año:<input type="number" id="AÑO" placeholder="Ej. 2025" /></label>
      <label>Colegio:<input type="text" id="COLEGIO" placeholder="Nombre del colegio" /></label>
      <label>Comuna:<input type="text" id="COMUNA" placeholder="Ej. Providencia" /></label>
      <label>Valor Programa:<input type="text" id="VALOR_PROGRAMA" placeholder="Ej. 1200" /></label>
      <label>PAX Mínimos:<input type="number" id="PAX_MIN" placeholder="Ej. 20" /></label>
      <label>PAX Liberados:<input type="number" id="PAX_LIBERADOS" placeholder="Ej. 2" /></label>

      <!-- Nuevo campo de email -->
      <label>Email destinatario:
        <input list="emailList" id="DEST_EMAIL" placeholder="Selecciona un email" />
      </label>
      <datalist id="emailList">
        <option value="griveros@raitrai.cl">
        <option value="cgayoso@raitrai.cl">
        <option value="crojas@raitrai.cl">
        <option value="orietta@raitrai.cl">
        <option value="elagos@raitrai.cl">
        <option value="aflores@raitrai.cl">
        <option value="chernandez@raitrai.cl">
      </datalist>

      <label>Moneda:<input type="text" id="MONEDA" readonly /></label>
      <label>Cuota Inscripción:<input type="text" id="CUOTA_INSCRIPCION" placeholder="Ej. 150" /></label>
      <label>Fecha Inscripción:<input type="date" id="FECHA_INSCRIPCION" /></label>
      <label>Fecha Pago Final:<input type="date" id="FECHA_PAGO_FINAL" /></label>
    </div>

    <!-- 3) CLÁUSULAS ADICIONALES -->
    <h2>Cláusulas adicionales</h2>
    <div id="clausulasContainer"></div>
    <button id="addClause" style="margin-bottom:1rem;">➕ Agregar cláusula</button>

    <!-- 4) GENERAR -->
    <button onclick="generarContrato()">📄 Descargar Contrato</button>
    <div id="estado" style="margin-top:1rem;font-style:italic;color:#c0392b;"></div>
  </div>

  <script>
    // ——————————————————————————————————————————
    //  URL de tu Web-App de Apps Script (CORS habilitado)
    //  ID de implementación: AKfycbz3hqiMso4WDmHf-L_pWumNenIR9m-7appsl5-SsL3I28QD71weJHZNL4i4l8Jo7lJEBg
    // ——————————————————————————————————————————
    const sheetURL = 
      'https://script.google.com/macros/s/AKfycbz3hqiMso4WDmHf-L_pWumNenIR9m-7appsl5-SsL3I28QD71weJHZNL4i4l8Jo7lJEBg/exec';

    // 1) Añadir / eliminar cláusulas dinámicamente
    document.getElementById("addClause").addEventListener("click", () => {
      const cont = document.getElementById("clausulasContainer");
      const div = document.createElement("div");
      div.className = "clausula";
      div.style.marginBottom = "1rem";
      div.innerHTML = `
        <label>Título cláusula:<input type="text" name="titulo" placeholder="Ej: Fuerza mayor"/></label>
        <label>Texto cláusula:<textarea name="texto" rows="4" placeholder="Redacta la cláusula…"></textarea></label>
        <button type="button" class="removeClause" style="background:#c0392b;color:#fff;">Eliminar</button>
      `;
      cont.appendChild(div);
      div.querySelector(".removeClause").onclick = () => div.remove();
    });

    // 2) Al cargar la página, traer y parsear tu sheet JSON
    window.addEventListener("DOMContentLoaded", () => {
      fetch(sheetURL)
        .then(r => {
          if (!r.ok) throw new Error("HTTP "+r.status);
          return r.json();
        })
        .then(rows => {
          const bl = document.getElementById("businessList");
          const gl = document.getElementById("grupoList");

          // 2.a) Poblar datalists con valores de la hoja
          rows.forEach(r => {
            if (r.numeroNegocio) bl.append(new Option(r.numeroNegocio, r.numeroNegocio));
            if (r.nombreGrupo)  gl.append(new Option(r.nombreGrupo,  r.nombreGrupo));
          });

          // 2.b) Auto-completar al cambiar número o nombre
          ["numeroNegocio","nombreGrupo"].forEach(id => {
            document.getElementById(id).addEventListener("change", e => {
              const v = e.target.value.trim();
              const row = rows.find(r =>
                String(r.numeroNegocio) === v || r.nombreGrupo === v
              );
              if (!row) return;

              // --- Extraer Colegio / Curso / Año de "nombreGrupo" ---
              const m = row.nombreGrupo.match(
                /^(.+?)\s*(?:\(\d{4}\))?(?:\s*-\s*)?(\d+\w?)\s*\((\d{4})\)/
              );
              if (m) {
                document.getElementById("COLEGIO").value = m[1];
                document.getElementById("CURSO").value   = m[2];
                document.getElementById("AÑO").value     = m[3];
              }

              // --- El resto de campos según nombre de columna en tu sheet ---
              document.getElementById("COMUNA").value        = row.direccion    || "";
              const vp = row.valorPrograma || "";
              document.getElementById("MONEDA").value        = vp.includes("USD") ? "USD" : "CLP";
              document.getElementById("VALOR_PROGRAMA").value = vp.replace(/[^\d]/g,"");
              document.getElementById("PAX_MIN").value       = row.cantidadgrupo || "";
              document.getElementById("PAX_LIBERADOS").value = row.liberados     || "";
            });
          });
        })
        .catch(err => {
          console.error("❌ Error leyendo Sheet JSON:", err);
          document.getElementById("estado").textContent =
            "❌ No fue posible cargar los datos.";
        });
    });

    // 3) Generar y descargar el contrato
    async function generarContrato() {
      const fields = [
        'FECHA_CONTRATO','CURSO','AÑO','COLEGIO','COMUNA',
        'VALOR_PROGRAMA','PAX_MIN','PAX_LIBERADOS',
        'DEST_EMAIL','MONEDA','CUOTA_INSCRIPCION',
        'FECHA_INSCRIPCION','FECHA_PAGO_FINAL'
      ];
      const data = {};
      fields.forEach(id => data[id] = document.getElementById(id).value);

      // Adjuntar cláusulas adicionales
      data.clausulas = Array.from(
        document.querySelectorAll(".clausula")
      ).map(div => ({
        titulo: div.querySelector("input[name=titulo]").value,
        texto:  div.querySelector("textarea[name=texto]").value
      })).filter(c => c.titulo || c.texto);

      document.getElementById("estado").textContent = "⏳ Generando contrato…";

      try {
        const res = await fetch("/api/generar", {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(await res.text());

        // Forzar descarga del DOCX que devuelve tu API
        const blob = await res.blob();
        const fn = res.headers.get("Content-Disposition")
                     ?.match(/filename="?(.+)"?$/)?.[1]
                   || "Contrato.docx";
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fn;
        document.body.append(a);
        a.click();
        a.remove();
      } catch(err) {
        alert("Error: "+err.message);
      } finally {
        document.getElementById("estado").textContent = "";
      }
    }
  </script>
</body>
</html>
