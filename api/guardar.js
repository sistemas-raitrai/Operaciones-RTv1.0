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
    const buscarExistente = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const dataFilas = await buscarExistente.json();
    
    // ✅ Buscar si ya existe una fila con el mismo número de negocio (más robusto)
    let filaExistente = null;
    
    for (const fila of dataFilas.value || []) {
      const valorColumnaA = fila?.values?.[0]?.[0]; // Primer campo de la fila
      console.log("🔎 Comparando:", valorColumnaA, "vs", datos.numeroNegocio);
    
      if (valorColumnaA?.toString().trim() === datos.numeroNegocio.toString().trim()) {
        filaExistente = fila;
        break;
      }
    }
    
    // ✅ 3. Si existe, actualiza la fila. Si no, inserta una nueva
    if (filaExistente) {
      const rowId = filaExistente.id;
    
      // 🧽 1. Elimina la fila anterior
      await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows/${rowId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
    
      // ➕ 2. Inserta la nueva fila completa con los datos actualizados
      const resInsert = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows/add`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [insertData] }),
      });
    
      const resultadoInsert = await resInsert.json();
      console.log("🔁 Reemplazada fila:", resultadoInsert);
    } else {
      const resInsert = await fetch(`${endpointBase}/BaseOperaciones/tables/BaseOperaciones/rows/add`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [insertData] }),
      });
    
      const resultadoInsert = await resInsert.json();
      console.log("🆕 Insertado:", resultadoInsert);
    }

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
