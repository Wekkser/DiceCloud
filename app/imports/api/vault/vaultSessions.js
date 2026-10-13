// Diario delle sessioni letto da un vault Obsidian locale (fork helder-local).
//
// settings.json (privato, fuori da git):
//   "vaults": { "<creatureId>": "/percorso/assoluto/del/vault" }
//
// Il vault ha main.md con un callout per sessione seguito dall'embed del file:
//   > [!note]- Sessione 29 — Dentro al cubo (12/10/26)
//   > ![[story/2026/12_10_26/text]]
// Ogni text.md può avere una sezione "## Recap" subito sotto il titolo.
//
// Solo lettura: il vault resta l'unica fonte, DiceCloud non lo modifica mai.

import fs from 'fs';
import path from 'path';
import SimpleSchema from 'simpl-schema';
import { WebApp } from 'meteor/webapp';
import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { RateLimiterMixin } from 'ddp-rate-limiter-mixin';
import { assertOwnership } from '/imports/api/creature/creatures/creaturePermissions';

const IMAGE_ROUTE = '/vault-image';
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', 'mcp']);
const INDEX_TTL_MS = 60 * 1000;

function vaultRoot(creatureId) {
  const root = Meteor.settings.vaults?.[creatureId];
  return root ? path.resolve(root) : undefined;
}

// ------------------------------------------------------------------ main.md

const SESSION_LINE = /^>\s*\[!\w+\][-+]?\s*(Session[ei])\s+(\S+)\s*[—–-]\s*(.+?)(?:\s*\((\d{1,2}\/\d{1,2}\/\d{2,4})\))?\s*$/;
const EMBED_LINE = /^>\s*!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/;

function readIndex(root) {
  const lines = fs.readFileSync(path.join(root, 'main.md'), 'utf8').split('\n');
  const sessions = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SESSION_LINE);
    if (!m) continue;
    const embed = lines[i + 1]?.match(EMBED_LINE);
    if (!embed) continue;
    sessions.push({
      label: `${m[1]} ${m[2]}`,
      title: m[3].trim(),
      date: m[4],
      file: `${embed[1].trim()}.md`,
    });
  }
  return sessions;
}

// ------------------------------------------------------------------ text.md

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg)$/i;

const imageSrc = (creatureId, ref) =>
  `${IMAGE_ROUTE}/${creatureId}/${ref.split('/').map(encodeURIComponent).join('/')}`;

/** Converte la sintassi Obsidian in Markdown che marked + DOMPurify sanno mostrare. */
function obsidianToMarkdown(text, creatureId) {
  return text
    // Immagini incorporate: ![[nome.jpeg|300]], anche con [Luogo] nel nome
    .replace(/!\[\[(.+?\.(?:jpe?g|png|gif|webp|svg))(?:\|(\d+))?\]\]/gi, (all, name, width) =>
      `<img src="${imageSrc(creatureId, name.trim())}" alt="" style="max-width: 100%"${width ? ` width="${width}"` : ''}>`)
    // Altri embed (note): ![[nota]] → nome in corsivo
    .replace(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (all, name) => `*${path.basename(name.trim())}*`)
    // Link interni: [[nota|alias]] → alias, [[cartella/nota]] → nota
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (all, target, alias) => alias || path.basename(target))
    // Immagini HTML con percorso relativo al vault: <img src="imgs/maps/x.jpg">
    .replace(/(<img\b[^>]*\bsrc=")(?!https?:|\/)([^"]+)"/gi, (all, head, ref) => `${head}${imageSrc(creatureId, ref)}"`)
    // Callout: > [!important]- Titolo → > **Titolo**
    .replace(/^(>\s*)\[!(\w+)\][-+]?\s*(.*)$/gm, (all, quote, type, title) =>
      `${quote}**${title || type.charAt(0).toUpperCase() + type.slice(1)}**`);
}

/** Separa titolo, sezione "## Recap" e resto del testo. */
function splitSession(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (/^#\s/.test(lines[0] || '')) lines.shift();
  const start = lines.findIndex((l) => /^##\s+Recap\s*$/i.test(l));
  if (start === -1) return { recap: '', body: lines.join('\n').trim() };
  let end = lines.findIndex((l, i) => i > start && (/^##\s/.test(l) || /^---\s*$/.test(l)));
  if (end === -1) end = lines.length;
  const recap = lines.slice(start + 1, end).join('\n').trim();
  // Il separatore che chiude il recap non serve più
  if (/^---\s*$/.test(lines[end] || '')) end++;
  const body = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
  return { recap, body };
}

function readSession(root, session, creatureId) {
  const file = path.resolve(root, session.file);
  if (!file.startsWith(root + path.sep)) return { ...session, missing: true };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ...session, missing: true };
  }
  const { recap, body } = splitSession(text);
  return {
    ...session,
    recap: obsidianToMarkdown(recap, creatureId),
    body: obsidianToMarkdown(body, creatureId),
  };
}

// ------------------------------------------------------------------ metodo

const recentSessions = new ValidatedMethod({
  name: 'vault.recentSessions',
  validate: new SimpleSchema({
    creatureId: { type: String, max: 32 },
    count: { type: SimpleSchema.Integer, min: 1, max: 50, optional: true },
  }).validator(),
  mixins: [RateLimiterMixin],
  rateLimit: {
    numRequests: 10,
    timeInterval: 5000,
  },
  run({ creatureId, count = 5 }) {
    // Il diario è privato anche se la scheda è pubblica: solo il proprietario
    assertOwnership(creatureId, this.userId);
    const root = vaultRoot(creatureId);
    if (!root) return null;
    let index;
    try {
      index = readIndex(root);
    } catch (e) {
      throw new Meteor.Error('vault-unreadable', `Non riesco a leggere main.md nel vault: ${e.message}`);
    }
    return {
      total: index.length,
      sessions: index.slice(-count).reverse().map((s) => readSession(root, s, creatureId)),
    };
  },
});

export default recentSessions;

// ------------------------------------------------------------------ immagini

const imageIndexes = new Map(); // root -> { builtAt, byName: Map(basename -> path) }

function buildImageIndex(root) {
  const byName = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (IMAGE_EXT.test(entry.name) && !byName.has(entry.name)) {
        byName.set(entry.name, full);
      }
    }
  };
  walk(root);
  const index = { builtAt: Date.now(), byName };
  imageIndexes.set(root, index);
  return index;
}

function findImage(root, name) {
  let index = imageIndexes.get(root);
  if (!index || Date.now() - index.builtAt > INDEX_TTL_MS) index = buildImageIndex(root);
  // Immagine aggiunta da poco: ricostruisco l'indice una volta
  if (!index.byName.has(name)) index = buildImageIndex(root);
  return index.byName.get(name);
}

const isLoopback = (address = '') =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

WebApp.connectHandlers.use(IMAGE_ROUTE, (req, res) => {
  const send = (status) => { res.writeHead(status); res.end(); };
  // Le immagini del vault sono private: le serve solo a chi è sullo stesso Mac
  if (!isLoopback(req.socket.remoteAddress)) return send(403);
  const [creatureId, ...parts] = req.url.split('?')[0].split('/').filter(Boolean);
  const root = creatureId && vaultRoot(creatureId);
  if (!root || !parts.length) return send(404);
  let ref;
  try {
    ref = parts.map(decodeURIComponent).join('/');
  } catch (e) {
    return send(400);
  }
  if (!IMAGE_EXT.test(ref) || ref.includes('\\')) return send(400);
  // Prima come percorso relativo al vault, poi per nome file come fa Obsidian
  let file = path.resolve(root, ref);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) file = findImage(root, path.basename(ref));
  if (!file || !path.resolve(file).startsWith(root + path.sep)) return send(404);
  res.writeHead(200, {
    'Content-Type': IMAGE_TYPES[path.extname(file).toLowerCase()],
    'Cache-Control': 'private, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
});
