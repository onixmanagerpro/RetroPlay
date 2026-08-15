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
 *   EmulatorJS recomienda para producción). Ver emulators/<consola>/README.md
 *   en cada carpeta para instrucciones de self-hosting cuando se quiera
 *   evitar la dependencia del CDN.
 *
 * Cada consola soportada mapea a un core real de libretro:
 *   SNES        -> snes9x
 *   Mega Drive  -> genesis_plus_gx
 *   N64         -> mupen64plus_next
 *   Dreamcast   -> flycast
 *   PS1         -> mednafen_psx
 * -----------------------------------------------------------------------
 */

const EMULATORJS_VENDOR_PATH = 'vendor/emulatorjs/';

// Por defecto servimos los assets de los cores desde el CDN oficial de
// EmulatorJS (así es como el propio proyecto se despliega en producción,
// ver https://emulatorjs.org/docs/api). Si se hace self-host de los
// cores (ver README de cada carpeta en /emulators), basta con cambiar
// esta constante a la carpeta local correspondiente.
const CORE_DATA_CDN = 'https://cdn.emulatorjs.org/stable/data/';

const CONSOLE_CORE_MAP = {
  'SNES': { core: 'snes9x', folder: 'emulators/snes' },
  'Mega Drive': { core: 'segaMD', folder: 'emulators/megadrive' },
  'Nintendo 64': { core: 'n64', folder: 'emulators/n64' },
  'Dreamcast': { core: 'flycast', folder: 'emulators/dreamcast' },
  'PS1': { core: 'psx', folder: 'emulators/ps1' }
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
  }

  isSupported(consoleId) {
    return !!CONSOLE_CORE_MAP[consoleId];
  }

  /**
   * Lanza el emulador para un juego dado dentro del contenedor indicado.
   * `hostEl` es el nodo DOM (#emulator-canvas-host) donde EmulatorJS
   * inyecta su propio reproductor.
   */
  async launch(game, hostEl, { onBootMessage, onReady, onError } = {}) {
    if (!this.isSupported(game.console)) {
      onError?.(`La consola "${game.console}" no está configurada para emulación en navegador.`);
      return;
    }

    this._active = true;
    this.currentGame = game;
    this.currentConsole = game.console;
    const coreInfo = CONSOLE_CORE_MAP[game.console];

    this._runBootSequence(onBootMessage);
    hostEl.innerHTML = '';
    this._teardownPreviousInstance();

    try {
      // Intentamos recuperar un save-state automático previo (autosave
      // al salir del juego la última vez) para ofrecer continuidad.
      const savedState = await retroStorage.loadEmulatorState(game.id, 'auto');

      // --- Variables de configuración de EmulatorJS (API oficial EJS_*) ---
      window.EJS_player = '#emulator-canvas-host';
      window.EJS_core = coreInfo.core;
      window.EJS_gameUrl = game.file;
      window.EJS_pathtodata = CORE_DATA_CDN;
      window.EJS_gameName = game.name;
      window.EJS_backgroundColor = '#000000';
      window.EJS_startOnLoaded = true;
      window.EJS_fullscreenOnLoaded = false;
      window.EJS_volume = 0.6;
      window.EJS_gameID = game.id;
      // askBeforeExit=false porque el cierre limpio ya lo gestionamos
      // nosotros desde la topbar de RetroPlay (autosave incluido).
      window.EJS_askBeforeExit = false;

      // Guardado automático de partidas: cuando EmulatorJS detecta un
      // cambio en la memoria persistente del juego, lo reflejamos en
      // IndexedDB vía storage.js -- así "Continuar jugando" siempre
      // tiene el último progreso real.
      window.EJS_onSaveState = (e) => this._handleSaveStateEvent(e);
      window.EJS_onGameStart = () => {
        clearInterval(this._bootLogTimer);
        onReady?.();
        retroStorage.recordPlayed(game.id, 5);
      };

      if (savedState && savedState.data) {
        window.EJS_loadStateURL = this._base64ToBytes(savedState.data);
      } else {
        window.EJS_loadStateURL = null;
      }

      await this._injectLoader();
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
   * Inserta vendor/emulatorjs/loader.js, el bootstrap OFICIAL sin
   * modificar. Cada partida requiere una inyección nueva del script
   * (EmulatorJS no está pensado para reinicializarse in-place), así que
   * lo eliminamos y re-añadimos en cada `launch`.
   */
  _injectLoader() {
    return new Promise((resolve, reject) => {
      const prev = document.getElementById('ejs-loader-script');
      if (prev) prev.remove();

      const script = document.createElement('script');
      script.id = 'ejs-loader-script';
      script.src = `${EMULATORJS_VENDOR_PATH}loader.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('No se pudo cargar vendor/emulatorjs/loader.js'));
      document.body.appendChild(script);
    });
  }

  _teardownPreviousInstance() {
    if (window.EJS_emulator) {
      try {
        // EmulatorJS no expone un destroy() público estable entre
        // versiones; la forma segura de "cerrar" es vaciar el host y
        // soltar la referencia, dejando que el GC libere el módulo WASM.
        window.EJS_emulator = null;
      } catch (_) { /* noop */ }
    }
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
    if (!window.EJS_emulator?.gameManager?.getState) {
      throw new Error('El emulador todavía no está listo para guardar.');
    }
    const stateBytes = window.EJS_emulator.gameManager.getState();
    const base64 = this._bytesToBase64(stateBytes);
    await retroStorage.saveEmulatorState(this.currentGame.id, slot, base64);
    await retroStorage.recordPlayed(this.currentGame.id, 100);
    return true;
  }

  async loadState(slot = 'auto') {
    if (!this.currentGame) throw new Error('No hay ningún juego activo.');
    const record = await retroStorage.loadEmulatorState(this.currentGame.id, slot);
    if (!record) throw new Error('No hay ninguna partida guardada para este juego.');
    if (window.EJS_emulator?.gameManager?.loadState) {
      const bytes = this._base64ToBytes(record.data);
      window.EJS_emulator.gameManager.loadState(bytes);
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
    if (window.EJS_emulator?.controlMenu) {
      window.EJS_emulator.controlMenu.style.display = '';
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
    if (autoSave && this.currentGame && window.EJS_emulator?.gameManager?.getState) {
      try { await this.saveState('auto'); } catch (_) { /* el core puede no soportar save-state */ }
    }
    clearInterval(this._bootLogTimer);
    this._teardownPreviousInstance();
    this._active = false;
    this.currentGame = null;
    this.currentConsole = null;
  }
}

// Instancia global -- un único controlador de emulación activo a la vez.
const emulatorController = new EmulatorController();
