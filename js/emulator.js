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

// Estos mensajes rotativos cubren la fase de ARRANQUE (después de que el
// archivo del juego ya se descargó por completo -- ver la descarga con
// progreso real en launch()): cargar el reproductor, el núcleo WASM, y
// montar el disco ya descargado en el filesystem virtual del emulador.
const BOOT_MESSAGES = [
  'Cargando reproductor EmulatorJS…',
  'Descargando núcleo WebAssembly…',
  'Preparando memoria del emulador…',
  'Montando archivo de juego…',
  'Sincronizando entrada de mando…'
];

/**
 * REESCRITURA DE .cue CON LOS NOMBRES REALES DE LOS ASSETS
 * -----------------------------------------------------------------------
 * Por qué existe esta función:
 *
 * Un .cue es un archivo de TEXTO que referencia su(s) .bin por nombre
 * EXACTO, carácter a carácter, en líneas del tipo:
 *
 *   FILE "Metal Slug X (USA).bin" BINARY
 *
 * El nombre que aparece ahí lo decidió quien creó originalmente el rip
 * (Redump, No-Intro...), normalmente CON espacios y paréntesis: "Nombre
 * (USA).bin". Pero un asset de GitHub Release en este proyecto puede
 * llevar ese mismo nombre "normalizado" a puntos, p.ej.
 * "Metal.Slug.X.USA.bin" -- y si esa normalización no se hizo también
 * DENTRO del .cue al subirlo, el nombre que pide el .cue y el nombre
 * real que se monta en EJS_externalFiles dejan de coincidir.
 *
 * Cuando eso pasa, pcsx_rearmed (el core PSX) no encuentra el .bin en su
 * filesystem virtual y NO lanza ningún error visible: cae en silencio a
 * su menú nativo de configuración ("Main Menu / Load Content..."), que
 * es justo lo que emulator.js ya se esfuerza en ocultar más abajo
 * (EJS_Buttons.settings=false, CSS anti-rgui) pero sin arreglar la causa.
 *
 * En vez de exigir que el nombre del asset subido a GitHub coincida
 * SIEMPRE al carácter con lo que el .cue pide por dentro (frágil: un
 * solo re-subido con nombre "limpio" rompe el juego para siempre), esta
 * función hace lo contrario: reescribe el TEXTO del .cue para que sus
 * líneas FILE "..." apunten al nombre real de cada asset compañero ya
 * resuelto (entries[i].name), emparejando por orden de aparición. Así
 * el .cue que llega al core siempre referencia exactamente lo que
 * montamos en EJS_externalFiles, sin importar cómo se llame el asset en
 * GitHub.
 *
 * `cueText` es el contenido del .cue tal cual se descargó.
 * `companionNames` es la lista de nombres reales (entries[i].name) de
 * los archivos NO-.cue de este juego, en el mismo orden en que
 * aparecen en game.file (típicamente solo un .bin, pero se soporta más
 * de una pista/FILE por si algún juego multi-track lo necesita).
 * Devuelve el texto del .cue ya corregido.
 */
function rewriteCueFileReferences(cueText, companionNames) {
  if (!companionNames.length) return cueText;
  let nextCompanion = 0;
  // Un .cue puede tener varias líneas FILE (multi-track / multi-disco
  // en un solo .cue). Sustituimos el nombre entre comillas de cada
  // línea FILE, en el orden en que aparecen, por el siguiente nombre
  // real disponible -- si hay más líneas FILE que archivos compañeros
  // conocidos, las sobrantes se dejan tal cual (mejor no tocar lo que
  // no sabemos resolver que romper una referencia válida).
  return cueText.replace(/^(\s*FILE\s+")([^"]+)("\s.*)$/gim, (fullLine, prefix, _originalName, suffix) => {
    if (nextCompanion >= companionNames.length) return fullLine;
    const realName = companionNames[nextCompanion];
    nextCompanion++;
    return `${prefix}${realName}${suffix}`;
  });
}

class EmulatorController {
  constructor() {
    this.currentGame = null;
    this.currentConsole = null;
    this._bootLogTimer = null;
    this._active = false;
    this._iframe = null; // iframe activo de la partida en curso
    this._blobUrls = []; // blob: URLs de los archivos del juego actual
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

  /**
   * Lanza el emulador para un juego dado dentro del contenedor indicado.
   * `hostEl` es el nodo DOM (#emulator-canvas-host) donde se crea el
   * iframe aislado que aloja al reproductor real.
   */
  async launch(game, hostEl, { onBootMessage, onDownloadProgress, onReady, onError } = {}) {
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
    // Blob URLs creadas por esta partida (ver más abajo): se liberan al
    // cerrar el juego para no acumular cientos de MB en memoria si la
    // persona encadena varias partidas sin recargar la página.
    this._blobUrls = [];
    const coreInfo = CONSOLE_CORE_MAP[game.console];
    hostEl.innerHTML = '';

    try {
      // Intentamos recuperar un save-state automático previo (autosave
      // al salir del juego la última vez) para ofrecer continuidad.
      const savedState = await retroStorage.loadEmulatorState(game.id, 'auto');

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
      const entries = await window.resolveGameFileEntries(game.file);
      // Tanto las rutas locales como las de github-release:// (que ahora
      // pasan por nuestro proxy /api/github-asset, ver
      // js/github-release-source.js) son URLs relativas al propio
      // dominio de RetroPlay -- ya no hace falta distinguir el caso
      // "URL absoluta de GitHub" de antes.
      const toAbsoluteUrl = (entry) => new URL(entry.url, window.location.href).href;

      // ---------------------------------------------------------------
      // DESCARGA PREVIA CON PROGRESO REAL (crítico para PS1)
      // ---------------------------------------------------------------
      // Un disco de PS1 (.bin) pesa fácilmente cientos de MB. Si le
      // pasamos la URL directamente a EJS_gameUrl/EJS_externalFiles,
      // EmulatorJS la descarga por dentro y RetroPlay no tiene forma de
      // saber cuántos bytes van ni cuántos faltan -- de ahí que antes
      // solo hubiera un spinner con mensajes de texto genéricos.
      //
      // En su lugar, descargamos aquí mismo cada archivo con
      // fetchWithProgress() (ver github-release-source.js), sumamos el
      // progreso de todos los archivos del juego (un .cue+.bin cuentan
      // como una sola descarga combinada) y se lo reportamos a la UI
      // como bytes reales / bytes totales. El resultado se convierte en
      // un blob: URL local, que es instantáneo de montar para
      // EmulatorJS -- ya no vuelve a tocar la red para estos archivos.
      const knownTotalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
      // Si ni la API de GitHub ni el servidor local informaron tamaño
      // para NINGÚN archivo, no hay total fiable: la UI debe mostrar un
      // indicador indeterminado en vez de un porcentaje inventado.
      const hasReliableTotal = entries.some(e => e.size) && knownTotalBytes > 0;
      const loadedPerEntry = new Array(entries.length).fill(0);

      const reportDownloadProgress = () => {
        const loadedBytes = loadedPerEntry.reduce((sum, n) => sum + n, 0);
        onDownloadProgress?.({
          loadedBytes,
          totalBytes: hasReliableTotal ? knownTotalBytes : null,
          fileIndex: entries.length > 1 ? loadedPerEntry.filter(n => n > 0).length : 1,
          fileCount: entries.length,
        });
      };
      reportDownloadProgress();

      const blobs = await Promise.all(entries.map((entry, i) =>
        window.fetchWithProgress(toAbsoluteUrl(entry), (loaded) => {
          loadedPerEntry[i] = loaded;
          reportDownloadProgress();
        })
      ));

      const MAIN_FILE_EXTENSIONS = ['cue', 'm3u', 'ccd', 'toc'];
      let mainIndex = entries.findIndex(e => MAIN_FILE_EXTENSIONS.includes(
        e.name.split('.').pop().toLowerCase()
      ));
      if (mainIndex === -1) mainIndex = 0;

      const companionIndexes = entries.map((_, i) => i).filter(i => i !== mainIndex);
      const mainExtension = entries[mainIndex].name.split('.').pop().toLowerCase();

      // Si el archivo principal es un .cue, su contenido es TEXTO que
      // referencia sus archivos compañeros (.bin) por nombre exacto --
      // ver rewriteCueFileReferences() más arriba para el porqué. Lo
      // reescribimos aquí, ANTES de convertirlo en blob: URL, para que
      // siempre apunte a los nombres reales que vamos a montar en
      // EJS_externalFiles, sin importar cómo se llame el asset de
      // origen en GitHub. Los formatos .m3u/.ccd/.toc no se tocan: son
      // playlists/índices de otro formato que este proyecto no genera
      // dinámicamente, así que solo se corrige el caso .cue real.
      let mainBlob = blobs[mainIndex];
      if (mainExtension === 'cue' && companionIndexes.length > 0) {
        const originalCueText = await mainBlob.text();
        const companionNames = companionIndexes.map(i => entries[i].name);
        const fixedCueText = rewriteCueFileReferences(originalCueText, companionNames);
        if (fixedCueText !== originalCueText) {
          console.info('[emulator] .cue reescrito para que coincida con los nombres reales de los assets montados.');
        }
        mainBlob = new Blob([fixedCueText], { type: 'text/plain' });
      }

      const blobUrls = entries.map((_, i) => {
        const blob = i === mainIndex ? mainBlob : blobs[i];
        const url = URL.createObjectURL(blob);
        this._blobUrls.push(url);
        return url;
      });

      iWin.EJS_gameUrl = blobUrls[mainIndex];

      if (companionIndexes.length > 0) {
        iWin.EJS_externalFiles = {};
        for (const i of companionIndexes) {
          iWin.EJS_externalFiles[entries[i].name] = blobUrls[i];
        }
      }

      // La descarga real ya terminó en este punto -- lo que sigue
      // (arranque del núcleo WASM, montaje del disco) es la fase de
      // "boot", así que a partir de aquí arrancamos los BOOT_MESSAGES
      // rotativos en vez de la barra de progreso de descarga.
      onDownloadProgress?.({
        loadedBytes: knownTotalBytes || loadedPerEntry.reduce((s, n) => s + n, 0),
        totalBytes: hasReliableTotal ? knownTotalBytes : null,
        fileIndex: entries.length,
        fileCount: entries.length,
        done: true,
      });
      this._runBootSequence(onBootMessage);
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
      // A diferencia de antes, en este punto el .bin/.cue YA está
      // descargado por completo (ver la descarga previa con progreso
      // más arriba): EJS_gameUrl/EJS_externalFiles apuntan a blob: URLs
      // locales, instantáneas de montar. Por eso el plazo aquí solo
      // necesita cubrir el arranque del núcleo WASM y el montaje del
      // disco en el filesystem virtual, no la transferencia de red --
      // con un suelo generoso para conexiones lentas al cargar el propio
      // core (que sí sale del CDN) y un techo para no esperar
      // indefinidamente si el archivo de verdad está roto.
      const startTimeoutMs = 45000;
      const startTimeout = setTimeout(() => {
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
        clearTimeout(startTimeout);
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
      console.error('[emulator] Error al iniciar', err);
      clearInterval(this._bootLogTimer);
      onError?.('No se pudo iniciar el emulador. Comprueba tu conexión: los núcleos WebAssembly se cargan bajo demanda la primera vez.');
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

    // Destruir el iframe completo es la limpieza real: se lleva consigo
    // el módulo WASM cargado, todos los listeners internos de
    // EmulatorJS, y dev sobre todo el scope global donde loader.js
    // declaró sus variables -- así la próxima partida parte de un
    // iframe nuevo, sin ningún resto de la anterior.
    if (this._iframe) {
      this._iframe.remove();
      this._iframe = null;
    }

    // Liberar las blob: URLs creadas para esta partida (ver launch()):
    // cada una retiene en memoria los bytes completos del .bin/.cue
    // descargado, así que sin esto la memoria crecería con cada partida
    // sucesiva hasta que se recargue la página entera.
    if (this._blobUrls) {
      for (const url of this._blobUrls) {
        URL.revokeObjectURL(url);
      }
      this._blobUrls = [];
    }

    this._active = false;
    this.currentGame = null;
    this.currentConsole = null;
  }
}

// Instancia global -- un único controlador de emulación activo a la vez.
const emulatorController = new EmulatorController();
