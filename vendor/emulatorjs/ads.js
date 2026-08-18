/**
 * ads.js
 * -----------------------------------------------------------------------
 * Punto de extensión para monetización futura (opcional).
 *
 * Este archivo existe por la estructura de carpetas solicitada, pero NO
 * integra ninguna red publicitaria real: no hay tags de AdSense, ningún
 * SDK de terceros, ni llamadas de red a ningún proveedor de anuncios.
 * Activar publicidad real es una decisión de producto (y de cumplimiento
 * legal — cookies, consentimiento RGPD/LOPD, etc.) que corresponde a
 * quien despliegue esta plataforma, no algo que deba venir activado por
 * defecto en una plantilla.
 *
 * RETROPLAY_ADS_CONFIG.enabled queda en false. Si en el futuro se
 * integra un proveedor (por ejemplo, para financiar el ancho de banda
 * de servir los cores WASM propios en vez de depender de un CDN), el
 * patrón recomendado es:
 *
 *   1. Cargar el SDK del proveedor solo si enabled === true.
 *   2. Mostrar primero un banner de consentimiento de cookies/privacidad.
 *   3. Insertar los slots en los contenedores marcados con
 *      [data-ad-slot] (ver ejemplo comentado abajo) — ninguno existe
 *      todavía en index.html porque no hay proveedor configurado.
 *
 * EmulatorJS también soporta sus propias variables EJS_AdUrl / EJS_AdMode
 * / EJS_AdTimer / EJS_AdSize si se quisiera mostrar un anuncio breve
 * antes de que arranque un juego (ver emulator.js) — se dejan sin
 * definir intencionadamente por el mismo motivo.
 * -----------------------------------------------------------------------
 */

const RETROPLAY_ADS_CONFIG = {
  enabled: false,
  provider: null, // p.ej. 'adsense' | 'custom' — sin implementar
  slots: []
};

class AdsManager {
  constructor(config) {
    this.config = config;
  }

  init() {
    if (!this.config.enabled) {
      console.info('[ads] Publicidad desactivada (ads.js en modo no-op). Configura RETROPLAY_ADS_CONFIG para activarla.');
      return;
    }
    // Intencionadamente sin implementar: aquí iría la carga condicional
    // del SDK del proveedor elegido, una vez exista consentimiento.
  }

  renderSlot(_slotId) {
    if (!this.config.enabled) return;
    // No-op hasta que se configure un proveedor real.
  }
}

const adsManager = new AdsManager(RETROPLAY_ADS_CONFIG);
adsManager.init();
