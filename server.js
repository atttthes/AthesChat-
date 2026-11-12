const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e5 // 100KB por mensagem, evita payload gigante
});

app.set('trust proxy', true); // confia em X-Forwarded-For (Render/Heroku)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= CONFIG =================
// SEGURANÇA: sem fallback hardcoded. Se não definir env vars, gera senha aleatória
// e imprime no log (apenas para dev). Em produção, SEMPRE defina ADMIN_USER e ADMIN_PASS.
const ADMIN_USERNAME = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || (() => {
    const p = crypto.randomBytes(12).toString('base64url');
    console.log(`⚠️  ADMIN_PASS não definido. Senha temporária: ${p}`);
    return p;
})();
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.log('⚠️  JWT_SECRET não definido. Tokens serão invalidados ao reiniciar.');

// ================= ROTAS BÁSICAS =================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/termos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'termos.html')));
app.get('/privacidade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidade.html')));

// ================= ADMIN STATIC =================
const adminPath = path.join(__dirname, 'admin');
if (!fs.existsSync(adminPath)) fs.mkdirSync(adminPath, { recursive: true });
app.use('/admin', express.static(adminPath));

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    // comparação em tempo constante para evitar timing attack
    const safeEqual = (a, b) => {
        const ba = Buffer.from(String(a));
        const bb = Buffer.from(String(b));
        if (ba.length !== bb.length) return false;
        return crypto.timingSafeEqual(ba, bb);
    };
    if (typeof username === 'string' && typeof password === 'string'
        && safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASS)) {
        const token = jwt.sign({ role: 'admin', user: username }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: "Credenciais inválidas" });
    }
});

function verificarToken(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(403).json({ error: "Acesso negado" });
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    try {
        req.admin = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        return res.status(403).json({ error: "Token inválido ou expirado" });
    }
}

// ================= ARQUIVOS JSON =================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function lerArquivo(nome, padrao = {}) {
    try {
        const p = path.join(dataDir, nome);
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : padrao;
    } catch (e) { return padrao; }
}
function escreverArquivo(nome, dados) {
    try {
        // escrita atômica: grava em .tmp e renomeia
        const p = path.join(dataDir, nome);
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), 'utf8');
        fs.renameSync(tmp, p);
    } catch (e) { console.error('Erro ao escrever', nome, e); }
}

// Schema unificado (compatível com o antigo, mas com nomes corretos)
let stats = lerArquivo('stats.json', {
    totalMessages: 0,
    dailyMessages: {},
    peakUsers: 0,
    gamesPlayed: { pong: 0, tictactoe: 0 }
});
// migração suave de schema antigo
if (stats.totalMensagens !== undefined && stats.totalMessages === 0) {
    stats.totalMessages = stats.totalMensagens || 0;
    stats.dailyMessages = stats.mensagensPorDia || {};
    stats.peakUsers = stats.picoMaximoUsuarios || 0;
    stats.gamesPlayed = {
        pong: (stats.totalPartidas && stats.totalPartidas.pong) || 0,
        tictactoe: (stats.totalPartidas && stats.totalPartidas.velha) || 0
    };
    escreverArquivo('stats.json', stats);
}

let bans = lerArquivo('bans.json', []);
let reports = lerArquivo('reports.json', []);
// CORREÇÃO: nome consistente (era admins_log.json no projeto, código lia admin_logs.json)
let adminLogs = lerArquivo('admin_logs.json', []);

// Filtro de palavras no servidor (carregado uma vez)
let palavrasProibidas = [];
try {
    const p = path.join(__dirname, 'public', 'palavras_proibidas.json');
    if (fs.existsSync(p)) palavrasProibidas = JSON.parse(fs.readFileSync(p, 'utf8'));
} catch (e) {
    // tenta na raiz, fallback
    try {
        const p2 = path.join(__dirname, 'palavras_proibidas.json');
        if (fs.existsSync(p2)) palavrasProibidas = JSON.parse(fs.readFileSync(p2, 'utf8'));
    } catch (_) {}
}
function contemPalavraOfensiva(texto) {
    if (!texto || palavrasProibidas.length === 0) return false;
    const t = String(texto).toLowerCase();
    return palavrasProibidas.some(palavra => {
        const escaped = palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // \b não funciona com espaços; usa lookaround de fronteira de palavra OU espaço
        const regex = new RegExp(`(?:^|[^a-zà-ú])${escaped}(?:$|[^a-zà-ú])`, 'i');
        return regex.test(t);
    });
}

function registrarLog(mensagem) {
    adminLogs.unshift({ timestamp: new Date().toISOString(), mensagem });
    if (adminLogs.length > 200) adminLogs = adminLogs.slice(0, 200);
    escreverArquivo('admin_logs.json', adminLogs);
}

// ================= ESTADO GLOBAL (MOVIDO PARA CIMA) =================
const connectedUsers = new Map();
const activeBots = new Map();
const activePongGames = new Map();
const activeTttGames = new Map(); // NOVO: Jogo da Velha
const adminSessions = new Set();
const messageRateLimit = new Map();
const RATE_WINDOW = 10000;
const RATE_MAX = 25;
const RATE_BLOCK = 5000;
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;

// ================= ADMIN APIs =================
app.get('/admin/api/stats', verificarToken, (req, res) => {
    const hoje = new Date().toISOString().split('T')[0];
    res.json({
        onlineNow: Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length,
        activeBots: activeBots.size,
        messagesToday: stats.dailyMessages[hoje] || 0,
        pendingReports: reports.filter(r => r.status === 'pending').length,
        // CORREÇÃO: contar partidas reais (dividir por 2 pois cada partida registra 2 sockets)
        activeGames: Math.floor(activePongGames.size / 2) + Math.floor(activeTttGames.size / 2),
        totalBanned: bans.length,
        peakUsers: stats.peakUsers || 0
    });
});

app.get('/admin/api/reports', verificarToken, (req, res) => res.json(reports));

app.post('/admin/api/reports/:id/action', express.json(), verificarToken, (req, res) => {
    const idx = reports.findIndex(r => r.reportId === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Não encontrada" });

    const { action, reason, duration, warningMessage } = req.body || {};
    const report = reports[idx];

    if (action === 'ignore') {
        report.status = 'reviewed';
        report.actionTaken = 'ignored';
        registrarLog(`Denúncia ${report.reportId} ignorada`);
    } else if (action === 'warning') {
        report.status = 'reviewed';
        report.actionTaken = 'warning';
        // avisa o usuário se ainda estiver conectado
        for (const [sid, ud] of connectedUsers) {
            if (ud.ip === report.reportedIP) {
                const s = io.sockets.sockets.get(sid);
                if (s) s.emit('admin_warning', { message: warningMessage || 'Você recebeu um aviso da moderação.' });
            }
        }
        registrarLog(`Aviso enviado para IP ${report.reportedIP}`);
    } else if (action === 'ban' || action === 'suspend') {
        report.status = 'reviewed';
        report.actionTaken = action;
        const expiresAt = (action === 'suspend' && duration)
            ? new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString()
            : null;
        if (!bans.some(b => b.userIP === report.reportedIP)) {
            bans.push({
                userIP: report.reportedIP,
                reason: reason || 'Violação dos termos',
                bannedAt: new Date().toISOString(),
                expiresAt
            });
            escreverArquivo('bans.json', bans);
        }
        // desconecta sockets ativos desse IP
        for (const [sid, ud] of connectedUsers) {
            if (ud.ip === report.reportedIP) {
                const s = io.sockets.sockets.get(sid);
                if (s) {
                    s.emit('you_are_banned', { reason: reason || 'Violação dos termos', until: expiresAt });
                    s.disconnect(true);
                }
            }
        }
        registrarLog(`${action === 'ban' ? 'Ban' : 'Suspensão'} de IP ${report.reportedIP} (${duration || 'permanente'}d)`);
    } else {
        return res.status(400).json({ error: "Ação inválida" });
    }

    escreverArquivo('reports.json', reports);
    res.json({ success: true });
});

app.get('/admin/api/bans', verificarToken, (req, res) => res.json(bans));

app.delete('/admin/api/bans/:ip', verificarToken, (req, res) => {
    const ip = decodeURIComponent(req.params.ip);
    const before = bans.length;
    bans = bans.filter(b => b.userIP !== ip);
    escreverArquivo('bans.json', bans);
    registrarLog(`IP ${ip} desbanido (${before - bans.length} registro(s))`);
    res.json({ success: true });
});

app.post('/admin/api/bans', express.json(), verificarToken, (req, res) => {
    const { userIP, reason, duration } = req.body || {};
    if (!userIP || !reason) return res.status(400).json({ error: "IP e motivo obrigatórios" });
    if (!bans.some(b => b.userIP === userIP)) {
        const expiresAt = duration && duration !== 'permanent'
            ? new Date(Date.now() + parseInt(duration) * 24 * 60 * 60 * 1000).toISOString()
            : null;
        bans.push({ userIP, reason, bannedAt: new Date().toISOString(), expiresAt });
        escreverArquivo('bans.json', bans);
        registrarLog(`Ban manual de IP ${userIP} (${duration || 'permanente'})`);
    }
    res.json({ success: true });
});

app.post('/admin/api/broadcast', express.json(), verificarToken, (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: "Mensagem obrigatória" });
    io.emit('admin_broadcast', req.body);
    registrarLog(`Broadcast enviado: "${String(message).slice(0, 80)}"`);
    res.json({ success: true });
});

app.get('/admin/api/logs', verificarToken, (req, res) => res.json(adminLogs.slice(0, 10)));

// ================= RATE LIMIT =================
function verificarRateLimit(id) {
    const now = Date.now();
    let d = messageRateLimit.get(id);
    if (!d) { d = { timestamps: [], blockedUntil: 0 }; messageRateLimit.set(id, d); }
    if (d.blockedUntil > now) return { allowed: false, remainingSeconds: Math.ceil((d.blockedUntil - now) / 1000) };
    d.timestamps = d.timestamps.filter(t => now - t < RATE_WINDOW);
    d.timestamps.push(now);
    if (d.timestamps.length > RATE_MAX) {
        d.blockedUntil = now + RATE_BLOCK;
        d.timestamps = [];
        return { allowed: false, remainingSeconds: Math.ceil(RATE_BLOCK / 1000) };
    }
    return { allowed: true };
}

// ================= BOT INTELIGENTE =================
const botLogic = {
    greetings: ["Olá!", "E aí, tudo bem?", "Oi, como vai?", "Opa, tudo certo?"],
    questions: ["O que você gosta de fazer?", "Qual seu filme favorito?", "Ouve que tipo de música?", "De onde você fala?"],
    keywords: {
        'tudo bem': ["Tudo ótimo por aqui, e com você?", "Tudo certo, e por aí?", "Vou bem, obrigado!"],
        'qual seu nome': ["Sou anônimo, assim como você haha", "Me chame de... Anônimo."],
        'você é um bot': ["Haha, será? 🤔", "Sou apenas mais um anônimo na rede."],
        'jogar': ["Adoro jogar! Quer jogar um Pong?", "Bora jogar! Aceita o convite aí."],
        'filme': ["Adoro filmes! Viu algum bom?", "Gosto de ficção científica. E você?"],
        'música': ["Música é vida! Curto de tudo.", "Qual sua banda preferida?"]
    },
    fallbacks: ["Interessante...", "Hmm, me conte mais.", "Não sei muito sobre isso.", "Entendi.", "Sério?"]
};

class Bot {
    constructor(socket) {
        this.id = "bot_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
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
        if (!userData) return; // usuário saiu antes de virar bot
        userData.partnerId = this.id;
        this.socket.emit('chat_start', { partnerId: this.id });
        setTimeout(() => {
            if (activeBots.has(this.id)) this.sendMsg(botLogic.greetings[Math.floor(Math.random() * botLogic.greetings.length)]);
        }, 1500);

        if (Math.random() < 0.3) {
            this.playInviteTimeout = setTimeout(() => {
                if (!this.inGame && activeBots.has(this.id)) {
                    this.sendMsg("Tô meio entediado aqui... quer jogar um Pong?");
                    this.socket.emit('bot_pong_invite');
                }
            }, 20000 + Math.random() * 40000);
        }
    }
    handleMsg(text) {
        if (!activeBots.has(this.id)) return;
        this.socket.emit('typing', { isTyping: true });
        setTimeout(() => {
            if (!activeBots.has(this.id)) return;
            const l = String(text || '').toLowerCase();
            if (l.includes('jogar') || l.includes('pong')) {
                this.socket.emit('bot_pong_invite');
                this.sendMsg("Bora! Te mandei o convite.");
                return;
            }
            for (const k in botLogic.keywords) {
                if (l.includes(k)) {
                    const r = botLogic.keywords[k];
                    this.sendMsg(r[Math.floor(Math.random() * r.length)]);
                    return;
                }
            }
            if (Math.random() > 0.6) this.sendMsg(botLogic.questions[Math.floor(Math.random() * botLogic.questions.length)]);
            else this.sendMsg(botLogic.fallbacks[Math.floor(Math.random() * botLogic.fallbacks.length)]);
        }, 1000 + Math.random() * 1000);
    }
    sendMsg(text) {
        this.socket.emit('typing', { isTyping: false });
        this.socket.emit('message', { text, senderId: this.id, location: this.location });
    }
    disconnect() {
        clearTimeout(this.playInviteTimeout);
        setTimeout(() => {
            const u = connectedUsers.get(this.userId);
            if (u && u.partnerId === this.id) {
                this.socket.emit('chat_ended');
                u.partnerId = null;
            }
            activeBots.delete(this.id);
        }, 1000);
    }
    updatePong(paddleX, ballX, ballY) {
        if (!this.inGame) return;
        this.paddleX = paddleX;
        if (ballY < 200) {
            if (Math.random() > 0.2) this.targetX = ballX - 30 + (Math.random() * 40 - 20);
        }
        let diff = this.targetX - this.paddleX;
        let speed = 4;
        if (Math.abs(diff) > speed) this.paddleX += Math.sign(diff) * speed;
        else this.paddleX = this.targetX;
        this.paddleX = Math.max(0, Math.min(300 - 60, this.paddleX));
    }
}

// ================= JOGO PONG =================
const PONG = { W: 300, H: 400, PW: 60, PH: 10, BR: 5, SX: 2.5, SY: 2.5, MAX_G: 3, TIME: 180000, INT: 1000 / 60 };

class PongGame {
    constructor(p1, p2, isBot = false) {
        this.p1 = { id: p1, socket: io.sockets.sockets.get(p1), score: 0, paddleX: 120 };
        this.p2 = { id: p2, socket: isBot ? null : io.sockets.sockets.get(p2), score: 0, paddleX: 120 };
        this.isBot = isBot;
        this.bot = isBot ? activeBots.get(p2) : null;
        if (this.bot) this.bot.inGame = true;
        this.ball = {};
        this.paused = true;
        this.loser = null;
        this.time = PONG.TIME;
        activePongGames.set(p1, this);
        if (!isBot) activePongGames.set(p2, this);
        this.loop = null;
        this.timer = null;
        this.suddenDeath = false;
        stats.gamesPlayed.pong = (stats.gamesPlayed.pong || 0) + 1;
        escreverArquivo('stats.json', stats);
    }
    broadcast(e, d) {
        if (this.p1.socket) this.p1.socket.emit(e, d);
        if (this.p2.socket) this.p2.socket.emit(e, d);
    }
    start() {
        this.broadcast('pong_start', {});
        this.timer = setInterval(() => this.tick(), 1000);
        this.startRound();
    }
    startRound() {
        this.paused = true;
        clearInterval(this.loop);
        this.broadcastState();
        this.broadcast('pong_countdown_start');
        setTimeout(() => {
            if (!activePongGames.has(this.p1.id) && !activePongGames.has(this.p2.id)) return; // jogo já acabou
            this.ball = {
                x: 150, y: 200,
                vx: (Math.random() > 0.5 ? 1 : -1) * PONG.SX,
                vy: (this.loser === this.p1.id ? 1 : -1) * PONG.SY,
                mult: 1, rally: 0
            };
            this.paused = false;
            this.loser = null;
            clearInterval(this.loop);
            this.loop = setInterval(() => this.update(), PONG.INT);
        }, 3000);
    }
    tick() {
        if (this.paused) return;
        this.time -= 1000;
        this.broadcast('pong_time_update', { time: Math.max(0, this.time) });
        if (this.time <= 0) this.end('time_up');
    }
    update() {
        if (this.paused || !this.ball) return;
        let b = this.ball;
        b.x += b.vx * b.mult;
        b.y += b.vy * b.mult;
        if (b.x - PONG.BR < 0 || b.x + PONG.BR > PONG.W) b.vx *= -1;

        let hit1 = b.y + PONG.BR >= PONG.H - PONG.PH && b.vy > 0 && b.x >= this.p1.paddleX && b.x <= this.p1.paddleX + PONG.PW;
        let hit2 = b.y - PONG.BR <= PONG.PH && b.vy < 0 && b.x >= this.p2.paddleX && b.x <= this.p2.paddleX + PONG.PW;

        if (hit1 || hit2) {
            let px = hit1 ? this.p1.paddleX : this.p2.paddleX;
            let norm = ((px + PONG.PW / 2) - b.x) / (PONG.PW / 2);
            norm = Math.max(-1, Math.min(1, norm));
            let angle = norm * (5 * Math.PI / 12);
            let spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            b.vx = spd * Math.sin(angle) * -1;
            b.vy = spd * Math.cos(angle) * (hit1 ? -1 : 1);
            b.rally++;
            if (b.rally % 5 === 0) b.mult = Math.min(2.5, b.mult + 0.15);
        }

        if (this.isBot && this.bot) {
            this.bot.updatePong(this.p2.paddleX, b.x, b.y);
            this.p2.paddleX = this.bot.paddleX;
        }

        if (b.y > PONG.H + PONG.BR) this.goal(this.p2, this.p1.id);
        else if (b.y < -PONG.BR) this.goal(this.p1, this.p2.id);
        this.broadcastState();
    }
    goal(w, lId) {
        this.loser = lId;
        w.score++;
        if (w.score >= PONG.MAX_G) this.end('score');
        else this.startRound();
    }
    movePaddle(id, x) {
        if (this.paused) return;
        const nx = Math.max(0, Math.min(PONG.W - PONG.PW, Number(x) || 0));
        if (id === this.p1.id) this.p1.paddleX = nx;
        else if (!this.isBot && id === this.p2.id) this.p2.paddleX = nx;
    }
    broadcastState() {
        if (this.p1.socket) {
            this.p1.socket.emit('pong_update', {
                ball: this.ball,
                you: { score: this.p1.score, paddleX: this.p1.paddleX },
                opponent: { score: this.p2.score, paddleX: this.p2.paddleX }
            });
        }
        const fY = y => PONG.H - y;
        const fB = this.ball && this.ball.x !== undefined
            ? { x: this.ball.x, y: fY(this.ball.y), vx: this.ball.vx, vy: this.ball.vy, mult: this.ball.mult, rally: this.ball.rally }
            : this.ball;
        if (this.p2.socket) {
            this.p2.socket.emit('pong_update', {
                ball: fB,
                you: { score: this.p2.score, paddleX: this.p2.paddleX },
                opponent: { score: this.p1.score, paddleX: this.p1.paddleX }
            });
        }
    }
    end(r) {
        // CORREÇÃO: reentrância - evita chamar end duas vezes (ex: time_up + desconexão)
        if (this._ended) return;
        this._ended = true;
        clearInterval(this.loop);
        clearInterval(this.timer);
        this.paused = true;

        if (r === 'time_up' && this.p1.score === this.p2.score && !this.suddenDeath) {
            this.suddenDeath = true;
            this.time = 30000;
            this.broadcast('system_message', { message: 'Empate! Morte súbita por 30s!' });
            // CORREÇÃO: reinicia timer para a morte súbita funcionar
            this.timer = setInterval(() => this.tick(), 1000);
            this.broadcast('pong_time_update', { time: this.time });
            this._ended = false;
            this.startRound();
            return;
        }

        const p1Score = this.p1.score, p2Score = this.p2.score;
        if (this.p1.socket) this.p1.socket.emit('pong_end', { reason: r, yourScore: p1Score, opponentScore: p2Score });
        if (this.p2.socket) this.p2.socket.emit('pong_end', { reason: r, yourScore: p2Score, opponentScore: p1Score });
        activePongGames.delete(this.p1.id);
        if (!this.isBot) activePongGames.delete(this.p2.id);
        if (this.isBot && this.bot) this.bot.inGame = false;
    }
}

// ================= JOGO DA VELHA (NOVO) =================
class TicTacToeGame {
    constructor(p1, p2) {
        this.p1 = p1;
        this.p2 = p2;
        this.board = Array(9).fill(null);
        this.symbols = { [p1]: 'X', [p2]: 'O' };
        this.turn = p1; // p1 começa
        this.over = false;
        activeTttGames.set(p1, this);
        activeTttGames.set(p2, this);
        stats.gamesPlayed.tictactoe = (stats.gamesPlayed.tictactoe || 0) + 1;
        escreverArquivo('stats.json', stats);
    }
    broadcast(e, d) {
        const s1 = io.sockets.sockets.get(this.p1);
        const s2 = io.sockets.sockets.get(this.p2);
        if (s1) s1.emit(e, d);
        if (s2) s2.emit(e, d);
    }
    start() {
        const s1 = io.sockets.sockets.get(this.p1);
        const s2 = io.sockets.sockets.get(this.p2);
        if (s1) s1.emit('tictactoe_start', { yourSymbol: 'X', firstTurn: this.turn === this.p1 });
        if (s2) s2.emit('tictactoe_start', { yourSymbol: 'O', firstTurn: this.turn === this.p2 });
        this.broadcast('tictactoe_update', { board: this.board, currentTurnSymbol: this.symbols[this.turn] });
    }
    checkWinner() {
        const b = this.board;
        const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        for (const [a, c, d] of lines) {
            if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
        }
        return b.every(x => x) ? 'draw' : null;
    }
    move(sid, pos) {
        if (this.over) return;
        if (sid !== this.turn) return;
        if (!Number.isInteger(pos) || pos < 0 || pos > 8) return;
        if (this.board[pos] !== null) return;
        this.board[pos] = this.symbols[sid];
        const w = this.checkWinner();
        if (w === 'draw') {
            this.over = true;
            this.broadcast('tictactoe_update', { board: this.board, currentTurnSymbol: null });
            this.broadcast('tictactoe_game_over', { isDraw: true });
            this.cleanup();
            return;
        } else if (w) {
            this.over = true;
            this.broadcast('tictactoe_update', { board: this.board, currentTurnSymbol: null });
            this.broadcast('tictactoe_game_over', { winnerSymbol: w });
            this.cleanup();
            return;
        }
        this.turn = this.turn === this.p1 ? this.p2 : this.p1;
        this.broadcast('tictactoe_update', { board: this.board, currentTurnSymbol: this.symbols[this.turn] });
    }
    cleanup() {
        activeTttGames.delete(this.p1);
        activeTttGames.delete(this.p2);
        // limpa convites pendentes
        pendingTttInvites.delete(this.p1);
        pendingTttInvites.delete(this.p2);
    }
    leave(sid) {
        const other = sid === this.p1 ? this.p2 : this.p1;
        const s = io.sockets.sockets.get(other);
        if (s) s.emit('tictactoe_close');
        this.over = true;
        this.cleanup();
    }
}

const pendingTttInvites = new Map(); // fromId -> toId
const pendingPongInvites = new Map(); // fromId -> toId

// ================= SOCKET.IO =================
io.on('connection', (socket) => {
    const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'Desconhecido';
    const ip = String(rawIp).split(',')[0].trim();

    // SEGURANÇA: bloqueia IP banido já na conexão (respeita expiração)
    const ban = bans.find(b => b.userIP === ip);
    if (ban) {
        const expired = ban.expiresAt && new Date(ban.expiresAt) < new Date();
        if (!expired) {
            socket.emit('you_are_banned', { reason: ban.reason, until: ban.expiresAt });
            socket.disconnect(true);
            return;
        } else {
            // limpa bans expirados
            bans = bans.filter(b => b !== ban);
            escreverArquivo('bans.json', bans);
        }
    }

    connectedUsers.set(socket.id, {
        id: socket.id, partnerId: null, location: 'Desconhecido', isAdmin: false, ip
    });

    // admin_register precisa do token JWT
    socket.on('admin_register', (token) => {
        try {
            const payload = jwt.verify(String(token || ''), JWT_SECRET);
            if (payload.role !== 'admin') throw new Error('role');
            adminSessions.add(socket.id);
            const u = connectedUsers.get(socket.id);
            if (u) { u.isAdmin = true; u.partnerId = null; }
        } catch (e) {
            socket.emit('admin_register_failed', { error: 'Token inválido' });
        }
    });

    socket.on('join', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || u.partnerId) return;
        if (data && typeof data.location === 'string') u.location = data.location.slice(0, 60);

        // procura parceiro real
        let realP = null;
        for (const [uid, ud] of connectedUsers) {
            if (uid !== socket.id && !ud.partnerId && !adminSessions.has(uid)) {
                realP = io.sockets.sockets.get(uid);
                break;
            }
        }
        if (realP) {
            u.partnerId = realP.id;
            const pu = connectedUsers.get(realP.id);
            if (pu) pu.partnerId = socket.id;
            socket.emit('chat_start', { partnerId: realP.id });
            realP.emit('chat_start', { partnerId: socket.id });
        } else {
            socket.emit('waiting');
            setTimeout(() => {
                if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId && !adminSessions.has(socket.id)) {
                    new Bot(socket).start();
                }
            }, 3000);
        }
    });

    socket.on('message', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        const text = (data && typeof data.text === 'string') ? data.text.slice(0, 2000) : '';
        if (!text.trim()) return;

        const rate = verificarRateLimit(socket.id);
        if (!rate.allowed) {
            // CORREÇÃO: envia remainingSeconds para o cliente ajustar o cooldown
            socket.emit('system_message', {
                message: `⏳ Aguarde ${rate.remainingSeconds}s antes de enviar outra mensagem.`,
                remainingSeconds: rate.remainingSeconds
            });
            return;
        }

        // SEGURANÇA: filtro no servidor também
        if (contemPalavraOfensiva(text)) {
            socket.emit('message_blocked', {
                reason: 'Sua mensagem contém linguagem que viola as diretrizes da comunidade.'
            });
            return;
        }

        const replyTo = data && data.replyTo ? data.replyTo : undefined;
        if (activeBots.has(u.partnerId)) {
            activeBots.get(u.partnerId).handleMsg(text);
        } else {
            const p = io.sockets.sockets.get(u.partnerId);
            if (p) p.emit('message', { text, senderId: socket.id, location: u.location, replyTo });
        }

        stats.totalMessages = (stats.totalMessages || 0) + 1;
        const h = new Date().toISOString().split('T')[0];
        stats.dailyMessages[h] = (stats.dailyMessages[h] || 0) + 1;
        escreverArquivo('stats.json', stats);
    });

    // RELAY de digitação
    socket.on('typing', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activeBots.has(u.partnerId)) return; // bot não "digita" via relay
        const p = io.sockets.sockets.get(u.partnerId);
        if (p) p.emit('typing', { isTyping: !!(data && data.isTyping) });
    });

    // DENÚNCIA
    socket.on('report_user', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u) return;
        const reportedUserId = data && data.reportedUserId;
        if (!reportedUserId) return;

        let reportedIp = 'Desconhecido';
        let reportedMsg = '';
        if (activeBots.has(reportedUserId)) {
            reportedIp = 'BOT';
        } else {
            const ru = connectedUsers.get(reportedUserId);
            if (ru) reportedIp = ru.ip;
        }
        if (data && typeof data.reportedMessage === 'string') reportedMsg = data.reportedMessage.slice(0, 1000);

        const report = {
            reportId: 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            reporterIP: u.ip,
            reporterId: socket.id,
            reportedIP: reportedIp,
            reportedUserId,
            reportedMessage: reportedMsg || '(sem mensagem anexada)',
            reason: String(data && data.reason || 'outro').slice(0, 100),
            priority: (data && data.reason === 'assédio') ? 'high' : 'medium',
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        reports.push(report);
        escreverArquivo('reports.json', reports);
        registrarLog(`Denúncia ${report.reportId} de ${u.ip} contra ${reportedIp} (${report.reason})`);
        socket.emit('report_thanks', { message: '✅ Denúncia registrada! Obrigado por ajudar.' });
    });

    socket.on('end_chat', () => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activePongGames.has(socket.id)) activePongGames.get(socket.id).end('chat_ended');
        if (activeTttGames.has(socket.id)) activeTttGames.get(socket.id).leave(socket.id);
        const pid = u.partnerId;
        u.partnerId = null;
        if (activeBots.has(pid)) activeBots.get(pid).disconnect();
        else {
            const p = io.sockets.sockets.get(pid);
            if (p) {
                p.emit('chat_ended');
                const pd = connectedUsers.get(pid);
                if (pd) pd.partnerId = null;
            }
        }
        socket.emit('chat_ended');
    });

    // ============ PONG ============
    socket.on('pong_invite', () => {
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        // permite convidar bot também
        if (activeBots.has(u.partnerId)) {
            const bot = activeBots.get(u.partnerId);
            if (bot.inGame) { socket.emit('system_message', { message: 'O bot já está em jogo.' }); return; }
            // bot aceita automaticamente após pequeno delay
            socket.emit('system_message', { message: 'Convite aceito pelo bot! Iniciando...' });
            setTimeout(() => {
                if (!activePongGames.has(socket.id) && connectedUsers.get(socket.id)?.partnerId === bot.id) {
                    new PongGame(socket.id, bot.id, true).start();
                }
            }, 800);
            return;
        }
        const p = io.sockets.sockets.get(u.partnerId);
        if (p) {
            pendingPongInvites.set(socket.id, u.partnerId);
            p.emit('pong_invite_received');
            socket.emit('system_message', { message: "Convite enviado." });
        }
    });

    socket.on('pong_accept', () => {
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activePongGames.has(socket.id)) return;
        // encontra quem convidou (parceiro)
        pendingPongInvites.delete(u.partnerId);
        const isBot = activeBots.has(u.partnerId);
        new PongGame(socket.id, u.partnerId, isBot).start();
    });

    socket.on('pong_decline', () => {
        const u = connectedUsers.get(socket.id);
        if (!u) return;
        // avisa quem convidou
        for (const [fromId, toId] of pendingPongInvites) {
            if (toId === socket.id) {
                const s = io.sockets.sockets.get(fromId);
                if (s) s.emit('system_message', { message: 'O convite de Pong foi recusado.' });
                pendingPongInvites.delete(fromId);
            }
        }
    });

    socket.on('pong_move', (d) => {
        const g = activePongGames.get(socket.id);
        if (g && d && typeof d.paddleX !== 'undefined') g.movePaddle(socket.id, d.paddleX);
    });

    socket.on('pong_leave', () => {
        const g = activePongGames.get(socket.id);
        if (g) g.end('leave');
    });

    // ============ JOGO DA VELHA ============
    socket.on('tictactoe_invite', () => {
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activeBots.has(u.partnerId)) {
            socket.emit('system_message', { message: 'O bot não joga Jogo da Velha. Desafie um humano!' });
            return;
        }
        const p = io.sockets.sockets.get(u.partnerId);
        if (p) {
            pendingTttInvites.set(socket.id, u.partnerId);
            p.emit('tictactoe_invite_received');
            socket.emit('system_message', { message: "Convite de Jogo da Velha enviado." });
        }
    });

    socket.on('tictactoe_accept', () => {
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activeTttGames.has(socket.id)) return;
        pendingTttInvites.delete(u.partnerId);
        const g = new TicTacToeGame(u.partnerId, socket.id);
        g.start();
    });

    socket.on('tictactoe_decline', () => {
        const u = connectedUsers.get(socket.id);
        if (!u) return;
        for (const [fromId, toId] of pendingTttInvites) {
            if (toId === socket.id) {
                const s = io.sockets.sockets.get(fromId);
                if (s) s.emit('system_message', { message: 'O convite do Jogo da Velha foi recusado.' });
                pendingTttInvites.delete(fromId);
            }
        }
    });

    socket.on('tictactoe_move', (data) => {
        const g = activeTttGames.get(socket.id);
        if (g && data) g.move(socket.id, data.position);
    });

    socket.on('tictactoe_leave', () => {
        const g = activeTttGames.get(socket.id);
        if (g) g.leave(socket.id);
        else {
            // pode estar saindo de um convite pendente
            pendingTttInvites.delete(socket.id);
            for (const [fromId, toId] of pendingTttInvites) {
                if (toId === socket.id) pendingTttInvites.delete(fromId);
            }
        }
    });

    // ============ DISCONNECT ============
    socket.on('disconnect', () => {
        try {
            if (activePongGames.has(socket.id)) activePongGames.get(socket.id).end('disconnected');
            if (activeTttGames.has(socket.id)) activeTttGames.get(socket.id).leave(socket.id);

            const u = connectedUsers.get(socket.id);
            if (u && u.partnerId) {
                if (activeBots.has(u.partnerId)) {
                    const bot = activeBots.get(u.partnerId);
                    if (bot) bot.disconnect();
                } else {
                    const p = io.sockets.sockets.get(u.partnerId);
                    if (p) {
                        p.emit('partner_disconnected');
                        const pd = connectedUsers.get(u.partnerId);
                        if (pd) pd.partnerId = null;
                    }
                }
            }
            adminSessions.delete(socket.id);
            connectedUsers.delete(socket.id);
            messageRateLimit.delete(socket.id);
            pendingPongInvites.delete(socket.id);
            pendingTttInvites.delete(socket.id);
            for (const [fromId, toId] of pendingPongInvites) if (toId === socket.id) pendingPongInvites.delete(fromId);
            for (const [fromId, toId] of pendingTttInvites) if (toId === socket.id) pendingTttInvites.delete(fromId);
        } catch (e) {
            console.error('Erro no disconnect:', e);
        }
    });
});

// ================= CONTADOR ONLINE =================
setInterval(() => {
    const r = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
    let t = fakeOnlineBase + r + (Math.floor(Math.random() * 12) - 4);
    if (t < r) t = r;
    // CORREÇÃO: atualiza peakUsers
    if (t > (stats.peakUsers || 0)) {
        stats.peakUsers = t;
        escreverArquivo('stats.json', stats);
    }
    io.emit('users_online', t);
}, 4500);

// limpeza periódica de bans expirados
setInterval(() => {
    const now = Date.now();
    const before = bans.length;
    bans = bans.filter(b => !b.expiresAt || new Date(b.expiresAt).getTime() > now);
    if (bans.length !== before) escreverArquivo('bans.json', bans);
}, 60 * 60 * 1000); // a cada hora

server.listen(PORT, () => console.log(`🚀 AthesChat rodando na porta ${PORT}`));