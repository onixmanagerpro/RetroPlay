/**
 * api/github-asset.js
 * -----------------------------------------------------------------------
 * Proxy CORS para assets de GitHub Releases.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * -----------------------------------------------------------------------
 * GitHub NO envía cabeceras Access-Control-Allow-Origin en la descarga
 * de assets de un Release (ni en browser_download_url, ni en el asset
 * final tras la redirección a su storage). Esto es una limitación de la
 * plataforma de GitHub, no un bug nuestro: un fetch() desde el navegador
 * a "github.com/OWNER/REPO/releases/download/TAG/archivo" SIEMPRE falla
 * con "blocked by CORS policy", lo hayas escrito bien o mal, cargues un
 * archivo o varios. Solo funciona la navegación directa (clic en un
 * enlace <a href>), que es para lo que GitHub diseñó esa URL.
 *
 * EmulatorJS (vendor/emulatorjs/emulator.min.js) descarga EJS_gameUrl y
 * EJS_externalFiles con fetch() desde dentro del iframe del emulador, así
 * que sin este proxy NUNCA van a poder cargar bytes de un asset de
 * GitHub Release, por más que la URL resuelta sea 100% correcta.
 *
 * QUÉ HACE
 * -----------------------------------------------------------------------
 * Recibe la browser_download_url REAL (ya resuelta vía la API de GitHub
 * en js/github-release-source.js -- este endpoint no busca ni adivina
 * nada, solo relay), la pide desde el servidor (donde no hay CORS
 * porque no es una petición de navegador) y devuelve los bytes con
 * Access-Control-Allow-Origin: * añadido.
 *
 * Corre en el Edge Runtime de Vercel (no el runtime Node clásico) a
 * propósito: los archivos de disco de PS1 pesan 300-700MB+, y las
 * funciones Node "serverless" clásicas de Vercel tienen un límite de
 * payload de respuesta pensado para APIs ligeras. El Edge Runtime deja
 * hacer streaming del cuerpo de la respuesta tal cual llega de GitHub,
 * sin cargarlo entero en memoria primero.
 *
 * SEGURIDAD: solo se permite hacer de proxy hacia
 * github.com/*\/*\/releases/download/*, para que esto no se pueda usar
 * como proxy CORS genérico hacia cualquier URL arbitraria.
 */

export const config = { runtime: 'edge' };

const ALLOWED_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/;

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

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');
  const fileName = searchParams.get('name') || '';

  if (!targetUrl) {
    return jsonError(400, 'Falta el parámetro "url".');
  }
  if (!ALLOWED_URL_PATTERN.test(targetUrl)) {
    // Bloqueado a propósito: este proxy solo debe poder alcanzar assets
    // de Releases de GitHub, nunca URLs arbitrarias.
    return jsonError(400, 'Esta URL no es un asset de GitHub Releases válido.');
  }

  let upstream;
  try {
    // Reenviamos el header Range si el cliente lo pide (EmulatorJS o el
    // propio navegador pueden pedir un rango al hacer scrubbing/seek en
    // archivos grandes ya cacheados). GitHub lo soporta de forma nativa.
    const range = request.headers.get('range');
    upstream = await fetch(targetUrl, {
      redirect: 'follow',
      headers: range ? { Range: range } : {},
    });
  } catch (err) {
    return jsonError(502, `No se pudo contactar con GitHub: ${err.message}`);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonError(upstream.status, `GitHub respondió HTTP ${upstream.status} al descargar el asset.`);
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
  // Los assets de un Release ya publicado no cambian nunca (para
  // cambiarlos habría que subir un asset nuevo con otro nombre), así
  // que cachear agresivamente en el CDN de Vercel es seguro y evita
  // volver a pedirle el archivo a GitHub en cada partida.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  // El body de `upstream` es un ReadableStream: lo devolvemos tal cual,
  // sin bufferearlo en memoria, para que archivos de cientos de MB
  // puedan fluir directo de GitHub al navegador a través de esta función.
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
