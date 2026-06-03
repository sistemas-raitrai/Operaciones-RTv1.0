const BASE_API_PAGOS = "https://pagos.turismoraitrai.cl/agencia/api";

export default async function handler(req, res) {
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const modo = req.query.modo || "grupos";
    const numeroNegocio = req.query.numeroNegocio || "";
    const token = process.env.TOKEN_API_PAGOS;

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };

    async function pedirJson(url) {
      const r = await fetch(url, { headers });
      const txt = await r.text();
      return JSON.parse(txt);
    }

    if (modo === "grupos") {
      const grupos = await pedirJson(`${BASE_API_PAGOS}/api_colegios.php`);
      return res.status(200).json({ ok: true, modo, grupos });
    }

    if (modo === "detalle") {
      if (!numeroNegocio) {
        return res.status(400).json({
          ok: false,
          error: "Falta numeroNegocio"
        });
      }

      const [nominas, saldos] = await Promise.all([
        pedirJson(`${BASE_API_PAGOS}/api_nominas.php?negocio_id=${numeroNegocio}`),
        pedirJson(`${BASE_API_PAGOS}/api_saldos.php?negocio_id=${numeroNegocio}`)
      ]);

      return res.status(200).json({
        ok: true,
        modo,
        numeroNegocio,
        nominas,
        saldos
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Modo no reconocido"
    });

  } catch (error) {
    console.error("Error api/pagos:", error);

    return res.status(500).json({
      ok: false,
      error: "Error consultando API de pagos",
      detalle: error.message
    });
  }
}
