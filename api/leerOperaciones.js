export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

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

  try {
    const body = await req.json?.() || req.body;
    const numeroNegocio = body?.numeroNegocio;

    if (!numeroNegocio) return res.status(400).json({ error: "Falta numeroNegocio" });

    const token = await obtenerAccessToken();
    const workbookId = '38e4db77-4608-4481-96d1-712a199e4156';
    const endpoint = `https://graph.microsoft.com/v1.0/users/ignacio@raitrail.onmicrosoft.com/drive/items/${workbookId}/workbook/worksheets/BaseOperaciones/tables/BaseOperaciones/rows`;

    const resp = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await resp.json();
    const fila = data.value?.find(fila =>
      fila?.values?.[0]?.toString().trim() === numeroNegocio.toString().trim()
    );

    if (!fila) return res.status(200).json({ existe: false });

    return res.status(200).json({ existe: true, valores: fila.values[0] });

  } catch (err) {
    console.error("❌ Error al leer desde Excel Online:", err);
    return res.status(500).json({ error: "Error interno al leer desde Excel." });
  }
}
