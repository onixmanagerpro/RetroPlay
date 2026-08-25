/**
 * storage.js
 * -----------------------------------------------------------------------
 * Capa de persistencia de RetroPlay.
 *
 * PARTIDAS GUARDADAS ("save states"): modelo LOCAL-FIRST.
 *
 *   1. SIEMPRE se guardan en este navegador, en IndexedDB (objectStore
 *      `saveStates`). Esto NO requiere sesión iniciada, NO requiere red,
 *      y es lo único de lo que depende que "Guardar partida" / "Cargar
 *      partida" funcionen siempre. Es la fuente de verdad.
 *   2. Si además el usuario tiene sesión de Firebase iniciada, cada
 *      guardado se sube TAMBIÉN a Firestore (mismo id que la copia
 *      local) como respaldo en la nube / sincronización entre
 *      dispositivos. Es "best effort": si falla (sin red, reglas de
 *      Firestore, sesión caducada...) el guardado local ya hecho no se
 *      deshace ni se convierte en un error para el usuario -- solo se
 *      registra en consola con el prefijo [SAVE-VERIFY].
 *   3. Cualquier partida (recién capturada o ya guardada) se puede
 *      además exportar a un archivo .json descargable, y ese archivo se
 *      puede volver a importar más tarde (mismo navegador, otro
 *      navegador, otro dispositivo) -- ver downloadSaveStateFile() /
 *      readSaveStateFile() más abajo. Es la tercera vía de persistencia
 *      que pidió el usuario, totalmente independiente de Firebase e
 *      IndexedDB.
 *
 * Guardar/cargar partidas por tanto NUNCA depende de que Firebase esté
 * bien configurado, de que el usuario haya iniciado sesión, ni de tener
 * conexión a internet -- solo lo necesitas si además quieres la copia en
 * la nube.
 *
 * Para activar el respaldo en la nube (opcional):
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
 * de mando) siguen guardándose localmente en IndexedDB igual que antes.
 * -----------------------------------------------------------------------
 */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA5wcZXzitPt8CE15cvKEwzTRnsT8xW8KM',
  authDomain: 'inframe-capture.firebaseapp.com',
  databaseURL: 'https://inframe-capture-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'inframe-capture',
  storageBucket: 'inframe-capture.firebasestorage.app',
  messagingSenderId: '866171827071',
  appId: '1:866171827071:web:4c1affa83d63a6bdb3a04a',
  measurementId: 'G-2Y1GK0KPHC'
};

const DB_NAME = 'retroplay-db';
const DB_VERSION = 2; // v2: añade el objectStore `saveStates` (partidas guardadas locales)

const STORES = {
  favorites: 'favorites',           // { gameId, addedAt }
  recentlyPlayed: 'recentlyPlayed', // { gameId, lastPlayedAt, progressPct }
  gamepadConfig: 'gamepadConfig',   // { id: 'default' | padId, mapping }
  settings: 'settings',             // { key, value }
  saveStates: 'saveStates'          // { id, gameId, gameName, consoleId, name, data, kind, updatedAt }
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
        if (!db.objectStoreNames.contains(STORES.saveStates)) {
          const store = db.createObjectStore(STORES.saveStates, { keyPath: 'id' });
          store.createIndex('gameId', 'gameId', { unique: false });
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
 * Adaptador de Firebase. OPCIONAL para guardar/cargar partidas: solo se
 * usa como respaldo en la nube cuando hay sesión iniciada (ver
 * RetroPlayStorage.saveEmulatorState/loadEmulatorState más abajo, que
 * usan local -- IndexedDB -- como fuente de verdad). Se instancia
 * siempre que el SDK de Firebase esté cargado en la página (ver los
 * <script> en index.html), independientemente de las demás
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
   * Sube (o sobrescribe) una copia en la nube de un registro de partida
   * que YA EXISTE localmente -- por eso recibe el `record` completo, id
   * incluido, en vez de generar uno nuevo aquí: así la copia local y la
   * copia en la nube comparten siempre el mismo id.
   */
  async createSaveState(record) {
    const col = this._saveStatesCol();
    await col.doc(record.id).set(record);
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

  // ---------- Partidas guardadas (local-first + nube opcional + archivo) ----------
  //
  // Ver el comentario grande al principio del archivo para el diseño
  // completo. Resumen: local (IndexedDB) es SIEMPRE la fuente de verdad
  // y nunca falla por temas de sesión/red; Firebase es un respaldo en la
  // nube best-effort; downloadSaveStateFile/readSaveStateFile cubren la
  // tercera vía (archivo) sin depender de ninguna de las otras dos.

  _genSaveId() {
    return `save_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Guarda una partida nueva con el nombre elegido por el usuario. SIEMPRE
   * se persiste en local (IndexedDB de este navegador) -- eso es lo que
   * garantiza que esta función nunca falle por Firebase. Cada guardado
   * crea un registro propio (no sobrescribe por juego) -- así el usuario
   * puede tener "partida naves 1", "partida naves 2", "juego retro 2",
   * etc., todas a la vez, tal como pidió.
   */
  async saveEmulatorState(game, name, data, kind = 'state') {
    const cleanName = (name || '').trim();
    if (!cleanName) {
      const err = new Error('La partida necesita un nombre.');
      saveVerifyError(err.message);
      throw err;
    }
    const record = {
      id: this._genSaveId(),
      gameId: game.id,
      gameName: game.name || game.title || game.id,
      consoleId: game.console,
      name: cleanName,
      data,
      kind: kind || 'state',
      updatedAt: Date.now()
    };

    // [SAVE-VERIFY] Esto es lo único que DEBE funcionar siempre. Si esto
    // lanza (p. ej. IndexedDB deshabilitado y sin cuota en el fallback de
    // memoria), es un error real que sí debe llegar al usuario.
    await this.local.put(STORES.saveStates, record);
    saveVerifyLog('Local: partida guardada', `"${cleanName}"`, game.id, `(${data.length} chars base64)`);

    // Respaldo en la nube: solo si hay sesión iniciada, y nunca bloqueante.
    if (this.firebase.enabled && this.firebase.isSignedIn()) {
      try {
        await this.firebase.createSaveState(record);
        saveVerifyLog('Firebase: copia en la nube subida', `"${cleanName}"`, game.id);
      } catch (err) {
        saveVerifyError('Firebase: no se pudo subir la copia en la nube (la partida local SÍ se guardó)', game.id, err);
      }
    }

    return record;
  }

  /**
   * Carga una partida por id. Se busca primero en local (inmediato, sin
   * red); si no aparece ahí -- p. ej. se guardó desde otro
   * navegador/dispositivo con la misma cuenta -- se busca en Firebase y,
   * si aparece, se copia también a local para la próxima vez.
   */
  async loadEmulatorState(saveId) {
    const local = await this.local.get(STORES.saveStates, saveId);
    if (local) {
      saveVerifyLog('Local: partida cargada', `"${local.name}"`, local.gameId, `(${local.data.length} chars base64)`);
      return local;
    }

    if (this.firebase.enabled && this.firebase.isSignedIn()) {
      try {
        const remote = await this.firebase.getSaveState(saveId);
        if (remote) {
          saveVerifyLog('Firebase: partida cargada', `"${remote.name}"`, remote.gameId, `(${remote.data.length} chars base64)`);
          try { await this.local.put(STORES.saveStates, remote); } catch (_) { /* solo caché, no crítico */ }
          return remote;
        }
      } catch (err) {
        saveVerifyError('Firebase: FALLÓ al cargar la partida', saveId, err);
      }
    }

    saveVerifyLog('No se encontró la partida', saveId);
    return null;
  }

  /** Todas las partidas guardadas del usuario: local + nube (si hay sesión), sin duplicados. */
  async listAllSaveStates() {
    const local = await this.local.getAll(STORES.saveStates);
    const byId = new Map(local.map(s => [s.id, s]));

    if (this.firebase.enabled && this.firebase.isSignedIn()) {
      try {
        const remote = await this.firebase.listSaveStates();
        for (const r of remote) {
          const existing = byId.get(r.id);
          if (!existing || (r.updatedAt || 0) > (existing.updatedAt || 0)) {
            byId.set(r.id, r);
          }
        }
      } catch (err) {
        saveVerifyError('Firebase: no se pudo listar la copia en la nube (se muestran solo las partidas locales)', err);
      }
    }

    return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Partidas guardadas del usuario para un juego concreto. */
  async listSaveStatesForGame(gameId) {
    const all = await this.listAllSaveStates();
    return all.filter(s => s.gameId === gameId);
  }

  async deleteSaveState(saveId) {
    await this.local.delete(STORES.saveStates, saveId);
    if (this.firebase.enabled && this.firebase.isSignedIn()) {
      try {
        await this.firebase.deleteSaveState(saveId);
      } catch (err) {
        saveVerifyError('Firebase: no se pudo eliminar la copia en la nube', saveId, err);
      }
    }
  }

  // ---------- Partidas guardadas como archivo (tercera vía, sin nube ni sesión) ----------
  //
  // Convierte un registro de partida (el mismo shape que usan local y
  // Firebase: {gameId, gameName, consoleId, name, data, kind}) en un
  // archivo .json descargable, y viceversa. Totalmente independiente de
  // IndexedDB y de Firebase -- sirve para hacer una copia de seguridad
  // manual o para llevar una partida a otro navegador/dispositivo.

  downloadSaveStateFile(record) {
    const payload = {
      app: 'RetroPlay',
      formatVersion: 1,
      exportedAt: Date.now(),
      gameId: record.gameId,
      gameName: record.gameName,
      consoleId: record.consoleId,
      name: record.name,
      kind: record.kind || 'state',
      data: record.data
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeBase = `${payload.gameId || 'partida'}_${payload.name || 'guardado'}`
      .replace(/[^a-z0-9_-]+/gi, '_')
      .slice(0, 80);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeBase}.rpstate.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    saveVerifyLog('Archivo: partida exportada', `"${payload.name}"`, payload.gameId);
    return payload;
  }

  async readSaveStateFile(file) {
    if (!file) throw new Error('No se seleccionó ningún archivo.');
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error('Ese archivo no es una partida válida de RetroPlay (JSON inválido).');
    }
    if (!payload || !payload.data) {
      throw new Error('Ese archivo no contiene datos de partida.');
    }
    saveVerifyLog('Archivo: partida leída', `"${payload.name || '(sin nombre)'}"`, payload.gameId);
    return payload;
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
