/* Shared presentation rules; source records are never changed. */
((root) => {
  'use strict';

  const STORAGE_KEY = 'barcelona-cinema.watched.v1';
  const LANGUAGE_FILTERS = [
    ['original', 'Versión original · VO / VOSC / VOSE'],
    ['dubbed', 'Doblada'],
    ['unknown', 'Versión sin confirmar'],
  ];
  const normalize = (value) => typeof value === 'string'
    ? value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : '';
  function isLanguage(value, code) {
    const names = code === 'es' ? ['es', 'spa', 'esp', 'castellano', 'castella', 'espanol', 'spanish']
      : ['ca', 'cat', 'catalan', 'catala', 'catalonian'];
    return normalize(value).replace(/_/g, '-').split(/[\s,;/|+]+/)
      .some((token) => names.includes(token) || token.startsWith(`${code}-`));
  }
  function versionInfo(language) {
    const info = language && typeof language === 'object' ? language : {};
    const version = normalize(info.version).replace(/\./g, '');
    const original = /^(?:vo(?:s(?:e|c|cat)?|e|cat)?|ve|vc|original|version original|versio original)(?:\b|$)/.test(version);
    const dubbed = /^(?:vd[ce]?|doblada|doblado|doblat|dubbed)(?:\b|$)/.test(version);
    // Audio castellano/catalán no demuestra doblaje. VO no demuestra subtítulos.
    const spanish = isLanguage(info.subtitles, 'es') || (!normalize(info.subtitles) && /^vose\b/.test(version));
    const catalan = isLanguage(info.subtitles, 'ca') || (!normalize(info.subtitles) && /^vos(?:c|cat)\b/.test(version));
    return { original, dubbed, spanish, catalan };
  }
  function languageCategory(language) {
    const info = versionInfo(language);
    if (info.dubbed) return 'dubbed';
    if (info.original) return 'original';
    return 'unknown';
  }
  function languageLabel(language) {
    const info = versionInfo(language);
    if (info.dubbed) return 'Doblada';
    if (info.original) return info.spanish ? 'VOSE' : info.catalan ? 'VOSC' : 'VO';
    return 'Versión sin confirmar';
  }
  function languageName(value) {
    if (isLanguage(value, 'es') && isLanguage(value, 'ca')) return 'Castellano / catalán';
    if (isLanguage(value, 'es')) return 'Castellano';
    if (isLanguage(value, 'ca')) return 'Catalán';
    return { en: 'Inglés', fr: 'Francés', it: 'Italiano', de: 'Alemán', ja: 'Japonés' }[normalize(value)] || value;
  }
  function movieKeys(movie) {
    // Solo identificadores explícitos; nunca se agrupan remakes por título.
    const merged = Array.isArray(movie.mergedIds) ? movie.mergedIds.map((id) => ['id', id]) : [];
    return [['id', movie.id], ['imdb', movie.imdbId], ['fa', movie.filmaffinityId], ...merged]
      .filter(([, value]) => (typeof value === 'string' || typeof value === 'number') && String(value).trim())
      .map(([provider, value]) => `${provider}:${String(value).trim()}`);
  }
  function createWatchedStore(getStorage) {
    let entries = [];
    const matches = (entry, keys) => entry.keys.some((key) => keys.includes(key));
    function reload() {
      const raw = getStorage().getItem(STORAGE_KEY);
      const saved = raw === null ? { version: 1, movies: [] } : JSON.parse(raw);
      if (saved?.version !== 1 || !Array.isArray(saved.movies) || !saved.movies.every((entry) =>
        entry && Array.isArray(entry.keys) && entry.keys.length && entry.keys.every((key) => typeof key === 'string' && key.length))) {
        throw new Error('La lista de películas vistas no tiene un formato válido.');
      }
      entries = saved.movies;
    }
    function has(movie) { return entries.some((entry) => matches(entry, movieKeys(movie))); }
    function set(movie, watched) {
      const keys = movieKeys(movie);
      if (!keys.length) throw new Error('La película no tiene un identificador estable.');
      // Releer antes de escribir incorpora los cambios de otras pestañas.
      reload();
      const previous = entries.filter((entry) => matches(entry, keys));
      const next = entries.filter((entry) => !matches(entry, keys));
      if (watched) next.push({
        keys: [...new Set([...keys, ...previous.flatMap((entry) => entry.keys)])],
        title: typeof movie.title === 'string' ? movie.title : '',
      });
      // No ocultar una película si el navegador rechaza el guardado.
      getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, movies: next }));
      entries = next;
    }
    return { reload, has, set };
  }

  const api = { STORAGE_KEY, LANGUAGE_FILTERS, languageCategory, languageLabel, languageName, createWatchedStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CinemaPreferences = Object.freeze(api);
})(globalThis);
