const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rotas Básicas
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/termos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'termos.html')));
app.get('/privacidade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidade.html')));

// Admin
const adminPath = path.join(__dirname, 'admin');
if (!fs.existsSync(adminPath)) fs.mkdirSync(adminPath, { recursive: true });
app.use('/admin', express.static(adminPath));

app.post('/admin/login', express.json(), (req, res) => {
    const { username, password } = req.body;
    const ADMIN_USERNAME = process.env.ADMIN_USER || "eusouVitoriosoathes";
    const ADMIN_PASS = process.env.ADMIN_PASS || "atheschatthebestintheworld#1";
    if (username === ADMIN_USERNAME && password === ADMIN_PASS) {
        res.json({ success: true, token: Buffer.from(`${username}:${Date.now()}`).toString('base64') });
    } else { res.status(401).json({ success: false, message: "Credenciais inválidas" }); }
});

function verificarToken(req, res, next) { if (!req.headers['authorization']) return res.status(403).json({ error: "Acesso negado" }); next(); }

// Arquivos JSON
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
function lerArquivo(nome, padrao = {}) { try { const p = path.join(dataDir, nome); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : padrao; } catch (e) { return padrao; } }
function escreverArquivo(nome, dados) { try { fs.writeFileSync(path.join(dataDir, nome), JSON.stringify(dados, null, 2), 'utf8'); } catch(e) {} }

let stats = lerArquivo('stats.json', { totalMessages: 0, dailyMessages: {}, peakUsers: 0, gamesPlayed: { pong: 0, tictactoe: 0 } });
let bans = lerArquivo('bans.json', []);
let reports = lerArquivo('reports.json', []);
let adminLogs = lerArquivo('admin_logs.json', []);

// Admin APIs
app.get('/admin/api/stats', verificarToken, (req, res) => {
    const hoje = new Date().toISOString().split('T')[0];
    res.json({
        onlineNow: Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length,
        activeBots: activeBots.size,
        messagesToday: stats.dailyMessages[hoje] || 0,
        pendingReports: reports.filter(r => r.status === 'pending').length,
        activeGames: activePongGames.size,
        totalBanned: bans.length,
        peakUsers: stats.peakUsers || 0
    });
});
app.get('/admin/api/reports', verificarToken, (req, res) => res.json(reports));
app.post('/admin/api/reports/:id/action', express.json(), verificarToken, (req, res) => {
    const idx = reports.findIndex(r => r.reportId === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Não encontrada" });
    reports[idx].status = 'reviewed';
    if (req.body.action === 'ban') {
        if (!bans.some(b => b.userIP === reports[idx].reportedIP)) bans.push({ userIP: reports[idx].reportedIP, reason: req.body.reason, bannedAt: new Date().toISOString() });
        escreverArquivo('bans.json', bans);
        for (const [sid, ud] of connectedUsers) { if (ud.ip === reports[idx].reportedIP) { const s = io.sockets.sockets.get(sid); if (s) { s.emit('you_are_banned', { reason: req.body.reason }); s.disconnect(); } } }
    }
    escreverArquivo('reports.json', reports);
    res.json({ success: true });
});
app.get('/admin/api/bans', verificarToken, (req, res) => res.json(bans));
app.delete('/admin/api/bans/:ip', verificarToken, (req, res) => { bans = bans.filter(b => b.userIP !== req.params.ip); escreverArquivo('bans.json', bans); res.json({ success: true }); });
app.post('/admin/api/bans', express.json(), verificarToken, (req, res) => {
    if (!bans.some(b => b.userIP === req.body.userIP)) { bans.push({ userIP: req.body.userIP, reason: req.body.reason, bannedAt: new Date().toISOString() }); escreverArquivo('bans.json', bans); }
    res.json({ success: true });
});
app.post('/admin/api/broadcast', express.json(), verificarToken, (req, res) => { io.emit('admin_broadcast', req.body); res.json({ success: true }); });
app.get('/admin/api/logs', verificarToken, (req, res) => res.json(adminLogs.slice(0, 10)));

// Variáveis Globais
const connectedUsers = new Map();
const activeBots = new Map();
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;
const activePongGames = new Map();
const adminSessions = new Set();
const messageRateLimit = new Map();
const RATE_WINDOW = 10000; const RATE_MAX = 25; const RATE_BLOCK = 5000;

function verificarRateLimit(id) {
    const now = Date.now(); let d = messageRateLimit.get(id);
    if (!d) { d = { timestamps: [], blockedUntil: 0 }; messageRateLimit.set(id, d); }
    if (d.blockedUntil > now) return { allowed: false, remainingSeconds: Math.ceil((d.blockedUntil - now) / 1000) };
    d.timestamps = d.timestamps.filter(t => now - t < RATE_WINDOW); d.timestamps.push(now);
    if (d.timestamps.length > RATE_MAX) { d.blockedUntil = now + RATE_BLOCK; d.timestamps = []; return { allowed: false, remainingSeconds: Math.ceil(RATE_BLOCK / 1000) }; }
    return { allowed: true };
}

// ================= BOT INTELIGENTE E JOGADOR =================
const botLogic = {
    greetings: ["Olá!", "E aí, tudo bem?", "Oi, como vai?", "Opa, tudo certo?"],
    questions: ["O que você gosta de fazer?", "Qual seu filme favorito?", "Ouve que tipo de música?", "De onde você fala?"],
    keywords: {
        'tudo bem': ["Tudo ótimo por aqui, e com você?", "Tudo certo, e por aí?", "Vou bem, obrigado!"],
        'qual seu nome': ["Sou anônimo, assim como você haha", "Me chame de... Anônimo."],
        'você é um bot': ["Haha, será? 🤔", "Sou apenas mais um anônimo na rede."],
        'jogar': ["Adoro jogar! Quer jogar um Pong?", "Bora jogar! Aceita o convite aí."],
        'filme': ["Adoro filmes! Viu algum bom?", "Gosto de ficção científica. E você?"],
        'música': ["Música é vida! Curto de tudo.", "Qual sua banda preferida?"],
    },
    fallbacks: ["Interessante...", "Hmm, me conte mais.", "Não sei muito sobre isso.", "Entendi.", "Sério?"]
};

class Bot {
    constructor(socket) {
        this.id = "bot_" + Date.now();
        this.userId = socket.id;
        this.socket = socket;
        this.location = ["São Paulo", "Rio de Janeiro", "Minas Gerais", "Bahia"][Math.floor(Math.random() * 4)];
        activeBots.set(this.id, this);
        this.inGame = false;
        this.paddleX = 120;
        this.targetX = 120;
        this.playInviteTimeout = null;
    }
    start() {
        const userData = connectedUsers.get(this.userId);
        if (userData) userData.partnerId = this.id;
        this.socket.emit('chat_start', { partnerId: this.id });
        setTimeout(() => this.sendMsg(botLogic.greetings[Math.floor(Math.random() * botLogic.greetings.length)]), 1500);
        
        if (Math.random() < 0.3) {
            this.playInviteTimeout = setTimeout(() => {
                if (!this.inGame) {
                    this.sendMsg("Tô meio entediado aqui... quer jogar um Pong?");
                    this.socket.emit('bot_pong_invite');
                }
            }, 20000 + Math.random() * 40000);
        }
    }
    handleMsg(text) {
        this.socket.emit('typing', { isTyping: true });
        setTimeout(() => {
            const l = text.toLowerCase();
            if (l.includes('jogar') || l.includes('pong')) {
                this.socket.emit('bot_pong_invite');
                this.sendMsg("Bora! Te mandei o convite.");
                return;
            }
            for (const k in botLogic.keywords) { if (l.includes(k)) { const r = botLogic.keywords[k]; this.sendMsg(r[Math.floor(Math.random() * r.length)]); return; } }
            if (Math.random() > 0.6) this.sendMsg(botLogic.questions[Math.floor(Math.random() * botLogic.questions.length)]);
            else this.sendMsg(botLogic.fallbacks[Math.floor(Math.random() * botLogic.fallbacks.length)]);
        }, 1000 + Math.random() * 1000);
    }
    sendMsg(text) { this.socket.emit('typing', { isTyping: false }); this.socket.emit('message', { text, senderId: this.id, location: this.location }); }
    disconnect() { clearTimeout(this.playInviteTimeout); setTimeout(() => { const u = connectedUsers.get(this.userId); if (u && u.partnerId === this.id) { this.socket.emit('chat_ended'); u.partnerId = null; } activeBots.delete(this.id); }, 1000); }
    
    updatePong(paddleX, ballX, ballY) {
        if (!this.inGame) return;
        this.paddleX = paddleX;
        if (ballY < 200) {
            if (Math.random() > 0.2) {
                this.targetX = ballX - 30 + (Math.random() * 40 - 20);
            }
        }
        let diff = this.targetX - this.paddleX;
        let speed = 4;
        if (Math.abs(diff) > speed) this.paddleX += Math.sign(diff) * speed;
        else this.paddleX = this.targetX;
        this.paddleX = Math.max(0, Math.min(300 - 60, this.paddleX));
    }
}

// ================= JOGO PONG =================
const PONG = { W: 300, H: 400, PW: 60, PH: 10, BR: 5, SX: 2.5, SY: 2.5, MAX_G: 3, TIME: 180000, INT: 1000/60 };
class PongGame {
    constructor(p1, p2, isBot = false) {
        this.p1 = { id: p1, socket: io.sockets.sockets.get(p1), score: 0, paddleX: 120 };
        this.p2 = { id: p2, socket: isBot ? null : io.sockets.sockets.get(p2), score: 0, paddleX: 120 };
        this.isBot = isBot;
        this.bot = isBot ? activeBots.get(p2) : null;
        if (this.bot) this.bot.inGame = true;
        this.ball = {}; this.paused = true; this.loser = null; this.time = PONG.TIME;
        activePongGames.set(p1, this); if (!isBot) activePongGames.set(p2, this);
        this.loop = null; this.timer = null;
        stats.gamesPlayed.pong++; escreverArquivo('stats.json', stats);
    }
    broadcast(e, d) { if (this.p1.socket) this.p1.socket.emit(e, d); if (this.p2.socket) this.p2.socket.emit(e, d); }
    start() { this.broadcast('pong_start', {}); this.timer = setInterval(() => this.tick(), 1000); this.startRound(); }
    startRound() {
        this.paused = true; clearInterval(this.loop); this.broadcastState(); this.broadcast('pong_countdown_start');
        setTimeout(() => {
            this.ball = { x: 150, y: 200, vx: (Math.random() > 0.5 ? 1 : -1) * PONG.SX, vy: (this.loser === this.p1.id ? 1 : -1) * PONG.SY, mult: 1, rally: 0 };
            this.paused = false; this.loser = null; this.loop = setInterval(() => this.update(), PONG.INT);
        }, 3000);
    }
    tick() { if (this.paused) return; this.time -= 1000; this.broadcast('pong_time_update', { time: this.time }); if (this.time <= 0) this.end('time_up'); }
    update() {
        if (this.paused) return;
        let b = this.ball; b.x += b.vx * b.mult; b.y += b.vy * b.mult;
        if (b.x - PONG.BR < 0 || b.x + PONG.BR > PONG.W) b.vx *= -1;
        let hit1 = b.y + PONG.BR >= PONG.H - PONG.PH && b.vy > 0 && b.x >= this.p1.paddleX && b.x <= this.p1.paddleX + PONG.PW;
        let hit2 = b.y - PONG.BR <= PONG.PH && b.vy < 0 && b.x >= this.p2.paddleX && b.x <= this.p2.paddleX + PONG.PW;
        
        if (hit1 || hit2) {
            let px = hit1 ? this.p1.paddleX : this.p2.paddleX;
            let norm = ((px + PONG.PW / 2) - b.x) / (PONG.PW / 2);
            let angle = norm * (5 * Math.PI / 12);
            let spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            b.vx = spd * Math.sin(angle) * -1; b.vy = spd * Math.cos(angle) * (hit1 ? -1 : 1);
            b.rally++; if (b.rally % 5 === 0) b.mult = Math.min(2.5, b.mult + 0.15);
        }
        
        if (this.isBot) {
            this.bot.updatePong(this.p2.paddleX, b.x, b.y);
            this.p2.paddleX = this.bot.paddleX;
        }

        if (b.y > PONG.H + PONG.BR) this.goal(this.p2, this.p1.id);
        else if (b.y < -PONG.BR) this.goal(this.p1, this.p2.id);
        this.broadcastState();
    }
    goal(w, lId) { this.loser = lId; w.score++; if (w.score >= PONG.MAX_G) this.end('score'); else this.startRound(); }
    movePaddle(id, x) { if (this.paused) return; if (id === this.p1.id) this.p1.paddleX = x; else if (!this.isBot && id === this.p2.id) this.p2.paddleX = x; }
    broadcastState() {
        if (this.p1.socket) this.p1.socket.emit('pong_update', { ball: this.ball, you: { score: this.p1.score, paddleX: this.p1.paddleX }, opponent: { score: this.p2.score, paddleX: this.p2.paddleX } });
        const fY = y => PONG.H - y;
        const fB = this.ball.x ? { x: this.ball.x, y: fY(this.ball.y), vx: this.ball.vx, vy: this.ball.vy, mult: this.ball.mult, rally: this.ball.rally } : this.ball;
        if (this.p2.socket) this.p2.socket.emit('pong_update', { ball: fB, you: { score: this.p2.score, paddleX: this.p2.paddleX }, opponent: { score: this.p1.score, paddleX: this.p1.paddleX } });
    }
    end(r) {
        clearInterval(this.loop); clearInterval(this.timer); this.paused = true;
        if (r === 'time_up' && this.p1.score === this.p2.score) { this.time = 30000; this.broadcast('system_message', { message: 'Empate! Morte súbita!' }); this.startRound(); return; }
        if (this.p1.socket) this.p1.socket.emit('pong_end', { reason: r, yourScore: this.p1.score, opponentScore: this.p2.score });
        if (this.p2.socket) this.p2.socket.emit('pong_end', { reason: r, yourScore: this.p2.score, opponentScore: this.p1.score });
        activePongGames.delete(this.p1.id); if (!this.isBot) activePongGames.delete(this.p2.id);
        if (this.isBot) this.bot.inGame = false;
    }
}

// ================= CONEXÃO SOCKET.IO =================
io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'Desconhecido';
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido', isAdmin: false, ip });

    socket.on('admin_register', () => { adminSessions.add(socket.id); const u = connectedUsers.get(socket.id); if(u) u.isAdmin = true; });
    socket.on('join', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id); if (!u || u.partnerId) return;
        if (data?.location) u.location = data.location;
        let realP = null;
        for (const [uid, ud] of connectedUsers) { if (uid !== socket.id && !ud.partnerId && !adminSessions.has(uid)) { realP = io.sockets.sockets.get(uid); break; } }
        if (realP) {
            connectedUsers.get(socket.id).partnerId = realP.id; connectedUsers.get(realP.id).partnerId = socket.id;
            socket.emit('chat_start', { partnerId: realP.id }); realP.emit('chat_start', { partnerId: socket.id });
        } else {
            socket.emit('waiting');
            setTimeout(() => { if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId && !adminSessions.has(socket.id)) new Bot(socket).start(); }, 3000);
        }
    });

    socket.on('message', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id); if (!u?.partnerId) return;
        const rate = verificarRateLimit(socket.id);
        if (!rate.allowed) {
            socket.emit('system_message', { message: rate.remainingSeconds >= 5 ? `⚠️ Calma aí! Aguarde ${rate.remainingSeconds} segundos.` : `⏳ Espere ${rate.remainingSeconds}s antes de enviar outra mensagem.` });
            return;
        }
        if (activeBots.has(u.partnerId)) activeBots.get(u.partnerId).handleMsg(data.text);
        else { const p = io.sockets.sockets.get(u.partnerId); if(p) p.emit('message', { text: data.text, senderId: socket.id, location: u.location }); }
        stats.totalMessages++; const h = new Date().toISOString().split('T')[0]; stats.dailyMessages[h] = (stats.dailyMessages[h] || 0) + 1; escreverArquivo('stats.json', stats);
    });

    socket.on('end_chat', () => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id); if (!u?.partnerId) return;
        if (activePongGames.has(socket.id)) activePongGames.get(socket.id).end('chat_ended');
        const pid = u.partnerId; u.partnerId = null;
        if (activeBots.has(pid)) activeBots.get(pid).disconnect();
        else { const p = io.sockets.sockets.get(pid); if(p) { p.emit('chat_ended'); const pd = connectedUsers.get(pid); if(pd) pd.partnerId = null; } }
        socket.emit('chat_ended');
    });

    socket.on('disconnect', () => {
        adminSessions.delete(socket.id); if (activePongGames.has(socket.id)) activePongGames.get(socket.id).end('disconnected');
        const u = connectedUsers.get(socket.id);
        if (u?.partnerId) { if (activeBots.has(u.partnerId)) activeBots.delete(u.partnerId); else { const p = io.sockets.sockets.get(u.partnerId); if(p) p.emit('partner_disconnected'); } }
        connectedUsers.delete(socket.id); messageRateLimit.delete(socket.id);
    });

    socket.on('pong_invite', () => { const u = connectedUsers.get(socket.id); if (u?.partnerId && !activeBots.has(u.partnerId)) { const p = io.sockets.sockets.get(u.partnerId); if(p) { p.emit('pong_invite_received'); socket.emit('system_message', { message: "Convite enviado." }); } } });
    socket.on('pong_accept', () => { const u = connectedUsers.get(socket.id); if (!u?.partnerId || activePongGames.has(socket.id)) return; const isBot = activeBots.has(u.partnerId); new PongGame(socket.id, u.partnerId, isBot).start(); });
    socket.on('pong_move', (d) => { const g = activePongGames.get(socket.id); if(g) g.movePaddle(socket.id, d.paddleX); });
    socket.on('pong_leave', () => { const g = activePongGames.get(socket.id); if(g) g.end('leave'); });
});

setInterval(() => {
    const r = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
    let t = fakeOnlineBase + r + (Math.floor(Math.random() * 12) - 4); if (t < r) t = r; io.emit('users_online', t);
}, 4500);

server.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));