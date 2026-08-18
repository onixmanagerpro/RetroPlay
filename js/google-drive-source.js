/**
 * Cargador directo de archivos públicos de Google Drive.
 *
 * Los bytes se solicitan desde el navegador y nunca pasan por Vercel. Para
 * juegos de PS1 se descarga primero el CUE, se leen sus líneas FILE y sólo se
 * obtienen los BIN declarados en el manifiesto del catálogo.
 */

const GOOGLE_DRIVE_SOURCE = 'google-drive';
const GOOGLE_DRIVE_API_ORIGIN = 'https://www.googleapis.com/drive/v3/files';

function isGoogleDriveGameSource(fileField) {
  return !!fileField &&
    !Array.isArray(fileField) &&
    typeof fileField === 'object' &&
    fileField.source === GOOGLE_DRIVE_SOURCE;
}

function buildGoogleDriveDownloadUrl(fileId) {
  if (typeof fileId !== 'string' || !fileId.trim()) {
    throw new Error('Falta el identificador de un archivo de Google Drive.');
  }

  const apiKey = String(window.RETROPLAY_GOOGLE_DRIVE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Falta configurar la clave de Google Drive. Añádela en js/google-drive-config.js.'
    );
  }

  const params = new URLSearchParams({ alt: 'media', key: apiKey });
  return `${GOOGLE_DRIVE_API_ORIGIN}/${encodeURIComponent(fileId.trim())}?${params.toString()}`;
}

function normalizeCuePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function readCueFileReferences(cueText) {
  const references = [];
  // El primer grupo cubre nombres entre comillas (incluidos espacios); el
  // segundo mantiene compatibilidad con CUE sin comillas.
  const fileLine = /^\s*FILE\s+(?:"([^"]+)"|([^\s]+))\s+(?:BINARY|MOTOROLA|AIFF|WAVE|MP3)\b/gim;
  let match;

  while ((match = fileLine.exec(cueText)) !== null) {
    const name = match[1] || match[2];
    if (name && !references.includes(name)) references.push(name);
  }

  if (references.length === 0) {
    throw new Error('El archivo .cue no contiene ninguna línea FILE compatible.');
  }

  return references;
}

function validateDriveEntry(entry, label) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !entry.id || !entry.name) {
    throw new Error(`La entrada ${label} de Google Drive debe incluir "id" y "name".`);
  }
  return { id: entry.id, name: entry.name };
}

async function fetchGoogleDriveBlob(entry, { signal } = {}) {
  const url = buildGoogleDriveDownloadUrl(entry.id);
  let response;

  try {
    response = await fetch(url, {
      signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(
      `No se pudo obtener "${entry.name}" directamente desde Google Drive. ` +
      'Comprueba que el archivo sea público y que la clave esté restringida a este sitio y a Google Drive API.'
    );
  }

  if (!response.ok) {
    throw new Error(`Google Drive respondió HTTP ${response.status} al cargar "${entry.name}".`);
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error(`Google Drive devolvió "${entry.name}" vacío.`);
  }

  return {
    name: entry.name,
    blob,
    size: blob.size,
    mimeType: blob.type || 'application/octet-stream'
  };
}

/**
 * Descarga en memoria un juego definido así:
 *
 * {
 *   source: 'google-drive',
 *   cue: { id: '...', name: 'Juego.cue' },
 *   files: [{ id: '...', name: 'Nombre literal que referencia el CUE.bin' }]
 * }
 */
async function loadGoogleDriveGameFiles(fileField, { signal, onProgress } = {}) {
  if (!isGoogleDriveGameSource(fileField)) {
    throw new Error('La fuente del juego no es una configuración de Google Drive válida.');
  }

  const cueEntry = validateDriveEntry(fileField.cue, 'cue');
  const fileEntries = Array.isArray(fileField.files)
    ? fileField.files.map((entry, index) => validateDriveEntry(entry, `files[${index}]`))
    : [];

  onProgress?.('Obteniendo el archivo .cue desde Google Drive…');
  const main = await fetchGoogleDriveBlob(cueEntry, { signal });
  const cueText = await main.blob.text();
  const cueReferences = readCueFileReferences(cueText);

  const entriesByName = new Map();
  for (const entry of fileEntries) {
    const key = normalizeCuePath(entry.name);
    if (entriesByName.has(key)) {
      throw new Error(`Hay dos archivos de Google Drive con el mismo nombre: "${entry.name}".`);
    }
    entriesByName.set(key, entry);
  }

  const companionsToLoad = cueReferences.map((cueName) => {
    const entry = entriesByName.get(normalizeCuePath(cueName));
    if (!entry) {
      throw new Error(
        `El .cue referencia "${cueName}", pero no existe una entrada con ese nombre en files.`
      );
    }
    // mountedName es el texto exacto del CUE, no una versión normalizada.
    return { ...entry, mountedName: cueName };
  });

  const companions = [];
  for (let index = 0; index < companionsToLoad.length; index++) {
    const entry = companionsToLoad[index];
    onProgress?.(`Cargando archivo ${index + 1} de ${companionsToLoad.length}: ${entry.name}…`);
    const file = await fetchGoogleDriveBlob(entry, { signal });
    companions.push({ ...file, mountedName: entry.mountedName });
  }

  const assets = {
    main,
    companions,
    totalBytes: main.size + companions.reduce((sum, entry) => sum + entry.size, 0),
    release() {
      // Las URLs blob y el File del iframe siguen siendo responsables de los
      // bytes que el emulador está usando. Aquí se eliminan sólo referencias
      // de este cargador cuando ya no hacen falta.
      this.main.blob = null;
      this.companions.forEach((entry) => { entry.blob = null; });
      this.companions.length = 0;
    }
  };

  return assets;
}

window.isGoogleDriveGameSource = isGoogleDriveGameSource;
window.loadGoogleDriveGameFiles = loadGoogleDriveGameFiles;
