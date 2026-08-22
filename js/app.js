/**
 * app.js
 * -----------------------------------------------------------------------
 * Orquestador principal de RetroPlay: enrutador hash, renderizado de
 * vistas y wiring de todos los eventos de UI. Consume gameLibrary
 * (library.js), retroStorage (storage.js), gamepadManager (gamepad.js)
 * y emulatorController (emulator.js).
 * -----------------------------------------------------------------------
 */

const state = {
  favoriteIds: new Set(),
  currentGameId: null,
  library: {
    tab: 'all',
    console: 'all',
    genre: 'all',
    sort: 'name-asc',
    term: ''
  },
  downloadsConsole: 'all',
  remapTarget: null
};

// ===========================================================================
// Router
// ===========================================================================
const routes = {
  home: () => showView('home'),
  library: () => showView('library'),
  play: () => showView('play'),
  downloads: () => showView('downloads'),
  console: (consoleId) => openConsoleView(consoleId),
  'gamepad-config': () => showView('gamepad-config')
};

function parseHash() {
  const raw = location.hash.replace(/^#\//, '') || 'home';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart || '');
  return { root: segments[0] || 'home', arg: segments[1] ? decodeURIComponent(segments[1]) : null, params };
}

function handleRoute() {
  const { root, arg, params } = parseHash();
  updateActiveNav(root);

  if (root === 'library') {
    if (params.get('filter') === 'favorites') state.library.tab = 'favorites';
    if (params.get('sort') === 'recent') state.library.sort = 'recent';
  }

  if (routes[root]) {
    routes[root](arg);
  } else {
    showView('home');
  }
}

function updateActiveNav(root) {
  document.querySelectorAll('[data-nav]').forEach(el => {
    const match = el.dataset.nav === root || (root === 'console' && el.dataset.nav === 'play');
    el.classList.toggle('is-active', match);
  });
}

function navigateTo(hash) {
  location.hash = hash;
}

// ===========================================================================
// Vistas
// ===========================================================================
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.add('is-active');

  if (name === 'home') renderHome();
  if (name === 'library') renderLibraryView();
  if (name === 'play') renderPlayView();
  if (name === 'downloads') renderDownloadsView();
  if (name === 'gamepad-config') renderGamepadConfigView();

  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// ---------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------
async function renderHome() {
  // Cada sección se aísla en su propio try/catch: un fallo puntual (portada
  // rota, dato faltante en una tarjeta) no debe tumbar las secciones
  // hermanas ni dejar la página a medio renderizar.

  try {
    const homeConsoleGrid = document.getElementById('home-console-grid');
    homeConsoleGrid.innerHTML = PLAYABLE_CONSOLES.map(c =>
      renderConsoleTile(c, gameLibrary.countByConsole(c.id))
    ).join('');
  } catch (err) {
    console.error('[home] Error renderizando consolas jugables', err);
  }

  try {
    const recentlyPlayed = await retroStorage.getRecentlyPlayed(8);
    const continueSection = document.getElementById('continue-section');
    const continueRow = document.getElementById('continue-row');
    if (recentlyPlayed.length > 0) {
      const cards = recentlyPlayed
        .map(rp => {
          const game = gameLibrary.getById(rp.gameId);
          return game ? renderContinueCard(game, rp.progressPct || 10) : '';
        })
        .filter(Boolean);
      if (cards.length) {
        continueRow.innerHTML = cards.join('');
        continueSection.hidden = false;
      } else {
        continueSection.hidden = true;
      }
    } else {
      continueSection.hidden = true;
    }
  } catch (err) {
    console.error('[home] Error renderizando "Continuar jugando"', err);
  }

  try {
    const favSection = document.getElementById('favorites-section');
    const favGrid = document.getElementById('favorites-grid');
    const favIds = await retroStorage.getFavoriteIds();
    if (favIds.length > 0) {
      const favGames = gameLibrary.query({ ids: favIds }).slice(0, 6);
      favGrid.innerHTML = safeRenderList(favGames, g => renderGameCard(g, { favoriteIds: state.favoriteIds }));
      favSection.hidden = false;
    } else {
      favSection.hidden = true;
    }
  } catch (err) {
    console.error('[home] Error renderizando favoritos', err);
  }

  try {
    const recentAdded = gameLibrary.query({ sort: 'recent' }).slice(0, 6);
    document.getElementById('recent-added-grid').innerHTML =
      safeRenderList(recentAdded, g => renderGameCard(g, { favoriteIds: state.favoriteIds }));
  } catch (err) {
    console.error('[home] Error renderizando "Recién añadidos"', err);
  }

  try {
    const downloads = gameLibrary.getDownloadable().slice(0, 6);
    document.getElementById('home-downloads-grid').innerHTML =
      safeRenderList(downloads, g => renderGameCard(g, { favoriteIds: state.favoriteIds }));
  } catch (err) {
    console.error('[home] Error renderizando descargas destacadas', err);
  }
}

// ---------------------------------------------------------------------
// BIBLIOTECA
// ---------------------------------------------------------------------
function populateLibraryFilters() {
  const consoleSelect = document.getElementById('filter-console');
  const genreSelect = document.getElementById('filter-genre');

  const consoles = gameLibrary.getConsolesPresent();
  consoleSelect.innerHTML = '<option value="all">Todas</option>' +
    consoles.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  const genres = gameLibrary.getGenres();
  genreSelect.innerHTML = '<option value="all">Todos</option>' +
    genres.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');

  consoleSelect.value = state.library.console;
  genreSelect.value = state.library.genre;
  document.getElementById('filter-sort').value = state.library.sort;
  document.getElementById('library-search-input').value = state.library.term;
}

async function renderLibraryView() {
  populateLibraryFilters();

  document.querySelectorAll('#library-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.tab === state.library.tab);
  });

  let ids = null;
  let countLabel = 'Todos los juegos';

  if (state.library.tab === 'favorites') {
    ids = await retroStorage.getFavoriteIds();
    countLabel = 'Favoritos';
  } else if (state.library.tab === 'recent') {
    const recent = await retroStorage.getRecentlyPlayed(50);
    ids = recent.map(r => r.gameId);
    countLabel = 'Jugados recientemente';
  }

  const results = gameLibrary.query({
    term: state.library.term,
    console: state.library.console,
    genre: state.library.genre,
    sort: state.library.sort,
    ids
  });

  document.getElementById('library-count-label').textContent =
    `${countLabel} · ${results.length} ${results.length === 1 ? 'resultado' : 'resultados'}`;

  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');

  if (results.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
  } else {
    empty.hidden = true;
    grid.innerHTML = safeRenderList(results, g => renderGameCard(g, { favoriteIds: state.favoriteIds }));
  }
}

// ---------------------------------------------------------------------
// JUGAR ONLINE (selector de consolas)
// ---------------------------------------------------------------------
function renderPlayView() {
  const grid = document.getElementById('play-console-grid');
  grid.innerHTML = PLAYABLE_CONSOLES.map(c =>
    renderConsoleTile(c, gameLibrary.countByConsole(c.id))
  ).join('');
}

// ---------------------------------------------------------------------
// BIBLIOTECA DE UNA CONSOLA
// ---------------------------------------------------------------------
function openConsoleView(consoleId) {
  const meta = PLAYABLE_CONSOLES.find(c => c.id === consoleId);
  if (!meta) {
    navigateTo('#/play');
    return;
  }

  showView('console');

  document.getElementById('console-view-title').textContent = meta.label;
  document.getElementById('console-view-eyebrow').textContent = 'Jugar online';
  const count = gameLibrary.countByConsole(consoleId);
  document.getElementById('console-view-subtitle').textContent =
    `${count} ${count === 1 ? 'juego disponible' : 'juegos disponibles'} para emulación en navegador.`;

  const games = gameLibrary.getByConsole(consoleId);
  const grid = document.getElementById('console-game-grid');

  if (games.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="6" width="20" height="12" rx="4"/></svg>
        <p class="empty-state-title">Todavía no hay juegos aquí</p>
        <p class="empty-state-desc">Añade uno nuevo en data/games.json con "console": "${escapeHtml(consoleId)}" y aparecerá automáticamente.</p>
      </div>
    `;
  } else {
    grid.innerHTML = safeRenderList(games, g => renderGameCard(g, { favoriteIds: state.favoriteIds }));
  }
}

// ---------------------------------------------------------------------
// DESCARGAS
// ---------------------------------------------------------------------
function renderDownloadsView() {
  document.querySelectorAll('#downloads-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.console === state.downloadsConsole);
  });

  const games = state.downloadsConsole === 'all'
    ? gameLibrary.getDownloadable()
    : gameLibrary.getDownloadable().filter(g => g.console === state.downloadsConsole);

  const list = document.getElementById('downloads-list');
  if (games.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        <p class="empty-state-title">Sin descargas en esta consola todavía</p>
        <p class="empty-state-desc">Añade un juego con "type": "download" en data/games.json y aparecerá aquí.</p>
      </div>
    `;
  } else {
    list.innerHTML = safeRenderList(games, renderDownloadCard);
  }
}

// ===========================================================================
// FICHA DE JUEGO (modal)
// ===========================================================================
function openGameModal(gameId) {
  const game = gameLibrary.getById(gameId);
  if (!game) return;
  state.currentGameId = gameId;

  const meta = GameLibrary.consoleMeta(game.console);
  const color = meta ? meta.color : 'var(--accent-amber)';

  document.getElementById('game-modal-title').textContent = game.name;
  document.getElementById('game-modal-desc').textContent = game.description || '';

  const sizeBlock = document.getElementById('game-modal-size-block');
  if (game.size) {
    sizeBlock.hidden = false;
    document.getElementById('game-modal-size').textContent = game.size;
  } else {
    sizeBlock.hidden = true;
  }

  document.getElementById('game-modal-cover').innerHTML = `
    <img src="${escapeHtml(game.cover)}" alt="Portada de ${escapeHtml(game.name)}"
         onerror="handleCoverError(this, '${escapeHtml(game.id)}')" />
  `;

  document.getElementById('game-modal-tags').innerHTML = `
    <span class="tag-pill tag-console" style="--tag-color:${color}">${escapeHtml(game.console)}</span>
    <span class="tag-pill">${escapeHtml(game.genre)}</span>
    <span class="tag-pill">${game.type === 'download' ? 'Descarga' : 'Jugable en navegador'}</span>
    ${game.players ? `<span class="tag-pill">${escapeHtml(game.players)} jugador(es)</span>` : ''}
  `;

  const actions = document.getElementById('game-modal-actions');
  const isFav = state.favoriteIds.has(game.id);
  if (game.type === 'browser') {
    actions.innerHTML = `
      <button class="btn btn-primary btn-lg" id="modal-play-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Jugar
      </button>
      <button class="btn btn-secondary" data-fav-toggle="${escapeHtml(game.id)}">
        ${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}
      </button>
    `;
    document.getElementById('modal-play-btn').addEventListener('click', () => {
      closeGameModal();
      launchGame(game);
    });
  } else {
    actions.innerHTML = `
      <button class="btn btn-primary btn-lg" id="modal-download-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        Descargar
      </button>
      <button class="btn btn-secondary" data-fav-toggle="${escapeHtml(game.id)}">
        ${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}
      </button>
    `;
    document.getElementById('modal-download-btn').addEventListener('click', () => {
      triggerDownload(game);
    });
  }

  // El botón de favorito del modal ya queda cubierto por el listener
  // delegado en document (ver bindGlobalEvents) -- no necesita bind propio.

  document.getElementById('game-modal-backdrop').classList.add('is-open');
  document.getElementById('game-modal-backdrop').setAttribute('aria-hidden', 'false');
}

function closeGameModal() {
  document.getElementById('game-modal-backdrop').classList.remove('is-open');
  document.getElementById('game-modal-backdrop').setAttribute('aria-hidden', 'true');
  state.currentGameId = null;
}

// ===========================================================================
// EMULADOR
// ===========================================================================
async function launchGame(game) {
  const view = document.getElementById('emulator-view');
  const host = document.getElementById('emulator-canvas-host');
  const bootScreen = document.getElementById('emulator-boot-screen');
  const bootLog = document.getElementById('emulator-boot-log');

  document.getElementById('emulator-game-name').textContent = game.name;
  document.getElementById('emulator-console-name').textContent = game.console;
  const thumb = document.getElementById('emulator-cover-thumb');
  thumb.src = game.cover;
  thumb.onerror = () => { thumb.style.visibility = 'hidden'; };
  thumb.style.visibility = 'visible';

  host.innerHTML = '';
  bootScreen.style.display = 'flex';
  view.classList.add('is-open');
  view.setAttribute('aria-hidden', 'false');

  await emulatorController.launch(game, host, {
    onBootMessage: (msg) => { bootLog.textContent = msg; },
    onReady: () => {
      bootScreen.style.display = 'none';
    },
    onError: (msg) => {
      bootLog.textContent = msg;
      bootScreen.querySelector('.crt-spinner')?.remove();
    }
  });
}

async function closeEmulator() {
  const view = document.getElementById('emulator-view');
  await emulatorController.close({ autoSave: true });
  view.classList.remove('is-open');
  view.setAttribute('aria-hidden', 'true');
  document.getElementById('emulator-canvas-host').innerHTML = '';
  const { root } = parseHash();
  if (root === 'home') renderHome();
  if (root === 'library') renderLibraryView();
}

// ===========================================================================
// DESCARGAS -- simulación de progreso realista con Blob real
// ===========================================================================
async function triggerDownload(game) {
  showToast({
    id: game.id,
    title: `Descargando ${game.name}`,
    sub: `${game.console} · ${game.size || 'Tamaño desconocido'}`
  });

  try {
    // game.file puede ser un string (un solo archivo, comportamiento de
    // siempre) o un array (juego multi-archivo, p.ej. PS1 .cue+.bin).
    // resolveGameFileEntries() normaliza ambos casos a una lista de
    // { name, url } ya resueltos (github-release://... o ruta local
    // indistintamente -- ver js/github-release-source.js). Para
    // descargar, cada archivo se guarda por separado con su nombre real,
    // porque en el navegador no podemos "reunirlos en una carpeta": el
    // usuario necesita el .cue y el/los .bin juntos en la misma carpeta
    // local para poder usarlos luego en un emulador de escritorio.
    const entries = await window.resolveGameFileEntries(game.file);
    const isMulti = entries.length > 1;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const res = await fetch(entry.url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} al descargar ${entry.name}`);

      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) {
          // Con varios archivos, cada uno ocupa su propio tramo del 0-100%
          // para que la barra de progreso avance de forma continua en vez
          // de reiniciar a 0 entre archivo y archivo.
          const fileProgress = received / total;
          const overallProgress = ((i + fileProgress) / entries.length) * 100;
          updateToastProgress(game.id, Math.min(100, overallProgress));
        }
      }

      const blob = new Blob(chunks);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    finishToast(game.id, true, null, isMulti
      ? `Descargados ${entries.length} archivos -- guárdalos juntos en la misma carpeta.`
      : null);
  } catch (err) {
    console.warn('[downloads]', err);
    finishToast(game.id, false, err.message || 'No se encontró el archivo. Añade el archivo real en /downloads y actualiza data/games.json, o revisa la referencia github-release://.');
  }
}

function showToast({ id, title, sub }) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.id = `toast-${id}`;
  el.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-sub">${escapeHtml(sub)}</div>
    <div class="toast-bar"><div class="toast-bar-fill" style="width:2%"></div></div>
  `;
  container.appendChild(el);
}

// [SAVE-VERIFY] Toast puntual con auto-dismiss, independiente del flujo
// de descarga (showToast/updateToastProgress/finishToast no se
// auto-eliminan por sí solos, están pensados para que otro paso los
// complete). Usado por emulator.js para avisar de fallos reales de
// guardado/carga que antes se tragaban en silencio.
function showSaveWarningToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const id = `save-warning-${Date.now()}`;
  const el = document.createElement('div');
  el.className = 'toast';
  el.id = id;
  el.innerHTML = `
    <div class="toast-title">Aviso de guardado</div>
    <div class="toast-sub">${escapeHtml(message)}</div>
  `;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, 6000);
}
window.showSaveWarningToast = showSaveWarningToast;

function updateToastProgress(id, pct) {
  const el = document.getElementById(`toast-${id}`);
  if (!el) return;
  const fill = el.querySelector('.toast-bar-fill');
  if (fill) fill.style.width = `${pct}%`;
}

function finishToast(id, success, errorMsg, successMsg) {
  const el = document.getElementById(`toast-${id}`);
  if (!el) return;
  if (success) {
    el.querySelector('.toast-sub').textContent = successMsg || 'Descarga completada';
    el.querySelector('.toast-bar-fill').style.width = '100%';
  } else {
    el.querySelector('.toast-title').textContent = 'No se pudo descargar';
    el.querySelector('.toast-sub').textContent = errorMsg || 'Inténtalo de nuevo más tarde.';
    el.querySelector('.toast-bar-fill').style.background = 'var(--accent-danger)';
    el.querySelector('.toast-bar-fill').style.width = '100%';
  }
  setTimeout(() => el.remove(), 4500);
}

// ===========================================================================
// FAVORITOS
// ===========================================================================
async function refreshFavoriteIdsCache() {
  const ids = await retroStorage.getFavoriteIds();
  state.favoriteIds = new Set(ids);
}

/**
 * Alterna el estado de favorito de un juego y sincroniza TODOS los
 * botones [data-fav-toggle] visibles con ese mismo gameId (una tarjeta
 * puede aparecer repetida en varias secciones de home a la vez, más el
 * modal si está abierto). Se invoca desde el listener delegado de clic
 * en bindGlobalEvents, nunca con bind directo -- ver la nota ahí sobre
 * por qué el bind directo se rompía tras la primera navegación.
 */
async function toggleFavoriteAndSync(gameId) {
  const nowFav = await retroStorage.toggleFavorite(gameId);
  if (nowFav) state.favoriteIds.add(gameId); else state.favoriteIds.delete(gameId);

  document.querySelectorAll(`[data-fav-toggle="${CSS.escape(gameId)}"]`).forEach(b => {
    b.classList.toggle('is-active', nowFav);
    b.setAttribute('aria-pressed', String(nowFav));
    const svg = b.querySelector('svg');
    if (svg) svg.setAttribute('fill', nowFav ? 'currentColor' : 'none');
    if (b.tagName === 'BUTTON' && b.textContent.includes('favoritos')) {
      b.textContent = nowFav ? 'Quitar de favoritos' : 'Añadir a favoritos';
    }
  });

  const { root } = parseHash();
  if (root === 'library' && state.library.tab === 'favorites') renderLibraryView();
  if (root === 'home') renderHome();
}

// ===========================================================================
// BUSCADOR GLOBAL
// ===========================================================================
function openSearchOverlay() {
  const overlay = document.getElementById('search-overlay');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  const input = document.getElementById('global-search-input');
  input.value = '';
  renderSearchResults('');
  setTimeout(() => input.focus(), 50);
}

function closeSearchOverlay() {
  const overlay = document.getElementById('search-overlay');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

function renderSearchResults(term) {
  const container = document.getElementById('search-results');
  if (!term.trim()) {
    container.innerHTML = '<div class="search-empty">Escribe para buscar en toda la biblioteca</div>';
    return;
  }
  const results = gameLibrary.query({ term }).slice(0, 8);
  if (results.length === 0) {
    container.innerHTML = '<div class="search-empty">Sin resultados para "' + escapeHtml(term) + '"</div>';
    return;
  }
  container.innerHTML = results.map(g => `
    <div class="search-result-row" data-game-id="${escapeHtml(g.id)}" role="button" tabindex="0">
      <img class="search-result-thumb" src="${escapeHtml(g.cover)}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="search-result-meta">
        <div class="search-result-name">${escapeHtml(g.name)}</div>
        <div class="search-result-sub">${escapeHtml(g.console)} · ${escapeHtml(g.genre)}</div>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.search-result-row').forEach(row => {
    row.addEventListener('click', () => {
      closeSearchOverlay();
      openGameModal(row.dataset.gameId);
    });
  });
}

// ===========================================================================
// CONFIGURACIÓN DE MANDO (vista de plataforma)
// ===========================================================================
function renderGamepadConfigView() {
  updateGamepadStatusCard();
  renderButtonTester();
  renderRemapList();
  renderKeyboardMapList();
}

function updateGamepadStatusCard() {
  const card = document.getElementById('gamepad-status-card');
  const name = document.getElementById('gamepad-status-name');
  const sub = document.getElementById('gamepad-status-sub');
  const pad = gamepadManager.getActivePad();

  if (pad) {
    card.classList.add('is-connected');
    name.textContent = pad.id;
    sub.textContent = 'Mando detectado y listo. Prueba los botones abajo o reasigna cualquier control.';
  } else {
    card.classList.remove('is-connected');
    name.textContent = 'Ningún mando detectado';
    sub.textContent = 'Conecta un mando por USB o Bluetooth y pulsa cualquier botón para activarlo. También puedes jugar con el teclado.';
  }
}

function renderButtonTester() {
  const container = document.getElementById('button-tester');
  container.innerHTML = Array.from({ length: 16 }, (_, i) => `<div class="tester-btn" data-btn-index="${i}">${i}</div>`).join('');
}

function renderRemapList() {
  const container = document.getElementById('remap-list');
  container.innerHTML = LOGICAL_BUTTONS.map(btn => {
    const { padDesc, keyDesc } = gamepadManager.describeCurrentBinding(btn.id);
    return `
      <div class="remap-row" data-logical-id="${btn.id}">
        <div>
          <div class="remap-action">${escapeHtml(btn.label)}</div>
          <div class="remap-action-desc">Mando: ${escapeHtml(padDesc)} · Teclado: ${escapeHtml(keyDesc)}</div>
        </div>
        <button class="remap-btn" data-remap-btn="${btn.id}">Reasignar</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-remap-btn]').forEach(btn => {
    btn.addEventListener('click', () => startRemap(btn.dataset.remapBtn));
  });
}

function renderKeyboardMapList() {
  const container = document.getElementById('keyboard-map-list');
  container.innerHTML = `
    <div class="filter-bar" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap: var(--space-3);">
      ${LOGICAL_BUTTONS.map(btn => `
        <div>
          <div class="filter-label">${escapeHtml(btn.label)}</div>
          <div style="font-size:0.9rem; margin-top:2px;">${escapeHtml(KEY_DISPLAY_NAMES[gamepadManager.keyboardMapping[btn.id]] || gamepadManager.keyboardMapping[btn.id])}</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function startRemap(logicalId) {
  const row = document.querySelector(`.remap-row[data-logical-id="${logicalId}"]`);
  const btn = row?.querySelector('[data-remap-btn]');
  if (!btn) return;

  row.classList.add('is-listening');
  btn.classList.add('is-listening');
  const prevLabel = btn.textContent;
  btn.textContent = 'Pulsa un botón…';

  try {
    const result = await gamepadManager.waitForNextInput(logicalId, { timeoutMs: 8000 });
    btn.textContent = result.display;
  } catch (_) {
    btn.textContent = prevLabel;
  } finally {
    row.classList.remove('is-listening');
    btn.classList.remove('is-listening');
    renderRemapList();
    renderKeyboardMapList();
  }
}

function bindGamepadTesterAndStick() {
  gamepadManager.onRawButton((index, pressed) => {
    if (document.getElementById('view-gamepad-config')?.classList.contains('is-active')) {
      const el = document.querySelector(`.tester-btn[data-btn-index="${index}"]`);
      if (el) el.classList.toggle('is-pressed', pressed);
    }
  });

  gamepadManager.onStickMove((x, y) => {
    if (!document.getElementById('view-gamepad-config')?.classList.contains('is-active')) return;
    const dot = document.getElementById('stick-dot');
    if (!dot) return;
    const clampedX = Math.max(-1, Math.min(1, x));
    const clampedY = Math.max(-1, Math.min(1, y));
    dot.style.transform = `translate(calc(-50% + ${clampedX * 30}px), calc(-50% + ${clampedY * 30}px))`;
  });
}

// ===========================================================================
// INDICADOR DE MANDO (header + topbar emulador)
// ===========================================================================
function updateGamepadIndicators(connected, gp) {
  const headerIndicator = document.getElementById('gamepad-indicator');
  const headerLabel = document.getElementById('gamepad-indicator-label');
  const emuIndicator = document.getElementById('emulator-gamepad-indicator');
  const emuLabel = emuIndicator?.querySelector('.gamepad-label');

  headerIndicator.classList.toggle('is-connected', connected);
  emuIndicator?.classList.toggle('is-connected', connected);

  const label = connected ? (gp ? shortenPadName(gp.id) : 'Mando conectado') : 'Sin mando';
  headerLabel.textContent = label;
  if (emuLabel) emuLabel.textContent = connected ? label : 'Sin mando · usando teclado';
}

function shortenPadName(id) {
  if (/xbox/i.test(id)) return 'Mando Xbox';
  if (/dualshock|dualsense|playstation|sony/i.test(id)) return 'Mando PlayStation';
  if (/pro controller|switch/i.test(id)) return 'Mando genérico';
  return 'Mando conectado';
}

// ===========================================================================
// WIRING GLOBAL DE EVENTOS
// ===========================================================================
function bindGlobalEvents() {
  window.addEventListener('hashchange', handleRoute);

  // Delegación de eventos en `document`: los grids de tarjetas se
  // regeneran por completo en cada render (innerHTML), así que un
  // listener añadido directamente a un botón concreto se pierde en
  // cuanto ese botón se recrea. Escuchando en `document` (que nunca se
  // destruye) el manejador sigue funcionando sin importar cuántas veces
  // se haya vuelto a pintar el grid. Los favoritos usan este mismo
  // patrón vía toggleFavoriteAndSync (ver más abajo) en vez de bind
  // directo, que es lo que causaba que dejaran de responder tras
  // navegar por primera vez.
  document.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav-toggle]');
    if (favBtn) {
      e.stopPropagation();
      toggleFavoriteAndSync(favBtn.dataset.favToggle);
      return;
    }
    const card = e.target.closest('.game-card');
    if (card) {
      openGameModal(card.dataset.gameId);
      return;
    }
    const continueCard = e.target.closest('.continue-card');
    if (continueCard) {
      const game = gameLibrary.getById(continueCard.dataset.gameId);
      if (game) launchGame(game);
      return;
    }
    const downloadBtn = e.target.closest('[data-download-trigger]');
    if (downloadBtn) {
      const game = gameLibrary.getById(downloadBtn.dataset.downloadTrigger);
      if (game) triggerDownload(game);
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = document.activeElement?.closest?.('.game-card');
    if (card) {
      e.preventDefault();
      openGameModal(card.dataset.gameId);
    }
  });

  document.getElementById('game-modal-close').addEventListener('click', closeGameModal);
  document.getElementById('game-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'game-modal-backdrop') closeGameModal();
  });

  document.getElementById('search-trigger').addEventListener('click', openSearchOverlay);
  document.getElementById('search-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'search-overlay') closeSearchOverlay();
  });
  document.getElementById('global-search-input').addEventListener('input', (e) => {
    renderSearchResults(e.target.value);
  });

  document.getElementById('open-gamepad-config').addEventListener('click', () => navigateTo('#/gamepad-config'));

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('search-overlay').classList.contains('is-open')) closeSearchOverlay();
    else if (document.getElementById('game-modal-backdrop').classList.contains('is-open')) closeGameModal();
    else if (document.getElementById('emulator-view').classList.contains('is-open')) closeEmulator();
  });

  document.getElementById('library-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    state.library.tab = btn.dataset.tab;
    renderLibraryView();
  });
  document.getElementById('filter-console').addEventListener('change', (e) => {
    state.library.console = e.target.value;
    renderLibraryView();
  });
  document.getElementById('filter-genre').addEventListener('change', (e) => {
    state.library.genre = e.target.value;
    renderLibraryView();
  });
  document.getElementById('filter-sort').addEventListener('change', (e) => {
    state.library.sort = e.target.value;
    renderLibraryView();
  });
  let searchDebounce;
  document.getElementById('library-search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const val = e.target.value;
    searchDebounce = setTimeout(() => {
      state.library.term = val;
      renderLibraryView();
    }, 180);
  });

  document.getElementById('console-back-btn').addEventListener('click', () => navigateTo('#/play'));

  document.getElementById('downloads-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    state.downloadsConsole = btn.dataset.console;
    renderDownloadsView();
  });

  document.getElementById('emulator-close').addEventListener('click', closeEmulator);
  document.getElementById('emulator-save-state').addEventListener('click', async () => {
    try {
      await emulatorController.saveState('manual');
      flashButton('emulator-save-state');
    } catch (err) {
      console.warn(err);
    }
  });
  document.getElementById('emulator-load-state').addEventListener('click', async () => {
    try {
      await emulatorController.loadState('manual');
      flashButton('emulator-load-state');
    } catch (err) {
      try {
        await emulatorController.loadState('auto');
        flashButton('emulator-load-state');
      } catch (_) { console.warn('Sin partida guardada todavía'); }
    }
  });
  document.getElementById('emulator-config-gamepad').addEventListener('click', () => {
    emulatorController.openNativeGamepadConfig();
  });
  document.getElementById('emulator-toggle-touch').addEventListener('click', () => {
    // Respaldo manual: fuerza mostrar/ocultar el gamepad virtual táctil
    // por si la sincronización automática (EJS_onGameStart) todavía no
    // ha tenido ocasión de correr -- típico en PS1, donde el disco puede
    // seguir descargándose varios segundos después de que el usuario ya
    // esté mirando la pantalla del juego.
    const result = emulatorController.toggleVirtualGamepad();
    if (result !== null) flashButton('emulator-toggle-touch');
  });
  document.getElementById('emulator-fullscreen').addEventListener('click', () => {
    const stage = document.querySelector('.emulator-stage');
    if (!document.fullscreenElement) {
      stage.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  });

  // requestFullscreen() se pide sobre .emulator-stage (el contenedor del
  // padre), no sobre el <iframe> del juego -- así el navbar y los
  // botones del reproductor siguen siendo clicables en fullscreen. Pero
  // eso deja el foco de teclado fuera del iframe, donde EmulatorJS
  // escucha los controles, así que tras CUALQUIER cambio de fullscreen
  // (botón propio, tecla Esc, F11, o el botón nativo del reproductor)
  // lo devolvemos explícitamente al juego.
  document.addEventListener('fullscreenchange', () => {
    const stage = document.querySelector('.emulator-stage');
    const emulatorOpen = document.getElementById('emulator-view')?.classList.contains('is-open');
    if (!emulatorOpen) return;
    // requestAnimationFrame porque el navegador reasigna el foco de
    // forma asíncrona al entrar/salir de fullscreen -- llamar a focus()
    // en el mismo tick del evento a veces no tiene efecto.
    requestAnimationFrame(() => emulatorController.focusGame());
  });

  document.getElementById('save-gamepad-config').addEventListener('click', async () => {
    await gamepadManager.saveMapping();
    const btn = document.getElementById('save-gamepad-config');
    const prev = btn.textContent;
    btn.textContent = 'Guardado ✓';
    setTimeout(() => { btn.textContent = prev; }, 1600);
  });
  document.getElementById('reset-gamepad-config').addEventListener('click', () => {
    gamepadManager.resetToDefaults();
    renderRemapList();
    renderKeyboardMapList();
  });

  gamepadManager.onConnectionChange((connected, gp) => {
    updateGamepadIndicators(connected, gp);
    if (document.getElementById('view-gamepad-config')?.classList.contains('is-active')) {
      updateGamepadStatusCard();
    }
  });

  bindGamepadTesterAndStick();
}

function flashButton(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.color = 'var(--accent-mint)';
  setTimeout(() => { el.style.color = ''; }, 500);
}

// ===========================================================================
// INICIALIZACIÓN
// ===========================================================================
async function init() {
  await gameLibrary.load();
  await refreshFavoriteIdsCache();
  bindGlobalEvents();
  updateGamepadIndicators(gamepadManager.isConnected(), gamepadManager.getActivePad());
  handleRoute();
}

document.addEventListener('DOMContentLoaded', init);
