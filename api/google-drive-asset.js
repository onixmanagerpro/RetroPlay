/**
 * api/google-drive-asset.js
 * -----------------------------------------------------------------------
 * Proxy CORS + resolución de confirmación para archivos de Google Drive.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * -----------------------------------------------------------------------
 * Drive no manda cabeceras Access-Control-Allow-Origin al descargar un
 * archivo (igual que GitHub Releases -- ver api/github-asset.js), así
 * que un fetch() desde dentro del iframe del emulador SIEMPRE falla con
 * "blocked by CORS policy" si se apunta directo a drive.google.com.
 *
 * A eso se suma un problema propio de Drive: para archivos grandes
 * (todos los .bin/.cue de este proyecto lo son), la URL de descarga
 * directa
 *
 *   https://drive.google.com/uc?export=download&id={ID}
 *
 * NO devuelve el archivo. Devuelve una página HTML de aviso ("Google
 * Drive no puede escanear este archivo en busca de virus") con un
 * formulario que incluye un token de confirmación distinto cada vez.
 * Sin reenviar ese token en una segunda petición, nunca se llega a los
 * bytes reales -- el core del emulador terminaría intentando cargar un
 * HTML de unos pocos KB como si fuera una imagen de disco de 700MB.
 *
 * QUÉ HACE
 * -----------------------------------------------------------------------
 * 1. Pide la URL de descarga directa.
 * 2. Si la respuesta es HTML (no el archivo), extrae el token de
 *    confirmación del cuerpo y repite la petición añadiéndolo.
 * 3. Devuelve el stream de bytes real al navegador, con
 *    Access-Control-Allow-Origin añadido y soporte de Range para que
 *    EmulatorJS pueda hacer seek en archivos ya cargados.
 *
 * Corre en el Edge Runtime de Vercel por el mismo motivo que
 * api/github-asset.js: los .bin de PS1 pesan cientos de MB y hace falta
 * poder hacer streaming del cuerpo sin cargarlo entero en memoria.
 *
 * SEGURIDAD: el parámetro `id` se valida como un ID de Drive plausible
 * (solo letras, números, guiones y guion bajo) antes de usarlo para
 * construir la URL saliente, así este endpoint no se puede convertir en
 * un proxy genérico hacia cualquier URL arbitraria.
 */

export const config = { runtime: 'edge' };

const ALLOWED_ID_PATTERN = /^[a-zA-Z0-9_-]{10,100}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
};

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Extrae el token "confirm=XXXX" del HTML de aviso de Drive. El HTML
 * exacto ha cambiado de forma varias veces a lo largo de los años, así
 * que se prueban varios patrones conocidos en vez de confiar en uno solo.
 */
function extractConfirmToken(html) {
  const patterns = [
    /confirm=([0-9A-Za-z_-]+)&/,
    /name="confirm"\s+value="([0-9A-Za-z_-]+)"/,
    /confirm=([0-9A-Za-z_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function directDownloadUrl(id, confirmToken) {
  const base = `https://drive.google.com/uc?export=download&id=${id}`;
  return confirmToken ? `${base}&confirm=${confirmToken}` : base;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const fileName = searchParams.get('name') || '';

  if (!id) {
    return jsonError(400, 'Falta el parámetro "id".');
  }
  if (!ALLOWED_ID_PATTERN.test(id)) {
    // Bloqueado a propósito: evita que este endpoint se use para pedir
    // algo que no sea un ID de archivo de Drive con pinta razonable.
    return jsonError(400, 'El "id" no tiene el formato de un ID de Google Drive válido.');
  }

  const range = request.headers.get('range');
  const rangeHeaders = range ? { Range: range } : {};

  let upstream;
  try {
    upstream = await fetch(directDownloadUrl(id), {
      redirect: 'follow',
      headers: rangeHeaders,
    });
  } catch (err) {
    return jsonError(502, `No se pudo contactar con Google Drive: ${err.message}`);
  }

  const contentType = upstream.headers.get('content-type') || '';

  // Si Drive respondió con la página de aviso (HTML) en vez del
  // archivo, hay que extraer el token de confirmación y reintentar.
  if (contentType.includes('text/html')) {
    let html;
    try {
      html = await upstream.text();
    } catch (err) {
      return jsonError(502, `No se pudo leer la respuesta de Google Drive: ${err.message}`);
    }

    const confirmToken = extractConfirmToken(html);
    if (!confirmToken) {
      // Si no hay token que extraer, lo más probable es que el archivo
      // no sea público ("Cualquier usuario con el enlace: Lector") o
      // que el ID no exista -- se lo decimos claro a quien lo lea en la
      // consola/toast en vez de un error genérico.
      return jsonError(
        403,
        `Google Drive no devolvió el archivo directamente y no se encontró ` +
        `token de confirmación en su respuesta. Comprueba que el archivo ` +
        `(ID: ${id}) tenga permiso "Cualquier usuario con el enlace: Lector".`
      );
    }

    try {
      upstream = await fetch(directDownloadUrl(id, confirmToken), {
        redirect: 'follow',
        headers: rangeHeaders,
      });
    } catch (err) {
      return jsonError(502, `No se pudo contactar con Google Drive (confirmación): ${err.message}`);
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonError(upstream.status, `Google Drive respondió HTTP ${upstream.status} al descargar el archivo.`);
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) headers.set('Content-Length', contentLength);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers.set('Content-Range', contentRange);
  headers.set('Accept-Ranges', 'bytes');
  if (fileName) {
    headers.set('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);
  }
  // A diferencia de un asset de GitHub Release (inmutable por diseño),
  // un archivo de Drive SÍ se puede reemplazar manteniendo el mismo ID,
  // así que aquí NO se cachea de forma agresiva/permanente.
  headers.set('Cache-Control', 'private, max-age=3600');

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
