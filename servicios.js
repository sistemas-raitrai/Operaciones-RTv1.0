// servicios.js (con Exportar Excel por sección + Botón GLOBAL "Exportar todo")

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, deleteDoc, setDoc, getDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===========================
   1) Catálogos y configuración
   =========================== */
const opciones = {
  tipoServicio: ['DIARIO','GENERAL','OTRO'],
  categoria:    ['NAVEGACIÓN','ALIMENTACIÓN','ATRACCIÓN TURÍSTICA','ENTRETENIMIENTO','TOUR','PARQUE ACUÁTICO','DISCO','OTRA'],
  formaPago:    ['EFECTIVO','CTA CORRIENTE','OTRO'],
  tipoCobro:    ['POR PERSONA','POR GRUPO', 'POR DIA', 'OTRO'],
  moneda:       ['PESO CHILENO','PESO ARGENTINO','REAL','USD','OTRO'],
  voucher:      ['FISICO','ELECTRONICO','CORREO', 'TICKET','NO APLICA'] // para la columna Voucher
};

// Orden y nombres de campos (mismo orden visual y de guardado)
const campos = [
  'servicio','tipoServicio','categoria','ciudad','restricciones',
  'proveedor','indicaciones','voucher','clave','tipoCobro','moneda','valorServicio','formaPago'
];

// Secciones por destino; `null` representa la sección "OTRO"
const destinos = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE', null];

const DESTINOS_FIJOS = new Set(
  destinos
    .filter(Boolean)
    .map(destino => destino.toUpperCase())
);

let ANO_TARIFA_ACTIVO = String(new Date().getFullYear());

function getAnoTarifaActivo() {
  return ANO_TARIFA_ACTIVO || '2025';
}

/* ===========================
   2) Utilidades globales (para exportación)
   =========================== */
// Registro de secciones para exportación global
const allSections = []; // { name:string, getAOA:()=>string[][] }

// Carga perezosa de SheetJS
function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Script load error: ' + src));
    document.head.appendChild(s);
  });
}

async function loadXLSX(){
  if (window.XLSX) return window.XLSX;
  // Probar varios CDNs por si alguno está bloqueado
  const cdns = [
    'https://cdn.jsdelivr.net/npm/xlsx@0.20.0/dist/xlsx.full.min.js',
    'https://unpkg.com/xlsx@0.20.0/dist/xlsx.full.min.js',
    'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js'
  ];
  for (const url of cdns){
    try {
      await loadScript(url);
      if (window.XLSX) return window.XLSX;
    } catch(e) {
      // sigue probando el siguiente
    }
  }
  throw new Error('No se pudo cargar XLSX desde los CDNs.');
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

function aoaToCSV(aoa){
  const esc = v => {
    const s = (v ?? '').toString();
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
    return s;
  };
  return aoa.map(row => row.map(esc).join(',')).join('\n');
}

/* ===============================================
   3) Autenticación: si no hay sesión, redirige
   =============================================== */
onAuthStateChanged(auth, u => {
  if(!u) return location.href = 'login.html';
  init();
});

/* =====================================================
   4) Inicialización de la página (filtros y construcción)
   ===================================================== */
function init(){
  setupAnoTarifa();
  setupFilter();
  setupSearch();
  destinos.forEach(d => createSection(d));

  // Botón "Administrar Proveedores" ya existe (id=btnProv).
  const btnProv = document.getElementById('btnProv');
  const headerEl = btnProv ? btnProv.closest('header') : null; // evita tomar el header de encabezado.html
  if (headerEl && btnProv) {
    const group = document.createElement('div');
    group.style.display = 'flex';
    group.style.gap = '.5rem';

    // Inserta el contenedor justo antes del botón y luego mueve el botón dentro
    headerEl.insertBefore(group, btnProv);
    group.appendChild(btnProv);

    const btnAll = document.createElement('button');
    btnAll.id = 'btnExportAll';
    btnAll.textContent = '⬇️ Exportar todo';
    btnAll.onclick = exportAllSections;
    group.appendChild(btnAll);
  }

  // Modal proveedores (callbacks globales)
  document.getElementById('btnProv').onclick = openProveedores;
  window.closeProveedores = closeProveedores;
}

function getAnoComercialActual() {
  const hoy = new Date();
  const ano = hoy.getFullYear();
  const mes = hoy.getMonth(); // enero=0, febrero=1, marzo=2

  // Año comercial Rai Trai: desde 1 de marzo
  return mes >= 2 ? ano : ano - 1;
}

function setupAnoTarifa(){
  const header = document.querySelector('header');
  if (!header) return;

  const anoActual = getAnoComercialActual();
  ANO_TARIFA_ACTIVO = String(anoActual);

  const box = document.createElement('div');
  box.style.display = 'flex';
  box.style.gap = '.5rem';
  box.style.alignItems = 'center';
  box.style.margin = '0 .75rem';

  box.innerHTML = `
    <label style="font-weight:600;">Año tarifas:</label>
    <select id="anoTarifa">
      ${[anoActual - 1, anoActual, anoActual + 1].map(a => `
        <option value="${a}" ${a === anoActual ? 'selected' : ''}>${a}</option>
      `).join('')}
    </select>
    <button id="btnCopiarTarifarioAnterior" type="button">
      📋 Copiar tarifas año anterior
    </button>
  `;

  header.appendChild(box);

  document.getElementById('anoTarifa').addEventListener('change', e => {
    ANO_TARIFA_ACTIVO = e.target.value;
    document.getElementById('secciones').innerHTML = '';
    allSections.length = 0;
    destinos.forEach(d => createSection(d));
  });

  document.getElementById('btnCopiarTarifarioAnterior').addEventListener('click', async () => {
    await copiarTarifarioAnteriorAlAnoActivo();
  });
}

/* =======================================
   5) Filtro por destino
   ======================================= */
function setupFilter(){
  const sel = document.getElementById('destFilter');
  [...sel.options].forEach(o => o.selected = (o.value === 'ALL'));
  sel.addEventListener('change', () => {
    const vals = [...sel.selectedOptions].map(o => o.value);
    const mostrarTodas = vals.includes('ALL') || vals.length === 0;
    document.querySelectorAll('.section').forEach(sec => {
      const title = sec.querySelector('h3').textContent;
      sec.style.display = (mostrarTodas || vals.includes(title)) ? '' : 'none';
    });
    if (mostrarTodas) {
      [...sel.options].forEach(o => o.selected = (o.value === 'ALL'));
    }
  });
}

/* =========================================================
   6) Buscador global – filtra filas en todas las secciones
   ========================================================= */
function _norm(s){
  return (s || '')
    .toString()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toUpperCase();
}
function applySearch(){
  const input = document.getElementById('srvSearch');
  if(!input) return;
  const q = _norm(input.value.trim());
  const rows = document.querySelectorAll('#secciones tbody tr');
  rows.forEach(tr => {
    let txt = '';
    tr.querySelectorAll('input, select').forEach(el => {
      if (el.tagName === 'SELECT' && el.multiple) {
        txt += [...el.selectedOptions].map(o => o.value).join(' ') + ' ';
      } else if (el.tagName === 'SELECT') {
        txt += (el.value || '') + ' ';
      } else {
        txt += (el.value || '') + ' ';
      }
    });
    tr.style.display = _norm(txt).includes(q) ? '' : 'none';
  });
}
function setupSearch(){
  const input = document.getElementById('srvSearch');
  if(!input) return;
  input.addEventListener('input', applySearch);
}

/* ==========================================================
   7) Construcción de una sección (destino) con su tabla
   ========================================================== */
function createSection(destFijo){
  const isOtro = destFijo === null;

  /* =====================================================
     1) Crear contenedor de la sección
     ===================================================== */
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.innerHTML = `<h3>${isOtro ? 'OTRO' : destFijo}</h3>`;
  document.getElementById('secciones').appendChild(sec);

  /* =====================================================
     2) Controles
     ===================================================== */
  const ctrl = document.createElement('div');
  ctrl.className = 'controls';

  [
    ['➕ Nueva fila', add],
    ['➕➕ Agregar 10 filas', () => {
      [...Array(10)].forEach(() => add());
    }],
    ['💾 Guardar todo', saveAll],
    ['💾 Guardar seleccionadas', saveSelected],
    ['🗑️ Eliminar seleccionadas', deleteSelected],
    ['⬇️ Exportar Excel', exportExcel]
  ].forEach(([txt, fn]) => {
    const b = document.createElement('button');
    b.textContent = txt;
    b.onclick = fn;
    ctrl.appendChild(b);
  });

  sec.appendChild(ctrl);

  /* =====================================================
     3) Tabla
     ===================================================== */
  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';

  const tbl = document.createElement('table');

  if (isOtro) {
    tbl.classList.add('tbl-servicios-otro');
  }

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');

  /*
    En OTRO agregamos Destino después de No.
    En destinos fijos se mantiene exactamente el orden anterior.
  */
  const headerTitles = isOtro
    ? [
        '',
        'No',
        'Destino',
        'Servicio',
        'Tipo Servicio',
        'Categoría',
        'Ciudad',
        'Restricciones',
        'Proveedor',
        'Indicaciones',
        'Voucher',
        'Clave',
        'Tipo Cobro',
        'Moneda',
        'Valor Servicio',
        'Forma de Pago'
      ]
    : [
        '',
        'No',
        'Servicio',
        'Tipo Servicio',
        'Categoría',
        'Ciudad',
        'Restricciones',
        'Proveedor',
        'Indicaciones',
        'Voucher',
        'Clave',
        'Tipo Cobro',
        'Moneda',
        'Valor Servicio',
        'Forma de Pago'
      ];

  headerTitles.forEach(txt => {
    const th = document.createElement('th');
    th.textContent = txt;
    trh.appendChild(th);
  });

  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody);

  wrap.appendChild(tbl);
  sec.appendChild(wrap);

  /* =====================================================
     4) Estado de la sección
     ===================================================== */
  const clavesUsadas = new Set();

  /*
    Para OTRO agregamos destino al comienzo.
    Para los destinos fijos se mantienen los campos originales.
  */
  const camposSeccion = isOtro
    ? ['destino', ...campos]
    : [...campos];

  const rows = [];
  const serviceChanges = [];

  function generarClaveUnica(){
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';

    do {
      code = Array.from(
        { length: 12 },
        () => ABC[Math.floor(Math.random() * ABC.length)]
      ).join('');
    } while (clavesUsadas.has(code));

    clavesUsadas.add(code);
    return code;
  }

  function normalizarDestino(valor){
    return (valor || '')
      .toString()
      .trim()
      .toUpperCase();
  }

  /* =====================================================
     5) Cargar proveedores según el destino de cada fila
     ===================================================== */
  async function loadProvs(tr, destinoFila, proveedorSeleccionado = ''){
    const sel = tr.querySelector('select[data-campo="proveedor"]');

    if (!sel) return;

    const destino = normalizarDestino(destinoFila);
    const proveedorActual = (
      proveedorSeleccionado ||
      sel.value ||
      ''
    ).toString().trim().toUpperCase();

    sel.innerHTML = '<option value="">—</option>';

    if (!destino) {
      if (proveedorActual) {
        sel.appendChild(
          new Option(proveedorActual, proveedorActual, true, true)
        );
      }
      return;
    }

    try {
      const snap = await getDocs(
        query(
          collection(db, 'Proveedores', destino, 'Listado'),
          orderBy('proveedor', 'asc')
        )
      );

      snap.forEach(docSnap => {
        const data = docSnap.data() || {};
        const nombre = (
          data.proveedor ||
          docSnap.id ||
          ''
        ).toString().trim().toUpperCase();

        if (!nombre) return;

        sel.appendChild(new Option(nombre, nombre));
      });

      /*
        Si el servicio tenía un proveedor que ya no aparece en el catálogo,
        no lo eliminamos de la fila.
      */
      if (
        proveedorActual &&
        ![...sel.options].some(opt => opt.value === proveedorActual)
      ) {
        sel.appendChild(
          new Option(
            `${proveedorActual} (NO ESTÁ EN CATÁLOGO)`,
            proveedorActual
          )
        );
      }

      sel.value = proveedorActual;
    } catch (error) {
      console.error(
        `No se pudieron cargar proveedores de ${destino}:`,
        error
      );

      if (proveedorActual) {
        sel.appendChild(
          new Option(proveedorActual, proveedorActual, true, true)
        );
      }
    }
  }

  /* =====================================================
     6) Numeración
     ===================================================== */
  function updateRowNumbers(){
    rows.forEach((r, index) => {
      const tr = r.checkbox.closest('tr');
      if (tr) tr.children[1].textContent = index + 1;
    });
  }

  /* =====================================================
     7) Agregar una fila
     ===================================================== */
  async function add(prefill = {}, ref = null){
    const tr = document.createElement('tr');
    const inputs = [];

    // Checkbox
    const tdChk = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    // Número de fila
    const tdNum = document.createElement('td');
    tr.appendChild(tdNum);

    for (const campo of camposSeccion) {
      const td = document.createElement('td');
      let inp;

      /* -----------------------------------------------
         Destino personalizado
         ----------------------------------------------- */
      if (campo === 'destino') {
        inp = document.createElement('input');
        inp.dataset.campo = campo;
        inp.placeholder = 'EJ.: MENDOZA';
        inp.value = normalizarDestino(prefill.destino);

        inp.addEventListener('input', () => {
          inp.value = normalizarDestino(inp.value);
          inp.title = inp.value;
        });
      }

      /* -----------------------------------------------
         Proveedor
         ----------------------------------------------- */
      else if (campo === 'proveedor') {
        inp = document.createElement('select');
        inp.dataset.campo = campo;
      }

      /* -----------------------------------------------
         Voucher
         ----------------------------------------------- */
      else if (campo === 'voucher') {
        inp = document.createElement('select');
        inp.dataset.campo = campo;

        opciones.voucher.forEach(valor => {
          inp.appendChild(new Option(valor, valor));
        });

        if (prefill[campo]) {
          const valor = prefill[campo]
            .toString()
            .trim()
            .toUpperCase();

          const opt = [...inp.options].find(o => o.value === valor);
          if (opt) opt.selected = true;
        }
      }

      /* -----------------------------------------------
         Clave electrónica
         ----------------------------------------------- */
      else if (campo === 'clave') {
        inp = document.createElement('input');
        inp.dataset.campo = campo;
        inp.readOnly = true;
        inp.value = prefill[campo] || '';
        inp.title = inp.value;

        if (inp.value) clavesUsadas.add(inp.value);
      }

      /* -----------------------------------------------
         Selectores de catálogos
         ----------------------------------------------- */
      else if (opciones[campo]) {
        inp = document.createElement('select');
        inp.dataset.campo = campo;

        if (campo === 'categoria' || campo === 'formaPago') {
          inp.multiple = true;
        }

        opciones[campo].forEach(valor => {
          inp.appendChild(new Option(valor, valor));
        });

        if (prefill[campo]) {
          const valores = Array.isArray(prefill[campo])
            ? prefill[campo]
            : [prefill[campo]];

          valores.forEach(valorOriginal => {
            const valor = (valorOriginal || '')
              .toString()
              .trim()
              .toUpperCase();

            const opt = [...inp.options].find(o => o.value === valor);
            if (opt) opt.selected = true;
          });
        }
      }

      /* -----------------------------------------------
         Inputs de texto
         ----------------------------------------------- */
      else {
        inp = document.createElement('input');
        inp.dataset.campo = campo;
        inp.value = prefill[campo] || '';
        inp.title = inp.value;

        if (campo !== 'valorServicio') {
          inp.addEventListener('input', () => {
            inp.value = (inp.value || '')
              .toString()
              .toUpperCase();

            inp.title = inp.value;
          });
        }

        inp.onfocus = () => showFloatingEditor(inp);
      }

      td.appendChild(inp);
      tr.appendChild(td);
      inputs.push(inp);
    }

    /*
      Insertamos la fila antes de hacer consultas para que el usuario
      la vea inmediatamente.
    */
    tbody.insertBefore(tr, tbody.firstChild);

    const rowData = {
      inputs,
      ref,
      checkbox: chk
    };

    rows.unshift(rowData);
    updateRowNumbers();

    /* -----------------------------------------------
       Cargar proveedores
       ----------------------------------------------- */
    const destinoInicial = isOtro
      ? normalizarDestino(prefill.destino)
      : destFijo;

    await loadProvs(
      tr,
      destinoInicial,
      prefill.proveedor || ''
    );

    /*
      En OTRO, cuando cambia el destino, se recarga el catálogo
      de proveedores correspondiente.
    */
    if (isOtro) {
      const destinoInp = tr.querySelector(
        'input[data-campo="destino"]'
      );

      if (destinoInp) {
        destinoInp.addEventListener('change', async () => {
          const proveedorSel = tr.querySelector(
            'select[data-campo="proveedor"]'
          );

          const proveedorAnterior = proveedorSel?.value || '';

          await loadProvs(
            tr,
            destinoInp.value,
            proveedorAnterior
          );

          applySearch();
        });
      }
    }

    /* -----------------------------------------------
       Voucher electrónico y clave
       ----------------------------------------------- */
    const voucherSel = tr.querySelector(
      'select[data-campo="voucher"]'
    );

    const claveInp = tr.querySelector(
      'input[data-campo="clave"]'
    );

    if (voucherSel && claveInp) {
      const ensureClave = () => {
        if (voucherSel.value === 'ELECTRONICO') {
          if (!claveInp.value) {
            claveInp.value = generarClaveUnica();
          }
        } else {
          claveInp.value = '';
        }

        claveInp.title = claveInp.value;
      };

      voucherSel.addEventListener('change', ensureClave);
      ensureClave();
    }

    inputs.forEach(inp => {
      inp.addEventListener('paste', e => {
        e.stopPropagation();
      });
    });

    applySearch();
  }

  /* =====================================================
     8) Cargar servicios del año
     ===================================================== */
  async function cargarServicios(){
    try {
      /*
        Destino fijo: solo carga la colección de ese destino.
      */
      if (!isOtro) {
        const snap = await getDocs(
          query(
            collection(
              db,
              'ServiciosPorAno',
              getAnoTarifaActivo(),
              'Destinos',
              destFijo,
              'Listado'
            ),
            orderBy('servicio', 'asc')
          )
        );

        for (const docSnap of snap.docs) {
          const data = docSnap.data() || {};

          const prefill = {
            ...data,
            servicio: data.servicio || docSnap.id,
            destino: destFijo
          };

          if (prefill.clave) {
            clavesUsadas.add(prefill.clave);
          }

          await add(
            prefill,
            doc(
              db,
              'ServiciosPorAno',
              getAnoTarifaActivo(),
              'Destinos',
              destFijo,
              'Listado',
              docSnap.id
            )
          );
        }

        return;
      }

      /*
        OTRO:
        1. Lee todos los documentos de Destinos.
        2. Excluye los destinos fijos.
        3. Carga sus servicios.
      */
      const destinosSnap = await getDocs(
        collection(
          db,
          'ServiciosPorAno',
          getAnoTarifaActivo(),
          'Destinos'
        )
      );

      const destinosPersonalizados = destinosSnap.docs
        .map(docSnap => normalizarDestino(docSnap.id))
        .filter(destino => {
          return (
            destino &&
            destino !== 'OTRO' &&
            !DESTINOS_FIJOS.has(destino)
          );
        })
        .sort((a, b) => a.localeCompare(b, 'es'));

      for (const destino of destinosPersonalizados) {
        const serviciosSnap = await getDocs(
          query(
            collection(
              db,
              'ServiciosPorAno',
              getAnoTarifaActivo(),
              'Destinos',
              destino,
              'Listado'
            ),
            orderBy('servicio', 'asc')
          )
        );

        for (const docSnap of serviciosSnap.docs) {
          const data = docSnap.data() || {};

          const prefill = {
            ...data,
            destino,
            servicio: data.servicio || docSnap.id
          };

          if (prefill.clave) {
            clavesUsadas.add(prefill.clave);
          }

          await add(
            prefill,
            doc(
              db,
              'ServiciosPorAno',
              getAnoTarifaActivo(),
              'Destinos',
              destino,
              'Listado',
              docSnap.id
            )
          );
        }
      }
    } catch (error) {
      console.error(
        `Error cargando servicios de ${isOtro ? 'OTRO' : destFijo}:`,
        error
      );

      alert(
        `No se pudieron cargar los servicios de ${
          isOtro ? 'OTRO' : destFijo
        }.\n\n${error.message}`
      );
    }
  }

  /* =====================================================
     9) Guardar una fila
     ===================================================== */
  async function commit(r, idx){
    const data = {};

    r.inputs.forEach(input => {
      data[input.dataset.campo] = input.multiple
        ? [...input.selectedOptions].map(opt => opt.value)
        : (input.value ?? '').toString().trim().toUpperCase();
    });

    const destino = normalizarDestino(
      isOtro ? data.destino : destFijo
    );

    const servicio = (
      data.servicio ||
      ''
    ).toString().trim().toUpperCase();

    const proveedor = (
      data.proveedor ||
      ''
    ).toString().trim().toUpperCase();

    if (!destino) {
      throw new Error(`F${idx}: Falta Destino`);
    }

    if (!servicio) {
      throw new Error(`F${idx}: Falta Servicio`);
    }

    if (!proveedor) {
      throw new Error(`F${idx}: Falta Proveedor`);
    }

    /*
      Evita guardar un destino fijo accidentalmente dentro de OTRO.
    */
    if (isOtro && DESTINOS_FIJOS.has(destino)) {
      throw new Error(
        `F${idx}: ${destino} ya tiene una sección propia. ` +
        `Guarda el servicio en la sección ${destino}.`
      );
    }

    /*
      Guardamos el destino también dentro del documento.
      La ruta sigue siendo la fuente principal, pero este campo facilita
      exportaciones, diagnósticos y futuras consultas.
    */
    const payload = {
      ...data,
      destino,
      destinoTarifa: destino,
      anoTarifa: Number(getAnoTarifaActivo()),
      servicio,
      proveedor
    };

    await setDoc(
      doc(
        db,
        'ServiciosPorAno',
        getAnoTarifaActivo()
      ),
      {
        _created: true,
        anoTarifa: Number(getAnoTarifaActivo())
      },
      { merge: true }
    );

    await setDoc(
      doc(
        db,
        'ServiciosPorAno',
        getAnoTarifaActivo(),
        'Destinos',
        destino
      ),
      {
        _created: true,
        destino,
        anoTarifa: Number(getAnoTarifaActivo())
      },
      { merge: true }
    );

    const targetId = servicio;

    const newRef = doc(
      db,
      'ServiciosPorAno',
      getAnoTarifaActivo(),
      'Destinos',
      destino,
      'Listado',
      targetId
    );

    const newVisible = _visibleSvc(payload, targetId);

    if (r.ref) {
      const parts = r.ref.path.split('/');

      /*
        ServiciosPorAno/{ano}/Destinos/{destino}/Listado/{servicio}
      */
      const oldDest = normalizarDestino(parts[3]);
      const oldId = parts[5];

      const destChanged = oldDest !== destino;
      const idChanged = oldId !== targetId;

      let oldData = null;

      try {
        const oldSnap = await getDoc(r.ref);
        if (oldSnap.exists()) {
          oldData = oldSnap.data();
        }
      } catch (error) {
        console.warn(
          'No se pudo leer la versión anterior del servicio:',
          error
        );
      }

      const oldVisible = _visibleSvc(oldData, oldId);

      if (!destChanged && !idChanged) {
        const willAddAlias =
          oldVisible &&
          oldVisible !== newVisible;

        const merged = willAddAlias
          ? {
              ...payload,
              aliases: Array.from(
                new Set([
                  ...(oldData?.aliases || []),
                  oldVisible
                ])
              )
            }
          : payload;

        await setDoc(r.ref, merged, { merge: true });

        if (willAddAlias) {
          serviceChanges.push({
            destino,
            oldId,
            newId: targetId,
            oldVisible,
            newVisible,
            aliases: [oldVisible]
          });
        }
      } else {
        /*
          Cambió el nombre o el destino:
          crea el documento nuevo y elimina la ubicación anterior.
        */
        const aliasSet = new Set(
          (oldData?.aliases || []).map(alias => _U(alias))
        );

        const oldIdU = _U(oldId);
        const oldVisibleU = _U(oldVisible);

        if (oldIdU) aliasSet.add(oldIdU);
        if (oldVisibleU) aliasSet.add(oldVisibleU);

        aliasSet.delete(newVisible);

        const merged = {
          ...payload,
          aliases: Array.from(aliasSet),
          prevIds: Array.from(
            new Set([
              ...(oldData?.prevIds || []),
              oldId
            ])
          ),
          destinoAnterior: oldDest
        };

        await setDoc(newRef, merged, { merge: true });

        try {
          await deleteDoc(r.ref);
        } catch (error) {
          console.warn(
            'El servicio nuevo se guardó, pero no se pudo eliminar la ubicación anterior:',
            error
          );
        }

        serviceChanges.push({
          destino,
          oldDestino: oldDest,
          oldId,
          newId: targetId,
          oldVisible: oldVisible || oldId,
          newVisible,
          aliases: Array.from(aliasSet)
        });

        r.ref = newRef;
      }
    } else {
      await setDoc(newRef, payload, { merge: true });
      r.ref = newRef;
    }
  }

  /* =====================================================
     10) Guardar todo
     ===================================================== */
  async function saveAll(){
    const errores = [];

    for (let i = 0; i < rows.length; i++) {
      try {
        await commit(rows[i], i + 1);
      } catch (error) {
        errores.push(error.message);
      }
    }

    updateRowNumbers();

    if (serviceChanges.length) {
      await propagarCambiosASItinerarios(
        serviceChanges,
        { ask: true }
      );

      serviceChanges.length = 0;
    }

    alert(
      errores.length
        ? `⚠️ Errores:\n${errores.join('\n')}`
        : '✅ Todos guardados'
    );
  }

  /* =====================================================
     11) Guardar seleccionadas
     ===================================================== */
  async function saveSelected(){
    const seleccionadas = rows.filter(
      row => row.checkbox.checked
    );

    if (!seleccionadas.length) {
      alert('❗ No hay filas seleccionadas');
      return;
    }

    const errores = [];

    for (const row of seleccionadas) {
      const idx = rows.indexOf(row) + 1;

      try {
        await commit(row, idx);
      } catch (error) {
        errores.push(error.message);
      }
    }

    updateRowNumbers();

    if (serviceChanges.length) {
      await propagarCambiosASItinerarios(
        serviceChanges,
        { ask: true }
      );

      serviceChanges.length = 0;
    }

    alert(
      errores.length
        ? `⚠️ Errores:\n${errores.join('\n')}`
        : '✅ Seleccionadas guardadas'
    );
  }

  /* =====================================================
     12) Eliminar seleccionadas
     ===================================================== */
  async function deleteSelected(){
    const seleccionadas = rows.filter(
      row => row.checkbox.checked
    );

    if (!seleccionadas.length) {
      alert('❗ No hay filas seleccionadas');
      return;
    }

    const confirmar = confirm(
      `¿Eliminar ${seleccionadas.length} servicio(s) seleccionado(s)?`
    );

    if (!confirmar) return;

    const errores = [];

    for (const row of seleccionadas) {
      try {
        if (row.ref) {
          await deleteDoc(row.ref);
        }

        row.checkbox.closest('tr')?.remove();
      } catch (error) {
        errores.push(error.message);
        row.checkbox.checked = false;
      }
    }

    const restantes = rows.filter(row => {
      return !seleccionadas.includes(row) ||
             !row.checkbox.checked;
    });

    rows.splice(0, rows.length, ...restantes);
    updateRowNumbers();

    alert(
      errores.length
        ? `⚠️ Algunos servicios no pudieron eliminarse:\n${errores.join('\n')}`
        : '🗑️ Servicios eliminados'
    );
  }

  /* =====================================================
     13) Filas visibles para exportación
     ===================================================== */
  function rowsVisibles(){
    return rows.filter(row => {
      const tr = row.checkbox.closest('tr');

      return (
        tr &&
        tr.offsetParent !== null &&
        tr.style.display !== 'none'
      );
    });
  }

  /* =====================================================
     14) Construir datos para Excel
     ===================================================== */
  function toAOA(){
    const headers = [
      'No',
      ...headerTitles.slice(2)
    ];

    const body = rowsVisibles().map(row => {
      const result = [
        rows.indexOf(row) + 1
      ];

      row.inputs.forEach(input => {
        if (input.multiple) {
          result.push(
            [...input.selectedOptions]
              .map(opt => opt.value)
              .join(' | ')
          );
        } else {
          result.push(
            (input.value ?? '').toString()
          );
        }
      });

      return result;
    });

    return [
      headers,
      ...body
    ];
  }

  /* =====================================================
     15) Exportar sección
     ===================================================== */
  async function exportExcel(){
    const aoa = toAOA();
    const nombreSeccion = isOtro ? 'OTRO' : destFijo;
    const fecha = new Date().toISOString().slice(0, 10);

    const nombre =
      `Servicios_${getAnoTarifaActivo()}_` +
      `${nombreSeccion}_${fecha}.xlsx`;

    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);

      XLSX.utils.book_append_sheet(
        wb,
        ws,
        nombreSeccion.slice(0, 31)
      );

      XLSX.writeFile(wb, nombre);
    } catch (error) {
      const csv = aoaToCSV(aoa);

      downloadBlob(
        new Blob(
          [csv],
          { type: 'text/csv;charset=utf-8' }
        ),
        nombre.replace(/\.xlsx$/i, '.csv')
      );

      alert(
        'No se pudo cargar XLSX. ' +
        'Se exportó CSV para abrirlo en Excel.'
      );
    }
  }

  /* =====================================================
     16) Registrar sección para exportación global
     ===================================================== */
  allSections.push({
    name: isOtro ? 'OTRO' : destFijo,
    getAOA: toAOA
  });

  /* =====================================================
     17) Iniciar carga
     ===================================================== */
  cargarServicios();
}

/* =========================================================
   8) Exportación GLOBAL (todas las secciones a un .xlsx)
   ========================================================= */
async function exportAllSections(){
  const fecha = new Date().toISOString().slice(0,10);
  try {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();

    allSections.forEach(sec => {
      const aoa = sec.getAOA();                 // respeta buscador (filas visibles)
      const ws  = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, sec.name.slice(0,31));
    });

    XLSX.writeFile(wb, `Servicios_TODOS_${getAnoTarifaActivo()}_${fecha}.xlsx`);
  } catch {
    // Fallback: un CSV por sección
    allSections.forEach(sec => {
      const csv = aoaToCSV(sec.getAOA());
      downloadBlob(new Blob([csv], {type:'text/csv;charset=utf-8'}), `Servicios_${sec.name}_${fecha}.csv`);
    });
    alert('No se pudo cargar XLSX. Se exportó un CSV por sección.');
  }
}

/* ======================================================
   Reparación masiva: propagar cambios de Servicios → Itinerarios
   ====================================================== */
function _U(s){ return (s ?? '').toString().trim().toUpperCase(); }
function _visibleSvc(data, id){ return _U(data?.nombre || data?.servicio || id); }

/**
 * Aplica a TODOS los grupos los cambios de servicios detectados.
 * changes: [{ destino, oldId, newId, oldVisible, newVisible, aliases[] }]
 */
async function propagarCambiosASItinerarios(changes, { ask = true } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) return;

  if (ask) {
    const ok = confirm(
      `Se detectaron ${changes.length} servicio(s) cambiado(s).\n` +
      `¿Propagar los cambios a todos los itinerarios ahora?`
    );
    if (!ok) return;
  }

  const gSnap = await getDocs(collection(db, 'grupos'));
  let gruposMod = 0, actsMod = 0;

  for (const d of gSnap.docs) {
    const g = d.data() || {};
    const it = g.itinerario || {};
    if (!it || Object.keys(it).length === 0) continue;

    let touched = false;
    const nuevo = {};
    for (const f of Object.keys(it)) {
      const arr = Array.isArray(it[f]) ? it[f] : [];
      const out = arr.map(a0 => {
        const A = { ...a0 };
        const actName = _U(A.actividad);
        const actId   = _U(A.servicioId);

        for (const ch of changes) {
          const newId   = _U(ch.newId);
          const oldId   = _U(ch.oldId || '');
          const newName = _U(ch.newVisible);
          const oldName = _U(ch.oldVisible || '');
          const aliases = (ch.aliases || []).map(_U);

          const hitId  = actId && (actId === newId || (oldId && actId === oldId));
          const hitTxt = !A.servicioId && (actName === oldName || aliases.includes(actName));

          if (hitId || hitTxt) {
            A.servicioId      = ch.newId;
            A.servicioNombre  = ch.newVisible;
            A.servicioDestino = ch.destino;
            A.actividad       = ch.newVisible;   // reflejar nombre vigente
            touched = true;
            actsMod++;
            break;
          }
        }
        return A;
      });
      nuevo[f] = out;
    }

    if (touched) {
      await updateDoc(doc(db, 'grupos', d.id), { itinerario: nuevo });
      gruposMod++;
    }
  }

  alert(
    'Propagación completa.\n' +
    `Grupos modificados: ${gruposMod}\n` +
    `Actividades actualizadas: ${actsMod}`
  );
}

/* =====================================================
   9) Editor flotante (se mantiene igual)
   ===================================================== */
let floating = null;
function showFloatingEditor(input){
  if(floating) floating.remove();
  floating = document.createElement('textarea');
  floating.className = 'floating-editor';
  floating.value = input.value;
  document.body.appendChild(floating);
  const r = input.getBoundingClientRect();
  floating.style.top  = `${r.bottom + scrollY + 4}px`;
  floating.style.left = `${r.left + scrollX}px`;
  floating.oninput = () => { input.value = floating.value; input.title = floating.value; };
  floating.onblur  = () => { floating.remove(); floating = null; };
  floating.focus();
}

/* =====================================================
   10) Modal de proveedores (igual)
   ===================================================== */
function openProveedores(){
  document.getElementById('iframe-prov').src='proveedores.html';
  document.getElementById('backdrop-prov').style.display='block';
  document.getElementById('modal-prov').style.display='block';
}
function closeProveedores(){
  document.getElementById('iframe-prov').src='';
  document.getElementById('backdrop-prov').style.display='none';
  document.getElementById('modal-prov').style.display='none';
}

/* =====================================================
   11) MIGRACIÓN ÚNICA: Servicios actuales → Tarifas 2025
   Ejecutar una sola vez desde consola:
   migrarServiciosActualesA2025()
   ===================================================== */
async function migrarServiciosActualesA2025() {
  const destinosMigrar = ['BRASIL', 'BARILOCHE', 'SUR DE CHILE', 'NORTE DE CHILE'];

  if (!confirm(
    'Esto copiará los servicios actuales desde Servicios/{DESTINO}/Listado hacia ServiciosPorAno/2025/Destinos/{DESTINO}/Listado.\n\n' +
    'No se borrará nada de la ruta antigua.\n\n¿Continuar?'
  )) {
    return;
  }

  let totalMigrados = 0;

  for (const destino of destinosMigrar) {
    console.log(`🔄 Migrando destino: ${destino}`);

    const snap = await getDocs(collection(db, 'Servicios', destino, 'Listado'));

    await setDoc(doc(db, 'ServiciosPorAno', '2025'), {
      _created: true,
      anoTarifa: 2025
    }, { merge: true });

    await setDoc(doc(db, 'ServiciosPorAno', '2025', 'Destinos', destino), {
      _created: true,
      destino
    }, { merge: true });

    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};

      await setDoc(
        doc(db, 'ServiciosPorAno', '2025', 'Destinos', destino, 'Listado', docSnap.id),
        {
          ...data,
          anoTarifa: 2025,
          destinoTarifa: destino,
          migradoDesde: `Servicios/${destino}/Listado/${docSnap.id}`,
          fechaMigracion: new Date().toISOString()
        },
        { merge: true }
      );

      totalMigrados++;
    }

    console.log(`✅ ${destino}: ${snap.size} servicios migrados`);
  }

  console.log(`✅ Migración completa. Total servicios migrados: ${totalMigrados}`);
  alert(`✅ Migración 2025 completada.\nServicios migrados: ${totalMigrados}`);
}

window.migrarServiciosActualesA2025 = migrarServiciosActualesA2025;

/* =====================================================
   12) BOTÓN: Copiar tarifas del año anterior al año activo
   Ejemplo:
   Año activo 2026 → copia 2025 a 2026
   Año activo 2027 → copia 2026 a 2027
   ===================================================== */
async function copiarTarifarioAnteriorAlAnoActivo() {
  const anoDestino = getAnoTarifaActivo();
  const anoOrigen = String(Number(anoDestino) - 1);

  const destinosCopiar = ['BRASIL', 'BARILOCHE', 'SUR DE CHILE', 'NORTE DE CHILE'];

  const ok = confirm(
    `Esto copiará las tarifas ${anoOrigen} hacia ${anoDestino}.\n\n` +
    `Se usará el tarifario anterior como plantilla.\n` +
    `No se copiarán abonos.\n` +
    `Si ya existen servicios en ${anoDestino}, se actualizarán con merge.\n\n` +
    `¿Continuar?`
  );

  if (!ok) return;
  
  let totalExistentes = 0;
  for (const destino of destinosCopiar) {
    const existeSnap = await getDocs(
      collection(db, 'ServiciosPorAno', anoDestino, 'Destinos', destino, 'Listado')
    );
    totalExistentes += existeSnap.size;
  }
  
  if (totalExistentes > 0) {
    const ok2 = confirm(
      `⚠️ Ya existen ${totalExistentes} servicios en el tarifario ${anoDestino}.\n\n` +
      `Si continúas, se mezclarán/actualizarán con datos del ${anoOrigen}.\n\n` +
      `¿Seguro que quieres continuar?`
    );
    if (!ok2) return;
  }
  
  let totalCopiados = 0;

  await setDoc(doc(db, 'ServiciosPorAno', anoDestino), {
    _created: true,
    anoTarifa: Number(anoDestino),
    copiadoDesdeAno: Number(anoOrigen),
    fechaCopia: new Date().toISOString()
  }, { merge: true });

  for (const destino of destinosCopiar) {
    const snap = await getDocs(
      collection(db, 'ServiciosPorAno', anoOrigen, 'Destinos', destino, 'Listado')
    );

    await setDoc(doc(db, 'ServiciosPorAno', anoDestino, 'Destinos', destino), {
      _created: true,
      destino,
      copiadoDesdeAno: Number(anoOrigen),
      fechaCopia: new Date().toISOString()
    }, { merge: true });

    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};

      const limpio = { ...data };

      // No arrastramos metadata de migración anterior
      delete limpio.migradoDesde;
      delete limpio.fechaMigracion;
      delete limpio.copiadoDesdeAno;
      delete limpio.fechaCopia;

      await setDoc(
        doc(db, 'ServiciosPorAno', anoDestino, 'Destinos', destino, 'Listado', docSnap.id),
        {
          ...limpio,
          anoTarifa: Number(anoDestino),
          destinoTarifa: destino,
          copiadoDesdeAno: Number(anoOrigen),
          fechaCopia: new Date().toISOString()
        },
        { merge: true }
      );

      totalCopiados++;
    }

    console.log(`✅ ${destino}: ${snap.size} servicios copiados de ${anoOrigen} a ${anoDestino}`);
  }

  alert(
    `✅ Tarifario copiado.\n\n` +
    `Origen: ${anoOrigen}\n` +
    `Destino: ${anoDestino}\n` +
    `Servicios copiados: ${totalCopiados}`
  );

  // Recargar tabla del año activo para ver lo copiado
  document.getElementById('secciones').innerHTML = '';
  allSections.length = 0;
  destinos.forEach(d => createSection(d));
}

window.copiarTarifarioAnteriorAlAnoActivo = copiarTarifarioAnteriorAlAnoActivo;
