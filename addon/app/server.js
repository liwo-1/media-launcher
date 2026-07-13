require('dotenv').config();

const path = require('path');
const express = require('express');
const apiRoutes = require('./src/routes/api');
const plexAuthRoutes = require('./src/routes/plex-auth');
const settingsRoutes = require('./src/routes/settings');
const { requireAdminPin } = require('./src/admin-auth');

const PORT = process.env.PORT || 8088;

const app = express();
app.use(express.json());
app.use('/api/plex-auth', requireAdminPin, plexAuthRoutes);
app.use('/api/settings', requireAdminPin, settingsRoutes);
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`media-launcher listening on 0.0.0.0:${PORT}`);
});
