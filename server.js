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
    maxHttpBufferSize: 1e5
});

app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= CONFIGURAÇÃO DE SEGURANÇA =================
const ADMIN_USERNAME = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || (() => {
    const p = crypto.randomBytes(12).toString('base64url');
    console.log(`⚠️  ADMIN_PASS não definido. Senha temporária: ${p}`);
    return p;
})();
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.log('⚠️  JWT_SECRET não definido. Tokens invalidam ao reiniciar.');

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
    const safeEqual = (a, b) => {
        const ba = Buffer.from(String(a));
        const bb = Buffer.from(String(b));
        if (ba.length !== bb.length) return false;
        return crypto.timingSafeEqual(ba, bb);
    };
    if (typeof username === 'string' && typeof password === 'string' &&
        safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASS)) {
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

// ================= SISTEMA DE ARQUIVOS JSON =================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function lerArquivo(nome, padrao = {}) {
    try {
        const p = path.join(dataDir, nome);
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : padrao;
    } catch (e) {
        return padrao;
    }
}

function escreverArquivo(nome, dados) {
    try {
        const p = path.join(dataDir, nome);
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), 'utf8');
        fs.renameSync(tmp, p);
    } catch (e) {
        console.error('Erro ao escrever', nome, e);
    }
}

// ================= ESTATÍSTICAS =================
let stats = lerArquivo('stats.json', {
    totalMessages: 0,
    dailyMessages: {},
    peakUsers: 0,
    gamesPlayed: { pong: 0, tictactoe: 0 }
});
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
let adminLogs = lerArquivo('admin_logs.json', []);

// ================= CONFIGURAÇÕES DO SITE (JOGOS E ANÚNCIOS) =================
const defaultGamesConfig = {
    pong: { active: false, message: "Em breve", daysRemaining: null },
    tictactoe: { active: false, message: "Em breve", daysRemaining: null }
};

const defaultAdsConfig = {
    adsEnabled: false,
    adsenseCode: "",
    adsPerVip: 15,
    vipDurationHours: 24,
    vipDefaultColor: "#ffd700"
};

let gamesConfig = lerArquivo('games_config.json', defaultGamesConfig);
let adsConfig = lerArquivo('ads_config.json', defaultAdsConfig);

gamesConfig = { ...defaultGamesConfig, ...gamesConfig };
adsConfig = { ...defaultAdsConfig, ...adsConfig };

function calcularVoltaEm(daysRemaining) {
    if (!daysRemaining || daysRemaining <= 0) return null;
    const ms = Number(daysRemaining) * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms).toISOString();
}

// ================= PALAVRAS PROIBIDAS =================
let palavrasProibidas = [];
try {
    const p = path.join(__dirname, 'public', 'palavras_proibidas.json');
    if (fs.existsSync(p)) palavrasProibidas = JSON.parse(fs.readFileSync(p, 'utf8'));
} catch (e) {
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
        const regex = new RegExp(`(?:^|[^a-zà-ú])${escaped}(?:$|[^a-zà-ú])`, 'i');
        return regex.test(t);
    });
}

function registrarLog(mensagem) {
    adminLogs.unshift({ timestamp: new Date().toISOString(), mensagem });
    if (adminLogs.length > 200) adminLogs = adminLogs.slice(0, 200);
    escreverArquivo('admin_logs.json', adminLogs);
}

// ================= ESTADO GLOBAL DO SERVIDOR =================
const connectedUsers = new Map();
const activeBots = new Map();
const activePongGames = new Map();
const activeTttGames = new Map();
const adminSessions = new Set();
const messageRateLimit = new Map();
const RATE_WINDOW = 10000;
const RATE_MAX = 25;
const RATE_BLOCK = 5000;
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;

const waitingQueue = [];
const queueTimers = new Map();

// ================= INTELIGÊNCIA DO BOT (EMBUTIDA) =================
const respostasBot = {
    saudacao: ["Oi, tudo bem? Como você tá?", "E aí, beleza? De onde você fala?", "Opa, oi! Tudo certo?", "Olá! Tudo bem por aí? Como tá o dia?"],
    despedidas: ["Fui! Até mais.", "Tchau, foi bom falar com você.", "Flw! Tenha um bom dia.", "Até mais, cuide-se."],
    tchau_seco: ["Fui.", "Já vou nessa.", "Até mais.", "Tchau."],
    nome: ["Pode me chamar de Anônimo haha. E você, como se chama?", "Meu nome? A graça do anonimato é não ter nome. Mas e o seu?", "Sou só mais um anônimo por aqui. Qual é o seu nome?"],
    idade: ["A idade é só um número, mas tô na faixa dos {idade} haha. E você?", "Tenho {idade} anos. E você, quantos anos tem?", "Adivinha? Tô com {idade}. Qual a sua idade?"],
    triste: ["Poxa, sinto muito que esteja assim. Quer falar sobre o que aconteceu?", "Dias ruins acontecem. Mas as vezes desabafar ajuda. O que houve?", "Fica assim não... quer conversar sobre isso?"],
    feliz: ["Que bom! Fico feliz em saber. O que aconteceu de bom?", "Isso aí! Contagia até o chat. Me conta a novidade!", "Adoro ver gente animada. Que bom que seu dia tá bom!"],
    hobbies: ["Curto muito música e tecnologia. E você, o que gosta de fazer?", "Sou fã de filmes e séries. Qual você assistiu recentemente?", "Gosto de conversar e conhecer gente nova. Quais são seus hobbies?"],
    fallback: ["Interessante... me conta mais sobre isso.", "Hmm, nunca tinha pensado por esse lado. Como assim?", "Sério? E o que você acha disso?", "Entendi. E o que te fez pensar nisso hoje?"],
    perguntas: ["E você, o que acha?", "Me conta mais, tô curioso.", "Sério? Como foi isso?", "E aí, o que mais aconteceu?"]
};

const intencoesBot = [
    { tags: ['oi', 'ola', 'eae', 'opa', 'tudo bem', 'bom dia', 'boa tarde', 'boa noite'], handler: 'saudacao' },
    { tags: ['tchau', 'ate mais', 'falou', 'fui', 'vou sair', 'tenho que ir'], handler: 'despedida' },
    { tags: ['qual seu nome', 'seu nome', 'como se chama', 'quem é você', 'quem e voce'], handler: 'nome' },
    { tags: ['sua idade', 'quantos anos', 'velho', 'nova'], handler: 'idade' },
    { tags: ['triste', 'mal', 'ruim', 'depressao', 'chorar', 'sozinho', 'cansado'], handler: 'triste' },
    { tags: ['feliz', 'alegre', 'otimo', 'bom', 'conquista', 'ganhei'], handler: 'feliz' },
    { tags: ['gosta de', 'hobby', 'curte', 'faz o que', 'filme', 'serie', 'musica', 'jogo'], handler: 'hobbies' }
];

function gerarRespostaBot(texto, memoria) {
    const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/gi, '');
    memoria.interacoes++;
    
    let intencao = null;
    for (let i of intencoesBot) {
        if (i.tags.some(tag => t.includes(tag))) {
            intencao = i.handler;
            break;
        }
    }

    if (intencao === 'saudacao' && memoria.interacoes > 2) return "Oi de novo! Tudo bem?";
    if (intencao === 'triste') return respostasBot.triste[Math.floor(Math.random() * respostasBot.triste.length)];
    if (intencao === 'feliz') return respostasBot.feliz[Math.floor(Math.random() * respostasBot.feliz.length)];
    if (intencao === 'nome') return respostasBot.nome[Math.floor(Math.random() * respostasBot.nome.length)];
    if (intencao === 'idade') {
        const idade = Math.floor(Math.random() * 17) + 18;
        return respostasBot.idade[Math.floor(Math.random() * respostasBot.idade.length)].replace('{idade}', idade);
    }
    if (intencao === 'hobbies') return respostasBot.hobbies[Math.floor(Math.random() * respostasBot.hobbies.length)];
    if (intencao === 'despedida') return respostasBot.despedidas[Math.floor(Math.random() * respostasBot.despedidas.length)];

    const matchNome = t.match(/(?:meu nome e|sou o|sou a|pode me chamar de)\s+([a-z]+)/i);
    if (matchNome && matchNome[1] && matchNome[1].length > 2) {
        memoria.nome = matchNome[1].charAt(0).toUpperCase() + matchNome[1].slice(1);
        return "Prazer, " + memoria.nome + "! Legal te conhecer. De onde você fala?";
    }
    
    if (memoria.interacoes === 1) return respostasBot.saudacao[Math.floor(Math.random() * respostasBot.saudacao.length)];
    
    return respostasBot.fallback[Math.floor(Math.random() * respostasBot.fallback.length)] + " " + respostasBot.perguntas[Math.floor(Math.random() * respostasBot.perguntas.length)];
}

// ================= CLASSE BOT (EMBUTIDA) =================
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
        this.typingTimeout = null;
        this.memoria = { nome: null, interacoes: 0 };
    }

    start() {
        const userData = connectedUsers.get(this.userId);
        if (!userData) return;
        userData.partnerId = this.id;
        this.socket.emit('chat_start', { partnerId: this.id });
        this.enviarComDigitacao("Oi! Tudo bem? De onde você fala?");
        
        if (Math.random() < 0.3 && gamesConfig.pong.active) {
            this.playInviteTimeout = setTimeout(() => {
                if (!this.inGame && activeBots.has(this.id)) {
                    this.enviarComDigitacao("Tô meio entediado aqui... quer jogar um Pong?");
                    this.socket.emit('bot_pong_invite');
                }
            }, 25000 + Math.random() * 30000);
        }
    }

    receberMensagem(text) {
        if (!activeBots.has(this.id)) return;
        this.socket.emit('typing', { isTyping: true });
        
        setTimeout(() => {
            if (!activeBots.has(this.id)) return;
            let resp = gerarRespostaBot(text, this.memoria);
            
            if (resp.includes("jogar") && gamesConfig.pong.active) {
                setTimeout(() => this.socket.emit('bot_pong_invite'), 1500);
            }
            
            this.enviarComDigitacao(resp);
        }, 600 + Math.random() * 800);
    }

    enviarComDigitacao(texto) {
        this.socket.emit('typing', { isTyping: true });
        const tempo = (texto.length * 50) + (Math.random() * 300);
        
        this.typingTimeout = setTimeout(() => {
            if (!activeBots.has(this.id)) return;
            this.socket.emit('typing', { isTyping: false });
            this.socket.emit('message', { text: texto, senderId: this.id, location: this.location });
        }, tempo);
    }

    desconectarPorqueChegouHumano() {
        const msg = respostasBot.tchau_seco[Math.floor(Math.random() * respostasBot.tchau_seco.length)];
        this.socket.emit('typing', { isTyping: true });
        
        setTimeout(() => {
            this.socket.emit('typing', { isTyping: false });
            this.socket.emit('message', { text: msg, senderId: this.id, location: this.location });
            
            setTimeout(() => {
                const u = connectedUsers.get(this.userId);
                if (u && u.partnerId === this.id) {
                    u.partnerId = null;
                    this.socket.emit('chat_ended');
                }
                activeBots.delete(this.id);
            }, 1000);
        }, 600);
    }

    disconnect() {
        clearTimeout(this.playInviteTimeout);
        clearTimeout(this.typingTimeout);
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
        if (ballY < 200 && Math.random() > 0.2) {
            this.targetX = ballX - 30 + (Math.random() * 40 - 20);
        }
        let diff = this.targetX - this.paddleX;
        let speed = 4;
        if (Math.abs(diff) > speed) this.paddleX += Math.sign(diff) * speed;
        else this.paddleX = this.targetX;
        this.paddleX = Math.max(0, Math.min(240, this.paddleX));
    }
}

// ================= API DO PAINEL ADMIN =================
app.get('/admin/api/stats', verificarToken, (req, res) => {
    const hoje = new Date().toISOString().split('T')[0];
    res.json({
        onlineNow: Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length,
        activeBots: activeBots.size,
        messagesToday: stats.dailyMessages[hoje] || 0,
        pendingReports: reports.filter(r => r.status === 'pending').length,
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
        for (const [sid, ud] of connectedUsers) {
            if (ud.ip === report.reportedIP) {
                const s = io.sockets.sockets.get(sid);
                if (s) s.emit('admin_warning', { message: warningMessage || 'Aviso.' });
            }
        }
        registrarLog(`Aviso para IP ${report.reportedIP}`);
    } else if (action === 'ban' || action === 'suspend') {
        report.status = 'reviewed';
        report.actionTaken = action;
        const expiresAt = (action === 'suspend' && duration) ? new Date(Date.now() + duration * 86400000).toISOString() : null;
        if (!bans.some(b => b.userIP === report.reportedIP)) {
            bans.push({ userIP: report.reportedIP, reason: reason || 'Violação', bannedAt: new Date().toISOString(), expiresAt });
            escreverArquivo('bans.json', bans);
        }
        for (const [sid, ud] of connectedUsers) {
            if (ud.ip === report.reportedIP) {
                const s = io.sockets.sockets.get(sid);
                if (s) { s.emit('you_are_banned', { reason, until: expiresAt }); s.disconnect(true); }
            }
        }
        registrarLog(`${action} de IP ${report.reportedIP}`);
    } else {
        return res.status(400).json({ error: "Ação inválida" });
    }
    escreverArquivo('reports.json', reports);
    res.json({ success: true });
});

app.get('/admin/api/bans', verificarToken, (req, res) => res.json(bans));

app.delete('/admin/api/bans/:ip', verificarToken, (req, res) => {
    const ip = decodeURIComponent(req.params.ip);
    bans = bans.filter(b => b.userIP !== ip);
    escreverArquivo('bans.json', bans);
    registrarLog(`IP ${ip} desbanido`);
    res.json({ success: true });
});

app.post('/admin/api/bans', express.json(), verificarToken, (req, res) => {
    const { userIP, reason, duration } = req.body || {};
    if (!userIP || !reason) return res.status(400).json({ error: "IP e motivo obrigatórios" });
    if (!bans.some(b => b.userIP === userIP)) {
        const expiresAt = duration && duration !== 'permanent' ? new Date(Date.now() + parseInt(duration) * 86400000).toISOString() : null;
        bans.push({ userIP, reason, bannedAt: new Date().toISOString(), expiresAt });
        escreverArquivo('bans.json', bans);
        registrarLog(`Ban manual ${userIP}`);
    }
    res.json({ success: true });
});

app.post('/admin/api/broadcast', express.json(), verificarToken, (req, res) => {
    io.emit('admin_broadcast', req.body);
    registrarLog(`Broadcast: "${req.body.message.slice(0, 30)}"`);
    res.json({ success: true });
});

app.get('/admin/api/logs', verificarToken, (req, res) => res.json(adminLogs.slice(0, 10)));

app.get('/admin/api/games-config', verificarToken, (req, res) => res.json(gamesConfig));

app.post('/admin/api/games-config', express.json(), verificarToken, (req, res) => {
    const { pong, tictactoe } = req.body || {};
    if (pong) gamesConfig.pong = { active: !!pong.active, message: String(pong.message).slice(0, 200), daysRemaining: pong.daysRemaining === '' ? null : Number(pong.daysRemaining) };
    if (tictactoe) gamesConfig.tictactoe = { active: !!tictactoe.active, message: String(tictactoe.message).slice(0, 200), daysRemaining: tictactoe.daysRemaining === '' ? null : Number(tictactoe.daysRemaining) };
    escreverArquivo('games_config.json', gamesConfig);
    io.emit('games_config_update', {
        pong: { ...gamesConfig.pong, returnAt: calcularVoltaEm(gamesConfig.pong.daysRemaining) },
        tictactoe: { ...gamesConfig.tictactoe, returnAt: calcularVoltaEm(gamesConfig.tictactoe.daysRemaining) }
    });
    registrarLog(`Jogos atualizados`);
    res.json({ success: true, gamesConfig });
});

app.get('/admin/api/ads-config', verificarToken, (req, res) => res.json(adsConfig));

app.post('/admin/api/ads-config', express.json(), verificarToken, (req, res) => {
    const { adsEnabled, adsenseCode, adsPerVip, vipDurationHours, vipDefaultColor } = req.body || {};
    if (typeof adsEnabled !== 'undefined') adsConfig.adsEnabled = !!adsEnabled;
    if (typeof adsenseCode === 'string') adsConfig.adsenseCode = adsenseCode.slice(0, 5000);
    if (adsPerVip) adsConfig.adsPerVip = Math.max(1, Math.min(100, Number(adsPerVip)));
    if (vipDurationHours) adsConfig.vipDurationHours = Math.max(1, Math.min(720, Number(vipDurationHours)));
    if (vipDefaultColor) adsConfig.vipDefaultColor = vipDefaultColor;
    escreverArquivo('ads_config.json', adsConfig);
    io.emit('ads_config_update', adsConfig);
    registrarLog(`Ads atualizados`);
    res.json({ success: true, adsConfig });
});

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
            if (!activePongGames.has(this.p1.id) && !activePongGames.has(this.p2.id)) return;
            this.ball = { x: 150, y: 200, vx: (Math.random() > 0.5 ? 1 : -1) * PONG.SX, vy: (this.loser === this.p1.id ? 1 : -1) * PONG.SY, mult: 1, rally: 0 };
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
            this.p1.socket.emit('pong_update', { ball: this.ball, you: { score: this.p1.score, paddleX: this.p1.paddleX }, opponent: { score: this.p2.score, paddleX: this.p2.paddleX } });
        }
        const fY = y => PONG.H - y;
        const fB = this.ball && this.ball.x !== undefined ? { x: this.ball.x, y: fY(this.ball.y), vx: this.ball.vx, vy: this.ball.vy, mult: this.ball.mult, rally: this.ball.rally } : this.ball;
        if (this.p2.socket) {
            this.p2.socket.emit('pong_update', { ball: fB, you: { score: this.p2.score, paddleX: this.p2.paddleX }, opponent: { score: this.p1.score, paddleX: this.p1.paddleX } });
        }
    }
    end(r) {
        if (this._ended) return;
        this._ended = true;
        clearInterval(this.loop);
        clearInterval(this.timer);
        this.paused = true;
        if (r === 'time_up' && this.p1.score === this.p2.score && !this.suddenDeath) {
            this.suddenDeath = true;
            this.time = 30000;
            this.broadcast('system_message', { message: 'Empate! Morte súbita!' });
            this.timer = setInterval(() => this.tick(), 1000);
            this.broadcast('pong_time_update', { time: this.time });
            this._ended = false;
            this.startRound();
            return;
        }
        if (this.p1.socket) this.p1.socket.emit('pong_end', { reason: r, yourScore: this.p1.score, opponentScore: this.p2.score });
        if (this.p2.socket) this.p2.socket.emit('pong_end', { reason: r, yourScore: this.p2.score, opponentScore: this.p1.score });
        activePongGames.delete(this.p1.id);
        if (!this.isBot) activePongGames.delete(this.p2.id);
        if (this.isBot && this.bot) this.bot.inGame = false;
    }
}

// ================= JOGO DA VELHA =================
class TicTacToeGame {
    constructor(p1, p2) {
        this.p1 = p1;
        this.p2 = p2;
        this.board = Array(9).fill(null);
        this.symbols = { [p1]: 'X', [p2]: 'O' };
        this.turn = p1;
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
        if (this.over || sid !== this.turn || !Number.isInteger(pos) || pos < 0 || pos > 8 || this.board[pos] !== null) return;
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

const pendingTttInvites = new Map();
const pendingPongInvites = new Map();

// ================= MATCHMAKING =================
function removerDaFila(socketId) {
    const idx = waitingQueue.indexOf(socketId);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    const t = queueTimers.get(socketId);
    if (t) { clearTimeout(t); queueTimers.delete(socketId); }
}

function tentarConectarComHumano(socket) {
    const u = connectedUsers.get(socket.id);
    if (!u || u.partnerId) return false;
    const partnerId = waitingQueue.find(id => id !== socket.id && connectedUsers.has(id) && !connectedUsers.get(id).partnerId);
    if (!partnerId) return false;
    removerDaFila(partnerId);
    removerDaFila(socket.id);
    const pu = connectedUsers.get(partnerId);
    u.partnerId = partnerId;
    pu.partnerId = socket.id;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('chat_start', { partnerId: socket.id });
    socket.emit('chat_start', { partnerId });
    return true;
}

// ================= SOCKET.IO EVENTOS =================
io.on('connection', (socket) => {
    const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'Desconhecido';
    const ip = String(rawIp).split(',')[0].trim();

    const ban = bans.find(b => b.userIP === ip);
    if (ban) {
        const expired = ban.expiresAt && new Date(ban.expiresAt) < new Date();
        if (!expired) {
            socket.emit('you_are_banned', { reason: ban.reason, until: ban.expiresAt });
            socket.disconnect(true);
            return;
        } else {
            bans = bans.filter(b => b !== ban);
            escreverArquivo('bans.json', bans);
        }
    }

    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido', isAdmin: false, ip });
    socket.emit('games_config_update', {
        pong: { ...gamesConfig.pong, returnAt: calcularVoltaEm(gamesConfig.pong.daysRemaining) },
        tictactoe: { ...gamesConfig.tictactoe, returnAt: calcularVoltaEm(gamesConfig.tictactoe.daysRemaining) }
    });
    socket.emit('ads_config_update', adsConfig);

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
        
        if (tentarConectarComHumano(socket)) return;
        
        if (!waitingQueue.includes(socket.id)) {
            waitingQueue.push(socket.id);
            socket.emit('waiting');
        }

        for (const [botId, bot] of activeBots) {
            if (bot.userId !== socket.id) {
                const botUser = connectedUsers.get(bot.userId);
                if (botUser && botUser.partnerId === botId) {
                    bot.desconectarPorqueChegouHumano();
                }
            }
        }

        const t1 = setTimeout(() => {
            queueTimers.delete(socket.id);
            if (waitingQueue.includes(socket.id) && connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId) {
                removerDaFila(socket.id);
                const botInstance = new Bot(socket);
                botInstance.start();
            }
        }, 3000);
        queueTimers.set(socket.id, t1);
    });

    socket.on('message', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        const text = (data && typeof data.text === 'string') ? data.text.slice(0, 2000) : '';
        if (!text.trim()) return;

        const rate = verificarRateLimit(socket.id);
        if (!rate.allowed) {
            socket.emit('system_message', { message: `⏳ Aguarde ${rate.remainingSeconds}s.`, remainingSeconds: rate.remainingSeconds });
            return;
        }
        if (contemPalavraOfensiva(text)) {
            socket.emit('message_blocked', { reason: 'Sua mensagem contém linguagem imprópria.' });
            return;
        }

        const isVip = !!(data && data.isVip);
        const vipColor = (data && typeof data.vipColor === 'string') ? data.vipColor.slice(0, 20) : '#ffd700';
        const replyTo = data && data.replyTo ? data.replyTo : undefined;

        if (activeBots.has(u.partnerId)) {
            const bot = activeBots.get(u.partnerId);
            if (bot) bot.receberMensagem(text);
        } else {
            const p = io.sockets.sockets.get(u.partnerId);
            if (p) p.emit('message', { text, senderId: socket.id, location: u.location, replyTo, isVip, vipColor });
        }

        stats.totalMessages = (stats.totalMessages || 0) + 1;
        const h = new Date().toISOString().split('T')[0];
        stats.dailyMessages[h] = (stats.dailyMessages[h] || 0) + 1;
        escreverArquivo('stats.json', stats);
    });

    socket.on('typing', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId || activeBots.has(u.partnerId)) return;
        const p = io.sockets.sockets.get(u.partnerId);
        if (p) p.emit('typing', { isTyping: !!(data && data.isTyping) });
    });

    socket.on('report_user', (data) => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u) return;
        const reportedUserId = data && data.reportedUserId;
        if (!reportedUserId) return;

        let reportedIp = 'Desconhecido';
        if (activeBots.has(reportedUserId)) reportedIp = 'BOT';
        else {
            const ru = connectedUsers.get(reportedUserId);
            if (ru) reportedIp = ru.ip;
        }
        const reportedMsg = (data && typeof data.reportedMessage === 'string') ? data.reportedMessage.slice(0, 1000) : '';
        const report = {
            reportId: 'r_' + Date.now(),
            reporterIP: u.ip,
            reporterId: socket.id,
            reportedIP: reportedIp,
            reportedUserId,
            reportedMessage: reportedMsg || '(sem mensagem)',
            reason: String(data && data.reason || 'outro').slice(0, 100),
            priority: 'medium',
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        reports.push(report);
        escreverArquivo('reports.json', reports);
        registrarLog(`Denúncia de ${u.ip} contra ${reportedIp}`);
        socket.emit('report_thanks', { message: '✅ Denúncia registrada!' });
    });

    socket.on('end_chat', () => {
        if (adminSessions.has(socket.id)) return;
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;

        if (activePongGames.has(socket.id)) activePongGames.get(socket.id).end('chat_ended');
        if (activeTttGames.has(socket.id)) activeTttGames.get(socket.id).leave(socket.id);

        const pid = u.partnerId;
        u.partnerId = null;

        if (activeBots.has(pid)) {
            activeBots.get(pid).disconnect();
        } else {
            const p = io.sockets.sockets.get(pid);
            if (p) {
                p.emit('chat_ended');
                const pd = connectedUsers.get(pid);
                if (pd) pd.partnerId = null;
            }
        }
        socket.emit('chat_ended');
    });

    socket.on('pong_invite', () => {
        if (!gamesConfig.pong.active) {
            socket.emit('game_unavailable', { game: 'pong', message: gamesConfig.pong.message, returnAt: calcularVoltaEm(gamesConfig.pong.daysRemaining) });
            return;
        }
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activeBots.has(u.partnerId)) {
            const bot = activeBots.get(u.partnerId);
            if (bot.inGame) { socket.emit('system_message', { message: 'O bot já está em jogo.' }); return; }
            socket.emit('system_message', { message: 'Convite aceito pelo bot!' });
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
        if (!gamesConfig.pong.active) {
            socket.emit('game_unavailable', { game: 'pong', message: gamesConfig.pong.message, returnAt: calcularVoltaEm(gamesConfig.pong.daysRemaining) });
            return;
        }
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId || activePongGames.has(socket.id)) return;
        pendingPongInvites.delete(u.partnerId);
        new PongGame(socket.id, u.partnerId, activeBots.has(u.partnerId)).start();
    });

    socket.on('pong_decline', () => {
        const u = connectedUsers.get(socket.id);
        if (!u) return;
        for (const [fromId, toId] of pendingPongInvites) {
            if (toId === socket.id) {
                const s = io.sockets.sockets.get(fromId);
                if (s) s.emit('system_message', { message: 'Convite de Pong recusado.' });
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

    socket.on('tictactoe_invite', () => {
        if (!gamesConfig.tictactoe.active) {
            socket.emit('game_unavailable', { game: 'tictactoe', message: gamesConfig.tictactoe.message, returnAt: calcularVoltaEm(gamesConfig.tictactoe.daysRemaining) });
            return;
        }
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId) return;
        if (activeBots.has(u.partnerId)) {
            socket.emit('system_message', { message: 'O bot não joga Jogo da Velha.' });
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
        if (!gamesConfig.tictactoe.active) {
            socket.emit('game_unavailable', { game: 'tictactoe', message: gamesConfig.tictactoe.message, returnAt: calcularVoltaEm(gamesConfig.tictactoe.daysRemaining) });
            return;
        }
        const u = connectedUsers.get(socket.id);
        if (!u || !u.partnerId || activeTttGames.has(socket.id)) return;
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
                if (s) s.emit('system_message', { message: 'Convite do Jogo da Velha recusado.' });
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
            pendingTttInvites.delete(socket.id);
            for (const [fromId, toId] of pendingTttInvites) {
                if (toId === socket.id) pendingTttInvites.delete(fromId);
            }
        }
    });

    socket.on('disconnect', () => {
        try {
            removerDaFila(socket.id);
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

            for (const [fromId, toId] of pendingPongInvites) {
                if (toId === socket.id) pendingPongInvites.delete(fromId);
            }
            for (const [fromId, toId] of pendingTttInvites) {
                if (toId === socket.id) pendingTttInvites.delete(fromId);
            }
        } catch (e) {
            console.error('Erro no disconnect:', e);
        }
    });
});

// ================= LOOPS DE ATUALIZAÇÃO =================
setInterval(() => {
    const r = Array.from(connectedUsers.values()).filter(u => !u.isAdmin).length;
    let t = fakeOnlineBase + r + (Math.floor(Math.random() * 12) - 4);
    if (t < r) t = r;
    if (t > (stats.peakUsers || 0)) {
        stats.peakUsers = t;
        escreverArquivo('stats.json', stats);
    }
    io.emit('users_online', t);
}, 4500);

// Limpeza de bans expirados
setInterval(() => {
    const now = Date.now();
    const before = bans.length;
    bans = bans.filter(b => !b.expiresAt || new Date(b.expiresAt).getTime() > now);
    if (bans.length !== before) escreverArquivo('bans.json', bans);
}, 3600000);

server.listen(PORT, () => console.log(`🚀 AthesChat rodando na porta ${PORT}`));