#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const REPO = 'PurplePrintAI/claude-ttl-counter';
const VSIX_NAME = 'claude-ttl-counter';

function log(msg) {
  console.log(`\x1b[36m[claude-ttl]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[claude-ttl]\x1b[0m ${msg}`);
}

function followRedirects(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'claude-ttl-counter-install' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        followRedirects(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await followRedirects(url);
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

function detectIDE() {
  const ides = [
    { name: 'cursor', cmd: 'cursor' },
    { name: 'code', cmd: 'code' },
  ];

  for (const ide of ides) {
    try {
      execSync(`${ide.cmd} --version`, { stdio: 'ignore' });
      return ide;
    } catch {
      continue;
    }
  }
  return null;
}

async function getLatestRelease() {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await followRedirects(url);

  return new Promise((resolve, reject) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        const vsixAsset = release.assets?.find((a) => a.name.endsWith('.vsix'));
        if (!vsixAsset) {
          reject(new Error('No .vsix asset found in latest release'));
          return;
        }
        resolve({
          version: release.tag_name,
          downloadUrl: vsixAsset.browser_download_url,
          fileName: vsixAsset.name,
        });
      } catch (err) {
        reject(err);
      }
    });
    res.on('error', reject);
  });
}

async function main() {
  log('Claude TTL Counter installer');
  log('');

  log('Checking latest release...');
  let release;
  try {
    release = await getLatestRelease();
  } catch (err) {
    error(`Failed to fetch release: ${err.message}`);
    process.exit(1);
  }
  log(`Latest: ${release.version} (${release.fileName})`);

  const ide = detectIDE();
  if (!ide) {
    error('VS Code or Cursor not found. Install one first.');
    process.exit(1);
  }
  log(`Detected IDE: ${ide.name}`);

  const tmpDir = os.tmpdir();
  const vsixPath = path.join(tmpDir, release.fileName);

  log(`Downloading ${release.fileName}...`);
  try {
    await download(release.downloadUrl, vsixPath);
  } catch (err) {
    error(`Download failed: ${err.message}`);
    process.exit(1);
  }

  log(`Installing to ${ide.name}...`);
  try {
    execSync(`${ide.cmd} --install-extension "${vsixPath}"`, { stdio: 'inherit' });
  } catch (err) {
    error(`Installation failed. Try manually: ${ide.cmd} --install-extension "${vsixPath}"`);
    process.exit(1);
  }

  log('');
  log('Done! Reload your IDE to activate Claude TTL Counter.');
  log('Status bar will show: $(clock) TTL MM:SS · project-name');
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
