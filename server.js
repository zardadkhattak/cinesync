const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');
const cors    = require('cors');

const app = express();
app.use(cors());

// ─── Serve frontend static files ─────────────────────────────────
// In production (Railway), frontend files are in ../public/
// In local dev, they are in the parent directory (c:\xampp\htdocs\movieswatch\)
const FRONTEND_DIR = path.join(__dirname, 'public');
app.use(express.static(FRONTEND_DIR));

// Fallback: serve index.html for any unknown route (SPA support)
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Room store: { roomCode: [socketId1, socketId2] }
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ─── JOIN ROOM ───────────────────────────────────────────────
  socket.on('join-room', (roomCode, callback) => {
    const code = roomCode.toUpperCase().trim();

    if (!rooms[code]) rooms[code] = [];

    if (rooms[code].length >= 2) {
      callback({ success: false, error: 'Room is full (max 2 users)' });
      return;
    }

    rooms[code].push(socket.id);
    socket.join(code);
    socket.roomCode = code;

    const isHost = rooms[code].length === 1;
    callback({ success: true, isHost, userCount: rooms[code].length });

    // Notify other user that someone joined
    socket.to(code).emit('peer-joined', { socketId: socket.id });
    console.log(`[Room ${code}] ${socket.id} joined (${rooms[code].length}/2) host=${isHost}`);
  });

  // ─── WEBRTC SIGNALING ─────────────────────────────────────────
  socket.on('webrtc-offer', (data) => {
    socket.to(socket.roomCode).emit('webrtc-offer', data);
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(socket.roomCode).emit('webrtc-answer', data);
  });

  socket.on('webrtc-ice', (data) => {
    socket.to(socket.roomCode).emit('webrtc-ice', data);
  });

  // ─── VIDEO SYNC ───────────────────────────────────────────────
  socket.on('video-play', (data) => {
    socket.to(socket.roomCode).emit('video-play', data);
    console.log(`[Room ${socket.roomCode}] PLAY @ ${data.currentTime}`);
  });

  socket.on('video-pause', (data) => {
    socket.to(socket.roomCode).emit('video-pause', data);
    console.log(`[Room ${socket.roomCode}] PAUSE @ ${data.currentTime}`);
  });

  socket.on('video-seek', (data) => {
    socket.to(socket.roomCode).emit('video-seek', data);
    console.log(`[Room ${socket.roomCode}] SEEK → ${data.currentTime}`);
  });

  socket.on('video-load', (data) => {
    socket.to(socket.roomCode).emit('video-load', data);
    console.log(`[Room ${socket.roomCode}] LOAD: ${data.url} (type: ${data.type})`);
  });

  // ─── CHAT ─────────────────────────────────────────────────────
  socket.on('chat-message', (data) => {
    const msg = {
      text: data.text,
      sender: data.sender || 'Partner',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    socket.to(socket.roomCode).emit('chat-message', msg);
  });

  // ─── DISCONNECT ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      rooms[code] = rooms[code].filter(id => id !== socket.id);
      if (rooms[code].length === 0) {
        delete rooms[code];
        console.log(`[Room ${code}] Deleted (empty)`);
      } else {
        io.to(code).emit('peer-left');
        console.log(`[Room ${code}] ${socket.id} left`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 CineSync Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
