/**
 * google-drive-source.js
 * -----------------------------------------------------------------------
 * Resolver de archivos alojados en Google Drive.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * -----------------------------------------------------------------------
 * game.file puede apuntar a un archivo guardado en Google Drive en vez
 * de a /games/... local o a un asset de GitHub Releases. Igual que pasa
 * con GitHub (ver js/github-release-source.js), la URL de descarga de
 * Drive NO es un simple enlace fijo a partir del ID del archivo:
 *
 *   - Para archivos PEQUEÑOS, Drive permite descarga directa vía
 *     https://drive.google.com/uc?export=download&id={ID}
 *
 *   - Para archivos GRANDES (como un .bin de PS1/PS2 de cientos de MB,
 *     que es justo el caso de uso aquí), Drive intercala una página de
 *     confirmación ("Google Drive no puede escanear este archivo en
 *     busca de virus") con un token que cambia en cada descarga y que
 *     hay que extraer y reenviar. Un fetch() directo a la URL de arriba
 *     con un archivo grande NO devuelve el archivo: devuelve el HTML de
 *     esa página de aviso.
 *
 * Por eso este módulo NO resuelve nada en el navegador: reenvía la
 * petición a un endpoint propio (api/google-drive-asset.js) que hace
 * ese baile de confirmación en el servidor y devuelve los bytes reales
 * ya listos, con soporte de Range para que EmulatorJS pueda hacer
 * streaming/seek igual que con los archivos locales.
 *
 * FORMATO DE `game.file` QUE ESTE MÓDULO ENTIENDE
 * -----------------------------------------------------------------------
 *   google-drive://{ID_DEL_ARCHIVO}/{nombre-para-mostrar.ext}
 *
 * El ID es el que aparece en la URL para compartir de Drive:
 *   https://drive.google.com/file/d/EL_ID_VA_AQUI/view
 *                                    ^^^^^^^^^^^^
 * El {nombre-para-mostrar.ext} es obligatorio (a diferencia de GitHub,
 * la API pública de Drive no siempre expone el nombre original del
 * archivo sin credenciales) y debe coincidir con lo que un .cue interno
 * espera si el juego es multi-archivo.
 *
 * Ejemplo:
 *   "file": "google-drive://1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/rockfall.smc"
 *
 * Ejemplo multi-archivo (.cue + .bin):
 *   "file": [
 *     "google-drive://1AAAA.../Juego.cue",
 *     "google-drive://1BBBB.../Juego.bin"
 *   ]
 *
 * El archivo en Drive DEBE tener permiso "Cualquier usuario con el
 * enlace: Lector" -- si es privado, el proxy del servidor no puede
 * leerlo (Drive devuelve 403/redirect a login) y la descarga falla con
 * un error claro en vez de colgarse en silencio.
 *
 * Cualquier game.file que NO empiece por "google-drive://" no se toca
 * aquí -- sigue funcionando igual que antes (local o github-release://).
 * -----------------------------------------------------------------------
 */

const GDRIVE_SCHEME = 'google-drive://';

/**
 * Base del proxy CORS. Antes era una ruta relativa ("/api/google-drive-asset",
 * función de Vercel); ahora apunta al Worker de Cloudflare (ver
 * cloudflare-worker/index.js) para que los bytes de los juegos no
 * cuenten contra Fast Data Transfer / Fast Origin Transfer de Vercel.
 * Debe ser EXACTAMENTE la misma URL que en js/github-release-source.js
 * (es el mismo Worker, dos rutas distintas dentro de él).
 */
const ASSET_PROXY_BASE = 'https://retroplay-proxy.CAMBIA-ESTO.workers.dev';

function isGoogleDriveRef(fileField) {
  return typeof fileField === 'string' && fileField.startsWith(GDRIVE_SCHEME);
}

/**
 * Parsea "google-drive://ID/nombre.ext" en sus partes. Lanza un Error
 * descriptivo si falta el nombre, en vez de dejar que falle más tarde
 * con un mensaje críptico.
 */
function parseGoogleDriveRef(fileField) {
  const rest = fileField.slice(GDRIVE_SCHEME.length); // ID/nombre.ext
  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(
      `Referencia de Google Drive mal formada: "${fileField}". ` +
      `Formato esperado: google-drive://ID_DEL_ARCHIVO/nombre.ext ` +
      `(el nombre con extensión es obligatorio).`
    );
  }
  const id = rest.slice(0, slashIndex);
  const name = rest.slice(slashIndex + 1);
  if (!id || !name) {
    throw new Error(
      `Referencia de Google Drive incompleta: "${fileField}". ` +
      `Formato esperado: google-drive://ID_DEL_ARCHIVO/nombre.ext`
    );
  }
  return { id, name };
}

/**
 * Construye la URL del proxy propio (api/google-drive-asset.js) para un
 * archivo de Drive. Igual que con GitHub, no se usa la URL de Drive
 * directamente: hace falta el proxy para (a) resolver el token de
 * confirmación de archivos grandes en el servidor, y (b) añadir
 * cabeceras CORS que Drive no manda.
 */
function buildDriveProxyUrl(id, name) {
  const params = new URLSearchParams({ id, name });
  return `${ASSET_PROXY_BASE}/google-drive-asset?${params.toString()}`;
}

/**
 * Punto de entrada equivalente a resolveGameFileUrl() de
 * github-release-source.js: dado game.file (local, github-release://...
 * o google-drive://...), devuelve la URL final lista para fetch().
 */
function resolveGoogleDriveUrl(fileField) {
  if (!isGoogleDriveRef(fileField)) return fileField;
  const { id, name } = parseGoogleDriveRef(fileField);
  return buildDriveProxyUrl(id, name);
}

/**
 * Resuelve una entrada individual (string) de game.file a { name, url,
 * size, ref }, con la misma forma que usa resolveGameFileEntries() en
 * github-release-source.js, para que ambas fuentes sean intercambiables
 * dentro de un mismo array multi-archivo.
 *
 * size siempre es null aquí: el tamaño real solo se conoce tras pedirle
 * los metadatos a la API de Drive, y eso implica una petición extra por
 * archivo antes de empezar a descargar nada. Como emulator.js ya trata
 * size === null como "desconocido, usa timeout genérico" (igual que con
 * los archivos locales), no merece la pena esa petición extra solo para
 * rellenar el dato.
 */
function resolveGoogleDriveEntry(fileField) {
  const { id, name } = parseGoogleDriveRef(fileField);
  return { name, url: buildDriveProxyUrl(id, name), size: null, ref: fileField };
}

window.isGoogleDriveRef = isGoogleDriveRef;
window.resolveGoogleDriveUrl = resolveGoogleDriveUrl;
window.resolveGoogleDriveEntry = resolveGoogleDriveEntry;
