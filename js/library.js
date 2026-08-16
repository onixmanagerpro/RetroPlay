/**
 * library.js
 * -----------------------------------------------------------------------
 * Capa de datos de RetroPlay.
 *
 * Carga data/games.json (el "sistema de datos" pedido en el brief) y
 * expone utilidades de búsqueda / filtrado / ordenación sobre él, además
 * de helpers para construir el HTML de las tarjetas de juego.
 *
 * Para añadir un juego nuevo: basta con añadir un objeto más al array
 * "games" de data/games.json siguiendo el esquema documentado ahí mismo.
 * No hace falta tocar ningún archivo .js.
 * -----------------------------------------------------------------------
 */

const PLAYABLE_CONSOLES = [
  { id: 'SNES', label: 'Super Nintendo', short: 'SNES', color: 'var(--c-snes)', emulatorModule: 'snes' },
  { id: 'Mega Drive', label: 'Sega Mega Drive', short: 'Mega Drive', color: 'var(--c-megadrive)', emulatorModule: 'megadrive' },
  { id: 'Nintendo 64', label: 'Nintendo 64', short: 'N64', color: 'var(--c-n64)', emulatorModule: 'n64' },
  { id: 'Dreamcast', label: 'Sega Dreamcast', short: 'Dreamcast', color: 'var(--c-dreamcast)', emulatorModule: 'dreamcast' },
  { id: 'PS1', label: 'PlayStation 1', short: 'PS1', color: 'var(--c-ps1)', emulatorModule: 'ps1' },
  { id: 'GBA', label: 'Game Boy Advance', short: 'GBA', color: 'var(--accent-amber)', emulatorModule: 'gba' }
];

const DOWNLOAD_CONSOLES = [
  { id: 'PS2', label: 'PlayStation 2', short: 'PS2', color: 'var(--c-ps2)' },
  { id: 'PS3', label: 'PlayStation 3', short: 'PS3', color: 'var(--c-ps3)' },
  { id: 'PS4', label: 'PlayStation 4', short: 'PS4', color: 'var(--c-ps4)' }
];

class GameLibrary {
  constructor() {
    this.games = [];
    this._loaded = false;
    this._loadPromise = null;
  }

  async load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      try {
        const res = await fetch('data/games.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        this.games = json.games || [];
        this._loaded = true;
      } catch (err) {
        console.error('[library] No se pudo cargar data/games.json', err);
        this.games = [];
        this._loaded = true;
      }
      return this.games;
    })();
    return this._loadPromise;
  }

  isLoaded() { return this._loaded; }

  getById(id) {
    return this.games.find(g => g.id === id) || null;
  }

  getByConsole(consoleId) {
    return this.games.filter(g => g.console === consoleId);
  }

  getPlayable() {
    return this.games.filter(g => g.type === 'browser');
  }

  getDownloadable() {
    return this.games.filter(g => g.type === 'download');
  }

  getGenres() {
    return [...new Set(this.games.map(g => g.genre))].sort();
  }

  getConsolesPresent(type = null) {
    const pool = type ? this.games.filter(g => g.type === type) : this.games;
    return [...new Set(pool.map(g => g.console))];
  }

  countByConsole(consoleId) {
    return this.games.filter(g => g.console === consoleId).length;
  }

  /**
   * Búsqueda + filtros + orden combinados. Se usa tanto en el buscador
   * global como en la vista de biblioteca.
   */
  query({ term = '', console: consoleFilter = 'all', genre = 'all', type = null, sort = 'name-asc', ids = null } = {}) {
    let results = this.games;

    if (ids) {
      const idSet = new Set(ids);
      results = results.filter(g => idSet.has(g.id));
    }

    if (type) results = results.filter(g => g.type === type);
    if (consoleFilter && consoleFilter !== 'all') results = results.filter(g => g.console === consoleFilter);
    if (genre && genre !== 'all') results = results.filter(g => g.genre === genre);

    if (term && term.trim()) {
      const q = term.trim().toLowerCase();
      results = results.filter(g =>
        g.name.toLowerCase().includes(q) ||
        g.console.toLowerCase().includes(q) ||
        g.genre.toLowerCase().includes(q) ||
        (g.developer && g.developer.toLowerCase().includes(q))
      );
    }

    // Juegos sin "year" (p.ej. la mayoría de SNES/N64/PS1 del catálogo) no
    // deben quedar fuera de los sorts por year-asc/year-desc: al restar
    // undefined - undefined el resultado es NaN, y Array.prototype.sort
    // trata NaN como "iguales" (no reordena), así que esas entradas se
    // quedaban ancladas en su posición original dentro del array en vez
    // de mezclarse correctamente con el resto. Usamos un valor por
    // defecto explícito en vez de dejar que la resta produzca NaN.
    const yearOrDefault = (g, fallback) => (typeof g.year === 'number' ? g.year : fallback);

    results = [...results].sort((a, b) => {
      switch (sort) {
        case 'name-asc': return a.name.localeCompare(b.name, 'es');
        case 'name-desc': return b.name.localeCompare(a.name, 'es');
        // Sin year -> se consideran "el más antiguo posible" (-Infinity)
        // para que no salgan primero en year-asc.
        case 'year-asc': return yearOrDefault(a, -Infinity) - yearOrDefault(b, -Infinity);
        // Sin year -> se consideran "el más reciente" (+Infinity) para
        // que SÍ puedan aparecer en "recién añadidos" en vez de quedar
        // silenciosamente excluidos por un NaN.
        case 'year-desc': return yearOrDefault(b, Infinity) - yearOrDefault(a, Infinity);
        default: return 0;
      }
    });

    return results;
  }

  static consoleMeta(consoleId) {
    return PLAYABLE_CONSOLES.find(c => c.id === consoleId) || DOWNLOAD_CONSOLES.find(c => c.id === consoleId) || null;
  }
}

// ===========================================================================
// Helpers de renderizado — generan el HTML de las tarjetas reutilizadas
// en home / biblioteca / vistas de consola / descargas.
// ===========================================================================

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Aplica `renderFn` a cada elemento de `items` y concatena el resultado,
 * pero si una tarjeta concreta lanza una excepción (portada corrupta,
 * campo inesperado, etc.) la omite y sigue con el resto en vez de dejar
 * toda la cuadrícula en blanco. Se usa en cada .map() de tarjetas de
 * app.js para que un dato problemático nunca tumbe una sección completa.
 */
function safeRenderList(items, renderFn) {
  const html = [];
  for (const item of items) {
    try {
      html.push(renderFn(item));
    } catch (err) {
      console.error('[render] Se omitió una tarjeta por error de renderizado', item?.id, err);
    }
  }
  return html.join('');
}

function coverOrFallback(game) {
  const meta = GameLibrary.consoleMeta(game.console);
  const color = meta ? meta.color : 'var(--accent-amber)';
  const initialsSource = (meta && meta.short) || game.console || '??';
  const initials = initialsSource.slice(0, 4).toUpperCase();
  return `
    <div class="cover-fallback" style="--card-console-color:${color}">
      <span class="cover-fallback-glyph">${escapeHtml(initials)}</span>
      <span class="cover-fallback-name">${escapeHtml(game.name)}</span>
    </div>
  `;
}

/**
 * Manejador global de error de portada, referenciado desde el atributo
 * onerror="" de cada <img> de tarjeta. Se expone en window en vez de
 * construirse como string inline: intentar escapar HTML/backticks
 * anidados dentro de un atributo onerror es fuente segura de bugs de
 * renderizado (comillas rotas, contenido volcado como texto plano).
 * Aquí simplemente recibe el elemento y el id del juego, y sustituye
 * la imagen rota por el fallback con iniciales de consola.
 */
function handleCoverError(imgEl, gameId) {
  const game = gameLibrary.getById(gameId);
  if (!game || !imgEl || !imgEl.parentElement) return;
  imgEl.parentElement.innerHTML = coverOrFallback(game);
}
window.handleCoverError = handleCoverError;

/**
 * Tarjeta de juego estándar (grid de biblioteca / consola / descargas destacadas).
 */
function renderGameCard(game, { favoriteIds = new Set() } = {}) {
  const meta = GameLibrary.consoleMeta(game.console);
  const color = meta ? meta.color : 'var(--accent-amber)';
  const isFav = favoriteIds.has(game.id);
  const typeLabel = game.type === 'download' ? 'Descarga' : 'Jugable';

  return `
    <article class="game-card" data-game-id="${escapeHtml(game.id)}" tabindex="0" role="button" aria-label="Abrir ficha de ${escapeHtml(game.name)}">
      <div class="game-card-cover">
        <img src="${escapeHtml(game.cover)}" alt="Portada de ${escapeHtml(game.name)}" loading="lazy"
             onerror="handleCoverError(this, '${escapeHtml(game.id)}')" />
        <span class="console-sticker" style="--card-console-color:${color}; background:${color};">${escapeHtml(meta ? meta.short : game.console)}</span>
        <button class="game-card-favorite ${isFav ? 'is-active' : ''}" data-fav-toggle="${escapeHtml(game.id)}" aria-label="${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}" aria-pressed="${isFav}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="m12 21-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21Z"/></svg>
        </button>
        <span class="game-card-type-badge type-${game.type}">${typeLabel}</span>
        <div class="game-card-overlay">
          <span class="game-card-play-hint">
            ${game.type === 'download'
              ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Descargar'
              : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Jugar'}
          </span>
        </div>
      </div>
      <div class="game-card-body">
        <h3 class="game-card-title">${escapeHtml(game.name)}</h3>
        <div class="game-card-meta">
          <span>${escapeHtml(game.genre)}</span>
        </div>
      </div>
    </article>
  `;
}

function renderGameCardSkeleton() {
  return `<div class="skeleton skeleton-card"></div>`;
}

/**
 * Tarjeta de consola (usada en home y en la vista "Jugar online").
 */
function renderConsoleTile(consoleMeta, count) {
  return `
    <a href="#/console/${encodeURIComponent(consoleMeta.id)}" class="console-tile" style="--tile-color:${consoleMeta.color}" data-console-tile="${escapeHtml(consoleMeta.id)}">
      <div>
        <div class="console-tile-badge" style="--tile-color:${consoleMeta.color}">${escapeHtml(consoleMeta.short || consoleMeta.id)}</div>
        <div class="console-tile-name">${escapeHtml(consoleMeta.label)}</div>
      </div>
      <div class="console-tile-count">${count} ${count === 1 ? 'juego' : 'juegos'}</div>
    </a>
  `;
}

/**
 * Fila horizontal de "Continuar jugando".
 */
function renderContinueCard(game, progressPct) {
  return `
    <div class="continue-card" data-game-id="${escapeHtml(game.id)}" data-action="resume" role="button" tabindex="0" aria-label="Continuar ${escapeHtml(game.name)}">
      <div class="continue-card-cover">
        <img src="${escapeHtml(game.cover)}" alt="" loading="lazy" onerror="this.style.display='none'" />
        <div class="continue-play-btn">
          <span class="continue-play-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
        </div>
        <div class="continue-progress"><div class="continue-progress-fill" style="width:${Math.min(100, Math.max(4, progressPct))}%"></div></div>
      </div>
      <div class="continue-card-body">
        <div class="continue-card-title">${escapeHtml(game.name)}</div>
        <div class="continue-card-sub">${escapeHtml(game.console)}</div>
      </div>
    </div>
  `;
}

/**
 * Fila de descarga (vista Descargas).
 */
function renderDownloadCard(game) {
  const meta = GameLibrary.consoleMeta(game.console);
  const color = meta ? meta.color : 'var(--accent-amber)';
  return `
    <article class="download-card" data-game-id="${escapeHtml(game.id)}">
      <div class="download-card-cover">
        <img src="${escapeHtml(game.cover)}" alt="Portada de ${escapeHtml(game.name)}" loading="lazy"
             onerror="handleCoverError(this, '${escapeHtml(game.id)}')" />
      </div>
      <div class="download-card-info">
        <h3 class="download-card-title">${escapeHtml(game.name)}</h3>
        <div class="download-card-meta">
          <span style="color:${color}">${escapeHtml(game.console)}</span>
          <span>${escapeHtml(game.genre)}</span>
        </div>
        <p class="download-card-desc">${escapeHtml(game.description || '')}</p>
      </div>
      <div class="download-card-actions">
        <span class="download-size-tag">${escapeHtml(game.size || '—')}</span>
        <button class="btn btn-primary btn-sm" data-download-trigger="${escapeHtml(game.id)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Descargar
        </button>
      </div>
    </article>
  `;
}

// Instancia global — un único catálogo cargado una vez.
const gameLibrary = new GameLibrary();
