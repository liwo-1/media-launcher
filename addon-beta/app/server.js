'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const apiRoutes = require('./src/routes/api');
const jellyfinAuthRoutes = require('./src/routes/jellyfin-auth');
const plexAuthRoutes = require('./src/routes/plex-auth');
const settingsRoutes = require('./src/routes/settings');
const playerAgentRoutes = require('./src/routes/player-agent');
const { requireAdminPin } = require('./src/admin-auth');
const { listTargets, readAgentStore } = require('./src/agent-store');
const { publicProviderState } = require('./src/provider-manager');
const { createMediaRouter } = require('./src/routes/media');

const PORT = process.env.PORT || 8088;

function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
}

function privateApiHeaders(_req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
  res.vary('X-Admin-Pin');
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/bootstrap', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      mediaServer: publicProviderState(),
      playback: { hasTargets: listTargets(readAgentStore()).length > 0 },
    });
  });
  app.use('/api/player-agent', playerAgentRoutes);
  app.use(['/api/plex-auth', '/api/jellyfin-auth', '/api/settings'], privateApiHeaders);
  app.use('/api/plex-auth', requireAdminPin, plexAuthRoutes);
  app.use('/api/jellyfin-auth', requireAdminPin, jellyfinAuthRoutes);
  app.use('/api/settings', requireAdminPin, settingsRoutes);
  app.use('/api/media', createMediaRouter());
  app.use('/api', apiRoutes);
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && Object.hasOwn(error, 'body')) {
      return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    console.error(`request failed: ${error?.message || error}`);
    return res.status(500).json({ error: 'The request could not be completed.' });
  });
  return app;
}

if (require.main === module) {
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`media-launcher listening on 0.0.0.0:${PORT}`);
  });
}

module.exports = { createApp, privateApiHeaders, securityHeaders };
