import { db } from './firebase-init.js';
import {
  doc,
  getDoc,
  updateDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const API_PAGOS_URL = '/api/pagos';

function normalizarTextoPaxSync(txt = '') {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function obtenerNumerosNegocioPagoSync(numeroNegocio) {
  const raw = String(numeroNegocio || '').trim();
  if (!raw) return [];

  if (/^\d+\s*-\s*\d+$/.test(raw)) {
    return raw.split('-').map(x => x.trim()).filter(Boolean);
  }

  return [raw];
}

function pasajeroViajaSync(p) {
  const v = p.viaja ?? p.estado_viaje ?? p.estado ?? p.activo ?? '';

  if (typeof v === 'number') return Number(v) === 1;

  const txt = normalizarTextoPaxSync(v);

  if (!txt) return true;

  if (['1', 'si', 'sí', 'viaja', 'activo', 'activa'].includes(txt)) {
    return true;
  }

  if (['0', 'no', 'no viaja', 'anulado', 'anulada', 'baja'].includes(txt)) {
    return false;
  }

  return true;
}

function tipoPasajeroPagosSync(p) {
  const categoria = normalizarTextoPaxSync(
    p.ocupacion_categoria ||
    p.categoria ||
    p.tipo_pasajero ||
    p.tipo ||
    p.ocupacion ||
    ''
  );

  if (
    categoria.includes('estudiante') ||
    categoria.includes('alumno') ||
    categoria.includes('alumna')
  ) {
    return 'estudiante';
  }

  return 'adulto';
}

function crearResumenPagosVacioSync() {
  return {
    totalAdultos: 0,
    totalEstudiantes: 0,
    totalViajan: 0,
    totalNoViajan: 0,
    totalLeidos: 0
  };
}

function sumarResumenPagosSync(base, add) {
  base.totalAdultos += Number(add.totalAdultos || 0);
  base.totalEstudiantes += Number(add.totalEstudiantes || 0);
  base.totalViajan += Number(add.totalViajan || 0);
  base.totalNoViajan += Number(add.totalNoViajan || 0);
  base.totalLeidos += Number(add.totalLeidos || 0);
}

function calcularResumenPagosSync(items) {
  const resumen = crearResumenPagosVacioSync();
  const pasajeros = Array.isArray(items) ? items : [];

  pasajeros.forEach(item => {
    const p = item?.pasajero || item || {};
    resumen.totalLeidos++;

    if (!pasajeroViajaSync(p)) {
      resumen.totalNoViajan++;
      return;
    }

    resumen.totalViajan++;

    const tipo = tipoPasajeroPagosSync(p);

    if (tipo === 'estudiante') {
      resumen.totalEstudiantes++;
    } else {
      resumen.totalAdultos++;
    }
  });

  return resumen;
}

async function consultarResumenPagosFusionadoSync(numerosPago) {
  const acumulado = crearResumenPagosVacioSync();

  for (const numero of numerosPago) {
    const url = `${API_PAGOS_URL}?modo=detalle&numeroNegocio=${encodeURIComponent(numero)}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} consultando pagos ${numero}`);
    }

    const data = await res.json();

    const pasajeros =
      data?.nominas?.data?.pasajeros ||
      data?.saldos?.data?.detalle_pasajeros ||
      [];

    const resumen = calcularResumenPagosSync(pasajeros);
    sumarResumenPagosSync(acumulado, resumen);
  }

  return acumulado;
}

function sincronizarItinerarioConPax(itinerario, resumenPagos) {
  const nuevo = {};
  let huboCambio = false;

  Object.entries(itinerario || {}).forEach(([fecha, actividades]) => {
    nuevo[fecha] = (actividades || []).map(act => {
      const adultosActual = Number(act.adultos || 0);
      const estudiantesActual = Number(act.estudiantes || 0);
      const pasajerosActual = Number(act.pasajeros || 0);

      const adultosNuevo = Number(resumenPagos.totalAdultos || 0);
      const estudiantesNuevo = Number(resumenPagos.totalEstudiantes || 0);
      const pasajerosNuevo = Number(resumenPagos.totalViajan || 0);

      if (
        adultosActual !== adultosNuevo ||
        estudiantesActual !== estudiantesNuevo ||
        pasajerosActual !== pasajerosNuevo
      ) {
        huboCambio = true;
      }

      return {
        ...act,
        adultos: adultosNuevo,
        estudiantes: estudiantesNuevo,
        pasajeros: pasajerosNuevo
      };
    });
  });

  return { itinerario: nuevo, huboCambio };
}

export async function sincronizarPaxGrupoDesdePagos(grupoId) {
  const grupoRef = doc(db, 'grupos', grupoId);
  const snap = await getDoc(grupoRef);

  if (!snap.exists()) {
    return {
      ok: false,
      grupoId,
      error: 'GRUPO_NO_EXISTE'
    };
  }

  const g = snap.data() || {};
  const numeroNegocio = g.numeroNegocio || grupoId;
  const numerosPago = obtenerNumerosNegocioPagoSync(numeroNegocio);

  if (!numerosPago.length) {
    return {
      ok: false,
      grupoId,
      numeroNegocio,
      error: 'SIN_NUMERO_NEGOCIO'
    };
  }

  const resumenPagos = await consultarResumenPagosFusionadoSync(numerosPago);

  const { itinerario: itinerarioSync, huboCambio: cambioItinerario } =
    sincronizarItinerarioConPax(g.itinerario || {}, resumenPagos);

  const payload = {
    adultos: resumenPagos.totalAdultos,
    estudiantes: resumenPagos.totalEstudiantes,
    cantidadgrupo: resumenPagos.totalViajan,
    pax: resumenPagos.totalViajan,

    paxFuente: 'PAGOS',
    paxNumerosPago: numerosPago,
    paxActualizadoEn: serverTimestamp(),
    paxResumenPagos: resumenPagos
  };

  if (cambioItinerario) {
    payload.itinerario = itinerarioSync;
  }

  await updateDoc(grupoRef, payload);

  return {
    ok: true,
    grupoId,
    numeroNegocio,
    numerosPago,
    resumenPagos,
    cambioItinerario
  };
}
