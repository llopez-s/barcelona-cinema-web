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
  // Familias del filtro «Género». Las fichas siguen mostrando las etiquetas de cada fuente.
  const GENRE_FAMILIES = [
    ['drama', 'Drama', ['Drama']],
    ['comedia', 'Comedia', ['Comedia', 'Comedia dramática', 'Comèdia', 'Comedy']],
    ['romance', 'Romance', ['Romance', 'Romántico', 'Romanç', 'Romàntic']],
    ['accion', 'Acción y aventuras', ['Acción', 'Acció', 'Action', 'Aventura', 'Aventuras', 'Aventures', 'Adventure', 'Western']],
    ['thriller', 'Thriller y crimen', ['Thriller', 'Suspense', 'Intriga', 'Cine negro', 'Cinema negre', 'Crimen', 'Crim', 'Crime']],
    ['terror', 'Terror', ['Terror', 'Horror']],
    ['fantastico', 'Fantástico y ciencia ficción', ['Fantástico', 'Fantàstic', 'Fantasía', 'Fantasy', 'Ciencia ficción', 'Ciència ficció', 'Science Fiction']],
    ['animacion', 'Animación e infantil', ['Animación', 'Animació', 'Animation', 'Infantil']],
    ['historico', 'Histórico y bélico', ['Histórico', 'Històric', 'History', 'Bélico', 'Bèl·lic', 'Guerra', 'War']],
    ['musical', 'Musical', ['Musical']],
    ['documental', 'Documental', ['Documental', 'Documentary']],
    ['otros', 'Otros', ['Short', 'Cortometraje', 'Curtmetratge', 'Serie de TV']],
  ];
  const GENRE_FILTERS = GENRE_FAMILIES.map(([key, label]) => [key, label]);
  const GENRE_ALIASES = new Map(GENRE_FAMILIES.flatMap(([key, , labels]) => labels.map((label) => [normalize(label), key])));
  const UNGROUPED = 'etiqueta:';
  function genreKeys(genres) {
    const labels = Array.isArray(genres) ? genres.map(normalize).filter(Boolean) : [];
    const families = GENRE_FILTERS.map(([key]) => key).filter((key) => labels.some((label) => GENRE_ALIASES.get(label) === key));
    // Una etiqueta nueva sigue siendo filtrable hasta asignarla a una familia.
    const ungrouped = labels.filter((label) => !GENRE_ALIASES.has(label)).map((label) => UNGROUPED + label);
    return [...families, ...new Set(ungrouped)];
  }
  function genreOptions(movies) {
    const keys = new Set();
    const ungrouped = new Map();
    for (const movie of Array.isArray(movies) ? movies : []) {
      const genres = Array.isArray(movie?.genres) ? movie.genres : [];
      for (const key of genreKeys(genres)) keys.add(key);
      for (const label of genres) {
        const key = UNGROUPED + normalize(label);
        if (keys.has(key) && !ungrouped.has(key)) ungrouped.set(key, label.trim());
      }
    }
    const extra = [...ungrouped].sort((a, b) => a[1].localeCompare(b[1], 'es', { sensitivity: 'base' }));
    return [...GENRE_FILTERS.filter(([key]) => keys.has(key)), ...extra];
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

  const api = { STORAGE_KEY, LANGUAGE_FILTERS, GENRE_FILTERS, languageCategory, languageLabel, languageName, genreKeys, genreOptions, createWatchedStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CinemaPreferences = Object.freeze(api);
})(globalThis);
