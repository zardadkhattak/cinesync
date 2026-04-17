/* ═══════════════════════════════════════════════════════════════════
   CineSync — room.js
   Handles: Socket.io connection, WebRTC video chat, video sync
   ═══════════════════════════════════════════════════════════════════ */

// ─── CONFIG ──────────────────────────────────────────────────────
const SERVER_URL = sessionStorage.getItem('cs_server') || window.location.origin;
const ROOM_CODE  = sessionStorage.getItem('cs_room') || new URLSearchParams(location.search).get('room') || '';
const MY_ROLE    = sessionStorage.getItem('cs_role') || 'guest';

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// ─── STATE ───────────────────────────────────────────────────────
let socket           = null;
let peerConnection   = null;
let localStream      = null;
let isHost           = MY_ROLE === 'host';
let isConnected      = false;
let videoMode        = null;   // 'youtube' | 'mp4'
let ytPlayer         = null;
let isSyncingLocally = false;  // prevent echo loops
let isMuted          = false;  // video/audio player mute
let isCamOn          = true;   // webcam video on/off
let isMicOn          = true;   // microphone on/off
let ytApiReady       = false;  // YouTube IFrame API loaded flag
let ytPlayerReady    = false;  // YT.Player instance is ready to receive commands
let pendingVideoLoad = null;   // { url, type } queued before YT was ready
let pendingPlay      = null;   // currentTime to seek+play when player becomes ready
let currentVideo     = null;   // { url, type } track what's loaded (for re-broadcasting)

// ─── DOM REFS ─────────────────────────────────────────────────────
const statusOverlay  = document.getElementById('status-overlay');
const statusText     = document.getElementById('status-text');
const syncBadge      = document.getElementById('sync-badge');
const syncLabel      = document.getElementById('sync-label');
const roomCodeLabel  = document.getElementById('room-code-label');

const localVideo     = document.getElementById('local-video');
const remoteVideo    = document.getElementById('remote-video');
const selfBubble     = document.getElementById('bubble-self');
const partnerBubble  = document.getElementById('bubble-partner');
const partnerOffline = document.getElementById('partner-offline');

const ytWrapper      = document.getElementById('yt-wrapper');
const mp4Wrapper     = document.getElementById('mp4-wrapper');
const mp4Player      = document.getElementById('mp4-player');
const videoEmpty     = document.getElementById('video-empty');

const btnPlayPause   = document.getElementById('btn-play-pause');
const iconPlay       = document.getElementById('icon-play');
const iconPause      = document.getElementById('icon-pause');
const btnMute        = document.getElementById('btn-mute');
const seekInput      = document.getElementById('seek-input');
const seekFill       = document.getElementById('seek-fill');
const timeCurrent    = document.getElementById('time-current');
const timeDuration   = document.getElementById('time-duration');

const modalOverlay   = document.getElementById('modal-overlay');
const btnLoadVideo   = document.getElementById('btn-load-video');
const btnLoadEmpty   = document.getElementById('btn-load-empty');
const btnLoadConfirm = document.getElementById('btn-load-confirm');
const btnModalClose  = document.getElementById('btn-modal-close');
const inputYtUrl     = document.getElementById('input-yt-url');
const inputDirectUrl = document.getElementById('input-direct-url');

const chatPanel      = document.getElementById('chat-panel');
const chatMessages   = document.getElementById('chat-messages');
const chatInput      = document.getElementById('chat-input');
const btnChatSend    = document.getElementById('btn-chat-send');
const btnToggleChat  = document.getElementById('btn-toggle-chat');
const btnChatClose   = document.getElementById('btn-chat-close');
const chatUnread     = document.getElementById('chat-unread');

const toast          = document.getElementById('toast');

// ─── UTILITIES ───────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function formatTime(secs) {
  if (isNaN(secs) || !isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setSyncStatus(state, label) {
  syncBadge.className = `sync-badge ${state}`;
  syncLabel.textContent = label;
}

function hideStatusOverlay() {
  statusOverlay.style.opacity = '0';
  statusOverlay.style.transition = 'opacity 0.4s';
  setTimeout(() => statusOverlay.style.display = 'none', 400);
}

function setPlayPauseUI(playing) {
  iconPlay.style.display  = playing ? 'none' : 'block';
  iconPause.style.display = playing ? 'block' : 'none';
}

// ─── ROOM CODE DISPLAY ────────────────────────────────────────────
if (ROOM_CODE) {
  roomCodeLabel.textContent = ROOM_CODE;
  document.getElementById('btn-copy-room').addEventListener('click', () => {
    navigator.clipboard.writeText(ROOM_CODE).then(() => showToast('📋 Room code copied!')).catch(() => {});
  });
} else {
  window.location.href = 'index.html';
}

// ─── SOCKET.IO CONNECTION ─────────────────────────────────────────
statusText.textContent = 'Connecting to server...';

try {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
} catch (e) {
  statusText.textContent = 'Cannot connect. Make sure the server is running.';
}

socket.on('connect', () => {
  statusText.textContent = 'Joining room...';
  socket.emit('join-room', ROOM_CODE, (res) => {
    if (!res.success) {
      statusText.textContent = res.error || 'Could not join room.';
      return;
    }

    isHost = res.isHost;
    setSyncStatus('waiting', 'Waiting...');
    startCamera();

    if (res.userCount === 2) {
      // Both users already in room
      statusText.textContent = 'Partner found! Setting up...';
      if (isHost) initPeerConnection(true);
    } else {
      statusText.textContent = 'Waiting for partner to join...';
    }
  });
});

socket.on('connect_error', () => {
  statusText.textContent = '⚠️ Cannot reach server. Is it running?';
});

socket.on('disconnect', () => {
  setSyncStatus('error', 'Disconnected');
  showToast('⚠️ Disconnected from server');
});

// ─── PEER EVENTS FROM SERVER ──────────────────────────────────────
socket.on('peer-joined', () => {
  showToast('👋 Partner joined!');
  setSyncStatus('waiting', 'Connecting...');
  statusText.textContent = 'Partner found! Setting up video call...';
  if (isHost) initPeerConnection(true);

  // Re-broadcast current video to the new partner so late joiners get it
  if (currentVideo) {
    setTimeout(() => {
      socket.emit('video-load', currentVideo);
    }, 1500); // small delay to let partner's socket settle
  }
});

socket.on('peer-left', () => {
  showToast('😔 Partner left the room');
  setSyncStatus('error', 'Alone');
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  remoteVideo.srcObject = null;
  partnerBubble.classList.remove('cam-online');
  partnerOffline.style.display = 'flex';
  isConnected = false;
});

// ─── WEBRTC SIGNALING ─────────────────────────────────────────────
socket.on('webrtc-offer', async ({ sdp }) => {
  if (!peerConnection) initPeerConnection(false);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('webrtc-answer', { sdp: peerConnection.localDescription });
});

socket.on('webrtc-answer', async ({ sdp }) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('webrtc-ice', async ({ candidate }) => {
  if (peerConnection && candidate) {
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
  }
});

// ─── CAMERA / MIC ─────────────────────────────────────────────────
async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
      audio: true
    });
    localVideo.srcObject = localStream;
    selfBubble.classList.add('cam-online');
    document.getElementById('self-offline').style.display = 'none';
  } catch (err) {
    console.warn('Camera access denied:', err.message);
    showToast('📷 Camera access denied — video chat disabled');
  }
}

// ─── PEER CONNECTION ──────────────────────────────────────────────
function initPeerConnection(createOffer) {
  if (peerConnection) { peerConnection.close(); }

  peerConnection = new RTCPeerConnection(STUN_SERVERS);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  // Receive remote stream
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      partnerBubble.classList.add('cam-online');
      partnerOffline.style.display = 'none';
      isConnected = true;
      setSyncStatus('synced', 'Connected');
      hideStatusOverlay();
      showToast('✅ Connected to partner!');
    }
  };

  // ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice', { candidate: event.candidate });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === 'connected') {
      setSyncStatus('synced', 'In Sync');
      hideStatusOverlay();
    } else if (state === 'failed' || state === 'disconnected') {
      setSyncStatus('error', 'Dropped');
      showToast('⚠️ Video call dropped');
    }
  };

  if (createOffer) {
    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => socket.emit('webrtc-offer', { sdp: peerConnection.localDescription }))
      .catch(console.error);
  }
}

// ─── VIDEO SYNC — RECEIVE ─────────────────────────────────────────
socket.on('video-load', ({ url, type }) => {
  loadVideo(url, type, false);
  showToast('▶️ Partner loaded a video — loading for you too!');
});

socket.on('video-play', ({ currentTime }) => {
  // If YouTube player isn't ready yet, queue the play command
  if (videoMode === 'youtube' && (!ytPlayer || !ytPlayerReady)) {
    pendingPlay = { action: 'play', currentTime };
    setPlayPauseUI(true); // update UI optimistically
    return;
  }
  isSyncingLocally = true;
  seekTo(currentTime);
  playVideo();
  setTimeout(() => isSyncingLocally = false, 600);
});

socket.on('video-pause', ({ currentTime }) => {
  // If YouTube player isn't ready yet, queue the pause command
  if (videoMode === 'youtube' && (!ytPlayer || !ytPlayerReady)) {
    pendingPlay = { action: 'pause', currentTime };
    setPlayPauseUI(false);
    return;
  }
  isSyncingLocally = true;
  seekTo(currentTime);
  pauseVideo();
  setTimeout(() => isSyncingLocally = false, 600);
});

socket.on('video-seek', ({ currentTime }) => {
  isSyncingLocally = true;
  seekTo(currentTime);
  setTimeout(() => isSyncingLocally = false, 500);
});

// ─── VIDEO LOADING ────────────────────────────────────────────────
function extractYouTubeId(url) {
  const patterns = [
    /[?&]v=([^&#]+)/,
    /youtu\.be\/([^?&#]+)/,
    /youtube\.com\/embed\/([^?&#]+)/,
    /youtube\.com\/shorts\/([^?&#]+)/
  ];
  for (const pattern of patterns) {
    const m = url.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function loadVideo(url, type, emit = true) {
  if (emit) socket.emit('video-load', { url, type });

  // Track current video for re-broadcasting to late joiners
  currentVideo = { url, type };

  videoEmpty.style.display = 'none';

  if (type === 'youtube') {
    // Reset player ready flag — new player will set it again via onYTReady
    ytPlayerReady = false;

    // ── If YouTube API not loaded yet, queue it ──────────────────
    if (!ytApiReady || typeof YT === 'undefined' || typeof YT.Player === 'undefined') {
      console.warn('⏳ YT API not ready yet — queuing video load');
      pendingVideoLoad = { url, type };
      showToast('⏳ YouTube player loading, please wait...');
      // Show a visual hint
      ytWrapper.style.display = 'flex';
      mp4Wrapper.style.display = 'none';
      return;
    }

    videoMode = 'youtube';
    mp4Wrapper.style.display = 'none';
    ytWrapper.style.display = 'flex';

    const videoId = extractYouTubeId(url);
    if (!videoId) { showToast('❌ Invalid YouTube URL'); return; }

    try {
      if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        ytPlayer.loadVideoById(videoId);
      } else {
        ytPlayer = new YT.Player('yt-player', {
          videoId: videoId,
          playerVars: {
            autoplay: 0,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            fs: 0,
            disablekb: 1
          },
          events: {
            onReady: onYTReady,
            onStateChange: onYTStateChange
          }
        });
      }
    } catch (err) {
      console.error('YouTube player error:', err);
      showToast('❌ YouTube player failed. Try reloading the page.');
    }

  } else {
    videoMode = 'mp4';
    ytWrapper.style.display = 'none';
    mp4Wrapper.style.display = 'flex';
    mp4Player.src = url;
    mp4Player.load();
    setupMp4Events();
  }
}

// ─── YOUTUBE PLAYER API ───────────────────────────────────────────
window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
  console.log('✅ YouTube API ready');
  // If a video was queued while API was loading, load it now
  if (pendingVideoLoad) {
    const { url, type } = pendingVideoLoad;
    pendingVideoLoad = null;
    setTimeout(() => loadVideo(url, type, false), 300);
  }
};

let ytEventLock = false;

function onYTReady(event) {
  ytPlayerReady = true;
  // YouTube API sometimes calls this without an event in Firefox — guard against it
  try {
    if (event && event.target) {
      event.target.setVolume(100);
    } else if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.setVolume(100);
    }
  } catch (e) {
    // Volume not critical — continue
  }
  startSeekBarUpdater();

  // Execute any queued play/pause command that arrived before player was ready
  if (pendingPlay !== null) {
    const cmd = pendingPlay;
    pendingPlay = null;
    setTimeout(() => {
      isSyncingLocally = true;
      try {
        if (cmd.currentTime > 0) {
          if (ytPlayer) ytPlayer.seekTo(cmd.currentTime, true);
        }
        if (cmd.action === 'play') {
          if (ytPlayer) ytPlayer.playVideo();
          setPlayPauseUI(true);
        } else {
          if (ytPlayer) ytPlayer.pauseVideo();
          setPlayPauseUI(false);
        }
      } catch(e) {}
      setTimeout(() => isSyncingLocally = false, 600);
    }, 500); // wait a moment for player to fully settle
  }
}

function onYTStateChange(event) {
  if (isSyncingLocally) return;
  const state = event.data;

  if (state === YT.PlayerState.PLAYING) {
    setPlayPauseUI(true);
    socket.emit('video-play', { currentTime: ytPlayer.getCurrentTime() });
    setSyncStatus('synced', 'In Sync');
  } else if (state === YT.PlayerState.PAUSED) {
    setPlayPauseUI(false);
    socket.emit('video-pause', { currentTime: ytPlayer.getCurrentTime() });
  }
}

// ─── HTML5 VIDEO EVENTS ───────────────────────────────────────────
function setupMp4Events() {
  mp4Player.onplay = () => {
    if (isSyncingLocally) return;
    setPlayPauseUI(true);
    socket.emit('video-play', { currentTime: mp4Player.currentTime });
  };

  mp4Player.onpause = () => {
    if (isSyncingLocally) return;
    setPlayPauseUI(false);
    socket.emit('video-pause', { currentTime: mp4Player.currentTime });
  };

  mp4Player.onseeked = () => {
    if (isSyncingLocally) return;
    socket.emit('video-seek', { currentTime: mp4Player.currentTime });
  };

  mp4Player.ontimeupdate = updateSeekBar;

  mp4Player.onloadedmetadata = () => {
    timeDuration.textContent = formatTime(mp4Player.duration);
    seekInput.max = mp4Player.duration;
  };

  mp4Player.onerror = () => {
    showToast('❌ Cannot load video. Check the URL.');
    videoEmpty.style.display = 'flex';
    mp4Wrapper.style.display = 'none';
  };
}

// ─── PLAYBACK CONTROL ─────────────────────────────────────────────
function playVideo() {
  if (videoMode === 'youtube' && ytPlayer) {
    try {
      // Check player state: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
      const state = ytPlayer.getPlayerState();
      if (state === 3) {
        // Currently buffering — it will auto-play when ready
        return;
      }
      ytPlayer.playVideo();
    } catch(e) { console.warn('playVideo error:', e); }
  }
  if (videoMode === 'mp4') mp4Player.play().catch(() => {});
}

function pauseVideo() {
  if (videoMode === 'youtube' && ytPlayer) ytPlayer.pauseVideo();
  if (videoMode === 'mp4') mp4Player.pause();
}

function seekTo(t) {
  if (videoMode === 'youtube' && ytPlayer) ytPlayer.seekTo(t, true);
  if (videoMode === 'mp4') mp4Player.currentTime = t;
}

function getCurrentTime() {
  if (videoMode === 'youtube' && ytPlayer) return ytPlayer.getCurrentTime();
  if (videoMode === 'mp4') return mp4Player.currentTime;
  return 0;
}

function getDuration() {
  if (videoMode === 'youtube' && ytPlayer) return ytPlayer.getDuration() || 0;
  if (videoMode === 'mp4') return mp4Player.duration || 0;
  return 0;
}

function isPlaying() {
  if (videoMode === 'youtube' && ytPlayer) return ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
  if (videoMode === 'mp4') return !mp4Player.paused;
  return false;
}

// ─── SEEK BAR ─────────────────────────────────────────────────────
let seekUpdater = null;

function startSeekBarUpdater() {
  if (seekUpdater) clearInterval(seekUpdater);
  seekUpdater = setInterval(updateSeekBar, 500);
}

function updateSeekBar() {
  const current  = getCurrentTime();
  const duration = getDuration();
  if (!duration) return;

  timeCurrent.textContent = formatTime(current);
  timeDuration.textContent = formatTime(duration);

  const pct = (current / duration) * 100;
  seekFill.style.width = pct + '%';
  seekInput.value = current;
  seekInput.max = duration;
}

// Start updater loop (also for YouTube)
startSeekBarUpdater();

// ─── SEEK INPUT ───────────────────────────────────────────────────
let isSeeking = false;
seekInput.addEventListener('input', () => {
  isSeeking = true;
  const t = parseFloat(seekInput.value);
  seekFill.style.width = ((t / getDuration()) * 100) + '%';
  timeCurrent.textContent = formatTime(t);
});

seekInput.addEventListener('change', () => {
  const t = parseFloat(seekInput.value);
  seekTo(t);
  socket.emit('video-seek', { currentTime: t });
  isSeeking = false;
});

// ─── PLAY/PAUSE BUTTON ────────────────────────────────────────────
btnPlayPause.addEventListener('click', () => {
  if (!videoMode) { showToast('Load a video first 📎'); return; }
  if (isPlaying()) {
    pauseVideo();
    socket.emit('video-pause', { currentTime: getCurrentTime() });
    setPlayPauseUI(false);
  } else {
    playVideo();
    socket.emit('video-play', { currentTime: getCurrentTime() });
    setPlayPauseUI(true);
  }
});

// ─── MUTE ─────────────────────────────────────────────────────────
btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  if (videoMode === 'mp4') mp4Player.muted = isMuted;
  if (videoMode === 'youtube' && ytPlayer) {
    isMuted ? ytPlayer.mute() : ytPlayer.unMute();
  }
  btnMute.style.opacity = isMuted ? '0.4' : '1';
  showToast(isMuted ? '🔇 Muted' : '🔊 Unmuted');
});

// ─── CAMERA TOGGLE (video only) ─────────────────────────────────
document.getElementById('btn-toggle-cam').addEventListener('click', () => {
  if (!localStream) { showToast('Allow camera access first'); return; }
  isCamOn = !isCamOn;
  localStream.getVideoTracks().forEach(t => t.enabled = isCamOn);
  const camBtn = document.getElementById('btn-toggle-cam');
  camBtn.style.opacity = isCamOn ? '1' : '0.4';
  showToast(isCamOn ? '📹 Camera on' : '📷 Camera off');
});

// ─── MIC TOGGLE (audio only) ─────────────────────────────────────
document.getElementById('btn-toggle-mic').addEventListener('click', () => {
  if (!localStream) { showToast('Allow microphone access first'); return; }
  isMicOn = !isMicOn;
  localStream.getAudioTracks().forEach(t => t.enabled = isMicOn);
  const micBtn = document.getElementById('btn-toggle-mic');
  micBtn.style.opacity = isMicOn ? '1' : '0.4';
  showToast(isMicOn ? '🎤 Mic on — partner can hear you' : '🔇 Mic muted');
});

// ─── LOAD VIDEO MODAL ─────────────────────────────────────────────
function openModal() { modalOverlay.style.display = 'flex'; }
function closeModal() { modalOverlay.style.display = 'none'; }

btnLoadVideo.addEventListener('click', openModal);
btnLoadEmpty.addEventListener('click', openModal);
document.getElementById('btn-load-empty')?.addEventListener('click', openModal);
btnModalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-content-yt').style.display  = tab === 'yt'  ? 'block' : 'none';
    document.getElementById('tab-content-url').style.display = tab === 'url' ? 'block' : 'none';
  });
});

btnLoadConfirm.addEventListener('click', () => {
  const activeTab = document.querySelector('.tab-btn.active').dataset.tab;

  if (activeTab === 'yt') {
    const url = inputYtUrl.value.trim();
    if (!url) { showToast('⚠️ Paste a YouTube URL first'); return; }
    const videoId = extractYouTubeId(url);
    if (!videoId) { showToast('❌ Invalid YouTube URL'); return; }
    loadVideo(url, 'youtube', true);
    closeModal();
    showToast('▶️ Loading YouTube video...');
  } else {
    const url = inputDirectUrl.value.trim();
    if (!url) { showToast('⚠️ Paste a video URL first'); return; }
    loadVideo(url, 'mp4', true);
    closeModal();
    showToast('▶️ Loading video...');
  }
});

// ─── CHAT ─────────────────────────────────────────────────────────
let chatOpen = false;

function toggleChat() {
  chatOpen = !chatOpen;
  chatPanel.classList.toggle('open', chatOpen);
  if (chatOpen) {
    chatUnread.style.display = 'none';
    chatInput.focus();
  }
}

btnToggleChat.addEventListener('click', toggleChat);
btnChatClose.addEventListener('click', toggleChat);

function addChatMessage(text, isMe, time = '', senderName = '') {
  const div = document.createElement('div');
  div.className = `chat-msg ${isMe ? 'me' : 'them'}`;

  const t = time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="msg-bubble">${escapeHTML(text)}</div>
    <span class="msg-time">${isMe ? '' : (senderName ? senderName + ' · ' : '')}${t}</span>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-system-msg';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  addChatMessage(text, true);
  socket.emit('chat-message', { text, sender: 'Partner' });
  chatInput.value = '';
}

btnChatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });

socket.on('chat-message', ({ text, sender, time }) => {
  addChatMessage(text, false, time, sender);
  if (!chatOpen) {
    chatUnread.style.display = 'flex';
    showToast(`💬 ${sender}: ${text.substring(0, 40)}`);
  }
});

// ─── READY CHECK ──────────────────────────────────────────────────
// If the user lands directly on room.html without going through index.html
if (!ROOM_CODE) {
  statusText.textContent = 'No room code found. Redirecting...';
  setTimeout(() => window.location.href = 'index.html', 2000);
} else {
  // Show overlay for 8 seconds max (if partner never joins, still hide)
  setTimeout(() => {
    if (statusOverlay.style.display !== 'none') {
      hideStatusOverlay();
      setSyncStatus('waiting', 'Waiting...');
    }
  }, 8000);
}
