export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  const { datos, historial } = req.body;

  if (!datos || !datos.numeroNegocio) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const scriptURL = process.env.GOOGLE_SCRIPT_URL;

    const response = await fetch(scriptURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datos, historial })
    });

    const texto = await response.text();
    console.log("🟢 Respuesta del Apps Script:", texto);

    if (texto.includes("OK")) {
      return res.status(200).json({ message: "✅ Datos guardados en Google Sheets" });
    } else {
      return res.status(500).json({ error: texto });
    }

  } catch (error) {
    console.error("❌ Error:", error);
    return res.status(500).json({ error: "Error al conectar con Google Sheets" });
  }
}
