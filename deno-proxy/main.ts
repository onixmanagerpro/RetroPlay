/**
 * main.ts — Proxy de assets para RetroPlay, pensado para Deno Deploy.
 * -----------------------------------------------------------------------
 * Sustituye a api/github-asset.js y api/google-drive-asset.js (que corrían
 * como Edge Functions de Vercel). Hace exactamente lo mismo que esos dos
 * archivos, pero fuera de Vercel, para que el tráfico pesado de las
 * descargas (ROMs/discos, cientos de MB) no consuma la cuota de Vercel.
 *
 * Rutas:
 *   GET /github-asset?url=...&name=...   (antes: /api/github-asset)
 *   GET /google-drive-asset?id=...&name=... (antes: /api/google-drive-asset)
 *
 * Deploy: se sube tal cual a Deno Deploy (Playground o "New Project" con
 * este archivo como entry point). No requiere configuración adicional.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------
// GitHub Releases
// ---------------------------------------------------------------------

const ALLOWED_GITHUB_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/;

async function handleGithubAsset(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  const fileName = searchParams.get("name") || "";

  if (!targetUrl) return jsonError(400, 'Falta el parámetro "url".');
  if (!ALLOWED_GITHUB_URL.test(targetUrl)) {
    return jsonError(400, "Esta URL no es un asset de GitHub Releases válido.");
  }

  let upstream: Response;
  try {
    const range = request.headers.get("range");
    upstream = await fetch(targetUrl, {
      redirect: "follow",
      headers: range ? { Range: range } : {},
    });
  } catch (err) {
    return jsonError(502, `No se pudo contactar con GitHub: ${(err as Error).message}`);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonError(upstream.status, `GitHub respondió HTTP ${upstream.status} al descargar el asset.`);
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers.set("Content-Range", contentRange);
  headers.set("Accept-Ranges", "bytes");
  if (fileName) {
    headers.set("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
  }
  // Los assets de un Release ya publicado no cambian nunca -> cache agresivo.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------

const ALLOWED_DRIVE_ID = /^[a-zA-Z0-9_-]{10,100}$/;

function extractConfirmToken(html: string): string | null {
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

function directDownloadUrl(id: string, confirmToken?: string | null): string {
  const base = `https://drive.google.com/uc?export=download&id=${id}`;
  return confirmToken ? `${base}&confirm=${confirmToken}` : base;
}

async function handleGoogleDriveAsset(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const fileName = searchParams.get("name") || "";

  if (!id) return jsonError(400, 'Falta el parámetro "id".');
  if (!ALLOWED_DRIVE_ID.test(id)) {
    return jsonError(400, 'El "id" no tiene el formato de un ID de Google Drive válido.');
  }

  const range = request.headers.get("range");
  const rangeHeaders = range ? { Range: range } : {};

  let upstream: Response;
  try {
    upstream = await fetch(directDownloadUrl(id), { redirect: "follow", headers: rangeHeaders });
  } catch (err) {
    return jsonError(502, `No se pudo contactar con Google Drive: ${(err as Error).message}`);
  }

  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("text/html")) {
    let html: string;
    try {
      html = await upstream.text();
    } catch (err) {
      return jsonError(502, `No se pudo leer la respuesta de Google Drive: ${(err as Error).message}`);
    }

    const confirmToken = extractConfirmToken(html);
    if (!confirmToken) {
      return jsonError(
        403,
        `Google Drive no devolvió el archivo directamente y no se encontró ` +
          `token de confirmación en su respuesta. Comprueba que el archivo ` +
          `(ID: ${id}) tenga permiso "Cualquier usuario con el enlace: Lector".`,
      );
    }

    try {
      upstream = await fetch(directDownloadUrl(id, confirmToken), {
        redirect: "follow",
        headers: rangeHeaders,
      });
    } catch (err) {
      return jsonError(502, `No se pudo contactar con Google Drive (confirmación): ${(err as Error).message}`);
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonError(upstream.status, `Google Drive respondió HTTP ${upstream.status} al descargar el archivo.`);
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers.set("Content-Range", contentRange);
  headers.set("Accept-Ranges", "bytes");
  if (fileName) {
    headers.set("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
  }
  // Un archivo de Drive sí se puede reemplazar con el mismo ID -> sin cache agresivo.
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

Deno.serve((request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { pathname } = new URL(request.url);

  if (pathname === "/github-asset") return handleGithubAsset(request);
  if (pathname === "/google-drive-asset") return handleGoogleDriveAsset(request);

  return jsonError(404, `Ruta no encontrada: ${pathname}. Usa /github-asset o /google-drive-asset.`);
});
