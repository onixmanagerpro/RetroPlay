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
    this._pendingAutoState = null;
  }

  isSupported(consoleId) {
    return !!CONSOLE_CORE_MAP[consoleId];
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
      await this.close({ autoSave: true });
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
      // Intentamos recuperar un save-state automático previo (autosave
      // al salir del juego la última vez) para ofrecer continuidad.
      const savedState = await retroStorage.loadEmulatorState(game.id, 'auto');
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
      // explícitamente vía EJS_Buttons/EJS_* -- no toca las partidas
      // guardadas, que viven aparte en IndexedDB vía retroStorage.
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
      // "Quick Save"/"Quick Load" nativos de EmulatorJS llaman a
      // gameManager.quickSave()/quickLoad() DIRECTAMENTE (escriben al
      // filesystem virtual del core), sin pasar nunca por
      // callEvent("saveState"/"loadState") -- es decir, sin pasar por
      // EJS_onSaveState/EJS_onLoadState ni, por tanto, por retroStorage
      // (IndexedDB). Una partida guardada así vive solo en la memoria
      // WASM de ese iframe: se pierde en cuanto se cierra el juego, sin
      // ningún aviso. Dejarlos visibles junto a los botones "Guardar/
      // Cargar partida" de la topbar de RetroPlay (que sí persisten)
      // es la receta perfecta para el síntoma "a veces parece que
      // guarda, pero al volver no está" -- por eso se ocultan aquí.
      // saveState/loadState nativos SÍ persisten correctamente (pasan
      // por callEvent -> EJS_onSaveState/EJS_onLoadState -> retroStorage,
      // ver más abajo), así que se dejan disponibles como alternativa a
      // los de la topbar.
      iWin.EJS_Buttons = {
        playPause: false,
        restart: true,
        mute: false,
        settings: false,   // oculta el acceso al menú de configuración del core
        fullscreen: true,
        saveState: true,
        loadState: true,
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
          this.close({ autoSave: false });
        }
      }, startTimeoutMs);

      // Guardado automático de partidas: cuando EmulatorJS detecta un
      // cambio en la memoria persistente del juego, lo reflejamos en
      // IndexedDB vía storage.js -- así "Continuar jugando" siempre
      // tiene el último progreso real.
      iWin.EJS_onSaveState = (e) => this._handleSaveStateEvent(e);
      // Sin este handler, EmulatorJS considera que nadie está escuchando el
      // evento "loadState" (callEvent("loadState") devuelve 0) y cae a su
      // flujo nativo: abre el selector de archivos del sistema operativo
      // dentro del iframe y no reporta nada si el usuario no completa esa
      // selección -- de ahí que "cargar" pareciera no hacer nada. Con este
      // handler, el botón nativo de cargar usa el mismo autosave que ya
      // gestiona retroStorage, igual que ya hace el guardado.
      iWin.EJS_onLoadState = () => { this.loadState('manual').catch(() => {}); };
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
        // Restauramos aquí (y no vía EJS_loadStateURL, ver el bloque de
        // comentarios "BUG DEL VENDOR: EJS_loadStateURL" más abajo) el
        // autosave de la partida anterior, si lo hay. gameManager ya
        // existe de verdad en este punto, así que podemos llamar a
        // loadState() directamente con los bytes -- el mismo camino que
        // ya usan los botones "Guardar/Cargar partida" de la topbar,
        // que sí funciona.
        this._restorePendingAutoState();
        onReady?.();
        retroStorage.recordPlayed(game.id, 5);
      };

      // ---------------------------------------------------------------
      // BUG DEL VENDOR: EJS_loadStateURL
      // ---------------------------------------------------------------
      // EmulatorJS documenta EJS_loadStateURL como el mecanismo oficial
      // para precargar un save-state al arrancar, y por su nombre (y por
      // aceptar Uint8Array/ArrayBuffer/Blob además de string) parece
      // pensado exactamente para nuestro caso: reinyectar el autosave
      // guardado en IndexedDB.
      //
      // downloadStartState() (dentro de vendor/emulatorjs/emulator.min.js)
      // encamina ese valor a través de this.downloadFile(...), y en
      // cuanto esa promesa resuelve, registra -- vía this.on("start", cb)
      // -- un listener adicional sobre el mismo evento "start" que ya
      // dispara EJS_onGameStart. Ese listener hace, con 10ms de retraso:
      //
      //   this.gameManager.loadState(new Uint8Array(e.data.files[0].bytes))
      //
      // Esa forma `{ files: [{ bytes }] }` es la que produce
      // this.downloader.downloadFile(...) para una URL real descargada y
      // cacheada -- NUNCA la que produce pasar un Uint8Array ya en
      // memoria (ahí downloadFile devuelve `{ data: <el propio
      // Uint8Array> }`, sin `.files`), así que ese acceso revienta con
      // "Cannot read properties of undefined (reading '0')".
      //
      // Verificado ejecutando el código real (no una reescritura) extraído
      // de emulator.min.js: el juego SÍ arranca con normalidad y
      // EJS_onGameStart SÍ se dispara -- el problema no es que el
      // arranque se cuelgue, sino que, ~10ms después de arrancar, ese
      // segundo listener revienta con una excepción no controlada
      // (invisible salvo abriendo devtools) *antes* de llegar a la
      // llamada a loadState(). Efecto observable: el autosave previo se
      // ignora en silencio y la partida arranca siempre desde cero, sin
      // ningún error visible para quien está jugando -- de ahí que
      // "cargar partida" pareciera no hacer nada, para CUALQUIER juego
      // que ya tuviera un progreso guardado.
      //
      // La solución: nunca usar EJS_loadStateURL con datos en memoria.
      // Guardamos el save pendiente en this._pendingAutoState y lo
      // restauramos manualmente en EJS_onGameStart (ver
      // _restorePendingAutoState más abajo), llamando a
      // gameManager.loadState() directamente -- el mismo método que
      // usan con éxito los botones de topbar "Guardar/Cargar partida".
      iWin.EJS_loadStateURL = null;
      this._pendingAutoState = (savedState && savedState.data) ? savedState.data : null;

      await this._injectLoader(iDoc, iWin);
    } catch (err) {
      if (loadAbortController.signal.aborted || !this._active || this.currentGame !== game) {
        return;
      }
      console.error('[emulator] Error al iniciar', err);
      clearInterval(this._bootLogTimer);
      await this.close({ autoSave: false });
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

  /**
   * Restaura, si existe, el autosave pendiente guardado en
   * this._pendingAutoState (fijado en launch() a partir de lo que
   * había en IndexedDB para este juego). Se llama desde
   * EJS_onGameStart, que es el único punto donde gameManager.loadState
   * ya es una función real -- llamarlo antes lanzaría "gameManager is
   * undefined" o similar, igual que le pasaría a cualquier otro uso de
   * gameManager hecho demasiado pronto.
   *
   * Usa el mismo camino que ya emplean con éxito los botones
   * "Guardar/Cargar partida" de la topbar (instance.gameManager.
   * loadState(bytes) directamente), evitando así el mecanismo roto de
   * EJS_loadStateURL (ver el bloque de comentarios "BUG DEL VENDOR"
   * en launch()).
   */
  _restorePendingAutoState() {
    const base64 = this._pendingAutoState;
    this._pendingAutoState = null;
    if (!base64) return;

    try {
      const instance = this.getEmulatorInstance();
      if (!instance?.gameManager?.loadState) {
        console.warn('[emulator] El core no expone gameManager.loadState todavía; no se pudo restaurar el autosave.');
        return;
      }
      const bytes = this._base64ToBytes(base64);
      instance.gameManager.loadState(bytes);
    } catch (err) {
      // Un autosave corrupto o de un core/versión incompatible no debe
      // impedir que la partida arranque -- el usuario simplemente
      // empieza de cero, igual que si nunca hubiera habido autosave.
      console.warn('[emulator] No se pudo restaurar el autosave previo; se continúa sin él', err);
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

  async _handleSaveStateEvent(e) {
    if (!this.currentGame || !e) return;
    try {
      const bytes = e.state || e;
      const base64 = this._bytesToBase64(new Uint8Array(bytes));
      await retroStorage.saveEmulatorState(this.currentGame.id, 'auto', base64);
      await retroStorage.recordPlayed(this.currentGame.id, 60);
    } catch (err) {
      console.warn('[emulator] No se pudo persistir el save state automático', err);
    }
  }

  // ---------------------------------------------------------------------
  // Guardado / carga manual de partidas -- botones de la topbar
  // ---------------------------------------------------------------------
  async saveState(slot = 'auto') {
    const instance = this.getEmulatorInstance();
    if (!instance?.gameManager?.getState) {
      throw new Error('El emulador todavía no está listo para guardar.');
    }
    const stateBytes = instance.gameManager.getState();
    const base64 = this._bytesToBase64(stateBytes);
    await retroStorage.saveEmulatorState(this.currentGame.id, slot, base64);
    await retroStorage.recordPlayed(this.currentGame.id, 100);
    return true;
  }

  async loadState(slot = 'auto') {
    if (!this.currentGame) throw new Error('No hay ningún juego activo.');
    const record = await retroStorage.loadEmulatorState(this.currentGame.id, slot);
    if (!record) throw new Error('No hay ninguna partida guardada para este juego.');
    const instance = this.getEmulatorInstance();
    if (instance?.gameManager?.loadState) {
      const bytes = this._base64ToBytes(record.data);
      instance.gameManager.loadState(bytes);
    }
    return record;
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
  async close({ autoSave = true } = {}) {
    const instance = this.getEmulatorInstance();
    if (autoSave && this.currentGame && instance?.gameManager?.getState) {
      try { await this.saveState('auto'); } catch (_) { /* el core puede no soportar save-state */ }
    }
    clearInterval(this._bootLogTimer);
    clearTimeout(this._startTimeout);
    this._startTimeout = null;
    this._pendingAutoState = null;
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
const emulatorController = new EmulatorController();
