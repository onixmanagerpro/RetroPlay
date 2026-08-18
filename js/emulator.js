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
        quickSave: true,
        quickLoad: true,
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
      iWin.EJS_onGameStart = () => {
        clearTimeout(this._startTimeout);
        this._startTimeout = null;
        clearInterval(this._bootLogTimer);
        onReady?.();
        retroStorage.recordPlayed(game.id, 5);
      };

      if (savedState && savedState.data) {
        iWin.EJS_loadStateURL = this._base64ToBytes(savedState.data);
      } else {
        iWin.EJS_loadStateURL = null;
      }

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
