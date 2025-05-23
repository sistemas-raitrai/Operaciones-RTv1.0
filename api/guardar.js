export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  // ✅ Obtener token automáticamente desde Azure
  async function obtenerAccessToken() {
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;
    const tenantId = process.env.TENANT_ID;

    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await resp.json();
    if (!data.access_token) throw new Error("No se obtuvo access_token");
    return data.access_token;
  }

  const token = await obtenerAccessToken(); // ✅ token válido automático

  const workbookId = '38e4db77-4608-4481-96d1-712a199e4156';
  const endpointBase = `https://graph.microsoft.com/v1.0/users/ignacio@raitrail.onmicrosoft.com/drive/items/${workbookId}/workbook/worksheets`;

  const { datos, historial } = req.body;
  if (!datos || !historial) return res.status(400).json({ error: "Datos incompletos." });

  try {
    // ✅ 1. Armar los datos en el orden de las columnas
    const insertData = [
      datos.numeroNegocio, datos.nombreGrupo, datos.cantidadgrupo,
      datos.colegio, datos.curso, datos.anoViaje, datos.destino,
      datos.programa, datos.hotel, datos.asistenciaEnViajes,
      datos.autorizacion, datos.fechaDeViaje, datos.observaciones,
      datos.versionFicha, datos.creadoPor, datos.fechaCreacion
    ];
    
        // ✅ 2. Buscar si ya existe una fila con el mismo número de negocio
        const buscarExistente = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows?$top=999`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const dataFilas = await buscarExistente.json();
        // ✅ Buscar todas las filas con el mismo número de negocio
        const filasDuplicadas = dataFilas.value?.filter(fila => {
          const valor = fila?.values?.[0]?.[0]; // ✅ Accede al primer campo (columna A) de la fila
          console.log("🔎 Verificando fila:", valor);
          return valor?.toString().trim() === datos.numeroNegocio.toString().trim();
        });
    
    // 🧽 Eliminar todas las coincidencias encontradas
      for (const fila of filasDuplicadas) {
        const id = fila?.id;
        if (!id) {
          console.warn(`⚠️ Fila sin ID encontrada. Saltando eliminación.`);
          continue;
        }
      
        const eliminar = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` }
        });
      
        if (!eliminar.ok) {
          console.error(`❌ Error al eliminar fila ID ${id}`);
        }
      }

    
      // 🔁 Espera un momento después de las eliminaciones
      console.log("⌛ Esperando que Excel actualice antes de insertar...");
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 🔄 Revalidar que no quedó ninguna fila duplicada antes de insertar
      const revalidar = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows?$top=999`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const filasFinales = await revalidar.json();
      
      const sigueExistiendo = filasFinales.value?.some(f =>
        f?.values?.[0]?.[0]?.toString().trim() === datos.numeroNegocio.toString().trim()
      );
      
      if (sigueExistiendo) {
        console.warn("⚠️ Fila aún existe después de esperar. Esperando 1 segundo más...");
        await new Promise(resolve => setTimeout(resolve, 1000));
      
        // Reintentar una vez más
        const segundoIntento = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows?$top=999`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const finalFinal = await segundoIntento.json();
      
        const persiste = finalFinal.value?.some(f =>
          f?.values?.[0]?.[0]?.toString().trim() === datos.numeroNegocio.toString().trim()
        );
      
        if (persiste) {
          console.error("❌ La fila aún persiste después de reintento. Cancelando inserción.");
          return res.status(409).json({ error: "Conflicto: la fila duplicada no pudo ser eliminada." });
        }
      }
      
      // ➕ Insertar la nueva fila limpia
      const resInsert = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows/add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [insertData] }),
    });
    
    const resultadoInsert = await resInsert.json();
    console.log("✅ Insertado nuevo registro:", resultadoInsert);

    // ✅ 2. Insertar historial
    const historialData = historial.map(change => [
      datos.numeroNegocio, datos.nombreGrupo, datos.anoViaje,
      change.campo, change.anterior, change.nuevo,
      datos.modificadoPor, new Date().toISOString()
    ]);

    if (historialData.length > 0) {
      const resHist = await fetch(`${endpointBase}/HistorialCambios/tables/HistorialCambios/rows/add`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: historialData }),
      });

      const resultadoHist = await resHist.json();
      console.log("🕓 HistorialCambios:", resultadoHist);
    }

    return res.status(200).json({ message: "✅ Guardado exitoso en Excel Online." });

  } catch (err) {
    console.error("❌ Error al guardar:", err);
    return res.status(500).json({ error: "Error interno al guardar en Excel." });
  }
}
