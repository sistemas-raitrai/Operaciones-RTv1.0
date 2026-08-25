//grupos.js

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection,
  collectionGroup,
  getDocs,
  getDoc,
  query,
  orderBy,
  where,
  limit,
  doc,
  updateDoc,
  addDoc,
  Timestamp,
  writeBatch,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
// Clave requerida para modificar PAX / ADULTOS / ESTUDIANTES
const PAX_PASSWORD = 'Nacho123!';
const API_PAGOS_URL = '/api/pagos';


// Propiedades en el mismo orden que aparecen en la tabla
const camposFire = [
  "numeroNegocio",          // 0
  "identificador",          // 1
  "nombreGrupo",            // 2
  "anoViaje",               // 3
  "vendedora",              // 4

  // NUEVO
  "cantidadCoordinadores",  // 5

  "cantidadgrupo",          // 6
  "adultos",                // 7
  "estudiantes",            // 8
  "colegio",                // 9
  "curso",                  // 10
  "destino",                // 11
  "programa",               // 12
  "fechaInicio",            // 13
  "fechaFin",               // 14
  "asistenciaEnViajes",     // 15
  "autorizacion",           // 16
  "hoteles",                // 17
  "ciudades",               // 18
  "transporte",             // 19
  "tramos",                 // 20
  "fechaDeViaje",           // 21
  "observaciones",          // 22
  "creadoPor",              // 23
  "fechaCreacion"           // 24
];

// Campos que deben ser numéricos en Firestore
const NUMERIC_FIELDS = new Set([
  'cantidadCoordinadores',
  'cantidadgrupo',
  'adultos',
  'estudiantes'
]);

const PAX_FIELDS = new Set(['cantidadgrupo', 'adultos', 'estudiantes']);

function normalizarCantidadCoordinadores(valor) {
  const n =
    Number.parseInt(
      String(
        valor ?? 1
      ),
      10
    );

  if (!Number.isFinite(n)) {
    return 1;
  }

  return Math.min(
    3,
    Math.max(
      1,
      n
    )
  );
}

function validarFilaPax($tr) {
  const $pax = $tr.find('td[data-campo="cantidadgrupo"]');
  const $adultos = $tr.find('td[data-campo="adultos"]');
  const $estudiantes = $tr.find('td[data-campo="estudiantes"]');

  const pax = toNum($pax.text());
  const adultos = toNum($adultos.text());
  const estudiantes = toNum($estudiantes.text());

  const ok = pax === adultos + estudiantes;

  [$pax, $adultos, $estudiantes].forEach($td => {
    $td.toggleClass('pax-error', !ok);
    $td.attr(
      'title',
      ok ? '' : `Error: PAX ${pax} ≠ Adultos ${adultos} + Estudiantes ${estudiantes}`
    );
  });

  return ok;
}

function validarTodasLasFilasPax() {
  let todoOk = true;

  $('#tablaGrupos tbody tr').each((_, tr) => {
    const ok = validarFilaPax($(tr));
    if (!ok) todoOk = false;
  });

  return todoOk;
}

let editMode = false;
let dtHist = null;
let GRUPOS_RAW = [];

let tablaGruposDT = null;
let REVISION_PAX_ACTIVA = false;

// Cambios editados en pantalla pero todavía NO guardados en Firebase
let cambiosPendientes = [];

const ANO_ACTUAL = new Date().getFullYear();

function resolverAnoFiltro(valor) {
  if (valor === 'anterior') return String(ANO_ACTUAL - 1);
  if (valor === 'proximo') return String(ANO_ACTUAL + 1);
  if (valor === 'todos') return 'todos';
  return String(ANO_ACTUAL);
}

// 👇 NUEVO: estado de filtros de vuelo
const FLT_FILTER = {
  tipo: 'all',      // 'all' | 'charter' | 'regular'
  fechaIda: ''      // 'YYYY-MM-DD' o ''
};

$(function(){
  $('#btn-logout').click(() => signOut(auth).then(()=>location='login.html'));
  onAuthStateChanged(auth, user => {
    if (!user) location = 'login.html';
    else cargarYMostrarTabla('actual');
  });
});

function formatearCelda(valor, campo) {
  const camposFecha = ['fechaInicio', 'fechaFin', 'fechaDeViaje', 'fechaCreacion'];

  if (camposFecha.includes(campo)) {
    let date = null;

    if (valor instanceof Timestamp) {
      date = valor.toDate();
    } else if (valor?.toDate) {
      date = valor.toDate();
    } else {
      date = parseFechaPosible(valor);
    }

    if (date instanceof Date && !isNaN(date.getTime())) {
      return date.toLocaleDateString('es-CL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }).replaceAll('/', '-');
    }
  }

  return valor?.toString() || '';
}

// ==== Helpers de normalización para Totales ====
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function parseFechaPosible(v) {
  if (!v) return null;
  if (v instanceof Timestamp) return v.toDate();
  if (v?.toDate) return v.toDate();
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (m) {
      let [ , dd, mm, yy ] = m;
      dd = dd.padStart(2,'0'); mm = mm.padStart(2,'0');
      yy = yy.length === 2 ? ('20' + yy) : yy;
      return new Date(`${yy}-${mm}-${dd}T00:00:00`);
    }
  }
  return null;
}

// Convierte Date -> "YYYY-MM-DD" para <input type="date">
function toInputDate(d) {
  if (!(d instanceof Date)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function crearRangoFechasISO(fechaInicio, fechaFin) {
  const ini = parseFechaPosible(fechaInicio);
  const fin = parseFechaPosible(fechaFin);

  if (!ini || !fin || fin < ini) return [];

  const out = [];

  for (let d = new Date(ini); d <= fin; d.setDate(d.getDate() + 1)) {
    out.push(toInputDate(d));
  }

  return out;
}

function esDiaRelativoItinerario(k) {
  return /^DIA_\d+$/i.test(String(k || '').trim());
}

function ordenarDiasRelativos(a, b) {
  const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0;
  const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0;
  return na - nb;
}

async function sincronizarFechasEItinerarioGrupo(docId) {
  const ref = doc(db, 'grupos', docId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    throw new Error(`No existe el grupo ${docId}.`);
  }

  const g = snap.data() || {};

  const fechasNuevas = crearRangoFechasISO(
    g.fechaInicio,
    g.fechaFin
  );

  if (!fechasNuevas.length) {
    throw new Error(
      `El grupo ${g.numeroNegocio || docId} tiene un rango de fechas inválido.`
    );
  }

  const itinerarioAnterior = g.itinerario || {};

  const keysAnteriores = Object.keys(itinerarioAnterior)
    .sort((a, b) => {
      const aReal = /^\d{4}-\d{2}-\d{2}$/.test(String(a));
      const bReal = /^\d{4}-\d{2}-\d{2}$/.test(String(b));

      if (aReal && bReal) {
        return new Date(a) - new Date(b);
      }

      if (aReal) return -1;
      if (bReal) return 1;

      const na =
        parseInt(String(a).replace(/\D/g, ''), 10) || 0;

      const nb =
        parseInt(String(b).replace(/\D/g, ''), 10) || 0;

      return na - nb;
    });

  // =====================================================
  // PROTECCIÓN:
  // no permitir que una sincronización elimine días
  // =====================================================
  if (
    keysAnteriores.length > 0 &&
    fechasNuevas.length < keysAnteriores.length
  ) {
    await addDoc(collection(db, 'historial'), {
      numeroNegocio: g.numeroNegocio || docId,
      nombreGrupo: g.nombreGrupo || '',

      accion: 'SINCRONIZACIÓN FECHAS BLOQUEADA',

      motivo:
        'El nuevo rango tenía menos días que el itinerario existente.',

      anterior: {
        fechaInicio: _toISO(g.fechaInicio),
        fechaFin: _toISO(g.fechaFin),
        cantidadDias: keysAnteriores.length,
        itinerarioKeys: keysAnteriores,
        itinerario: itinerarioAnterior
      },

      intento: {
        cantidadDias: fechasNuevas.length,
        itinerarioKeys: fechasNuevas
      },

      usuario: auth.currentUser?.email || '',
      timestamp: new Date()
    });

    throw new Error(
      `No se sincronizó el itinerario del grupo ${g.numeroNegocio || docId}. ` +
      `Actualmente tiene ${keysAnteriores.length} días y el nuevo rango solamente tiene ${fechasNuevas.length}. ` +
      `La operación fue bloqueada para evitar eliminar actividades.`
    );
  }

  const nuevoItinerario = {};

  fechasNuevas.forEach((fechaReal, idx) => {
    const keyAnterior = keysAnteriores[idx];

    nuevoItinerario[fechaReal] = keyAnterior
      ? (itinerarioAnterior[keyAnterior] || [])
      : [];
  });

  await updateDoc(ref, {
    itinerario: nuevoItinerario,
    updatedAt: serverTimestamp()
  });

  await addDoc(collection(db, 'historial'), {
    numeroNegocio: g.numeroNegocio || docId,
    nombreGrupo: g.nombreGrupo || '',

    accion: 'SINCRONIZAR FECHAS E ITINERARIO',

    anterior: {
      cantidadDias: keysAnteriores.length,
      itinerarioKeys: keysAnteriores,
      itinerario: itinerarioAnterior
    },

    nuevo: {
      cantidadDias: fechasNuevas.length,
      itinerarioKeys: fechasNuevas,
      itinerario: nuevoItinerario
    },

    usuario: auth.currentUser?.email || '',
    timestamp: new Date()
  });

  return true;
}

// ================== ENRIQUECIMIENTO: HELPERS REUTILIZABLES ===================
const _norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,'');
const _arrify = v => Array.isArray(v) ? v : (v && typeof v==='object' ? Object.values(v) : (v?[v]:[]));

function _toISO(x){
  if (!x) return '';
  if (typeof x === 'string') {
    const t = x.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;          // YYYY-MM-DD
    if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {                   // DD-MM-YYYY
      const [dd,mm,yy] = t.split('-');
      return `${yy}-${mm}-${dd}`;
    }
    const d = new Date(t);
    return isNaN(d) ? '' : d.toISOString().slice(0,10);
  }
  if (x instanceof Date) return x.toISOString().slice(0,10);
  if (x?.toDate) return x.toDate().toISOString().slice(0,10);
  if (x?.seconds != null) return new Date(x.seconds*1000).toISOString().slice(0,10);
  return '';
}
const _dmy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||''); 
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const _timeVal = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t||'').trim());
  if (!m) return 1e9;
  const h = Math.max(0, Math.min(23, parseInt(m[1],10)));
  const mi= Math.max(0, Math.min(59, parseInt(m[2],10)));
  return h*60+mi;
};

// === Color de fondo por estado del coordinador ===
function _bgEstado(est){
  const v = String(est||'').toLowerCase();
  if (v === 'aprobado')  return 'background-color: rgba(16,185,129,.18)'; // verde suave
  if (v === 'rechazado') return 'background-color: rgba(239,68,68,.18)';  // rojo suave
  return 'background-color: rgba(234,179,8,.22)';                         // amarillo (pendiente / default)
}

// Emails/nombres probables de coordinadores desde el doc grupo
function _emailsOf(g){
  const out = new Set();
  const push = (e)=>{ if(e) out.add(String(e).toLowerCase()); };
  push(g?.coordinadorEmail); 
  push(g?.coordinador?.email);
  _arrify(g?.coordinadoresEmails).forEach(push);
  if (g?.coordinadoresEmailsObj) Object.keys(g.coordinadoresEmailsObj).forEach(push);
  _arrify(g?.coordinadores).forEach(x=>{
    if (x?.email) push(x.email);
    else if (typeof x === 'string' && x.includes('@')) push(x);
  });
  return [...out];
}

// ============================================================
// HOTELES - CARGA MASIVA / ÍNDICES EN MEMORIA
// ============================================================

const _hotelesCache = {
  loaded: false,
  byId: new Map(),
  bySlug: new Map(),
  all: []
};

function _pushMapArray(map, key, value) {
  const k = String(key || '').trim();

  if (!k) return;

  if (!map.has(k)) {
    map.set(k, []);
  }

  map.get(k).push(value);
}

async function _ensureHotelesIndex(db) {
  if (_hotelesCache.loaded) {
    return _hotelesCache;
  }

  const snap = await getDocs(
    collection(db, 'hoteles')
  );

  snap.forEach(d => {
    const x = d.data() || {};

    const docu = {
      id: d.id,
      ...x
    };

    const slug = _norm(
      x.slug ||
      x.nombre ||
      d.id
    );

    _hotelesCache.byId.set(
      String(d.id),
      docu
    );

    if (slug) {
      _hotelesCache.bySlug.set(
        slug,
        docu
      );
    }

    _hotelesCache.all.push(
      docu
    );
  });

  _hotelesCache.loaded = true;

  return _hotelesCache;
}

function _extraerClavesGrupoAsignacionHotel(a) {
  const out = new Set();

  const add = value => {
    const v = String(value || '').trim();

    if (v) {
      out.add(v);
    }
  };

  add(a.grupoId);
  add(a.grupoDocId);
  add(a.grupoNumero);
  add(a.numeroNegocio);
  add(a.numNegocio);

  if (Array.isArray(a.grupoIds)) {
    a.grupoIds.forEach(add);
  }

  if (Array.isArray(a.grupos)) {
    a.grupos.forEach(x => {
      if (typeof x === 'string') {
        add(x);
        return;
      }

      if (x && typeof x === 'object') {
        add(x.id);
        add(x.grupoId);
        add(x.grupoDocId);
        add(x.numeroNegocio);
        add(x.numNegocio);
        add(x.grupoNumero);
      }
    });
  }

  return [...out];
}

async function _buildHotelesAssignmentsIndex(db) {
  const byGrupo = new Map();

  const snap = await getDocs(
    collection(
      db,
      'hotelAssignments'
    )
  );

  snap.forEach(d => {
    const a = {
      id: d.id,
      ...(d.data() || {})
    };

    const claves =
      _extraerClavesGrupoAsignacionHotel(a);

    claves.forEach(clave => {
      _pushMapArray(
        byGrupo,
        clave,
        a
      );
    });
  });

  return byGrupo;
}

function _resolverHotelDocDesdeAsignacion(
  asig,
  g,
  hotelIndex
) {
  const {
    byId,
    bySlug,
    all
  } = hotelIndex;

  const tryIds = [];

  if (asig?.hotelId) {
    tryIds.push(
      String(asig.hotelId)
    );
  }

  if (asig?.hotelDocId) {
    tryIds.push(
      String(asig.hotelDocId)
    );
  }

  if (asig?.hotel?.id) {
    tryIds.push(
      String(asig.hotel.id)
    );
  }

  if (asig?.hotelRef?.id) {
    tryIds.push(
      String(asig.hotelRef.id)
    );
  }

  const m =
    String(
      asig?.hotelPath ||
      ''
    ).match(
      /hoteles\/([^/]+)/i
    );

  if (m) {
    tryIds.push(
      m[1]
    );
  }

  for (const id of tryIds) {
    if (byId.has(id)) {
      return byId.get(id);
    }
  }

  const nombre =
    _norm(
      asig?.nombre ||
      asig?.hotelNombre ||
      ''
    );

  const destino =
    _norm(
      g?.destino ||
      ''
    );

  if (nombre) {
    if (bySlug.has(nombre)) {
      return bySlug.get(nombre);
    }

    const candidatos = [];

    for (
      const [slugName, docu]
      of bySlug
    ) {
      if (
        slugName.includes(nombre) ||
        nombre.includes(slugName)
      ) {
        candidatos.push(docu);
      }
    }

    if (candidatos.length === 1) {
      return candidatos[0];
    }

    const mismoDestino =
      candidatos.find(h =>
        _norm(
          h.destino ||
          h.ciudad ||
          ''
        ) === destino
      );

    return (
      mismoDestino ||
      candidatos[0] ||
      null
    );
  }

  const mismoDestino =
    all.filter(h =>
      _norm(
        h.destino ||
        h.ciudad ||
        ''
      ) === destino
    );

  return (
    mismoDestino[0] ||
    null
  );
}

function _loadHotelesInfoDesdeIndice(
  g,
  assignmentsByGrupo,
  hotelIndex
) {
  const docId =
    String(
      g.id ||
      ''
    ).trim();

  const numero =
    String(
      g.numeroNegocio ||
      ''
    ).trim();

  const encontrados = [
    ...(assignmentsByGrupo.get(docId) || []),
    ...(assignmentsByGrupo.get(numero) || [])
  ];

  const unicos =
    new Map();

  encontrados.forEach(a => {
    const key =
      String(
        a.id ||
        `${a.hotelId || ''}_${a.checkIn || ''}_${a.checkOut || ''}`
      );

    if (!unicos.has(key)) {
      unicos.set(
        key,
        a
      );
    }
  });

  const cand =
    [...unicos.values()];

  cand.sort(
    (a, b) =>
      (_toISO(a.checkIn) || '')
        .localeCompare(
          _toISO(b.checkIn) || ''
        )
  );

  return cand.map(a => {
    const H =
      _resolverHotelDocDesdeAsignacion(
        a,
        g,
        hotelIndex
      );

    return {
      ...a,

      hotel:
        H,

      hotelNombre:
        a?.hotelNombre ||
        a?.nombre ||
        H?.nombre ||
        '',

      checkIn:
        _toISO(
          a.checkIn
        ),

      checkOut:
        _toISO(
          a.checkOut
        )
    };
  });
}
// =============== VUELOS POR GRUPO (multi-esquema) ===============
const _cacheVuelosByGroup = new Map();
function _normalizeVuelo(v){
  const get = (...keys)=>{ for (const k of keys){
    const val = k.split('.').reduce((acc,p)=> (acc && acc[p]!==undefined) ? acc[p] : undefined, v);
    if (val!==undefined && val!==null && val!=='') return val;
  } return ''; };

  const tipoTransporte = (String(get('tipoTransporte')) || 'aereo').toLowerCase() || 'aereo';
  const tipoVuelo      = (tipoTransporte==='aereo')
    ? (String(get('tipoVuelo') || 'charter').toLowerCase())
    : '';

  const numero    = get('numero','nro','numVuelo','vuelo','flightNumber','codigo','code');
  const proveedor = get('proveedor','empresa','aerolinea','compania');

  const origen    = get('origen','salida.origen','salida.iata','origenIATA','origenSigla','origenCiudad');
  const destino   = get('destino','llegada.destino','llegada.iata','destinoIATA','destinoSigla','destinoCiudad');
  const fechaIda  = get('fechaIda','ida','salida.fecha','fechaSalida','fecha_ida','fecha');
  const fechaVta  = get('fechaVuelta','vuelta','regreso.fecha','fechaRegreso','fecha_vuelta');

  const presentacionIdaHora    = get('presentacionIdaHora');
  const vueloIdaHora           = get('vueloIdaHora');
  const presentacionVueltaHora = get('presentacionVueltaHora');
  const vueloVueltaHora        = get('vueloVueltaHora');

  const idaHora    = get('idaHora');
  const vueltaHora = get('vueltaHora');

  const tr = Array.isArray(v.tramos) ? v.tramos : [];
  const tramos = tr.map(t=>({
    aerolinea: String(t.aerolinea||'').toUpperCase(),
    numero:    String(t.numero||'').toUpperCase(),
    origen:    String(t.origen||'').toUpperCase(),
    destino:   String(t.destino||'').toUpperCase(),
    fechaIda:  t.fechaIda || '',
    fechaVuelta: t.fechaVuelta || '',
    presentacionIdaHora:    t.presentacionIdaHora || '',
    vueloIdaHora:           t.vueloIdaHora || '',
    presentacionVueltaHora: t.presentacionVueltaHora || '',
    vueloVueltaHora:        t.vueloVueltaHora || ''
  }));

  return {
    numero, proveedor,
    tipoTransporte, tipoVuelo,
    origen, destino, fechaIda, fechaVta,
    presentacionIdaHora, vueloIdaHora, presentacionVueltaHora, vueloVueltaHora,
    idaHora, vueltaHora,
    tramos
  };
}

// ============================================================
// VUELOS - CARGA MASIVA / ÍNDICE EN MEMORIA
// ============================================================

function _extraerClavesGrupoVuelo(v) {
  const out = new Set();

  const add = value => {
    const x =
      String(
        value ||
        ''
      ).trim();

    if (x) {
      out.add(x);
    }
  };


  // ========================================================
  // grupoIds
  // ========================================================

  if (
    Array.isArray(
      v.grupoIds
    )
  ) {
    v.grupoIds.forEach(
      add
    );
  }


  // ========================================================
  // grupos
  // ========================================================

  if (
    Array.isArray(
      v.grupos
    )
  ) {
    v.grupos.forEach(x => {
      if (
        typeof x ===
        'string'
      ) {
        add(x);

        return;
      }


      if (
        x &&
        typeof x ===
        'object'
      ) {
        add(x.id);
        add(x.grupoId);
        add(x.grupoDocId);
        add(x.numeroNegocio);
        add(x.numNegocio);
        add(x.grupoNumero);
      }
    });
  }


  // ========================================================
  // CAMPOS RAÍZ
  // ========================================================

  add(v.grupoId);
  add(v.grupoDocId);
  add(v.grupoNumero);
  add(v.numeroNegocio);
  add(v.numNegocio);


  return [
    ...out
  ];
}

async function _buildVuelosIndex(db) {
  const byGrupo =
    new Map();


  // ========================================================
  // UNA SOLA LECTURA DE TODA LA COLECCIÓN
  // ========================================================

  const snap =
    await getDocs(
      collection(
        db,
        'vuelos'
      )
    );


  snap.forEach(d => {
    const raw = {
      id:
        d.id,

      ...(
        d.data() ||
        {}
      )
    };


    const vuelo = {
      id:
        d.id,

      raw,

      normalizado:
        _normalizeVuelo(
          raw
        )
    };


    const claves =
      _extraerClavesGrupoVuelo(
        raw
      );


    claves.forEach(clave => {
      _pushMapArray(
        byGrupo,
        clave,
        vuelo
      );
    });
  });


  return byGrupo;
}

function _loadVuelosInfoDesdeIndice(
  g,
  vuelosByGrupo
) {
  const docId =
    String(
      g.id ||
      ''
    ).trim();

  const numero =
    String(
      g.numeroNegocio ||
      ''
    ).trim();


  const encontrados = [
    ...(
      vuelosByGrupo.get(
        docId
      ) ||
      []
    ),

    ...(
      vuelosByGrupo.get(
        numero
      ) ||
      []
    )
  ];


  // ========================================================
  // EVITAR DUPLICADOS
  // porque un vuelo puede estar indexado por ID y negocio
  // ========================================================

  const unicos =
    new Map();


  encontrados.forEach(item => {
    const key =
      String(
        item.id ||
        ''
      );


    if (
      key &&
      !unicos.has(
        key
      )
    ) {
      unicos.set(
        key,
        item
      );
    }
  });


  return [
    ...unicos.values()
  ].map(
    item =>
      item.normalizado
  );
}

// ------------ ÍNDICES RÁPIDOS PARA COORDINADORES ------------
async function _buildCoordIndexes(
  anoViaje = null,
  gruposPermitidos = []
) {
  // ============================================================
  // CATÁLOGO COORDINADORES
  // ============================================================

  const coordById =
    new Map();

  try {
    const snapC =
      await getDocs(
        collection(
          db,
          'coordinadores'
        )
      );

    snapC.forEach(d => {
      const x =
        d.data() ||
        {};

      coordById.set(
        d.id,
        {
          nombre:
            String(
              x.nombre ||
              ''
            ).trim(),

          correo:
            String(
              x.correo ||
              ''
            )
              .trim()
              .toLowerCase(),

          telefono:
            String(
              x.telefono ||
              x.fono ||
              x.celular ||
              ''
            ).trim()
        }
      );
    });

  } catch (e) {
    console.warn(
      'No pude leer coordinadores:',
      e
    );
  }


  // ============================================================
  // GRUPOS QUE CORRESPONDEN A LA TABLA ACTUAL
  // ============================================================

  const gruposValidos =
    new Set(
      (
        gruposPermitidos ||
        []
      )
        .map(String)
        .filter(Boolean)
    );


  // ============================================================
  // AHORA SON ARRAYS
  // ============================================================

  const coordIdsByGrupo =
    new Map();

  const estadosByGrupo =
    new Map();

  const conjuntosByGrupo =
    new Map();


  try {
    const snapSets =
      await getDocs(
        collectionGroup(
          db,
          'conjuntos'
        )
      );

    snapSets.forEach(s => {
      const coordId =
        s.ref.parent.parent.id;

      const x =
        s.data() ||
        {};

      const anoConjunto =
        Number(
          x.anoViaje
        ) ||
        null;

      if (
        anoViaje !== null &&
        anoConjunto &&
        Number(anoConjunto) !==
          Number(anoViaje)
      ) {
        return;
      }


      const estado =
        String(
          x.estadoCoord ||
          'pendiente'
        )
          .trim()
          .toLowerCase();


      (
        Array.isArray(x.viajes)
          ? x.viajes
          : []
      ).forEach(rawGid => {
        const gid =
          String(
            rawGid
          );

        if (
          gruposValidos.size &&
          !gruposValidos.has(gid)
        ) {
          return;
        }


        if (
          !coordIdsByGrupo.has(
            gid
          )
        ) {
          coordIdsByGrupo.set(
            gid,
            []
          );
        }


        if (
          !estadosByGrupo.has(
            gid
          )
        ) {
          estadosByGrupo.set(
            gid,
            []
          );
        }


        if (
          !conjuntosByGrupo.has(
            gid
          )
        ) {
          conjuntosByGrupo.set(
            gid,
            []
          );
        }


        const ids =
          coordIdsByGrupo.get(
            gid
          );

        // Un mismo coordinador sólo puede
        // cubrir un cupo del mismo grupo.
        if (
          !ids.includes(
            coordId
          )
        ) {
          ids.push(
            coordId
          );

          estadosByGrupo
            .get(gid)
            .push(
              estado
            );

          conjuntosByGrupo
            .get(gid)
            .push(
              s.id
            );
        }
      });
    });

  } catch (e) {
    console.warn(
      'No pude leer conjuntos:',
      e
    );
  }


  return {
    coordById,
    coordIdsByGrupo,
    estadosByGrupo,
    conjuntosByGrupo
  };
}

function resolverEstadoCoordinadoresGrupo(
  estados = []
) {
  const arr =
    (
      estados ||
      []
    )
      .map(x =>
        String(
          x ||
          'pendiente'
        ).toLowerCase()
      );


  if (!arr.length) {
    return 'pendiente';
  }

  // Si cualquiera fue rechazado,
  // mostramos el grupo en rojo.
  if (
    arr.includes(
      'rechazado'
    )
  ) {
    return 'rechazado';
  }

  // Sólo queda completamente aprobado
  // cuando TODOS aprobaron.
  if (
    arr.every(
      x =>
        x === 'aprobado'
    )
  ) {
    return 'aprobado';
  }

  return 'pendiente';
}

function setCarga(porcentaje, titulo, detalle = '') {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('ok', 'error');
  box.style.display = 'block';

  bar.style.width = `${Math.max(0, Math.min(100, porcentaje))}%`;
  title.textContent = titulo;
  detail.textContent = detalle;
}

function setCargaOk(detalle = 'Datos cargados correctamente.') {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('error');
  box.classList.add('ok');
  bar.style.width = '100%';
  title.textContent = 'Listo';
  detail.textContent = detalle;
}

function setCargaError(error) {
  const box = document.getElementById('loadBox');
  const bar = document.getElementById('loadProgress');
  const title = document.getElementById('loadTitle');
  const detail = document.getElementById('loadDetail');

  if (!box || !bar || !title || !detail) return;

  box.classList.remove('ok');
  box.classList.add('error');
  bar.style.width = '100%';
  title.textContent = 'Error al cargar';
  detail.textContent = error?.message || String(error) || 'Error desconocido. Revisa la consola.';
}

function registrarCambioPendiente(cambio) {
  const key = `${cambio.docId}__${cambio.campo}`;

  const existente = cambiosPendientes.find(c => c.key === key);

  if (existente) {
    existente.nuevoDisplay = cambio.nuevoDisplay;
    existente.nuevoValorFirestore = cambio.nuevoValorFirestore;
    existente.td = cambio.td;
  } else {
    cambiosPendientes.push({
      key,
      ...cambio,
      identificador: cambio.identificador || '',
      nombreGrupo: cambio.nombreGrupo || ''
    });
  }
}

function resumenCambiosPendientes() {
  if (!cambiosPendientes.length) return 'No hay cambios pendientes.';

  return cambiosPendientes
    .map((c, i) => {
      return `${i + 1}) Negocio ${c.numeroNegocio} | ${c.campo}: "${c.anteriorDisplay}" → "${c.nuevoDisplay}"`;
    })
    .join('\n');
}

async function guardarCambiosPendientes() {
  const paxOk = validarTodasLasFilasPax();

  if (!paxOk) {
    throw new Error(
      'Hay filas donde PAX no coincide con Adultos + Estudiantes. ' +
      'Corrige esas filas antes de guardar.'
    );
  }

  const hayCambiosPax = cambiosPendientes.some(c =>
    c.campo === 'cantidadgrupo' ||
    c.campo === 'adultos' ||
    c.campo === 'estudiantes'
  );

  if (hayCambiosPax) {
    const clave = window.prompt(
      '⚠️ Hay cambios en PAX / ADULTOS / ESTUDIANTES. ' +
      'Ingresa la clave para guardar:'
    );

    if (clave !== PAX_PASSWORD) {
      throw new Error(
        'Clave incorrecta. No se guardaron los cambios.'
      );
    }
  }

  // =====================================================
  // 1. Agrupar cambios por documento
  // =====================================================
  const cambiosPorGrupo = new Map();

  cambiosPendientes.forEach(c => {
    if (!cambiosPorGrupo.has(c.docId)) {
      cambiosPorGrupo.set(c.docId, []);
    }

    cambiosPorGrupo.get(c.docId).push(c);
  });

  // =====================================================
  // 2. Validar ANTES de escribir en Firestore
  // =====================================================
  for (const [docId, cambiosGrupo] of cambiosPorGrupo.entries()) {
    const cambiaInicio = cambiosGrupo.some(
      c => c.campo === 'fechaInicio'
    );

    const cambiaFin = cambiosGrupo.some(
      c => c.campo === 'fechaFin'
    );

    if (!cambiaInicio && !cambiaFin) continue;

    const ref = doc(db, 'grupos', docId);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      throw new Error(`No existe el grupo ${docId}.`);
    }

    const g = snap.data() || {};

    let fechaInicioFinal = g.fechaInicio;
    let fechaFinFinal = g.fechaFin;

    const cambioInicio = cambiosGrupo.find(
      c => c.campo === 'fechaInicio'
    );

    const cambioFin = cambiosGrupo.find(
      c => c.campo === 'fechaFin'
    );

    if (cambioInicio) {
      fechaInicioFinal = cambioInicio.nuevoValorFirestore;
    }

    if (cambioFin) {
      fechaFinFinal = cambioFin.nuevoValorFirestore;
    }

    const fechasEsperadas = crearRangoFechasISO(
      fechaInicioFinal,
      fechaFinFinal
    );

    if (!fechasEsperadas.length) {
      throw new Error(
        `El nuevo rango de fechas del grupo ${g.numeroNegocio || docId} no es válido.`
      );
    }

    const itinerarioActual = g.itinerario || {};
    const cantidadDiasActual =
      Object.keys(itinerarioActual).length;

    if (
      cantidadDiasActual > 0 &&
      fechasEsperadas.length < cantidadDiasActual
    ) {
      throw new Error(
        `No se guardaron los cambios del grupo ${g.numeroNegocio || docId}.\n\n` +
        `El itinerario tiene ${cantidadDiasActual} días, pero las nuevas fechas solamente cubren ${fechasEsperadas.length} días.\n\n` +
        'La operación fue bloqueada para evitar eliminar actividades.'
      );
    }
  }

  // =====================================================
  // 3. Después de validar todo, guardar cambios
  // =====================================================
  const gruposConFechaEditada = new Set();

  for (const c of cambiosPendientes) {
    await updateDoc(doc(db, 'grupos', c.docId), {
      [c.campo]: c.nuevoValorFirestore
    });

    if (
      c.campo === 'fechaInicio' ||
      c.campo === 'fechaFin'
    ) {
      gruposConFechaEditada.add(c.docId);
    }

    await addDoc(collection(db, 'historial'), {
      numeroNegocio: c.numeroNegocio,
      nombreGrupo: c.nombreGrupo || '',
      campo: c.campo,
      anterior: c.anteriorDisplay ?? '',
      nuevo: c.nuevoDisplay ?? '',
      modificadoPor: auth.currentUser?.email || '',
      timestamp: new Date()
    });

    if (c.td) {
      $(c.td)
        .text(c.nuevoDisplay)
        .attr('data-original', c.nuevoValorFirestore);
    }
  }

  // =====================================================
  // 4. Sincronizar solamente después de guardar
  // =====================================================
  for (const docId of gruposConFechaEditada) {
    await sincronizarFechasEItinerarioGrupo(docId);
  }

  cambiosPendientes = [];
}

function descartarCambiosPendientes() {
  cambiosPendientes.forEach(c => {
    if (c.td) {
      $(c.td)
        .text(c.anteriorDisplay)
        .attr('data-original', c.anteriorDisplay);
    }
  });

  cambiosPendientes = [];
}

function mostrarModalCambios() {
  const $tb = $('#tablaCambiosPendientes');
  $tb.empty();

  cambiosPendientes.forEach(c => {
    $tb.append(`
      <tr>
        <td>${c.numeroNegocio}</td>
        <td>${c.identificador}</td>
        <td>${c.nombreGrupo}</td>
        <td>${c.campo}</td>
        <td>${c.anteriorDisplay}</td>
        <td>${c.nuevoDisplay}</td>
      </tr>
    `);
  });

  $('#modalConfirmarCambios').css('display', 'flex');
}

async function cargarYMostrarTabla(
  filtroAnoCarga = 'actual'
) {
  try {
    setCarga(
      5,
      'Cargando grupos...',
      'Leyendo colección grupos'
    );


    // =====================================================
    // 1) CARGAR GRUPOS POR AÑO
    // =====================================================

    const anoResuelto =
      resolverAnoFiltro(
        filtroAnoCarga
      );


    let docsGrupos =
      [];


    if (
      anoResuelto ===
      'todos'
    ) {
      const snap =
        await getDocs(
          collection(
            db,
            'grupos'
          )
        );

      docsGrupos =
        snap.docs;

    } else {
      const [
        snapTexto,
        snapNumero
      ] =
        await Promise.all([
          getDocs(
            query(
              collection(
                db,
                'grupos'
              ),
              where(
                'anoViaje',
                '==',
                String(
                  anoResuelto
                )
              )
            )
          ),

          getDocs(
            query(
              collection(
                db,
                'grupos'
              ),
              where(
                'anoViaje',
                '==',
                Number(
                  anoResuelto
                )
              )
            )
          )
        ]);


      const mapa =
        new Map();


      snapTexto.docs.forEach(
        d =>
          mapa.set(
            d.id,
            d
          )
      );


      snapNumero.docs.forEach(
        d =>
          mapa.set(
            d.id,
            d
          )
      );


      docsGrupos =
        Array.from(
          mapa.values()
        );
    }


    if (
      !docsGrupos.length
    ) {
      console.warn(
        'No hay grupos para el filtro:',
        filtroAnoCarga
      );


      $('#tablaGrupos tbody')
        .empty();


      setCargaOk(
        `No hay grupos para el filtro seleccionado: ${filtroAnoCarga}`
      );


      return;
    }


    setCarga(
      15,
      'Grupos cargados',
      `${docsGrupos.length} grupos encontrados`
    );


    // =====================================================
    // 2) ÍNDICES COORDINADORES
    // =====================================================

    setCarga(
      25,
      'Cargando coordinadores...',
      'Leyendo coordinadores y conjuntos'
    );


    const {
      coordById,
      coordIdsByGrupo,
      estadosByGrupo,
      conjuntosByGrupo
    } =
      await _buildCoordIndexes(
        anoResuelto === 'todos'
          ? null
          : Number(
              anoResuelto
            ),

        docsGrupos.map(
          d =>
            String(
              d.id
            )
        )
      );


    setCarga(
      35,
      'Coordinadores cargados',
      'Preparando tabla principal'
    );


    // =====================================================
    // 3) MAPEAR DATOS DE TABLA
    // =====================================================

    const valores =
      docsGrupos.map(
        docSnap => {
          const d =
            docSnap.data() ||
            {};


          // =============================================
          // COORDINADORES GUARDADOS EN EL GRUPO
          // =============================================

          const idsGuardados =
            Array.isArray(
              d.coordinadorIds
            )
              ? d.coordinadorIds
                  .map(String)
                  .filter(Boolean)
              : (
                  d.coordinadorId
                    ? [
                        String(
                          d.coordinadorId
                        )
                      ]
                    : []
                );


          // =============================================
          // COORDINADORES DESDE CONJUNTOS
          // =============================================

          const idsDesdeConjuntos =
            coordIdsByGrupo.get(
              docSnap.id
            ) ||
            [];


          const coordIds =
            [
              ...new Set([
                ...idsGuardados,
                ...idsDesdeConjuntos
              ])
            ];


          const coordInfos =
            coordIds.map(
              id => ({
                id,
                ...(
                  coordById.get(id) ||
                  {}
                )
              })
            );


          const nombresGuardados =
            Array.isArray(
              d.coordinadores
            )
              ? d.coordinadores
              : (
                  d.coordinador
                    ? [
                        d.coordinador
                      ]
                    : []
                );


          const nombres =
            coordInfos
              .map(
                c =>
                  String(
                    c.nombre ||
                    ''
                  ).trim()
              )
              .filter(Boolean);


          const coordTexto =
            (
              nombres.length
                ? nombres
                : nombresGuardados
            )
              .filter(Boolean)
              .join(
                ' / '
              );


          const coordTelefono =
            coordInfos
              .map(
                c =>
                  String(
                    c.telefono ||
                    ''
                  ).trim()
              )
              .filter(Boolean)
              .join(
                ' / '
              );


          const estados =
            Array.isArray(
              d.coordinadoresAsignados
            )
              ? d.coordinadoresAsignados
                  .map(
                    x =>
                      x?.estadoCoord ||
                      'pendiente'
                  )
              : (
                  estadosByGrupo.get(
                    docSnap.id
                  ) ||
                  (
                    d.coordEstado
                      ? [
                          d.coordEstado
                        ]
                      : []
                  )
                );


          const estadoCoord =
            resolverEstadoCoordinadoresGrupo(
              estados
            );


          const cantidadCoordinadores =
            normalizarCantidadCoordinadores(
              d.cantidadCoordinadores
            );


          return {
            id:
              docSnap.id,

            fila:
              camposFire.map(
                c => {
                  if (
                    c ===
                    'cantidadCoordinadores'
                  ) {
                    return cantidadCoordinadores;
                  }

                  return (
                    d[c] ??
                    ''
                  );
                }
              ),

            coordTexto,

            coordTelefono,

            coordIds,

            estadoCoord,

            cantidadCoordinadores,

            coordinadoresAsignados:
              coordIds.length,

            fechasConfirmadasDesdeHoteles:
              !!d.fechasConfirmadasDesdeHoteles
          };
        }
      );


    // =====================================================
    // 4) GRUPOS_RAW
    // =====================================================

    GRUPOS_RAW =
      docsGrupos.map(
        s => {
          const d =
            s.data() ||
            {};


          return {
            _id:
              s.id,

            numeroNegocio:
              d.numeroNegocio ??
              '',

            identificador:
              d.identificador ??
              '',

            nombreGrupo:
              d.nombreGrupo ??
              '',

            anoViaje:
              d.anoViaje ??
              '',

            vendedora:
              d.vendedora ??
              '',

            cantidadCoordinadores:
              normalizarCantidadCoordinadores(
                d.cantidadCoordinadores
              ),

            cantidadgrupo:
              toNum(
                d.cantidadgrupo
              ),

            adultos:
              toNum(
                d.adultos
              ),

            estudiantes:
              toNum(
                d.estudiantes
              ),

            colegio:
              d.colegio ??
              '',

            curso:
              d.curso ??
              '',

            destino:
              d.destino ??
              '',

            programa:
              d.programa ??
              '',

            fechaInicio:
              parseFechaPosible(
                d.fechaInicio
              ),

            fechaFin:
              parseFechaPosible(
                d.fechaFin
              ),

            hoteles:
              d.hoteles ??
              '',

            transporte:
              d.transporte ??
              ''
          };
        }
      );


    // =====================================================
    // 5) MIRROR PARA LOOKUPS
    // =====================================================

    const gruposParaLookup =
      docsGrupos.map(
        s => {
          const d =
            s.data() ||
            {};


          return {
            id:
              s.id,

            numeroNegocio:
              String(
                d.numeroNegocio ??
                d.numNegocio ??
                d.idNegocio ??
                s.id
              ),

            destino:
              d.destino ??
              '',

            fechaInicio:
              _toISO(
                d.fechaInicio
              ),

            fechaFin:
              _toISO(
                d.fechaFin
              ),

            coordinadorEmail:
              d.coordinadorEmail,

            coordinador:
              d.coordinador,

            coordinadoresEmails:
              d.coordinadoresEmails,

            coordinadoresEmailsObj:
              d.coordinadoresEmailsObj,

            coordinadores:
              d.coordinadores
          };
        }
      );


    // =====================================================
    // =====================================================
    // 6) ENRIQUECER HOTELES / VUELOS
    //    CARGA MASIVA
    // =====================================================

    setCarga(
      40,
      'Cargando información operacional...',
      'Leyendo hoteles, asignaciones y vuelos una sola vez'
    );


    // =====================================================
    // LEER COLECCIONES UNA SOLA VEZ
    // =====================================================

    const [
      hotelIndex,
      hotelAssignmentsByGrupo,
      vuelosByGrupo
    ] =
      await Promise.all([
        _ensureHotelesIndex(
          db
        ),

        _buildHotelesAssignmentsIndex(
          db
        ),

        _buildVuelosIndex(
          db
        )
      ]);


    setCarga(
      60,
      'Enriqueciendo información...',
      `Procesando ${valores.length} grupos en memoria`
    );


    // =====================================================
    // YA NO HAY CONSULTAS FIRESTORE DENTRO DE ESTE LOOP
    // =====================================================

    for (
      let idx = 0;
      idx < valores.length;
      idx++
    ) {
      const item =
        valores[idx];


      const fila =
        item.fila;


      const g =
        gruposParaLookup[idx];


      // ===================================================
      // HOTELES
      // fila[17]
      // ===================================================

      try {
        const hoteles =
          _loadHotelesInfoDesdeIndice(
            g,
            hotelAssignmentsByGrupo,
            hotelIndex
          );


        if (
          hoteles &&
          hoteles.length
        ) {
          const txt =
            hoteles
              .map(h => {
                const name =
                  String(
                    h.hotelNombre ||
                    ''
                  )
                    .toUpperCase();


                const ci =
                  _dmy(
                    _toISO(
                      h.checkIn
                    )
                  );


                const co =
                  _dmy(
                    _toISO(
                      h.checkOut
                    )
                  );


                return (
                  `${name}` +
                  `${
                    ci ||
                    co
                      ? ` (${ci} → ${co})`
                      : ''
                  }`
                );
              })
              .join(
                ' · '
              );


          fila[17] =
            txt ||
            fila[17];


          const graw =
            GRUPOS_RAW[idx];


          if (graw) {
            graw.hoteles =
              txt;
          }
        }

      } catch (e) {
        console.warn(
          'Error procesando hoteles:',
          g.id,
          e
        );
      }


      // ===================================================
      // VUELOS / TRANSPORTE
      //
      // transporte = fila[19]
      // tramos     = fila[20]
      // ===================================================

      try {
        const vuelos =
          _loadVuelosInfoDesdeIndice(
            g,
            vuelosByGrupo
          );


        if (
          vuelos &&
          vuelos.length
        ) {
          const v0 =
            vuelos[0];


          const isAereo =
            (
              v0.tipoTransporte ||
              'aereo'
            ) ===
            'aereo';


          if (isAereo) {
            const tipo =
              (
                v0.tipoVuelo ||
                ''
              )
                .toUpperCase();


            const nro =
              (
                v0.numero ||
                ''
              )
                .toString()
                .toUpperCase();


            const ida =
              _dmy(
                _toISO(
                  v0.fechaIda
                )
              );


            const vta =
              _dmy(
                _toISO(
                  v0.fechaVta
                )
              );


            const lIda =
              (
                v0.presentacionIdaHora ||
                v0.vueloIdaHora
              )
                ? ` · IDA: ${
                    v0.presentacionIdaHora
                      ? (
                          'PRES ' +
                          v0.presentacionIdaHora
                        )
                      : ''
                  }${
                    v0.vueloIdaHora
                      ? (
                          (
                            v0.presentacionIdaHora
                              ? ' · '
                              : ''
                          ) +
                          'VUELO ' +
                          v0.vueloIdaHora
                        )
                      : ''
                  }`
                : '';


            const lVta =
              (
                v0.presentacionVueltaHora ||
                v0.vueloVueltaHora
              )
                ? ` · VUELTA: ${
                    v0.presentacionVueltaHora
                      ? (
                          'PRES ' +
                          v0.presentacionVueltaHora
                        )
                      : ''
                  }${
                    v0.vueloVueltaHora
                      ? (
                          (
                            v0.presentacionVueltaHora
                              ? ' · '
                              : ''
                          ) +
                          'VUELO ' +
                          v0.vueloVueltaHora
                        )
                      : ''
                  }`
                : '';


            fila[19] =
              (
                `AÉREO` +
                `${
                  tipo
                    ? (
                        ' · ' +
                        tipo
                      )
                    : ''
                }` +
                `${
                  nro
                    ? (
                        ' · ' +
                        nro
                      )
                    : ''
                }` +
                ` · ${ida || '—'} → ${vta || '—'}` +
                lIda +
                lVta
              ).trim();


            fila[20] =
              Array.isArray(
                v0.tramos
              ) &&
              v0.tramos.length
                ? `${v0.tramos.length} TRAMO(S)`
                : (
                    fila[20] ||
                    ''
                  );


          } else {
            const idaH =
              v0.idaHora ||
              '';


            const vtaH =
              v0.vueltaHora ||
              '';


            fila[19] =
              `TERRESTRE (BUS)` +
              `${
                idaH ||
                vtaH
                  ? ` · SALIDA: ${idaH || '—'} · REGRESO: ${vtaH || '—'}`
                  : ''
              }`;


            fila[20] =
              fila[20] ||
              '';
          }


          const graw =
            GRUPOS_RAW[idx];


          if (graw) {
            graw.transporte =
              fila[19];
          }
        }

      } catch (e) {
        console.warn(
          'Error procesando vuelos:',
          g.id,
          e
        );
      }


      // ===================================================
      // ACTUALIZAR BARRA VISUAL
      // ===================================================

      if (
        idx % 20 === 0 ||
        idx === valores.length - 1
      ) {
        const avance =
          60 +
          Math.round(
            (
              (idx + 1) /
              Math.max(
                valores.length,
                1
              )
            ) *
            15
          );


        setCarga(
          avance,
          'Enriqueciendo información...',
          `Procesados ${idx + 1} de ${valores.length} grupos`
        );
      }
    }


    // =====================================================
    // 7) FILTROS
    // =====================================================

    setCarga(
      80,
      'Construyendo filtros...',
      'Preparando destino, año y transporte'
    );


    const destinosUnicos =
      new Set();

    const transportesUnicos =
      new Set();


    valores.forEach(
      item => {
        const fila =
          item.fila;


        if (
          fila[11]
        ) {
          destinosUnicos.add(
            fila[11]
          );
        }


        if (
          fila[19]
        ) {
          transportesUnicos.add(
            fila[19]
          );
        }
      }
    );


    const destinos =
      Array.from(
        destinosUnicos
      ).sort();


    const transportes =
      Array.from(
        transportesUnicos
      ).sort();


    const $filtroDestino =
      $('#filtroDestino')
        .empty()
        .append(
          '<option value="">Todos</option>'
        );


    destinos.forEach(
      d =>
        $filtroDestino.append(
          `<option value="${d}">${d}</option>`
        )
    );


    $('#filtroAno')
      .val(
        filtroAnoCarga
      );


    const $filtroTransporte =
      $('#filter-transporte')
        .empty()
        .append(
          '<option value="">Todos</option>'
        );


    transportes.forEach(
      t =>
        $filtroTransporte.append(
          `<option value="${t}">${t}</option>`
        )
    );


    // =====================================================
    // 8) RENDER TABLA
    // =====================================================

    const $tb =
      $('#tablaGrupos tbody')
        .empty();


    valores.forEach(
      item => {
        const $tr =
          $('<tr>');


        // columnas Firestore 0..4
        for (
          let idx = 0;
          idx <= 4;
          idx++
        ) {
          const campo =
            camposFire[idx];

          const celda =
            item.fila[idx];


          const $td =
            $('<td>')
              .text(
                formatearCelda(
                  celda,
                  campo
                )
              )
              .attr(
                'data-doc-id',
                item.id
              )
              .attr(
                'data-campo',
                campo
              )
              .attr(
                'data-original',
                celda
              );


          if (
            NUMERIC_FIELDS.has(
              campo
            )
          ) {
            $td.attr(
              'data-tipo',
              'number'
            );
          }


          $tr.append(
            $td
          );
        }


        // ===============================================
        // COORDINADORES
        // tabla col 5
        // ===============================================

        const coordText =
          (
            item.coordTexto ||
            ''
          )
            .toString()
            .toUpperCase();


        const est =
          item.estadoCoord ||
          'pendiente';


        const $tdCoord =
          $('<td>')
            .text(
              coordText
            )
            .attr(
              'data-doc-id',
              item.id
            )
            .attr(
              'data-fixed',
              '1'
            )
            .attr(
              'data-campo',
              ''
            )
            .attr(
              'data-original',
              coordText
            )
            .attr(
              'title',
              'Estado: ' +
              est.toUpperCase()
            )
            .attr(
              'style',
              _bgEstado(
                est
              )
            );


        $tr.append(
          $tdCoord
        );


        // ===============================================
        // TELÉFONOS
        // tabla col 6
        // ===============================================

        const telText =
          (
            item.coordTelefono ||
            ''
          )
            .toString()
            .trim();


        const $tdTel =
          $('<td>')
            .text(
              telText
            )
            .attr(
              'data-doc-id',
              item.id
            )
            .attr(
              'data-fixed',
              '1'
            )
            .attr(
              'data-campo',
              ''
            )
            .attr(
              'data-original',
              telText
            )
            .attr(
              'title',
              'Teléfono coordinador'
            );


        $tr.append(
          $tdTel
        );


        // ===============================================
        // resto campos Firestore 5..24
        // ===============================================

        for (
          let idx = 5;
          idx < camposFire.length;
          idx++
        ) {
          const campo =
            camposFire[idx];

          const celda =
            item.fila[idx];


          const $td =
            $('<td>')
              .text(
                formatearCelda(
                  celda,
                  campo
                )
              )
              .attr(
                'data-doc-id',
                item.id
              )
              .attr(
                'data-campo',
                campo
              )
              .attr(
                'data-original',
                celda
              );


          if (
            NUMERIC_FIELDS.has(
              campo
            )
          ) {
            $td.attr(
              'data-tipo',
              'number'
            );
          }


          if (
            campo ===
              'fechaInicio' ||
            campo ===
              'fechaFin'
          ) {
            const estadoFechaHotel =
              item.fechasConfirmadasDesdeHoteles
                ? 'aprobado'
                : 'pendiente';


            $td
              .attr(
                'title',
                item.fechasConfirmadasDesdeHoteles
                  ? 'Fechas confirmadas desde hotelería'
                  : 'Fechas pendientes de confirmación hotelera'
              )
              .attr(
                'style',
                _bgEstado(
                  estadoFechaHotel
                )
              );
          }


          $tr.append(
            $td
          );
        }


        $tb.append(
          $tr
        );


        validarFilaPax(
          $tr
        );
      }
    );


    // =====================================================
    // 9) DATATABLE
    // =====================================================

    setCarga(
      90,
      'Renderizando tabla...',
      'Inicializando DataTable'
    );


    const tabla =
      $('#tablaGrupos')
        .DataTable({
          language: {
            url:
              'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
          },

          dom:
            'Brtip',

          buttons: [
            {
              extend:
                'colvis',

              text:
                'Ver columnas',

              className:
                'dt-button',

              columns:
                ':gt(0)'
            }
          ],

          pageLength:
            -1,

          lengthChange:
            false,

          order: [
            [13, 'desc'],
            [14, 'desc'],
            [15, 'desc'],
            [1, 'desc']
          ],

          scrollX:
            true,

          scrollY:
            'calc(100vh - 360px)',

          scrollCollapse:
            false,

          autoWidth:
            true,

          fixedHeader:
            false,

          columnDefs: [
            {
              targets: [
                11,
                12,
                17,
                18,
                20,
                22,
                25,
                26
              ],

              visible:
                false
            },

            {
              targets: [
                7,
                8,
                9,
                10
              ],

              type:
                'num',

              className:
                'dt-body-right'
            },

            {
              targets:
                '_all',

              className:
                'dt-nowrap'
            }
          ]
        });


    tablaGruposDT =
      tabla;


    tabla
      .buttons()
      .container()
      .appendTo(
        '#toolbar'
      );


    setTimeout(
      () => {
        const $wrapper =
          $('#tablaGrupos')
            .closest(
              '.dataTables_wrapper'
            );


        tabla
          .columns
          .adjust()
          .draw(
            false
          );


        $wrapper
          .find(
            '.dataTables_scrollBody'
          )
          .scrollLeft(
            0
          );
      },
      300
    );


    // =====================================================
    // 10) FILTRO ESPECIAL
    // =====================================================

    const BUSQ_ESPECIAL = {
      activo:
        false,

      termino:
        ''
    };


    $.fn.dataTable.ext.search.push(
      function (
        settings,
        rowData
      ) {
        if (
          settings.nTable.id !==
          'tablaGrupos'
        ) {
          return true;
        }


        // Transporte = columna 21
        const trans =
          (
            rowData[21] ||
            ''
          ).toString();


        if (
          FLT_FILTER.tipo ===
            'charter' ||
          FLT_FILTER.tipo ===
            'regular'
        ) {
          const target =
            FLT_FILTER.tipo
              .toUpperCase();


          if (
            !trans
              .toUpperCase()
              .includes(
                target
              )
          ) {
            return false;
          }
        }


        if (
          FLT_FILTER.fechaIda
        ) {
          const [
            yyyy,
            mm,
            dd
          ] =
            FLT_FILTER.fechaIda
              .split(
                '-'
              );


          const dmy =
            `${dd}-${mm}-${yyyy}`;


          if (
            !trans.includes(
              dmy
            )
          ) {
            return false;
          }
        }


        if (
          !BUSQ_ESPECIAL.activo
        ) {
          return true;
        }


        const coordTxt =
          (
            rowData[5] ||
            ''
          )
            .trim();


        const term =
          BUSQ_ESPECIAL.termino
            .toLowerCase();


        if (!term) {
          return (
            coordTxt ===
            ''
          );
        }


        const rowText =
          rowData
            .join(
              ' '
            )
            .toLowerCase();


        return (
          rowText.includes(
            term
          ) ||
          coordTxt ===
            ''
        );
      }
    );


    // =====================================================
    // 11) BUSCADOR
    // =====================================================

    $('#buscador')
      .off(
        'input.grupos'
      )
      .on(
        'input.grupos',
        function () {
          const raw =
            String(
              this.value ||
              ''
            );


          if (
            raw.includes(
              ','
            )
          ) {
            BUSQ_ESPECIAL.activo =
              true;


            BUSQ_ESPECIAL.termino =
              raw
                .split(
                  ','
                )[0]
                .trim();


            tabla.search(
              ''
            );

          } else {
            BUSQ_ESPECIAL.activo =
              false;

            BUSQ_ESPECIAL.termino =
              '';

            tabla.search(
              raw
            );
          }


          tabla.draw();
        }
      );


    // =====================================================
    // 12) FILTRO DESTINO
    // columna DataTable 13
    // =====================================================

    $('#filtroDestino')
      .off(
        'change.grupos'
      )
      .on(
        'change.grupos',
        function () {
          tabla
            .column(
              13
            )
            .search(
              this.value
            )
            .draw();
        }
      );


    // =====================================================
    // 13) FILTRO AÑO
    // =====================================================

    $('#filtroAno')
      .off(
        'change.grupos'
      )
      .on(
        'change.grupos',
        async function () {
          const valor =
            this.value ||
            'actual';


          try{
            if (
              $.fn.DataTable.isDataTable(
                '#tablaGrupos'
              )
            ) {
              $('#tablaGrupos')
                .DataTable()
                .destroy();
            }


            $('#tablaGrupos tbody')
              .empty();


            await cargarYMostrarTabla(
              valor
            );

          }catch(err){
            console.error(
              'Error recargando por año:',
              err
            );


            alert(
              'Error al cargar grupos del año seleccionado.'
            );
          }
        }
      );


    // =====================================================
    // 14) FILTRO TIPO VUELO
    // =====================================================

    $('#filter-tipoVuelo')
      .off(
        'change.grupos'
      )
      .on(
        'change.grupos',
        function () {
          const v =
            this.value ||
            'all';


          FLT_FILTER.tipo =
            (
              v ===
                'charter' ||
              v ===
                'regular'
            )
              ? v
              : 'all';


          tabla.draw();
        }
      );


    // =====================================================
    // 15) FILTRO FECHA IDA
    // =====================================================

    $('#filter-fechaIda')
      .off(
        'change.grupos'
      )
      .on(
        'change.grupos',
        function () {
          FLT_FILTER.fechaIda =
            this.value ||
            '';


          tabla.draw();
        }
      );


    // =====================================================
    // 16) FILTRO TRANSPORTE
    // columna DataTable 21
    // =====================================================

    $('#filter-transporte')
      .off(
        'change.grupos'
      )
      .on(
        'change.grupos',
        function () {
          const val =
            this.value ||
            '';


          if (!val) {
            tabla
              .column(
                21
              )
              .search(
                '',
                true,
                false
              )
              .draw();

            return;
          }


          const escaped =
            $.fn.dataTable.util
              .escapeRegex(
                val
              );


          tabla
            .column(
              21
            )
            .search(
              '^' +
              escaped +
              '$',
              true,
              false
            )
            .draw();
        }
      );


    // =====================================================
    // 17) REVISIÓN PAX
    // =====================================================

    $('#btn-revisar-pax-pagos')
      .off(
        'click.grupos'
      )
      .on(
        'click.grupos',
        async () => {
          await revisarPaxGruposContraPagos();
        }
      );


    $('#btnCerrarRevisionPaxPagos')
      .off(
        'click.grupos'
      )
      .on(
        'click.grupos',
        () => {
          $('#modalRevisionPaxPagos')
            .hide();
        }
      );


    // =====================================================
    // 18) CAMPOS FECHA
    // =====================================================

    const DATE_FIELDS =
      new Set([
        'fechaInicio',
        'fechaFin',
        'fechaDeViaje',
        'fechaCreacion'
      ]);


    function timestampToInputDate(
      valor
    ) {
      if (!valor) {
        return '';
      }


      if (
        valor instanceof
        Timestamp
      ) {
        return toInputDate(
          valor.toDate()
        );
      }


      if (
        valor?.toDate
      ) {
        return toInputDate(
          valor.toDate()
        );
      }


      if (
        valor instanceof
        Date
      ) {
        return toInputDate(
          valor
        );
      }


      const parsed =
        parseFechaPosible(
          valor
        );


      return (
        parsed
          ? toInputDate(
              parsed
            )
          : ''
      );
    }


    function inputDateToDisplay(
      value
    ) {
      if (!value) {
        return '';
      }


      const [
        yyyy,
        mm,
        dd
      ] =
        value.split(
          '-'
        );


      return (
        `${dd}-${mm}-${yyyy}`
      );
    }


    function inputDateToTimestamp(
      value
    ) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          value
        )
      ) {
        throw new Error(
          'Fecha inválida.'
        );
      }


      return Timestamp.fromDate(
        new Date(
          value +
          'T00:00:00'
        )
      );
    }


    // =====================================================
    // 19) EDITAR FECHAS
    // =====================================================

    $('#tablaGrupos tbody')
      .off(
        'click.fechaGrupo',
        'td[data-campo]'
      )
      .on(
        'click.fechaGrupo',
        'td[data-campo]',
        function () {
          if (!editMode) {
            return;
          }


          const $td =
            $(this);


          const campo =
            $td.attr(
              'data-campo'
            );


          if (
            !DATE_FIELDS.has(
              campo
            )
          ) {
            return;
          }


          if (
            $td.find(
              'input[type="date"]'
            ).length
          ) {
            return;
          }


          const valorOriginal =
            $td.attr(
              'data-original'
            );


          const fechaInput =
            timestampToInputDate(
              valorOriginal ||
              $td.text().trim()
            );


          const $input =
            $('<input type="date">')
              .val(
                fechaInput
              )
              .css({
                width:
                  '130px',

                border:
                  '1px solid #7c3aed',

                padding:
                  '4px',

                borderRadius:
                  '6px'
              });


          $td
            .empty()
            .append(
              $input
            );


          $input.trigger(
            'focus'
          );


          $input.on(
            'change blur',
            function () {
              const value =
                this.value;


              if (!value) {
                $td.text(
                  formatearCelda(
                    valorOriginal,
                    campo
                  )
                );

                return;
              }


              const docId =
                $td.attr(
                  'data-doc-id'
                );


              const nuevoValor =
                inputDateToTimestamp(
                  value
                );


              const displayText =
                inputDateToDisplay(
                  value
                );


              registrarCambioPendiente({
                docId,

                numeroNegocio:
                  $td
                    .closest('tr')
                    .find('td')
                    .eq(0)
                    .text()
                    .trim(),

                campo,

                anteriorDisplay:
                  formatearCelda(
                    valorOriginal,
                    campo
                  ),

                nuevoDisplay:
                  displayText,

                nuevoValorFirestore:
                  nuevoValor,

                identificador:
                  $td
                    .closest('tr')
                    .find('td')
                    .eq(1)
                    .text()
                    .trim(),

                nombreGrupo:
                  $td
                    .closest('tr')
                    .find('td')
                    .eq(2)
                    .text()
                    .trim(),

                td:
                  $td[0]
              });


              $td.text(
                displayText
              );
            }
          );
        }
      );


    // =====================================================
    // 20) EDICIÓN INLINE
    // =====================================================

    $('#tablaGrupos tbody')
      .off(
        'focusout.edicionGrupo',
        'td[contenteditable]'
      )
      .on(
        'focusout.edicionGrupo',
        'td[contenteditable]',
        function () {
          const $td =
            $(this);


          const campo =
            $td.attr(
              'data-campo'
            );


          const docId =
            $td.attr(
              'data-doc-id'
            );


          const orig =
            $td.attr(
              'data-original'
            );


          if (
            !campo ||
            !docId
          ) {
            return;
          }


          if (
            DATE_FIELDS.has(
              campo
            )
          ) {
            return;
          }


          const raw =
            $td
              .text()
              .trim();


          let nuevoValor;
          let displayText;


          if (
            NUMERIC_FIELDS.has(
              campo
            )
          ) {
            // ===========================================
            // CANTIDAD COORDINADORES
            // ===========================================

            if (
              campo ===
              'cantidadCoordinadores'
            ) {
              const n =
                Number.parseInt(
                  raw,
                  10
                );


              if (
                !Number.isFinite(
                  n
                ) ||
                n < 1 ||
                n > 3
              ) {
                alert(
                  'La cantidad de coordinadores debe ser 1, 2 o 3.'
                );


                $td.text(
                  String(
                    orig ||
                    1
                  )
                );


                return;
              }


              nuevoValor =
                n;

              displayText =
                String(n);


            } else {
              // =========================================
              // OTROS NUMÉRICOS
              // =========================================

              if (
                raw === ''
              ) {
                nuevoValor =
                  0;

                displayText =
                  '0';

              } else {
                const n =
                  Number(
                    raw.replace(
                      /[^\d.-]/g,
                      ''
                    )
                  );


                if (
                  !Number.isFinite(
                    n
                  )
                ) {
                  $td.text(
                    String(
                      orig ??
                      ''
                    )
                  );

                  return;
                }


                const entero =
                  Math.trunc(
                    n
                  );


                nuevoValor =
                  entero;

                displayText =
                  String(
                    entero
                  );
              }
            }


          } else {
            nuevoValor =
              raw.toUpperCase();

            displayText =
              nuevoValor;
          }


          if (
            String(
              orig ??
              ''
            ) ===
            String(
              displayText
            )
          ) {
            return;
          }


          registrarCambioPendiente({
            docId,

            numeroNegocio:
              $td
                .closest('tr')
                .find('td')
                .eq(0)
                .text()
                .trim(),

            campo,

            anteriorDisplay:
              orig ??
              '',

            nuevoDisplay:
              displayText,

            nuevoValorFirestore:
              nuevoValor,

            identificador:
              $td
                .closest('tr')
                .find('td')
                .eq(1)
                .text()
                .trim(),

            nombreGrupo:
              $td
                .closest('tr')
                .find('td')
                .eq(2)
                .text()
                .trim(),

            td:
              $td[0]
          });


          $td.text(
            displayText
          );


          if (
            PAX_FIELDS.has(
              campo
            )
          ) {
            validarFilaPax(
              $td.closest(
                'tr'
              )
            );
          }
        }
      );


    // =====================================================
    // 21) VALIDACIÓN PAX EN VIVO
    // =====================================================

    $('#tablaGrupos tbody')
      .off(
        'input.paxLive'
      )
      .on(
        'input.paxLive',
        'td[contenteditable][data-campo="cantidadgrupo"], td[contenteditable][data-campo="adultos"], td[contenteditable][data-campo="estudiantes"]',
        function () {
          validarFilaPax(
            $(this)
              .closest(
                'tr'
              )
          );
        }
      );


    // =====================================================
    // 22) TOGGLE EDICIÓN
    // =====================================================

    $('#btn-toggle-edit')
      .off(
        'click.grupos'
      )
      .on(
        'click.grupos',
        async () => {
          if (
            editMode &&
            cambiosPendientes.length >
              0
          ) {
            mostrarModalCambios();

            return;
          }


          editMode =
            !editMode;


          $('#btn-toggle-edit')
            .text(
              editMode
                ? '🔒 Desactivar Edición'
                : '🔓 Activar Edición'
            );


          $('#tablaGrupos tbody tr')
            .each(
              (_, tr) => {
                $(tr)
                  .find('td')
                  .each(
                    (
                      i,
                      td
                    ) => {
                      const $td =
                        $(td);


                      const campo =
                        $td.attr(
                          'data-campo'
                        );


                      if (
                        i > 1 &&
                        !$td.attr(
                          'data-fixed'
                        ) &&
                        !DATE_FIELDS.has(
                          campo
                        )
                      ) {
                        if (editMode) {
                          $td.attr(
                            'contenteditable',
                            'true'
                          );

                        } else {
                          $td.removeAttr(
                            'contenteditable'
                          );
                        }

                      } else {
                        $td.removeAttr(
                          'contenteditable'
                        );
                      }
                    }
                  );
              }
            );


          await addDoc(
            collection(
              db,
              'historial'
            ),
            {
              accion:
                editMode
                  ? 'ACTIVÓ MODO EDICIÓN'
                  : 'DESACTIVÓ MODO EDICIÓN',

              usuario:
                auth.currentUser
                  ?.email ||
                '',

              timestamp:
                new Date()
            }
          );
        }
      );


    // =====================================================
    // 23) ASEGURAR EDITABLE
    // =====================================================

    $('#tablaGrupos tbody')
      .off(
        'click.ensureEditable'
      )
      .on(
        'click.ensureEditable',
        'td[data-campo]',
        function () {
          if (!editMode) {
            return;
          }


          const $td =
            $(this);


          if (
            $td.attr(
              'data-fixed'
            )
          ) {
            return;
          }


          const campo =
            $td.attr(
              'data-campo'
            );


          if (!campo) {
            return;
          }


          if (
            $td.index() <=
            1
          ) {
            return;
          }


          if (
            DATE_FIELDS.has(
              campo
            )
          ) {
            return;
          }


          $td.attr(
            'contenteditable',
            'true'
          );


          $td.trigger(
            'focus'
          );
        }
      );


    // =====================================================
    // 24) HISTORIAL
    // =====================================================

    $('#btn-view-history')
      .off(
        'click.grupos'
      )
      .on(
        'click.grupos',
        async () => {
          $('#modalHistorial')
            .css(
              'display',
              'flex'
            );


          $('#tablaHistorial tbody')
            .html(`
              <tr>
                <td colspan="6">
                  Cargando historial...
                </td>
              </tr>
            `);


          try{
            await recargarHistorial();

          }catch(err){
            console.error(
              'Error al abrir historial:',
              err
            );


            $('#tablaHistorial tbody')
              .html(`
                <tr>
                  <td colspan="6">
                    Error al cargar historial.
                  </td>
                </tr>
              `);
          }
        }
      );


    // =====================================================
    // 25) TOTALES
    // =====================================================

    const $modalTot =
      $('#modalTotales');


    const $popover =
      $('#tot-popover');


    function overlaps(
      ini,
      fin,
      min,
      max
    ) {
      if (
        !ini &&
        !fin
      ) {
        return false;
      }


      ini =
        ini ||
        fin;


      fin =
        fin ||
        ini;


      if (
        min &&
        fin <
          min
      ) {
        return false;
      }


      if (
        max &&
        ini >
          max
      ) {
        return false;
      }


      return true;
    }


    function openTotales() {
      const conInicio =
        GRUPOS_RAW.filter(
          g =>
            g.fechaInicio instanceof
            Date
        );


      if (
        conInicio.length
      ) {
        conInicio.sort(
          (a, b) =>
            a.fechaInicio -
            b.fechaInicio
        );


        const primero =
          conInicio[0];


        const ultimo =
          conInicio[
            conInicio.length -
            1
          ];


        $('#totInicio')
          .val(
            toInputDate(
              primero.fechaInicio
            )
          );


        $('#totFin')
          .val(
            toInputDate(
              ultimo.fechaFin ||
              ultimo.fechaInicio
            )
          );

      } else {
        $('#totInicio')
          .val(
            ''
          );

        $('#totFin')
          .val(
            ''
          );
      }


      $('#tot-resumen')
        .empty();


      $('#tot-tablas')
        .empty();


      $popover.hide();

      $modalTot.show();

      renderTotales();
    }


    function renderTotales() {
      const min =
        $('#totInicio')
          .val()
          ? new Date(
              $('#totInicio')
                .val() +
              'T00:00:00'
            )
          : null;


      const max =
        $('#totFin')
          .val()
          ? new Date(
              $('#totFin')
                .val() +
              'T23:59:59'
            )
          : null;


      const lista =
        GRUPOS_RAW.filter(
          g => {
            if (
              !min &&
              !max
            ) {
              return true;
            }


            return overlaps(
              g.fechaInicio,
              g.fechaFin,
              min,
              max
            );
          }
        );


      const cats = {
        '101':
          [],

        '201/202':
          [],

        '301/302/303':
          []
      };


      for (
        const g
        of lista
      ) {
        const idn =
          parseInt(
            String(
              g.identificador
            ).replace(
              /[^\d]/g,
              ''
            ),
            10
          );


        if (
          idn ===
          101
        ) {
          cats['101']
            .push(
              g
            );

        } else if (
          idn ===
            201 ||
          idn ===
            202
        ) {
          cats['201/202']
            .push(
              g
            );

        } else if (
          [
            301,
            302,
            303
          ].includes(
            idn
          )
        ) {
          cats['301/302/303']
            .push(
              g
            );
        }
      }


      const sum =
        (
          arr,
          k
        ) =>
          arr.reduce(
            (
              acc,
              x
            ) =>
              acc +
              (
                x[k] ||
                0
              ),
            0
          );


      const totPax =
        sum(
          lista,
          'cantidadgrupo'
        );


      const totAdul =
        sum(
          lista,
          'adultos'
        );


      const totEst =
        sum(
          lista,
          'estudiantes'
        );


      const fechasValidas =
        lista
          .flatMap(
            g => [
              g.fechaInicio,
              g.fechaFin
            ]
          )
          .filter(Boolean)
          .sort(
            (a, b) =>
              a -
              b
          );


      const minReal =
        fechasValidas[0]
          ? fechasValidas[0]
              .toLocaleDateString(
                'es-CL'
              )
          : '—';


      const maxReal =
        fechasValidas[
          fechasValidas.length -
          1
        ]
          ? fechasValidas[
              fechasValidas.length -
              1
            ]
              .toLocaleDateString(
                'es-CL'
              )
          : '—';


      const $res =
        $('#tot-resumen')
          .empty();


      const PILL_INDEX =
        [];


      const $tbx =
        $('#tot-tablas')
          .empty();


      const addPill =
        (
          label,
          arr,
          key
        ) => {
          const i =
            PILL_INDEX.push({
              key,
              arr
            }) -
            1;


          $('<div class="tot-pill"></div>')
            .attr(
              'data-pill',
              i
            )
            .attr(
              'title',
              'Click para ver grupos'
            )
            .append(
              `<span>${label}:</span>`
            )
            .append(
              `<span>${arr.length}</span>`
            )
            .append(
              '<small>grupos</small>'
            )
            .on(
              'click',
              ev =>
                showPopover(
                  ev,
                  PILL_INDEX[i],
                  label
                )
            )
            .appendTo(
              $res
            );
        };


      addPill(
        'Identificador 101',
        cats['101'],
        'id101'
      );


      addPill(
        'Identificador 201/202',
        cats['201/202'],
        'id201_202'
      );


      addPill(
        'Identificador 301/302/303',
        cats['301/302/303'],
        'id301_303'
      );


      $('<div class="tot-pill"></div>')
        .append(
          `<span>👥 Pax</span><span>${totPax}</span>`
        )
        .append(
          `<small>(Adultos ${totAdul} / Estudiantes ${totEst})</small>`
        )
        .appendTo(
          $res
        );


      $('<div class="tot-pill"></div>')
        .append(
          `<span>🗓️ Rango</span><span>${minReal} → ${maxReal}</span>`
        )
        .appendTo(
          $res
        );


      const mkTabla =
        (
          titulo,
          filas,
          includePax = true
        ) => {
          const $wrap =
            $('<div></div>')
              .append(
                `<h3 style="margin:.5rem 0;">${titulo}</h3>`
              );


          const $t =
            $(`
              <table>
                <thead>
                  <tr>
                    <th>${titulo}</th>
                    <th># Grupos</th>
                    ${
                      includePax
                        ? '<th>Pax</th>'
                        : ''
                    }
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            `);


          const $tb =
            $t.find(
              'tbody'
            );


          filas.forEach(
            row => {
              const i =
                PILL_INDEX.push({
                  key:
                    `${titulo}:${row.clave}`,

                  arr:
                    row.grupos
                }) -
                1;


              const paxTd =
                includePax
                  ? `<td>${row.pax}</td>`
                  : '';


              $tb.append(`
                <tr>
                  <td>${row.clave || '—'}</td>
                  <td>
                    <button
                      class="mini-link"
                      data-pill="${i}"
                      type="button"
                    >
                      ${row.grupos.length}
                    </button>
                  </td>
                  ${paxTd}
                </tr>
              `);
            }
          );


          $t.on(
            'click',
            'button.mini-link',
            ev => {
              const idx =
                parseInt(
                  ev.currentTarget
                    .getAttribute(
                      'data-pill'
                    ),
                  10
                );


              showPopover(
                ev,
                PILL_INDEX[idx],
                titulo
              );
            }
          );


          $wrap
            .append(
              $t
            );


          $tbx
            .append(
              $wrap
            );
        };


      const groupBy =
        (
          arr,
          key
        ) => {
          const map =
            new Map();


          for (
            const g
            of arr
          ) {
            const k =
              (
                g[key] ??
                ''
              )
                .toString()
                .trim();


            if (
              !map.has(
                k
              )
            ) {
              map.set(
                k,
                []
              );
            }


            map
              .get(
                k
              )
              .push(
                g
              );
          }


          return [
            ...map.entries()
          ]
            .map(
              (
                [
                  clave,
                  grupos
                ]
              ) => ({
                clave,

                grupos,

                pax:
                  sum(
                    grupos,
                    'cantidadgrupo'
                  )
              })
            )
            .sort(
              (a, b) =>
                b.grupos.length -
                a.grupos.length
            );
        };


      mkTabla(
        'Año',
        groupBy(
          lista,
          'anoViaje'
        )
      );


      mkTabla(
        'Vendedor(a)',
        groupBy(
          lista,
          'vendedora'
        )
      );


      mkTabla(
        'Destino',
        groupBy(
          lista,
          'destino'
        )
      );


      mkTabla(
        'Programa',
        groupBy(
          lista,
          'programa'
        )
      );


      mkTabla(
        'Hoteles',
        groupBy(
          lista,
          'hoteles'
        )
      );


      mkTabla(
        'Transporte',
        groupBy(
          lista,
          'transporte'
        )
      );


      function showPopover(
        ev,
        bucket,
        titulo
      ) {
        const items =
          bucket?.arr ||
          [];


        const html = `
          <h4>${titulo}</h4>
          <ul>
            ${
              items
                .map(
                  g => `
                    <li>
                      <a
                        href="#"
                        class="go-row"
                        data-num="${g.numeroNegocio}"
                      >
                        ${g.numeroNegocio} — ${g.nombreGrupo}
                      </a>
                    </li>
                  `
                )
                .join(
                  ''
                )
            }
          </ul>
        `;


        $popover
          .html(
            html
          );


        const vw =
          $(window).width();


        const vh =
          $(window).height();


        const w =
          Math.min(
            420,
            vw -
            24
          );


        $popover.css({
          width:
            w +
            'px'
        });


        const left =
          Math.min(
            ev.pageX +
            12,

            window.scrollX +
            vw -
            w -
            12
          );


        const top =
          Math.min(
            ev.pageY +
            12,

            window.scrollY +
            vh -
            24
          );


        $popover
          .css({
            left:
              left +
              'px',

            top:
              top +
              'px'
          })
          .show();


        $popover
          .off(
            'click',
            'a.go-row'
          )
          .on(
            'click',
            'a.go-row',
            e => {
              e.preventDefault();


              const num =
                e.currentTarget
                  .getAttribute(
                    'data-num'
                  ) ||
                '';


              let foundNode =
                null;


              tabla
                .rows()
                .every(
                  function () {
                    const data =
                      this.data();


                    if (
                      (
                        data?.[0] ||
                        ''
                      )
                        .toString()
                        .trim() ===
                      num
                        .toString()
                        .trim()
                    ) {
                      foundNode =
                        this.node();
                    }
                  }
                );


              if (
                foundNode
              ) {
                $('#tablaGrupos tbody tr')
                  .removeClass(
                    'highlight-row'
                  );


                $(foundNode)
                  .addClass(
                    'highlight-row'
                  )[0]
                  .scrollIntoView({
                    behavior:
                      'smooth',

                    block:
                      'center'
                  });

              } else {
                tabla
                  .search(
                    num
                  )
                  .draw();
              }
            }
          );
      }
    }


    window.__RT_totales = {
      open:
        openTotales,

      render:
        renderTotales
    };


    // =====================================================
    // 26) HISTORIAL
    // =====================================================

    async function recargarHistorial() {
      console.group(
        '🔄 recargarHistorial()'
      );


      try{
        const $tabla =
          $('#tablaHistorial');


        if (
          !$tabla.length
        ) {
          console.error(
            'No encontré #tablaHistorial'
          );

          console.groupEnd();

          return;
        }


        const q =
          query(
            collection(
              db,
              'historial'
            ),
            orderBy(
              'timestamp',
              'desc'
            ),
            limit(
              300
            )
          );


        const snap =
          await getDocs(
            q
          );


        const $tbH =
          $tabla
            .find(
              'tbody'
            )
            .empty();


        if (
          snap.empty
        ) {
          $tbH.html(`
            <tr>
              <td colspan="6">
                No hay historial registrado.
              </td>
            </tr>
          `);
        }


        snap.forEach(
          s => {
            const d =
              s.data();


            const fecha =
              d.timestamp
                ?.toDate
                ?.();


            if (!fecha) {
              return;
            }


            const ts =
              fecha.getTime();


            $tbH.append(`
              <tr>
                <td data-timestamp="${ts}">
                  ${fecha.toLocaleString('es-CL')}
                </td>

                <td>
                  ${d.modificadoPor || d.usuario || ''}
                </td>

                <td>
                  ${d.numeroNegocio || ''}
                </td>

                <td>
                  ${d.accion || d.campo || d.tipo || ''}
                </td>

                <td>
                  ${d.anterior ?? d.valorAnterior ?? d.antes ?? ''}
                </td>

                <td>
                  ${d.nuevo ?? d.valorNuevo ?? d.despues ?? d.nuevoDisplay ?? ''}
                </td>
              </tr>
            `);
          }
        );


        if (
          $.fn.DataTable.isDataTable(
            '#tablaHistorial'
          )
        ) {
          $('#tablaHistorial')
            .DataTable()
            .destroy();
        }


        dtHist =
          $('#tablaHistorial')
            .DataTable({
              language: {
                url:
                  'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
              },

              pageLength:
                15,

              lengthMenu: [
                [
                  15,
                  30,
                  50,
                  -1
                ],

                [
                  15,
                  30,
                  50,
                  'Todos'
                ]
              ],

              order: [
                [
                  0,
                  'desc'
                ]
              ],

              dom:
                'ltip'
            });


      }catch(err){
        console.error(
          '🔥 recargarHistorial() error:',
          err
        );
      }


      console.groupEnd();
    }


    $('#btn-refresh-history')
      .off(
        'click.grupos'
      )
      .on(
        'click.grupos',
        recargarHistorial
      );


    $('#btn-close-history')
      .off(
        'click.grupos'
      )
      .on(
        'click.grupos',
        () => {
          $('#modalHistorial')
            .hide();
        }
      );


    $('#buscadorHistorial')
      .off(
        'input.grupos'
      )
      .on(
        'input.grupos',
        () => {
          if (
            dtHist
          ) {
            dtHist
              .search(
                $('#buscadorHistorial')
                  .val()
              )
              .draw();
          }
        }
      );


    // =====================================================
    // 27) FILTRO HISTORIAL POR FECHA
    // =====================================================

    $.fn.dataTable.ext.search.push(
      (
        settings,
        rowData,
        rowIdx
      ) => {
        if (
          settings.nTable.id !==
          'tablaHistorial'
        ) {
          return true;
        }


        if (!dtHist) {
          return true;
        }


        const node =
          dtHist
            .row(
              rowIdx
            )
            .node();


        const cell =
          node
            ?.querySelector(
              'td[data-timestamp]'
            );


        if (!cell) {
          return true;
        }


        const ts =
          parseInt(
            cell.getAttribute(
              'data-timestamp'
            ),
            10
          );


        const min =
          $('#histInicio')
            .val()
            ? new Date(
                $('#histInicio')
                  .val()
              ).getTime()
            : -Infinity;


        const max =
          $('#histFin')
            .val()
            ? new Date(
                $('#histFin')
                  .val()
              ).getTime()
            : +Infinity;


        return (
          ts >= min &&
          ts <= max
        );
      }
    );


    $('#histInicio, #histFin')
      .off(
        'change.grupos'
      )
      .on(
        'change.grupos',
        () => {
          if (
            dtHist
          ) {
            dtHist.draw();
          }
        }
      );


    setCargaOk(
      `Tabla cargada correctamente con ${valores.length} grupos.`
    );


  } catch (err) {
    console.error(
      '🔥 Error general en cargarYMostrarTabla():',
      err
    );


    setCargaError(
      err
    );
  }
}
// 1) Función que lee toda la tabla de DataTables y genera un Excel
function exportarGrupos() {
  // Usamos DataTables API para obtener datos tal como se muestran (filtrados, ordenados)
  const tabla = $('#tablaGrupos').DataTable();
  // Obtiene un array de arrays: cada fila en un sub-array de celdas de texto
  const rows = tabla.rows({ search: 'applied' }).data().toArray();

  // Encabezados igual a las columnas definidas en el HTML (ordenado)
  const headers = [
    "N° Negocio",
    "Identificador",
    "Nombre de Grupo",
    "Año",
    "Vendedor(a)",
    "Coordinadores",
    "Tel. Coord.",
    "Cant. Coord.",
    "Pax",
    "Adultos",
    "Estudiantes",
    "Colegio",
    "Curso",
    "Destino",
    "Programa",
    "Fecha Inicio",
    "Fecha Fin",
    "Seguro Médico",
    "Autoriz.",
    "Hoteles",
    "Ciudades",
    "Transporte",
    "Tramos",
    "Indicaciones de la Fecha",
    "Observaciones",
    "Creado Por",
    "Fecha Creación"
  ];

  // Prepara un array de objetos (clave=header, valor=celda)
  const datos = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });

  // 2) Genera worksheet y workbook con SheetJS
  const ws = XLSX.utils.json_to_sheet(datos, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Grupos");

  // 3) Desencadena la descarga
  XLSX.writeFile(wb, "grupos.xlsx");
}

// 4) Asocia el botón
document
  .getElementById('btn-export-excel')
  .addEventListener('click', exportarGrupos);

// Handlers robustos (delegados) para el modal Totales
$(document).off('click.RTtot');

$(document).on('click.RTtot', '#btn-totales', function (e) {
  e.preventDefault();
  window.__RT_totales?.open();
});

$(document).on('click.RTtot', '#btn-tot-calcular', function (e) {
  e.preventDefault();
  window.__RT_totales?.render();
});

$(document).on('click.RTtot', '#btn-tot-cerrar', function (e) {
  e.preventDefault();
  $('#tot-popover').hide();
  $('#modalTotales').hide();
});

// Cerrar popover al hacer click fuera (sin cerrar el modal)
$(document).on('click.RTtot', function (e) {
  if (!$(e.target).closest('#tot-popover, .tot-pill, .mini-link').length) {
    $('#tot-popover').hide();
  }
});

// Botones modal cambios
$(document).off('click.RTcambios');

$(document).on('click.RTcambios', '#btn-cambios-cancelar', () => {
  $('#modalConfirmarCambios').hide();
});

$(document).on('click.RTcambios', '#btn-cambios-descartar', async () => {
  descartarCambiosPendientes();

  $('#modalConfirmarCambios').hide();

  editMode = false;
  $('#btn-toggle-edit').text('🔓 Activar Edición');

  $('#tablaGrupos tbody td').removeAttr('contenteditable');

  await addDoc(collection(db, 'historial'), {
    accion: 'DESCARTÓ CAMBIOS Y DESACTIVÓ MODO EDICIÓN',
    usuario: auth.currentUser.email,
    timestamp: new Date()
  });
});

$(document).on('click.RTcambios', '#btn-cambios-guardar', async () => {
  try {
    await guardarCambiosPendientes();

    $('#modalConfirmarCambios').hide();

    editMode = false;
    $('#btn-toggle-edit').text('🔓 Activar Edición');

    $('#tablaGrupos tbody td').removeAttr('contenteditable');

    await addDoc(collection(db, 'historial'), {
      accion: 'GUARDÓ CAMBIOS Y DESACTIVÓ MODO EDICIÓN',
      usuario: auth.currentUser.email,
      timestamp: new Date()
    });

    alert('Cambios guardados correctamente.');
  } catch (err) {
    console.error('Error guardando cambios:', err);
    alert(err.message || 'No se pudieron guardar los cambios.');
  }
});

window.convertirItinerariosRelativosExistentes = async function () {
  const snap = await getDocs(collection(db, 'grupos'));

  let revisados = 0;
  let convertidos = 0;
  let omitidos = 0;

  for (const docSnap of snap.docs) {
    revisados++;

    try {
      const ok = await convertirItinerarioRelativoGrupo(docSnap.id);
      if (ok) convertidos++;
      else omitidos++;
    } catch (err) {
      console.error('Error convirtiendo grupo:', docSnap.id, err);
      omitidos++;
    }
  }

  console.log({ revisados, convertidos, omitidos });

  alert(
    `Proceso terminado.\n` +
    `Revisados: ${revisados}\n` +
    `Convertidos: ${convertidos}\n` +
    `Omitidos: ${omitidos}`
  );
};

window.diagnosticarSincronizacionFechasItinerario = async function () {
  const snap = await getDocs(collection(db, 'grupos'));

  const reporte = [];

  snap.forEach(docSnap => {
    const g = docSnap.data() || {};
    const IT = g.itinerario || {};
    const keys = Object.keys(IT);

    const fechasEsperadas = crearRangoFechasISO(g.fechaInicio, g.fechaFin);

    if (!fechasEsperadas.length) return;

    const iguales =
      keys.length === fechasEsperadas.length &&
      fechasEsperadas.every(f => keys.includes(f));

    if (!iguales) {
      reporte.push({
        docId: docSnap.id,
        numeroNegocio: g.numeroNegocio || '',
        nombreGrupo: g.nombreGrupo || '',
        fechaInicio: formatearCelda(g.fechaInicio, 'fechaInicio'),
        fechaFin: formatearCelda(g.fechaFin, 'fechaFin'),
        diasItinerarioActual: keys.join(', '),
        diasEsperados: fechasEsperadas.join(', ')
      });
    }
  });

  console.table(reporte);
  console.log(`Grupos desincronizados: ${reporte.length}`);
  return reporte;
};

window.sincronizarTodosLosItinerariosConFechas = async function (dryRun = true) {
  const snap = await getDocs(collection(db, 'grupos'));

  let revisados = 0;
  let corregidos = 0;
  let sinFechas = 0;
  let yaOk = 0;
  let errores = 0;

  const reporte = [];

  for (const docSnap of snap.docs) {
    try {
      const g = docSnap.data() || {};
      const docId = docSnap.id;

      revisados++;

      const fechasEsperadas = crearRangoFechasISO(g.fechaInicio, g.fechaFin);

      if (!fechasEsperadas.length) {
        sinFechas++;
        continue;
      }

      const IT = g.itinerario || {};
      const keys = Object.keys(IT);

      const iguales =
        keys.length === fechasEsperadas.length &&
        fechasEsperadas.every(f => keys.includes(f));

      if (iguales) {
        yaOk++;
        continue;
      }

      reporte.push({
        docId,
        numeroNegocio: g.numeroNegocio || '',
        nombreGrupo: g.nombreGrupo || '',
        antes: keys.join(', '),
        despues: fechasEsperadas.join(', ')
      });

      if (!dryRun) {
        await sincronizarFechasEItinerarioGrupo(docId);
        corregidos++;
      }

    } catch (err) {
      errores++;
      console.error('Error sincronizando grupo:', docSnap.id, err);
    }
  }

  console.table(reporte);

  console.log({
    modo: dryRun ? 'PRUEBA / NO GUARDA' : 'REAL / GUARDA',
    revisados,
    detectadosParaCorregir: reporte.length,
    corregidos,
    sinFechas,
    yaOk,
    errores
  });

  return {
    modo: dryRun ? 'PRUEBA / NO GUARDA' : 'REAL / GUARDA',
    revisados,
    detectadosParaCorregir: reporte.length,
    corregidos,
    sinFechas,
    yaOk,
    errores,
    reporte
  };
};

window.rellenarFechasGrupoDesdeItinerario = async function (dryRun = true) {
  const snap = await getDocs(collection(db, 'grupos'));

  let revisados = 0;
  let actualizados = 0;
  let sinItinerarioConFechas = 0;

  const reporte = [];

  for (const docSnap of snap.docs) {
    const g = docSnap.data() || {};
    const docId = docSnap.id;

    revisados++;

    const IT = g.itinerario || {};
    const fechasItinerario = Object.keys(IT)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(String(k)))
      .sort((a, b) => new Date(a) - new Date(b));

    if (!fechasItinerario.length) {
      sinItinerarioConFechas++;
      continue;
    }

    const fechaInicioNueva = fechasItinerario[0];
    const fechaFinNueva = fechasItinerario[fechasItinerario.length - 1];

    const inicioActual = _toISO(g.fechaInicio);
    const finActual = _toISO(g.fechaFin);

    if (inicioActual === fechaInicioNueva && finActual === fechaFinNueva) {
      continue;
    }

    reporte.push({
      docId,
      numeroNegocio: g.numeroNegocio || '',
      nombreGrupo: g.nombreGrupo || '',
      inicioActual,
      finActual,
      fechaInicioNueva,
      fechaFinNueva
    });

    if (!dryRun) {
      await updateDoc(doc(db, 'grupos', docId), {
        fechaInicio: Timestamp.fromDate(new Date(fechaInicioNueva + 'T00:00:00')),
        fechaFin: Timestamp.fromDate(new Date(fechaFinNueva + 'T00:00:00'))
      });

      await addDoc(collection(db, 'historial'), {
        numeroNegocio: g.numeroNegocio || docId,
        nombreGrupo: g.nombreGrupo || '',
        accion: 'RELLENAR FECHAS DESDE ITINERARIO',
        anterior: `${inicioActual || 'SIN INICIO'} → ${finActual || 'SIN FIN'}`,
        nuevo: `${fechaInicioNueva} → ${fechaFinNueva}`,
        usuario: auth.currentUser?.email || '',
        timestamp: new Date()
      });

      actualizados++;
    }
  }

  console.table(reporte);

  console.log({
    modo: dryRun ? 'PRUEBA / NO GUARDA' : 'REAL / GUARDA',
    revisados,
    detectados: reporte.length,
    actualizados,
    sinItinerarioConFechas
  });

  return {
    modo: dryRun ? 'PRUEBA / NO GUARDA' : 'REAL / GUARDA',
    revisados,
    detectados: reporte.length,
    actualizados,
    sinItinerarioConFechas,
    reporte
  };
};

window.verGrupoDebug = async function (docId) {
  const ref = doc(db, "grupos", docId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    console.warn("No existe el grupo:", docId);
    return null;
  }

  const g = snap.data();

  console.log("docId:", docId);
  console.log("numeroNegocio:", g.numeroNegocio);
  console.log("nombreGrupo:", g.nombreGrupo);
  console.log("fechaInicio:", g.fechaInicio);
  console.log("fechaFin:", g.fechaFin);
  console.log("fechaInicio ISO:", _toISO(g.fechaInicio));
  console.log("fechaFin ISO:", _toISO(g.fechaFin));
  console.log("itinerario keys:", Object.keys(g.itinerario || {}).sort());

  return g;
};

async function revisarPaxGruposContraPagos() {
  if (REVISION_PAX_ACTIVA) return;
  REVISION_PAX_ACTIVA = true;

  const $resumen = $('#revisionPaxResumen');
  const $body = $('#revisionPaxBody');

  $body.empty();
  $resumen.text('Consultando sistema de pagos...');
  $('#modalRevisionPaxPagos').css('display', 'flex');

  const tabla = $('#tablaGrupos').DataTable();
  const filas = tabla.rows({ search: 'applied' }).data().toArray();

  const resultados = [];

  for (const row of filas) {
    const numeroNegocio = String(row[0] || '').trim();
    const nombreGrupo = String(row[2] || '').trim();

    const paxSistema =
      toNum(
        row[8]
      );
    
    const adultosSistema =
      toNum(
        row[9]
      );
    
    const estudiantesSistema =
      toNum(
        row[10]
      );

    try {
      const numerosPago = obtenerNumerosNegocioPagoGrupos(numeroNegocio);
      const pagos = await consultarResumenPagosFusionadoGrupos(numerosPago);

      const diferencia = pagos.totalViajan - paxSistema;
      const diffAdultos = pagos.totalAdultos - adultosSistema;
      const diffEstudiantes = pagos.totalEstudiantes - estudiantesSistema;

      if (diferencia !== 0 || diffAdultos !== 0 || diffEstudiantes !== 0) {
        resultados.push({
          numeroNegocio,
          nombreGrupo,
          paxSistema,
          paxPagos: pagos.totalViajan,
          diferencia,
          adultosSistema,
          adultosPagos: pagos.totalAdultos,
          estudiantesSistema,
          estudiantesPagos: pagos.totalEstudiantes
        });
      }

    } catch (err) {
      console.error('Error revisando pagos grupo:', numeroNegocio, err);

      resultados.push({
        numeroNegocio,
        nombreGrupo,
        paxSistema,
        paxPagos: 'ERROR',
        diferencia: 'ERROR',
        adultosSistema,
        adultosPagos: 'ERROR',
        estudiantesSistema,
        estudiantesPagos: 'ERROR'
      });
    }
  }

  if (!resultados.length) {
    $resumen.text(`✅ Todos los grupos visibles coinciden con pagos. Revisados: ${filas.length}.`);
  } else {
    $resumen.text(`⚠️ Hay ${resultados.length} grupo(s) con diferencia. Revisados: ${filas.length}.`);
  }

  $body.html(resultados.map(r => {
    const color = r.diferencia === 0 ? '#09832e' : '#ca0a1f';
    const diffTxt =
      r.diferencia === 'ERROR'
        ? 'ERROR'
        : (r.diferencia > 0 ? `+${r.diferencia}` : r.diferencia);

    return `
      <tr class="${r.diferencia === 0 ? '' : 'fila-error'}">
        <td>${r.numeroNegocio}</td>
        <td class="col-texto">${r.nombreGrupo}</td>
        <td>${r.paxSistema}</td>
        <td>${r.paxPagos}</td>
        <td class="${r.diferencia === 0 ? 'diff-ok' : 'diff-error'}">${diffTxt}</td>
        <td>${r.adultosSistema}</td>
        <td>${r.adultosPagos}</td>
        <td>${r.estudiantesSistema}</td>
        <td>${r.estudiantesPagos}</td>
      </tr>
    `;
  }).join(''));

  REVISION_PAX_ACTIVA = false;
}

function obtenerNumerosNegocioPagoGrupos(numeroNegocio) {
  const raw = String(numeroNegocio || '').trim();
  if (!raw) return [];

  // Fusionados: 1581-1582
  if (/^\d+\s*-\s*\d+$/.test(raw)) {
    return raw.split('-').map(x => x.trim()).filter(Boolean);
  }

  return [raw];
}

async function consultarResumenPagosFusionadoGrupos(numerosPago) {
  const acumulado = crearResumenPagosVacioGrupos();

  for (const numero of numerosPago) {
    const url = `${API_PAGOS_URL}?modo=detalle&numeroNegocio=${encodeURIComponent(numero)}`;
    const res = await fetch(url);

    if (!res.ok) throw new Error(`HTTP ${res.status} consultando ${numero}`);

    const data = await res.json();

    const pasajeros =
      data?.nominas?.data?.pasajeros ||
      data?.saldos?.data?.detalle_pasajeros ||
      [];

    const resumen = calcularResumenPagosGrupos(pasajeros);
    sumarResumenPagosGrupos(acumulado, resumen);
  }

  return acumulado;
}

function crearResumenPagosVacioGrupos() {
  return {
    totalViajan: 0,
    totalAdultos: 0,
    totalEstudiantes: 0
  };
}

function sumarResumenPagosGrupos(base, add) {
  base.totalViajan += Number(add.totalViajan || 0);
  base.totalAdultos += Number(add.totalAdultos || 0);
  base.totalEstudiantes += Number(add.totalEstudiantes || 0);
}

function calcularResumenPagosGrupos(items) {
  const resumen = crearResumenPagosVacioGrupos();
  const pasajeros = Array.isArray(items) ? items : [];

  pasajeros.forEach(item => {
    const p = item?.pasajero || item || {};

    if (!pasajeroViajaGrupos(p)) return;

    resumen.totalViajan++;

    if (tipoPasajeroPagosGrupos(p) === 'estudiante') {
      resumen.totalEstudiantes++;
    } else {
      resumen.totalAdultos++;
    }
  });

  return resumen;
}

function pasajeroViajaGrupos(p) {
  const v =
    p.viaja ??
    p.estado_viaje ??
    p.estado ??
    p.activo ??
    '';

  if (typeof v === 'number') return Number(v) === 1;

  const txt = normalizarTextoPagosGrupos(v);
  if (!txt) return true;

  if (['1', 'si', 'sí', 'viaja', 'activo', 'activa'].includes(txt)) return true;
  if (['0', 'no', 'no viaja', 'anulado', 'anulada', 'baja'].includes(txt)) return false;

  return true;
}

function tipoPasajeroPagosGrupos(p) {
  const categoria = normalizarTextoPagosGrupos(
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

function normalizarTextoPagosGrupos(txt) {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}
