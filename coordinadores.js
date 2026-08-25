/* coordinadores.js — FINAL + LOGS
   Instrumentación:
   - DEBUG switch + helper L(), W(), E()
   - window.onerror / unhandledrejection
   - console.time* en cargas y render
   - groupCollapsed en pasos críticos
   - contadores y tamaños en cada fase
*/

import { app, db } from './firebase-init.js';
import {
  collection, collectionGroup, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc,
  query, where, getDoc, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===================== LOGGING ===================== */
const DEBUG = true;
const tag = 'RTV/coord';
const L = (...a)=> DEBUG && console.log(`[${tag}]`, ...a);
const W = (...a)=> DEBUG && console.warn(`[${tag}]`, ...a);
const E = (...a)=> DEBUG && console.error(`[${tag}]`, ...a);

window.addEventListener('error', (ev)=>{
  E('window.onerror:', ev.message, ev.error);
});
window.addEventListener('unhandledrejection', (ev)=>{
  E('unhandledrejection:', ev.reason || ev);
});

/* =========================================================
   Estado
   ========================================================= */
let COORDS = [];   // {id, nombre, rut, telefono, correo, destinos:string[], disponibilidad:[{inicio,fin}], activo, notas, _isNew?}
let GRUPOS = [];   // catálogo de viajes (grupos)
let SETS   = [];   // asignaciones (conjuntos)
let ID2GRUPO = new Map();

let HORAS_INICIO = new Map(); // groupId -> { pres:'HH:MM'|null, inicio:'HH:MM'|null, fuente:'aereo|terrestre', vueloId:string|null }

// Hoteles asignados por grupo (ya depurados sin solapes y tomando el último creado)
let HOTELES_POR_GRUPO = new Map(); // groupId -> [{ nombre, ini, fin }]

// Catálogo de hoteles: id → nombre (y otros datos si quisieras después)
let HOTELS_BY_ID = new Map(); // hotelId -> nombreHotel

/* =========================================================
   Año operativo de coordinadores
   ========================================================= */

function getAnoOperativoCoordinadores() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());

  const ano = Number(
    partes.find(p => p.type === 'year')?.value
  );

  const mes = Number(
    partes.find(p => p.type === 'month')?.value
  );

  return mes >= 3 ? ano : ano - 1;
}

let ANO_COORDINADORES = getAnoOperativoCoordinadores();

function getAnoGrupo(g) {
  return Number(
    g?.anoViaje ??
    g?.anio ??
    g?.year ??
    0
  ) || null;
}

let DESTINOS = []; // catálogo (normalizado) desde GRUPOS
// ===== Snapshot para diffs en guardado =====
const PREV = {
  grupos: new Map(),   // id -> { aliasGrupo, conjuntoId, coordinadorId, coordinador }
  sets:   new Map(),   // `${ownerCoordId}/${conjuntoId}` -> { viajes:[ids], confirmado:true, owner }
};

// Filtros de catálogo (resumen/libres)
const FILTER = { destino:'', programa:'', desde:'', hasta:'' };

// Buscador de CONJUNTOS (tokens)
const SEARCH = { tokens: [] };

// Filtros/búsquedas adicionales
const FILTER_SETS   = { day: '' };   // día exacto para asignados (SETS)
const FILTER_LIBRES = { day: '' };   // día exacto para libres
const SEARCH_LIBRES = { tokens: [] };// buscador para libres

/* =========================================================
   Triestado aceptación del coordinador (SET-level)
   ========================================================= */
const ESTADO_VALUES = ['pendiente','aprobado','rechazado'];
const normalizeEstado = (v) => {
  const x = (v||'').toString().toLowerCase();
  return ESTADO_VALUES.includes(x) ? x : 'pendiente';
};
const nextEstado = (v) => {
  const i = ESTADO_VALUES.indexOf(normalizeEstado(v));
  return ESTADO_VALUES[(i+1) % ESTADO_VALUES.length];
};
const estadoIcon  = (v) => ({pendiente:'⏳', aprobado:'✅', rechazado:'⛔'})[normalizeEstado(v)];
const estadoLabel = (v) => ({pendiente:'Pendiente', aprobado:'Aprobado', rechazado:'Rechazado'})[normalizeEstado(v)];

function estadoBgStyle(est){
  const v = normalizeEstado(est);
  // verde suave (aprobado), amarillo suave (pendiente), rojo suave (rechazado)
  if (v === 'aprobado')  return 'background-color: rgba(16,185,129,.18)';   // green-500 @ ~18%
  if (v === 'rechazado') return 'background-color: rgba(239,68,68,.18)';    // red-500  @ ~18%
  return 'background-color: rgba(234,179,8,.22)';                           // amber-400 @ ~22% (pendiente)
}

function estadoClass(v){
  switch (normalizeEstado(v)) {
    case 'aprobado':  return 'estado-ok';
    case 'rechazado': return 'estado-bad';
    default:          return 'estado-pend';
  }
}

let swapMode  = false;
let swapFirst = null;

/* =========================================================
   Helpers fecha/formato
   ========================================================= */
const toISO = d => (new Date(d)).toISOString().slice(0,10);
const addDaysISO = (iso, n) => { const D=new Date(iso+'T00:00:00'); D.setDate(D.getDate()+n); return toISO(D); };

function asISO(v){
  if (!v) return null;
  if (typeof v === 'string'){ const d = new Date(v); return isNaN(d) ? null : toISO(d); }
  if (v?.toDate)  return toISO(v.toDate());
  if (v?.seconds) return toISO(new Date(v.seconds*1000));
  if (v instanceof Date) return toISO(v);
  return null;
}

const cmpISO   = (a,b)=> (new Date(a)-new Date(b));
const overlap  = (a1,a2,b1,b2)=>!(new Date(a2)<new Date(b1)||new Date(b2)<new Date(a1));
const inAnyRange = (ini,fin,ranges=[]) => (ranges||[]).some(r=> new Date(ini)>=new Date(r.inicio) && new Date(fin)<=new Date(r.fin));
function gapDays(finA, iniB){ const A=new Date(finA+'T00:00:00'); const B=new Date(iniB+'T00:00:00'); return Math.round((B-A)/86400000)-1; }

// dd/mm/aaaa
function fmtDMY(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
// ===== Helpers HH:MM =====
function isHHMM(s){ return typeof s==='string' && /^\d{2}:\d{2}$/.test(s); }
function hhmmToMin(s){ if(!isHHMM(s)) return null; const [h,m]=s.split(':').map(Number); return (h*60)+m; }
function minHHMM(a,b){
  if (!isHHMM(a)) return b||''; if (!isHHMM(b)) return a||'';
  return (hhmmToMin(a) <= hhmmToMin(b)) ? a : b;
}

/* =========================================================
   Normalización de destinos (MAYÚSCULA)
   ========================================================= */
const normDest = s => (s||'').toString().trim().toUpperCase();
function cleanDestinos(arr){
  return (arr||[])
    .map(normDest)
    .filter(Boolean)
    .filter((v,i,a)=>a.indexOf(v)===i)
    .sort();
}
function isAptoDestino(coord, destino){
  const d = normDest(destino);
  if (!d) return true;
  const L = coord?.destinos || [];
  // lista vacía = apto para todos
  return !L.length || L.includes(d);
}

// Resolver el ID real del grupo a partir de un grupoId que viene en hotelAssignments
function resolveGrupoIdFromHotelAssignment(rawGrupoId){
  const k = (rawGrupoId || '').toString().trim();
  if (!k) return null;

  // 1) Coincide con el ID del documento de grupos
  if (ID2GRUPO.has(k)) return k;

  // 2) Coincide con numeroNegocio del grupo
  const hit = GRUPOS.find(g => String(g.numeroNegocio || '').trim() === k);
  return hit ? hit.id : null;
}

/* =========================================================
   Carga Firestore
   ========================================================= */
async function loadCoordinadores(){
  console.time('loadCoordinadores');
  COORDS = [];
  try{
    const snap = await getDocs(collection(db,'coordinadores'));
    L('Coordinadores: snap.size =', snap.size);
    snap.forEach(d=>{
      const x=d.data();
      const disp = Array.isArray(x.disponibilidad) ? x.disponibilidad
                 : Array.isArray(x.fechasDisponibles) ? x.fechasDisponibles : [];
      const disponibilidad = (disp||[])
        .map(r=>({inicio:asISO(r.inicio)||null, fin:asISO(r.fin)||null}))
        .filter(r=>r.inicio&&r.fin&&(new Date(r.inicio)<=new Date(r.fin)));

         COORDS.push({
           id:d.id,
           nombre:(x.nombre||'').trim(),
           rut:(x.rut||'').trim(),
           fechaNacimiento: asISO(x.fechaNacimiento) || null,
         
           // ← NUEVO: DATOS PARA TRANSFERIR
           datosTransferir: (x.datosTransferir || x.datos_para_transferir || x.transferData || '').toString().trim(),
         
           telefono:(x.telefono||'').trim(),
           correo:(x.correo||'').trim().toLowerCase(),
           destinos: cleanDestinos(x.destinos || x.destinosAptos || []),
           disponibilidad,
           activo:(x.activo!==false),
           notas:(x.notas||'').trim()
         });

    });
    L('Coordinadores cargados:', COORDS.length);
  }catch(err){
    E('loadCoordinadores error:', err);
    throw err;
  }finally{
    console.timeEnd('loadCoordinadores');
  }
}

async function loadGrupos(){
  console.time('loadGrupos');

  GRUPOS = [];
  ID2GRUPO.clear();

  try{
    const ref = collection(db, 'grupos');

    // Hay registros donde anoViaje puede estar guardado
    // como número o como texto.
    const [snapNumero, snapTexto] = await Promise.all([
      getDocs(
        query(
          ref,
          where(
            'anoViaje',
            '==',
            Number(ANO_COORDINADORES)
          )
        )
      ),

      getDocs(
        query(
          ref,
          where(
            'anoViaje',
            '==',
            String(ANO_COORDINADORES)
          )
        )
      )
    ]);

    // Evitar duplicados si por cualquier razón
    // ambos resultados contienen el mismo documento.
    const docsMap = new Map();

    snapNumero.docs.forEach(d => {
      docsMap.set(d.id, d);
    });

    snapTexto.docs.forEach(d => {
      docsMap.set(d.id, d);
    });

    const docs = Array.from(
      docsMap.values()
    );

    L(
      'Grupos año',
      ANO_COORDINADORES,
      '=',
      docs.length
    );

    let omitidosSinFecha = 0;
    let tomados = 0;

    const primerosIds = [];

    docs.forEach(d => {
      if (primerosIds.length < 8) {
        primerosIds.push(d.id);
      }

      const x = d.data() || {};

      x.id = d.id;

      x.numeroNegocio =
        x.numeroNegocio ||
        d.id;

      x.aliasGrupo =
        x.aliasGrupo ||
        limpiarAlias(
          x.nombreGrupo ||
          String(d.id)
        );

      const { ini, fin } =
        normalizarFechasGrupo(x);

      if (!ini || !fin) {
        omitidosSinFecha++;
        return;
      }

      const g = {
        ...x,

        id: d.id,

        anoViaje:
          Number(x.anoViaje) ||
          ANO_COORDINADORES,

        fechaInicio: ini,
        fechaFin: fin,

        identificador:
          x.identificador ||
          x.identificadorGrupo ||
          x.codigoGrupo ||
          x.codigo ||
          '',

        programa:
          x.programa ||
          x.nombrePrograma ||
          x.programaNombre ||
          '',

        destino:
          x.destino ||
          x.destinoPrincipal ||
          x.ciudadDestino ||
          x.ciudad ||
          x.paisDestino ||
          ''
      };

      GRUPOS.push(g);

      ID2GRUPO.set(
        g.id,
        g
      );

      tomados++;
    });

    GRUPOS.sort(
      (a, b) =>
        new Date(a.fechaInicio) -
        new Date(b.fechaInicio)
    );

    L(
      'loadGrupos año',
      ANO_COORDINADORES,
      '=> tomados:',
      tomados,
      '| omitidosSinFecha:',
      omitidosSinFecha,
      '| ID2GRUPO:',
      ID2GRUPO.size,
      '| primeros:',
      primerosIds
    );

    if (!GRUPOS.length) {
      W(
        `No existen grupos válidos para el año ${ANO_COORDINADORES}.`
      );
    }

  }catch(err){
    E(
      'loadGrupos error:',
      err
    );

    throw err;

  }finally{
    console.timeEnd(
      'loadGrupos'
    );
  }
}

async function loadHorasViajes(){
  console.time('loadHorasViajes');
  HORAS_INICIO.clear();
  try{
    // Cargamos TODOS los vuelos
    const snap = await getDocs(collection(db,'vuelos')); // requiere import getDocs, collection (ya los tienes)
    // Recorremos cada vuelo y sus grupos
    snap.forEach(d=>{
      const v = d.data() || {};
      const vId = d.id;
      const tipoTrans = (v.tipoTransporte || 'aereo').toLowerCase();

      // Helper para postular horas a un grupo
      const postularHoras = (groupId, fechaIda, pres, inicio)=>{
        const g = ID2GRUPO.get(groupId);
        if (!g) return;
        const fechaGrupo = g.fechaInicio; // ya normalizada por loadGrupos
        if (!fechaGrupo || !fechaIda || fechaGrupo !== fechaIda) return;

        const curr = HORAS_INICIO.get(groupId) || { pres:null, inicio:null, fuente:null, vueloId:null };
        const nuevo = {
          pres  : pres   && isHHMM(pres)   ? (curr.pres   ? minHHMM(curr.pres, pres)   : pres)   : curr.pres,
          inicio: inicio && isHHMM(inicio) ? (curr.inicio ? minHHMM(curr.inicio, inicio): inicio): curr.inicio,
          fuente: tipoTrans,
          vueloId: vId
        };
        HORAS_INICIO.set(groupId, nuevo);
      };

      // Caso AÉREO REGULAR MULTITRAMO: horas en tramos[]
      const isAereo = tipoTrans === 'aereo';
      const isRegMT = isAereo && v.tipoVuelo === 'regular' && Array.isArray(v.tramos) && v.tramos.length>0;

      if (isRegMT){
        (Array.isArray(v.grupos)?v.grupos:[]).forEach(gref=>{
          const gid = gref?.id; if(!gid) return;
          // para cada tramo con fechaIda
          (v.tramos||[]).forEach(t=>{
            const fIda = t?.fechaIda ? (new Date(t.fechaIda)).toISOString().slice(0,10) : '';
            if (!fIda) return;
            const pres = t.presentacionIdaHora || '';
            const ini  = t.vueloIdaHora || '';
            postularHoras(gid, fIda, pres, ini);
          });
        });
        return; // procesa siguiente vuelo
      }

      // Caso AÉREO simple/charter: top-level fechaIda + horas
      if (isAereo){
        const fIda = v?.fechaIda ? (new Date(v.fechaIda)).toISOString().slice(0,10) : '';
        const pres = v.presentacionIdaHora || '';
        const ini  = v.vueloIdaHora || '';
        (Array.isArray(v.grupos)?v.grupos:[]).forEach(gref=>{
          const gid = gref?.id; if(!gid) return;
          postularHoras(gid, fIda, pres, ini);
        });
        return;
      }

      // Caso TERRESTRE (bus): top-level fechaIda + idaHora
      if (tipoTrans==='terrestre'){
        const fIda = v?.fechaIda ? (new Date(v.fechaIda)).toISOString().slice(0,10) : '';
        const hr   = v.idaHora || '';
        (Array.isArray(v.grupos)?v.grupos:[]).forEach(gref=>{
          const gid = gref?.id; if(!gid) return;
          // en bus usamos la misma hora como presentación/inicio (si no definiste presentación aparte)
          postularHoras(gid, fIda, hr, hr);
        });
        return;
      }
    });

    // Opcional: volcar las horas al objeto GRUPOS
    GRUPOS.forEach(g=>{
      const h = HORAS_INICIO.get(g.id) || null;
      if (h) g._horasInicio = h; // pres, inicio, fuente, vueloId
    });

    console.log('[RTV/coord] HORAS_INICIO map size =', HORAS_INICIO.size);
  }catch(err){
    E('loadHorasViajes error:', err);
  }finally{
    console.timeEnd('loadHorasViajes');
  }
}

async function loadHotelAssignments(){
  console.time('loadHotelAssignments');
  HOTELES_POR_GRUPO.clear();
  HOTELS_BY_ID.clear();

  try{
    /* 1) Cargar catálogo de hoteles (colección "hoteles") */
    const snapHot = await getDocs(collection(db, 'hoteles'));
    snapHot.forEach(d=>{
      const x = d.data() || {};
      const nombre = (
        x.nombre ||
        x.Nombre ||
        x.NOMBRE ||
        x.hotelNombre ||
        ''
      ).toString().trim();

      HOTELS_BY_ID.set(d.id, nombre || '(SIN NOMBRE)');
    });
    L('loadHotelAssignments: hoteles cargados =', HOTELS_BY_ID.size);

    /* 2) Cargar asignaciones desde "hotelAssignments" */
    const snap = await getDocs(collection(db, 'hotelAssignments'));
    L('hotelAssignments size =', snap.size);

    // gid -> [{ nombre, ini, fin, ts }]
    const tmp = new Map();

    snap.forEach(d=>{
      const x = d.data() || {};

      // Resolver a qué grupo pertenece esta asignación
      const gid = resolveGrupoIdFromHotelAssignment(
        x.grupoId || x.grupo || x.groupId || x.numeroNegocio || x.negocioId
      );
      if (!gid) return;

      const g = ID2GRUPO.get(gid);
      if (!g) return;

      // Fechas de la reserva de hotel
      const ini = asISO(
        x.fechaInicio || x.fechaIni || x.inicio ||
        x.fechaEntrada || x.checkIn
      );
      const fin = asISO(
        x.fechaFin || x.fin || x.fechaSalida ||
        x.fechaFinReserva || x.checkOut
      );
      if (!ini || !fin) return;

      // Solo consideramos asignaciones que se cruzan con el rango del viaje
      if (!overlap(ini, fin, g.fechaInicio, g.fechaFin)) return;

      // Id del hotel y nombre cruzado con colección "hoteles"
      const hotelId = x.hotelId || x.hotelID || x.idHotel || null;

      let nombre = hotelId && HOTELS_BY_ID.has(hotelId)
        ? HOTELS_BY_ID.get(hotelId)
        : (
            x.hotelNombre ||
            x.hotel ||
            x.nombreHotel ||
            x.nombre ||
            ''
          ).toString().trim();

      if (!nombre) nombre = '(SIN NOMBRE)';

      // Timestamp para decidir "el último" en caso de solapes (usar updatedAt si existe, si no createdAt)
      const ts = x.updatedAt?.toDate
        ? x.updatedAt.toDate().getTime()
        : (x.createdAt?.toDate
            ? x.createdAt.toDate().getTime()
            : (x.updatedAt?.seconds
                ? x.updatedAt.seconds * 1000
                : (x.createdAt?.seconds ? x.createdAt.seconds * 1000 : 0)));

      if (!tmp.has(gid)) tmp.set(gid, []);
      tmp.get(gid).push({ nombre, ini, fin, ts });
    });

    // 3) Por cada grupo: quedarnos con el último registro por tramo, sin solapes
    for (const [gid, arr] of tmp.entries()){
      const ordered = arr
        .filter(h => h.ini && h.fin && new Date(h.ini) <= new Date(h.fin))
        .sort((a,b) => (b.ts || 0) - (a.ts || 0)); // más nuevo primero

      const picked = [];
      for (const h of ordered){
        // si se solapa con algo ya elegido, lo ignoramos porque éste es más viejo
        const choca = picked.some(p => overlap(p.ini, p.fin, h.ini, h.fin));
        if (!choca) picked.push(h);
      }

      // Ordenar cronológicamente para mostrar bonito
      picked.sort((a,b) => cmpISO(a.ini, b.ini));

      if (picked.length) HOTELES_POR_GRUPO.set(gid, picked);
    }

    L('loadHotelAssignments => grupos con hotel =', HOTELES_POR_GRUPO.size);
  }catch(err){
    E('loadHotelAssignments error:', err);
  }finally{
    console.timeEnd('loadHotelAssignments');
  }
}

async function loadSets(){
  console.time('loadSets');

  SETS = [];

  if (
    !GRUPOS.length ||
    !ID2GRUPO.size
  ) {
    W(
      'loadSets: GRUPOS vacío; reintentando loadGrupos().'
    );

    await loadGrupos();
  }

  try{
    console.groupCollapsed(
      `[SETS ${ANO_COORDINADORES}] A) collectionGroup("conjuntos")`
    );

    const mapByConj =
      new Map();

    const snap =
      await getDocs(
        collectionGroup(
          db,
          'conjuntos'
        )
      );

    L(
      'Conjuntos totales encontrados:',
      snap.size
    );

    let conjuntosAno = 0;
    let legacyUsados = 0;

    snap.forEach(d => {
      const x =
        d.data() ||
        {};

      const conjuntoId =
        d.id;

      const coordinadorId =
        d.ref.parent.parent.id;

      // Solo dejamos viajes que pertenecen
      // a los grupos del año actualmente cargado.
      const viajes =
        (
          Array.isArray(x.viajes)
            ? x.viajes
            : []
        )
          .map(String)
          .filter(
            id =>
              ID2GRUPO.has(id)
          );

      // ==================================================
      // DETERMINAR AÑO DEL CONJUNTO
      // ==================================================

      let anoConjunto =
        Number(
          x.anoViaje
        ) ||
        null;

      // ----------------------------------------------
      // COMPATIBILIDAD LEGACY
      //
      // Los conjuntos antiguos pueden no tener
      // anoViaje.
      //
      // Como GRUPOS ya contiene exclusivamente
      // ANO_COORDINADORES, podemos inferir el año
      // de los viajes que sobrevivieron al filtro.
      // ----------------------------------------------
      if (!anoConjunto) {
        const anosViajes =
          viajes
            .map(id =>
              getAnoGrupo(
                ID2GRUPO.get(id)
              )
            )
            .filter(Boolean);

        if (anosViajes.length) {
          anoConjunto =
            Number(
              anosViajes[0]
            );

          legacyUsados++;
        }
      }

      // Conjunto explícitamente de otro año:
      // no corresponde a esta vista.
      if (
        anoConjunto &&
        Number(anoConjunto) !==
          Number(ANO_COORDINADORES)
      ) {
        return;
      }

      // Si no contiene ningún grupo del año activo,
      // tampoco lo mostramos.
      if (!viajes.length) {
        return;
      }

      mapByConj.set(
        conjuntoId,
        {
          id:
            conjuntoId,

          anoViaje:
            Number(
              anoConjunto ||
              ANO_COORDINADORES
            ),

          viajes:
            viajes.slice(),

          coordinadorId,

          confirmado:
            !!x.confirmado,

          estadoCoord:
            normalizeEstado(
              x.estadoCoord ||
              'pendiente'
            ),

          alertas:
            [],

          _ownerCoordId:
            coordinadorId
        }
      );

      conjuntosAno++;
    });

    L(
      `Conjuntos usados año ${ANO_COORDINADORES}:`,
      conjuntosAno,
      '| legacy inferidos:',
      legacyUsados
    );

    console.groupEnd();

    // =====================================================
    // B) RECONSTRUCCIÓN DESDE LOS DOCUMENTOS DE GRUPO
    //
    // Esto mantiene compatibilidad si el grupo tiene
    // conjuntoId/coordinadorId pero falta el documento
    // dentro de coordinadores/{id}/conjuntos.
    // =====================================================

    console.groupCollapsed(
      `[SETS ${ANO_COORDINADORES}] B) reconstruir desde grupos`
    );

    let adds = 0;

    for (const g of GRUPOS) {
      if (!g.conjuntoId) {
        continue;
      }

      const conjuntoId =
        String(
          g.conjuntoId
        );

      if (
        !mapByConj.has(
          conjuntoId
        )
      ) {
        let coordId =
          g.coordinadorId ||
          null;

        // Legacy:
        // intentar resolver coordinador por nombre.
        if (
          !coordId &&
          g.coordinador
        ) {
          const wanted =
            (
              g.coordinador ||
              ''
            )
              .trim()
              .toLowerCase();

          const hit =
            COORDS.find(
              c =>
                (
                  c.nombre ||
                  ''
                )
                  .trim()
                  .toLowerCase() ===
                wanted
            );

          if (hit) {
            coordId =
              hit.id;
          }
        }

        mapByConj.set(
          conjuntoId,
          {
            id:
              conjuntoId,

            anoViaje:
              Number(
                g.anoViaje ||
                ANO_COORDINADORES
              ),

            viajes:
              [],

            coordinadorId:
              coordId,

            confirmado:
              true,

            estadoCoord:
              normalizeEstado(
                g.coordEstado ||
                'pendiente'
              ),

            alertas:
              [],

            _ownerCoordId:
              coordId ||
              null
          }
        );

        adds++;
      }

      const S =
        mapByConj.get(
          conjuntoId
        );

      if (
        !S.coordinadorId &&
        g.coordinadorId
      ) {
        S.coordinadorId =
          g.coordinadorId;

        S._ownerCoordId =
          g.coordinadorId;
      }

      // Si el documento del conjunto no tenía
      // estado, tomamos el del grupo como respaldo.
      if (
        (
          !S.estadoCoord ||
          S.estadoCoord === 'pendiente'
        ) &&
        g.coordEstado
      ) {
        S.estadoCoord =
          normalizeEstado(
            g.coordEstado
          );
      }

      if (
        ID2GRUPO.has(g.id) &&
        !S.viajes.includes(g.id)
      ) {
        S.viajes.push(
          g.id
        );
      }
    }

    L(
      'Conjuntos reconstruidos desde grupos:',
      adds
    );

    console.groupEnd();

    // =====================================================
    // C) VOLCAR A SETS
    // =====================================================

    SETS =
      Array.from(
        mapByConj.values()
      )
        .map(S => ({
          ...S,

          anoViaje:
            Number(
              S.anoViaje ||
              ANO_COORDINADORES
            ),

          estadoCoord:
            normalizeEstado(
              S.estadoCoord ||
              'pendiente'
            ),

          viajes:
            (
              S.viajes ||
              []
            )
              .map(String)
              .filter(
                id =>
                  ID2GRUPO.has(id)
              )
        }))
        .filter(
          S =>
            S.viajes.length > 0
        );

    L(
      `SETS preliminares ${ANO_COORDINADORES}:`,
      SETS.length,
      'Viajes:',
      SETS.reduce(
        (n, s) =>
          n +
          (
            s.viajes?.length ||
            0
          ),
        0
      )
    );

    // =====================================================
    // D) POST PROCESO
    // =====================================================

    dedupeSetsInPlace();
    sortSetsInPlace();

    populateFilterOptions();
    evaluarAlertas();
    render();

    // =====================================================
    // E) SNAPSHOT PREV — GRUPOS
    // =====================================================

    PREV.grupos.clear();

    GRUPOS.forEach(g => {
      PREV.grupos.set(
        g.id,
        {
          aliasGrupo:
            g.aliasGrupo ||
            null,

          conjuntoId:
            g.conjuntoId ||
            null,

          coordinadorId:
            g.coordinadorId ||
            null,

          coordinador:
            g.coordinador ||
            null,

          coordEstado:
            g.coordEstado ||
            null,

          anoViaje:
            Number(
              g.anoViaje ||
              ANO_COORDINADORES
            )
        }
      );
    });

    // =====================================================
    // F) SNAPSHOT PREV — SETS
    // =====================================================

    PREV.sets.clear();

    SETS.forEach(s => {
      const owner =
        s._ownerCoordId ||
        s.coordinadorId ||
        null;

      const sid =
        s.id ||
        null;

      if (
        owner &&
        sid
      ) {
        PREV.sets.set(
          `${owner}/${sid}`,
          {
            viajes:
              (
                s.viajes ||
                []
              ).slice(),

            confirmado:
              !!s.confirmado,

            estadoCoord:
              normalizeEstado(
                s.estadoCoord ||
                'pendiente'
              ),

            anoViaje:
              Number(
                s.anoViaje ||
                ANO_COORDINADORES
              ),

            owner
          }
        );
      }
    });

    L(
      `SETS finales año ${ANO_COORDINADORES}:`,
      SETS.length
    );

  }catch(err){
    E(
      'loadSets error:',
      err
    );

    throw err;

  }finally{
    console.timeEnd(
      'loadSets'
    );
  }
}

/* =========================================================
   DOM refs
   ========================================================= */
const $ = s=>document.querySelector(s);
const elWrapLibres = $('#lista-viajes-libres');
const elWrapSets   = $('#conjuntos-wrap');
const elMsg        = $('#msg');

// Filtros de catálogo (resumen/libres)
const selDestino = $('#f-destino');
const selPrograma= $('#f-programa');
const inpDesde   = $('#f-desde');
const inpHasta   = $('#f-hasta');

// Buscador de CONJUNTOS (ubícalo en la cabecera de “Viajes”)
const inpBuscarSets = $('#buscar-sets');

const inpDiaSets      = $('#f-dia-sets');
const inpBuscarLibres = $('#buscar-libres');
const inpDiaLibres    = $('#f-dia-libres');

const wrapResumen= $('#resumen-wrap');
const wrapStats  = $('#stats-viajes-wrap');

// Modal
const mb               = $('#mb');
const modal            = $('#modal-coords');
const btnOpenModal     = $('#btn-modal-coords');
const btnCloseModal    = $('#close-modal');
const btnCerrar        = $('#btn-cerrar');
const btnGuardarCoords = $('#btn-guardar-coords');
const btnAddCoord      = $('#btn-add-coord');
const btnAddLote       = $('#btn-add-lote');
const inputExcel       = $('#input-excel');
const tbodyCoords      = $('#tabla-coords tbody');
const hintEmptyCoords  = $('#hint-empty-coords');

if (!elWrapLibres || !elWrapSets){
  W('DOM contenedores no encontrados:', { elWrapLibres: !!elWrapLibres, elWrapSets: !!elWrapSets });
}

// Toolbar
$('#btn-sugerir')?.addEventListener(
  'click',
  abrirSelectorSugerencia
);
$('#btn-nuevo-conjunto')?.addEventListener(
  'click',
  () => {
    L(
      'Nuevo conjunto',
      ANO_COORDINADORES
    );

    SETS.unshift({
      anoViaje:
        Number(
          ANO_COORDINADORES
        ),

      viajes:
        [],

      coordinadorId:
        null,

      confirmado:
        false,

      estadoCoord:
        'pendiente',

      alertas:
        [],

      _isNew:
        true
    });

    render();
  }
);
$('#btn-guardar')?.addEventListener('click', ()=>withBusy($('#btn-guardar'), 'Guardando…', guardarTodo, 'Guardar cambios', '✅ Guardado'));

// Modal handlers
btnOpenModal?.addEventListener('click', ()=>{ openModal(); renderCoordsTable(); });
btnCloseModal?.addEventListener('click', closeModal);
btnCerrar?.addEventListener('click', closeModal);
btnGuardarCoords?.addEventListener('click', ()=>withBusy(btnGuardarCoords, 'Guardando…', saveCoordsModal, 'Guardar coordinadores', '✅ Guardado'));
btnAddCoord?.addEventListener('click', ()=>{
   COORDS.unshift({
     nombre:'', rut:'',
     fechaNacimiento: null,
   
     // ← NUEVO
     datosTransferir: '',
   
     telefono:'', correo:'',
     destinos:[], disponibilidad:[],
     _isNew:true
   });

  renderCoordsTable(); setTimeout(initPickers,10);
});
btnAddLote?.addEventListener('click', ()=> inputExcel.click());
inputExcel?.addEventListener('change', handleExcel);

// Filtros (catálogo)
function populateFilterOptions(){
  console.time('populateFilterOptions');
  DESTINOS = [...new Set(GRUPOS.map(g=>normDest(g.destino)).filter(Boolean))].sort();

  const dests=[...new Set(GRUPOS.map(g=>g.destino).filter(Boolean))].sort();
  const progs=[...new Set(GRUPOS.map(g=>g.programa).filter(Boolean))].sort();
  if (selDestino)  selDestino.innerHTML  = `<option value="">Todos los destinos</option>` + dests.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  if (selPrograma) selPrograma.innerHTML = `<option value="">Todos los programas</option>` + progs.map(p=>`<option>${escapeHtml(p)}</option>`).join('');

  L('populateFilterOptions:', { destinos:dests.length, programas:progs.length });

  selDestino?.addEventListener('change',  ()=>{ FILTER.destino = selDestino.value; render(); });
  selPrograma?.addEventListener('change', ()=>{ FILTER.programa= selPrograma.value; render(); });
  inpDesde?.addEventListener('change',    ()=>{ FILTER.desde   = inpDesde.value||''; render(); });
  inpHasta?.addEventListener('change',    ()=>{ FILTER.hasta   = inpHasta.value||''; render(); });

   // — Asignados (SETS): día exacto
   inpDiaSets?.addEventListener('change', ()=>{
     FILTER_SETS.day = inpDiaSets.value || '';
     renderSets(); // refrescar solo los SETS
   });
   
   // — Libres: buscador (sin tildes gracias a norm())
   inpBuscarLibres?.addEventListener('input', ()=>{
     SEARCH_LIBRES.tokens = parseTokens(inpBuscarLibres.value);
     renderLibres(); // refrescar libres
   });
   
   // — Libres: día exacto
   inpDiaLibres?.addEventListener('change', ()=>{
     FILTER_LIBRES.day = inpDiaLibres.value || '';
     renderLibres();
   });

  inpBuscarSets?.addEventListener('input', ()=>{
    SEARCH.tokens = parseTokens(inpBuscarSets.value);
    L('Buscar conjuntos tokens:', SEARCH.tokens);
    renderSets();
  });
  console.timeEnd('populateFilterOptions');
}

/* =========================================================
   Utils generales
   ========================================================= */
function withBusy(btn, busyText, fn, normalText, okText){
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  Promise.resolve(fn()).then(()=>{
    btn.textContent = okText || 'Listo';
    setTimeout(()=>{ btn.textContent = normalText || prev; btn.disabled=false; }, 900);
  }).catch(err=>{
    E('withBusy error:', err);
    btn.textContent = '❌ Error';
    setTimeout(()=>{ btn.textContent = normalText || prev; btn.disabled=false; }, 1500);
    alert('Ocurrió un error. Revisa la consola.');
  });
}

function normalizarFechasGrupo(x){
  // Helpers seguros a ISO (YYYY-MM-DD)
  const toISO = d => (new Date(d)).toISOString().slice(0,10);
  const asISO = (v)=>{
    if (!v) return null;
    if (typeof v === 'string'){ const d = new Date(v); return isNaN(d) ? null : toISO(d); }
    if (v?.toDate)  return toISO(v.toDate());
    if (v?.seconds) return toISO(new Date(v.seconds*1000));
    if (v instanceof Date) return toISO(v);
    return null;
  };
  const addDaysISO = (iso, n) => { const D=new Date(iso+'T00:00:00'); D.setDate(D.getDate()+n); return toISO(D); };

  // Nombres de campos que solemos ver
  let ini=asISO(
    x.fechaInicio ?? x.fecha_inicio ?? x.inicio ??
    x.fecha ?? x.fechaDeViaje ?? x.fechaViaje ?? x.fechaInicioViaje
  );
  let fin=asISO(
    x.fechaFin ?? x.fecha_fin ?? x.fin ??
    x.fechaFinal ?? x.fechaFinViaje
  );

  // Derivar desde itinerario { 'YYYY-MM-DD': {...} }
  if ((!ini || !fin) && x.itinerario && typeof x.itinerario==='object'){
    const ks=Object.keys(x.itinerario).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    if (ks.length){ ini = ini || ks[0]; fin = fin || ks[ks.length-1]; }
  }

  // Calcular fin desde duración/noches
  if (ini && !fin && (x.duracion || x.noches)){
    const days = Number(x.duracion) || (Number(x.noches)+1) || 1;
    fin = addDaysISO(ini, days-1);
  }

  // Normalizaciones finales
  if (ini && !fin) fin = ini;
  if (fin && !ini) ini = fin;

  return { ini, fin };
}

function sortSetsInPlace(){
  const news = SETS.filter(s=>s._isNew);
  const olds = SETS.filter(s=>!s._isNew);
  olds.sort((A,B)=>{
    const nA=A.viajes?.length||0, nB=B.viajes?.length||0;
    if (nA!==nB) return nB-nA;
    const fA=firstStartISO(A)||'9999-12-31', fB=firstStartISO(B)||'9999-12-31';
    return cmpISO(fA,fB);
  });
  SETS.length=0; SETS.push(...news,...olds);
}
function firstStartISO(s){
  const viajes=(s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean).sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
  return viajes[0]?.fechaInicio || null;
}
function norm(s){
  return (s ?? '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita tildes/diacríticos
    .trim()
    .toLowerCase();
}
function parseTokens(s){ return (s||'').split(',').map(t=>norm(t)).filter(Boolean); }

function gruposFiltrados(arr=GRUPOS){
  return arr.filter(g=>{
    if (FILTER.destino && !norm(g.destino).includes(norm(FILTER.destino))) return false;
    if (FILTER.programa && !norm(g.programa).includes(norm(FILTER.programa))) return false;
    if (FILTER.desde && g.fechaInicio < FILTER.desde) return false;
    if (FILTER.hasta && g.fechaInicio > FILTER.hasta) return false;
    return true;
  });
}

// Conjuntos filtrados por SEARCH.tokens (AND entre tokens)
function setsFiltrados(arr=SETS){
  const toks = SEARCH.tokens || [];
  const day  = FILTER_SETS.day || '';

  // 1) Filtro por día (si hay valor)
  const base = day
    ? arr.filter(s=>{
        const viajes = (s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean);
        return viajes.some(v => v && v.fechaInicio === day);
      })
    : arr;

  // 2) Filtro por texto (tokens AND)
  if (!toks.length) return base;

  return base.filter(s=>{
    const coordName = s.coordinadorId ? (COORDS.find(c=>c.id===s.coordinadorId)?.nombre||'') : '';
    const viajes = (s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean);

    const hay = [];
    hay.push(norm(coordName));
    viajes.forEach(v=>{
      hay.push(
        norm(v.aliasGrupo),
        norm(v.nombreGrupo),
        norm('#'+(v.numeroNegocio||'')),
        norm(v.identificador),
        norm(v.programa),
        norm(v.destino),
        norm(v.id||'')
      );
      hay.push(norm(fmtDMY(v.fechaInicio)), norm(fmtDMY(v.fechaFin)));
      hay.push(norm(v.fechaInicio), norm(v.fechaFin));
    });

    return toks.every(tok => hay.some(h => h && h.includes(tok)));
  });
}

function filtrarLibresBusquedaYDia(arr){
  const toks = SEARCH_LIBRES.tokens || [];
  const day  = FILTER_LIBRES.day || '';

  const base = day ? arr.filter(g => g.fechaInicio === day) : arr;

  if (!toks.length) return base;

  return base.filter(g=>{
    const hay = [
      norm(g.aliasGrupo),
      norm(g.nombreGrupo),
      norm('#'+(g.numeroNegocio||'')),
      norm(g.identificador),
      norm(g.programa),
      norm(g.destino),
      norm(g.id||''),
      norm(fmtDMY(g.fechaInicio)),
      norm(fmtDMY(g.fechaFin)),
      norm(g.fechaInicio),
      norm(g.fechaFin)
    ];
    return toks.every(tok => hay.some(h => h && h.includes(tok)));
  });
}

/* =========================================================
   BLOQUEO por confirmación (coordinadores ya en uso)
   ========================================================= */
function getBlockedCoordIds(exceptSetIdx = null){
  const blocked = new Set();

  // Si no estamos evaluando un set concreto,
  // no podemos determinar choques de fechas.
  if (
    exceptSetIdx === null ||
    !SETS[exceptSetIdx]
  ) {
    return blocked;
  }

  const setActual =
    SETS[exceptSetIdx];

  const viajesActual =
    (
      setActual.viajes ||
      []
    )
      .map(
        id =>
          ID2GRUPO.get(id)
      )
      .filter(Boolean);

  if (!viajesActual.length) {
    return blocked;
  }

  // =====================================================
  // REVISAR OTROS SETS CONFIRMADOS
  // =====================================================

  SETS.forEach(
    (otroSet, idx) => {
      if (
        idx === exceptSetIdx
      ) {
        return;
      }

      if (
        !otroSet.confirmado ||
        !otroSet.coordinadorId
      ) {
        return;
      }

      const viajesOtro =
        (
          otroSet.viajes ||
          []
        )
          .map(
            id =>
              ID2GRUPO.get(id)
          )
          .filter(Boolean);

      if (!viajesOtro.length) {
        return;
      }

      const hayChoque =
        viajesActual.some(
          a =>
            viajesOtro.some(
              b =>
                overlap(
                  a.fechaInicio,
                  a.fechaFin,
                  b.fechaInicio,
                  b.fechaFin
                )
            )
        );

      if (hayChoque) {
        blocked.add(
          otroSet.coordinadorId
        );
      }
    }
  );

  L(
    'Blocked coordIds por choque real (except',
    exceptSetIdx,
    '):',
    blocked.size
  );

  return blocked;
}

/* =========================================================
   Render
   ========================================================= */
function render(){
  console.time('render');
  sortSetsInPlace();
  renderResumen();
  renderLibres();
  renderSets();
  renderViajesStats();
  elMsg && (elMsg.textContent='');
  console.timeEnd('render');
}

function renderResumen(){
  console.groupCollapsed('renderResumen');
  const arr=gruposFiltrados(GRUPOS);
  L('Resumen sobre grupos filtrados:', arr.length, '(de', GRUPOS.length, ')');
  const by=(fn)=>arr.reduce((m,g)=>{ const k=fn(g)||'(sin dato)'; m[k]=(m[k]||0)+1; return m; },{});
  const tDest=by(g=>g.destino);
  const tProg=by(g=>g.programa);
  const tIniISO=by(g=>g.fechaInicio);
  const tIniDMY={}; Object.entries(tIniISO).forEach(([iso,c])=>{ tIniDMY[fmtDMY(iso)]=c; });

  const mk=(title,obj)=>`
    <div class="panel" style="min-width:260px">
      <div class="hd">${title}</div>
      <div class="bd">
        ${Object.keys(obj).length?`
        <table><thead><tr><th>Clave</th><th style="width:72px">Total</th></tr></thead>
        <tbody>${Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>
        `:`<div class="empty">Sin datos.</div>`}
      </div>
    </div>`;
  wrapResumen && (wrapResumen.innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${mk('Por destino',tDest)}
      ${mk('Por fecha de inicio',tIniDMY)}
      ${mk('Por programa',tProg)}
    </div>`);
  console.groupEnd();
}

function viajesUsadosSetIds(){
  const conteo =
    new Map();


  SETS.forEach(s => {
    const vistosSet =
      new Set();

    (
      s.viajes ||
      []
    ).forEach(gid => {
      if (
        vistosSet.has(
          gid
        )
      ) {
        return;
      }

      vistosSet.add(
        gid
      );

      conteo.set(
        gid,
        (
          conteo.get(gid) ||
          0
        ) + 1
      );
    });
  });


  const completos =
    new Set();


  for (
    const g
    of GRUPOS
  ) {
    const usados =
      conteo.get(
        g.id
      ) ||
      0;

    const requeridos =
      getCantidadCoordinadoresGrupo(
        g
      );


    if (
      usados >=
      requeridos
    ) {
      completos.add(
        g.id
      );
    }
  }


  return completos;
}

function renderLibres(){
  console.groupCollapsed('renderLibres');
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  // 1) Aplico catálogo (destino/programa/desde/hasta)
  const pre = gruposFiltrados(libresAll);
  // 2) Aplico búsqueda y día específico para LIBRES
  const libres = filtrarLibresBusquedaYDia(pre);
  L('Libres:', libres.length, 'Usados en sets:', usados.size, 'Grupos totales:', GRUPOS.length);
  if (!elWrapLibres){ W('elWrapLibres no existe'); console.groupEnd(); return; }
  
  if (!libres.length){
    elWrapLibres.innerHTML = '<div class="empty">No hay viajes libres.</div>';
    console.groupEnd();
    return;
  }

  elWrapLibres.innerHTML = libres.map(g=>`
    <div class="card">
      <div class="hd">
        <div>
          <b title="${escapeHtml(g.nombreGrupo||'')}">
            ${g.aliasGrupo || '(sin alias)'}
          </b>
          <span class="muted">#${g.numeroNegocio}</span>
        </div>
        <button class="btn small" data-add="${g.id}">Agregar a viaje…</button>
      </div>
      <div class="bd">
        <div class="muted">
           ${fmtDMY(g.fechaInicio)} a ${fmtDMY(g.fechaFin)}
           ${g._horasInicio && (g._horasInicio.pres || g._horasInicio.inicio)
             ? ` · ${g._horasInicio.pres ? 'Pres ' + g._horasInicio.pres : ''}${(g._horasInicio.pres && g._horasInicio.inicio)?' · ':''}${g._horasInicio.inicio ? 'Salida ' + g._horasInicio.inicio : ''}`
             : ''}
        </div>
        <div class="muted">
          ${g.identificador?`ID: ${escapeHtml(g.identificador)} · `:''}
          ${g.programa?`Prog: ${escapeHtml(g.programa)} · `:''}
          ${g.destino?`Dest: ${escapeHtml(g.destino)}`:''}
        </div>
        ${getHotelResumenHtmlForGroup(g)}
      </div>
    </div>`).join('');

  elWrapLibres.querySelectorAll('button[data-add]').forEach(b=> b.onclick=()=>seleccionarConjuntoDestino(b.dataset.add));
  console.groupEnd();
}

function renderSets(){
  console.groupCollapsed('renderSets');
  if (!elWrapSets){ W('elWrapSets no existe'); console.groupEnd(); return; }
  const list = setsFiltrados(SETS);
  L('SETS visibles:', list.length, 'SETS totales:', SETS.length);
  if (!list.length){ elWrapSets.innerHTML='<div class="empty">Sin viajes asignados (sin resultados en la búsqueda).</div>'; console.groupEnd(); return; }

  elWrapSets.innerHTML='';
  list.forEach((s)=>{
    const idx = SETS.indexOf(s);
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
    const setDestinos = [...new Set(viajes.map(v=>normDest(v.destino)).filter(Boolean))];

      const rows = viajes.map(v => {
        const cobertura =
          getCoberturaGrupo(
            v.id
          );
      
        return `
            <tr>
              <td style="width:36%">
                <input
                  type="text"
                  class="${estadoClass(s.estadoCoord)}"
                  data-alias="${v.id}"
                  value="${v.aliasGrupo||''}"
                  title="${escapeHtml(v.nombreGrupo||'')}"
                >
              </td>
              <td style="width:24%">
                 ${fmtDMY(v.fechaInicio)} → ${fmtDMY(v.fechaFin)}
                 ${v._horasInicio && (v._horasInicio.pres || v._horasInicio.inicio)
                   ? `<div class="muted" style="margin-top:.2rem">
                        ${v._horasInicio.pres ? 'Pres ' + v._horasInicio.pres : ''}
                        ${(v._horasInicio.pres && v._horasInicio.inicio)?' · ':''}
                        ${v._horasInicio.inicio ? 'Salida ' + v._horasInicio.inicio : ''}
                      </div>`
                   : ''}
               </td>
              <td style="width:40%">
                <div class="muted">#${v.numeroNegocio}</div>
                ${v.identificador?`<div class="muted">ID: ${escapeHtml(v.identificador)}</div>`:''}
                ${v.programa?`<div class="muted">Programa: ${escapeHtml(v.programa)}</div>`:''}
                  ${v.destino
                    ? `<div class="muted">Destino: ${escapeHtml(v.destino)}</div>`
                    : ''
                  }
                  
                  <div
                    class="muted"
                    style="
                      margin-top:.25rem;
                      font-weight:600;
                    "
                  >
                    Coordinadores:
                    ${cobertura.usados}/${cobertura.requeridos}
                  
                    ${
                      cobertura.confirmados
                        ? ` · ${cobertura.confirmados} confirmado${cobertura.confirmados === 1 ? '' : 's'}`
                        : ''
                    }
                  </div>
                  
                  ${getHotelResumenHtmlForGroup(v)}
              </td>
            </tr>

            <tr><td colspan="3">
              <div class="row">
                <button class="btn small" data-swap="${v.id}" data-set="${idx}">Swap</button>
                <button class="btn small" data-move="${v.id}" data-set="${idx}">Mover…</button>
                <button class="btn small" data-del="${v.id}" data-set="${idx}">Quitar</button>
              </div>
            </td></tr>
          `;
          }).join('');

    const blocked = getBlockedCoordIds(idx);
    const opts=['<option value="">(Seleccionar)</option>'].concat(
      COORDS
        .slice()
        .sort((a,b)=>(a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}))
        .filter(c => !blocked.has(c.id) || c.id===s.coordinadorId)
        .map(c=>{
          const apto = setDestinos.every(d => isAptoDestino(c, d));
          const name = escapeHtml(c.nombre||'(sin nombre)') + (apto ? '' : ' (NO APTO)');
          const sel  = (s.coordinadorId===c.id)?'selected':'';
          return `<option value="${c.id}" ${sel}>${name}</option>`;
        })
    ).join('');

    const alertas=s.alertas||[];
    const alertHtml = alertas.length
      ? `<div>${alertas.map(a=>`<div class="${a.tipo==='err'?'err':'warn'}">• ${a.msg}</div>`).join('')}</div>`
      : '<div class="muted">Sin alertas.</div>';

    elWrapSets.insertAdjacentHTML('beforeend',`
      <div class="card">
        <div class="hd">
          <div class="row">
            <span class="tag">VIAJES ${idx+1}</span>
            ${s._isNew?'<span class="pill">Nuevo</span>':''}
            ${s.confirmado?'<span class="pill">Confirmado</span>':''}
          </div>
          <div class="row">
            <select data-coord="${idx}" title="Coordinador del viaje" style="${estadoBgStyle(s.estadoCoord)}">${opts}</select>
            <button class="btn small" data-addv="${idx}">Agregar viaje</button>
            <button class="btn small" data-sugerirc="${idx}">Sugerir coord</button>
            <button class="btn small ${s.confirmado?'secondary':''}" data-confirm="${idx}">${s.confirmado?'Desconfirmar':'Confirmar'}</button>
            
            <button class="btn small" data-estado="${idx}" title="Estado: ${estadoLabel(s.estadoCoord||'pendiente')}">
              ${estadoIcon(s.estadoCoord||'pendiente')} ${estadoLabel(s.estadoCoord||'pendiente')}
            </button>
            
            <button class="btn small" data-saveone="${idx}">💾 Guardar</button>
            <button class="btn small" data-delset="${idx}">Eliminar</button>

          </div>
        </div>
        <div class="bd">
          ${viajes.length?`
            <table>
              <thead><tr><th>Alias</th><th>Fechas</th><th>Info</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`:`<div class="empty">Sin viajes en este grupo.</div>`}
          <div style="margin-top:.5rem">${alertHtml}</div>
        </div>
      </div>`);
  });

  elWrapSets.querySelectorAll('input[data-alias]').forEach(inp=>{
    inp.onchange=()=>{ const g=ID2GRUPO.get(inp.dataset.alias); if(g){ g.aliasGrupo=inp.value; } };
  });
  elWrapSets.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick=()=>{ 
     const i=+btn.dataset.set;   
     SETS[i].viajes = SETS[i].viajes.filter(id => id !== btn.dataset.del); 
     SETS[i].estadoCoord='pendiente';
     refreshSets(); 
   };
  });
  elWrapSets.querySelectorAll('button[data-move]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set; moverViajeAotroConjunto(btn.dataset.move,i); };
  });
  elWrapSets.querySelectorAll('button[data-addv]').forEach(btn=>{
    btn.onclick=()=>agregarViajeAConjunto(+btn.dataset.addv);
  });
  elWrapSets.querySelectorAll('button[data-delset]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.delset; if(!confirm('¿Eliminar este grupo de viajes?'))return; SETS.splice(i,1); refreshSets(); };
  });
  elWrapSets.querySelectorAll('button[data-sugerirc]').forEach(btn=>{
    btn.onclick=()=>sugerirCoordinador(+btn.dataset.sugerirc);
  });
  elWrapSets.querySelectorAll('button[data-confirm]').forEach(btn=>{
    btn.onclick=()=>{ 
     const i=+btn.dataset.confirm; 
     const newVal = !SETS[i].confirmado; 
     SETS[i].confirmado = newVal; 
     if (!newVal) SETS[i].estadoCoord = 'pendiente';
     refreshSets(); 
   };
  });
  elWrapSets.querySelectorAll('select[data-coord]').forEach(sel=>{
    sel.onchange=()=>{ const i=+sel.dataset.coord; SETS[i].coordinadorId = sel.value||null; SETS[i].estadoCoord='pendiente'; refreshSets(); };
  });

  elWrapSets.querySelectorAll('button[data-swap]').forEach(btn=>{
    btn.onclick=()=>{ const setIdx=+btn.dataset.set; const gid=btn.dataset.swap; handleSwapClick(setIdx,gid,btn); };
  });

   elWrapSets.querySelectorAll('button[data-saveone]').forEach(btn=>{
     btn.onclick = () => withBusy(
       btn,
       'Guardando…',
       () => guardarSet(+btn.dataset.saveone),
       '💾 Guardar',
       '✅ Guardado'
     );
   });

   // Triestado: rotar Pendiente → Aprobado → Rechazado
   elWrapSets.querySelectorAll('button[data-estado]').forEach(btn=>{
     btn.onclick = () => {
       const i = +btn.dataset.estado;
       const s = SETS[i];
       s.estadoCoord = nextEstado(s.estadoCoord);
       refreshSets();
     };
   });

  document.body.addEventListener('click', e=>{
    if (!e.target.closest('button[data-swap]')){
      swapMode=false; swapFirst=null;
      elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap'));
    }
  }, true);
  console.groupEnd();
}

/* =========================================================
   Sugeridor (respeta confirmados memoria + persistido)
   ========================================================= */
/* =========================================================
   SUGERIDORES DE GRUPOS DE VIAJE
   ========================================================= */


/* =========================================================
   SELECTOR DE ESTRATEGIA
   ========================================================= */

function abrirSelectorSugerencia(){
  document
    .getElementById(
      'modal-estrategia-sugerencia'
    )
    ?.remove();

  const overlay =
    document.createElement(
      'div'
    );

  overlay.id =
    'modal-estrategia-sugerencia';

  overlay.style.cssText = `
    position:fixed;
    inset:0;
    z-index:99999;
    background:rgba(15,23,42,.48);
    display:flex;
    align-items:center;
    justify-content:center;
    padding:20px;
  `;

  overlay.innerHTML = `
    <div
      style="
        width:min(620px, 100%);
        background:#fff;
        border-radius:14px;
        box-shadow:0 20px 60px rgba(0,0,0,.25);
        padding:20px;
      "
    >
      <div
        style="
          font-size:20px;
          font-weight:700;
          margin-bottom:6px;
        "
      >
        Sugerir grupos de viajes
      </div>

      <div
        style="
          color:#64748b;
          margin-bottom:18px;
          line-height:1.4;
        "
      >
        Selecciona la estrategia que quieres usar para los viajes todavía no confirmados.
      </div>

      <div
        style="
          display:grid;
          gap:12px;
        "
      >

        <button
          type="button"
          data-estrategia="continuidad"
          style="
            text-align:left;
            padding:15px;
            border:1px solid #cbd5e1;
            border-radius:10px;
            background:#fff;
            cursor:pointer;
          "
        >
          <strong>
            Optimizar continuidad
          </strong>

          <div
            style="
              margin-top:4px;
              color:#64748b;
              font-size:13px;
              line-height:1.4;
            "
          >
            Mantiene la lógica original: encadena cronológicamente los viajes y aprovecha al máximo cada grupo de viajes.
          </div>
        </button>

        <button
          type="button"
          data-estrategia="temporada"
          style="
            text-align:left;
            padding:15px;
            border:1px solid #cbd5e1;
            border-radius:10px;
            background:#fff;
            cursor:pointer;
          "
        >
          <strong>
            Optimizar temporada y cantidad de grupos
          </strong>

          <div
            style="
              margin-top:4px;
              color:#64748b;
              font-size:13px;
              line-height:1.4;
            "
          >
            Busca primero generar la menor cantidad posible de grupos de viaje,
            prioriza que la mayoría tenga 2 viajes, respeta las reglas especiales
            de septiembre, octubre, noviembre y OTRO, y después optimiza los días de descanso.
          </div>
        </button>

      </div>

      <div
        style="
          display:flex;
          justify-content:flex-end;
          margin-top:16px;
        "
      >
        <button
          type="button"
          data-cerrar
          class="btn secondary"
        >
          Cancelar
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(
    overlay
  );

  const cerrar = () => {
    overlay.remove();
  };

  overlay
    .querySelector(
      '[data-cerrar]'
    )
    ?.addEventListener(
      'click',
      cerrar
    );

  overlay.addEventListener(
    'click',
    e => {
      if (
        e.target === overlay
      ) {
        cerrar();
      }
    }
  );

  overlay
    .querySelector(
      '[data-estrategia="continuidad"]'
    )
    ?.addEventListener(
      'click',
      () => {
        cerrar();

        sugerirConjuntosContinuidad();
      }
    );

  overlay
    .querySelector(
      '[data-estrategia="temporada"]'
    )
    ?.addEventListener(
      'click',
      () => {
        cerrar();

        sugerirConjuntosTemporada();
      }
    );
}

/* =========================================================
   OBTENER SETS FIJOS
   ========================================================= */

function obtenerBaseSugerencia(){
  // =====================================================
  // 1) CONSERVAR SETS CONFIRMADOS
  // =====================================================

  const fixedSetsMem =
    SETS.filter(
      s =>
        s.confirmado &&
        !!s.coordinadorId
    );


  // =====================================================
  // 2) CUÁNTOS CUPOS YA ESTÁN CONFIRMADOS
  // =====================================================

  const confirmadosPorGrupo =
    new Map();


  fixedSetsMem.forEach(s => {
    const vistos =
      new Set();

    (
      s.viajes ||
      []
    ).forEach(gid => {
      if (
        vistos.has(
          gid
        )
      ) {
        return;
      }

      vistos.add(
        gid
      );

      confirmadosPorGrupo.set(
        gid,
        (
          confirmadosPorGrupo.get(
            gid
          ) ||
          0
        ) + 1
      );
    });
  });


  // =====================================================
  // 3) CREAR UN ELEMENTO POR CADA CUPO PENDIENTE
  //
  // Ejemplo:
  //
  // grupo A necesita 3
  // ya tiene 1 confirmado
  //
  // pool recibe:
  // A-cupo-2
  // A-cupo-3
  //
  // Los dos objetos siguen teniendo id=A,
  // porque el SET finalmente guarda el ID real del grupo.
  // =====================================================

  const pool =
    [];


  for (
    const g
    of GRUPOS
  ) {
    const requeridos =
      getCantidadCoordinadoresGrupo(
        g
      );

    const confirmados =
      confirmadosPorGrupo.get(
        g.id
      ) ||
      0;

    const faltan =
      Math.max(
        0,
        requeridos -
        confirmados
      );


    for (
      let cupo = 0;
      cupo < faltan;
      cupo++
    ) {
      pool.push({
        ...g,

        _cupoCoordinador:
          confirmados +
          cupo +
          1,

        _slotKey:
          `${g.id}__${confirmados + cupo + 1}`
      });
    }
  }


  pool.sort(
    (a, b) =>
      cmpISO(
        a.fechaInicio,
        b.fechaInicio
      )
  );


  L(
    'obtenerBaseSugerencia:',
    {
      grupos:
        GRUPOS.length,

      cuposPendientes:
        pool.length,

      confirmados:
        fixedSetsMem.length
    }
  );


  return {
    fixedSetsMem,

    // Lo dejamos por compatibilidad
    // con las funciones sugeridoras actuales.
    fixedFromGruposFiltered:
      [],

    pool
  };
}


/* =========================================================
   ESTRATEGIA 1
   CONTINUIDAD
   = lógica que ya tenías
   ========================================================= */

function sugerirConjuntosContinuidad(){
  console.groupCollapsed(
    'sugerirConjuntosContinuidad'
  );

  try{
    const {
      fixedSetsMem,
      fixedFromGruposFiltered,
      pool
    } =
      obtenerBaseSugerencia();


    L(
      'Pool continuidad:',
      pool.length
    );


    const work =
      [];


    for (
      const g
      of pool
    ) {
      let best =
        -1;

      let bestAvail =
        null;


      for (
        let i = 0;
        i < work.length;
        i++
      ) {
        const s =
          work[i];


        // =================================================
        // MUY IMPORTANTE — MULTI COORDINADOR
        //
        // Dos cupos del mismo grupo NUNCA pueden quedar
        // dentro del mismo grupo de viajes.
        //
        // Un grupo de viajes representa la agenda
        // de UNA sola persona.
        // =================================================

        if (
          (
            s.viajes ||
            []
          ).includes(
            g.id
          )
        ) {
          continue;
        }


        const gap =
          gapDays(
            s.lastFin,
            g.fechaInicio
          );


        const ok =
          (
            gap >= 1
          ) ||
          (
            gap === 0 &&
            s.zeroChain < 2
          );


        if (!ok) {
          continue;
        }


        const avail =
          addDaysISO(
            s.lastFin,
            1
          );


        if (
          best === -1 ||
          cmpISO(
            avail,
            bestAvail
          ) < 0
        ) {
          best =
            i;

          bestAvail =
            avail;
        }
      }


      // ===================================================
      // NO ENCONTRÓ SET COMPATIBLE
      // ===================================================

      if (
        best === -1
      ) {
        work.push({
          viajes:
            [g.id],

          lastFin:
            g.fechaFin,

          zeroChain:
            0,

          // Sólo para depuración.
          slots:
            [
              g._slotKey ||
              `${g.id}__1`
            ]
        });


      // ===================================================
      // AGREGAR A SET EXISTENTE
      // ===================================================

      } else {
        const s =
          work[best];


        const gap =
          gapDays(
            s.lastFin,
            g.fechaInicio
          );


        s.viajes.push(
          g.id
        );


        s.slots ||= [];

        s.slots.push(
          g._slotKey ||
          `${g.id}__1`
        );


        s.zeroChain =
          gap === 0
            ? s.zeroChain + 1
            : 0;


        s.lastFin =
          g.fechaFin;
      }
    }


    // =====================================================
    // CONVERTIR A SETS
    // =====================================================

    const suggested =
      work.map(
        w => ({
          anoViaje:
            Number(
              ANO_COORDINADORES
            ),

          viajes:
            [
              ...new Set(
                w.viajes
              )
            ],

          coordinadorId:
            null,

          confirmado:
            false,

          estadoCoord:
            'pendiente',

          alertas:
            [],

          _isNew:
            true,

          estrategiaSugerencia:
            'continuidad'
        })
      );


    SETS =
      fixedSetsMem
        .concat(
          fixedFromGruposFiltered
        )
        .concat(
          suggested
        );


    dedupeSetsInPlace();

    sortSetsInPlace();

    evaluarAlertas();

    render();


    L(
      'Continuidad generó:',
      suggested.length,
      'grupos de viajes',
      '| cupos procesados:',
      pool.length
    );


  }finally{
    console.groupEnd();
  }
}

/* =========================================================
   CLASIFICACIÓN POR TEMPORADA
   ========================================================= */

/* =========================================================
   ESTRATEGIA TEMPORADA
   ========================================================= */


/* =========================================================
   CLASIFICAR TIPO DE VIAJE
   ========================================================= */

function clasificarTipoViajeTemporada(g){
  if (!g) {
    return {
      tipo:
        'UNIDAD',

      individual:
        true
    };
  }

  // =====================================================
  // OTRO
  //
  // Siempre es grupo de viaje independiente.
  // Puede después compartir coordinador con otro SET,
  // pero nunca comparte este mismo SET.
  // =====================================================

  if (
    normDest(
      g.destino
    ) === 'OTRO'
  ) {
    return {
      tipo:
        'OTRO',

      individual:
        true
    };
  }

  const ini =
    String(
      g.fechaInicio ||
      ''
    );

  const fin =
    String(
      g.fechaFin ||
      ''
    );

  const mesIni =
    Number(
      ini.slice(
        5,
        7
      )
    );

  const mesFin =
    Number(
      fin.slice(
        5,
        7
      )
    );

  // =====================================================
  // SEPTIEMBRE ESPECIAL
  //
  // Cualquier viaje que EMPIEZA O TERMINA en septiembre.
  //
  // Puede combinarse con TEMPORADA.
  // No puede combinarse con:
  // - otro septiembre
  // - octubre puro
  // - noviembre puro
  // =====================================================

  if (
    mesIni === 9 ||
    mesFin === 9
  ) {
    return {
      tipo:
        'SEPTIEMBRE',

      individual:
        false
    };
  }

  // =====================================================
  // OCTUBRE PURO
  //
  // Empieza Y termina en octubre.
  // =====================================================

  if (
    mesIni === 10 &&
    mesFin === 10
  ) {
    return {
      tipo:
        'OCTUBRE',

      individual:
        false
    };
  }

  // =====================================================
  // NOVIEMBRE PURO
  //
  // Empieza Y termina en noviembre.
  // =====================================================

  if (
    mesIni === 11 &&
    mesFin === 11
  ) {
    return {
      tipo:
        'NOVIEMBRE',

      individual:
        false
    };
  }

  // =====================================================
  // TEMPORADA
  //
  // CASO 1:
  // empieza en noviembre y termina en diciembre.
  //
  // CASO 2:
  // empieza y termina en diciembre.
  // =====================================================

  if (
    (
      mesIni === 11 &&
      mesFin === 12
    ) ||
    (
      mesIni === 12 &&
      mesFin === 12
    )
  ) {
    return {
      tipo:
        'TEMPORADA',

      individual:
        false
    };
  }

  // =====================================================
  // CUALQUIER OTRO CASO
  //
  // Por seguridad queda como unidad independiente.
  // =====================================================

  return {
    tipo:
      'UNIDAD',

    individual:
      true
  };
}


/* =========================================================
   COMPATIBILIDAD ENTRE TIPOS
   ========================================================= */

function sonTiposCompatiblesTemporada(
  tipoA,
  tipoB
){
  if (
    !tipoA ||
    !tipoB
  ) {
    return false;
  }

  // OTRO / UNIDAD:
  // nunca comparten grupo de viajes.
  if (
    tipoA === 'OTRO' ||
    tipoB === 'OTRO' ||
    tipoA === 'UNIDAD' ||
    tipoB === 'UNIDAD'
  ) {
    return false;
  }

  // =====================================================
  // TEMPORADA + TEMPORADA
  // =====================================================

  if (
    tipoA === 'TEMPORADA' &&
    tipoB === 'TEMPORADA'
  ) {
    return true;
  }

  // =====================================================
  // ESPECIALES + TEMPORADA
  //
  // Septiembre + temporada
  // Octubre puro + temporada
  // Noviembre puro + temporada
  // =====================================================

  const especiales =
    new Set([
      'SEPTIEMBRE',
      'OCTUBRE',
      'NOVIEMBRE'
    ]);

  if (
    tipoA === 'TEMPORADA' &&
    especiales.has(
      tipoB
    )
  ) {
    return true;
  }

  if (
    tipoB === 'TEMPORADA' &&
    especiales.has(
      tipoA
    )
  ) {
    return true;
  }

  // =====================================================
  // ENTRE ESPECIALES NO SE COMBINAN
  // =====================================================

  return false;
}


/* =========================================================
   COMPATIBILIDAD REAL ENTRE DOS VIAJES
   ========================================================= */

function sonViajesCompatiblesTemporada(
  A,
  B
){
  if (
    !A ||
    !B ||
    A.id === B.id
  ) {
    return false;
  }

  const tipoA =
    clasificarTipoViajeTemporada(
      A
    );

  const tipoB =
    clasificarTipoViajeTemporada(
      B
    );

  if (
    tipoA.individual ||
    tipoB.individual
  ) {
    return false;
  }

  if (
    !sonTiposCompatiblesTemporada(
      tipoA.tipo,
      tipoB.tipo
    )
  ) {
    return false;
  }

  const ordenados =
    [A, B]
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const primero =
    ordenados[0];

  const segundo =
    ordenados[1];

  // =====================================================
  // SOLAPE REAL:
  // PROHIBIDO.
  // =====================================================

  if (
    overlap(
      primero.fechaInicio,
      primero.fechaFin,
      segundo.fechaInicio,
      segundo.fechaFin
    )
  ) {
    return false;
  }

  const gap =
    gapDays(
      primero.fechaFin,
      segundo.fechaInicio
    );

  return gap >= 0;
}


/* =========================================================
   INFORMACIÓN / PUNTAJE DE UNA PAREJA
   ========================================================= */

function puntuarParejaViajes(
  A,
  B
){
  if (
    !sonViajesCompatiblesTemporada(
      A,
      B
    )
  ) {
    return null;
  }

  const viajes =
    [A, B]
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const gap =
    gapDays(
      viajes[0].fechaFin,
      viajes[1].fechaInicio
    );

  return {
    viajes,

    gap,

    descansoCompleto:
      gap >= 1
        ? 1
        : 0,

    // El descanso es un desempate.
    // No debe ganarle a formar más parejas.
    scoreDescanso:
      Math.min(
        Math.max(
          gap,
          0
        ),
        60
      )
  };
}


/* =========================================================
   CALIDAD DE UNA PAREJA
   ========================================================= */

function scoreCalidadPareja(
  A,
  B
){
  const p =
    puntuarParejaViajes(
      A,
      B
    );

  if (!p) {
    return -Infinity;
  }

  // Tener al menos 1 día completo
  // pesa más que tener simplemente más días.
  return (
    (
      p.descansoCompleto
        ? 1000
        : 0
    ) +
    p.scoreDescanso
  );
}


/* =========================================================
   CONTAR CUÁNTOS VIAJES TODAVÍA TIENEN OPCIÓN
   DE SER EMPAREJADOS
   ========================================================= */

function contarViajesConParejaPosible(
  grupos
){
  let total =
    0;

  for (
    let i = 0;
    i < grupos.length;
    i++
  ) {
    const g =
      grupos[i];

    const tiene =
      grupos.some(
        (otro, j) =>
          i !== j &&
          sonViajesCompatiblesTemporada(
            g,
            otro
          )
      );

    if (tiene) {
      total++;
    }
  }

  return total;
}


/* =========================================================
   EMPAREJAMIENTO BASE
   ========================================================= */

function construirEmparejamientoBase(
  grupos
){
  const pendientes =
    grupos
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const parejas =
    [];

  while (
    pendientes.length >= 2
  ) {
    // ===================================================
    // PRIMERO ELEGIMOS EL VIAJE MÁS DIFÍCIL
    //
    // Es decir:
    // el que tenga menos compañeros posibles.
    //
    // Esto evita "gastarse" un viaje flexible y dejar
    // otro sin pareja.
    // ===================================================

    let idxBase =
      -1;

    let candidatosBase =
      null;

    for (
      let i = 0;
      i < pendientes.length;
      i++
    ) {
      const candidatos =
        [];

      for (
        let j = 0;
        j < pendientes.length;
        j++
      ) {
        if (
          i === j
        ) {
          continue;
        }

        if (
          sonViajesCompatiblesTemporada(
            pendientes[i],
            pendientes[j]
          )
        ) {
          candidatos.push(
            j
          );
        }
      }

      if (
        !candidatos.length
      ) {
        continue;
      }

      if (
        idxBase === -1 ||
        candidatos.length <
          candidatosBase.length
      ) {
        idxBase =
          i;

        candidatosBase =
          candidatos;
      }
    }

    // Ningún viaje restante puede emparejarse.
    if (
      idxBase === -1
    ) {
      break;
    }

    const base =
      pendientes[
        idxBase
      ];

    let mejor =
      null;

    // ===================================================
    // ELEGIR COMPAÑERO
    //
    // PRIORIDAD:
    //
    // 1. dejar la mayor cantidad de viajes restantes
    //    todavía emparejables.
    //
    // 2. recién después mejorar el descanso.
    // ===================================================

    for (
      const idxComp
      of candidatosBase
    ) {
      const comp =
        pendientes[
          idxComp
        ];

      const restantes =
        pendientes.filter(
          (_, idx) =>
            idx !== idxBase &&
            idx !== idxComp
        );

      const emparejablesDespues =
        contarViajesConParejaPosible(
          restantes
        );

      const calidad =
        scoreCalidadPareja(
          base,
          comp
        );

      if (
        !mejor ||
        emparejablesDespues >
          mejor.emparejablesDespues ||
        (
          emparejablesDespues ===
            mejor.emparejablesDespues &&
          calidad >
            mejor.calidad
        )
      ) {
        mejor = {
          idxComp,
          comp,
          emparejablesDespues,
          calidad
        };
      }
    }

    if (!mejor) {
      break;
    }

    parejas.push(
      {
        viajes:
          [base, mejor.comp]
            .sort(
              (a, b) =>
                cmpISO(
                  a.fechaInicio,
                  b.fechaInicio
                )
            )
      }
    );

    // Borrar índices de mayor a menor.
    const borrar =
      [
        idxBase,
        mejor.idxComp
      ]
        .sort(
          (a, b) =>
            b - a
        );

    borrar.forEach(
      idx =>
        pendientes.splice(
          idx,
          1
        )
    );
  }

  return {
    parejas,

    sueltos:
      pendientes
  };
}


/* =========================================================
   REPARAR EMPAREJAMIENTO
   ========================================================= */

function repararEmparejamientoTemporada(
  parejas,
  sueltos
){
  let P =
    parejas.map(
      p => ({
        viajes:
          p.viajes.slice()
      })
    );

  let S =
    sueltos.slice();

  let cambio =
    true;

  while (cambio) {
    cambio =
      false;

    // ===================================================
    // A) DOS SUELTOS QUE PUEDAN FORMAR UNA PAREJA
    // ===================================================

    outerDirecto:
    for (
      let i = 0;
      i < S.length - 1;
      i++
    ) {
      for (
        let j = i + 1;
        j < S.length;
        j++
      ) {
        if (
          sonViajesCompatiblesTemporada(
            S[i],
            S[j]
          )
        ) {
          P.push(
            {
              viajes:
                [S[i], S[j]]
                  .sort(
                    (a, b) =>
                      cmpISO(
                        a.fechaInicio,
                        b.fechaInicio
                      )
                  )
            }
          );

          S.splice(
            j,
            1
          );

          S.splice(
            i,
            1
          );

          cambio =
            true;

          break outerDirecto;
        }
      }
    }

    if (cambio) {
      continue;
    }

    // ===================================================
    // B) REPARACIÓN 2x2
    //
    // Tenemos:
    //
    // pareja A+B
    // suelto C
    // suelto D
    //
    // buscamos:
    //
    // A+C
    // B+D
    //
    // o:
    //
    // A+D
    // B+C
    //
    // Esto reduce:
    //
    // 3 grupos → 2 grupos.
    //
    // Es exactamente el tipo de caso:
    //
    // 04-09 + 13-20
    // y quedan solos 05-12 / 10-16
    //
    // que queremos corregir.
    // ===================================================

    let mejorReparacion =
      null;

    for (
      let pIdx = 0;
      pIdx < P.length;
      pIdx++
    ) {
      const [
        A,
        B
      ] =
        P[pIdx].viajes;

      for (
        let i = 0;
        i < S.length - 1;
        i++
      ) {
        for (
          let j = i + 1;
          j < S.length;
          j++
        ) {
          const C =
            S[i];

          const D =
            S[j];

          const alternativas =
            [
              [
                [A, C],
                [B, D]
              ],

              [
                [A, D],
                [B, C]
              ]
            ];

          for (
            const alt
            of alternativas
          ) {
            const [
              par1,
              par2
            ] =
              alt;

            if (
              !sonViajesCompatiblesTemporada(
                par1[0],
                par1[1]
              ) ||
              !sonViajesCompatiblesTemporada(
                par2[0],
                par2[1]
              )
            ) {
              continue;
            }

            const score =
              scoreCalidadPareja(
                par1[0],
                par1[1]
              ) +
              scoreCalidadPareja(
                par2[0],
                par2[1]
              );

            if (
              !mejorReparacion ||
              score >
                mejorReparacion.score
            ) {
              mejorReparacion = {
                pIdx,
                i,
                j,
                par1,
                par2,
                score
              };
            }
          }
        }
      }
    }

    if (
      mejorReparacion
    ) {
      const r =
        mejorReparacion;

      P[r.pIdx] = {
        viajes:
          r.par1
            .slice()
            .sort(
              (a, b) =>
                cmpISO(
                  a.fechaInicio,
                  b.fechaInicio
                )
            )
      };

      P.push(
        {
          viajes:
            r.par2
              .slice()
              .sort(
                (a, b) =>
                  cmpISO(
                    a.fechaInicio,
                    b.fechaInicio
                  )
              )
        }
      );

      S.splice(
        r.j,
        1
      );

      S.splice(
        r.i,
        1
      );

      cambio =
        true;
    }
  }

  return {
    parejas:
      P,

    sueltos:
      S
  };
}


/* =========================================================
   MEJORAR DESCANSOS SIN CAMBIAR CANTIDAD DE PAREJAS
   ========================================================= */

function mejorarDescansoParejas(
  parejas
){
  const P =
    parejas.map(
      p => ({
        viajes:
          p.viajes.slice()
      })
    );

  let cambio =
    true;

  let vueltas =
    0;

  while (
    cambio &&
    vueltas < 20
  ) {
    cambio =
      false;

    vueltas++;

    outer:
    for (
      let i = 0;
      i < P.length - 1;
      i++
    ) {
      for (
        let j = i + 1;
        j < P.length;
        j++
      ) {
        const [
          A,
          B
        ] =
          P[i].viajes;

        const [
          C,
          D
        ] =
          P[j].viajes;

        const actual =
          scoreCalidadPareja(
            A,
            B
          ) +
          scoreCalidadPareja(
            C,
            D
          );

        const alternativas =
          [
            [
              [A, C],
              [B, D]
            ],

            [
              [A, D],
              [B, C]
            ]
          ];

        for (
          const alt
          of alternativas
        ) {
          const [
            p1,
            p2
          ] =
            alt;

          if (
            !sonViajesCompatiblesTemporada(
              p1[0],
              p1[1]
            ) ||
            !sonViajesCompatiblesTemporada(
              p2[0],
              p2[1]
            )
          ) {
            continue;
          }

          const nuevo =
            scoreCalidadPareja(
              p1[0],
              p1[1]
            ) +
            scoreCalidadPareja(
              p2[0],
              p2[1]
            );

          if (
            nuevo >
            actual
          ) {
            P[i].viajes =
              p1
                .slice()
                .sort(
                  (a, b) =>
                    cmpISO(
                      a.fechaInicio,
                      b.fechaInicio
                    )
                );

            P[j].viajes =
              p2
                .slice()
                .sort(
                  (a, b) =>
                    cmpISO(
                      a.fechaInicio,
                      b.fechaInicio
                    )
                );

            cambio =
              true;

            break outer;
          }
        }
      }
    }
  }

  return P;
}


/* =========================================================
   EMPAREJAR TEMPORADA
   ========================================================= */

function emparejarViajesTemporada(
  grupos
){
  // =====================================================
  // 1) EMPAREJAMIENTO BASE
  // =====================================================

  const base =
    construirEmparejamientoBase(
      grupos
    );

  // =====================================================
  // 2) REPARAR SUELTOS
  //
  // Acá priorizamos reducir la cantidad total de SETS.
  // =====================================================

  const reparado =
    repararEmparejamientoTemporada(
      base.parejas,
      base.sueltos
    );

  // =====================================================
  // 3) CON LA CANTIDAD DE PAREJAS YA RESUELTA,
  //    OPTIMIZAMOS DESCANSO.
  // =====================================================

  const parejasMejoradas =
    mejorarDescansoParejas(
      reparado.parejas
    );

  return {
    parejas:
      parejasMejoradas,

    sueltos:
      reparado.sueltos
  };
}


/* =========================================================
   VALIDAR TRÍO
   ========================================================= */

function evaluarTrioTemporada(
  viajes
){
  if (
    !Array.isArray(
      viajes
    ) ||
    viajes.length !== 3
  ) {
    return null;
  }

  const arr =
    viajes
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const gaps =
    [];

  for (
    let i = 0;
    i < arr.length - 1;
    i++
  ) {
    const A =
      arr[i];

    const B =
      arr[i + 1];

    if (
      !sonViajesCompatiblesTemporada(
        A,
        B
      )
    ) {
      return null;
    }

    const gap =
      gapDays(
        A.fechaFin,
        B.fechaInicio
      );

    if (
      gap < 0
    ) {
      return null;
    }

    gaps.push(
      gap
    );
  }

  // =====================================================
  // Evitar tres viajes seguidos con ambos cambios
  // sin ningún día completo.
  // =====================================================

  const cambiosSinDescanso =
    gaps.filter(
      g =>
        g === 0
    ).length;

  if (
    cambiosSinDescanso >= 2
  ) {
    return null;
  }

  return {
    viajes:
      arr,

    gaps,

    descansoCompleto:
      gaps.filter(
        g =>
          g >= 1
      ).length,

    totalDescanso:
      gaps.reduce(
        (n, g) =>
          n +
          Math.max(
            g,
            0
          ),
        0
      )
  };
}


/* =========================================================
   ABSORBER ALGUNOS SUELTOS EN TRÍOS
   ========================================================= */

function optimizarSueltosEnParejas(
  parejas,
  sueltos
){
  const sets =
    parejas.map(
      p => ({
        viajes:
          p.viajes.slice()
      })
    );

  const restantes =
    sueltos.slice();

  let cambio =
    true;

  while (
    cambio &&
    restantes.length
  ) {
    cambio =
      false;

    let mejor =
      null;

    for (
      let sIdx = 0;
      sIdx < restantes.length;
      sIdx++
    ) {
      const suelto =
        restantes[
          sIdx
        ];

      for (
        let setIdx = 0;
        setIdx < sets.length;
        setIdx++
      ) {
        const set =
          sets[
            setIdx
          ];

        if (
          set.viajes.length !== 2
        ) {
          continue;
        }

        const prueba =
          evaluarTrioTemporada(
            [
              ...set.viajes,
              suelto
            ]
          );

        if (!prueba) {
          continue;
        }

        // =================================================
        // Mantener la mayoría de los SETS con 2 viajes.
        //
        // Si absorbemos este suelto:
        //
        // - desaparece 1 grupo individual
        // - una pareja pasa a ser trío
        // =================================================

        const paresActuales =
          sets.filter(
            x =>
              x.viajes.length === 2
          ).length;

        const paresDespues =
          paresActuales - 1;

        const totalSetsDespues =
          sets.length +
          restantes.length -
          1;

        if (
          paresDespues <=
          totalSetsDespues / 2
        ) {
          continue;
        }

        const score =
          (
            prueba.descansoCompleto *
            1000
          ) +
          prueba.totalDescanso;

        if (
          !mejor ||
          score >
            mejor.score
        ) {
          mejor = {
            sIdx,
            setIdx,
            prueba,
            score
          };
        }
      }
    }

    if (mejor) {
      sets[
        mejor.setIdx
      ].viajes =
        mejor.prueba.viajes;

      restantes.splice(
        mejor.sIdx,
        1
      );

      cambio =
        true;
    }
  }

  // =====================================================
  // LOS QUE SIGUEN SUELTOS
  // =====================================================

  restantes.forEach(
    g => {
      sets.push(
        {
          viajes:
            [g]
        }
      );
    }
  );

  return sets;
}


/* =========================================================
   SUGERIR POR TEMPORADA
   ========================================================= */

function sugerirConjuntosTemporada(){
  console.groupCollapsed(
    'sugerirConjuntosTemporada'
  );

  try{
    const {
      fixedSetsMem,
      fixedFromGruposFiltered,
      pool
    } =
      obtenerBaseSugerencia();

    L(
      'Pool temporada:',
      pool.length
    );

    // =====================================================
    // 1) SEPARAR LOS QUE OBLIGATORIAMENTE VAN SOLOS
    // =====================================================

    const individuales =
      [];

    const combinables =
      [];

    for (
      const g
      of pool
    ) {
      const clasificacion =
        clasificarTipoViajeTemporada(
          g
        );

      if (
        clasificacion.individual
      ) {
        individuales.push(
          g
        );

      } else {
        combinables.push(
          g
        );
      }
    }

    L(
      'Temporada clasificación:',
      {
        combinables:
          combinables.length,

        individuales:
          individuales.length
      }
    );

    // =====================================================
    // 2) BUSCAR LA MAYOR CANTIDAD POSIBLE DE PAREJAS
    // =====================================================

    const {
      parejas,
      sueltos
    } =
      emparejarViajesTemporada(
        combinables
      );

    // =====================================================
    // 3) REDUCIR AÚN MÁS LA CANTIDAD DE SETS,
    //    PERMITIENDO ALGUNOS TRÍOS,
    //    SIN PERDER LA MAYORÍA DE SETS DOBLES.
    // =====================================================

    const optimizados =
      optimizarSueltosEnParejas(
        parejas,
        sueltos
      );

    // =====================================================
    // 4) AGREGAR LOS INDIVIDUALES OBLIGATORIOS
    //
    // OTRO y casos fuera de regla.
    // =====================================================

    individuales.forEach(
      g => {
        optimizados.push(
          {
            viajes:
              [g]
          }
        );
      }
    );

    // =====================================================
    // 5) CREAR SETS
    // =====================================================

    const suggested =
      optimizados.map(
        s => {
          const viajesOrdenados =
            s.viajes
              .slice()
              .sort(
                (a, b) =>
                  cmpISO(
                    a.fechaInicio,
                    b.fechaInicio
                  )
              );

          return {
            anoViaje:
              Number(
                ANO_COORDINADORES
              ),

            viajes:
              viajesOrdenados.map(
                g =>
                  g.id
              ),

            coordinadorId:
              null,

            confirmado:
              false,

            estadoCoord:
              'pendiente',

            alertas:
              [],

            _isNew:
              true,

            estrategiaSugerencia:
              'temporada'
          };
        }
      );

    // =====================================================
    // 6) CONSERVAR LO YA CONFIRMADO
    // =====================================================

    SETS =
      fixedSetsMem
        .concat(
          fixedFromGruposFiltered
        )
        .concat(
          suggested
        );

    dedupeSetsInPlace();
    sortSetsInPlace();
    evaluarAlertas();
    render();

    // =====================================================
    // 7) ESTADÍSTICAS DE LA PROPUESTA
    // =====================================================

    const deUno =
      suggested.filter(
        s =>
          s.viajes.length === 1
      ).length;

    const deDos =
      suggested.filter(
        s =>
          s.viajes.length === 2
      ).length;

    const deTres =
      suggested.filter(
        s =>
          s.viajes.length === 3
      ).length;

    const totalViajes =
      suggested.reduce(
        (n, s) =>
          n +
          s.viajes.length,
        0
      );

    L(
      'Temporada resultado FINAL:',
      {
        viajes:
          totalViajes,

        gruposViaje:
          suggested.length,

        uno:
          deUno,

        dos:
          deDos,

        tres:
          deTres
      }
    );

  }finally{
    console.groupEnd();
  }
}

/* =========================================================
   CUPOS DE COORDINADORES POR GRUPO
   ========================================================= */

function getCantidadCoordinadoresGrupo(
  grupoOrId
){
  const g =
    typeof grupoOrId ===
      'string'
      ? ID2GRUPO.get(
          grupoOrId
        )
      : grupoOrId;


  const n =
    Number.parseInt(
      String(
        g?.cantidadCoordinadores ??
        1
      ),
      10
    );


  if (
    !Number.isFinite(n)
  ) {
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


function getSetsQueContienenGrupo(
  grupoId,
  {
    soloConfirmados = false
  } = {}
){
  return SETS.filter(s => {
    if (
      soloConfirmados &&
      (
        !s.confirmado ||
        !s.coordinadorId
      )
    ) {
      return false;
    }


    return (
      s.viajes ||
      []
    ).includes(
      grupoId
    );
  });
}


function getCantidadCuposUsadosGrupo(
  grupoId
){
  return getSetsQueContienenGrupo(
    grupoId
  ).length;
}


function getCantidadAsignadaGrupo(
  grupoId
){
  const coordinadores =
    new Set();


  getSetsQueContienenGrupo(
    grupoId,
    {
      soloConfirmados:
        true
    }
  ).forEach(s => {
    if (
      s.coordinadorId
    ) {
      coordinadores.add(
        s.coordinadorId
      );
    }
  });


  return coordinadores.size;
}


function getCuposPendientesGrupo(
  grupoId
){
  return Math.max(
    0,
    getCantidadCoordinadoresGrupo(
      grupoId
    ) -
    getCantidadCuposUsadosGrupo(
      grupoId
    )
  );
}


function getCoberturaGrupo(
  grupoId
){
  const requeridos =
    getCantidadCoordinadoresGrupo(
      grupoId
    );

  const usados =
    getCantidadCuposUsadosGrupo(
      grupoId
    );

  const confirmados =
    getCantidadAsignadaGrupo(
      grupoId
    );


  return {
    requeridos,
    usados,
    confirmados,
    pendientes:
      Math.max(
        0,
        requeridos -
        usados
      )
  };
}

/* =========================================================
   Unicidad: cada viaje puede estar en un único conjunto
   ========================================================= */
function dedupeSetsInPlace() {
  // =====================================================
  // NUEVA REGLA:
  //
  // un grupo puede aparecer tantas veces
  // como cantidadCoordinadores indique.
  //
  // Pero:
  // - sólo una vez dentro del mismo SET
  // - un mismo coordinador no puede cubrir
  //   dos cupos del mismo grupo.
  //
  // Los confirmados tienen prioridad.
  // =====================================================

  const usadosPorGrupo =
    new Map();

  const usadosPorGrupoCoord =
    new Set();


  const indices =
    SETS
      .map(
        (_, idx) =>
          idx
      )
      .sort(
        (a, b) => {
          const A =
            SETS[a];

          const B =
            SETS[b];

          const aConfirmado =
            !!A.confirmado &&
            !!A.coordinadorId;

          const bConfirmado =
            !!B.confirmado &&
            !!B.coordinadorId;

          if (
            aConfirmado !==
            bConfirmado
          ) {
            return aConfirmado
              ? -1
              : 1;
          }

          return a - b;
        }
      );


  for (
    const idx
    of indices
  ) {
    const s =
      SETS[idx];

    const local =
      new Set();

    const nuevosViajes =
      [];


    for (
      const rawGid
      of (
        s.viajes ||
        []
      )
    ) {
      const gid =
        String(
          rawGid
        );


      if (
        !ID2GRUPO.has(
          gid
        )
      ) {
        continue;
      }


      // Nunca dos veces dentro
      // de la misma agenda.
      if (
        local.has(
          gid
        )
      ) {
        continue;
      }


      const requeridos =
        getCantidadCoordinadoresGrupo(
          gid
        );

      const usados =
        usadosPorGrupo.get(
          gid
        ) ||
        0;


      // Si ya alcanzó el máximo,
      // no agregar otro cupo.
      if (
        usados >=
        requeridos
      ) {
        continue;
      }


      // Un mismo coordinador no puede
      // cubrir dos cupos del mismo viaje.
      if (
        s.coordinadorId
      ) {
        const key =
          `${gid}__${s.coordinadorId}`;

        if (
          usadosPorGrupoCoord.has(
            key
          )
        ) {
          continue;
        }

        usadosPorGrupoCoord.add(
          key
        );
      }


      local.add(
        gid
      );

      nuevosViajes.push(
        gid
      );

      usadosPorGrupo.set(
        gid,
        usados + 1
      );
    }


    s.viajes =
      nuevosViajes;
  }


  L(
    'dedupeSetsInPlace multi-coordinador:',
    Object.fromEntries(
      usadosPorGrupo
    )
  );
}

function refreshSets() {
  L('refreshSets()');
  dedupeSetsInPlace();
  sortSetsInPlace();
  render();
}


/* =========================================================
   Alertas / Consistencia (incluye aptitud destinos)
   ========================================================= */
function evaluarAlertas(){
  console.groupCollapsed('evaluarAlertas');
  SETS.forEach(s=> s.alertas=[]);
  SETS.forEach(s=>{
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean).sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
    s.viajes=viajes.map(v=>v.id);
    let consec=0;
    for (let i=0;i<viajes.length-1;i++){
      const A=viajes[i], B=viajes[i+1];
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)) s.alertas.push({tipo:'err', msg:`Solape entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      const gap=gapDays(A.fechaFin,B.fechaInicio);
      if (gap<0) s.alertas.push({tipo:'err', msg:`Orden inconsistente entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      else if (gap===0) consec++; else consec=0;
      if (consec>=2) s.alertas.push({tipo:'warn', msg:`3 viajes seguidos sin día de descanso`});
    }

    if (s.coordinadorId){
      const c=COORDS.find(x=>x.id===s.coordinadorId);
      if (c){
        viajes.forEach(v=>{
          if (!inAnyRange(v.fechaInicio,v.fechaFin,c.disponibilidad||[])){
            s.alertas.push({tipo:'warn', msg:`Coordinador fuera de disponibilidad en ${v.aliasGrupo||v.nombreGrupo}`});
          }
        });
        if ((c.destinos||[]).length){
          viajes.forEach(v=>{
            const d = normDest(v.destino);
            if (d && !c.destinos.includes(d)){
              s.alertas.push({tipo:'warn', msg:`Coordinador no apto para destino ${d} en ${v.aliasGrupo||v.nombreGrupo}`});
            }
          });
        }
      }
    }
  });

  for (let i=0;i<SETS.length;i++){
    for (let j=i+1;j<SETS.length;j++){
      const A=SETS[i], B=SETS[j]; if (!A.coordinadorId || A.coordinadorId!==B.coordinadorId) continue;
      const va=A.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const vb=B.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const pisado=va.some(a=>vb.some(b=>overlap(a.fechaInicio,a.fechaFin,b.fechaInicio,b.fechaFin)));
      if (pisado){
        const name=(COORDS.find(c=>c.id===A.coordinadorId)?.nombre)||'(coordinador)';
        A.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${j+1} con fechas que se cruzan`});
        B.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${i+1} con fechas que se cruzan`});
      }
    }
  }
  L('evaluarAlertas: sets con alertas:',
    SETS.filter(s=> (s.alertas||[]).length).length);
  console.groupEnd();
}

/* =========================================================
   Acciones sobre viajes
   ========================================================= */
function seleccionarConjuntoDestino(
  grupoId
){
  if (!SETS.length) {
    alert(
      'Primero crea un grupo de viajes.'
    );

    return;
  }


  const g =
    ID2GRUPO.get(
      grupoId
    );


  if (!g) {
    alert(
      'No se encontró el grupo.'
    );

    return;
  }


  const cobertura =
    getCoberturaGrupo(
      grupoId
    );


  // =====================================================
  // SI YA ESTÁ COMPLETO NO DEJAMOS AGREGAR MÁS CUPOS
  // =====================================================

  if (
    cobertura.usados >=
    cobertura.requeridos
  ) {
    alert(
      `Este grupo ya tiene cubiertos sus ${cobertura.requeridos} cupo(s) de coordinador.`
    );

    return;
  }


  const n =
    prompt(
      `¿A qué grupo de viajes agregar este cupo? (1..${SETS.length})\n\n` +
      `Cobertura actual: ${cobertura.usados}/${cobertura.requeridos}`
    );


  if (!n) {
    return;
  }


  const idx =
    Number(n) -
    1;


  if (
    idx < 0 ||
    idx >= SETS.length
  ) {
    alert(
      'Número inválido.'
    );

    return;
  }


  const destino =
    SETS[idx];


  // =====================================================
  // EL MISMO GRUPO NO PUEDE ESTAR DOS VECES
  // DENTRO DEL MISMO SET.
  // =====================================================

  if (
    (
      destino.viajes ||
      []
    ).includes(
      grupoId
    )
  ) {
    alert(
      'Este grupo ya está dentro de ese grupo de viajes.'
    );

    return;
  }


  // =====================================================
  // SI EL SET YA TIENE COORDINADOR,
  // ESA MISMA PERSONA NO PUEDE CUBRIR OTRO CUPO
  // DEL MISMO GRUPO EN OTRO SET.
  // =====================================================

  if (
    destino.coordinadorId
  ) {
    const mismoCoordinadorYaUsado =
      SETS.some(
        (s, otroIdx) =>
          otroIdx !== idx &&
          s.coordinadorId ===
            destino.coordinadorId &&
          (
            s.viajes ||
            []
          ).includes(
            grupoId
          )
      );


    if (
      mismoCoordinadorYaUsado
    ) {
      const nombre =
        COORDS.find(
          c =>
            c.id ===
            destino.coordinadorId
        )?.nombre ||
        'Este coordinador';


      alert(
        `${nombre} ya cubre otro cupo de este mismo grupo. Debes usar otro coordinador.`
      );

      return;
    }
  }


  // =====================================================
  // IMPORTANTE:
  //
  // NO BORRAMOS grupoId DE LOS OTROS SETS.
  //
  // Puede aparecer:
  //
  // - 1 vez si requiere 1 coordinador
  // - 2 veces si requiere 2
  // - 3 veces si requiere 3
  // =====================================================

  destino.viajes.push(
    grupoId
  );


  destino.estadoCoord =
    'pendiente';


  refreshSets();
}
function moverViajeAotroConjunto(
  grupoId,
  desdeIdx
){
  if (
    SETS.length <= 1
  ) {
    alert(
      'No hay otro grupo de viajes.'
    );

    return;
  }


  const n =
    prompt(
      `Mover al grupo (1..${SETS.length}, distinto de ${desdeIdx + 1})`
    );


  if (!n) {
    return;
  }


  const to =
    Number(n) -
    1;


  if (
    to === desdeIdx ||
    to < 0 ||
    to >= SETS.length
  ) {
    alert(
      'Número inválido.'
    );

    return;
  }


  // El mismo grupo no puede aparecer dos veces
  // dentro del mismo SET.
  if (
    (
      SETS[to].viajes ||
      []
    ).includes(
      grupoId
    )
  ) {
    alert(
      'Ese grupo ya está dentro del grupo de viajes de destino.'
    );

    return;
  }


  // Si el destino ya tiene coordinador,
  // verificar que esa persona no esté cubriendo
  // otro cupo de este mismo grupo.
  const coordDestino =
    SETS[to].coordinadorId ||
    null;


  if (
    coordDestino
  ) {
    const repetido =
      SETS.some(
        (s, idx) =>
          idx !== desdeIdx &&
          idx !== to &&
          s.coordinadorId ===
            coordDestino &&
          (
            s.viajes ||
            []
          ).includes(
            grupoId
          )
      );


    if (repetido) {
      const nombre =
        COORDS.find(
          c =>
            c.id ===
            coordDestino
        )?.nombre ||
        'Ese coordinador';


      alert(
        `${nombre} ya cubre este grupo en otro grupo de viajes.`
      );

      return;
    }
  }


  SETS[desdeIdx].viajes =
    SETS[desdeIdx].viajes.filter(
      id =>
        id !== grupoId
    );


  SETS[to].viajes.push(
    grupoId
  );


  SETS[desdeIdx].estadoCoord =
    'pendiente';

  SETS[to].estadoCoord =
    'pendiente';


  refreshSets();
}
function agregarViajeAConjunto(
  setIdx
){
  const destino =
    SETS[setIdx];


  if (!destino) {
    return;
  }


  const usados =
    viajesUsadosSetIds();


  // =====================================================
  // GRUPOS QUE TODAVÍA TIENEN AL MENOS UN CUPO
  // =====================================================

  const libresAll =
    GRUPOS.filter(
      g =>
        !usados.has(
          g.id
        )
    );


  // =====================================================
  // NO MOSTRAR UN GRUPO QUE YA ESTÁ DENTRO DE ESTE SET
  //
  // Aunque necesite 2 o 3 coordinadores,
  // esos cupos deben estar en OTROS SETS.
  // =====================================================

  const candidatos =
    libresAll.filter(
      g =>
        !(
          destino.viajes ||
          []
        ).includes(
          g.id
        )
    );


  const libres =
    gruposFiltrados(
      candidatos
    );


  if (!libres.length) {
    alert(
      'No quedan viajes con cupos disponibles para agregar a este grupo de viajes.'
    );

    return;
  }


  const listado =
    libres
      .map(
        (g, i) => {
          const cobertura =
            getCoberturaGrupo(
              g.id
            );


          return (
            `${i + 1}) ` +
            `${g.aliasGrupo || g.nombreGrupo} ` +
            `[${fmtDMY(g.fechaInicio)}→${fmtDMY(g.fechaFin)}] ` +
            `• #${g.numeroNegocio} ` +
            `• Coord. ${cobertura.usados}/${cobertura.requeridos} ` +
            `• ${g.programa || ''} ` +
            `• ${g.destino || ''}`
          );
        }
      )
      .join(
        '\n'
      );


  const n =
    prompt(
      `Selecciona # de viaje a agregar:\n\n${listado}`
    );


  if (!n) {
    return;
  }


  const i =
    Number(n) -
    1;


  if (
    i < 0 ||
    i >= libres.length
  ) {
    alert(
      'Número inválido.'
    );

    return;
  }


  const elegido =
    libres[i];


  // =====================================================
  // SEGURIDAD EXTRA
  // =====================================================

  if (
    (
      destino.viajes ||
      []
    ).includes(
      elegido.id
    )
  ) {
    alert(
      'Este grupo ya está dentro de este grupo de viajes.'
    );

    return;
  }


  // =====================================================
  // SI EL SET YA TIENE COORDINADOR:
  //
  // comprobar que no esté cubriendo este mismo grupo
  // mediante otro SET.
  // =====================================================

  if (
    destino.coordinadorId
  ) {
    const yaLoCubre =
      SETS.some(
        (s, idx) =>
          idx !== setIdx &&
          s.coordinadorId ===
            destino.coordinadorId &&
          (
            s.viajes ||
            []
          ).includes(
            elegido.id
          )
      );


    if (yaLoCubre) {
      const nombre =
        COORDS.find(
          c =>
            c.id ===
            destino.coordinadorId
        )?.nombre ||
        'Este coordinador';


      alert(
        `${nombre} ya cubre otro cupo de este grupo.`
      );

      return;
    }
  }


  destino.viajes.push(
    elegido.id
  );


  destino.estadoCoord =
    'pendiente';


  refreshSets();
}
function handleSwapClick(setIdx, grupoId, btn){
  if (!swapMode){ swapMode=true; swapFirst={setIdx,grupoId}; elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap')); btn.classList.add('selected-swap'); return; }
  if (swapFirst && (swapFirst.setIdx!==setIdx || swapFirst.grupoId!==grupoId)) swapBetweenSets(swapFirst,{setIdx,grupoId});
  swapMode=false; swapFirst=null; elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap'));
}
function swapBetweenSets(a,b){
  SETS[a.setIdx].viajes=SETS[a.setIdx].viajes.filter(id=>id!==a.grupoId);
  SETS[b.setIdx].viajes=SETS[b.setIdx].viajes.filter(id=>id!==b.grupoId);
  SETS[a.setIdx].viajes.push(b.grupoId);
  SETS[b.setIdx].viajes.push(a.grupoId);
  SETS[a.setIdx].estadoCoord = 'pendiente';
  SETS[b.setIdx].estadoCoord = 'pendiente';
  refreshSets();
}

// Sugerir coordinador (filtra bloqueados, disponibilidad y aptitud por destino)
function sugerirCoordinador(setIdx){
  const s=SETS[setIdx];
  const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
  const blocked = getBlockedCoordIds(setIdx);
  const destSet = [...new Set(viajes.map(v=>normDest(v.destino)).filter(Boolean))];

  const ok=COORDS.filter(c =>
    !blocked.has(c.id) &&
    viajes.every(v => inAnyRange(v.fechaInicio, v.fechaFin, c.disponibilidad||[])) &&
    destSet.every(d => isAptoDestino(c, d))
  );
  L('sugerirCoordinador: candidatos', ok.length, 'de', COORDS.length);
  if (!ok.length){ alert('No hay coordinadores disponibles (fechas/destinos) que cubran todo el grupo.'); return; }
  s.coordinadorId = ok[0].id;
  refreshSets();
}

/* =========================================================
   Guardado / IDs de coordinador
   ========================================================= */
function slugNombre(nombre){
  return (nombre||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'coord';
}
async function findCoordId({rut, nombre}) {
  if (rut){ const q1=query(collection(db,'coordinadores'), where('rut','==',rut)); const s1=await getDocs(q1); if(!s1.empty) return s1.docs[0].id; }
  if (nombre){ const q2=query(collection(db,'coordinadores'), where('nombre','==',nombre)); const s2=await getDocs(q2); if(!s2.empty) return s2.docs[0].id; }
  return null;
}
function cleanRanges(arr){
  return (arr||[])
    .map(r=>({ inicio: asISO(r.inicio)||asISO(r.inicioRaw)||null, fin: asISO(r.fin)||asISO(r.finRaw)||null }))
    .filter(r=>r.inicio && r.fin && (new Date(r.inicio)<=new Date(r.fin)));
}

// 💾 Guardar UNA fila de coordinador (con meta correcto)
async function saveOneCoord(i){
  const c = COORDS[i];
  const nombre=(c.nombre||'').trim();
  if (!nombre){ alert('Debe indicar nombre.'); return; }

   const base = {
     nombre,
     rut:(c.rut||'').replace(/\s+/g,'').toUpperCase(),
     fechaNacimiento: asISO(c.fechaNacimiento) || null,
   
     // ← NUEVO
     datosTransferir: (c.datosTransferir || '').toString().trim(),
   
     telefono:(c.telefono||'').trim(),
     correo:(c.correo||'').trim().toLowerCase(),
     destinos: cleanDestinos(c.destinos),
     disponibilidad: cleanRanges(c.disponibilidad),
     activo:(c.activo!==false),
     notas:(c.notas||'').trim(),
   };


  let id = c.id || await findCoordId({ rut: base.rut, nombre: base.nombre });
  let isNew = false;

  if (!id){
    const wanted = slugNombre(base.nombre);
    const exists = await getDoc(doc(db,'coordinadores', wanted));
    id   = exists.exists() ? `${wanted}-${Date.now().toString(36).slice(-4)}` : wanted;
    isNew = true;
  }

  L('saveOneCoord:', { nombre: base.nombre, id, isNew });

  const ref = doc(db, 'coordinadores', id);
  await setDoc(
    ref,
    {
      ...base,
      meta: isNew
        ? { creadoEn: serverTimestamp(), actualizadoEn: serverTimestamp() }
        : { actualizadoEn: serverTimestamp() }
    },
    { merge: true }
  );

  c.id = id;
  delete c._isNew;
}

// Guardar todas las filas del modal
async function saveCoordsModal(){
  console.time('saveCoordsModal');
  for (let i=0;i<COORDS.length;i++){
    const c=COORDS[i];
    if (!c.nombre || !c.nombre.trim()) continue;
    await saveOneCoord(i);
  }
  await loadCoordinadores();
  closeModal(); render();
  console.timeEnd('saveCoordsModal');
}

/* =========================================================
   Estadísticas de viajes (sobre todos los SETS)
   ========================================================= */
function computeViajesStats(){
  const sizes = SETS.map(s => s.viajes?.length || 0);
  const totalGrupos = sizes.length;
  const totalTramos = sizes.reduce((a,b)=>a+b,0);
  const dist = {}; sizes.forEach(n => { dist[n] = (dist[n]||0) + 1; });

  let paresSinDescanso = 0,
      gruposConGap0   = 0,
      paresSolapados  = 0,
      paresOrdenMalo  = 0,
      gruposTodosDescanso = 0;

  let totalErr = 0, totalWarn = 0, confirmados = 0, conCoordinador = 0;
  const coordsAsignados = new Set();

  for (const s of SETS){
    const viajes = (s.viajes||[])
      .map(id => ID2GRUPO.get(id)).filter(Boolean)
      .sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));

    if (s.confirmado) confirmados++;
    if (s.coordinadorId){ conCoordinador++; coordsAsignados.add(s.coordinadorId); }
    (s.alertas||[]).forEach(a => (a.tipo==='err' ? totalErr++ : totalWarn++));
    let tuvo0 = false;
    let todosOK = true;

    for (let i=0;i<viajes.length-1;i++){
      const A = viajes[i], B = viajes[i+1];
      const gap = gapDays(A.fechaFin, B.fechaInicio);
      if (gap < 0) paresOrdenMalo++;
      if (gap === 0){ paresSinDescanso++; tuvo0 = true; }
      if (gap < 1) todosOK = false;
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)) paresSolapados++;
    }
    if (tuvo0) gruposConGap0++;
    if (viajes.length >= 2 && todosOK) gruposTodosDescanso++;
  }

  const min = sizes.length ? Math.min(...sizes) : 0;
  const max = sizes.length ? Math.max(...sizes) : 0;
  const promedio = totalGrupos ? (totalTramos/totalGrupos) : 0;
  const mediana = (() => {
    if (!sizes.length) return 0;
    const s = sizes.slice().sort((a,b)=>a-b), m = Math.floor(s.length/2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  })();

  return {
    totalGrupos,totalTramos,dist,min,max,promedio,mediana,
    paresSinDescanso,gruposConGap0,gruposTodosDescanso,
    paresSolapados,paresOrdenMalo,
    totalErr,totalWarn,confirmados,conCoordinador,
    coordsUnicos: coordsAsignados.size
  };
}

function renderViajesStats(){
  if (!wrapStats) return;
  if (!SETS.length){ wrapStats.innerHTML='<div class="empty">AÚN NO HAY GRUPOS DE VIAJES.</div>'; return; }
  const s=computeViajesStats();
  L('renderViajesStats:', s);

  const tbl=(title,rows)=>`<div class="panel" style="min-width:280px"><div class="hd">${title}</div><div class="bd">${rows}</div></div>`;
  const rowsKV=(kv)=>`<table><thead><tr><th>CLAVE</th><th style="width:90px">TOTAL</th></tr></thead><tbody>${Object.entries(kv).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>`;

  const totales=`
    <table><tbody>
      <tr><th>TOTAL DE VIAJES (GRUPOS)</th><td>${s.totalGrupos}</td></tr>
      <tr><th>TOTAL DE TRAMOS (VIAJES ASIGNADOS)</th><td>${s.totalTramos}</td></tr>
      <tr><th>PROMEDIO TRAMOS POR VIAJE</th><td>${s.promedio.toFixed(2)}</td></tr>
      <tr><th>MEDIANA TRAMOS POR VIAJE</th><td>${s.mediana}</td></tr>
      <tr><th>MÁXIMO / MÍNIMO TRAMOS</th><td>${s.max} / ${s.min}</td></tr>
    </tbody></table>`;

  const distOrdenada=Object.fromEntries(
    Object.entries(s.dist).sort((a,b)=>Number(b[0])-Number(a[0])).map(([n,c])=>[`${n} TRAMO${n==1?'':'S'}`,c])
  );

  const consistencia=`
    <table><tbody>
      <tr><th>CAMBIOS DE VIAJE SIN DÍA LIBRE (0 DÍAS)</th><td>${s.paresSinDescanso}</td></tr>
      <tr><th>GRUPOS CON ALGÚN CAMBIO SIN DÍA LIBRE</th><td>${s.gruposConGap0}</td></tr>
      <tr><th>GRUPOS QUE RESPETAN 1+ DÍA LIBRE ENTRE TODOS SUS CAMBIOS</th><td>${s.gruposTodosDescanso}</td></tr>
      <tr><th>FECHAS QUE SE PISAN ENTRE VIAJES</th><td>${s.paresSolapados}</td></tr>
      <tr><th>FECHAS EN ORDEN INCORRECTO</th><td>${s.paresOrdenMalo}</td></tr>
      <tr><th>ALERTAS (ERRORES / AVISOS)</th><td>${s.totalErr} / ${s.totalWarn}</td></tr>
    </tbody></table>`;

  const asignaciones=`
    <table><tbody>
      <tr><th>VIAJES CONFIRMADOS</th><td>${s.confirmados}</td></tr>
      <tr><th>VIAJES CON COORDINADOR</th><td>${s.conCoordinador}</td></tr>
      <tr><th>COORDINADORES ÚNICOS ASIGNADOS</th><td>${s.coordsUnicos}</td></tr>
    </tbody></table>`;

  wrapStats.innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${tbl('TOTALES',totales)}
      ${tbl('DISTRIBUCIÓN POR TAMAÑO (TRAMOS POR VIAJE)', rowsKV(distOrdenada))}
      ${tbl('CONSISTENCIA / ALERTAS', consistencia)}
      ${tbl('ASIGNACIONES', asignaciones)}
    </div>`;
}

/* =========================================================
   Modal coordinadores (con columna DESTINOS)
   ========================================================= */
function openModal(){ mb && (mb.style.display='block'); modal && (modal.style.display='flex'); }
function closeModal(){ if(modal) modal.style.display='none'; if(mb) mb.style.display='none'; }

function renderCoordsTable(){
  console.groupCollapsed('renderCoordsTable');
  if (!tbodyCoords){ W('tbodyCoords no existe'); console.groupEnd(); return; }
  tbodyCoords.innerHTML=''; hintEmptyCoords && (hintEmptyCoords.style.display=COORDS.length?'none':'block');

  const arr=COORDS.slice().sort((a,b)=> (!!a._isNew!==!!b._isNew) ? (a._isNew?-1:1) : (a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}));
  L('Filas visibles:', arr.length);

  arr.forEach((c,visibleIdx)=>{
    const i=COORDS.indexOf(c);

    const filas=(c.disponibilidad||[]).map((r,ri)=>`
      <div style="display:flex; gap:.3rem; align-items:center; margin:.15rem 0;">
        <input class="picker-range" data-cid="${i}" data-ridx="${ri}" type="text" value="${r.inicio && r.fin ? `${fmtDMY(r.inicio)} a ${fmtDMY(r.fin)}` : ''}" placeholder="dd/mm/aaaa a dd/mm/aaaa" readonly>
        <button class="btn small" data-delrng="${i}:${ri}">❌</button>
      </div>`).join('');

    const optsDest = DESTINOS.map(d=>{
      const sel = (c.destinos||[]).includes(d) ? 'selected' : '';
      return `<option value="${escapeHtml(d)}" ${sel}>${escapeHtml(d)}</option>`;
    }).join('');

    tbodyCoords.insertAdjacentHTML('beforeend',`
      <tr>
         <td style="text-align:center">${visibleIdx+1}</td>
         <td><input type="text" data-f="nombre"   data-i="${i}" value="${c.nombre||''}"   placeholder="Nombre"></td>
         <td><input type="text" data-f="rut"      data-i="${i}" value="${c.rut||''}"      placeholder="RUT"></td>
         
         <!-- ← NUEVO: FECHA NACIMIENTO (después del RUT) -->
         <td>
           <input
             type="text"
             class="picker-birth"
             data-i="${i}"
             value="${c.fechaNacimiento ? fmtDMY(c.fechaNacimiento) : ''}"
             placeholder="dd/mm/aaaa"
             readonly>
         </td>

         <!-- ← NUEVO: DATOS PARA TRANSFERIR (al lado de fecha nacimiento) -->
         <td>
           <input
             type="text"
             data-f="datosTransferir"
             data-i="${i}"
             value="${escapeHtml(c.datosTransferir||'')}"
             placeholder="Datos para transferir">
         </td>

         
         
         <td><input type="text" data-f="telefono" data-i="${i}" value="${c.telefono||''}" placeholder="Teléfono"></td>
         <td><input type="text" data-f="correo"   data-i="${i}" value="${c.correo||''}"   placeholder="Correo"></td>
        <td>
          <select multiple size="3" class="sel-dest" data-i="${i}" style="min-width:180px">
            ${optsDest}
          </select>
          <div class="row" style="margin-top:.25rem">
            <input type="text" class="add-dest" data-i="${i}" placeholder="Agregar destino…" style="width:160px">
            <button class="btn small" data-adddest="${i}">+</button>
          </div>
          <div class="muted" style="margin-top:.25rem; font-size:.85em">(Vacío = apto para todos)</div>
        </td>

        <td>${filas}<button class="btn small" data-addrng="${i}">+ Rango</button></td>

        <td>
          <div class="row">
            <button class="btn small" data-saverc="${i}">💾 Guardar</button>
            <button class="btn small" data-delcoord="${i}">🗑️ Eliminar</button>
          </div>
        </td>
      </tr>`);
  });

  tbodyCoords.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.onchange=()=>{ const i=+inp.dataset.i, f=inp.dataset.f; COORDS[i][f]=inp.value; };
  });

  tbodyCoords.querySelectorAll('select.sel-dest').forEach(sel=>{
    sel.onchange=()=>{
      const i=+sel.dataset.i;
      const selected=[...sel.selectedOptions].map(o=>normDest(o.value));
      COORDS[i].destinos = cleanDestinos(selected);
    };
  });

  tbodyCoords.querySelectorAll('button[data-adddest]').forEach(btn=>{
    btn.onclick=()=>{
      const i=+btn.dataset.adddest;
      const input = tbodyCoords.querySelector(`input.add-dest[data-i="${i}"]`);
      const val = normDest(input.value);
      if (!val) return;
      if (!DESTINOS.includes(val)) DESTINOS.push(val), DESTINOS.sort();
      COORDS[i].destinos = cleanDestinos([...(COORDS[i].destinos||[]), val]);
      renderCoordsTable(); setTimeout(initPickers,10);
    };
  });

  tbodyCoords.querySelectorAll('button[data-addrng]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.addrng; COORDS[i].disponibilidad ||= []; COORDS[i].disponibilidad.push({inicio:'',fin:''}); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-delrng]').forEach(btn=>{
    btn.onclick=()=>{ const [i,j]=btn.dataset.delrng.split(':').map(Number); COORDS[i].disponibilidad.splice(j,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });

  tbodyCoords.querySelectorAll('button[data-delcoord]').forEach(btn=>{
    btn.onclick=async()=>{ const i=+btn.dataset.delcoord; if (COORDS[i].id){ await deleteDoc(doc(db,'coordinadores',COORDS[i].id)); } COORDS.splice(i,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-saverc]').forEach(btn=>{
    btn.onclick=async()=>{
      const i=+btn.dataset.saverc;
      btn.disabled=true; const prev=btn.textContent; btn.textContent='Guardando…';
      try{
        await saveOneCoord(i);
        btn.textContent='✅ Guardado';
        setTimeout(()=>{ btn.textContent=prev; btn.disabled=false; }, 900);
      }catch(e){
        E('saveOneCoord (fila) error:', e);
        btn.textContent='❌ Error';
        setTimeout(()=>{ btn.textContent=prev; btn.disabled=false; }, 1500);
      }
    };
  });

  initPickers();
  console.groupEnd();
}

function initPickers(){
  if (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.es){
    flatpickr.localize(flatpickr.l10ns.es);
  }
   // ← NUEVO: datepicker para fecha de nacimiento
   tbodyCoords?.querySelectorAll('.picker-birth')?.forEach(inp=>{
     if (inp._flatpickr) inp._flatpickr.destroy();
     flatpickr(inp, {
       dateFormat:'d/m/Y',
       allowInput:true,
       onClose:(dates)=>{
         const i = +inp.dataset.i;
         if (dates.length===1){
           const iso = toISO(dates[0]);      // "YYYY-MM-DD"
           COORDS[i].fechaNacimiento = iso;
           inp.value = fmtDMY(iso);          // "dd/mm/aaaa"
         }
       }
     });
   });
}

/* =========================================================
   Utils varios
   ========================================================= */
function limpiarAlias(nombreCompleto){
  return (nombreCompleto||'').replace(/\d{4}/g,'')
    .replace(/\b(colegio|instituto|escuela|curso|año|de|del|la|el|los)\b/gi,'')
    .replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim();
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function getHotelResumenHtmlForGroup(g){
  if (!g) return '';
  const gid = g.id;
  const lista = gid ? (HOTELES_POR_GRUPO.get(gid) || []) : [];
  if (!lista.length) return '';

  const partes = lista.map(h =>
    `${escapeHtml(h.nombre)} (${fmtDMY(h.ini)} → ${fmtDMY(h.fin)})`
  );
  return `<div class="muted">Hotel: ${partes.join(' · ')}</div>`;
}

function sameArr(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* =========================================================
   RESUMEN DE COORDINADORES QUE SE GRABA EN EL GRUPO
   ========================================================= */

function construirAsignacionesGrupoDesdeSets(
  grupoId
){
  const out =
    [];

  const coordinadoresUsados =
    new Set();


  SETS.forEach(s => {
    if (
      !s.confirmado ||
      !s.coordinadorId ||
      !s.id
    ) {
      return;
    }


    if (
      !(
        s.viajes ||
        []
      ).includes(
        grupoId
      )
    ) {
      return;
    }


    // Un coordinador sólo una vez
    // para el mismo grupo.
    if (
      coordinadoresUsados.has(
        s.coordinadorId
      )
    ) {
      return;
    }


    coordinadoresUsados.add(
      s.coordinadorId
    );


    const c =
      COORDS.find(
        x =>
          x.id ===
          s.coordinadorId
      );


    out.push({
      coordinadorId:
        s.coordinadorId,

      coordinador:
        c?.nombre ||
        '',

      conjuntoId:
        s.id,

      estadoCoord:
        normalizeEstado(
          s.estadoCoord
        ),

      anoViaje:
        Number(
          s.anoViaje ||
          ANO_COORDINADORES
        )
    });
  });


  return out;
}


function resolverEstadoResumenGrupo(
  asignaciones
){
  if (
    !asignaciones.length
  ) {
    return null;
  }


  const estados =
    asignaciones.map(
      a =>
        normalizeEstado(
          a.estadoCoord
        )
    );


  if (
    estados.includes(
      'rechazado'
    )
  ) {
    return 'rechazado';
  }


  if (
    estados.every(
      e =>
        e === 'aprobado'
    )
  ) {
    return 'aprobado';
  }


  return 'pendiente';
}


function construirPayloadCoordinadoresGrupo(
  grupoId
){
  const asignaciones =
    construirAsignacionesGrupoDesdeSets(
      grupoId
    );


  const primero =
    asignaciones[0] ||
    null;


  return {
    coordinadorIds:
      asignaciones.map(
        x =>
          x.coordinadorId
      ),

    coordinadores:
      asignaciones.map(
        x =>
          x.coordinador
      ),

    conjuntoIds:
      asignaciones.map(
        x =>
          x.conjuntoId
      ),

    coordinadoresAsignados:
      asignaciones,

    // ===================================================
    // COMPATIBILIDAD LEGACY
    // ===================================================

    coordinadorId:
      primero?.coordinadorId ||
      null,

    coordinador:
      primero?.coordinador ||
      null,

    conjuntoId:
      primero?.conjuntoId ||
      null,

    coordEstado:
      resolverEstadoResumenGrupo(
        asignaciones
      )
  };
}


function aplicarPayloadCoordinadoresEnMemoria(
  grupoId,
  payload
){
  const g =
    ID2GRUPO.get(
      grupoId
    );

  if (!g) {
    return;
  }


  Object.assign(
    g,
    payload
  );
}

/* =========================================================
   Guardar CAMBIOS (persiste SOLO confirmados)
   ========================================================= */
async function guardarTodo(){
  console.time(
    'guardarTodo[MULTI]'
  );

  try{
    const nowTS =
      serverTimestamp();

    const ops =
      [];


    const commitOpsInChunks =
      async (
        operaciones,
        chunkSize = 450
      ) => {
        for (
          let i = 0;
          i < operaciones.length;
          i += chunkSize
        ) {
          const batch =
            writeBatch(
              db
            );

          operaciones
            .slice(
              i,
              i + chunkSize
            )
            .forEach(
              fn =>
                fn(batch)
            );

          await batch.commit();
        }
      };


    // =====================================================
    // 1) ALIAS
    // =====================================================

    for (
      const g
      of GRUPOS
    ) {
      const prev =
        PREV.grupos.get(
          g.id
        ) ||
        {};

      if (
        (
          prev.aliasGrupo ||
          null
        ) !==
        (
          g.aliasGrupo ||
          null
        )
      ) {
        ops.push(
          b =>
            b.update(
              doc(
                db,
                'grupos',
                g.id
              ),
              {
                aliasGrupo:
                  g.aliasGrupo ||
                  null
              }
            )
        );
      }
    }


    // =====================================================
    // 2) PERSISTIR LOS SETS CONFIRMADOS
    // =====================================================

    const nowKeys =
      new Set();


    for (
      const s
      of SETS
    ) {
      s.anoViaje =
        Number(
          s.anoViaje ||
          ANO_COORDINADORES
        );


      const tieneViajes =
        Array.isArray(
          s.viajes
        ) &&
        s.viajes.length >
          0;


      const persistir =
        !!s.confirmado &&
        !!s.coordinadorId &&
        tieneViajes;


      if (!persistir) {
        continue;
      }


      // -----------------------------------------------
      // CAMBIO DE COORDINADOR
      // -----------------------------------------------

      if (
        s.id &&
        s._ownerCoordId &&
        s._ownerCoordId !==
          s.coordinadorId
      ) {
        ops.push(
          b =>
            b.delete(
              doc(
                db,
                'coordinadores',
                s._ownerCoordId,
                'conjuntos',
                s.id
              )
            )
        );

        s.id =
          null;
      }


      if (!s.id) {
        s.id =
          doc(
            collection(
              db,
              'coordinadores',
              s.coordinadorId,
              'conjuntos'
            )
          ).id;
      }


      s._ownerCoordId =
        s.coordinadorId;


      const key =
        `${s._ownerCoordId}/${s.id}`;

      nowKeys.add(
        key
      );


      const conjRef =
        doc(
          db,
          'coordinadores',
          s._ownerCoordId,
          'conjuntos',
          s.id
        );


      const est =
        normalizeEstado(
          s.estadoCoord
        );


      ops.push(
        b =>
          b.set(
            conjRef,
            {
              anoViaje:
                Number(
                  s.anoViaje
                ),

              viajes:
                [
                  ...new Set(
                    s.viajes ||
                    []
                  )
                ],

              confirmado:
                true,

              estadoCoord:
                est,

              meta: {
                actualizadoEn:
                  nowTS,

                ...(
                  s._isNew
                    ? {
                        creadoEn:
                          nowTS
                      }
                    : {}
                )
              }
            },
            {
              merge:
                true
            }
          )
      );


      delete s._isNew;
    }


    // =====================================================
    // 3) BORRAR SETS QUE YA NO ESTÁN CONFIRMADOS
    // =====================================================

    for (
      const [
        key,
        prevSet
      ]
      of PREV.sets.entries()
    ) {
      if (
        nowKeys.has(
          key
        )
      ) {
        continue;
      }


      const [
        owner,
        conjuntoId
      ] =
        key.split('/');


      if (
        owner &&
        conjuntoId
      ) {
        ops.push(
          b =>
            b.delete(
              doc(
                db,
                'coordinadores',
                owner,
                'conjuntos',
                conjuntoId
              )
            )
        );
      }
    }


    // =====================================================
    // 4) RECONSTRUIR RESUMEN POR GRUPO
    //
    // AQUÍ está la diferencia central:
    // cada grupo se escribe UNA sola vez
    // después de reunir todos sus coordinadores.
    // =====================================================

    for (
      const g
      of GRUPOS
    ) {
      const payload =
        construirPayloadCoordinadoresGrupo(
          g.id
        );


      ops.push(
        b =>
          b.update(
            doc(
              db,
              'grupos',
              g.id
            ),
            payload
          )
      );


      aplicarPayloadCoordinadoresEnMemoria(
        g.id,
        payload
      );
    }


    // =====================================================
    // 5) COMMIT
    // =====================================================

    L(
      'guardarTodo[MULTI] ops =',
      ops.length
    );


    if (
      ops.length
    ) {
      await commitOpsInChunks(
        ops,
        450
      );
    }


    // =====================================================
    // 6) SNAPSHOT
    // =====================================================

    PREV.grupos.clear();

    GRUPOS.forEach(g => {
      PREV.grupos.set(
        g.id,
        {
          aliasGrupo:
            g.aliasGrupo ||
            null,

          conjuntoId:
            g.conjuntoId ||
            null,

          coordinadorId:
            g.coordinadorId ||
            null,

          coordinador:
            g.coordinador ||
            null,

          coordinadorIds:
            (
              g.coordinadorIds ||
              []
            ).slice(),

          coordinadores:
            (
              g.coordinadores ||
              []
            ).slice(),

          conjuntoIds:
            (
              g.conjuntoIds ||
              []
            ).slice(),

          coordEstado:
            g.coordEstado ||
            null,

          anoViaje:
            Number(
              g.anoViaje ||
              ANO_COORDINADORES
            )
        }
      );
    });


    PREV.sets.clear();

    SETS.forEach(s => {
      const owner =
        s._ownerCoordId ||
        s.coordinadorId ||
        null;

      if (
        owner &&
        s.id &&
        s.confirmado &&
        s.coordinadorId &&
        (
          s.viajes ||
          []
        ).length
      ) {
        PREV.sets.set(
          `${owner}/${s.id}`,
          {
            viajes:
              (
                s.viajes ||
                []
              ).slice(),

            confirmado:
              true,

            estadoCoord:
              normalizeEstado(
                s.estadoCoord
              ),

            anoViaje:
              Number(
                s.anoViaje ||
                ANO_COORDINADORES
              ),

            owner
          }
        );
      }
    });


    L(
      'guardarTodo[MULTI] OK'
    );

  }catch(err){
    E(
      'guardarTodo[MULTI] error:',
      err
    );

    throw err;

  }finally{
    console.timeEnd(
      'guardarTodo[MULTI]'
    );
  }
}

async function reconstruirResumenGrupoDesdeFirestore(
  grupoId
){
  const g =
    ID2GRUPO.get(
      grupoId
    );

  if (!g) {
    return null;
  }


  const snap =
    await getDocs(
      query(
        collectionGroup(
          db,
          'conjuntos'
        ),
        where(
          'viajes',
          'array-contains',
          grupoId
        )
      )
    );


  const asignaciones =
    [];

  const usados =
    new Set();


  snap.forEach(d => {
    const x =
      d.data() ||
      {};

    if (
      !x.confirmado
    ) {
      return;
    }


    const ano =
      Number(
        x.anoViaje
      ) ||
      null;


    if (
      ano &&
      Number(
        g.anoViaje ||
        ANO_COORDINADORES
      ) !==
        ano
    ) {
      return;
    }


    const coordinadorId =
      d.ref.parent.parent.id;


    if (
      usados.has(
        coordinadorId
      )
    ) {
      return;
    }


    usados.add(
      coordinadorId
    );


    const c =
      COORDS.find(
        z =>
          z.id ===
          coordinadorId
      );


    asignaciones.push({
      coordinadorId,

      coordinador:
        c?.nombre ||
        '',

      conjuntoId:
        d.id,

      estadoCoord:
        normalizeEstado(
          x.estadoCoord
        ),

      anoViaje:
        Number(
          x.anoViaje ||
          ANO_COORDINADORES
        )
    });
  });


  const primero =
    asignaciones[0] ||
    null;


  const payload = {
    coordinadorIds:
      asignaciones.map(
        x =>
          x.coordinadorId
      ),

    coordinadores:
      asignaciones.map(
        x =>
          x.coordinador
      ),

    conjuntoIds:
      asignaciones.map(
        x =>
          x.conjuntoId
      ),

    coordinadoresAsignados:
      asignaciones,

    coordinadorId:
      primero?.coordinadorId ||
      null,

    coordinador:
      primero?.coordinador ||
      null,

    conjuntoId:
      primero?.conjuntoId ||
      null,

    coordEstado:
      resolverEstadoResumenGrupo(
        asignaciones
      )
  };


  await updateDoc(
    doc(
      db,
      'grupos',
      grupoId
    ),
    payload
  );


  aplicarPayloadCoordinadoresEnMemoria(
    grupoId,
    payload
  );


  return payload;
}

async function guardarSet(i){
  const s =
    SETS[i];

  if (!s) {
    return;
  }

  console.time(
    `guardarSet[MULTI][${i}]`
  );

  try{
    // =====================================================
    // DATOS ANTERIORES DEL SET
    // =====================================================

    const oldOwner =
      s._ownerCoordId ||
      null;

    const oldId =
      s.id ||
      null;

    const oldKey =
      (
        oldOwner &&
        oldId
      )
        ? `${oldOwner}/${oldId}`
        : null;


    const prevSet =
      oldKey
        ? PREV.sets.get(
            oldKey
          )
        : null;


    // =====================================================
    // GRUPOS AFECTADOS
    //
    // Incluye:
    // - viajes que tenía antes
    // - viajes que tiene ahora
    //
    // Después reconstruiremos TODOS sus coordinadores.
    // =====================================================

    const afectados =
      new Set([
        ...(
          prevSet?.viajes ||
          []
        ),

        ...(
          s.viajes ||
          []
        )
      ]);


    // =====================================================
    // AÑO
    // =====================================================

    s.anoViaje =
      Number(
        s.anoViaje ||
        ANO_COORDINADORES
      );


    // =====================================================
    // VIAJES ACTUALES DEL SET
    // =====================================================

    const viajes =
      [
        ...new Set(
          (
            s.viajes ||
            []
          ).map(String)
        )
      ]
        .filter(
          gid =>
            ID2GRUPO.has(
              gid
            )
        );


    s.viajes =
      viajes;


    const persistir =
      !!s.confirmado &&
      !!s.coordinadorId &&
      viajes.length > 0;


    const batch =
      writeBatch(
        db
      );


    // =====================================================
    // 1) GUARDAR CAMBIOS DE ALIAS
    // =====================================================

    for (
      const gid
      of viajes
    ) {
      const g =
        ID2GRUPO.get(
          gid
        );

      if (!g) {
        continue;
      }


      const prevG =
        PREV.grupos.get(
          gid
        ) ||
        {};


      if (
        (
          prevG.aliasGrupo ||
          null
        ) !==
        (
          g.aliasGrupo ||
          null
        )
      ) {
        batch.update(
          doc(
            db,
            'grupos',
            gid
          ),
          {
            aliasGrupo:
              g.aliasGrupo ||
              null
          }
        );
      }
    }


    // =====================================================
    // 2) SET CONFIRMADO
    // =====================================================

    if (persistir) {
      // -------------------------------------------------
      // CAMBIÓ EL COORDINADOR DEL SET
      //
      // Como el documento vive bajo:
      //
      // coordinadores/{coordinadorId}/conjuntos/{setId}
      //
      // tenemos que borrar el documento antiguo.
      // -------------------------------------------------

      if (
        oldOwner &&
        oldId &&
        oldOwner !==
          s.coordinadorId
      ) {
        batch.delete(
          doc(
            db,
            'coordinadores',
            oldOwner,
            'conjuntos',
            oldId
          )
        );

        s.id =
          null;
      }


      // -------------------------------------------------
      // CREAR ID SI ES NUEVO
      // -------------------------------------------------

      if (!s.id) {
        s.id =
          doc(
            collection(
              db,
              'coordinadores',
              s.coordinadorId,
              'conjuntos'
            )
          ).id;
      }


      s._ownerCoordId =
        s.coordinadorId;


      // -------------------------------------------------
      // GUARDAR SET
      // -------------------------------------------------

      batch.set(
        doc(
          db,
          'coordinadores',
          s.coordinadorId,
          'conjuntos',
          s.id
        ),
        {
          anoViaje:
            Number(
              s.anoViaje
            ),

          viajes,

          confirmado:
            true,

          estadoCoord:
            normalizeEstado(
              s.estadoCoord
            ),

          meta: {
            actualizadoEn:
              serverTimestamp(),

            ...(
              s._isNew
                ? {
                    creadoEn:
                      serverTimestamp()
                  }
                : {}
            )
          }
        },
        {
          merge:
            true
        }
      );


    // =====================================================
    // 3) SET DESCONFIRMADO / ELIMINADO
    // =====================================================

    } else {
      if (
        oldOwner &&
        oldId
      ) {
        batch.delete(
          doc(
            db,
            'coordinadores',
            oldOwner,
            'conjuntos',
            oldId
          )
        );
      }
    }


    // =====================================================
    // 4) COMMIT DEL SET
    // =====================================================

    await batch.commit();


    // =====================================================
    // 5) RECONSTRUIR COORDINADORES DE CADA GRUPO
    //
    // MUY IMPORTANTE:
    //
    // No ponemos directamente:
    //
    // coordinadorId = este coordinador
    //
    // porque el grupo puede tener Pedro + María + Juan.
    //
    // Leemos TODOS los conjuntos confirmados que contienen
    // el grupo y reconstruimos:
    //
    // coordinadorIds
    // coordinadores
    // conjuntoIds
    // coordinadoresAsignados
    //
    // + campos legacy.
    // =====================================================

    for (
      const gid
      of afectados
    ) {
      await reconstruirResumenGrupoDesdeFirestore(
        gid
      );
    }


    // =====================================================
    // 6) QUITAR SNAPSHOT ANTIGUO DEL SET
    // =====================================================

    if (
      oldKey
    ) {
      PREV.sets.delete(
        oldKey
      );
    }


    // =====================================================
    // 7) CREAR SNAPSHOT NUEVO
    // =====================================================

    if (persistir) {
      PREV.sets.set(
        `${s.coordinadorId}/${s.id}`,
        {
          viajes:
            viajes.slice(),

          confirmado:
            true,

          estadoCoord:
            normalizeEstado(
              s.estadoCoord
            ),

          anoViaje:
            Number(
              s.anoViaje
            ),

          owner:
            s.coordinadorId
        }
      );

      delete s._isNew;

    } else {
      s._ownerCoordId =
        null;

      s.id =
        null;
    }


    // =====================================================
    // 8) ACTUALIZAR PREV.GRUPOS
    // =====================================================

    afectados.forEach(
      gid => {
        const g =
          ID2GRUPO.get(
            gid
          );

        if (!g) {
          return;
        }


        PREV.grupos.set(
          gid,
          {
            aliasGrupo:
              g.aliasGrupo ||
              null,

            conjuntoId:
              g.conjuntoId ||
              null,

            coordinadorId:
              g.coordinadorId ||
              null,

            coordinador:
              g.coordinador ||
              null,

            coordinadorIds:
              (
                g.coordinadorIds ||
                []
              ).slice(),

            coordinadores:
              (
                g.coordinadores ||
                []
              ).slice(),

            conjuntoIds:
              (
                g.conjuntoIds ||
                []
              ).slice(),

            coordEstado:
              g.coordEstado ||
              null,

            anoViaje:
              Number(
                g.anoViaje ||
                ANO_COORDINADORES
              )
          }
        );
      }
    );


    L(
      `guardarSet[MULTI][${i}] OK`,
      {
        anoViaje:
          s.anoViaje,

        coordinadorId:
          s.coordinadorId,

        viajes:
          viajes.length,

        gruposReconstruidos:
          afectados.size
      }
    );

  }catch(e){
    E(
      `guardarSet[MULTI][${i}] error:`,
      e
    );

    alert(
      'Error al guardar este grupo de viajes. Revisa la consola.'
    );

    throw e;

  }finally{
    console.timeEnd(
      `guardarSet[MULTI][${i}]`
    );
  }
}
/* =========================================================
   Carga por Excel (coordinadores)
   ========================================================= */
function handleExcel(evt){
  const file = evt.target.files?.[0];
  if(!file) return;

  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const wb = XLSX.read(e.target.result, { type:'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:'', raw:false, blankrows:false });

      const byName = new Map(COORDS.map(c => [ (c.nombre||'').trim().toUpperCase(), c ]));
      const byRut  = new Map(COORDS.filter(c=>c.rut).map(c => [ c.rut.replace(/\s+/g,'').toUpperCase(), c ]));

      L('Excel filas:', rows.length);

      for(const r of rows){
        const nombre   = (r.Nombre || r.NOMBRE || r.nombre || '').toString().trim();
        if(!nombre) continue;
        const rut      = (r.RUT || r.rut || '').toString().replace(/\s+/g,'').toUpperCase();
        const telefono = (r.TELEFONO || r['TELÉFONO'] || r.tel || r.Tel || r.telefono || '').toString().trim();
        const correo   = (r.Correo || r.CORREO || r.Email || r.EMAIL || r.email || '').toString().trim().toLowerCase();
        const destinosCell = (r.Destinos || r.DESTINOS || r.destinos || '').toString();
        const destinosXLS  = cleanDestinos(destinosCell.split(','));

        let c = (rut && byRut.get(rut)) || byName.get(nombre.toUpperCase());
        if (c){
          c.nombre = nombre; c.rut = rut; c.telefono = telefono; c.correo = correo;
          if (destinosXLS.length){
            c.destinos = cleanDestinos([...(c.destinos||[]), ...destinosXLS]);
         const transfer = (r['DATOS PARA TRANSFERIR'] || r['Datos para transferir'] || r['datosTransferir'] || r['datos_para_transferir'] || '').toString().trim();
         if (transfer) c.datosTransferir = transfer;
          }
        } else {
         c = {
           nombre, rut, telefono, correo,
           fechaNacimiento: asISO(r['Fecha Nacimiento'] || r['Fecha_nacimiento'] || r['fechaNacimiento']) || null,
         
           // ← NUEVO: DATOS PARA TRANSFERIR
           datosTransferir: (r['DATOS PARA TRANSFERIR'] || r['Datos para transferir'] || r['datosTransferir'] || r['datos_para_transferir'] || '').toString().trim(),
         
           destinos:destinosXLS, disponibilidad:[], _isNew:true
         };
          COORDS.unshift(c);
          byName.set(nombre.toUpperCase(), c);
          if (rut) byRut.set(rut, c);
        }
      }

      renderCoordsTable();
      setTimeout(initPickers,10);
    } catch (err){
      E('handleExcel error:', err);
      alert('No se pudo leer el Excel. Asegúrate de que sea .xlsx/.xls y que tenga la columna "Nombre".');
    } finally {
      evt.target.value = '';
    }
  };
  reader.readAsBinaryString(file);
}


/* =========================================================
   Boot
   ========================================================= */
async function __bootCoordinadores(){
  console.groupCollapsed('BOOT');
  try{
    console.time('BOOT');

    await loadCoordinadores();
    console.log('[RTV/coord] COORDS cargados =', COORDS.length);

    await loadGrupos();
    console.log('[RTV/coord] GRUPOS cargados =', GRUPOS.length,
                '| primeros ids =', GRUPOS.slice(0,5).map(g=>g.id));

    // NUEVO: Cargar horas por grupo desde 'vuelos'
    await loadHorasViajes();

    // NUEVO: Cargar hoteles por grupo desde "hotelAssignments"
    await loadHotelAssignments();

    await loadSets();
    console.log('[RTV/coord] SETS construidos =', SETS.length);


    populateFilterOptions();
    render();

  }catch(err){
    console.error('[RTV/coord] BOOT error:', err);
  }finally{
    console.timeEnd('BOOT');
    console.groupEnd();
  }

  // 🔧 Ganchos de depuración desde la consola
  window.__dbg = {
    get sizes(){ return { coords: COORDS.length, grupos: GRUPOS.length, sets: SETS.length }; },
    COORDS, GRUPOS, SETS,
    reloadAll: async ()=>{
      await loadCoordinadores();
      await loadGrupos();
      await loadHorasViajes();
      await loadHotelAssignments();
      await loadSets();
      render();
      return { coords: COORDS.length, grupos: GRUPOS.length, sets: SETS.length };
    }

  };
}

// 🔁 Ejecuta el boot siempre (con o sin DOMContentLoaded)
if (document.readyState === 'loading'){
  window.addEventListener('DOMContentLoaded', __bootCoordinadores, { once:true });
} else {
  // El DOM ya está listo: corre inmediatamente
  __bootCoordinadores();
}


/* =========================================================
   Probe directo a Firestore para "grupos"
   Llama:  await __probeGrupos()
   ========================================================= */
async function __probeGrupos(){
  try{
    console.time('__probeGrupos');
    const snap = await getDocs(collection(db,'grupos'));
    console.log('[RTV/coord] __probeGrupos size =', snap.size);
    snap.docs.slice(0,5).forEach(d=>{
      const x = d.data();
      console.log(' - id:', d.id, '| fechaInicio:', x.fechaInicio, '| fechaFin:', x.fechaFin, '| identificador:', x.identificador || x.codigo || x.codigoGrupo || '');
    });
  }catch(e){
    console.error('[RTV/coord] __probeGrupos error:', e);
  }finally{
    console.timeEnd('__probeGrupos');
  }
}
window.__probeGrupos = __probeGrupos;
