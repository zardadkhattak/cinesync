/**
 * CineSync Build Script
 * Copies frontend files into server/public/ for deployment
 * Run: node build.js (from the server/ directory)
 * OR:  node server/build.js (from the root movieswatch/ directory)
 */

const fs   = require('fs');
const path = require('path');

// Root of the project (movieswatch/)
const ROOT   = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');

// Files & folders to copy from root into public/
const COPY_ITEMS = [
  'index.html',
  'room.html',
  'manifest.json',
  'sw.js',
  'css',
  'js',
  'icons'
];

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return; // skip if doesn't exist
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(child => {
      copyRecursive(path.join(src, child), path.join(dest, child));
    });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Clean public/
if (fs.existsSync(PUBLIC)) {
  fs.rmSync(PUBLIC, { recursive: true });
}
fs.mkdirSync(PUBLIC);

// Copy each item
COPY_ITEMS.forEach(item => {
  const src  = path.join(ROOT, item);
  const dest = path.join(PUBLIC, item);
  copyRecursive(src, dest);
  if (fs.existsSync(src)) console.log(`✅ Copied: ${item}`);
  else console.log(`⚠️  Skipped (not found): ${item}`);
});

// Patch room.html: replace local IP/localhost with relative path for Socket.io
const roomHtmlPath = path.join(PUBLIC, 'room.html');
if (fs.existsSync(roomHtmlPath)) {
  let html = fs.readFileSync(roomHtmlPath, 'utf8');
  // Replace hardcoded server URL with empty string (relative)
  html = html.replace(
    /src="http:\/\/[^"]+\/socket\.io\/socket\.io\.js"/g,
    'src="/socket.io/socket.io.js"'
  );
  fs.writeFileSync(roomHtmlPath, html);
  console.log('✅ Patched: room.html (Socket.io URL → relative)');
}

// Patch room.js: replace hardcoded SERVER_URL
const roomJsPath = path.join(PUBLIC, 'js', 'room.js');
if (fs.existsSync(roomJsPath)) {
  let js = fs.readFileSync(roomJsPath, 'utf8');
  js = js.replace(
    /const SERVER_URL = sessionStorage\.getItem\('cs_server'\) \|\| '[^']+';/,
    "const SERVER_URL = sessionStorage.getItem('cs_server') || window.location.origin;"
  );
  fs.writeFileSync(roomJsPath, js);
  console.log('✅ Patched: room.js (SERVER_URL → window.location.origin)');
}

console.log('\n🎬 Build complete! Contents of server/public/ are ready to deploy.\n');
