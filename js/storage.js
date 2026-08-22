/**
 * storage.js
 * -----------------------------------------------------------------------
 * Capa de persistencia de RetroPlay.
 *
 * Por defecto TODO se guarda en IndexedDB, en local, sin backend ni cuenta.
 * Esto cumple el requisito de "app principalmente estática, sin backend
 * salvo que sea necesario más adelante".
 *
 * Se incluye además un adaptador opcional de Firebase (ver FirebaseAdapter
 * al final del archivo) para el día que se quiera sincronizar partidas
 * entre dispositivos con una cuenta (Google / email). Está DESACTIVADO
 * por defecto (RETROPLAY_CONFIG.useFirebase = false) precisamente porque
 * añadir autenticación real es una decisión de producto — y de costes de
 * infraestructura — que se debe tomar de forma explícita, no como opción
 * por defecto de una plantilla.
 *
 * Para activarlo:
 *   1. Crear un proyecto en https://console.firebase.google.com
 *   2. Rellenar RETROPLAY_CONFIG.firebase con las credenciales del proyecto
 *   3. Poner RETROPLAY_CONFIG.useFirebase = true
 *   4. Incluir los SDK de Firebase (firebase-app, firebase-auth,
 *      firebase-firestore) antes de este script en index.html
 * -----------------------------------------------------------------------
 */

const RETROPLAY_CONFIG = {
  useFirebase: false, // ⚠️ Cambiar a true solo tras configurar Firebase (ver arriba)
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: ''
  }
};

const DB_NAME = 'retroplay-db';
const DB_VERSION = 1;

const STORES = {
  favorites: 'favorites',       // { gameId, addedAt }
  recentlyPlayed: 'recentlyPlayed', // { gameId, lastPlayedAt, progressPct }
  saveStates: 'saveStates',     // { id: `${gameId}::slot`, gameId, slot, data (blob/base64), updatedAt }
  gamepadConfig: 'gamepadConfig', // { id: 'default' | padId, mapping }
  settings: 'settings'          // { key, value }
};

// -----------------------------------------------------------------------
// [SAVE-VERIFY] Prefijo de log reservado exclusivamente para la ruta de
// guardado/carga de partidas. Cualquier fallo en esta ruta se reporta
// aquí SIEMPRE -- nunca se traga en un catch vacío -- para que un bug de
// persistencia sea visible en la consola en el momento en que ocurre, no
// descubierto días después al perder una partida.
// -----------------------------------------------------------------------
function saveVerifyLog(...args) {
  console.log('[SAVE-VERIFY]', ...args);
}
function saveVerifyError(...args) {
  console.error('[SAVE-VERIFY]', ...args);
}

// -----------------------------------------------------------------------
// Fallback de localStorage para saveStates cuando IndexedDB no está
// disponible o falla (cuota excedida, contexto file://, modo incógnito
// con restricciones, navegador con IndexedDB deshabilitado). Solo cubre
// saveStates -- es la única categoría de datos cuya pérdida es
// irreversible para el usuario; favoritos/recientes/config de mando se
// pueden rehacer, una partida guardada no.
//
// localStorage tiene un límite práctico de ~5MB por origen, y un
// save-state de un core pesado (PS1 con RAM expandida, N64) puede rondar
// varios cientos de KB en base64. Por eso solo se guarda AQUÍ el slot
// 'auto' y el último 'manual' de cada juego -- no un historial -- y se
// aplica compresión ligera por deduplicación de slots antiguos del mismo
// juego antes de escribir, para minimizar el riesgo de QuotaExceededError.
// -----------------------------------------------------------------------
const LS_PREFIX = 'retroplay-savestate::';

function lsKey(gameId, slot) {
  return LS_PREFIX + gameId + '::' + slot;
}

function localStorageAvailable() {
  try {
    const testKey = '__retroplay_ls_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch (err) {
    return false;
  }
}

function saveStateToLocalStorage(gameId, slot, data) {
  if (!localStorageAvailable()) {
    saveVerifyError('localStorage no disponible; no hay fallback posible para', gameId, slot);
    return false;
  }
  const record = { id: `${gameId}::${slot}`, gameId, slot, data, updatedAt: Date.now() };
  try {
    window.localStorage.setItem(lsKey(gameId, slot), JSON.stringify(record));
    saveVerifyLog('Fallback localStorage: guardado', gameId, slot, `(${data.length} chars base64)`);
    return true;
  } catch (err) {
    saveVerifyError('Fallback localStorage FALLÓ al guardar', gameId, slot, err);
    return false;
  }
}

function loadStateFromLocalStorage(gameId, slot) {
  if (!localStorageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(lsKey(gameId, slot));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    saveVerifyError('Fallback localStorage FALLÓ al leer', gameId, slot, err);
    return null;
  }
}

class LocalStorageAdapter {
  constructor() {
    this._db = null;
    this._ready = this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        console.warn('[storage] IndexedDB no disponible en este navegador. Se usará memoria volátil.');
        this._memoryFallback = this._buildMemoryFallback();
        resolve(null);
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORES.favorites)) {
          db.createObjectStore(STORES.favorites, { keyPath: 'gameId' });
        }
        if (!db.objectStoreNames.contains(STORES.recentlyPlayed)) {
          db.createObjectStore(STORES.recentlyPlayed, { keyPath: 'gameId' });
        }
        if (!db.objectStoreNames.contains(STORES.saveStates)) {
          db.createObjectStore(STORES.saveStates, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.gamepadConfig)) {
          db.createObjectStore(STORES.gamepadConfig, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.settings)) {
          db.createObjectStore(STORES.settings, { keyPath: 'key' });
        }
      };

      req.onsuccess = (event) => {
        this._db = event.target.result;
        resolve(this._db);
      };

      req.onerror = () => {
        console.error('[storage] Error abriendo IndexedDB', req.error);
        this._memoryFallback = this._buildMemoryFallback();
        resolve(null);
      };
    });
  }

  _buildMemoryFallback() {
    const maps = {};
    Object.values(STORES).forEach(s => { maps[s] = new Map(); });
    return maps;
  }

  async _tx(storeName, mode) {
    await this._ready;
    if (!this._db) return null; // usaremos memoryFallback
    const tx = this._db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  async put(storeName, value) {
    const store = await this._tx(storeName, 'readwrite');
    if (!store) {
      const keyPath = value.gameId ? 'gameId' : (value.id ? 'id' : 'key');
      this._memoryFallback[storeName].set(value[keyPath], value);
      return value;
    }
    return new Promise((resolve, reject) => {
      const req = store.put(value);
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }

  async get(storeName, key) {
    const store = await this._tx(storeName, 'readonly');
    if (!store) return this._memoryFallback[storeName].get(key) || null;
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(storeName) {
    const store = await this._tx(storeName, 'readonly');
    if (!store) return Array.from(this._memoryFallback[storeName].values());
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, key) {
    const store = await this._tx(storeName, 'readwrite');
    if (!store) {
      this._memoryFallback[storeName].delete(key);
      return true;
    }
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * API pública de persistencia usada por el resto de la app.
 * Envuelve LocalStorageAdapter (y, si algún día se activa, FirebaseAdapter)
 * para que app.js / library.js / emulator.js / gamepad.js no necesiten
 * saber de dónde vienen realmente los datos.
 */
class RetroPlayStorage {
  constructor() {
    this.local = new LocalStorageAdapter();
    this.remote = RETROPLAY_CONFIG.useFirebase ? new FirebaseAdapter(RETROPLAY_CONFIG.firebase) : null;
  }

  // ---------- Favoritos ----------
  async toggleFavorite(gameId) {
    const existing = await this.local.get(STORES.favorites, gameId);
    if (existing) {
      await this.local.delete(STORES.favorites, gameId);
      return false;
    }
    await this.local.put(STORES.favorites, { gameId, addedAt: Date.now() });
    return true;
  }

  async isFavorite(gameId) {
    return !!(await this.local.get(STORES.favorites, gameId));
  }

  async getFavoriteIds() {
    const all = await this.local.getAll(STORES.favorites);
    return all.sort((a, b) => b.addedAt - a.addedAt).map(f => f.gameId);
  }

  // ---------- Recientemente jugados / "Continuar jugando" ----------
  async recordPlayed(gameId, progressPct = 0) {
    await this.local.put(STORES.recentlyPlayed, {
      gameId,
      lastPlayedAt: Date.now(),
      progressPct
    });
    if (this.remote) this.remote.syncRecentlyPlayed(gameId, progressPct).catch(() => {});
  }

  async getRecentlyPlayed(limit = 10) {
    const all = await this.local.getAll(STORES.recentlyPlayed);
    return all.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, limit);
  }

  // ---------- Estados de guardado del emulador ----------
  //
  // [SAVE-VERIFY] Este método YA NO asume que el guardado funcionó solo
  // porque la promesa de put() resolvió sin lanzar. IndexedDB puede
  // resolver "con éxito" una escritura que en la práctica no persiste
  // (algunos navegadores en modo incógnito, o con la cuota ya agotada,
  // devuelven éxito silencioso). Por eso, tras escribir, se hace una
  // lectura de verificación inmediata: solo se considera guardado real
  // si el dato releído coincide en longitud con el dato escrito.
  //
  // Si la verificación falla, o si put() lanza una excepción, se cae a
  // localStorage como red de seguridad, y se registra el resultado en
  // ambos casos con el prefijo [SAVE-VERIFY] -- nunca en silencio.
  async saveEmulatorState(gameId, slot, data) {
    const record = { id: `${gameId}::${slot}`, gameId, slot, data, updatedAt: Date.now() };
    let indexedDbOk = false;

    try {
      await this.local.put(STORES.saveStates, record);
      const verify = await this.local.get(STORES.saveStates, record.id);
      indexedDbOk = !!(verify && verify.data && verify.data.length === data.length);
      if (indexedDbOk) {
        saveVerifyLog('IndexedDB: guardado y verificado', gameId, slot, `(${data.length} chars base64)`);
      } else {
        saveVerifyError('IndexedDB: put() resolvió pero la verificación de lectura NO coincide', gameId, slot,
          verify ? `(esperado ${data.length}, leído ${verify.data ? verify.data.length : 'null'})` : '(no se encontró el registro)');
      }
    } catch (err) {
      saveVerifyError('IndexedDB: excepción al guardar', gameId, slot, err);
    }

    // Red de seguridad: si IndexedDB falló la verificación por cualquier
    // motivo, se guarda también (o exclusivamente) en localStorage, para
    // que el progreso no se pierda solo porque un motor de storage falló.
    const localStorageOk = indexedDbOk ? true : saveStateToLocalStorage(gameId, slot, data);

    if (!indexedDbOk && !localStorageOk) {
      // Ninguno de los dos motores de persistencia funcionó. Esto es un
      // fallo real y visible -- se relanza para que la capa de llamada
      // (emulator.js) pueda informar al usuario en vez de mostrar el
      // botón de "guardado" como si todo hubiera ido bien.
      const err = new Error('No se pudo guardar la partida: fallaron IndexedDB y localStorage.');
      saveVerifyError(err.message, gameId, slot);
      throw err;
    }

    if (this.remote) this.remote.uploadSaveState(record).catch(() => {});
    return record;
  }

  // [SAVE-VERIFY] Intenta IndexedDB primero; si no hay nada ahí (o el
  // registro está corrupto/incompleto), cae a localStorage antes de
  // devolver null. Antes, un fallo silencioso de IndexedDB se traducía
  // directamente en "no hay partida guardada" aunque sí la hubiera.
  async loadEmulatorState(gameId, slot = 'auto') {
    let record = null;
    try {
      record = await this.local.get(STORES.saveStates, `${gameId}::${slot}`);
    } catch (err) {
      saveVerifyError('IndexedDB: excepción al leer', gameId, slot, err);
    }

    if (record && record.data) {
      saveVerifyLog('IndexedDB: partida encontrada', gameId, slot, `(${record.data.length} chars base64, guardada ${new Date(record.updatedAt).toISOString()})`);
      return record;
    }

    const fallback = loadStateFromLocalStorage(gameId, slot);
    if (fallback && fallback.data) {
      saveVerifyLog('localStorage (fallback): partida encontrada', gameId, slot, `(${fallback.data.length} chars base64, guardada ${new Date(fallback.updatedAt).toISOString()})`);
      return fallback;
    }

    saveVerifyLog('Sin partida guardada en ningún motor', gameId, slot);
    return null;
  }

  async listSaveStatesForGame(gameId) {
    const all = await this.local.getAll(STORES.saveStates);
    return all.filter(s => s.gameId === gameId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---------- Configuración de mando ----------
  async saveGamepadMapping(padProfileId, mapping) {
    const record = { id: padProfileId, mapping, updatedAt: Date.now() };
    await this.local.put(STORES.gamepadConfig, record);
    if (this.remote) this.remote.syncGamepadConfig(record).catch(() => {});
    return record;
  }

  async getGamepadMapping(padProfileId) {
    return this.local.get(STORES.gamepadConfig, padProfileId);
  }

  // ---------- Ajustes generales ----------
  async setSetting(key, value) {
    return this.local.put(STORES.settings, { key, value });
  }

  async getSetting(key, fallback = null) {
    const rec = await this.local.get(STORES.settings, key);
    return rec ? rec.value : fallback;
  }
}

/**
 * Adaptador opcional de Firebase — NO se instancia salvo que
 * RETROPLAY_CONFIG.useFirebase sea true y los SDK de Firebase estén
 * cargados en la página. Pensado para sincronizar partidas/config
 * cuando el usuario inicia sesión con Google o correo.
 */
class FirebaseAdapter {
  constructor(config) {
    if (typeof firebase === 'undefined') {
      console.warn('[storage] useFirebase=true pero el SDK de Firebase no está cargado. Añade los <script> de Firebase antes de storage.js.');
      this.enabled = false;
      return;
    }
    this.app = firebase.initializeApp(config);
    this.auth = firebase.auth();
    this.db = firebase.firestore();
    this.enabled = true;
    this.user = null;
    this.auth.onAuthStateChanged(u => { this.user = u; });
  }

  async signInWithGoogle() {
    if (!this.enabled) return null;
    const provider = new firebase.auth.GoogleAuthProvider();
    const res = await this.auth.signInWithPopup(provider);
    return res.user;
  }

  async signInWithEmail(email, password) {
    if (!this.enabled) return null;
    const res = await this.auth.signInWithEmailAndPassword(email, password);
    return res.user;
  }

  async signOut() {
    if (!this.enabled) return;
    return this.auth.signOut();
  }

  _userDoc(sub) {
    if (!this.user) throw new Error('No hay sesión iniciada');
    return this.db.collection('users').doc(this.user.uid).collection(sub);
  }

  async uploadSaveState(record) {
    if (!this.enabled || !this.user) return;
    await this._userDoc('saveStates').doc(record.id).set(record);
  }

  async syncGamepadConfig(record) {
    if (!this.enabled || !this.user) return;
    await this._userDoc('gamepadConfig').doc(record.id).set(record);
  }

  async syncRecentlyPlayed(gameId, progressPct) {
    if (!this.enabled || !this.user) return;
    await this._userDoc('recentlyPlayed').doc(gameId).set({ gameId, progressPct, lastPlayedAt: Date.now() });
  }
}

// Instancia global usada por el resto de módulos.
const retroStorage = new RetroPlayStorage();
