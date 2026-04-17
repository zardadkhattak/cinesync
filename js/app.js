// ─── CONFIG ──────────────────────────────────────────────────────
// Change this to your deployed server URL when going online
const SERVER_URL = 'http://localhost:3000';

// ─── PWA INSTALL ─────────────────────────────────────────────────
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById('install-banner');
  if (banner) banner.style.display = 'flex';
});

document.getElementById('btn-install')?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') {
    document.getElementById('install-banner').style.display = 'none';
  }
  deferredPrompt = null;
});

document.getElementById('btn-dismiss-install')?.addEventListener('click', () => {
  document.getElementById('install-banner').style.display = 'none';
});

// ─── SERVICE WORKER ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ─── ROOM CODE GENERATOR ──────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── CREATE ROOM ──────────────────────────────────────────────────
const btnCreate = document.getElementById('btn-create');
const roomCodeDisplay = document.getElementById('room-code-display');
const generatedCodeEl = document.getElementById('generated-code');
let createdRoomCode = null;

btnCreate.addEventListener('click', () => {
  createdRoomCode = generateRoomCode();
  generatedCodeEl.textContent = createdRoomCode;
  roomCodeDisplay.style.display = 'block';
  btnCreate.style.display = 'none';

  // Animate the code display
  roomCodeDisplay.style.animation = 'none';
  roomCodeDisplay.offsetHeight; // reflow
  roomCodeDisplay.style.animation = 'fadeInUp 0.3s ease';
});

// Copy room code
document.getElementById('btn-copy-code')?.addEventListener('click', () => {
  if (!createdRoomCode) return;
  navigator.clipboard.writeText(createdRoomCode).then(() => {
    const btn = document.getElementById('btn-copy-code');
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
    }, 2000);
  }).catch(() => {
    // Fallback for older mobile browsers
    const el = document.createElement('textarea');
    el.value = createdRoomCode;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  });
});

// Enter created room
document.getElementById('btn-enter-created')?.addEventListener('click', () => {
  if (createdRoomCode) {
    enterRoom(createdRoomCode, 'host');
  }
});

// ─── JOIN ROOM ────────────────────────────────────────────────────
const joinInput = document.getElementById('join-code-input');
const joinError = document.getElementById('join-error');

// Auto-uppercase input
joinInput.addEventListener('input', (e) => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  joinError.textContent = '';
});

joinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

document.getElementById('btn-join').addEventListener('click', joinRoom);

function joinRoom() {
  const code = joinInput.value.trim().toUpperCase();

  if (code.length < 4) {
    joinError.textContent = '⚠️ Please enter a valid room code';
    joinInput.focus();
    return;
  }

  enterRoom(code, 'guest');
}

// ─── NAVIGATE TO ROOM ─────────────────────────────────────────────
function enterRoom(code, role) {
  // Save role & code to sessionStorage
  sessionStorage.setItem('cs_room', code);
  sessionStorage.setItem('cs_role', role);
  sessionStorage.setItem('cs_server', SERVER_URL);

  // Navigate
  window.location.href = `room.html?room=${code}`;
}
