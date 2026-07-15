(function exposeMediaModel(root, factory) {
  const value = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = value;
  root.MediaLauncherMediaModel = value;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function routeForItem(item) {
    const kind = String(item?.kind || '').toLowerCase();
    const itemId = String(item?.id || '');
    const seriesId = String(item?.hierarchy?.seriesId || '');
    if ((kind === 'episode' || kind === 'season') && seriesId) {
      return `#/series/${encodeURIComponent(seriesId)}`;
    }
    if (kind === 'series') return `#/series/${encodeURIComponent(itemId)}`;
    return `#/item/${encodeURIComponent(itemId)}`;
  }

  function progressPercent(item) {
    const position = Number(item?.resumePositionMs);
    const duration = Number(item?.durationMs);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return 0;
    return Math.max(0, Math.min(100, (position / duration) * 100));
  }

  function cardPresentation(item, context = 'default') {
    const kind = String(item?.kind || '').toLowerCase();
    const hierarchy = item?.hierarchy || {};
    if (kind === 'episode') {
      return {
        title: hierarchy.seriesTitle || item?.title || '',
        subtitle: context === 'recent'
          ? hierarchy.seasonTitle || (hierarchy.seasonNumber
            ? `Season ${hierarchy.seasonNumber}`
            : item?.title || '')
          : item?.title || '',
      };
    }
    return {
      title: item?.title || '',
      subtitle: item?.year ? String(item.year) : '',
    };
  }

  function recentPresentation(items) {
    const entries = [];
    const seenEpisodeGroups = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.kind === 'episode') {
        const hierarchy = item.hierarchy || {};
        const groupId = hierarchy.seasonId ||
          `${hierarchy.seriesId || item.id || ''}:${hierarchy.seasonNumber || ''}`;
        if (seenEpisodeGroups.has(groupId)) continue;
        seenEpisodeGroups.add(groupId);
      }
      entries.push({ item, ...cardPresentation(item, 'recent') });
    }
    return entries;
  }

  return { routeForItem, progressPercent, cardPresentation, recentPresentation };
}));
