/**
 * storage.js
 * -----------------------------------------------------------------------
 * Capa de persistencia de RetroPlay.
 *
 * PARTIDAS GUARDADAS ("save states"): viven EXCLUSIVAMENTE en Firebase
 * (Auth + Firestore), como una "memory card" personal ligada a la cuenta
 * del usuario. No hay IndexedDB, no hay localStorage, no hay autosave:
 * la única forma de guardar o cargar una partida es a través del botón
 * "Guardar partida" (pide un nombre elegido por el usuario, p.ej.
 * "partida naves 1") y el botón "Cargar partida" (lista esas partidas
 * por nombre) de la topbar del emulador. Ver RetroPlayStorage más abajo.
 *
 * Para activar Firebase:
 *   1. Crear un proyecto en https://console.firebase.google.com
 *   2. Activar Authentication -> Sign-in method -> Google y Email/contraseña
 *   3. Crear una base de datos Firestore (modo producción)
 *   4. Rellenar FIREBASE_CONFIG más abajo con las credenciales del proyecto
 *      (Configuración del proyecto -> Tus apps -> SDK de configuración)
 *   5. Reglas de seguridad recomendadas en Firestore (cada usuario solo
 *      puede leer/escribir sus propias partidas):
 *        rules_version = '2';
 *        service cloud.firestore {
 *          match /databases/{database}/documents {
 *            match /users/{userId}/saveStates/{saveId} {
 *              allow read, write: if request.auth != null && request.auth.uid == userId;
 *            }
 *          }
 *        }
 *
 * OTRAS FUNCIONALIDADES (favoritos, "recientemente jugado", configuración
 * de mando) siguen guardándose localmente en IndexedDB: no son "partidas"
 * y el usuario no pidió tocarlas.
 * -----------------------------------------------------------------------
 */

const FIREBASE_CONFIG = {
  apiKey: 'TU_API_KEY',
  authDomain: 'TU_PROYECTO.firebaseapp.com',
  projectId: 'TU_PROYECTO',
  storageBucket: 'TU_PROYECTO.appspot.com',
  messagingSenderId: 'TU_MESSAGING_SENDER_ID',
  appId: 'TU_APP_ID'
};

const DB_NAME = 'retroplay-db';
const DB_VERSION = 1;

const STORES = {
  favorites: 'favorites',           // { gameId, addedAt }
  recentlyPlayed: 'recentlyPlayed', // { gameId, lastPlayedAt, progressPct }
  gamepadConfig: 'gamepadConfig',   // { id: 'default' | padId, mapping }
  settings: 'settings'              // { key, value }
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

class LocalStorageAdapter {
  constructor() {
    this._db = null;
    this._ready = this._open();
  }

  _open() {
    return new Promise((resolve) => {
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
 * Adaptador de Firebase. Es OBLIGATORIO para guardar/cargar partidas:
 * sin sesión iniciada no hay memory card a la que escribir ni leer. Se
 * instancia siempre que el SDK de Firebase esté cargado en la página
 * (ver los <script> en index.html), independientemente de las demás
 * funcionalidades de la app (favoritos, etc.), que no dependen de esto.
 */
class FirebaseAdapter {
  constructor(config) {
    if (typeof firebase === 'undefined') {
      console.error('[storage] El SDK de Firebase no está cargado. Añade los <script> de Firebase antes de storage.js en index.html.');
      this.enabled = false;
      return;
    }
    this.app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
    this.auth = firebase.auth();
    this.db = firebase.firestore();
    this.enabled = true;
    this.user = null;
    this._authReady = new Promise((resolve) => {
      const unsub = this.auth.onAuthStateChanged((u) => {
        this.user = u;
        resolve(u);
        unsub();
      });
    });
    this.auth.onAuthStateChanged((u) => { this.user = u; });
  }

  /** Espera a que Firebase Auth resuelva el estado de sesión inicial. */
  async waitForAuthReady() {
    if (!this.enabled) return null;
    return this._authReady;
  }

  isSignedIn() {
    return !!(this.enabled && this.user);
  }

  onAuthStateChanged(cb) {
    if (!this.enabled) return () => {};
    return this.auth.onAuthStateChanged(cb);
  }

  async signInWithGoogle() {
    if (!this.enabled) throw new Error('Firebase no está configurado.');
    const provider = new firebase.auth.GoogleAuthProvider();
    const res = await this.auth.signInWithPopup(provider);
    return res.user;
  }

  async signInWithEmail(email, password) {
    if (!this.enabled) throw new Error('Firebase no está configurado.');
    const res = await this.auth.signInWithEmailAndPassword(email, password);
    return res.user;
  }

  async registerWithEmail(email, password) {
    if (!this.enabled) throw new Error('Firebase no está configurado.');
    const res = await this.auth.createUserWithEmailAndPassword(email, password);
    return res.user;
  }

  async signOut() {
    if (!this.enabled) return;
    return this.auth.signOut();
  }

  _requireUser() {
    if (!this.enabled) throw new Error('Firebase no está configurado.');
    if (!this.user) throw new Error('Debes iniciar sesión para guardar o cargar partidas.');
    return this.user;
  }

  _saveStatesCol() {
    const user = this._requireUser();
    return this.db.collection('users').doc(user.uid).collection('saveStates');
  }

  /**
   * Guarda una partida nueva con el nombre elegido por el usuario, como
   * una entrada más de su memory card en Firestore. Cada guardado crea
   * un documento propio (no sobrescribe por juego) -- así el usuario
   * puede tener "partida naves 1", "partida naves 2", "juego retro 2",
   * etc., todas a la vez, tal como pidió.
   */
  async createSaveState({ gameId, gameName, consoleId, name, data, kind }) {
    const col = this._saveStatesCol();
    const docRef = col.doc();
    const record = {
      id: docRef.id,
      gameId,
      gameName: gameName || gameId,
      consoleId: consoleId || null,
      name,
      data,
      kind: kind || 'state',
      updatedAt: Date.now()
    };
    await docRef.set(record);
    return record;
  }

  /** Todas las partidas guardadas del usuario, sin importar el juego. */
  async listSaveStates() {
    const col = this._saveStatesCol();
    const snap = await col.orderBy('updatedAt', 'desc').get();
    return snap.docs.map(d => d.data());
  }

  async getSaveState(saveId) {
    const col = this._saveStatesCol();
    const doc = await col.doc(saveId).get();
    return doc.exists ? doc.data() : null;
  }

  async deleteSaveState(saveId) {
    const col = this._saveStatesCol();
    await col.doc(saveId).delete();
  }
}

/**
 * API pública de persistencia usada por el resto de la app.
 */
class RetroPlayStorage {
  constructor() {
    this.local = new LocalStorageAdapter();
    this.firebase = new FirebaseAdapter(FIREBASE_CONFIG);
  }

  // ---------- Sesión ----------
  get isFirebaseReady() {
    return this.firebase.enabled;
  }

  isSignedIn() {
    return this.firebase.isSignedIn();
  }

  currentUser() {
    return this.firebase.user;
  }

  waitForAuthReady() {
    return this.firebase.waitForAuthReady();
  }

  onAuthStateChanged(cb) {
    return this.firebase.onAuthStateChanged(cb);
  }

  signInWithGoogle() {
    return this.firebase.signInWithGoogle();
  }

  signInWithEmail(email, password) {
    return this.firebase.signInWithEmail(email, password);
  }

  registerWithEmail(email, password) {
    return this.firebase.registerWithEmail(email, password);
  }

  signOut() {
    return this.firebase.signOut();
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
  }

  async getRecentlyPlayed(limit = 10) {
    const all = await this.local.getAll(STORES.recentlyPlayed);
    return all.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, limit);
  }

  // ---------- Partidas guardadas (memory card en Firebase) ----------
  //
  // Único mecanismo de guardado/carga de RetroPlay. No hay slots, no hay
  // "auto", no hay IndexedDB ni localStorage de por medio: cada partida
  // guardada es un documento en Firestore, bajo la cuenta del usuario,
  // identificado por el NOMBRE que él mismo eligió al guardar.
  //
  // [SAVE-VERIFY] Si Firebase no está configurado o el usuario no ha
  // iniciado sesión, esto lanza en vez de fallar en silencio -- la capa
  // de UI (emulator.js / app.js) es responsable de mostrar ese error.
  async saveEmulatorState(game, name, data, kind = 'state') {
    const cleanName = (name || '').trim();
    if (!cleanName) {
      const err = new Error('La partida necesita un nombre.');
      saveVerifyError(err.message);
      throw err;
    }
    try {
      const record = await this.firebase.createSaveState({
        gameId: game.id,
        gameName: game.name || game.title || game.id,
        consoleId: game.console,
        name: cleanName,
        data,
        kind
      });
      saveVerifyLog('Firebase: partida guardada', `"${cleanName}"`, game.id, `(${data.length} chars base64)`);
      return record;
    } catch (err) {
      saveVerifyError('Firebase: FALLÓ al guardar la partida', `"${cleanName}"`, game.id, err);
      throw err;
    }
  }

  async loadEmulatorState(saveId) {
    try {
      const record = await this.firebase.getSaveState(saveId);
      if (record) {
        saveVerifyLog('Firebase: partida cargada', `"${record.name}"`, record.gameId, `(${record.data.length} chars base64)`);
      } else {
        saveVerifyLog('Firebase: no se encontró la partida', saveId);
      }
      return record;
    } catch (err) {
      saveVerifyError('Firebase: FALLÓ al cargar la partida', saveId, err);
      throw err;
    }
  }

  /** Todas las partidas guardadas del usuario (cualquier juego). */
  async listAllSaveStates() {
    return this.firebase.listSaveStates();
  }

  /** Partidas guardadas del usuario para un juego concreto. */
  async listSaveStatesForGame(gameId) {
    const all = await this.firebase.listSaveStates();
    return all.filter(s => s.gameId === gameId);
  }

  async deleteSaveState(saveId) {
    return this.firebase.deleteSaveState(saveId);
  }

  // ---------- Configuración de mando ----------
  async saveGamepadMapping(padProfileId, mapping) {
    const record = { id: padProfileId, mapping, updatedAt: Date.now() };
    await this.local.put(STORES.gamepadConfig, record);
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

// Instancia global usada por el resto de módulos.
const retroStorage = new RetroPlayStorage();
