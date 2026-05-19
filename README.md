# omoggle v2

Live 1v1 mog arena — random webcam pairing, **on-device** PSL face analysis,
ELO ranking, global leaderboard. Self-hosted, no signup, no upload.

V2 over the original:
- Five-axis breakdown (symmetry / harmony / jaw / canthal tilt / skin) instead
  of a single opaque number
- Live landmark overlay during calibration
- ELO-banded matchmaking (closest-ELO partner, band widens with wait)
- **On-device NSFW detection** (nsfwjs + TensorFlow.js) — blocks queue if your
  own camera is flagged, auto-concedes + reports if the opponent's feed is
- Real-time PSL exchange during the round
- Mobile layout, instant rematch, one-tap report / concede
- Runs entirely on your own infra — no third-party media or analytics

## stack
- **node 20+** + express + socket.io (signaling + matchmaking)
- **better-sqlite3** (zero-admin persistence, ARM-friendly)
- **face-api.js** (TinyFaceDetector + 68-point landmarks, on-device)
- **nsfwjs + TensorFlow.js** (NSFW classification, on-device)
- **WebRTC** peer-to-peer for the video
- vanilla HTML/CSS/JS — no build step

## run locally
```bash
npm install
npm start          # http://localhost:8080
# or: npm run dev  # auto-reload
```

Open in two browser tabs/profiles to test matchmaking against yourself.
Webcam needs HTTPS for any non-localhost origin (handled by nginx below).

## deploy on a netcup arm vps

Tested on Ubuntu 22.04/24.04 LTS arm64.

```bash
# 1. system deps
sudo apt update
sudo apt install -y curl git build-essential python3 nginx

# 2. node 20 LTS (arm64 binary)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. drop the app onto the vps
sudo mkdir -p /srv/omoggle && sudo chown $USER /srv/omoggle
git clone <this-repo> /srv/omoggle
cd /srv/omoggle
npm ci --omit=dev      # better-sqlite3 will compile against your arm64 node

# 4. run it under pm2 (auto-restart, log rotation)
sudo npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd    # follow the printed instruction once

# 5. reverse proxy + TLS
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/omoggle
# edit server_name in that file
sudo ln -s /etc/nginx/sites-available/omoggle /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.tld -d www.your-domain.tld
```

If you'd rather skip pm2, use `deploy/omoggle.service.example` and run it under
plain systemd.

### environment variables
| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | http port (bind to 127.0.0.1 behind nginx) |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `./data` | sqlite + log directory |

### TURN (optional but recommended in prod)
Peers behind symmetric NAT will not connect with STUN alone. Stand up a
[coturn](https://github.com/coturn/coturn) on the same VPS and pass its
credentials into `webrtc-client.js` (the `iceServers` array). 5349/tcp + 3478/udp.

### data backup
SQLite WAL lives at `data/omoggle.db*`. Snapshot it with
`sqlite3 data/omoggle.db ".backup data/backup-$(date +%F).db"` from cron.

## safety / NSFW pipeline

`public/js/safety-vision.js` wraps **nsfwjs** (MobileNetV2 model, loaded over
TensorFlow.js) and runs it locally against the camera every ~1.8s. Two
consecutive frames over the risk threshold flip a flag. No frames leave the
device.

Risk score collapses the 5-class softmax — `Porn` and `Hentai` weighted fully,
`Sexy` weighted 0.45 — to avoid swimwear false positives. Tune in
`safety-vision.js` via `threshold`, `intervalMs`, `requiredHits`.

What happens when a flag fires:
- **Calibration**: queue button is locked, hint turns red.
- **Battle, own feed**: round is auto-conceded, blurred banner on your tile.
- **Battle, opponent feed**: round is auto-reported (`auto:nsfw`), blurred
  banner on their tile, server treats it as a draw to avoid abuse.

The model files come from nsfwjs's default CDN (~4mb, cached after first load).
If you'd rather self-host, download them from
<https://github.com/infinitered/nsfwjs> and pass the URL to `nsfwjs.load()` in
`safety-vision.js`. Be aware: this is a probabilistic classifier — it is the
first line of defense, not the only one. Pair it with a real reports queue
and a human moderator before going wide.

## file layout
```
server.js               express + socket.io + matchmaking + signaling
public/
  index.html            landing / age gate / handle
  arena.html            calibrate → queue → battle → result
  leaderboard.html      ELO / mogs board
  terms.html, privacy.html
  css/styles.css        design system (neon-on-void)
  js/face-analyzer.js   5-axis PSL pipeline (face-api.js wrapper)
  js/safety-vision.js   on-device NSFW detector (nsfwjs wrapper)
  js/arena.js           stage controller + match flow
  js/webrtc-client.js   RTCPeerConnection wrapper
  js/leaderboard.js, js/home.js, js/bg.js
ecosystem.config.cjs    pm2
deploy/                 nginx + systemd templates
data/                   sqlite db (gitignored)
```

## safety notes
This is an adult webcam product. The age gate + NSFW detector are necessary
but not sufficient — you are responsible for moderation, abuse handling, and
local-law compliance in any jurisdiction you serve. The `match:report` event
logs to stderr; wire it into whatever you run for moderation.
