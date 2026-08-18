/**
 * github-release-source.js
 * -----------------------------------------------------------------------
 * Resolver de assets alojados en GitHub Releases.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * -----------------------------------------------------------------------
 * emulator.js y triggerDownload() en app.js hacen fetch(game.file) tal
 * cual, asumiendo que game.file ya es una URL descargable directamente
 * (un path relativo local, o -- en teoría -- una URL absoluta a un
 * asset de un Release). Eso funciona perfecto para archivos servidos
 * desde el propio dominio de RetroPlay.
 *
 * Pero un asset de GitHub Release NO tiene una URL fija y predecible a
 * partir del nombre del archivo que uno recuerda o adivina. La URL de
 * descarga directa es:
 *
 *   https://github.com/{owner}/{repo}/releases/download/{tag}/{nombre}
 *
 * y {nombre} tiene que coincidir EXACTAMENTE, carácter a carácter (con
 * su extensión, sufijo de versión, mayúsculas, etc.) con el asset que
 * subió quien creó el release. Si esa cadena no es exacta, GitHub
 * responde 404 -- ese 404 es el error que reportas ("los juegos que
 * cargan desde GitHub Release dan error"), y ocurre pase lo que pase
 * en el resto del pipeline de emulación: fetch() nunca llega a bajar
 * bytes porque la URL en sí no existe.
 *
 * LA SOLUCIÓN: no adivinar la URL. GitHub expone una API real que
 * devuelve la lista exacta de assets de un release, cada uno con su
 * browser_download_url ya resuelta:
 *
 *   GET https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}
 *
 * Este módulo consulta esa API, busca dentro de la lista de assets uno
 * cuyo nombre coincida (exacto o parcial) con lo que se pide, y
 * devuelve la browser_download_url real tal como GitHub la reporta --
 * nunca una URL construida a mano. Así, si el archivo no existe, el
 * error aparece en la búsqueda ("no se encontró ningún asset que
 * coincida") en vez de como un 404 silencioso de fetch().
 *
 * FORMATO DE `game.file` QUE ESTE MÓDULO ENTIENDE
 * -----------------------------------------------------------------------
 * Para diferenciar "archivo local en /games/..." de "asset de un
 * Release de GitHub", game.file puede usar un pseudo-esquema:
 *
 *   github-release://{owner}/{repo}@{tag}/{nombre-o-fragmento}
 *
 * Ejemplos:
 *   github-release://devkitPro/gba-examples@v20240626/template
 *   github-release://devkitPro/gba-examples@latest/gba-examples
 *
 * `{tag}` puede ser un tag exacto o la palabra especial "latest".
 * `{nombre-o-fragmento}` no necesita ser exacto: basta con que esté
 * contenido en el nombre real del asset (case-insensitive), así que
 * "template" encuentra "template.zip" o "template-v2.gba" sin que
 * tengas que saber el nombre completo de antemano.
 *
 * Cualquier game.file que NO empiece por "github-release://" se
 * considera una URL/ruta normal y este módulo no interviene -- todo tu
 * catálogo local (/games/snes/..., /downloads/...) sigue funcionando
 * exactamente igual que antes, sin pasar por aquí.
 * -----------------------------------------------------------------------
 */

const GITHUB_RELEASE_SCHEME = 'github-release://';

/**
 * Cache en memoria de la respuesta de la API por "owner/repo@tag", para
 * no repetir la consulta si el usuario reintenta cargar el mismo juego
 * varias veces seguidas en la misma sesión (la API de GitHub sin
 * autenticar tiene un límite de 60 peticiones/hora por IP).
 */
const _releaseCache = new Map();

function isGithubReleaseRef(fileField) {
  return typeof fileField === 'string' && fileField.startsWith(GITHUB_RELEASE_SCHEME);
}

/**
 * Parsea "github-release://owner/repo@tag/fragmento" en sus partes.
 * Lanza un Error descriptivo (en vez de devolver null) si el formato
 * no es válido, para que el mensaje de error llegue claro hasta la UI
 * en lugar de perderse como un 404 genérico.
 */
function parseGithubReleaseRef(fileField) {
  const rest = fileField.slice(GITHUB_RELEASE_SCHEME.length); // owner/repo@tag/fragmento
  const match = rest.match(/^([^/]+)\/([^@/]+)@([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(
      `Referencia de GitHub Release mal formada: "${fileField}". ` +
      `Formato esperado: github-release://owner/repo@tag/nombre-o-fragmento`
    );
  }
  const [, owner, repo, tag, fragment] = match;
  return { owner, repo, tag, fragment };
}

/**
 * Consulta la API de GitHub y devuelve la lista de assets del release
 * (array de { name, browser_download_url, size, content_type }).
 * Usa tag "latest" o un tag concreto según lo que se haya pedido.
 */
async function _fetchReleaseAssets(owner, repo, tag) {
  const cacheKey = `${owner}/${repo}@${tag}`;
  if (_releaseCache.has(cacheKey)) return _releaseCache.get(cacheKey);

  const apiUrl = tag === 'latest'
    ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
    : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;

  const res = await fetch(apiUrl, {
    headers: { 'Accept': 'application/vnd.github+json' }
  });

  if (res.status === 404) {
    throw new Error(
      `No existe el release "${tag}" en ${owner}/${repo}, o el repositorio ` +
      `no es público. Comprueba el tag en github.com/${owner}/${repo}/releases`
    );
  }
  if (res.status === 403) {
    // Límite de peticiones sin autenticar de la API de GitHub (60/hora
    // por IP). No es un fallo del juego en sí -- conviene decírselo al
    // usuario tal cual en vez de un "error genérico".
    throw new Error(
      'GitHub ha limitado temporalmente las consultas a su API sin ' +
      'autenticar (60 peticiones/hora por IP). Espera unos minutos e ' +
      'inténtalo de nuevo.'
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API respondió HTTP ${res.status} al consultar el release.`);
  }

  const data = await res.json();
  const assets = (data.assets || []).map(a => ({
    name: a.name,
    browser_download_url: a.browser_download_url,
    size: a.size,
    content_type: a.content_type
  }));

  _releaseCache.set(cacheKey, assets);
  return assets;
}

/**
 * Dado game.file en formato github-release://..., devuelve la URL
 * directa y REAL (browser_download_url, tal como la reporta la API de
 * GitHub) del asset cuyo nombre contiene `fragment` (sin distinguir
 * mayúsculas/minúsculas).
 *
 * Si hay más de una coincidencia, se queda con la más corta (asumiendo
 * que es la más específica) y avisa por consola de las demás, en vez
 * de fallar o elegir al azar.
 */
async function resolveGithubReleaseAsset(fileField) {
  const { owner, repo, tag, fragment } = parseGithubReleaseRef(fileField);
  const assets = await _fetchReleaseAssets(owner, repo, tag);

  if (assets.length === 0) {
    throw new Error(`El release "${tag}" de ${owner}/${repo} no tiene ningún asset adjunto.`);
  }

  const needle = fragment.toLowerCase();
  const matches = assets.filter(a => a.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    const disponibles = assets.map(a => a.name).join(', ');
    throw new Error(
      `Ningún asset de ${owner}/${repo}@${tag} coincide con "${fragment}". ` +
      `Assets disponibles en ese release: ${disponibles}`
    );
  }

  if (matches.length > 1) {
    matches.sort((a, b) => a.name.length - b.name.length);
    console.warn(
      `[github-release-source] "${fragment}" coincide con ${matches.length} assets; ` +
      `usando "${matches[0].name}". Coincidencias: ${matches.map(m => m.name).join(', ')}`
    );
  }

  return matches[0];
}

/**
 * Construye la URL del proxy propio (api/github-asset.js) para un asset
 * de GitHub Release, en vez de devolver su browser_download_url tal
 * cual. Es NECESARIO: GitHub no manda cabeceras CORS en la descarga de
 * assets de Releases (ni en el redirect ni en el storage final), así
 * que un fetch() desde el navegador a esa URL SIEMPRE falla con
 * "blocked by CORS policy" -- no importa si el archivo existe y la URL
 * es exacta, el navegador ni siquiera deja leer la respuesta. Ver el
 * comentario completo en api/github-asset.js.
 */
function buildAssetProxyUrl(asset) {
  const params = new URLSearchParams({ url: asset.browser_download_url, name: asset.name });
  return `/api/github-asset?${params.toString()}`;
}

/**
 * Punto de entrada único usado por emulator.js y app.js:
 * dado game.file (sea local o github-release://...), devuelve la URL
 * final ya lista para pasar a fetch()/EJS_gameUrl. Si game.file no usa
 * el esquema github-release://, se devuelve tal cual sin tocar nada.
 */
async function resolveGameFileUrl(fileField) {
  if (!isGithubReleaseRef(fileField)) return fileField;
  const asset = await resolveGithubReleaseAsset(fileField);
  return buildAssetProxyUrl(asset);
}

/**
 * SOPORTE MULTI-ARCHIVO (cue+bin) -- por qué existe esta función
 * -----------------------------------------------------------------------
 * Un juego de PS1 con pistas de audio (o cualquier imagen de disco en
 * formato .cue) NO es un solo archivo: el .cue es un texto que referencia
 * uno o más .bin por su nombre EXACTO ("FILE "Nombre.bin" BINARY"). Si
 * solo servimos el .cue, el core (mednafen_psx / pcsx_rearmed) lo lee,
 * intenta abrir el .bin referenciado, no lo encuentra en el sistema de
 * archivos virtual del emulador, y falla en silencio o cae al menú
 * interno del core.
 *
 * Un Release de GitHub no permite "una carpeta" como asset: cada archivo
 * subido (el .cue, cada .bin) es un asset independiente con su propia
 * browser_download_url. Por eso game.file ahora puede ser tambien un
 * ARRAY de referencias (mezclando github-release://... y rutas locales
 * por igual), una por cada archivo que compone el juego:
 *
 *   "file": [
 *     "github-release://owner/repo@tag/Nombre.cue",
 *     "github-release://owner/repo@tag/Nombre.bin"
 *   ]
 *
 * resolveGameFileEntries() resuelve TODAS las referencias del array en
 * paralelo y devuelve, para cada una, { name, url }: `name` es el nombre
 * de archivo tal como debe existir dentro del sistema de archivos del
 * emulador (debe coincidir con lo que el .cue referencia internamente,
 * que en la inmensa mayoría de rips coincide con el propio nombre del
 * asset), y `url` es la browser_download_url real ya resuelta.
 *
 * emulator.js usa este resultado para decidir cuál de los archivos es el
 * "principal" (el .cue/.m3u/.ccd/.toc) -- ese va a EJS_gameUrl -- y monta
 * el resto como EJS_externalFiles, que EmulatorJS descarga y escribe en
 * su sistema de archivos virtual ANTES de arrancar el juego. Así, cuando
 * el core lee el .cue y busca el .bin, ya está ahí.
 */
async function resolveGameFileEntries(fileField) {
  const list = Array.isArray(fileField) ? fileField : [fileField];
  return Promise.all(list.map(async (ref) => {
    if (isGithubReleaseRef(ref)) {
      // El nombre real viene del propio asset reportado por la API de
      // GitHub (resolveGithubReleaseAsset), NO de la URL final: la URL
      // ahora es la del proxy (/api/github-asset?url=...&name=...), que
      // ya no termina en el nombre de archivo real.
      const asset = await resolveGithubReleaseAsset(ref);
      // asset.size (bytes, reportado por la propia API de GitHub) se
      // usa en emulator.js para calcular cuánto esperar antes de asumir
      // que el disco no cargó -- un .bin de PS1 puede pesar cientos de
      // MB, así que un timeout fijo pensado para ROMs pequeñas de
      // cartucho no vale aquí. Ver EJS_startTimeoutMs en emulator.js.
      return { name: asset.name, url: buildAssetProxyUrl(asset), size: asset.size, ref };
    }
    const name = decodeURIComponent(ref.split('/').pop().split('?')[0].split('#')[0]);
    // Los archivos locales (/games/...) van servidos desde el propio
    // dominio, sin proxy de por medio, así que no merece la pena hacer
    // un HEAD solo para conocer el tamaño: se trata como "desconocido"
    // y emulator.js aplica un timeout base generoso igualmente.
    return { name, url: ref, size: null, ref };
  }));
}

window.isGithubReleaseRef = isGithubReleaseRef;
window.resolveGameFileUrl = resolveGameFileUrl;
window.resolveGameFileEntries = resolveGameFileEntries;
