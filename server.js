const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

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
    const ADMIN_USERNAME = "eusouVitoriosoathes";
    const ADMIN_PASSWORD = "atheschatthebestintheworld#1";

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
    gamesPlayed: { pong: 0, tictactoe: 0, drawing: 0 }
});

let bans = lerArquivo('bans.json', []);
let reports = lerArquivo('reports.json', []);
let adminLogs = lerArquivo('admin_logs.json', []);

// ================= API ADMIN =================
app.get('/admin/api/stats', verificarTokenAdmin, (req, res) => {
    const hoje = new Date().toISOString().split('T')[0];
    const mensagensHoje = stats.dailyMessages[hoje] || 0;

    res.json({
        onlineNow: Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length,
        activeBots: activeBots.size,
        messagesToday: mensagensHoje,
        pendingReports: reports.filter(r => r.status === 'pending').length,
        activeGames: activePongGames.size + activeTicTacToeGames.size + activeDrawingGames.size,
        totalBanned: bans.length,
        peakUsers: stats.peakUsers || 0
    });
});

app.get('/admin/api/reports', verificarTokenAdmin, (req, res) => {
    res.json(reports);
});

app.post('/admin/api/reports/:id/action', express.json(), verificarTokenAdmin, (req, res) => {
    const { id } = req.params;
    const { action, reason, duration, warningMessage } = req.body;

    const reportIndex = reports.findIndex(r => r.reportId === id);
    if (reportIndex === -1) return res.status(404).json({ error: "Denúncia não encontrada" });

    const report = reports[reportIndex];
    report.status = 'reviewed';
    report.reviewedAt = new Date().toISOString();
    report.actionTaken = action;

    adminLogs.unshift({
        timestamp: new Date().toISOString(),
        mensagem: `Admin: ${action} aplicado ao usuário ${report.reportedUser}`
    });
    if (adminLogs.length > 10) adminLogs.pop();
    escreverArquivo('admin_logs.json', adminLogs);

    if (action === 'ban' || action === 'suspend') {
        const expiresAt = (action === 'suspend' && duration) ? new Date(Date.now() + duration * 86400000) : null;
        bans.push({
            userId: report.reportedUser,
            reason: reason,
            bannedBy: 'admin',
            bannedAt: new Date().toISOString(),
            expiresAt: expiresAt
        });
        escreverArquivo('bans.json', bans);

        const bannedSocket = io.sockets.sockets.get(report.reportedUser);
        if (bannedSocket) {
            bannedSocket.emit('you_are_banned', { reason: reason });
            bannedSocket.disconnect();
        }
    } else if (action === 'warning' && warningMessage) {
        const warnedSocket = io.sockets.sockets.get(report.reportedUser);
        if (warnedSocket) {
            warnedSocket.emit('system_message', { message: `⚠️ AVISO DO ADMIN: ${warningMessage}` });
        }
    }

    escreverArquivo('reports.json', reports);
    res.json({ success: true });
});

app.get('/admin/api/bans', verificarTokenAdmin, (req, res) => {
    res.json(bans);
});

app.post('/admin/api/bans', express.json(), verificarTokenAdmin, (req, res) => {
    const { userId, reason, duration } = req.body;
    const expiresAt = duration === 'permanent' ? null : new Date(Date.now() + duration * 86400000);

    bans.push({
        userId: userId,
        reason: reason,
        bannedBy: 'admin',
        bannedAt: new Date().toISOString(),
        expiresAt: expiresAt
    });
    escreverArquivo('bans.json', bans);

    const bannedSocket = io.sockets.sockets.get(userId);
    if (bannedSocket) {
        bannedSocket.emit('you_are_banned', { reason: reason });
        bannedSocket.disconnect();
    }
    res.json({ success: true });
});

app.delete('/admin/api/bans/:userId', verificarTokenAdmin, (req, res) => {
    const { userId } = req.params;
    const index = bans.findIndex(b => b.userId === userId);
    if (index !== -1) bans.splice(index, 1);
    escreverArquivo('bans.json', bans);
    res.json({ success: true });
});

app.post('/admin/api/broadcast', express.json(), verificarTokenAdmin, (req, res) => {
    const { message, speed, duration } = req.body;
    io.emit('admin_broadcast', { message: message, speed: speed || 20, duration: duration || 10 });
    adminLogs.unshift({ timestamp: new Date().toISOString(), mensagem: `Admin enviou mensagem global: ${message.substring(0, 50)}` });
    if (adminLogs.length > 10) adminLogs.pop();
    escreverArquivo('admin_logs.json', adminLogs);
    res.json({ success: true });
});

app.get('/admin/api/logs', verificarTokenAdmin, (req, res) => {
    res.json(adminLogs.slice(0, 10));
});

app.get('/test', (req, res) => {
    res.json({ status: 'ok', message: 'Servidor funcionando!' });
});

// ================= VARIÁVEIS GLOBAIS =================
const connectedUsers = new Map();
const activeBots = new Map();
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;
const activePongGames = new Map();
const activeTicTacToeGames = new Map();
const activeDrawingGames = new Map();
const adminSessions = new Set();

// ================= BOT =================
const botConversationLogic = {
    greetings: ["Olá!", "E aí, tudo bem?", "Oi, como vai?", "Opa, tudo certo?"],
    farewells: ["Preciso ir agora, até mais!", "Foi bom conversar, tchau!", "Falou, até a próxima!"],
    questions: ["O que você gosta de fazer?", "Qual seu filme favorito?", "Ouve que tipo de música?", "De onde você fala?", "Trabalha com o quê?"],
    keywords: {
        'tudo bem': ["Tudo ótimo por aqui, e com você?", "Tudo certo, e por aí?", "Vou bem, obrigado por perguntar!"],
        'qual seu nome': ["Sou anônimo, assim como você haha", "Prefiro não dizer, vamos manter o mistério.", "Me chame de... Anônimo."],
        'você é um bot': ["Haha, será? 🤔", "O que te faz pensar isso?", "Sou apenas mais um anônimo na rede.", "Talvez... ou talvez não."],
        'tédio': ["Tédio é complicado. Que tal um jogo?", "Vamos falar de algo legal.", "Conta uma piada!"],
        'filme': ["Adoro filmes! Viu algum bom recentemente?", "Gosto de ficção científica. E você?", "Prefiro séries."],
        'música': ["Música é vida! Curto de tudo.", "No momento estou ouvindo pop.", "Qual sua banda preferida?"],
    },
    fallbacks: ["Interessante...", "Hmm, me conte mais.", "Não sei muito sobre isso.", "Entendi.", "Sério?", "Legal."]
};

class Bot {
    constructor(partnerSocket) {
        this.id = "bot_" + Date.now();
        this.partnerId = partnerSocket.id;
        this.partnerSocket = partnerSocket;
        this.location = ["São Paulo", "Rio de Janeiro", "Minas Gerais", "Bahia", "Paraná"][Math.floor(Math.random() * 5)];
        this.messageTimeout = null;
        activeBots.set(this.id, this);
    }
    startConversation() {
        const userData = connectedUsers.get(this.partnerId);
        if (userData) userData.partnerId = this.id;
        this.partnerSocket.emit('chat_start', { partnerId: this.id });
        setTimeout(() => {
            const greeting = botConversationLogic.greetings[Math.floor(Math.random() * botConversationLogic.greetings.length)];
            this.sendMessage(greeting);
        }, 1500);
    }
    handleMessage(text) {
        clearTimeout(this.messageTimeout);
        this.partnerSocket.emit('typing', { isTyping: true });
        this.messageTimeout = setTimeout(() => {
            let response = this.findResponse(text);
            this.sendMessage(response);
        }, 1000 + Math.random() * 1500);
    }
    findResponse(text) {
        const lowerText = text.toLowerCase();
        for (const keyword in botConversationLogic.keywords) {
            if (lowerText.includes(keyword)) {
                const possibleResponses = botConversationLogic.keywords[keyword];
                return possibleResponses[Math.floor(Math.random() * possibleResponses.length)];
            }
        }
        if (Math.random() > 0.6) {
            return botConversationLogic.questions[Math.floor(Math.random() * botConversationLogic.questions.length)];
        }
        return botConversationLogic.fallbacks[Math.floor(Math.random() * botConversationLogic.fallbacks.length)];
    }
    sendMessage(text) {
        this.partnerSocket.emit('typing', { isTyping: false });
        this.partnerSocket.emit('message', { text: text, senderId: this.id, location: this.location });
    }
    disconnect(farewellMessage) {
        if (farewellMessage) this.sendMessage(farewellMessage);
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
const PONG_CONFIG = {
    CANVAS_WIDTH: 300, CANVAS_HEIGHT: 400, PADDLE_WIDTH: 60, PADDLE_HEIGHT: 10,
    BALL_RADIUS: 5, INITIAL_BALL_SPEED_X: 2.5, INITIAL_BALL_SPEED_Y: 2.5,
    MAX_GOALS: 3, GAME_DURATION_MS: 3 * 60 * 1000, UPDATE_INTERVAL: 1000 / 60, COUNTDOWN_SECONDS: 3,
};

class PongGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.ball = {}; this.ball2 = null; this.isSuddenDeath = false; this.gamePaused = true; this.lastLoser = null;
        activePongGames.set(player1Id, this); activePongGames.set(player2Id, this);
        this.gameLoop = null; this.durationTimer = null; this.timeRemaining = PONG_CONFIG.GAME_DURATION_MS;
    }
    broadcast(event, data) { if(this.player1.socket) this.player1.socket.emit(event, data); if(this.player2.socket) this.player2.socket.emit(event, data); }
    start() { this.player1.socket.emit('pong_start', { opponentId: this.player2.id }); this.player2.socket.emit('pong_start', { opponentId: this.player1.id }); this.durationTimer = setInterval(() => this.tick(), 1000); this.startRound(); }
    startRound() { this.gamePaused = true; clearInterval(this.gameLoop); this.broadcastState(); this.broadcast('pong_countdown_start'); setTimeout(() => { this.resetBall(this.ball, this.lastLoser); if (this.isSuddenDeath) { if (!this.ball2) this.ball2 = {}; this.resetBall(this.ball2, this.lastLoser, true); } this.gamePaused = false; this.lastLoser = null; this.gameLoop = setInterval(() => this.update(), PONG_CONFIG.UPDATE_INTERVAL); }, PONG_CONFIG.COUNTDOWN_SECONDS * 1000); }
    tick() { if(this.gamePaused) return; this.timeRemaining -= 1000; this.broadcast('pong_time_update', { time: this.timeRemaining }); if (this.timeRemaining <= 0) this.end('time_up'); }
    resetBall(ball, loserId, isSecondBall = false) { ball.x = PONG_CONFIG.CANVAS_WIDTH / 2; ball.y = PONG_CONFIG.CANVAS_HEIGHT / 2; ball.speedMultiplier = 1.0; ball.rallyCount = 0; ball.vx = (isSecondBall ? -1 : 1) * (Math.random() > 0.5 ? 1 : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_X; let verticalDirection; if (loserId) verticalDirection = (loserId === this.player1.id ? 1 : -1); else verticalDirection = -1; ball.vy = verticalDirection * PONG_CONFIG.INITIAL_BALL_SPEED_Y; }
    update() { if (this.gamePaused) return; this.updateBall(this.ball); if (this.isSuddenDeath && this.ball2) this.updateBall(this.ball2); this.broadcastState(); }
    updateBall(ball) { if (!ball || !ball.x) return; ball.x += ball.vx * ball.speedMultiplier; ball.y += ball.vy * ball.speedMultiplier; if (ball.x - PONG_CONFIG.BALL_RADIUS < 0 || ball.x + PONG_CONFIG.BALL_RADIUS > PONG_CONFIG.CANVAS_WIDTH) ball.vx *= -1; const hitPlayer1 = ball.y + PONG_CONFIG.BALL_RADIUS >= PONG_CONFIG.CANVAS_HEIGHT - PONG_CONFIG.PADDLE_HEIGHT && ball.vy > 0 && ball.x >= this.player1.paddleX && ball.x <= this.player1.paddleX + PONG_CONFIG.PADDLE_WIDTH; const hitPlayer2 = ball.y - PONG_CONFIG.BALL_RADIUS <= PONG_CONFIG.PADDLE_HEIGHT && ball.vy < 0 && ball.x >= this.player2.paddleX && ball.x <= this.player2.paddleX + PONG_CONFIG.PADDLE_WIDTH; if (hitPlayer1 || hitPlayer2) { const playerPaddleX = hitPlayer1 ? this.player1.paddleX : this.player2.paddleX; const intersectX = (playerPaddleX + (PONG_CONFIG.PADDLE_WIDTH / 2)) - ball.x; const normalizedIntersectX = intersectX / (PONG_CONFIG.PADDLE_WIDTH / 2); const maxBounceAngle = (5 * Math.PI) / 12; const bounceAngle = normalizedIntersectX * maxBounceAngle; const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy); ball.vx = currentSpeed * Math.sin(bounceAngle) * -1; ball.vy = currentSpeed * Math.cos(bounceAngle) * (hitPlayer1 ? -1 : 1); ball.rallyCount++; if (ball.rallyCount > 0 && ball.rallyCount % 5 === 0) ball.speedMultiplier = Math.min(2.5, ball.speedMultiplier + 0.15); } if (ball.y > PONG_CONFIG.CANVAS_HEIGHT + PONG_CONFIG.BALL_RADIUS) this.handleGoal(this.player2, this.player1.id); else if (ball.y < -PONG_CONFIG.BALL_RADIUS) this.handleGoal(this.player1, this.player2.id); }
    handleGoal(winner, loserId) { this.lastLoser = loserId; winner.score++; if (this.isSuddenDeath || winner.score >= PONG_CONFIG.MAX_GOALS) this.end('score_limit'); else this.startRound(); }
    movePaddle(playerId, paddleX) { if (this.gamePaused) return; if (playerId === this.player1.id) this.player1.paddleX = paddleX; else if (playerId === this.player2.id) this.player2.paddleX = paddleX; }
    broadcastState() { const stateForP1 = { ball: this.ball, ball2: this.isSuddenDeath ? this.ball2 : null, you: { score: this.player1.score, paddleX: this.player1.paddleX }, opponent: { score: this.player2.score, paddleX: this.player2.paddleX } }; const socketP1 = io.sockets.sockets.get(this.player1.id); if(socketP1) socketP1.emit('pong_update', stateForP1); const flipY = (y) => PONG_CONFIG.CANVAS_HEIGHT - y; const flippedBall = this.ball.x ? { x: this.ball.x, y: flipY(this.ball.y), vx: this.ball.vx, vy: this.ball.vy, speedMultiplier: this.ball.speedMultiplier, rallyCount: this.ball.rallyCount } : this.ball; let flippedBall2 = null; if (this.isSuddenDeath && this.ball2 && this.ball2.x) flippedBall2 = { x: this.ball2.x, y: flipY(this.ball2.y), vx: this.ball2.vx, vy: this.ball2.vy, speedMultiplier: this.ball2.speedMultiplier, rallyCount: this.ball2.rallyCount }; const stateForP2 = { ball: flippedBall, ball2: flippedBall2, you: { score: this.player2.score, paddleX: this.player2.paddleX }, opponent: { score: this.player1.score, paddleX: this.player1.paddleX } }; const socketP2 = io.sockets.sockets.get(this.player2.id); if(socketP2) socketP2.emit('pong_update', stateForP2); }
    end(reason) { clearInterval(this.gameLoop); clearInterval(this.durationTimer); this.gamePaused = true; if (reason === 'time_up' && this.player1.score === this.player2.score && !this.isSuddenDeath) { this.isSuddenDeath = true; this.broadcast('system_message', { message: '🏆 EMPATE! Morte súbita ativada!' }); this.startRound(); return; } const resultForP1 = { reason: reason, yourScore: this.player1.score, opponentScore: this.player2.score }; const resultForP2 = { reason: reason, yourScore: this.player2.score, opponentScore: this.player1.score }; const socketP1 = io.sockets.sockets.get(this.player1.id); if(socketP1) socketP1.emit('pong_end', resultForP1); const socketP2 = io.sockets.sockets.get(this.player2.id); if(socketP2) socketP2.emit('pong_end', resultForP2); activePongGames.delete(this.player1.id); activePongGames.delete(this.player2.id); }
}

// ================= JOGO DA VELHA =================
const TICTACTOE_CONFIG = { BOARD_SIZE: 9, WIN_PATTERNS: [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]] };

class TicTacToeGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), symbol: null };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), symbol: null };
        const randomStart = Math.random() < 0.5;
        if (randomStart) { this.player1.symbol = 'X'; this.player2.symbol = 'O'; this.currentTurn = player1Id; this.firstPlayer = player1Id; }
        else { this.player1.symbol = 'O'; this.player2.symbol = 'X'; this.currentTurn = player2Id; this.firstPlayer = player2Id; }
        this.board = Array(TICTACTOE_CONFIG.BOARD_SIZE).fill(null); this.gameActive = true; this.winner = null; this.isDraw = false;
        activeTicTacToeGames.set(player1Id, this); activeTicTacToeGames.set(player2Id, this);
    }
    broadcast(event, data) { if(this.player1.socket) this.player1.socket.emit(event, data); if(this.player2.socket) this.player2.socket.emit(event, data); }
    start() { this.player1.socket.emit('tictactoe_start', { opponentId: this.player2.id, yourSymbol: this.player1.symbol, firstTurn: this.currentTurn === this.player1.id, starter: this.firstPlayer === this.player1.id ? 'Você' : 'Oponente' }); this.player2.socket.emit('tictactoe_start', { opponentId: this.player1.id, yourSymbol: this.player2.symbol, firstTurn: this.currentTurn === this.player2.id, starter: this.firstPlayer === this.player2.id ? 'Você' : 'Oponente' }); this.broadcastState(); }
    makeMove(playerId, position) { if (!this.gameActive) return { success: false, reason: 'Jogo já terminou' }; if (playerId !== this.currentTurn) return { success: false, reason: 'Não é sua vez' }; if (position < 0 || position >= TICTACTOE_CONFIG.BOARD_SIZE) return { success: false, reason: 'Posição inválida' }; if (this.board[position] !== null) return { success: false, reason: 'Posição já ocupada' }; const symbol = playerId === this.player1.id ? this.player1.symbol : this.player2.symbol; this.board[position] = symbol; const winPattern = this.checkWin(symbol); if (winPattern) { this.gameActive = false; this.winner = playerId; this.broadcast('tictactoe_game_over', { winner: playerId, winnerSymbol: symbol, winPattern: winPattern, isDraw: false }); this.end('win'); return { success: true, move: position, gameOver: true, winner: symbol }; } const isDraw = this.board.every(cell => cell !== null); if (isDraw) { this.gameActive = false; this.isDraw = true; this.broadcast('tictactoe_game_over', { winner: null, winnerSymbol: null, winPattern: null, isDraw: true }); this.end('draw'); return { success: true, move: position, gameOver: true, isDraw: true }; } this.currentTurn = (this.currentTurn === this.player1.id) ? this.player2.id : this.player1.id; this.broadcastState(); return { success: true, move: position, gameOver: false }; }
    checkWin(symbol) { for (const pattern of TICTACTOE_CONFIG.WIN_PATTERNS) { const [a,b,c] = pattern; if (this.board[a] === symbol && this.board[b] === symbol && this.board[c] === symbol) return pattern; } return null; }
    broadcastState() { const state = { board: this.board, currentTurn: this.currentTurn, gameActive: this.gameActive, winner: this.winner, isDraw: this.isDraw, player1Symbol: this.player1.symbol, player2Symbol: this.player2.symbol, currentTurnSymbol: this.currentTurn === this.player1.id ? this.player1.symbol : this.player2.symbol }; this.broadcast('tictactoe_update', state); }
    end(reason) { activeTicTacToeGames.delete(this.player1.id); activeTicTacToeGames.delete(this.player2.id); setTimeout(() => { if (this.player1.socket) this.player1.socket.emit('tictactoe_close'); if (this.player2.socket) this.player2.socket.emit('tictactoe_close'); }, 3000); }
    forceEnd(playerLeftId) { this.broadcast('system_message', { message: "🚪 Oponente saiu do jogo. Partida encerrada." }); this.end('player_left'); }
}

// ================= JOGO DE DESENHO =================
const DRAWING_WORDS = ["cachorro","gato","elefante","girafa","leao","tigre","macaco","pinguim","golfinho","cavalo","cadeira","mesa","celular","computador","televisao","geladeira","fogao","sofá","cama","abajur","sol","lua","estrela","chuva","floresta","montanha","rio","mar","arvore","flor","pizza","hamburguer","sorvete","bolo","macarrao","arroz","feijao","salada","fruta","chocolate","medico","professor","bombeiro","policial","engenheiro","advogado","cozinheiro","motorista","cantor","dentista","futebol","basquete","tenis","natacao","volei","corrida","boxe","skate","surf","ginastica","carro","moto","bicicleta","aviao","helicoptero","navio","caminhao","onibus","trator","submarino"];

class DrawingGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), ready: false };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), ready: false };
        const randomDrawer = Math.random() < 0.5;
        if (randomDrawer) { this.drawerId = player1Id; this.guesserId = player2Id; }
        else { this.drawerId = player2Id; this.guesserId = player1Id; }
        const randomIndex = Math.floor(Math.random() * DRAWING_WORDS.length);
        this.currentWord = DRAWING_WORDS[randomIndex];
        this.gameActive = false; this.timeLeft = 60; this.timerInterval = null; this.winner = null; this.guessHistory = [];
        activeDrawingGames.set(player1Id, this); activeDrawingGames.set(player2Id, this);
    }
    broadcast(event, data) { if(this.player1.socket) this.player1.socket.emit(event, data); if(this.player2.socket) this.player2.socket.emit(event, data); }
    sendToPlayer(playerId, event, data) { const socket = io.sockets.sockets.get(playerId); if(socket) socket.emit(event, data); }
    setReady(playerId) { if (playerId === this.player1.id) this.player1.ready = true; else if (playerId === this.player2.id) this.player2.ready = true; if (this.player1.ready && this.player2.ready && !this.gameActive) this.startGame(); }
    startGame() { this.gameActive = true; this.timeLeft = 60; this.sendToPlayer(this.drawerId, 'drawing_start', { role: 'drawer', word: this.currentWord, timeLimit: this.timeLeft }); this.sendToPlayer(this.guesserId, 'drawing_start', { role: 'guesser', wordLength: this.currentWord.length, timeLimit: this.timeLeft }); this.timerInterval = setInterval(() => { if (!this.gameActive) return; this.timeLeft--; this.broadcast('drawing_timer', { timeLeft: this.timeLeft }); if (this.timeLeft <= 0) { clearInterval(this.timerInterval); this.endGame('timeout', 'Tempo esgotado!', null); } }, 1000); }
    makeDraw(playerId, drawingData) { if (!this.gameActive) return; if (playerId !== this.drawerId) return; this.sendToPlayer(this.guesserId, 'drawing_update', drawingData); }
    makeGuess(playerId, guess) { if (!this.gameActive) return; if (playerId !== this.guesserId) return; const normalizedGuess = guess.toLowerCase().trim(); const normalizedWord = this.currentWord.toLowerCase(); const guessEntry = { guess: guess, isCorrect: normalizedGuess === normalizedWord, timestamp: Date.now() }; this.guessHistory.push(guessEntry); this.broadcast('drawing_chat_update', { history: this.guessHistory }); if (normalizedGuess === normalizedWord) this.endGame('correct_guess', 'Acertou a palavra!', this.guesserId); else this.sendToPlayer(this.guesserId, 'drawing_wrong_guess', { guess: guess }); }
    endGame(reason, message, winnerId) { if (!this.gameActive) return; this.gameActive = false; if (this.timerInterval) clearInterval(this.timerInterval); this.winner = winnerId; let winnerRole = "Ninguém"; if (winnerId === this.drawerId) winnerRole = "Desenhista"; else if (winnerId === this.guesserId) winnerRole = "Adivinhador"; this.broadcast('drawing_game_over', { winnerId: winnerId, winnerRole: winnerRole, word: this.currentWord, reason: reason, message: message, history: this.guessHistory }); setTimeout(() => this.cleanup(), 5000); }
    cleanup() { activeDrawingGames.delete(this.player1.id); activeDrawingGames.delete(this.player2.id); }
    forceEnd(playerLeftId) { if (!this.gameActive) return; const leftPlayer = playerLeftId === this.drawerId ? 'Desenhista' : 'Adivinhador'; const winnerId = playerLeftId === this.drawerId ? this.guesserId : this.drawerId; this.endGame('player_left', leftPlayer + " saiu do jogo", winnerId); }
}

// ================= CONEXÃO SOCKET.IO =================
io.on('connection', (socket) => {
    console.log("Novo usuário conectado: " + socket.id);
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido', isAdmin: false });

    socket.on('admin_register', (token) => {
        adminSessions.add(socket.id);
        const userData = connectedUsers.get(socket.id);
        if (userData) userData.isAdmin = true;
        socket.emit('admin_registered');
        console.log(`Admin registrado: ${socket.id}`);
    });

    socket.on('join', (data) => {
        if (adminSessions.has(socket.id)) {
            socket.emit('system_message', { message: "Você está logado como admin. Saia do painel para conversar." });
            return;
        }
        const userData = connectedUsers.get(socket.id);
        if (!userData) return;
        if (data?.location) userData.location = data.location;
        if (userData.partnerId) return;

        let realPartner = null;
        for (const [uid, ud] of connectedUsers) {
            if (uid !== socket.id && !ud.partnerId && !adminSessions.has(uid)) {
                realPartner = io.sockets.sockets.get(uid);
                break;
            }
        }
        if (realPartner) {
            pairRealUsers(socket, realPartner);
        } else {
            socket.emit('waiting');
            setTimeout(() => {
                if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId && !adminSessions.has(socket.id)) {
                    const bot = new Bot(socket);
                    bot.startConversation();
                }
            }, 3000);
        }
    });

    socket.on('message', (data) => {
        if (adminSessions.has(socket.id)) return;
        const senderData = connectedUsers.get(socket.id);
        if (!senderData?.partnerId) return;
        const partnerId = senderData.partnerId;
        if (activeBots.has(partnerId)) {
            activeBots.get(partnerId).handleMessage(data.text);
        } else {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                partnerSocket.emit('message', { text: data.text, senderId: socket.id, replyTo: data.replyTo || null, location: senderData.location });
                io.emit('chat_message', { senderId: socket.id, text: data.text });
            }
        }
        const hoje = new Date().toISOString().split('T')[0];
        stats.dailyMessages[hoje] = (stats.dailyMessages[hoje] || 0) + 1;
        stats.totalMessages = (stats.totalMessages || 0) + 1;
        const onlineNow = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
        if (onlineNow > (stats.peakUsers || 0)) stats.peakUsers = onlineNow;
        escreverArquivo('stats.json', stats);
    });

    socket.on('typing', (data) => {
        if (adminSessions.has(socket.id)) return;
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId && !activeBots.has(partnerId)) {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) partnerSocket.emit('typing', { isTyping: data.isTyping });
        }
    });

    socket.on('end_chat', () => { if (!adminSessions.has(socket.id)) endUserChat(socket.id); });

    socket.on('report_user', (data) => {
        const newReport = {
            reportId: Date.now().toString(),
            reporterId: socket.id,
            reportedUser: data.reportedUserId,
            reportedMessage: data.reportedMessage || "Mensagem não especificada",
            reason: data.reason,
            status: 'pending',
            createdAt: new Date().toISOString(),
            priority: data.reason === 'ofensivo' ? 'high' : 'medium'
        };
        reports.unshift(newReport);
        escreverArquivo('reports.json', reports);
        socket.emit('report_thanks', { message: "Denúncia enviada com sucesso! Obrigado por ajudar a comunidade." });
    });

    socket.on('disconnect', () => {
        if (adminSessions.has(socket.id)) adminSessions.delete(socket.id);
        if (activePongGames.has(socket.id)) activePongGames.get(socket.id)?.end('partner_disconnected');
        if (activeTicTacToeGames.has(socket.id)) activeTicTacToeGames.get(socket.id)?.forceEnd(socket.id);
        if (activeDrawingGames.has(socket.id)) activeDrawingGames.get(socket.id)?.forceEnd(socket.id);
        const userData = connectedUsers.get(socket.id);
        if (userData?.partnerId) {
            if (activeBots.has(userData.partnerId)) activeBots.delete(userData.partnerId);
            else {
                const partnerSocket = io.sockets.sockets.get(userData.partnerId);
                if (partnerSocket) partnerSocket.emit('partner_disconnected');
            }
        }
        connectedUsers.delete(socket.id);
    });

    // Eventos dos jogos
    socket.on('pong_invite', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData?.partnerId || activeBots.has(userData.partnerId)) {
            socket.emit('system_message', { message: "⚠️ Você só pode jogar com um parceiro real." });
            return;
        }
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) { partnerSocket.emit('pong_invite_received'); socket.emit('system_message', { message: "⏳ Convite enviado." }); }
    });
    socket.on('pong_decline', () => { const userData = connectedUsers.get(socket.id); if (userData?.partnerId) io.sockets.sockets.get(userData.partnerId)?.emit('system_message', { message: "❌ Seu parceiro recusou o desafio." }); });
    socket.on('pong_accept', () => { const userData = connectedUsers.get(socket.id); if (!userData?.partnerId) return; if (activePongGames.has(socket.id) || activePongGames.has(userData.partnerId)) return; const newGame = new PongGame(userData.partnerId, socket.id); newGame.start(); });
    socket.on('pong_move', (data) => { const game = activePongGames.get(socket.id); if (game) game.movePaddle(socket.id, data.paddleX); });
    socket.on('pong_leave', () => { const game = activePongGames.get(socket.id); if (game) game.end('player_left'); });

    socket.on('tictactoe_invite', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData?.partnerId || activeBots.has(userData.partnerId)) {
            socket.emit('system_message', { message: "⚠️ Você só pode jogar com um parceiro real." });
            return;
        }
        if (activeTicTacToeGames.has(socket.id)) {
            socket.emit('system_message', { message: "⚠️ Você já está em uma partida." });
            return;
        }
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) {
            if (activeTicTacToeGames.has(userData.partnerId)) {
                socket.emit('system_message', { message: "⚠️ Seu parceiro já está em uma partida." });
                return;
            }
            partnerSocket.emit('tictactoe_invite_received');
            socket.emit('system_message', { message: "⏳ Convite enviado." });
        }
    });
    socket.on('tictactoe_decline', () => { const userData = connectedUsers.get(socket.id); if (userData?.partnerId) io.sockets.sockets.get(userData.partnerId)?.emit('system_message', { message: "❌ Seu parceiro recusou o desafio." }); });
    socket.on('tictactoe_accept', () => { const userData = connectedUsers.get(socket.id); if (!userData?.partnerId) return; if (activeTicTacToeGames.has(socket.id) || activeTicTacToeGames.has(userData.partnerId)) return; const newGame = new TicTacToeGame(userData.partnerId, socket.id); newGame.start(); });
    socket.on('tictactoe_move', (data) => { const game = activeTicTacToeGames.get(socket.id); if (game) game.makeMove(socket.id, data.position); });
    socket.on('tictactoe_leave', () => { const game = activeTicTacToeGames.get(socket.id); if (game) game.forceEnd(socket.id); });

    socket.on('drawing_invite', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData?.partnerId || activeBots.has(userData.partnerId)) {
            socket.emit('system_message', { message: "⚠️ Você só pode jogar com um parceiro real." });
            return;
        }
        if (activeDrawingGames.has(socket.id)) {
            socket.emit('system_message', { message: "⚠️ Você já está em uma partida." });
            return;
        }
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) {
            if (activeDrawingGames.has(userData.partnerId)) {
                socket.emit('system_message', { message: "⚠️ Seu parceiro já está em uma partida." });
                return;
            }
            partnerSocket.emit('drawing_invite_received');
            socket.emit('system_message', { message: "⏳ Convite enviado." });
        }
    });
    socket.on('drawing_decline', () => { const userData = connectedUsers.get(socket.id); if (userData?.partnerId) io.sockets.sockets.get(userData.partnerId)?.emit('system_message', { message: "❌ Seu parceiro recusou o desafio." }); });
    socket.on('drawing_accept', () => { const userData = connectedUsers.get(socket.id); if (!userData?.partnerId) return; if (activeDrawingGames.has(socket.id) || activeDrawingGames.has(userData.partnerId)) return; const newGame = new DrawingGame(userData.partnerId, socket.id); socket.emit('drawing_tutorial_required'); io.sockets.sockets.get(userData.partnerId)?.emit('drawing_tutorial_required'); });
    socket.on('drawing_tutorial_ready', () => { const game = activeDrawingGames.get(socket.id); if (game) game.setReady(socket.id); });
    socket.on('drawing_make_draw', (data) => { const game = activeDrawingGames.get(socket.id); if (game) game.makeDraw(socket.id, data); });
    socket.on('drawing_make_guess', (data) => { const game = activeDrawingGames.get(socket.id); if (game) game.makeGuess(socket.id, data.guess); });
    socket.on('drawing_leave', () => { const game = activeDrawingGames.get(socket.id); if (game) game.forceEnd(socket.id); });

    function pairRealUsers(s1, s2) {
        const u1 = connectedUsers.get(s1.id), u2 = connectedUsers.get(s2.id);
        if (u1) u1.partnerId = s2.id;
        if (u2) u2.partnerId = s1.id;
        s1.emit('chat_start', { partnerId: s2.id });
        s2.emit('chat_start', { partnerId: s1.id });
    }

    function endUserChat(socketId) {
        const userData = connectedUsers.get(socketId);
        if (!userData?.partnerId) return;
        const partnerId = userData.partnerId;
        if (activePongGames.has(socketId)) activePongGames.get(socketId)?.end('chat_ended');
        if (activeTicTacToeGames.has(socketId)) activeTicTacToeGames.get(socketId)?.forceEnd(socketId);
        if (activeDrawingGames.has(socketId)) activeDrawingGames.get(socketId)?.forceEnd(socketId);
        userData.partnerId = null;
        if (activeBots.has(partnerId)) activeBots.get(partnerId)?.disconnect();
        else {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) { partnerSocket.emit('chat_ended'); const pd = connectedUsers.get(partnerId); if(pd) pd.partnerId = null; }
        }
        io.sockets.sockets.get(socketId)?.emit('chat_ended');
    }
});

// ================= CONTADOR ONLINE =================
function broadcastOnlineCount() {
    const realUsers = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
    const fake = fakeOnlineBase + realUsers;
    const fluctuation = Math.floor(Math.random() * 12) - 4;
    let total = fake + fluctuation;
    if (total < realUsers) total = realUsers;
    io.emit('users_online', total);
}
setInterval(broadcastOnlineCount, 4500);

// ================= INICIALIZAÇÃO =================
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📱 Chat: http://localhost:${PORT}`);
    console.log(`🔐 Admin: http://localhost:${PORT}/admin`);
    console.log(`👤 Login: eusouVitoriosoathes`);
    console.log(`🔑 Senha: atheschatthebestintheworld#1`);
});