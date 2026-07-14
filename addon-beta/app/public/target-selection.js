(function exposeTargetSelection(root, factory) {
  const value = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = value;
  root.MediaLauncherTargetSelection = value;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function decidePlaybackTarget(result) {
    const targets = Array.isArray(result?.targets) ? result.targets : [];
    const onlineTargets = targets.filter((target) => target.online);
    if (!onlineTargets.length) {
      return {
        action: 'error',
        message: targets.length
          ? 'All paired playback targets are offline.'
          : 'No playback targets are paired yet. Open Settings to connect one.',
      };
    }

    const configuredDefault = targets.find(
      (target) => target.id === result.defaultPlaybackTargetId
    );
    if (result.defaultPlaybackTargetId && (!configuredDefault || !configuredDefault.online)) {
      return { action: 'pick' };
    }
    if (onlineTargets.length === 1) return { action: 'target', target: onlineTargets[0] };

    const preferred = onlineTargets.find(
      (target) => target.id === result.defaultPlaybackTargetId
    );
    if (!result.alwaysAskPlaybackTarget && preferred) {
      return { action: 'target', target: preferred };
    }
    return { action: 'pick' };
  }

  return { decidePlaybackTarget };
}));
