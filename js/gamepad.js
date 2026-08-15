/**
 * gamepad.js
 * -----------------------------------------------------------------------
 * Capa de detección de mando A NIVEL DE PLATAFORMA (fuera del emulador).
 *
 * Cubre:
 *   - Indicador de "mando conectado" en el header y en la topbar del
 *     emulador, con detección automática vía gamepadconnected/disconnected.
 *   - La vista "Configurar mando" de RetroPlay: probador de botones,
 *     visualizador de stick, reasignación de controles a nivel de
 *     plataforma y guardado de esa configuración en IndexedDB
 *     (retroStorage), para que el usuario pueda comprobar su mando
 *     ANTES de entrar a un juego.
 *   - Fallback total de teclado, siempre activo.
 *
 * IMPORTANTE — división de responsabilidades con el emulador:
 * Una vez DENTRO de una partida, el input real lo gestiona el sistema
 * nativo de EmulatorJS (su propio GamepadHandler + menú de controles,
 * ver /vendor/emulatorjs/src/gamepad.js), que ya soporta mandos Xbox,
 * PlayStation, genéricos USB y Bluetooth vía el "Standard Gamepad" del
 * navegador, y persiste su propia configuración. Reimplementar esa
 * lógica aquí y hacerla competir por los mismos eventos del navegador
 * duplicaría el polling y podría desincronizar el remapeo real. Por eso
 * gamepad.js se limita a la capa de plataforma: todo lo que ocurre
 * ANTES de pulsar "Jugar", más el indicador visual persistente.
 * -----------------------------------------------------------------------
 */

// Acciones lógicas que se muestran en el probador / lista de reasignación
// de la vista "Configurar mando" de RetroPlay.
const LOGICAL_BUTTONS = [
  { id: 'up', label: 'Arriba', group: 'dpad' },
  { id: 'down', label: 'Abajo', group: 'dpad' },
  { id: 'left', label: 'Izquierda', group: 'dpad' },
  { id: 'right', label: 'Derecha', group: 'dpad' },
  { id: 'a', label: 'Botón A / ✕', group: 'face' },
  { id: 'b', label: 'Botón B / ○', group: 'face' },
  { id: 'x', label: 'Botón X / □', group: 'face' },
  { id: 'y', label: 'Botón Y / △', group: 'face' },
  { id: 'l', label: 'Gatillo L / L1', group: 'shoulder' },
  { id: 'r', label: 'Gatillo R / R1', group: 'shoulder' },
  { id: 'start', label: 'Start', group: 'system' },
  { id: 'select', label: 'Select', group: 'system' }
];

// Mapeo por defecto para un "Standard Gamepad" (spec del navegador).
// Xbox, PlayStation (DualShock/DualSense) y la mayoría de mandos
// USB/Bluetooth genéricos exponen este mismo layout estándar cuando el
// navegador los reconoce, así que un único mapeo cubre los cuatro casos
// pedidos sin necesidad de perfiles distintos por marca.
const DEFAULT_GAMEPAD_MAPPING = {
  up: { type: 'button', index: 12 },
  down: { type: 'button', index: 13 },
  left: { type: 'button', index: 14 },
  right: { type: 'button', index: 15 },
  a: { type: 'button', index: 0 },
  b: { type: 'button', index: 1 },
  x: { type: 'button', index: 2 },
  y: { type: 'button', index: 3 },
  l: { type: 'button', index: 4 },
  r: { type: 'button', index: 5 },
  start: { type: 'button', index: 9 },
  select: { type: 'button', index: 8 }
};

// Fallback de teclado -- siempre activo, independientemente del mando.
const DEFAULT_KEYBOARD_MAPPING = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  a: 'KeyZ',
  b: 'KeyX',
  x: 'KeyA',
  y: 'KeyS',
  l: 'KeyQ',
  r: 'KeyW',
  start: 'Enter',
  select: 'ShiftRight'
};

const KEY_DISPLAY_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  KeyZ: 'Z', KeyX: 'X', KeyA: 'A', KeyS: 'S', KeyQ: 'Q', KeyW: 'W',
  Enter: 'Enter', ShiftRight: 'Shift der.'
};

const AXIS_DEADZONE = 0.22;

class GamepadManager {
  constructor() {
    this.pads = new Map();
    this.activePadIndex = null;
    this.mapping = { ...DEFAULT_GAMEPAD_MAPPING };
    this.keyboardMapping = { ...DEFAULT_KEYBOARD_MAPPING };
    this.connectionListeners = new Set();
    this._rawButtonListeners = new Set();
    this._stickListeners = new Set();
    this._pollHandle = null;
    this._remapListener = null;
    this._lastRawState = {};

    this._bindBrowserEvents();
    this._loadSavedMapping();
  }

  // ---------------------------------------------------------------------
  // Conexión / desconexión
  // ---------------------------------------------------------------------
  _bindBrowserEvents() {
    window.addEventListener('gamepadconnected', (e) => {
      const gp = e.gamepad;
      this.pads.set(gp.index, gp);
      if (this.activePadIndex === null) this.activePadIndex = gp.index;
      this._notifyConnection(true, gp);
      this._startPolling();
      this.loadMappingForActivePad();
      console.info(`[gamepad] Conectado: ${gp.id} (índice ${gp.index})`);
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      const gp = e.gamepad;
      this.pads.delete(gp.index);
      if (this.activePadIndex === gp.index) {
        const remaining = Array.from(this.pads.keys());
        this.activePadIndex = remaining.length ? remaining[0] : null;
      }
      this._notifyConnection(this.pads.size > 0, gp);
      if (this.pads.size === 0) this._stopPolling();
      console.info(`[gamepad] Desconectado: ${gp.id}`);
    });

    // Safari a veces no dispara gamepadconnected hasta la primera
    // pulsación; hacemos también un barrido inicial.
    this._scanExisting();
  }

  _scanExisting() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    for (const gp of pads) {
      if (gp) {
        this.pads.set(gp.index, gp);
        if (this.activePadIndex === null) this.activePadIndex = gp.index;
      }
    }
    if (this.pads.size > 0) {
      this._notifyConnection(true, this.pads.get(this.activePadIndex));
      this._startPolling();
    }
  }

  onConnectionChange(cb) {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  _notifyConnection(connected, gp) {
    this.connectionListeners.forEach(cb => cb(connected, gp));
  }

  getActivePad() {
    if (this.activePadIndex === null || !navigator.getGamepads) return null;
    return navigator.getGamepads()[this.activePadIndex] || null;
  }

  getPadProfileId() {
    const gp = this.getActivePad();
    if (!gp) return 'keyboard';
    return gp.id.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  }

  isConnected() {
    return this.pads.size > 0;
  }

  // ---------------------------------------------------------------------
  // Polling -- solo se usa para el probador de botones / stick de la
  // vista "Configurar mando" de la plataforma, no dentro del emulador.
  // ---------------------------------------------------------------------
  _startPolling() {
    if (this._pollHandle) return;
    const loop = () => {
      this._pollFrame();
      this._pollHandle = requestAnimationFrame(loop);
    };
    this._pollHandle = requestAnimationFrame(loop);
  }

  _stopPolling() {
    if (this._pollHandle) cancelAnimationFrame(this._pollHandle);
    this._pollHandle = null;
  }

  _pollFrame() {
    const gp = this.getActivePad();
    if (!gp) return;

    if (this._remapListener) {
      const pressedIndex = gp.buttons.findIndex(b => b.pressed || b.value > 0.6);
      if (pressedIndex !== -1) {
        this._remapListener({ type: 'button', index: pressedIndex });
        this._remapListener = null;
        return;
      }
      for (let i = 0; i < gp.axes.length; i++) {
        if (Math.abs(gp.axes[i]) > 0.7) {
          this._remapListener({ type: 'axis', index: i, direction: gp.axes[i] > 0 ? 1 : -1 });
          this._remapListener = null;
          return;
        }
      }
      return;
    }

    this._emitRawButtons(gp);
    this._emitStickPosition(gp);
  }

  _emitRawButtons(gp) {
    gp.buttons.forEach((b, i) => {
      const pressed = b.pressed || b.value > 0.5;
      const key = `raw:${i}`;
      const was = this._lastRawState[key] || false;
      if (pressed !== was) {
        this._lastRawState[key] = pressed;
        this._rawButtonListeners.forEach(cb => cb(i, pressed));
      }
    });
  }

  _emitStickPosition(gp) {
    const x = gp.axes[0] || 0;
    const y = gp.axes[1] || 0;
    this._stickListeners.forEach(cb => cb(x, y));
  }

  onRawButton(cb) {
    this._rawButtonListeners.add(cb);
    return () => this._rawButtonListeners.delete(cb);
  }

  onStickMove(cb) {
    this._stickListeners.add(cb);
    return () => this._stickListeners.delete(cb);
  }

  // ---------------------------------------------------------------------
  // Captura de teclado para el flujo de reasignación (no bloquea el uso
  // normal del teclado en el resto de la plataforma).
  // ---------------------------------------------------------------------
  captureNextKey(cb) {
    const handler = (e) => {
      window.removeEventListener('keydown', handler, true);
      cb({ type: 'key', code: e.code });
      e.preventDefault();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }

  // ---------------------------------------------------------------------
  // Reasignación de controles (vista "Configurar mando" de la plataforma)
  // ---------------------------------------------------------------------
  waitForNextInput(logicalId, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._remapListener = null;
        cancelKeyCapture();
        reject(new Error('timeout'));
      }, timeoutMs);

      const cancelKeyCapture = this.captureNextKey((binding) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._remapListener = null;
        this.keyboardMapping[logicalId] = binding.code;
        resolve({ kind: 'keyboard', display: KEY_DISPLAY_NAMES[binding.code] || binding.code });
      });

      this._remapListener = (binding) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cancelKeyCapture();
        this.mapping[logicalId] = binding;
        resolve({ kind: 'gamepad', display: this._describeBinding(binding) });
      };
    });
  }

  cancelRemap() {
    this._remapListener = null;
  }

  _describeBinding(binding) {
    if (binding.type === 'button') return `Botón ${binding.index}`;
    if (binding.type === 'axis') return `Eje ${binding.index} (${binding.direction > 0 ? '+' : '-'})`;
    return '—';
  }

  describeCurrentBinding(logicalId) {
    const pad = this.mapping[logicalId];
    const key = this.keyboardMapping[logicalId];
    const padDesc = pad ? this._describeBinding(pad) : '—';
    const keyDesc = key ? (KEY_DISPLAY_NAMES[key] || key) : '—';
    return { padDesc, keyDesc };
  }

  // ---------------------------------------------------------------------
  // Persistencia de configuración (por perfil de mando) vía storage.js
  // ---------------------------------------------------------------------
  async saveMapping() {
    const profileId = this.getPadProfileId();
    await retroStorage.saveGamepadMapping(profileId, {
      gamepad: this.mapping,
      keyboard: this.keyboardMapping
    });
    // También guardamos como "default" para que el próximo mando
    // desconocido arranque con la última config usada.
    await retroStorage.saveGamepadMapping('default', {
      gamepad: this.mapping,
      keyboard: this.keyboardMapping
    });
    return profileId;
  }

  async _loadSavedMapping() {
    const saved = await retroStorage.getGamepadMapping('default');
    if (saved && saved.mapping) {
      this.mapping = { ...DEFAULT_GAMEPAD_MAPPING, ...(saved.mapping.gamepad || {}) };
      this.keyboardMapping = { ...DEFAULT_KEYBOARD_MAPPING, ...(saved.mapping.keyboard || {}) };
    }
  }

  async loadMappingForActivePad() {
    const profileId = this.getPadProfileId();
    const saved = await retroStorage.getGamepadMapping(profileId);
    if (saved && saved.mapping) {
      this.mapping = { ...DEFAULT_GAMEPAD_MAPPING, ...(saved.mapping.gamepad || {}) };
      this.keyboardMapping = { ...DEFAULT_KEYBOARD_MAPPING, ...(saved.mapping.keyboard || {}) };
    }
  }

  resetToDefaults() {
    this.mapping = { ...DEFAULT_GAMEPAD_MAPPING };
    this.keyboardMapping = { ...DEFAULT_KEYBOARD_MAPPING };
  }
}

// Instancia global -- un único gestor de mandos de plataforma.
const gamepadManager = new GamepadManager();
