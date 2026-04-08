const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SCREENS_FILE = path.join(__dirname, 'screens.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.use('/player', express.static(path.join(__dirname, 'player')));

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

let settings = { defaultImageUrl: null };
if (fs.existsSync(SETTINGS_FILE)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (e) {
    console.warn('Could not parse settings.json');
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// --- Storage ---

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// screens = { [screenId]: { id, name, playlist: [] } }
let screens = {};
if (fs.existsSync(SCREENS_FILE)) {
  try {
    screens = JSON.parse(fs.readFileSync(SCREENS_FILE, 'utf-8'));
    console.log(`Loaded ${Object.keys(screens).length} screens`);
  } catch (e) {
    console.warn('Could not parse screens.json, starting fresh');
  }
}

// track which screenIds are currently connected
const onlineScreens = new Set();

function saveScreens() {
  fs.writeFileSync(SCREENS_FILE, JSON.stringify(screens, null, 2));
}

function getScreenOrError(res, screenId) {
  if (!screens[screenId]) {
    res.status(404).json({ error: 'Screen not found' });
    return null;
  }
  return screens[screenId];
}

// --- Library (shared uploads) ---

// Get all uploaded files
app.get('/api/library', (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).map(filename => {
    const ext = path.extname(filename).toLowerCase();
    const videoExts = ['.mp4', '.webm', '.ogg', '.mov'];
    return {
      filename,
      url: `/uploads/${filename}`,
      type: videoExts.includes(ext) ? 'video' : 'image'
    };
  });
  res.json(files);
});

// Upload a new file to the shared library
app.post('/api/library/upload', upload.single('file'), (req, res) => {
  const file = req.file;
  const ext = path.extname(file.originalname).toLowerCase();
  const videoExts = ['.mp4', '.webm', '.ogg', '.mov'];
  const item = {
    filename: file.filename,
    originalName: file.originalname,
    type: videoExts.includes(ext) ? 'video' : 'image',
    url: `/uploads/${file.filename}`
  };
  res.json(item);
});

// Delete a file from the shared library
app.delete('/api/library/:filename', (req, res) => {
  const filename = req.params.filename;
  fs.unlink(path.join(UPLOADS_DIR, filename), () => {});

  // Remove from all playlists
  Object.values(screens).forEach(screen => {
    screen.playlist = screen.playlist.filter(p => p.filename !== filename);
  });
  saveScreens();

  // Notify all affected players
  Object.values(screens).forEach(screen => {
    io.to(screen.id).emit('playlist-updated', screen.playlist);
  });

  res.json({ success: true });
});

// --- Screens ---

// Get all screens (with online status)
app.get('/api/screens', (req, res) => {
  const result = Object.values(screens).map(s => ({
    ...s,
    online: onlineScreens.has(s.id)
  }));
  res.json(result);
});

// Create a new screen
app.post('/api/screens', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (screens[id]) return res.status(400).json({ error: 'A screen with that name already exists' });

  screens[id] = { id, name, playlist: [], active: true };
  saveScreens();
  io.emit('screens-updated', Object.values(screens));
  res.json(screens[id]);
});

// Delete a screen
app.delete('/api/screens/:id', (req, res) => {
  const { id } = req.params;
  if (!screens[id]) return res.status(404).json({ error: 'Screen not found' });
  delete screens[id];
  saveScreens();
  io.emit('screens-updated', Object.values(screens));
  res.json({ success: true });
});

// --- Playlists (per screen) ---

// Get a screen's playlist
app.get('/api/screens/:id/playlist', (req, res) => {
  const screen = getScreenOrError(res, req.params.id);
  if (!screen) return;
  res.json(screen.playlist);
});

// Add a library item to a screen's playlist
app.post('/api/screens/:id/playlist', (req, res) => {
  const screen = getScreenOrError(res, req.params.id);
  if (!screen) return;

  const { filename, originalName, type, url, duration } = req.body;
  const item = {
    id: Date.now(),
    filename,
    originalName,
    type,
    url,
    duration: parseInt(duration) || 10
  };
  screen.playlist.push(item);
  saveScreens();
  io.to(screen.id).emit('playlist-updated', screen.playlist);
  res.json(item);
});

// Remove item from a screen's playlist
app.delete('/api/screens/:screenId/playlist/:itemId', (req, res) => {
  const screen = getScreenOrError(res, req.params.screenId);
  if (!screen) return;
  screen.playlist = screen.playlist.filter(p => p.id !== parseInt(req.params.itemId));
  saveScreens();
  io.to(screen.id).emit('playlist-updated', screen.playlist);
  res.json({ success: true });
});

// Reorder a screen's playlist
app.post('/api/screens/:id/playlist/reorder', (req, res) => {
  const screen = getScreenOrError(res, req.params.id);
  if (!screen) return;
  const { order } = req.body;
  screen.playlist = order.map(id => screen.playlist.find(p => p.id === id)).filter(Boolean);
  saveScreens();
  io.to(screen.id).emit('playlist-updated', screen.playlist);
  res.json({ success: true });
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(settings);
});

// Upload default image
app.post('/api/settings/default-image', upload.single('file'), (req, res) => {
  const ext = path.extname(req.file.originalname).toLowerCase();
  const videoExts = ['.mp4', '.webm', '.ogg', '.mov'];
  settings.defaultImageUrl = `/uploads/${req.file.filename}`;
  settings.defaultImageType = videoExts.includes(ext) ? 'video' : 'image';
  saveSettings();
  io.emit('settings-updated', settings);
  res.json(settings);
});

// Toggle screen on/off
app.post('/api/screens/:id/toggle', (req, res) => {
  const screen = getScreenOrError(res, req.params.id);
  if (!screen) return;
  screen.active = !screen.active;
  saveScreens();
  io.to(screen.id).emit('screen-toggled', { 
  active: screen.active, 
  defaultImageUrl: settings.defaultImageUrl,
  defaultImageType: settings.defaultImageType
});
  res.json({ active: screen.active });
});

// --- Sockets ---

io.on('connection', (socket) => {
  const screenId = socket.handshake.query.screenId;

  if (screenId) {
    socket.join(screenId);
    onlineScreens.add(screenId);
    console.log(`Player connected: ${screenId}`);
    io.emit('screen-status', { screenId, online: true });

    // Send current playlist to this player
    if (screens[screenId]) {
      socket.emit('playlist-updated', screens[screenId].playlist);
    }
  }

  socket.on('disconnect', () => {
    if (screenId) {
      onlineScreens.delete(screenId);
      console.log(`Player disconnected: ${screenId}`);
      io.emit('screen-status', { screenId, online: false });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});