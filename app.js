(() => {
  'use strict';

  const TIME_ZONE = 'Europe/Madrid';
  const STATIC_SITE = document.documentElement.dataset.mode === 'static';
  // Umbral editorial del visor; no implica que el monitor garantice esta frecuencia.
  const STALE_MS = 24 * 60 * 60 * 1000;
  const SOURCES = [
    { key: 'filmaffinity', name: 'FilmAffinity', short: 'FA' },
    { key: 'imdb', name: 'IMDb', short: 'IMDb' },
    { key: 'rottenTomatoes', name: 'Rotten Tomatoes · crítica', short: 'RT crítica' },
    { key: 'rottenTomatoesAudience', name: 'Rotten Tomatoes · público', short: 'RT público' },
  ];
  const EVENT_TYPES = { colloquium: 'Coloquio', 'special-screening': 'Sesión especial', cycle: 'Ciclo', festival: 'Festival', premiere: 'Estreno', preview: 'Preestreno', family: 'Cine familiar', retrospective: 'Retrospectiva', visita: 'Visita' };
  function eventType(event) { return text(event.type) || '__unspecified__'; }
  function eventTypeLabel(type) { return EVENT_TYPES[type] || (type === '__unspecified__' ? 'Sin tipo especificado' : type); }
  const STATUS_NAMES = {
    ok: 'Disponible', success: 'Disponible', available: 'Disponible', verified: 'Verificado por el monitor',
    active: 'Activo', scheduled: 'Programada', confirmed: 'Confirmada', complete: 'Completa',
    partial: 'Parcial', incomplete: 'Incompleta', pending: 'Pendiente', unknown: 'Sin confirmar',
    error: 'Error', failed: 'Error', blocked: 'Acceso bloqueado', unavailable: 'No disponible',
    missing: 'Sin datos', empty: 'Sin sesiones', stale: 'Obsoleto', outdated: 'Obsoleto',
    cancelled: 'Cancelada', canceled: 'Cancelada', sold_out: 'Agotada', soldout: 'Agotada',
    soldOut: 'Agotada', expired: 'Finalizada', skipped: 'Sin consultar', timeout: 'Tiempo agotado',
    no_data: 'Sin datos', no_sessions: 'Sin sesiones', not_found: 'No encontrado', closed: 'Cerrado',
    identity_unconfirmed: 'Identidad sin confirmar', unrated: 'Sin nota publicada',
  };
  const GOOD = new Set(['ok', 'success', 'available', 'verified', 'complete', 'active', 'confirmed', 'scheduled']);
  const FAILED = new Set(['error', 'failed', 'blocked', 'unavailable', 'timeout']);
  const PENDING_RATINGS = new Set(['pending', 'unknown', 'missing', 'unavailable', 'error', 'failed', 'blocked', 'not_found', 'no_data', 'identity_unconfirmed', 'unrated']);
  const UNBOOKABLE = new Set(['cancelled', 'canceled', 'sold_out', 'soldout', 'soldOut', 'expired', 'unavailable']);
  const { STORAGE_KEY, LANGUAGE_FILTERS, languageCategory, languageLabel, languageName, createWatchedStore } = window.CinemaPreferences;
  const watchedMovies = createWatchedStore(() => window.localStorage);
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('filters-form'), movies: $('movie-list'), events: $('event-list'), coverage: $('coverage-list'),
    refresh: $('refresh-button'), refreshLabel: $('refresh-label'), refreshStatus: $('refresh-status'),
    notices: $('notices'), dialog: $('movie-dialog'), dialogContent: $('dialog-content'),
  };
  const state = {
    snapshot: null, view: 'listings', loading: true, initializing: true, starting: false, running: false,
    snapshotError: '', monitorError: '', statusError: '', refreshError: '', statusKnown: false,
    pollTimer: null, statusEpoch: 0, snapshotEpoch: 0, failures: 0, snapshotFingerprint: '', lastSnapshotRead: 0,
    dialogOpener: null, dialogMovieId: '', deferredRender: false,
    watchedError: '', undoWatched: null, feedbackFocus: false,
  };
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const numberFormat = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
  const dateFormat = new Intl.DateTimeFormat('es-ES', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
  const dateTimeFormat = new Intl.DateTimeFormat('es-ES', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const timeFormat = new Intl.DateTimeFormat('es-ES', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const monthFormat = new Intl.DateTimeFormat('es-ES', { timeZone: TIME_ZONE, month: 'short', year: 'numeric' });

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function identifier(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
  function array(value) { return Array.isArray(value) ? value : []; }
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function strings(value) { return array(value).map(text).filter(Boolean); }
  function normalize(value) { return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es'); }
  function date(value) {
    if (!text(value)) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  function dayKey(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return value;
    const parsed = value instanceof Date ? value : date(value);
    if (!parsed) return '';
    const parts = Object.fromEntries(dayFormat.formatToParts(parsed).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function dayDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? date(`${value}T12:00:00Z`) : date(value); }
  function formatDate(value) { const parsed = dayDate(value); return parsed ? dateFormat.format(parsed) : 'Fecha pendiente'; }
  function formatDateTime(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return formatDate(value);
    const parsed = date(value);
    return parsed ? dateTimeFormat.format(parsed) : 'Fecha pendiente';
  }
  function isStale(value) { const parsed = date(value); return parsed !== null && Date.now() - parsed.getTime() > STALE_MS; }
  function statusName(value) { return STATUS_NAMES[text(value)] || text(value) || 'Pendiente'; }
  function plural(count, singular, multiple) { return `${numberFormat.format(count)} ${count === 1 ? singular : multiple}`; }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }
  // Los textos de las fuentes nunca se interpretan como HTML. Solo se admiten URLs web.
  function safeUrl(value) {
    if (!text(value)) return '';
    try {
      const url = new URL(value, window.location.href);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function externalLink(label, url, className = 'source-link') {
    const href = safeUrl(url);
    if (!href) return null;
    const link = element('a', className, label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${label} (se abre en otra pestaña)`);
    return link;
  }
  function statusBadge(value) {
    const status = text(value);
    const type = GOOD.has(status) ? 'status-good' : FAILED.has(status) ? 'status-error' : 'status-warning';
    return element('span', `status-badge ${type}`, statusName(status));
  }
  function cinemaFor(id) { return state.snapshot?.cinemas.find((cinema) => identifier(cinema.id) === identifier(id)); }
  function cinemaName(id) { return text(cinemaFor(id)?.name) || 'Cine sin identificar'; }
  function cinemaIsClosed(id) {
    return normalize(cinemaFor(id)?.status) === 'closed'
      || Boolean(state.snapshot?.coverage.some((item) => identifier(item.cinemaId) === identifier(id) && normalize(item.status) === 'closed'));
  }
  function matchesLanguage(language, selected) {
    return !selected || languageCategory(language) === selected;
  }
  function loadWatchedMovies() {
    try { watchedMovies.reload(); state.watchedError = ''; }
    catch { state.watchedError = 'No se pudo leer la lista de vistas de este navegador. Comprueba que permite guardar datos locales.'; }
  }
  function watchedButton(movie) {
    const watched = watchedMovies.has(movie);
    const button = element('button', 'watched-button', watched ? '✓ Vista · Quitar marca' : 'Ya la he visto');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(watched));
    button.setAttribute('aria-label', `${watched ? 'Marcar como no vista' : 'Ya la he visto'}: ${text(movie.title) || 'esta película'}`);
    button.addEventListener('click', () => setWatched(movie, !watchedMovies.has(movie)));
    return button;
  }
  function focusMovieOrFilter(movie) {
    const card = [...els.movies.querySelectorAll('.movie-card')].find((item) => item.dataset.movieId === identifier(movie?.id));
    (card?.querySelector('.watched-button') || $('panel-listings')).focus({ preventScroll: true });
  }
  function setWatched(movie, watched, undo = false) {
    const previous = watchedMovies.has(movie);
    try { watchedMovies.set(movie, watched); state.watchedError = ''; }
    catch {
      state.watchedError = 'No se pudo guardar el cambio. La película conserva su estado anterior; comprueba el almacenamiento de este navegador.';
      renderNotices();
      // El aviso debe poder leerse también con la ficha modal abierta.
      if (els.dialog.open) {
        let error = $('dialog-watched-error');
        if (!error) { error = element('p', 'notice notice-error'); error.id = 'dialog-watched-error'; error.setAttribute('role', 'alert'); els.dialogContent.append(error); }
        error.textContent = state.watchedError;
      }
      return;
    }
    state.undoWatched = undo ? null : { movie, watched: previous };
    $('watched-feedback').hidden = false;
    $('watched-message').textContent = `${text(movie.title) || 'Película'}: ${watched ? 'marcada como vista' : 'marcada como no vista'}.`;
    $('undo-watched').hidden = undo;
    renderNotices();
    if (els.dialog.open) {
      state.deferredRender = true;
      state.feedbackFocus = true;
      els.dialog.close();
    } else {
      renderView();
      if (undo) focusMovieOrFilter(movie);
      else $('undo-watched').focus({ preventScroll: true });
    }
  }
  function ratingData(movie, source) {
    const rating = movie.ratings?.[source] ?? (source === 'rottenTomatoesAudience' ? movie.ratings?.rottenTomatoes?.audience : null);
    if (!record(rating)) return { available: false, ratio: null };
    const maximum = rating.max ?? rating.scale;
    const valid = typeof rating.value === 'number' && Number.isFinite(rating.value) && rating.value >= 0;
    const maxValid = typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0;
    const available = valid && (!maxValid || rating.value <= maximum) && !PENDING_RATINGS.has(text(rating.status));
    return { ...rating, max: maximum, available, ratio: available && maxValid ? rating.value / maximum * 10 : null, maxValid };
  }
  function renderRatings(movie, detailed = false) {
    const container = element('div', detailed ? 'dialog-ratings' : 'ratings');
    for (const source of SOURCES) {
      const rating = ratingData(movie, source.key);
      const ratingUrl = rating.source === 'imdb_dataset' ? rating.titleUrl || rating.searchUrl : rating.titleUrl || rating.url || rating.searchUrl;
      const node = externalLink(source.name, ratingUrl, 'rating') || element('span', 'rating');
      node.append(element('span', 'rating-source', detailed ? source.name : source.short));
      // externalLink comienza con texto; se sustituye por nodos seguros para componer la nota.
      if (node.firstChild?.nodeType === Node.TEXT_NODE) node.firstChild.remove();
      if (rating.available) {
        node.append(element('span', 'rating-value', numberFormat.format(rating.value)));
        if (rating.maxValid) node.append(element('span', 'rating-scale', `/ ${numberFormat.format(rating.max)}`));
        if (rating.stale) node.append(element('span', 'rating-pending', 'Sin actualizar'));
        if (text(rating.status) && !GOOD.has(text(rating.status))) node.append(element('span', 'rating-pending', statusName(rating.status)));
      } else {
        node.append(element('span', 'rating-pending', 'Pendiente'));
        if (detailed && text(rating.status) && text(rating.status) !== 'pending') node.append(element('span', 'rating-pending', statusName(rating.status)));
      }
      if (node.tagName === 'A') {
        const valueLabel = rating.available ? `${numberFormat.format(rating.value)}${rating.maxValid ? ` sobre ${numberFormat.format(rating.max)}` : ''}` : 'nota pendiente';
        node.setAttribute('aria-label', `${source.name}: ${valueLabel}. Consultar fuente (otra pestaña)`);
        if (detailed) node.append(element('span', 'rating-pending', 'Consultar fuente ↗'));
      } else node.setAttribute('aria-label', `${source.name}: ${rating.available ? numberFormat.format(rating.value) : 'pendiente'}`);
      if (rating.available && rating.stale) {
        const observed = `Última nota verificada: ${formatDateTime(rating.observedAt)}`;
        node.title = `${observed}. No se ha podido actualizar.`;
        node.setAttribute('aria-label', `${node.getAttribute('aria-label')}. Sin actualizar. ${observed}`);
        if (detailed) node.append(element('span', 'rating-pending', observed));
      }
      container.append(node);
      if (detailed && rating.source === 'imdb_dataset') {
        const attribution = externalLink('Fuente: IMDb · conjunto oficial de datos', rating.url, 'small-text');
        if (attribution) container.append(attribution);
      }
    }
    return container;
  }
  function money(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return '';
    if (!text(currency)) return `${numberFormat.format(amount)} (moneda pendiente)`;
    try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(amount); }
    catch { return `${numberFormat.format(amount)} ${text(currency)}`; }
  }
  function priceLabel(price) {
    if (!record(price)) return 'Precio pendiente';
    const label = text(price.label);
    const amount = money(price.amount, price.currency);
    if (price.kind === 'unknown' || !['exact', 'from', 'range', 'published'].includes(price.kind)) return label ? `Precio pendiente · ${label}` : 'Precio pendiente';
    if (price.kind === 'range') return label ? `Rango · ${label}` : 'Rango de precio pendiente';
    if (!amount) return label ? `Precio pendiente · ${label}` : 'Precio pendiente';
    if (price.kind === 'published') return `${amount} · ${label || 'Publicado; extras no confirmados'}${label && !normalize(label).includes('extras') ? ' · Extras no confirmados' : ''}`;
    const result = price.kind === 'from' ? `Desde ${amount}` : amount;
    return label && normalize(label) !== normalize(result) ? `${result} · ${label}` : result;
  }
  function poster(movie) {
    const wrapper = element('div', 'poster-wrap');
    const missing = element('span', 'poster-missing', 'Cartel no disponible');
    wrapper.append(missing);
    const url = safeUrl(movie.poster);
    if (url) {
      const img = element('img', 'poster-image');
      img.alt = `Cartel de ${text(movie.title) || 'la película'}`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => { missing.hidden = true; }, { once: true });
      img.addEventListener('error', () => { img.remove(); missing.hidden = false; }, { once: true });
      img.src = url;
      wrapper.append(img);
    }
    return wrapper;
  }

  function filters() {
    return {
      query: normalize($('search').value), cinema: $('cinema').value, day: $('date').value,
      language: $('language').value, format: $('format').value, genre: $('genre').value,
      ratingSource: $('rating-source').value, minRating: $('min-rating').value,
      eventType: $('event-type').value, past: $('include-past').checked, sort: $('sort').value, watched: $('watched').value,
    };
  }
  function fillOptions(id, options, emptyLabel, preserveMissing = true) {
    const select = $(id);
    const previous = select.value;
    const previousLabel = select.selectedOptions[0]?.textContent || previous;
    const fragment = document.createDocumentFragment();
    const first = element('option', '', emptyLabel);
    first.value = '';
    fragment.append(first);
    const unique = new Map(options.filter(([key]) => key));
    if (preserveMissing && previous && !unique.has(previous)) unique.set(previous, previousLabel);
    for (const [value, label] of unique) {
      const option = element('option', '', label);
      option.value = value;
      fragment.append(option);
    }
    select.replaceChildren(fragment);
    select.value = unique.has(previous) ? previous : '';
  }
  function updateFilterOptions() {
    const data = state.snapshot;
    if (!data) return;
    const sessions = data.sessions.filter((session) => !cinemaIsClosed(session.cinemaId));
    const events = data.events.filter((event) => !cinemaIsClosed(event.cinemaId));
    fillOptions('event-type', [...new Set(events.map(eventType))].map((type) => [type, eventTypeLabel(type)]).sort((a, b) => collator.compare(a[1], b[1])), 'Todos los tipos');
    const alphabetic = (values) => [...new Set(values)].sort(collator.compare).map((value) => [value, value]);
    fillOptions('cinema', data.cinemas.filter((cinema) => !cinemaIsClosed(cinema.id)).map((cinema) => [identifier(cinema.id), text(cinema.name) || 'Cine sin nombre']).sort((a, b) => collator.compare(a[1], b[1])), 'Todos los cines', false);
    const dates = [...new Set([...sessions.map((session) => dayKey(session.startsAt)), ...events.flatMap((event) => [dayKey(event.startsAt), dayKey(event.endDate)])].filter(Boolean))].sort();
    // Incluir también los días intermedios de ciclos fechados, con límite para datos anómalos.
    for (const event of events) {
      const start = dayDate(dayKey(event.startsAt));
      const end = dayDate(dayKey(event.endDate));
      if (!start || !end) continue;
      const cursor = new Date(start);
      for (let count = 0; cursor <= end && count < 366; count += 1) {
        dates.push(dayKey(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    fillOptions('date', [...new Set(dates)].sort().map((value) => [value, formatDate(value)]), 'Todas las fechas');
    fillOptions('language', LANGUAGE_FILTERS, 'Todas las versiones', false);
    fillOptions('format', alphabetic(sessions.flatMap((session) => strings(session.formats))), 'Todos los formatos');
    fillOptions('genre', alphabetic(data.movies.flatMap((movie) => strings(movie.genres))), 'Todos los géneros');
  }
  function matchesSession(session, filter) {
    const starts = date(session.startsAt);
    return !cinemaIsClosed(session.cinemaId)
      && (!filter.cinema || identifier(session.cinemaId) === filter.cinema)
      && (!filter.day || dayKey(session.startsAt) === filter.day)
      && matchesLanguage(session.language, filter.language)
      && (!filter.format || strings(session.formats).includes(filter.format))
      && (filter.past || !starts || starts.getTime() >= Date.now());
  }
  function matchingMovies(filter) {
    const sessionsByMovie = new Map();
    for (const session of state.snapshot.sessions) {
      const id = identifier(session.movieId);
      if (!sessionsByMovie.has(id)) sessionsByMovie.set(id, []);
      sessionsByMovie.get(id).push(session);
    }
    const result = [];
    for (const movie of state.snapshot.movies) {
      const watched = watchedMovies.has(movie);
      if (filter.watched === 'unwatched' && watched || filter.watched === 'watched' && !watched) continue;
      const searchText = normalize([text(movie.title), text(movie.originalTitle), text(movie.director)].join(' '));
      if (filter.query && !filter.query.split(/\s+/).every((word) => searchText.includes(word))) continue;
      if (filter.genre && !strings(movie.genres).includes(filter.genre)) continue;
      const rating = ratingData(movie, filter.ratingSource);
      if (filter.minRating && (rating.ratio === null || rating.ratio < Number(filter.minRating))) continue;
      const allSessions = sessionsByMovie.get(identifier(movie.id)) || [];
      const sessions = allSessions.filter((session) => matchesSession(session, filter));
      if (!sessions.length && (allSessions.length || filter.cinema || filter.day || filter.language || filter.format)) continue;
      const next = sessions.reduce((minimum, session) => Math.min(minimum, date(session.startsAt)?.getTime() ?? Infinity), Infinity);
      result.push({ movie, sessions, next, rating: rating.ratio });
    }
    result.sort((a, b) => {
      if (filter.sort === 'rating') {
        const difference = (b.rating ?? -1) - (a.rating ?? -1);
        if (difference) return difference;
      }
      if (filter.sort === 'next' && a.next !== b.next) return a.next < b.next ? -1 : 1;
      return collator.compare(text(a.movie.title), text(b.movie.title));
    });
    return result;
  }
  function emptyState(title, description, reset = false) {
    const box = element('div', 'empty-state');
    box.append(element('span', 'empty-mark', '—'), element('h3', '', title), element('p', '', description));
    box.firstChild.setAttribute('aria-hidden', 'true');
    if (reset) {
      const button = element('button', 'button button-dark', 'Restablecer filtros');
      button.type = 'button';
      button.addEventListener('click', resetFilters);
      box.append(button);
    }
    return box;
  }
  function sessionTicket(session, movie) {
    const ticket = element('div', 'session-ticket');
    const starts = date(session.startsAt);
    const past = starts !== null && starts.getTime() < Date.now();
    if (past) ticket.classList.add('is-past');
    const top = element('div', 'ticket-top');
    const time = starts ? timeFormat.format(starts) : 'Hora pendiente';
    const booking = !past && !UNBOOKABLE.has(text(session.status)) ? externalLink(time, session.bookingUrl, 'session-time') : null;
    if (booking) {
      booking.setAttribute('aria-label', `Entradas para ${text(movie.title) || 'esta película'}, ${cinemaName(session.cinemaId)}, ${formatDateTime(session.startsAt)}, ${languageLabel(session.language)} (otra pestaña)`);
      const timeNode = element('time', '', time);
      timeNode.dateTime = session.startsAt;
      booking.replaceChildren(timeNode);
      top.append(booking, element('span', 'ticket-arrow', '↗'));
      top.lastChild.setAttribute('aria-hidden', 'true');
    } else {
      const timeNode = element(starts ? 'time' : 'span', 'session-time', time);
      if (starts) timeNode.dateTime = session.startsAt;
      top.append(timeNode);
    }
    ticket.append(top);
    const version = element('p', 'session-language', [languageLabel(session.language), ...strings(session.formats)].join(' · '));
    version.title = text(session.language?.label) ? `Texto de la fuente: ${text(session.language.label)}` : '';
    ticket.append(version);
    const languageDetails = [text(session.language?.audio) ? `Audio: ${languageName(session.language.audio)}` : '', text(session.language?.subtitles) ? `Subtítulos: ${languageName(session.language.subtitles)}` : ''].filter(Boolean).join(' · ');
    if (languageDetails) ticket.append(element('p', 'session-language', languageDetails));
    ticket.append(element('p', 'session-price', priceLabel(session.price)));
    if (past) ticket.append(element('span', 'session-state', 'Sesión pasada'));
    if (text(session.status) && !GOOD.has(text(session.status))) ticket.append(element('span', 'session-state', statusName(session.status)));
    if (!booking && !past && !UNBOOKABLE.has(text(session.status))) ticket.append(element('span', 'session-state', 'Enlace de entradas no disponible'));
    const stale = isStale(session.observedAt) || ['stale', 'outdated'].includes(text(session.status));
    if (stale) ticket.append(element('p', 'data-stale', 'Dato obsoleto · confirmar en la fuente'));
    const sources = element('div', 'session-source');
    const source = externalLink('Fuente', session.sourceUrl);
    const priceSource = externalLink('Tarifa', session.price?.url);
    if (source) sources.append(source);
    if (priceSource) sources.append(priceSource);
    if (sources.childNodes.length) ticket.append(sources);
    const observed = date(session.observedAt);
    ticket.title = observed ? `Observada: ${formatDateTime(session.observedAt)} · ${statusName(session.status)}` : 'Fecha de observación pendiente';
    return ticket;
  }
  function sessionGroups(sessions, movie) {
    const container = element('div', 'session-groups');
    if (!sessions.length) {
      container.append(element('p', 'movie-meta', 'Sin sesiones publicadas en esta instantánea.'));
      return container;
    }
    const groups = new Map();
    for (const session of sessions) {
      const key = identifier(session.cinemaId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    for (const [id, items] of [...groups].sort((a, b) => collator.compare(cinemaName(a[0]), cinemaName(b[0])))) {
      const group = element('section', 'cinema-sessions');
      const heading = element('div', 'cinema-heading');
      heading.append(element('h4', '', cinemaName(id)));
      const cinemaLink = externalLink('Web de la sala ↗', cinemaFor(id)?.url);
      if (cinemaLink) heading.append(cinemaLink);
      group.append(heading);
      const tariff = tariffReference(cinemaFor(id));
      if (tariff) group.append(tariff);
      const days = new Map();
      const sorted = [...items].sort((a, b) => (date(a.startsAt)?.getTime() ?? Infinity) - (date(b.startsAt)?.getTime() ?? Infinity));
      for (const session of sorted) {
        const key = dayKey(session.startsAt);
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(session);
      }
      for (const [day, daySessions] of days) {
        group.append(element('p', 'session-date', day ? formatDate(day) : 'Fecha pendiente'));
        const list = element('div', 'session-list');
        daySessions.forEach((session) => list.append(sessionTicket(session, movie)));
        group.append(list);
      }
      container.append(group);
    }
    return container;
  }
  function tariffReference(cinema) {
    const references = Array.isArray(cinema?.tariffs) ? cinema.tariffs : [];
    if (!references.length) return null;
    const details = element('details', 'tariff-reference');
    details.append(element('summary', '', 'Tarifas de referencia del cine'));
    for (const tariff of references) {
      details.append(element('p', 'small-text', text(tariff.label) || 'Importe no publicado'));
      details.append(element('p', 'small-text', text(tariff.conditions)));
      const source = externalLink('Consultar tarifario oficial ↗', tariff.sourceUrl);
      if (source) details.append(source);
    }
    return details;
  }
  function movieCard(entry, index) {
    const { movie, sessions } = entry;
    const article = element('article', 'movie-card');
    article.dataset.movieId = identifier(movie.id);
    article.append(poster(movie));
    const main = element('div', 'movie-main');
    const heading = element('div', 'movie-heading');
    const title = element('h3', 'movie-title');
    const titleButton = element('button', 'title-button', text(movie.title) || 'Título pendiente');
    titleButton.type = 'button';
    titleButton.setAttribute('aria-haspopup', 'dialog');
    titleButton.addEventListener('click', () => openMovie(movie, sessions));
    title.append(titleButton);
    const number = element('span', 'movie-number', String(index + 1).padStart(2, '0'));
    number.setAttribute('aria-hidden', 'true');
    heading.append(title, number);
    main.append(heading);
    const meta = [identifier(movie.year), text(movie.director), ...strings(movie.genres)].filter(Boolean);
    if (meta.length) main.append(element('p', 'movie-meta', meta.join(' · ')));
    if (text(movie.synopsis)) main.append(element('p', 'movie-synopsis', text(movie.synopsis)));
    main.append(renderRatings(movie));
    const actions = element('div', 'card-actions');
    const details = element('button', 'text-button', 'Ficha y tráiler ↗');
    details.type = 'button';
    details.setAttribute('aria-label', `Ver ficha de ${text(movie.title) || 'esta película'}`);
    details.setAttribute('aria-haspopup', 'dialog');
    details.addEventListener('click', () => openMovie(movie, sessions));
    actions.append(details, watchedButton(movie));
    main.append(actions);
    article.append(main);
    // Limitar la primera expansión evita cientos de entradas por película en una instantánea grande.
    const ordered = [...sessions].sort((a, b) => (date(a.startsAt)?.getTime() ?? Infinity) - (date(b.startsAt)?.getTime() ?? Infinity));
    const groups = sessionGroups(ordered.slice(0, 8), movie);
    if (ordered.length > 8) {
      const more = element('button', 'text-button more-sessions', `Ver las ${ordered.length} sesiones`);
      more.type = 'button';
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        const expanded = more.getAttribute('aria-expanded') !== 'true';
        groups.replaceChildren(...sessionGroups(expanded ? ordered : ordered.slice(0, 8), movie).childNodes);
        more.textContent = expanded ? 'Mostrar menos sesiones' : `Ver las ${ordered.length} sesiones`;
        more.setAttribute('aria-expanded', String(expanded));
        groups.append(more);
        more.focus({ preventScroll: true });
      });
      groups.append(more);
    }
    article.append(groups);
    return article;
  }
  function openMovie(movie, sessions) {
    state.dialogOpener = document.activeElement;
    state.dialogMovieId = identifier(movie.id);
    const content = document.createDocumentFragment();
    const header = element('div', 'dialog-header');
    header.append(poster(movie));
    const info = element('div');
    const title = element('h2', '', text(movie.title) || 'Título pendiente');
    title.id = 'dialog-title';
    info.append(title);
    if (text(movie.originalTitle) && movie.originalTitle !== movie.title) info.append(element('p', 'original-title', text(movie.originalTitle)));
    info.append(element('p', 'movie-meta', `Dirección: ${text(movie.director) || 'pendiente'}`));
    info.append(element('p', 'movie-meta', [identifier(movie.year) || 'Año pendiente', ...strings(movie.genres)].join(' · ')));
    const trailer = externalLink('Ver tráiler ↗', movie.trailer, 'text-button');
    const action = element('div', 'card-actions');
    action.append(trailer || element('p', 'small-text', 'Tráiler pendiente'), watchedButton(movie));
    info.append(action);
    header.append(info);
    content.append(header);
    const synopsis = element('section', 'dialog-section');
    synopsis.append(element('h3', '', 'La historia'), element('p', 'dialog-synopsis', text(movie.synopsis) || 'Sinopsis pendiente en la fuente.'));
    const ratings = element('section', 'dialog-section');
    ratings.append(element('h3', '', 'Notas y fuentes'), renderRatings(movie, true));
    const note = element('p', 'small-text dialog-session-note', `${plural(sessions.length, 'sesión coincide', 'sesiones coinciden')} con los filtros actuales. Las notas se muestran en su escala original; un enlace a una fuente no verifica una puntuación pendiente.`);
    content.append(synopsis, ratings, note);
    els.dialogContent.replaceChildren(content);
    els.dialog.showModal();
    els.dialog.scrollTop = 0;
    document.body.classList.add('dialog-open');
  }

  function renderListings() {
    if (!state.snapshot) {
      $('listings-summary').textContent = state.loading ? 'Cargando la programación…' : 'Sin instantánea disponible';
      els.movies.replaceChildren(emptyState(state.loading ? 'Cargando la cartelera' : 'La cartelera aún no está disponible', state.loading ? 'Esperando los datos de la programación.' : STATIC_SITE ? 'Usa «Recargar cartelera» para volver a consultar la última publicación.' : 'Usa «Actualizar cartelera» para consultar el monitor. Los errores de conexión aparecen arriba.'));
      return;
    }
    const entries = matchingMovies(filters());
    const count = entries.reduce((sum, entry) => sum + entry.sessions.length, 0);
    const summary = `${plural(entries.length, 'película', 'películas')} · ${plural(count, 'sesión', 'sesiones')} con los filtros actuales`;
    $('listings-summary').textContent = summary;
    $('results-announcement').textContent = summary;
    if (!entries.length) {
      const hasData = state.snapshot.movies.length > 0;
      els.movies.replaceChildren(emptyState(hasData ? 'Sin resultados para estos filtros' : 'Todavía no hay películas', hasData ? 'Prueba otra fecha, incluye la programación pasada o elige «Todas · incluir vistas» en Mi cartelera.' : 'La instantánea no contiene fichas de películas. Consulta «Cines y cobertura» para conocer el estado de las fuentes.', hasData));
      return;
    }
    const fragment = document.createDocumentFragment();
    entries.forEach((entry, index) => fragment.append(movieCard(entry, index)));
    els.movies.replaceChildren(fragment);
  }
  function eventMatches(event, filter) {
    if (filter.eventType && eventType(event) !== filter.eventType) return false;
    if (cinemaIsClosed(event.cinemaId)) return false;
    const period = Array.isArray(event.venuePeriods) ? event.venuePeriods.find((p) => identifier(p.cinemaId) === filter.cinema) : null;
    if (filter.cinema && identifier(event.cinemaId) !== filter.cinema && !period) return false;
    const startDay = dayKey(period?.startsAt || event.startsAt);
    const endDay = dayKey(period?.endDate || event.endDate) || startDay;
    if (filter.day && (!startDay || filter.day < startDay || filter.day > endDay)) return false;
    if (!filter.past) {
      if (text(event.endDate)) {
        if (endDay && endDay < dayKey(new Date())) return false;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(text(event.startsAt))) {
        if (startDay < dayKey(new Date())) return false;
      } else {
        const start = date(event.startsAt);
        if (start && start.getTime() < Date.now()) return false;
      }
    }
    return true;
  }
  function renderEvents() {
    if (!state.snapshot) {
      els.events.replaceChildren(emptyState('Eventos pendientes', 'Todavía no hay una instantánea disponible.'));
      return;
    }
    const entries = state.snapshot.events.filter((event) => eventMatches(event, filters())).sort((a, b) => (dayDate(a.startsAt)?.getTime() ?? Infinity) - (dayDate(b.startsAt)?.getTime() ?? Infinity));
    const summary = `${plural(entries.length, 'evento', 'eventos')} · Filtros de tipo, cine, fecha y programación pasada`;
    $('events-summary').textContent = summary;
    $('results-announcement').textContent = summary;
    if (!entries.length) {
      els.events.replaceChildren(emptyState('No hay eventos disponibles', state.snapshot.events.length ? 'No hay eventos que coincidan con estos filtros.' : 'No hay eventos publicados en esta instantánea.', state.snapshot.events.length > 0));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const event of entries) {
      const article = element('article', 'event-card');
      const calendar = element('div', 'event-date');
      const start = dayDate(event.startsAt);
      calendar.append(element('span', 'event-day', start ? new Intl.DateTimeFormat('es-ES', { timeZone: TIME_ZONE, day: '2-digit' }).format(start) : '—'));
      calendar.append(element('span', 'event-month', start ? monthFormat.format(start) : 'Sin fecha'));
      const body = element('div');
      body.append(element('p', 'eyebrow', eventTypeLabel(eventType(event))), element('h3', 'event-title', text(event.title) || 'Título pendiente'));
      const venue = strings(event.venues).join(' · ') || (event.cinemaId ? cinemaName(event.cinemaId) : 'Sedes pendientes de confirmar');
      body.append(element('p', 'event-meta', `${venue} · ${formatDateTime(event.startsAt)}${text(event.endDate) ? ` · Hasta ${formatDateTime(event.endDate)}` : ''}`));
      body.append(element('p', 'event-description', text(event.description) || 'Descripción pendiente.'));
      const source = externalLink('Consultar el evento ↗', event.url);
      body.append(source || element('p', 'small-text', 'Enlace del evento pendiente'));
      article.append(calendar, body);
      fragment.append(article);
    }
    els.events.replaceChildren(fragment);
  }
  function coverageRecords() {
    const data = state.snapshot;
    const entries = data.coverage.map((coverage) => ({ cinema: cinemaFor(coverage.cinemaId), coverage }));
    for (const cinema of data.cinemas) {
      if (!data.coverage.some((coverage) => identifier(coverage.cinemaId) === identifier(cinema.id))) entries.push({ cinema, coverage: null });
    }
    return entries;
  }
  function renderCoverage() {
    if (!state.snapshot) {
      els.coverage.replaceChildren(emptyState('Cobertura pendiente', 'Todavía no hay una instantánea disponible.'));
      return;
    }
    const entries = coverageRecords();
    const coveredIds = new Set(state.snapshot.coverage.map((item) => identifier(item.cinemaId)));
    const knownCovered = state.snapshot.cinemas.filter((cinema) => coveredIds.has(identifier(cinema.id))).length;
    const summary = `${knownCovered} de ${state.snapshot.cinemas.length} cines con informe de cobertura · Un estado disponible no garantiza programación completa.`;
    $('coverage-summary').textContent = summary;
    $('results-announcement').textContent = summary;
    if (!entries.length) {
      els.coverage.replaceChildren(emptyState('Sin informes de cobertura', 'El monitor todavía no ha proporcionado cines ni informes de sus fuentes.'));
      return;
    }
    const fragment = document.createDocumentFragment();
    entries.sort((a, b) => collator.compare(text(a.cinema?.name), text(b.cinema?.name)));
    for (const { cinema, coverage } of entries) {
      const card = element('article', 'coverage-card');
      card.append(statusBadge(coverage?.status || 'pending'));
      card.append(element('h3', '', text(cinema?.name) || 'Cine sin identificar'));
      card.append(element('p', 'coverage-address', text(cinema?.address) || 'Dirección pendiente'));
      if (text(cinema?.status)) card.append(element('p', 'small-text', `Estado del cine: ${statusName(cinema.status)}`));
      const count = element('p', 'coverage-count');
      const reported = typeof coverage?.sessions === 'number' && Number.isInteger(coverage.sessions) && coverage.sessions >= 0;
      count.append(element('strong', '', reported ? numberFormat.format(coverage.sessions) : '—'), document.createTextNode(reported ? 'sesiones informadas por la fuente' : 'Recuento pendiente'));
      card.append(count);
      card.append(element('p', 'coverage-message', text(coverage?.message) || (coverage ? 'La fuente no ha proporcionado un mensaje adicional.' : 'No hay informe de cobertura para este cine.')));
      const links = element('div', 'coverage-links');
      const source = externalLink('Fuente de programación ↗', coverage?.sourceUrl);
      const web = externalLink('Web del cine ↗', cinema?.url);
      if (source) links.append(source);
      if (web) links.append(web);
      card.append(links);
      const tariff = tariffReference(cinema);
      if (tariff) card.append(tariff);
      card.append(element('p', 'coverage-checked', `Consulta: ${formatDateTime(coverage?.checkedAt)}`));
      if (isStale(coverage?.checkedAt)) card.append(element('p', 'data-stale', 'Consulta obsoleta · hace más de 24 h'));
      fragment.append(card);
    }
    els.coverage.replaceChildren(fragment);
  }
  function renderNotices() {
    const fragment = document.createDocumentFragment();
    const add = (title, message, error = false) => {
      const notice = element('p', `notice${error ? ' notice-error' : ''}`);
      notice.append(element('strong', '', `${title} `), document.createTextNode(message));
      fragment.append(notice);
    };
    if (window.location.protocol === 'file:') add('Abre el visor desde su dirección web.', 'La cartelera necesita una dirección HTTP o HTTPS para cargar sus datos.', true);
    if (state.snapshotError) add('No se pudo leer la cartelera.', `${state.snapshotError}${state.snapshot ? ' Se conserva la última instantánea recibida.' : ''}`, true);
    if (state.statusError) add('Estado del monitor sin confirmar.', `${state.statusError} Se volverá a consultar automáticamente.`, true);
    if (state.refreshError) add('Solicitud de actualización sin confirmar.', state.refreshError, true);
    if (state.monitorError) add('El monitor ha comunicado un error.', state.monitorError, true);
    if (state.watchedError) add('Películas vistas.', state.watchedError, true);
    const data = state.snapshot;
    if (data) {
      if (!date(data.updatedAt)) add('Actualización sin fecha.', 'El monitor no ha proporcionado una fecha válida; no es posible confirmar la antigüedad de los datos.');
      else if (isStale(data.updatedAt)) add('La cartelera puede estar obsoleta.', STATIC_SITE ? 'Han pasado más de 24 horas desde la consulta de las fuentes. Comprueba los horarios en la web del cine.' : 'Han pasado más de 24 horas desde la actualización. Comprueba las sesiones en la fuente o actualiza el monitor.');
      const withoutReport = data.cinemas.filter((cinema) => !data.coverage.some((item) => identifier(item.cinemaId) === identifier(cinema.id))).length;
      const attention = data.coverage.filter((item) => (!GOOD.has(text(item.status)) && item.status !== 'closed') || isStale(item.checkedAt) || !date(item.checkedAt)).length;
      if (withoutReport || attention || !data.coverage.length) add('Consulta la cobertura.', `${plural(attention, 'informe requiere', 'informes requieren')} atención y ${plural(withoutReport, 'cine no tiene', 'cines no tienen')} informe. La ausencia de sesiones no confirma que una sala no tenga programación.`);
      const movieIds = new Set(data.movies.map((movie) => identifier(movie.id)));
      const orphaned = data.sessions.filter((session) => !movieIds.has(identifier(session.movieId))).length;
      if (orphaned) add('Fichas incompletas.', `${plural(orphaned, 'sesión no tiene', 'sesiones no tienen')} una película asociada y no puede mostrarse en la cartelera agrupada.`);
    }
    els.notices.replaceChildren(fragment);
    els.notices.hidden = !els.notices.childNodes.length;
  }
  function renderHeader() {
    const data = state.snapshot;
    if (data) {
      const upcoming = data.sessions.filter((session) => {
        const starts = date(session.startsAt);
        return starts && starts.getTime() >= Date.now() && !cinemaIsClosed(session.cinemaId) && !['cancelled', 'canceled', 'expired'].includes(text(session.status));
      });
      $('stat-movies').textContent = numberFormat.format(data.movies.length);
      $('stat-sessions').textContent = numberFormat.format(upcoming.length);
      $('stat-cinemas').textContent = numberFormat.format(new Set(upcoming.map((session) => identifier(session.cinemaId)).filter((id) => cinemaFor(id))).size);
      $('count-listings').textContent = numberFormat.format(data.movies.length);
      $('count-events').textContent = numberFormat.format(data.events.length);
      $('updated-at').textContent = date(data.updatedAt) ? `Actualizada el ${formatDateTime(data.updatedAt)}` : 'Fecha de actualización pendiente';
    }
    const busy = state.starting || state.running;
    els.refresh.disabled = busy || state.initializing || window.location.protocol === 'file:';
    els.refresh.classList.toggle('is-running', busy);
    els.refreshLabel.textContent = state.starting ? (STATIC_SITE ? 'Cargando…' : 'Solicitando…') : state.running ? 'Actualizando…' : STATIC_SITE ? 'Recargar cartelera' : 'Actualizar cartelera';
    els.refresh.setAttribute('aria-busy', String(busy));
    els.refreshStatus.textContent = STATIC_SITE
      ? (state.initializing || busy ? 'Cargando la última publicación…' : 'Consulta la fecha de actualización. Recargar muestra la última cartelera publicada.')
      : state.statusError ? 'Sin conexión con el estado del monitor.'
      : busy ? 'El monitor está consultando las fuentes. Puedes seguir explorando.'
      : state.initializing ? 'Conectando con el monitor…'
      : state.monitorError ? 'La última actualización comunicó un error.'
      : state.statusKnown ? 'Monitor en reposo · Actualización manual disponible.'
      : 'Estado del monitor pendiente.';
    els.movies.setAttribute('aria-busy', String(state.loading));
    renderNotices();
  }
  function renderView() {
    // Una respuesta de red o la búsqueda diferida no deben quitar el foco de una ficha abierta.
    if (els.dialog.open) { state.deferredRender = true; return; }
    if (state.view === 'listings') renderListings();
    if (state.view === 'events') renderEvents();
    if (state.view === 'coverage') renderCoverage();
  }
  function changeView(view, focus = false) {
    state.view = view;
    document.querySelectorAll('[data-view]').forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`panel-${tab.dataset.view}`).hidden = !selected;
      if (selected && focus) tab.focus();
    });
    $('filters-sidebar').hidden = view === 'coverage';
    $('workspace').classList.toggle('coverage-view', view === 'coverage');
    document.querySelectorAll('.movie-filter').forEach((field) => { field.hidden = view !== 'listings'; });
    document.querySelectorAll('.event-filter').forEach((field) => { field.hidden = view !== 'events'; });
    renderView();
  }
  function resetFilters() {
    els.form.reset();
    $('sort').value = 'next';
  }

  async function requestJSON(path, method = 'GET') {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(`Respuesta HTTP ${response.status}.`);
      try { return await response.json(); }
      catch { throw new Error('El servidor no devolvió JSON válido.'); }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('El servidor no respondió en 20 segundos.');
      if (error instanceof TypeError) throw new Error(STATIC_SITE ? 'No se pudo descargar la cartelera publicada.' : 'No se pudo conectar con el servidor local.');
      throw error;
    } finally { window.clearTimeout(timeout); }
  }
  function validateSnapshot(value) {
    if (!record(value) || !['cinemas', 'movies', 'sessions', 'events', 'coverage'].every((key) => Array.isArray(value[key]))) throw new Error('La instantánea no tiene el esquema esperado.');
    const result = { updatedAt: text(value.updatedAt) };
    for (const key of ['cinemas', 'movies', 'sessions', 'events', 'coverage']) result[key] = value[key].filter(record);
    return result;
  }
  async function readSnapshot() {
    const epoch = ++state.snapshotEpoch;
    state.lastSnapshotRead = Date.now();
    let changed = false;
    try {
      const snapshot = validateSnapshot(await requestJSON(STATIC_SITE ? './data/snapshot.json' : '/api/snapshot'));
      if (epoch !== state.snapshotEpoch) return;
      const fingerprint = JSON.stringify(snapshot);
      changed = fingerprint !== state.snapshotFingerprint;
      if (changed) {
        state.snapshot = snapshot;
        state.snapshotFingerprint = fingerprint;
        updateFilterOptions();
      }
      state.snapshotError = '';
    } catch (error) {
      if (epoch !== state.snapshotEpoch) return;
      state.snapshotError = error.message;
    } finally {
      if (epoch === state.snapshotEpoch) {
        state.loading = false;
        renderHeader();
        if (changed || !state.snapshot) renderView();
      }
    }
  }
  function validateStatus(value) {
    if (!record(value) || typeof value.running !== 'boolean') throw new Error('El estado recibido no incluye «running» como booleano.');
    return value;
  }
  function applyStatus(value) {
    state.running = value.running;
    state.monitorError = text(value.error) || (value.error ? 'Error sin descripción proporcionada por el monitor.' : '');
    state.statusKnown = true;
    state.statusError = '';
    state.failures = 0;
    renderHeader();
  }
  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    if (STATIC_SITE || document.hidden || window.location.protocol === 'file:') return;
    const delay = state.failures ? Math.min(30000, 3000 * 2 ** Math.min(state.failures - 1, 4)) : state.running ? 1800 : 30000;
    state.pollTimer = window.setTimeout(pollStatus, delay);
  }
  async function pollStatus() {
    if (STATIC_SITE) { await readSnapshot(); return; }
    if (state.starting) { schedulePoll(); return; }
    const epoch = state.statusEpoch;
    try {
      const status = validateStatus(await requestJSON('/api/status'));
      if (epoch !== state.statusEpoch) return;
      const wasRunning = state.running;
      applyStatus(status);
      if (!status.running || wasRunning !== status.running || Date.now() - state.lastSnapshotRead >= 10000) await readSnapshot();
    } catch (error) {
      if (epoch !== state.statusEpoch) return;
      state.statusError = error.message;
      state.failures += 1;
      renderHeader();
    } finally {
      if (epoch === state.statusEpoch) schedulePoll();
    }
  }
  async function refresh() {
    if (state.starting || state.running || state.initializing) return;
    if (STATIC_SITE) {
      state.starting = true;
      renderHeader();
      try { await readSnapshot(); }
      finally { state.starting = false; renderHeader(); }
      return;
    }
    state.statusEpoch += 1;
    window.clearTimeout(state.pollTimer);
    state.starting = true;
    state.refreshError = '';
    renderHeader();
    try {
      const status = validateStatus(await requestJSON('/api/refresh', 'POST'));
      applyStatus(status);
      if (!status.running) await readSnapshot();
    } catch (error) {
      // Un POST sin respuesta puede haber iniciado el trabajo: consultar estado sin repetirlo.
      state.refreshError = `${error.message} Se consultará el estado sin repetir automáticamente la solicitud.`;
    } finally {
      state.starting = false;
      renderHeader();
      await pollStatus();
    }
  }
  async function initialize() {
    loadWatchedMovies();
    if (window.matchMedia('(max-width: 800px)').matches) $('filter-details').open = false;
    if (window.location.protocol === 'file:') {
      state.loading = false;
      state.initializing = false;
      renderHeader();
      renderView();
      return;
    }
    if (STATIC_SITE) {
      await readSnapshot();
      state.initializing = false;
      renderHeader();
      return;
    }
    const results = await Promise.allSettled([readSnapshot(), requestJSON('/api/status').then(validateStatus)]);
    const statusResult = results[1];
    if (statusResult.status === 'fulfilled') applyStatus(statusResult.value);
    else { state.statusError = statusResult.reason.message; state.failures += 1; }
    if (results[0].status === 'rejected') state.snapshotError = results[0].reason.message;
    state.initializing = false;
    renderHeader();
    schedulePoll();
  }

  let searchTimer;
  els.form.addEventListener('submit', (event) => event.preventDefault());
  els.form.addEventListener('input', (event) => {
    if (event.target.id !== 'search') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderView, 160);
  });
  els.form.addEventListener('change', () => { window.clearTimeout(searchTimer); renderView(); });
  els.form.addEventListener('reset', () => {
    window.clearTimeout(searchTimer);
    $('sort').value = 'next';
    // El evento reset precede a la restauración nativa de los controles.
    window.setTimeout(renderView, 0);
  });
  $('sort').addEventListener('change', renderView);
  $('undo-watched').addEventListener('click', () => {
    if (state.undoWatched) setWatched(state.undoWatched.movie, state.undoWatched.watched, true);
  });
  $('dismiss-watched').addEventListener('click', () => {
    const movie = state.undoWatched?.movie;
    $('watched-feedback').hidden = true;
    state.undoWatched = null;
    focusMovieOrFilter(movie);
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    loadWatchedMovies();
    renderNotices();
    if (els.dialog.open) {
      const movie = state.snapshot?.movies.find((item) => identifier(item.id) === state.dialogMovieId);
      const button = els.dialogContent.querySelector('.watched-button');
      if (movie && button) {
        const focused = document.activeElement === button;
        const replacement = watchedButton(movie);
        button.replaceWith(replacement);
        if (focused) replacement.focus({ preventScroll: true });
      }
    }
    renderView();
  });
  els.refresh.addEventListener('click', refresh);
  document.querySelectorAll('[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => changeView(tab.dataset.view));
    tab.addEventListener('keydown', (event) => {
      const tabs = [...document.querySelectorAll('[data-view]')];
      const index = tabs.indexOf(tab);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); changeView(tabs[next].dataset.view, true); }
    });
  });
  $('close-dialog').addEventListener('click', () => els.dialog.close());
  els.dialog.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
    if (state.deferredRender) { state.deferredRender = false; renderView(); }
    const card = [...document.querySelectorAll('.movie-card')].find((item) => item.dataset.movieId === state.dialogMovieId);
    const target = state.dialogOpener?.isConnected ? state.dialogOpener : card?.querySelector('.title-button') || $('tab-listings');
    if (state.feedbackFocus) { state.feedbackFocus = false; $('undo-watched').focus({ preventScroll: true }); }
    else target?.focus({ preventScroll: true });
    state.dialogOpener = null;
  });
  els.dialog.addEventListener('click', (event) => {
    if (event.target !== els.dialog) return;
    const bounds = els.dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) els.dialog.close();
  });
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer);
    if (!document.hidden && !state.initializing && window.location.protocol !== 'file:') {
      state.statusEpoch += 1;
      renderHeader();
      pollStatus();
    }
  });
  window.addEventListener('online', () => {
    if (state.initializing || window.location.protocol === 'file:') return;
    window.clearTimeout(state.pollTimer);
    state.statusEpoch += 1;
    pollStatus();
  });
  initialize();
})();
