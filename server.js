const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const helmet = require('helmet'); // NOVO: Segurança de cabeçalhos

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configuração do Helmet para segurança
app.use(helmet({
    contentSecurityPolicy: false, // Desativado para não bloquear scripts inline do seu front-end
    crossOriginEmbedderPolicy: false
}));

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= ROTAS PRINCIPAIS =================
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('<h1>AthesChat</h1><p>Servidor funcionando! Aguardando index.html</p>');
    }
});

// ================= ROTAS DO ADMIN =================
const adminPath = path.join(__dirname, 'admin');
if (!fs.existsSync(adminPath)) {
    fs.mkdirSync(adminPath, { recursive: true });
}

app.use('/admin', express.static(adminPath));

app.get('/admin', (req, res) => {
    const adminIndexPath = path.join(adminPath, 'index.html');
    if (fs.existsSync(adminIndexPath)) {
        res.sendFile(adminIndexPath);
    } else {
        res.status(404).send(`
            <h1>Painel Admin não encontrado</h1>
            <p>Crie o arquivo admin/index.html</p>
            <a href="/">Voltar</a>
        `);
    }
});

app.post('/admin/login', express.json(), (req, res) => {
    const { username, password } = req.body;
    
    // Usa as variáveis de ambiente (se configuradas no Render) ou o fallback antigo
    const ADMIN_USERNAME = process.env.ADMIN_USER || "eusouVitoriosoathes";
    const ADMIN_PASSWORD = process.env.ADMIN_PASS || "atheschatthebestintheworld#1";

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
        res.json({ success: true, token: token });
    } else {
        res.status(401).json({ success: false, message: "Credenciais inválidas" });
    }
});

function verificarTokenAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) {
        return res.status(403).json({ error: "Acesso negado" });
    }
    next();
}

// ================= FUNÇÕES DE ARQUIVO =================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function lerArquivo(nome, padrao = {}) {
    try {
        const filePath = path.join(dataDir, nome);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return padrao;
    } catch (e) { 
        return padrao; 
    }
}

function escreverArquivo(nome, dados) {
    try {
        fs.writeFileSync(path.join(dataDir, nome), JSON.stringify(dados, null, 2), 'utf8');
    } catch(e) {}
}

// ================= DADOS INICIAIS =================
let stats = lerArquivo('stats.json', {
    totalMessages: 0,
    dailyMessages: {},
    weeklyMessages: {},
    peakUsers: 0,
    gamesPlayed: { pong: 0, tictactoe: 0 }
});

if (!stats.dailyMessages) stats.dailyMessages = {};
if (!stats.gamesPlayed) stats.gamesPlayed = { pong: 0, tictactoe: 0 };

let bans = lerArquivo('bans.json', []);
let reports = lerArquivo('reports.json', []);
let adminLogs = lerArquivo('admin_logs.json', []);

let palavrasOfensivas = [];

function carregarPalavrasOfensivas() {
    try {
        const palavrasPath = path.join(__dirname, 'public', 'palavras_proibidas.json');
        if (fs.existsSync(palavrasPath)) {
            palavrasOfensivas = JSON.parse(fs.readFileSync(palavrasPath, 'utf8'));
            console.log(`📋 Carregadas ${palavrasOfensivas.length} palavras ofensivas`);
        }
    } catch (e) {
        console.error('Erro ao carregar palavras ofensivas:', e);
    }
}

function contemPalavraOfensiva(texto) {
    if (palavrasOfensivas.length === 0) return false;
    return palavrasOfensivas.some(palavra => {
        const regex = new RegExp(`\\b${palavra.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        return regex.test(texto);
    });
}

carregarPalavrasOfensivas();

// ================= API ADMIN =================
app.get('/admin/api/stats', verificarTokenAdmin, (req, res) => {
    const hoje = new Date().toISOString().split('T')[0];
    if (!stats.dailyMessages) stats.dailyMessages = {};
    const mensagensHoje = stats.dailyMessages[hoje] || 0;

    res.json({
        onlineNow: Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length,
        activeBots: activeBots.size,
        messagesToday: mensagensHoje,
        pendingReports: reports.filter(r => r.status === 'pending').length,
        activeGames: (activePongGames.size || 0) + (activeTicTacToeGames.size || 0),
        totalBanned: bans.length,
        peakUsers: stats.peakUsers || 0
    });
});

app.get('/admin/api/reports', verificarTokenAdmin, (req, res) => { res.json(reports); });

app.post('/admin/api/reports/:id/action', express.json(), verificarTokenAdmin, (req, res) => {
    const { id } = req.params;
    const { action, reason, duration, warningMessage } = req.body;

    const reportIndex = reports.findIndex(r => r.reportId === id);
    if (reportIndex === -1) return res.status(404).json({ error: "Denúncia não encontrada" });

    const report = reports[reportIndex];
    report.status = 'reviewed';
    report.reviewedAt = new Date().toISOString();
    report.actionTaken = action;

    adminLogs.unshift({ timestamp: new Date().toISOString(), mensagem: `Admin: ${action} aplicado ao IP ${report.reportedIP}` });
    if (adminLogs.length > 10) adminLogs.pop();
    escreverArquivo('admin_logs.json', adminLogs);

    if (action === 'ban' || action === 'suspend') {
        const expiresAt = (action === 'suspend' && duration) ? new Date(Date.now() + duration * 86400000) : null;
        if (!bans.some(b => b.userIP === report.reportedIP)) {
            bans.push({ userId: report.reportedUserId, userIP: report.reportedIP, reason: reason, bannedAt: new Date().toISOString(), expiresAt: expiresAt });
            escreverArquivo('bans.json', bans);
        }
        for (const [socketId, userData] of connectedUsers) {
            if (userData.ip === report.reportedIP) {
                const bannedSocket = io.sockets.sockets.get(socketId);
                if (bannedSocket) { bannedSocket.emit('you_are_banned', { reason: reason }); bannedSocket.disconnect(); }
            }
        }
    } else if (action === 'warning' && warningMessage) {
        for (const [socketId, userData] of connectedUsers) {
            if (userData.ip === report.reportedIP) {
                const warnedSocket = io.sockets.sockets.get(socketId);
                if (warnedSocket) warnedSocket.emit('system_message', { message: `⚠️ AVISO DO ADMIN: ${warningMessage}` });
            }
        }
    }

    escreverArquivo('reports.json', reports);
    res.json({ success: true });
});

app.get('/admin/api/bans', verificarTokenAdmin, (req, res) => { res.json(bans); });

app.post('/admin/api/bans', express.json(), verificarTokenAdmin, (req, res) => {
    const { userId, userIP, reason, duration } = req.body;
    const expiresAt = duration === 'permanent' ? null : new Date(Date.now() + duration * 86400000);
    
    let targetIP = userIP;
    if (userId && !targetIP) {
        const userData = connectedUsers.get(userId);
        if (userData) targetIP = userData.ip;
    }
    
    if (!targetIP) return res.status(400).json({ error: "IP do usuário não encontrado" });
    
    if (!bans.some(b => b.userIP === targetIP)) {
        bans.push({ userId: userId || 'Desconhecido', userIP: targetIP, reason: reason, bannedAt: new Date().toISOString(), expiresAt: expiresAt });
        escreverArquivo('bans.json', bans);
    }
    
    for (const [socketId, userData] of connectedUsers) {
        if (userData.ip === targetIP) {
            const bannedSocket = io.sockets.sockets.get(socketId);
            if (bannedSocket) { bannedSocket.emit('you_are_banned', { reason: reason }); bannedSocket.disconnect(); }
        }
    }
    res.json({ success: true });
});

app.delete('/admin/api/bans/:userIP', verificarTokenAdmin, (req, res) => {
    const decodedIP = decodeURIComponent(req.params.userIP);
    const index = bans.findIndex(b => b.userIP === decodedIP);
    if (index !== -1) bans.splice(index, 1);
    escreverArquivo('bans.json', bans);
    res.json({ success: true });
});

app.post('/admin/api/broadcast', express.json(), verificarTokenAdmin, (req, res) => {
    const { message, textColor, bgColor, fontSize, speed, duration, effect } = req.body;
    io.emit('admin_broadcast', { message, textColor: textColor || '#ffffff', bgColor: bgColor || '#e94560', fontSize: fontSize || 16, speed: speed || 15, duration: duration || 10, effect: effect || 'slide' });
    adminLogs.unshift({ timestamp: new Date().toISOString(), mensagem: `Admin enviou broadcast: ${message.substring(0, 50)}` });
    if (adminLogs.length > 10) adminLogs.pop();
    escreverArquivo('admin_logs.json', adminLogs);
    res.json({ success: true });
});

app.get('/admin/api/logs', verificarTokenAdmin, (req, res) => { res.json(adminLogs.slice(0, 10)); });

// ================= VARIÁVEIS GLOBAIS =================
const connectedUsers = new Map();
const activeBots = new Map();
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;
const activePongGames = new Map();
const activeTicTacToeGames = new Map();
const adminSessions = new Set();

// ================= ANTI-SPAM =================
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX_MESSAGES = 25;
const RATE_LIMIT_BLOCK_MS = 5000;
const messageRateLimit = new Map();

function verificarRateLimit(socketId) {
    const now = Date.now();
    let rateData = messageRateLimit.get(socketId);
    if (!rateData) { rateData = { timestamps: [], blockedUntil: 0 }; messageRateLimit.set(socketId, rateData); }
    if (rateData.blockedUntil > now) return { allowed: false, remainingSeconds: Math.ceil((rateData.blockedUntil - now) / 1000) };
    rateData.timestamps = rateData.timestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    rateData.timestamps.push(now);
    if (rateData.timestamps.length > RATE_LIMIT_MAX_MESSAGES) {
        rateData.blockedUntil = now + RATE_LIMIT_BLOCK_MS;
        rateData.timestamps = [];
        return { allowed: false, remainingSeconds: Math.ceil(RATE_LIMIT_BLOCK_MS / 1000) };
    }
    return { allowed: true };
}

// ================= BOT =================
const botConversationLogic = {
    greetings: ["Olá!", "E aí, tudo bem?", "Oi, como vai?", "Opa, tudo certo?"],
    questions: ["O que você gosta de fazer?", "Qual seu filme favorito?", "Ouve que tipo de música?", "De onde você fala?"],
    keywords: {
        'tudo bem': ["Tudo ótimo por aqui, e com você?", "Tudo certo, e por aí?", "Vou bem, obrigado por perguntar!"],
        'qual seu nome': ["Sou anônimo, assim como você haha", "Prefiro não dizer.", "Me chame de... Anônimo."],
        'você é um bot': ["Haha, será? 🤔", "O que te faz pensar isso?", "Sou apenas mais um anônimo na rede."],
        'filme': ["Adoro filmes! Viu algum bom recentemente?", "Gosto de ficção científica. E você?", "Prefiro séries."],
        'música': ["Música é vida! Curto de tudo.", "Qual sua banda preferida?"],
    },
    fallbacks: ["Interessante...", "Hmm, me conte mais.", "Não sei muito sobre isso.", "Entendi.", "Sério?"]
};

class Bot {
    constructor(partnerSocket) {
        this.id = "bot_" + Date.now();
        this.partnerId = partnerSocket.id;
        this.partnerSocket = partnerSocket;
        this.location = ["São Paulo", "Rio de Janeiro", "Minas Gerais", "Bahia", "Paraná"][Math.floor(Math.random() * 5)];
        activeBots.set(this.id, this);
    }
    startConversation() {
        const userData = connectedUsers.get(this.partnerId);
        if (userData) userData.partnerId = this.id;
        this.partnerSocket.emit('chat_start', { partnerId: this.id });
        setTimeout(() => { this.sendMessage(botConversationLogic.greetings[Math.floor(Math.random() * botConversationLogic.greetings.length)]); }, 1500);
    }
    handleMessage(text) {
        this.partnerSocket.emit('typing', { isTyping: true });
        setTimeout(() => {
            let response = this.findResponse(text);
            this.sendMessage(response);
        }, 1000 + Math.random() * 1500);
    }
    findResponse(text) {
        const lowerText = text.toLowerCase();
        for (const keyword in botConversationLogic.keywords) {
            if (lowerText.includes(keyword)) {
                const resps = botConversationLogic.keywords[keyword];
                return resps[Math.floor(Math.random() * resps.length)];
            }
        }
        if (Math.random() > 0.6) return botConversationLogic.questions[Math.floor(Math.random() * botConversationLogic.questions.length)];
        return botConversationLogic.fallbacks[Math.floor(Math.random() * botConversationLogic.fallbacks.length)];
    }
    sendMessage(text) {
        this.partnerSocket.emit('typing', { isTyping: false });
        this.partnerSocket.emit('message', { text: text, senderId: this.id, location: this.location });
    }
    disconnect() {
        setTimeout(() => {
            const partnerData = connectedUsers.get(this.partnerId);
            if (partnerData && partnerData.partnerId === this.id) {
                this.partnerSocket.emit('chat_ended');
                partnerData.partnerId = null;
            }
            activeBots.delete(this.id);
        }, 1000);
    }
}

// ================= JOGO PONG =================
const PONG_CONFIG = { CANVAS_WIDTH: 300, CANVAS_HEIGHT: 400, PADDLE_WIDTH: 60, PADDLE_HEIGHT: 10, BALL_RADIUS: 5, INITIAL_BALL_SPEED_X: 2.5, INITIAL_BALL_SPEED_Y: 2.5, MAX_GOALS: 3, GAME_DURATION_MS: 3 * 60 * 1000, UPDATE_INTERVAL: 1000 / 60, COUNTDOWN_SECONDS: 3 };

class PongGame {
    constructor(p1, p2) {
        this.player1 = { id: p1, socket: io.sockets.sockets.get(p1), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.player2 = { id: p2, socket: io.sockets.sockets.get(p2), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.ball = {}; this.ball2 = null; this.isSuddenDeath = false; this.gamePaused = true; this.lastLoser = null;
        activePongGames.set(p1, this); activePongGames.set(p2, this);
        this.gameLoop = null; this.durationTimer = null; this.timeRemaining = PONG_CONFIG.GAME_DURATION_MS;
        if (!stats.gamesPlayed) stats.gamesPlayed = { pong: 0, tictactoe: 0 };
        stats.gamesPlayed.pong = (stats.gamesPlayed.pong || 0) + 1;
        escreverArquivo('stats.json', stats);
    }
    broadcast(event, data) { if(this.player1.socket) this.player1.socket.emit(event, data); if(this.player2.socket) this.player2.socket.emit(event, data); }
    start() { 
        if (this.player1.socket) this.player1.socket.emit('pong_start', { opponentId: this.player2.id }); 
        if (this.player2.socket) this.player2.socket.emit('pong_start', { opponentId: this.player1.id }); 
        this.durationTimer = setInterval(() => this.tick(), 1000); 
        this.startRound(); 
    }
    startRound() { 
        this.gamePaused = true; clearInterval(this.gameLoop); this.broadcastState(); this.broadcast('pong_countdown_start'); 
        setTimeout(() => { 
            this.resetBall(this.ball, this.lastLoser); 
            if (this.isSuddenDeath) { if (!this.ball2) this.ball2 = {}; this.resetBall(this.ball2, this.lastLoser, true); } 
            this.gamePaused = false; this.lastLoser = null; this.gameLoop = setInterval(() => this.update(), PONG_CONFIG.UPDATE_INTERVAL); 
        }, PONG_CONFIG.COUNTDOWN_SECONDS * 1000); 
    }
    tick() { if(this.gamePaused) return; this.timeRemaining -= 1000; this.broadcast('pong_time_update', { time: this.timeRemaining }); if (this.timeRemaining <= 0) this.end('time_up'); }
    resetBall(ball, loserId, isSecondBall = false) { 
        ball.x = PONG_CONFIG.CANVAS_WIDTH / 2; ball.y = PONG_CONFIG.CANVAS_HEIGHT / 2; ball.speedMultiplier = 1.0; ball.rallyCount = 0; 
        ball.vx = (isSecondBall ? -1 : 1) * (Math.random() > 0.5 ? 1 : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_X; 
        ball.vy = (loserId ? (loserId === this.player1.id ? 1 : -1) : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_Y; 
    }
    update() { if (this.gamePaused) return; this.updateBall(this.ball); if (this.isSuddenDeath && this.ball2) this.updateBall(this.ball2); this.broadcastState(); }
    updateBall(ball) { 
        if (!ball || !ball.x) return; ball.x += ball.vx * ball.speedMultiplier; ball.y += ball.vy * ball.speedMultiplier; 
        if (ball.x - PONG_CONFIG.BALL_RADIUS < 0 || ball.x + PONG_CONFIG.BALL_RADIUS > PONG_CONFIG.CANVAS_WIDTH) ball.vx *= -1; 
        const hitP1 = ball.y + PONG_CONFIG.BALL_RADIUS >= PONG_CONFIG.CANVAS_HEIGHT - PONG_CONFIG.PADDLE_HEIGHT && ball.vy > 0 && ball.x >= this.player1.paddleX && ball.x <= this.player1.paddleX + PONG_CONFIG.PADDLE_WIDTH; 
        const hitP2 = ball.y - PONG_CONFIG.BALL_RADIUS <= PONG_CONFIG.PADDLE_HEIGHT && ball.vy < 0 && ball.x >= this.player2.paddleX && ball.x <= this.player2.paddleX + PONG_CONFIG.PADDLE_WIDTH; 
        if (hitP1 || hitP2) { 
            const pX = hitP1 ? this.player1.paddleX : this.player2.paddleX; 
            const normInt = ((pX + (PONG_CONFIG.PADDLE_WIDTH / 2)) - ball.x) / (PONG_CONFIG.PADDLE_WIDTH / 2); 
            const bounceAngle = normInt * ((5 * Math.PI) / 12); 
            const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy); 
            ball.vx = speed * Math.sin(bounceAngle) * -1; ball.vy = speed * Math.cos(bounceAngle) * (hitP1 ? -1 : 1); 
            ball.rallyCount++; if (ball.rallyCount > 0 && ball.rallyCount % 5 === 0) ball.speedMultiplier = Math.min(2.5, ball.speedMultiplier + 0.15); 
        } 
        if (ball.y > PONG_CONFIG.CANVAS_HEIGHT + PONG_CONFIG.BALL_RADIUS) this.handleGoal(this.player2, this.player1.id); 
        else if (ball.y < -PONG_CONFIG.BALL_RADIUS) this.handleGoal(this.player1, this.player2.id); 
    }
    handleGoal(winner, loserId) { this.lastLoser = loserId; winner.score++; if (this.isSuddenDeath || winner.score >= PONG_CONFIG.MAX_GOALS) this.end('score_limit'); else this.startRound(); }
    movePaddle(playerId, paddleX) { if (this.gamePaused) return; if (playerId === this.player1.id) this.player1.paddleX = paddleX; else if (playerId === this.player2.id) this.player2.paddleX = paddleX; }
    broadcastState() { 
        if(this.player1.socket) this.player1.socket.emit('pong_update', { ball: this.ball, ball2: this.isSuddenDeath ? this.ball2 : null, you: { score: this.player1.score, paddleX: this.player1.paddleX }, opponent: { score: this.player2.score, paddleX: this.player2.paddleX } }); 
        const flipY = (y) => PONG_CONFIG.CANVAS_HEIGHT - y; 
        const fB1 = this.ball.x ? { x: this.ball.x, y: flipY(this.ball.y), vx: this.ball.vx, vy: this.ball.vy, speedMultiplier: this.ball.speedMultiplier, rallyCount: this.ball.rallyCount } : this.ball; 
        let fB2 = null; if (this.isSuddenDeath && this.ball2 && this.ball2.x) fB2 = { x: this.ball2.x, y: flipY(this.ball2.y), vx: this.ball2.vx, vy: this.ball2.vy, speedMultiplier: this.ball2.speedMultiplier, rallyCount: this.ball2.rallyCount }; 
        if(this.player2.socket) this.player2.socket.emit('pong_update', { ball: fB1, ball2: fB2, you: { score: this.player2.score, paddleX: this.player2.paddleX }, opponent: { score: this.player1.score, paddleX: this.player1.paddleX } }); 
    }
    end(reason) { 
        clearInterval(this.gameLoop); clearInterval(this.durationTimer); this.gamePaused = true; 
        if (reason === 'time_up' && this.player1.score === this.player2.score && !this.isSuddenDeath) { this.isSuddenDeath = true; this.broadcast('system_message', { message: '🏆 EMPATE! Morte súbita ativada!' }); this.startRound(); return; } 
        if(this.player1.socket) this.player1.socket.emit('pong_end', { reason: reason, yourScore: this.player1.score, opponentScore: this.player2.score }); 
        if(this.player2.socket) this.player2.socket.emit('pong_end', { reason: reason, yourScore: this.player2.score, opponentScore: this.player1.score }); 
        activePongGames.delete(this.player1.id); activePongGames.delete(this.player2.id); 
    }
}

// ================= JOGO DA VELHA =================
const TTT_CONFIG = { WIN_PATTERNS: [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]] };
class TicTacToeGame {
    constructor(p1, p2) {
        this.player1 = { id: p1, socket: io.sockets.sockets.get(p1), symbol: null };
        this.player2 = { id: p2, socket: io.sockets.sockets.get(p2), symbol: null };
        if (Math.random() < 0.5) { this.player1.symbol = 'X'; this.player2.symbol = 'O'; this.currentTurn = p1; this.firstPlayer = p1; }
        else { this.player1.symbol = 'O'; this.player2.symbol = 'X'; this.currentTurn = p2; this.firstPlayer = p2; }
        this.board = Array(9).fill(null); this.gameActive = true; this.winner = null; this.isDraw = false;
        activeTicTacToeGames.set(p1, this); activeTicTacToeGames.set(p2, this);
        if (!stats.gamesPlayed) stats.gamesPlayed = { pong: 0, tictactoe: 0 };
        stats.gamesPlayed.tictactoe = (stats.gamesPlayed.tictactoe || 0) + 1;
        escreverArquivo('stats.json', stats);
    }
    broadcast(event, data) { if(this.player1.socket) this.player1.socket.emit(event, data); if(this.player2.socket) this.player2.socket.emit(event, data); }
    start() { 
        if(this.player1.socket) this.player1.socket.emit('tictactoe_start', { opponentId: this.player2.id, yourSymbol: this.player1.symbol, firstTurn: this.currentTurn === this.player1.id });
        if(this.player2.socket) this.player2.socket.emit('tictactoe_start', { opponentId: this.player1.id, yourSymbol: this.player2.symbol, firstTurn: this.currentTurn === this.player2.id });
        this.broadcastState(); 
    }
    makeMove(playerId, pos) { 
        if (!this.gameActive || playerId !== this.currentTurn || pos < 0 || pos >= 9 || this.board[pos] !== null) return; 
        const symbol = playerId === this.player1.id ? this.player1.symbol : this.player2.symbol; 
        this.board[pos] = symbol; 
        const win = this.checkWin(symbol); 
        if (win) { 
            this.gameActive = false; this.winner = playerId; 
            this.broadcast('tictactoe_game_over', { winner: playerId, winnerSymbol: symbol, winPattern: win, isDraw: false }); 
            this.end(); return; 
        } 
        if (this.board.every(c => c !== null)) { 
            this.gameActive = false; this.isDraw = true; 
            this.broadcast('tictactoe_game_over', { winner: null, winnerSymbol: null, isDraw: true }); 
            this.end(); return; 
        } 
        this.currentTurn = (this.currentTurn === this.player1.id) ? this.player2.id : this.player1.id; 
        this.broadcastState(); 
    }
    checkWin(sym) { for (const p of TTT_CONFIG.WIN_PATTERNS) { if (this.board[p[0]] === sym && this.board[p[1]] === sym && this.board[p[2]] === sym) return p; } return null; }
    broadcastState() { 
        this.broadcast('tictactoe_update', { board: this.board, currentTurn: this.currentTurn, gameActive: this.gameActive, currentTurnSymbol: this.currentTurn === this.player1.id ? this.player1.symbol : this.player2.symbol }); 
    }
    end() { 
        activeTicTacToeGames.delete(this.player1.id); activeTicTacToeGames.delete(this.player2.id); 
        setTimeout(() => { if(this.player1.socket) this.player1.socket.emit('tictactoe_close'); if(this.player2.socket) this.player2.socket.emit('tictactoe_close'); }, 3000); 
    }
    forceEnd() { this.broadcast('system_message', { message: "🚪 Oponente saiu do jogo." }); this.end(); }
}

// ================= CONEXÃO SOCKET.IO =================
io.on('connection', (socket) => {
    const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'Desconhecido';
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido', isAdmin: false, ip: clientIP });

    socket.on('admin_register', (token) => {
        adminSessions.add(socket.id);
        const userData = connectedUsers.get(socket.id);
        if (userData) userData.isAdmin = true;
        socket.emit('admin_registered');
    });

    socket.on('join', (data) => {
        if (adminSessions.has(socket.id)) { socket.emit('system_message', { message: "Você está logado como admin. Saia do painel para conversar." }); return; }
        const userData = connectedUsers.get(socket.id);
        if (!userData || userData.partnerId) return;
        if (data?.location) userData.location = data.location;

        let realPartner = null;
        for (const [uid, ud] of connectedUsers) { if (uid !== socket.id && !ud.partnerId && !adminSessions.has(uid)) { realPartner = io.sockets.sockets.get(uid); break; } }
        
        if (realPartner) {
            const u1 = connectedUsers.get(socket.id), u2 = connectedUsers.get(realPartner.id);
            u1.partnerId = realPartner.id; u2.partnerId = socket.id;
            socket.emit('chat_start', { partnerId: realPartner.id }); realPartner.emit('chat_start', { partnerId: socket.id });
        } else {
            socket.emit('waiting');
            setTimeout(() => { if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId && !adminSessions.has(socket.id)) new Bot(socket).startConversation(); }, 3000);
        }
    });

    socket.on('message', (data) => {
        if (adminSessions.has(socket.id)) return;
        const senderData = connectedUsers.get(socket.id);
        if (!senderData?.partnerId) return;

        const rateCheck = verificarRateLimit(socket.id);
        if (!rateCheck.allowed) {
            if (rateCheck.remainingSeconds >= Math.ceil(RATE_LIMIT_BLOCK_MS / 1000)) {
                socket.emit('system_message', { message: `⚠️ Calma aí! Você está enviando mensagens muito rápido. Aguarde ${rateCheck.remainingSeconds} segundos.` });
            } else {
                socket.emit('system_message', { message: `⏳ Espere ${rateCheck.remainingSeconds}s antes de enviar outra mensagem.` });
            }
            return;
        }

        const userBan = bans.find(b => b.userIP === senderData.ip);
        if (userBan && userBan.expiresAt && new Date(userBan.expiresAt) > new Date()) {
            socket.emit('you_are_banned', { reason: userBan.reason }); socket.disconnect(); return;
        }

        const isOffensive = contemPalavraOfensiva(data.text);
        const partnerId = senderData.partnerId;
        if (activeBots.has(partnerId)) activeBots.get(partnerId).handleMessage(data.text);
        else {
            const pSocket = io.sockets.sockets.get(partnerId);
            if (pSocket) pSocket.emit('message', { text: data.text, senderId: socket.id, replyTo: data.replyTo || null, location: senderData.location });
        }

        io.emit('chat_message', { senderId: socket.id, text: data.text, senderIP: senderData.ip, isOffensive: isOffensive });
        const hoje = new Date().toISOString().split('T')[0];
        if (!stats.dailyMessages) stats.dailyMessages = {};
        stats.dailyMessages[hoje] = (stats.dailyMessages[hoje] || 0) + 1;
        stats.totalMessages = (stats.totalMessages || 0) + 1;
        const online = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
        if (online > (stats.peakUsers || 0)) stats.peakUsers = online;
        escreverArquivo('stats.json', stats);
    });

    socket.on('typing', (data) => {
        if (adminSessions.has(socket.id)) return;
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId && !activeBots.has(partnerId)) { const p = io.sockets.sockets.get(partnerId); if(p) p.emit('typing', data); }
    });

    socket.on('end_chat', () => {
        if (adminSessions.has(socket.id)) return;
        const userData = connectedUsers.get(socket.id);
        if (!userData?.partnerId) return;
        if (activePongGames.has(socket.id)) activePongGames.get(socket.id)?.end('chat_ended');
        if (activeTicTacToeGames.has(socket.id)) activeTicTacToeGames.get(socket.id)?.forceEnd();
        const pId = userData.partnerId; userData.partnerId = null;
        if (activeBots.has(pId)) activeBots.get(pId)?.disconnect();
        else { const pSocket = io.sockets.sockets.get(pId); if(pSocket) { pSocket.emit('chat_ended'); const pd = connectedUsers.get(pId); if(pd) pd.partnerId = null; } }
        socket.emit('chat_ended');
    });

    socket.on('report_user', (data) => {
        const rData = connectedUsers.get(socket.id);
        const tData = connectedUsers.get(data.reportedUserId);
        const rIP = tData ? tData.ip : 'Desconhecido';
        reports.unshift({ reportId: Date.now().toString(), reporterId: socket.id, reportedUserId: data.reportedUserId, reportedIP: rIP, reportedMessage: data.reportedMessage || "", reason: data.reason, status: 'pending', createdAt: new Date().toISOString(), priority: data.reason === 'ofensivo' ? 'high' : 'medium' });
        escreverArquivo('reports.json', reports);
        socket.emit('report_thanks', { message: "Denúncia enviada com sucesso!" });
    });

    socket.on('disconnect', () => {
        adminSessions.delete(socket.id);
        if (activePongGames.has(socket.id)) activePongGames.get(socket.id)?.end('partner_disconnected');
        if (activeTicTacToeGames.has(socket.id)) activeTicTacToeGames.get(socket.id)?.forceEnd();
        const uData = connectedUsers.get(socket.id);
        if (uData?.partnerId) {
            if (activeBots.has(uData.partnerId)) activeBots.delete(uData.partnerId);
            else { const p = io.sockets.sockets.get(uData.partnerId); if(p) p.emit('partner_disconnected'); }
        }
        connectedUsers.delete(socket.id); messageRateLimit.delete(socket.id);
    });

    socket.on('pong_invite', () => { const u = connectedUsers.get(socket.id); if (u?.partnerId && !activeBots.has(u.partnerId)) { const p = io.sockets.sockets.get(u.partnerId); if(p) { p.emit('pong_invite_received'); socket.emit('system_message', { message: "⏳ Convite enviado." }); } } });
    socket.on('pong_accept', () => { const u = connectedUsers.get(socket.id); if (!u?.partnerId || activePongGames.has(socket.id)) return; new PongGame(u.partnerId, socket.id).start(); });
    socket.on('pong_decline', () => { const u = connectedUsers.get(socket.id); if(u?.partnerId) { const p = io.sockets.sockets.get(u.partnerId); if(p) p.emit('system_message', { message: "❌ Desafio recusado." }); } });
    socket.on('pong_move', (d) => { const g = activePongGames.get(socket.id); if(g) g.movePaddle(socket.id, d.paddleX); });
    socket.on('pong_leave', () => { const g = activePongGames.get(socket.id); if(g) g.end('player_left'); });

    socket.on('tictactoe_invite', () => { const u = connectedUsers.get(socket.id); if (u?.partnerId && !activeBots.has(u.partnerId)) { const p = io.sockets.sockets.get(u.partnerId); if(p) { p.emit('tictactoe_invite_received'); socket.emit('system_message', { message: "⏳ Convite enviado." }); } } });
    socket.on('tictactoe_accept', () => { const u = connectedUsers.get(socket.id); if (!u?.partnerId || activeTicTacToeGames.has(socket.id)) return; new TicTacToeGame(u.partnerId, socket.id).start(); });
    socket.on('tictactoe_decline', () => { const u = connectedUsers.get(socket.id); if(u?.partnerId) { const p = io.sockets.sockets.get(u.partnerId); if(p) p.emit('system_message', { message: "❌ Desafio recusado." }); } });
    socket.on('tictactoe_move', (d) => { const g = activeTicTacToeGames.get(socket.id); if(g) g.makeMove(socket.id, d.position); });
    socket.on('tictactoe_leave', () => { const g = activeTicTacToeGames.get(socket.id); if(g) g.forceEnd(); });
});

// ================= CONTADOR ONLINE =================
setInterval(() => {
    const real = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
    let total = fakeOnlineBase + real + (Math.floor(Math.random() * 12) - 4);
    if (total < real) total = real;
    io.emit('users_online', total);
}, 4500);

server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});