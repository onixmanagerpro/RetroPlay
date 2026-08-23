/**
 * emulator.js
 * -----------------------------------------------------------------------
 * Motor de emulación en navegador de RetroPlay.
 *
 * IMPLEMENTACIÓN REAL, no una maqueta: se apoya en EmulatorJS
 * (https://emulatorjs.org, licencia GPL-3.0), un frontend de código
 * abierto para cores de RetroArch/libretro compilados a WebAssembly.
 * Es el mismo enfoque técnico que pide el brief ("emuladores basados en
 * JavaScript/WebAssembly").
 *
 * QUÉ HAY VENDORIZADO EN /vendor/emulatorjs (real, descargado y
 * compilado desde el repositorio oficial, no simulado):
 *   - loader.js          -> bootstrap oficial, sin modificar
 *   - emulator.min.js    -> el reproductor completo, compilado con Rollup
 *                           desde el código fuente oficial (data/src/*.js)
 *   - emulator.min.css   -> estilos oficiales del reproductor
 *   - libunrar.js/.wasm  -> descompresión de ROMs comprimidas
 *   - localization/      -> textos multi-idioma oficiales
 *
 * QUÉ NO ESTÁ INCLUIDO Y POR QUÉ:
 *   Los binarios .wasm de cada CORE (snes9x, genesis_plus_gx,
 *   mupen64plus_next, flycast, mednafen_psx) pesan varios MB cada uno y
 *   no se distribuyen en el paquete npm base ni en el repo git -- el
 *   propio proyecto los sirve desde su CDN oficial en runtime. Por eso
 *   EJS_pathtodata apunta por defecto a ese CDN (exactamente como
 *   EmulatorJS recomienda para producción). Para self-hosting basta con
 *   cambiar CORE_DATA_CDN a la carpeta local correspondiente en
 *   /emulators/<consola>/.
 *
 * Cada consola soportada mapea a un core real de libretro:
 *   SNES        -> snes9x
 *   Mega Drive  -> genesis_plus_gx
 *   N64         -> mupen64plus_next
 *   Dreamcast   -> flycast
 *   PS1         -> mednafen_psx
 *
 * AISLAMIENTO EN IFRAME
 * -----------------------------------------------------------------------
 * loader.js declara `const folderPath = ...` (y otras) en el scope
 * GLOBAL del documento donde se ejecuta, sin envolverse en una IIFE ni
 * cargarse como módulo. Si se inyecta dos veces en el mismo `window`
 * (segunda partida, reintento tras un fallo de red, doble clic en
 * "Jugar"), la segunda ejecución choca con la primera:
 *
 *   Uncaught SyntaxError: Identifier 'folderPath' has already been
 *   declared
 *
 * y todo lo que hay debajo de esa línea en loader.js deja de ejecutarse,
 * lo que a su vez hace que EmulatorJS nunca llegue a inicializar el
 * reproductor real. Quitar el <script> del DOM (lo que hacía la versión
 * anterior de este archivo) NO deshace esa declaración: una vez que el
 * navegador ejecutó `const folderPath = ...` en el global, esa
 * declaración vive ahí hasta que el propio `window` se destruye.
 *
 * La solución robusta es que cada partida corra en su propio `window`
 * real: un <iframe> nuevo por cada `launch()`. Cada iframe tiene su
 * propio scope global aislado, así que loader.js puede ejecutarse
 * tantas veces como se quiera -- una vez por iframe -- sin colisionar
 * jamás consigo mismo. Cerrar el juego destruye el iframe entero, lo
 * que además libera la memoria WASM de forma mucho más fiable que
 * intentar anular referencias sueltas en `window.EJS_emulator`.
 * -----------------------------------------------------------------------
 */

const EMULATORJS_VENDOR_PATH = 'vendor/emulatorjs/';

// Por defecto servimos los assets de los cores desde el CDN oficial de
// EmulatorJS (así es como el propio proyecto se despliega en producción,
// ver https://emulatorjs.org/docs/api). Para self-hosting de los cores,
// cambia esta constante a la carpeta local correspondiente.
const CORE_DATA_CDN = 'https://cdn.emulatorjs.org/stable/data/';

const CONSOLE_CORE_MAP = {
  'SNES': { core: 'snes9x', folder: 'emulators/snes' },
  'Mega Drive': { core: 'segaMD', folder: 'emulators/megadrive' },
  'Nintendo 64': { core: 'n64', folder: 'emulators/n64' },
  'Dreamcast': { core: 'flycast', folder: 'emulators/dreamcast' },
  'PS1': { core: 'psx', folder: 'emulators/ps1' },
  'GBA': { core: 'mgba', folder: 'emulators/gba' },
  'PS2': { core: 'play', folder: 'emulators/ps2' }
};

const BOOT_MESSAGES = [
  'Cargando reproductor EmulatorJS…',
  'Descargando núcleo WebAssembly…',
  'Preparando memoria del emulador…',
  'Montando archivo de juego…',
  'Sincronizando entrada de mando…'
];

// -----------------------------------------------------------------------
// [SAVE-VERIFY] Mismo prefijo de log que storage.js -- deliberadamente,
// para que un fallo de guardado/carga se pueda seguir de principio a fin
// en la consola filtrando por "[SAVE-VERIFY]", sin importar si el fallo
// ocurrió en la capa de persistencia (storage.js) o en la capa de
// orquestación del emulador (este archivo).
// -----------------------------------------------------------------------
function saveVerifyLog(...args) {
  console.log('[SAVE-VERIFY]', ...args);
}
function saveVerifyError(...args) {
  console.error('[SAVE-VERIFY]', ...args);
}

class EmulatorController {
  constructor() {
    this.currentGame = null;
    this.currentConsole = null;
    this._bootLogTimer = null;
    this._active = false;
    this._iframe = null; // iframe activo de la partida en curso
    this._romLoadAbortController = null;
    this._romObjectUrls = new Set();
    this._romAssets = null;
    this._startTimeout = null;
    // No hay autosave de ningún tipo: guardar y cargar son siempre
    // acciones explícitas del usuario a través de saveState(name) /
    // loadState(saveId), con nombre elegido por él y persistidas en
    // Firebase (ver storage.js).
  }

  isSupported(consoleId) {
    return !!CONSOLE_CORE_MAP[consoleId];
  }

  // [SAVE-VERIFY] Puente hacia el sistema de toasts de app.js
  // (showToast), sin crear una dependencia dura: si por lo que sea
  // showToast no está cargado en la página (uso de emulator.js fuera de
  // este contexto, orden de carga distinto), se degrada a console.error
  // en vez de lanzar. Un fallo de guardado siempre debe ser visible en
  // algún sitio -- nunca silencioso -- pero nunca debe romper el resto
  // de la app por sí mismo.
  _notifyUser(message) {
    // showToast() de app.js está diseñado para el flujo de descarga
    // (progreso + finishToast lo completa/actualiza) y no se
    // auto-elimina por sí solo -- usarlo tal cual para un aviso puntual
    // dejaría el toast pegado en pantalla para siempre. Por eso se usa
    // showSaveWarningToast(), una función separada en app.js pensada
    // para avisos puntuales con auto-dismiss, que reutiliza el mismo
    // contenedor y las mismas clases CSS (mismo aspecto visual, sin
    // duplicar estilos).
    if (typeof window !== 'undefined' && typeof window.showSaveWarningToast === 'function') {
      window.showSaveWarningToast(message);
    } else {
      saveVerifyError('(sin showSaveWarningToast disponible) ', message);
    }
  }

  /**
   * Devuelve el `window` del iframe activo, o null si no hay ninguna
   * partida en curso. Todo acceso a EJS_emulator pasa por aquí en vez
   * de leer window.EJS_emulator directamente (ese global pertenece al
   * documento padre, que ya no es donde vive el reproductor).
   */
  _emulatorWindow() {
    return this._iframe?.contentWindow || null;
  }

  getEmulatorInstance() {
    return this._emulatorWindow()?.EJS_emulator || null;
  }

  /**
   * Devuelve el foco de teclado al documento del iframe donde vive el
   * juego. Necesario tras cualquier cambio de fullscreen: EmulatorJS
   * escucha "keydown" sobre SU PROPIO document (el del iframe), y
   * requestFullscreen() en el elemento padre no transfiere el foco al
   * iframe hijo automáticamente -- el navegador puede dejarlo en el
   * <body> del documento padre, y entonces los controles de teclado
   * dejan de responder hasta que se hace clic manualmente dentro del
   * juego.
   */
  focusGame() {
    const iWin = this._emulatorWindow();
    if (!iWin) return;
    // El propio iframe también necesita el foco a nivel de navegador,
    // no solo su document interno.
    this._iframe?.focus();
    iWin.focus();
  }

  async _prepareGoogleDriveEntries(fileField, iWin, onBootMessage, signal) {
    const assets = await window.loadGoogleDriveGameFiles(fileField, {
      signal,
      onProgress: onBootMessage
    });

    // EmulatorJS identifica los File mediante instanceof dentro del iframe,
    // por eso el objeto se crea en el realm del iframe y conserva el .cue.
    if (typeof iWin.File !== 'function') {
      assets.release();
      throw new Error('Este navegador no admite File para cargar el juego en memoria.');
    }

    const entries = [{
      name: assets.main.name,
      size: assets.main.size,
      file: new iWin.File([assets.main.blob], assets.main.name, { type: assets.main.mimeType })
    }];

    for (const companion of assets.companions) {
      const objectUrl = URL.createObjectURL(companion.blob);
      this._romObjectUrls.add(objectUrl);
      // mountedName mantiene exactamente lo escrito en la línea FILE del CUE.
      entries.push({ name: companion.mountedName, size: companion.size, url: objectUrl });
    }

    this._romAssets = assets;
    return entries;
  }

  _releaseRomResources() {
    this._romLoadAbortController?.abort();
    this._romLoadAbortController = null;

    for (const objectUrl of this._romObjectUrls) URL.revokeObjectURL(objectUrl);
    this._romObjectUrls.clear();

    this._romAssets?.release?.();
    this._romAssets = null;
  }

  /**
   * Lanza el emulador para un juego dado dentro del contenedor indicado.
   * `hostEl` es el nodo DOM (#emulator-canvas-host) donde se crea el
   * iframe aislado que aloja al reproductor real.
   */
  async launch(game, hostEl, { onBootMessage, onReady, onError } = {}) {
    if (!this.isSupported(game.console)) {
      onError?.(`La consola "${game.console}" no está configurada para emulación en navegador.`);
      return;
    }

    // Si ya había una partida en curso (segunda pulsación de "Jugar",
    // cambio de juego sin haber cerrado antes), la cerramos primero por
    // completo -- destruyendo su iframe -- antes de abrir la nueva.
    // Esto es lo que garantiza que loader.js nunca se ejecute dos veces
    // en el mismo scope global.
    if (this._active) {
      await this.close();
    }

    this._active = true;
    this.currentGame = game;
    this.currentConsole = game.console;
    const loadAbortController = new AbortController();
    this._romLoadAbortController = loadAbortController;
    const coreInfo = CONSOLE_CORE_MAP[game.console];

    this._runBootSequence(onBootMessage);
    hostEl.innerHTML = '';

    try {
      // El progreso ya NO se recupera automáticamente al lanzar el juego:
      // el único mecanismo de guardado/carga es el par de botones
      // "Guardar partida" / "Cargar partida" de la topbar, con nombre
      // elegido por el usuario (ver saveState()/loadState() más abajo y
      // storage.js). No hay autosave.
      if (loadAbortController.signal.aborted || !this._active || this.currentGame !== game) return;

      const iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'gamepad; fullscreen; autoplay');
      // Sin este atributo legacy, requestFullscreen() invocado DESDE
      // dentro del iframe (p.ej. el botón nativo de EmulatorJS) es
      // rechazado por el navegador aunque la Permissions Policy de
      // arriba lo permita -- son dos mecanismos distintos.
      iframe.allowFullscreen = true;
      iframe.style.cssText = 'width:100%; height:100%; border:0; display:block; background:#000;';
      hostEl.appendChild(iframe);
      this._iframe = iframe;

      const iWin = iframe.contentWindow;
      const iDoc = iframe.contentDocument;

      // Documento base mínimo dentro del iframe: EmulatorJS necesita un
      // <body> donde anclar su UI y busca el elemento EJS_player por
      // selector CSS dentro de ESTE documento, no del padre.
      iDoc.open();
      iDoc.write('<!DOCTYPE html><html style="width:100%;height:100%;"><head><meta charset="utf-8"><style>' +
        // Red de seguridad visual: si el core cae a su menú interno de
        // configuración (p.ej. "Main Menu" de pcsx_rearmed cuando el
        // disco no es válido), esto lo oculta por completo en vez de
        // dejarlo visible sobre el reproductor de RetroPlay.
        '.ejs-retroarch-menu,.retroarch-menu,[class*="rgui"],[class*="quick-menu"]{display:none !important;}' +
        '</style></head><body style="margin:0;width:100%;height:100%;background:#000;overflow:hidden;"><div id="emulator-root" style="width:100%;height:100%;"></div></body></html>');
      iDoc.close();

      // --- Variables de configuración de EmulatorJS (API oficial EJS_*) ---
      // Se definen en el `window` del IFRAME, que es donde loader.js las
      // va a leer al ejecutarse dentro de ese mismo documento.
      iWin.EJS_player = '#emulator-root';
      iWin.EJS_core = coreInfo.core;
      // game.file puede ser:
      //   - un string: una ruta local (/games/snes/...) o una referencia
      //     github-release://owner/repo@tag/fragmento (un solo archivo,
      //     comportamiento de siempre).
      //   - un ARRAY de strings: un juego multi-archivo (típicamente PS1
      //     con .cue + uno o más .bin). Cada elemento se resuelve igual
      //     que el caso anterior (local o github-release://), y luego:
      //       * el archivo "principal" (.cue/.m3u/.ccd/.toc, o el primero
      //         si ninguno coincide) se pasa como EJS_gameUrl de siempre.
      //       * el resto se pasa como EJS_externalFiles: EmulatorJS los
      //         descarga y los escribe en su filesystem virtual ANTES de
      //         arrancar el juego, así cuando el core lee el .cue y busca
      //         el .bin por su nombre, ya está montado.
      //     Ver js/github-release-source.js (resolveGameFileEntries) para
      //     el detalle de por qué esto es necesario con GitHub Releases.
      const entries = window.isGoogleDriveGameSource?.(game.file)
        ? await this._prepareGoogleDriveEntries(game.file, iWin, onBootMessage, loadAbortController.signal)
        : await window.resolveGameFileEntries(game.file);
      // Tanto las rutas locales como las de github-release:// (que ahora
      // pasan por nuestro proxy /api/github-asset, ver
      // js/github-release-source.js) son URLs relativas al propio
      // dominio de RetroPlay -- ya no hace falta distinguir el caso
      // "URL absoluta de GitHub" de antes.
      const toAbsoluteUrl = (entry) => entry.file || new URL(entry.url, window.location.href).href;

      const MAIN_FILE_EXTENSIONS = ['cue', 'm3u', 'ccd', 'toc'];
      let mainEntry = entries.find(e => MAIN_FILE_EXTENSIONS.includes(
        e.name.split('.').pop().toLowerCase()
      ));
      if (!mainEntry) mainEntry = entries[0];

      iWin.EJS_gameUrl = toAbsoluteUrl(mainEntry);

      const companionEntries = entries.filter(e => e !== mainEntry);
      if (companionEntries.length > 0) {
        iWin.EJS_externalFiles = {};
        for (const entry of companionEntries) {
          iWin.EJS_externalFiles[entry.name] = toAbsoluteUrl(entry);
        }
      }
      // EJS_pathtodata la usa el reproductor (emulator.min.js) para pedir
      // los datos pesados de cada core (*-wasm.data, *.wasm...), y ahí sí
      // queremos el CDN oficial -- no vendorizamos esos binarios.
      //
      // PERO loader.js (el bootstrap que carga emulator.min.js) reutiliza
      // esa MISMA variable para localizarse a sí mismo si no le decimos
      // otra cosa, así que sin EJS_paths intentaría descargar
      // emulator.min.js/.css desde el CDN de datos de core, donde no
      // existen -> "EmulatorJS failed to load. Check for missing files."
      // EJS_paths mapea por nombre de archivo y loader.js lo consulta
      // ANTES de caer a EJS_pathtodata, así que fijamos aquí los pocos
      // ficheros del propio reproductor que sí están vendorizados local.
      const vendorBase = new URL(EMULATORJS_VENDOR_PATH, window.location.href).href;
      iWin.EJS_paths = {
        'emulator.min.js': vendorBase + 'emulator.min.js',
        'emulator.min.css': vendorBase + 'emulator.min.css',
        'emulator.js': vendorBase + 'emulator.js',
        'emulator.css': vendorBase + 'emulator.css',
        'libunrar.js': vendorBase + 'libunrar.js',
        'libunrar.wasm': vendorBase + 'libunrar.wasm'
      };
      iWin.EJS_pathtodata = CORE_DATA_CDN;
      iWin.EJS_gameName = game.name;
      iWin.EJS_backgroundColor = '#000000';
      iWin.EJS_startOnLoaded = true;
      iWin.EJS_fullscreenOnLoaded = false;
      iWin.EJS_volume = 0.6;
      iWin.EJS_gameID = game.id;
      // Las ROM de Drive no deben persistir en la caché IndexedDB interna de
      // EmulatorJS: los bytes sólo se mantienen durante esta partida.
      if (this._romAssets) iWin.EJS_cacheConfig = { enabled: false };
      // askBeforeExit=false porque el cierre limpio ya lo gestionamos
      // nosotros desde la topbar de RetroPlay (autosave incluido).
      iWin.EJS_askBeforeExit = false;
      // El core WASM que EmulatorJS descarga viene en dos variantes: la
      // moderna y "-legacy". La moderna es la única que exporta
      // EmulatorJSGetState en su Module -- sin eso, gameManager.getState()
      // lanza "this.Module.EmulatorJSGetState is not a function" y
      // save/load state no funcionan nunca, para ningún juego.
      //
      // Qué variante se descarga depende de this.webgl2Enabled dentro de
      // emulator.min.js, que se resuelve así (por orden de prioridad):
      //   1. Un valor previamente guardado en el localStorage DEL NAVEGADOR
      //      para este core+juego concreto (preGetSetting).
      //   2. Si no hay nada en localStorage: EJS_defaultOptions.
      //   3. Si tampoco hay defaultOptions: el JSON de reporte del core
      //      (cores/reports/<core>.json), pedido por fetch al CDN.
      // El paso 3 para snes9x concretamente no declara soporte WebGL2 (el
      // report real trae "options": {}), así que aunque ese fetch tenga
      // éxito el resultado es igualmente "-legacy" -- el fetch en sí (que
      // en algunos navegadores además da 404) nunca fue la causa real.
      // Y el paso 2 (EJS_defaultOptions) puede perder contra el paso 1 si
      // el navegador ya tenía algo guardado de una partida anterior.
      // EJS_disableLocalStorage salta el paso 1 por completo, así que la
      // resolución cae siempre y de forma determinista en defaultOptions,
      // sin depender de qué haya en el navegador de cada persona. Solo
      // afecta a un puñado de ajustes internos del propio reproductor
      // (hilos, menú, rebobinado, rotación de vídeo) que RetroPlay ya fija
      // explícitamente vía EJS_Buttons/EJS_* -- las partidas guardadas
      // viven exclusivamente en Firebase vía retroStorage, no aquí.
      iWin.EJS_disableLocalStorage = true;
      iWin.EJS_defaultOptions = { webgl2Enabled: 'enabled' };

      // ---------------------------------------------------------------
      // ARRANQUE FORZADO SIN MENÚ (todas las consolas, en especial PS1)
      // ---------------------------------------------------------------
      // Cuando el core PSX (pcsx_rearmed) no puede montar EJS_gameUrl
      // como disco válido, no lanza un error visible: cae a su propia
      // pantalla nativa de configuración ("Main Menu / Load Content...",
      // con el pie "PCSX-ReARMed"). Para que RetroPlay JAMÁS muestre esa
      // UI interna del core, la ocultamos a nivel de contenedor y
      // forzamos el intento de arranque inmediato del contenido ya
      // cargado en cuanto el reproductor esté listo.
      // TODOS los mecanismos nativos de guardado/carga de EmulatorJS
      // (saveState, loadState, quickSave, quickLoad, save/loadSavefiles)
      // se ocultan sin excepción. La única forma de guardar o cargar una
      // partida en RetroPlay son los dos botones de la topbar propia
      // ("Guardar partida" / "Cargar partida"), que piden un nombre y
      // pasan por retroStorage -> Firebase. Cualquier otro camino nativo
      // (quickSave escribe al filesystem virtual del core sin pasar por
      // retroStorage) se pierde al cerrar el juego sin aviso, así que se
      // elimina por completo de la interfaz.
      iWin.EJS_Buttons = {
        playPause: false,
        restart: true,
        mute: false,
        settings: false,   // oculta el acceso al menú de configuración del core
        fullscreen: true,
        saveState: false,
        loadState: false,
        screenRecord: false,
        gamepad: true,
        cheat: false,
        volume: true,
        saveSavefiles: false,
        loadSavefiles: false,
        quickSave: false,
        quickLoad: false,
        screenshot: false,
        cacheManager: false,
        exitEmulation: true
      };
      // Evita que, ante cualquier fallo de carga del disco, el core se
      // quede "esperando" en su menú nativo: si no disparó
      // EJS_onGameStart en un tiempo prudencial, se interpreta como
      // fallo de contenido (archivo no es un disco PS1 válido) y se
      // informa por la UI de RetroPlay en vez de dejar visible la
      // pantalla interna del core.
      //
      // El plazo NO puede ser un número fijo pequeño: un disco de PS1
      // (.bin) pesa fácilmente cientos de MB, y en juegos multi-archivo
      // (.cue+.bin) esos MB además pasan por nuestro proxy CORS
      // (api/github-asset.js, ver github-release-source.js) antes de
      // llegar al core. Con un timeout fijo de pocos segundos, esta
      // pantalla de "archivo no válido" saltaba mientras el .bin TODAVÍA
      // se estaba descargando -- un falso fallo, no un problema real del
      // archivo. Por eso el plazo se calcula a partir del peso total
      // conocido de los archivos del juego (entries[].size, viene de la
      // API de GitHub cuando aplica): una descarga muy lenta de 512KB/s
      // más un margen fijo para que el core arranque y monte el disco,
      // con un suelo y un techo razonables para no esperar ni muy poco
      // ni indefinidamente si el archivo de verdad está roto.
      const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
      const MIN_ASSUMED_SPEED_BYTES_PER_SEC = 512 * 1024; // 512KB/s, conexión lenta
      const BOOT_OVERHEAD_MS = 15000; // descarga del core wasm + montaje del FS
      // El techo (240s) se queda por debajo del límite de streaming de
      // la función Edge del proxy (300s, ver api/github-asset.js) --no
      // tiene sentido esperar más que lo que la propia plataforma va a
      // dejar durar la descarga.
      const startTimeoutMs = Math.min(240000, Math.max(
        20000,
        (totalBytes / MIN_ASSUMED_SPEED_BYTES_PER_SEC) * 1000 + BOOT_OVERHEAD_MS
      ));
      this._startTimeout = setTimeout(() => {
        if (this._active && this.currentGame === game) {
          onError?.('El archivo de este juego no es un disco de PS1 válido (.bin/.cue/.iso), así que el núcleo no pudo arrancarlo automáticamente. Sustituye el archivo en /games/ps1/ por una imagen de disco real.');
          this.close();
        }
      }, startTimeoutMs);

      // No se registran EJS_onSaveState / EJS_onLoadState: los botones
      // nativos que los disparan están desactivados en EJS_Buttons. El
      // único guardado/carga posible es el manual, por nombre, vía los
      // botones propios de la topbar (ver saveState()/loadState() más
      // abajo).
      iWin.EJS_onGameStart = () => {
        clearTimeout(this._startTimeout);
        this._startTimeout = null;
        clearInterval(this._bootLogTimer);
        // Ver el bloque de comentarios "BUG DEL VENDOR" más abajo: aquí es
        // donde gameManager ya existe de verdad, así que es el único punto
        // fiable para forzar la sincronización del gamepad virtual táctil
        // (crítico en PS1, donde la descarga pesada del disco hace que las
        // dos vías nativas de EmulatorJS lleguen tarde o nunca).
        this._syncVirtualGamepad(this.getEmulatorInstance());
        onReady?.();
        retroStorage.recordPlayed(game.id, 5);
      };

      // No se usa EJS_loadStateURL: no hay ningún autosave que precargar
      // al arrancar. Cargar una partida es siempre una acción explícita
      // del usuario a través del botón "Cargar partida" (ver loadState()
      // más abajo), nunca algo automático al lanzar el juego.
      iWin.EJS_loadStateURL = null;

      await this._injectLoader(iDoc, iWin);
    } catch (err) {
      if (loadAbortController.signal.aborted || !this._active || this.currentGame !== game) {
        return;
      }
      console.error('[emulator] Error al iniciar', err);
      clearInterval(this._bootLogTimer);
      await this.close();
      onError?.(err.message || 'No se pudo iniciar el emulador. Comprueba tu conexión e inténtalo de nuevo.');
    }
  }

  /**
   * BUG DEL VENDOR: el <div> del gamepad virtual táctil de EmulatorJS
   * nace oculto (display:none implícito, nunca se le pone display=''
   * en el constructor) y solo hay DOS caminos en todo emulator.min.js
   * que lo hacen visible:
   *
   *   1) El toggle "Virtual Gamepad" del menú de ajustes
   *      (menuOptionChanged -> handleSpecialOptions -> toggleVirtualGamepad),
   *      que además se auto-dispara UNA VEZ al construirse el propio
   *      menú (para reflejar el valor guardado/por defecto). Pero ese
   *      auto-disparo ocurre en el constructor del reproductor -- SÍNCRONO,
   *      antes de downloadFiles()/initializeGameManager() -- y
   *      menuOptionChanged está guardado por "this.gameManager &&", así
   *      que con gameManager todavía undefined la llamada se descarta
   *      en silencio. No hay ningún reintento posterior: initializeGameManager()
   *      no vuelve a tocar el menú de ajustes.
   *
   *   2) startGame() (que sí corre después de que gameManager exista)
   *      tiene "this.touch && (this.virtualGamepad.style.display = '')".
   *      Pero this.touch (distinto de this.isMobile/this.hasTouchScreen)
   *      arranca en false y SOLO se pone a true por un evento táctil
   *      real sobre el botón de inicio NATIVO de EmulatorJS. RetroPlay
   *      fija EJS_startOnLoaded=true (ver más abajo), así que ese botón
   *      nunca se muestra ni se toca -- this.touch se queda en false
   *      para siempre, en TODAS las consolas.
   *
   * Con las dos vías inutilizadas, el gamepad depende de pura suerte de
   * timing: en cores pequeños (SNES) el usuario a veces ya tocó la
   * pantalla o el menú ya se reconstruyó por algún otro motivo antes de
   * fijarse, así que a veces no se nota. En PS1, con EJS_externalFiles
   * pesados y descargas de minutos, la ventana es enorme y el div se
   * queda en display:none de forma consistente.
   *
   * EL FIX vive aquí, en código propio de RetroPlay, no en el vendor
   * GPL de terceros (que además está minificado y se perdería en
   * cualquier actualización de /vendor/emulatorjs): en cuanto
   * EJS_onGameStart confirma que gameManager ya existe, se fuerza la
   * sincronización directamente contra la instancia usando su API
   * pública y estable (toggleVirtualGamepad, preGetSetting) -- sin
   * tocar this.touch ni el display interno a mano, y sin parchear
   * emulator.min.js.
   *
   * Se respeta la preferencia real del usuario si la guardó alguna vez
   * (preGetSetting lee de localStorage vía la propia API del
   * reproductor); si nunca la tocó, se usa el mismo criterio por
   * defecto que ya usa el vendor para decidir el valor inicial del
   * menú (isMobile ? "enabled" : "disabled", ver el bloque de ajustes
   * "Virtual Gamepad" en emulator.min.js), para que lo que se ve en
   * pantalla coincida con lo que el propio menú de ajustes muestra
   * seleccionado.
   */
  _syncVirtualGamepad(instance) {
    try {
      if (!instance || typeof instance.toggleVirtualGamepad !== 'function') return;

      const saved = typeof instance.preGetSetting === 'function'
        ? instance.preGetSetting('virtual-gamepad')
        : null;
      const shouldShow = saved
        ? saved !== 'disabled'
        : !!instance.isMobile;

      instance.toggleVirtualGamepad(shouldShow);

      // El propio menú de ajustes queda con el checkbox tal como estaba
      // en el momento en que se construyó (posiblemente desincronizado
      // del valor real que acabamos de aplicar arriba, por el mismo
      // guard de gameManager). allSettings sí se actualiza siempre
      // (menuOptionChanged lo hace ANTES del guard), así que forzamos
      // también gameManager.setVariable para que el core reciba el
      // valor, igual que habría pasado si el guard no hubiese bloqueado
      // la llamada original.
      if (instance.gameManager && typeof instance.gameManager.setVariable === 'function') {
        instance.gameManager.setVariable('virtual-gamepad', shouldShow ? 'enabled' : 'disabled');
      }
      if (instance.allSettings) {
        instance.allSettings['virtual-gamepad'] = shouldShow ? 'enabled' : 'disabled';
      }
    } catch (err) {
      // Nunca debe romper el arranque del juego por esto -- en el peor
      // caso el gamepad se queda como estaba (comportamiento previo),
      // no algo peor.
      console.warn('[emulator] No se pudo sincronizar el gamepad virtual táctil', err);
    }
  }

  _runBootSequence(onBootMessage) {
    let i = 0;
    onBootMessage?.(BOOT_MESSAGES[0]);
    this._bootLogTimer = setInterval(() => {
      i = (i + 1) % BOOT_MESSAGES.length;
      onBootMessage?.(BOOT_MESSAGES[i]);
    }, 1100);
  }

  /**
   * Inserta vendor/emulatorjs/loader.js DENTRO del documento del iframe
   * dado, el bootstrap OFICIAL sin modificar. Como cada partida usa un
   * iframe recién creado, este script solo se ejecuta una vez por
   * scope global -- nunca puede chocar con una ejecución anterior.
   */
  _injectLoader(iDoc, iWin) {
    return new Promise((resolve, reject) => {
      const script = iDoc.createElement('script');
      // Ruta absoluta al documento padre: el iframe no comparte la
      // misma base URL relativa, así que resolvemos contra
      // window.location (la página principal) explícitamente.
      script.src = new URL(`${EMULATORJS_VENDOR_PATH}loader.js`, window.location.href).href;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('No se pudo cargar vendor/emulatorjs/loader.js'));
      iDoc.body.appendChild(script);
    });
  }

  // ---------------------------------------------------------------------
  // Guardado / carga manual de partidas -- botones de la topbar
  // ---------------------------------------------------------------------
  //
  // [SAVE-VERIFY] BUG DEL VENDOR: Module.EmulatorJSGetState ausente
  // ---------------------------------------------------------------
  // gameManager.getState() (dentro de emulator.min.js) es literalmente
  // `return this.Module.EmulatorJSGetState()` -- sin ningún fallback.
  // EmulatorJSGetState es un símbolo que exporta el propio CORE WASM
  // compilado (genesis_plus_gx-wasm.data, servido desde el CDN de
  // EmulatorJS), no algo que emulator.min.js pueda sintetizar por su
  // cuenta. Cuando el build del core servido en un momento dado no
  // exporta ese símbolo (confirmado aquí para genesis_plus_gx; es un
  // problema conocido y reportado contra EmulatorJS -- ver issue #1013
  // del propio repo, "[Bug] Save/Load state doesn't work", con el mismo
  // síntoma de raíz para otro core), la llamada revienta con
  // "this.Module.EmulatorJSGetState is not a function" para CUALQUIER
  // juego de esa consola, siempre -- no es un fallo intermitente ni de
  // timing (por eso reintentar getState() sin más no sirve de nada).
  //
  // Como RetroPlay vendoriza emulator.min.js localmente pero sirve los
  // binarios de cada core en vivo desde CORE_DATA_CDN, no controlamos
  // qué build de genesis_plus_gx llega en cada visita -- así que en vez
  // de asumir que getState() funciona, saveState() ahora se degrada con
  // gracia a un segundo mecanismo que SÍ es independiente de
  // EmulatorJSGetState: gameManager.getSaveFile(), que vuelca la
  // partida guardada tipo pila/batería (SRAM) escribiéndola a través de
  // la función cwrapped cmd_savefiles y leyéndola de vuelta con
  // FS.readFile -- el mismo patrón robusto (cwrap + FS) que loadState()
  // ya usa con éxito para restaurar. No es un snapshot exacto de la
  // partida en curso (no incluye el estado de la CPU/vídeo a mitad de
  // frame), pero para cualquier juego con guardado interno (la inmensa
  // mayoría de Mega Drive/SNES/N64 con batería) SÍ persiste el progreso
  // real del jugador, en vez de dejar el guardado completamente roto.
  /**
   * Guarda la partida actual en Firebase con el nombre elegido por el
   * usuario (p.ej. "partida naves 1"), como una entrada más de su
   * "memory card" personal ligada a su cuenta. Es el ÚNICO mecanismo de
   * guardado de RetroPlay -- lo dispara el botón "Guardar partida" de la
   * topbar, que pide el nombre antes de llamar aquí.
   */
  async saveState(name) {
    if (!this.currentGame) throw new Error('No hay ningún juego activo.');
    if (!name || !name.trim()) throw new Error('La partida necesita un nombre.');
    const instance = await this._waitForGameManager();
    if (!instance) {
      throw new Error('El emulador todavía no está listo para guardar.');
    }
    const gameManager = instance.gameManager;

    // Camino principal: snapshot completo de memoria (posición exacta
    // dentro de la partida). Es el único que soporta continuar
    // literalmente donde lo dejaste, así que se intenta siempre primero.
    if (typeof gameManager.getState === 'function') {
      try {
        const stateBytes = gameManager.getState();
        const base64 = this._bytesToBase64(stateBytes);
        const record = await retroStorage.saveEmulatorState(this.currentGame, name, base64, 'state');
        await retroStorage.recordPlayed(this.currentGame.id, 100);
        return record;
      } catch (err) {
        // No relanzamos todavía: para eso está el fallback de abajo.
        // Pero SÍ se registra con detalle -- este catch es precisamente
        // el que faltaba antes y dejaba el fallo invisible salvo con
        // devtools abiertas.
        saveVerifyError('getState() falló al guardar', this.currentGame.id, name, err);
      }
    } else {
      saveVerifyLog('gameManager.getState no existe en este core; se usa el fallback de SRAM directamente para', this.currentGame.id, name);
    }

    // Fallback: partida guardada tipo pila/batería, vía cmd_savefiles +
    // FS.readFile. No depende de Module.EmulatorJSGetState.
    if (typeof gameManager.getSaveFile === 'function') {
      try {
        const saveBytes = gameManager.getSaveFile();
        if (saveBytes && saveBytes.length) {
          const base64 = this._bytesToBase64(saveBytes);
          const record = await retroStorage.saveEmulatorState(this.currentGame, name, base64, 'sram');
          await retroStorage.recordPlayed(this.currentGame.id, 100);
          saveVerifyLog('Guardado como partida SRAM (fallback, sin snapshot completo) para', this.currentGame.id, name);
          this._notifyUser?.('Guardado el progreso de la partida guardada del juego (no la posición exacta en pantalla): este core no admite snapshots completos ahora mismo.');
          return record;
        }
        saveVerifyError('getSaveFile() no devolvió datos (el juego no tiene partida guardada interna) para', this.currentGame.id, name);
      } catch (err) {
        saveVerifyError('getSaveFile() también falló al guardar', this.currentGame.id, name, err);
      }
    }

    throw new Error('El emulador no pudo guardar la partida: ni el snapshot completo ni la partida guardada interna están disponibles para este core ahora mismo.');
  }

  /**
   * Carga una partida previamente guardada en Firebase a partir de su
   * identificador (id del documento en Firestore, ver storage.js). Es el
   * ÚNICO mecanismo de carga de RetroPlay -- lo dispara el botón "Cargar
   * partida" de la topbar, tras elegir el usuario un nombre de su lista.
   */
  async loadState(saveId) {
    if (!this.currentGame) throw new Error('No hay ningún juego activo.');
    if (!saveId) throw new Error('No se indicó qué partida cargar.');
    const record = await retroStorage.loadEmulatorState(saveId);
    if (!record) throw new Error('No se encontró esa partida guardada.');
    const instance = await this._waitForGameManager();
    if (!instance) {
      throw new Error('El emulador todavía no está listo para cargar.');
    }
    const gameManager = instance.gameManager;
    const bytes = this._base64ToBytes(record.data);

    // "kind" distingue snapshots completos (guardados con getState) de
    // volcados de SRAM (guardados con el fallback getSaveFile).
    if (record.kind === 'sram') {
      if (typeof gameManager.loadSaveFiles !== 'function') {
        throw new Error('Este core no puede restaurar la partida guardada (SRAM).');
      }
      gameManager.FS.writeFile(gameManager.getSaveFilePath(), bytes);
      gameManager.loadSaveFiles();
    } else if (typeof gameManager.loadState === 'function') {
      gameManager.loadState(bytes);
    } else {
      throw new Error('Este core no puede restaurar partidas guardadas ahora mismo.');
    }
    return record;
  }

  // [SAVE-VERIFY] gameManager puede tardar en aparecer tras el arranque,
  // especialmente en cores pesados como PS1 o N64. Reintenta brevemente
  // antes de rendirse, en vez de fallar a la primera comprobación.
  async _waitForGameManager(maxAttempts = 10, delayMs = 200) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const instance = this.getEmulatorInstance();
      if (instance?.gameManager) return instance;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return this.getEmulatorInstance()?.gameManager ? this.getEmulatorInstance() : null;
  }

  /**
   * Abre el panel NATIVO de configuración de mando de EmulatorJS
   * (detección, reasignación de botones, perfiles por jugador). Se
   * reutiliza el propio del reproductor en vez de reimplementarlo,
   * porque ya cubre Xbox / PlayStation / genéricos / Bluetooth vía el
   * Standard Gamepad del navegador y persiste su configuración solo.
   */
  openNativeGamepadConfig() {
    const instance = this.getEmulatorInstance();
    if (instance?.controlMenu) {
      instance.controlMenu.style.display = '';
    }
  }

  /**
   * Botón manual de respaldo ("Controles táctiles") en la topbar del
   * emulador. _syncVirtualGamepad ya se dispara solo en EJS_onGameStart,
   * pero se deja este interruptor accesible al usuario por si en una
   * conexión muy lenta el propio evento onGameStart tarda en llegar o el
   * usuario simplemente quiere forzar el estado sin reabrir el juego.
   * Alterna sobre el estado REAL actual del div (instance.virtualGamepad),
   * no sobre la preferencia guardada, para que el botón siempre refleje lo
   * que se ve en pantalla ahora mismo.
   */
  toggleVirtualGamepad() {
    const instance = this.getEmulatorInstance();
    if (!instance || typeof instance.toggleVirtualGamepad !== 'function') {
      return null;
    }
    const currentlyVisible = instance.virtualGamepad
      ? instance.virtualGamepad.style.display !== 'none'
      : false;
    const nextVisible = !currentlyVisible;
    instance.toggleVirtualGamepad(nextVisible);
    if (instance.gameManager && typeof instance.gameManager.setVariable === 'function') {
      instance.gameManager.setVariable('virtual-gamepad', nextVisible ? 'enabled' : 'disabled');
    }
    if (instance.allSettings) {
      instance.allSettings['virtual-gamepad'] = nextVisible ? 'enabled' : 'disabled';
    }
    return nextVisible;
  }

  _bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += chunk) {
      binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  _base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ---------------------------------------------------------------------
  // Cierre / limpieza
  // ---------------------------------------------------------------------
  //
  // No existe ningún autoguardado -- ni periódico ni al cerrar el juego.
  // El progreso solo se persiste cuando el usuario pulsa explícitamente
  // "Guardar partida" y le pone un nombre (ver saveState()). close() se
  // limita a liberar recursos.
  async close() {
    clearInterval(this._bootLogTimer);
    clearTimeout(this._startTimeout);
    this._startTimeout = null;
    this._releaseRomResources();

    // Destruir el iframe completo es la limpieza real: se lleva consigo
    // el módulo WASM cargado, todos los listeners internos de
    // EmulatorJS, y dev sobre todo el scope global donde loader.js
    // declaró sus variables -- así la próxima partida parte de un
    // iframe nuevo, sin ningún resto de la anterior.
    if (this._iframe) {
      this._iframe.remove();
      this._iframe = null;
    }

    this._active = false;
    this.currentGame = null;
    this.currentConsole = null;
  }
}

// Instancia global -- un único controlador de emulación activo a la vez.
// No hay ningún listener de autoguardado (ni pagehide, ni periódico):
// cerrar la pestaña, recargar o salir del juego sin haber pulsado
// "Guardar partida" NO persiste nada, por diseño -- el guardado es
// siempre una acción explícita del usuario, con nombre elegido por él.
const emulatorController = new EmulatorController();
