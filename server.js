// server.js ATUALIZADO

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- AJUSTE DE DIRETÓRIO ESTÁTICO (CORREÇÃO DO ERRO) ---
// O erro 'ENOENT: .../src/index.html' na plataforma de deploy (Render.com)
// indica que o servidor está procurando os arquivos estáticos (como index.html)
// em um diretório 'src', mas eles estão na raiz do projeto.
// O código abaixo resolve isso de forma adaptativa:
// 1. Ele verifica se o script está rodando de dentro de um diretório chamado 'src'.
// 2. Se estiver, ele define o caminho dos arquivos públicos como o diretório pai ('..').
// 3. Caso contrário (ambiente local), ele usa o diretório atual (__dirname).
// Isso garante que o app funcione tanto no seu computador quanto no servidor da Render.
let publicPath = __dirname;
if (path.basename(__dirname) === 'src') {
    publicPath = path.join(__dirname, '..');
}
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});


// --- CONSTANTES E VARIÁVEIS ---
const connectedUsers = new Map();
const activeBots = new Map();
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;
const activePongGames = new Map(); // Gerencia os jogos de Pong ativos

// --- LÓGICA DO BOT (Inalterada) ---
const botConversationLogic = {
    greetings: ["Olá!", "E aí, tudo bem?", "Oi, como vai?", "Opa, tudo certo?"],
    farewells: ["Preciso ir agora, até mais!", "Foi bom conversar, tchau!", "Falou, até a próxima!"],
    questions: ["O que você gosta de fazer?", "Qual seu filme favorito?", "Ouve que tipo de música?", "De onde você fala?", "Trabalha com o quê?"],
    keywords: {
        'tudo bem': ["Tudo ótimo por aqui, e com você?", "Tudo certo, e por aí?", "Vou bem, obrigado por perguntar!"],
        'qual seu nome': ["Sou anônimo, assim como você haha", "Prefiro não dizer, vamos manter o mistério.", "Me chame de... Anônimo."],
        'você é um bot': ["Haha, será? 🤔", "O que te faz pensar isso?", "Sou apenas mais um anônimo na rede.", "Talvez... ou talvez não."],
        'tédio': ["Tédio é complicado. Que tal um jogo? Pedra, papel ou tesoura?", "Vamos falar de algo legal pra passar o tempo.", "Conta uma piada!"],
        'filme': ["Adoro filmes! Viu algum bom recentemente?", "Gosto de ficção científica. E você?", "Prefiro séries, na verdade. Recomenda alguma?"],
        'música': ["Música é vida! Curto um pouco de tudo, principalmente rock.", "No momento estou ouvindo muito pop.", "Qual sua banda preferida?"],
    },
    fallbacks: [ "Interessante...", "Hmm, me conte mais.", "Não sei muito sobre isso.", "Entendi.", "Mudar de assunto... que tal o clima, hein?", "Sério?", "Legal."]
};

class Bot {
    constructor(partnerSocket) {
        this.id = `bot_${Date.now()}`;
        this.partnerId = partnerSocket.id;
        this.partnerSocket = partnerSocket;
        this.location = ["São Paulo", "Rio de Janeiro", "Minas Gerais", "Bahia", "Paraná"][Math.floor(Math.random() * 5)];
        this.messageTimeout = null;
        activeBots.set(this.id, this);
        console.log(`Bot ${this.id} criado para o usuário ${this.partnerId}`);
    }
    startConversation() {
        connectedUsers.get(this.partnerId).partnerId = this.id;
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
            console.log(`Bot ${this.id} desconectado.`);
        }, 1000);
    }
}


// --- LÓGICA DO JOGO PONG (ATUALIZADO) ---
const PONG_CONFIG = {
    CANVAS_WIDTH: 300,
    CANVAS_HEIGHT: 400,
    PADDLE_WIDTH: 60,
    PADDLE_HEIGHT: 10,
    BALL_RADIUS: 5,
    INITIAL_BALL_SPEED_X: 2.5,
    INITIAL_BALL_SPEED_Y: 2.5,
    MAX_GOALS: 3,
    GAME_DURATION_MS: 3 * 60 * 1000, // 3 minutos
    UPDATE_INTERVAL: 1000 / 60, // ~60 FPS
    COUNTDOWN_SECONDS: 3,
};

class PongGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.ball = {};
        this.ball2 = null; // Para o modo Morte Súbita
        this.isSuddenDeath = false;
        this.gamePaused = true;
        this.lastLoser = null;
        
        activePongGames.set(player1Id, this);
        activePongGames.set(player2Id, this);
        
        this.gameLoop = null;
        this.durationTimer = null;
        this.timeRemaining = PONG_CONFIG.GAME_DURATION_MS;
    }

    broadcast(event, data) {
        if(this.player1.socket) this.player1.socket.emit(event, data);
        if(this.player2.socket) this.player2.socket.emit(event, data);
    }

    start() {
        this.player1.socket.emit('pong_start', { opponentId: this.player2.id, isPlayerOne: true });
        this.player2.socket.emit('pong_start', { opponentId: this.player1.id, isPlayerOne: false });
        
        this.durationTimer = setInterval(() => this.tick(), 1000);
        this.startRound();
    }
    
    startRound() {
        this.gamePaused = true;
        clearInterval(this.gameLoop);
        this.broadcastState(); // Garante que placar e posições estejam atualizados
        this.broadcast('pong_countdown_start');

        setTimeout(() => {
            this.resetBall(this.ball, this.lastLoser);
            if (this.isSuddenDeath) {
                if (!this.ball2) this.ball2 = {};
                this.resetBall(this.ball2, this.lastLoser, true); // Inicia a segunda bola
            }
            this.gamePaused = false;
            this.lastLoser = null; // Limpa o perdedor anterior
            this.gameLoop = setInterval(() => this.update(), PONG_CONFIG.UPDATE_INTERVAL);
        }, PONG_CONFIG.COUNTDOWN_SECONDS * 1000);
    }
    
    tick() {
        if(this.gamePaused) return;
        this.timeRemaining -= 1000;
        this.broadcast('pong_time_update', { time: this.timeRemaining });
        if (this.timeRemaining <= 0) {
            this.end('time_up');
        }
    }
    
    resetBall(ball, loser, isSecondBall = false) {
        ball.x = PONG_CONFIG.CANVAS_WIDTH / 2;
        ball.y = PONG_CONFIG.CANVAS_HEIGHT / 2;
        ball.speedMultiplier = 1.0;
        ball.rallyCount = 0;
        
        ball.vx = (isSecondBall ? -1 : 1) * (Math.random() > 0.5 ? 1 : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_X;
        // Direciona a bola para o jogador que perdeu o último ponto
        ball.vy = (loser === this.player1.id ? 1 : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_Y;
    }

    update() {
        if (this.gamePaused) return;

        this.updateBall(this.ball);
        if (this.isSuddenDeath && this.ball2) {
            this.updateBall(this.ball2);
        }
        
        this.broadcastState();
    }
    
    updateBall(ball) {
        if (!ball) return;
        
        ball.x += ball.vx * ball.speedMultiplier;
        ball.y += ball.vy * ball.speedMultiplier;

        // Colisão com paredes laterais
        if (ball.x - PONG_CONFIG.BALL_RADIUS < 0 || ball.x + PONG_CONFIG.BALL_RADIUS > PONG_CONFIG.CANVAS_WIDTH) {
            ball.vx *= -1;
        }
        
        // Detecção de colisão com as barras
        const hitPlayer1 = ball.y + PONG_CONFIG.BALL_RADIUS >= PONG_CONFIG.CANVAS_HEIGHT - PONG_CONFIG.PADDLE_HEIGHT && ball.vy > 0 && ball.x > this.player1.paddleX && ball.x < this.player1.paddleX + PONG_CONFIG.PADDLE_WIDTH;
        const hitPlayer2 = ball.y - PONG_CONFIG.BALL_RADIUS <= PONG_CONFIG.PADDLE_HEIGHT && ball.vy < 0 && ball.x > this.player2.paddleX && ball.x < this.player2.paddleX + PONG_CONFIG.PADDLE_WIDTH;

        if (hitPlayer1 || hitPlayer2) {
            const playerPaddleX = hitPlayer1 ? this.player1.paddleX : this.player2.paddleX;
            
            // 1. Calcula o ponto de intersecção relativo ao centro da barra
            const intersectX = (playerPaddleX + (PONG_CONFIG.PADDLE_WIDTH / 2)) - ball.x;
            
            // 2. Normaliza o valor (-1 a 1)
            const normalizedIntersectX = intersectX / (PONG_CONFIG.PADDLE_WIDTH / 2);
            
            // 3. Calcula o ângulo de rebote (máximo 75 graus)
            const maxBounceAngle = (5 * Math.PI) / 12; 
            const bounceAngle = normalizedIntersectX * maxBounceAngle;
            
            // 4. Atualiza os componentes de velocidade da bola
            const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
            ball.vx = currentSpeed * Math.sin(bounceAngle) * -1;
            
            // Garante que a bola vá na direção Y correta após a colisão
            if (hitPlayer2) { // Acertou a barra de cima (player 2), deve ir para baixo
                ball.vy = currentSpeed * Math.cos(bounceAngle);
            } else { // Acertou a barra de baixo (player 1), deve ir para cima
                ball.vy = currentSpeed * -Math.cos(bounceAngle);
            }

            // Aumenta a velocidade a cada 5 rebatidas
            ball.rallyCount++;
            if (ball.rallyCount > 0 && ball.rallyCount % 5 === 0) {
                ball.speedMultiplier = Math.min(2.5, ball.speedMultiplier + 0.15);
            }
        }
        
        // Detecção de gol
        if (ball.y > PONG_CONFIG.CANVAS_HEIGHT + PONG_CONFIG.BALL_RADIUS) {
            this.handleGoal(this.player2, this.player1.id); // Player 2 marca
        } else if (ball.y < -PONG_CONFIG.BALL_RADIUS) {
            this.handleGoal(this.player1, this.player2.id); // Player 1 marca
        }
    }

    handleGoal(winner, loserId) {
        this.lastLoser = loserId; // Armazena quem perdeu o ponto
        winner.score++;

        if (this.isSuddenDeath || winner.score >= PONG_CONFIG.MAX_GOALS) {
            this.end('score_limit');
        } else {
            this.startRound(); // Inicia uma nova rodada com countdown
        }
    }

    movePaddle(playerId, paddleX) {
        if (this.gamePaused) return;
        if (playerId === this.player1.id) this.player1.paddleX = paddleX;
        else if (playerId === this.player2.id) this.player2.paddleX = paddleX;
    }

    broadcastState() {
        const gameState = {
            ball: this.ball,
            ball2: this.isSuddenDeath ? this.ball2 : null,
            p1: { score: this.player1.score, paddleX: this.player1.paddleX },
            p2: { score: this.player2.score, paddleX: this.player2.paddleX },
        };
        this.broadcast('pong_update', gameState);
    }

    end(reason) {
        clearInterval(this.gameLoop);
        clearInterval(this.durationTimer);
        this.gamePaused = true;

        if (reason === 'time_up' && this.player1.score === this.player2.score && !this.isSuddenDeath) {
            this.isSuddenDeath = true;
            this.broadcast('system_message', { message: '🏆 EMPATE! Morte súbita ativada com 2 bolas. O próximo a marcar vence!' });
            this.startRound();
            return;
        }

        const result = {
            reason: reason,
            scores: { p1: this.player1.score, p2: this.player2.score }
        };
        
        this.broadcast('pong_end', result);

        activePongGames.delete(this.player1.id);
        activePongGames.delete(this.player2.id);
        console.log(`Jogo de Pong entre ${this.player1.id} e ${this.player2.id} finalizado.`);
    }
}


// --- LÓGICA DE CONEXÃO PRINCIPAL ---
io.on('connection', (socket) => {
    console.log(`Novo usuário conectado: ${socket.id}`);
    
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido' });
    
    socket.on('join', (data) => {
        const currentUserData = connectedUsers.get(socket.id);
        if (!currentUserData) return;
        if (data && data.location) currentUserData.location = data.location;
        if (currentUserData.partnerId) return;

        // Lógica de pareamento
        let userWithBot = null;
        for (const [userId, userData] of connectedUsers) {
            if (userData.partnerId && activeBots.has(userData.partnerId)) {
                userWithBot = io.sockets.sockets.get(userId);
                break;
            }
        }
        if (userWithBot) {
            const botId = connectedUsers.get(userWithBot.id).partnerId;
            const bot = activeBots.get(botId);
            if (bot) bot.disconnect();
            activeBots.delete(botId);

            console.log(`Bot ${botId} removido para dar lugar a um usuário real.`);
            userWithBot.emit('system_message', { message: '✔️ Um parceiro real foi encontrado! Conectando...' });
            connectedUsers.get(userWithBot.id).partnerId = null;
            pairRealUsers(socket, userWithBot);
            return;
        }
        let realPartner = null;
        for (const [userId, userData] of connectedUsers) {
            if (userId !== socket.id && !userData.partnerId) {
                realPartner = io.sockets.sockets.get(userId);
                break;
            }
        }
        if (realPartner) {
            pairRealUsers(socket, realPartner);
        } else {
            socket.emit('waiting');
            setTimeout(() => {
                if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId) {
                    const bot = new Bot(socket);
                    bot.startConversation();
                }
            }, 3000);
        }
    });

    socket.on('message', (data) => {
        const senderData = connectedUsers.get(socket.id);
        if (!senderData || !senderData.partnerId) return;
        const partnerId = senderData.partnerId;

        if (activeBots.has(partnerId)) {
            activeBots.get(partnerId).handleMessage(data.text);
        } else {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                partnerSocket.emit('message', { text: data.text, senderId: socket.id, replyTo: data.replyTo || null, location: senderData.location });
            }
        }
    });

    socket.on('typing', (data) => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId && !activeBots.has(partnerId)) {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) partnerSocket.emit('typing', { isTyping: data.isTyping });
        }
    });

    socket.on('end_chat', () => {
        endUserChat(socket.id);
    });

    socket.on('disconnect', () => {
        if (activePongGames.has(socket.id)) {
            const game = activePongGames.get(socket.id);
            if(game) game.end('partner_disconnected');
        }

        const userData = connectedUsers.get(socket.id);
        if (!userData) return;
        const partnerId = userData.partnerId;
        if (partnerId) {
            if (activeBots.has(partnerId)) {
                if (activeBots.get(partnerId)) activeBots.delete(partnerId);
            } else {
                const partnerSocket = io.sockets.sockets.get(partnerId);
                if (partnerSocket) {
                    partnerSocket.emit('partner_disconnected');
                    const partnerData = connectedUsers.get(partnerId);
                    if(partnerData) partnerData.partnerId = null;
                }
            }
        }
        connectedUsers.delete(socket.id);
        console.log(`Usuário desconectado: ${socket.id}`);
    });
    
    // --- EVENTOS DE PONG ---
    socket.on('pong_invite', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId || activeBots.has(userData.partnerId)) {
            socket.emit('system_message', { message: "⚠️ Você só pode jogar com um parceiro real." });
            return;
        }
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) {
            partnerSocket.emit('pong_invite_received');
            socket.emit('system_message', { message: "⏳ Convite para o Pong enviado. Aguardando resposta..." });
        }
    });
    
    socket.on('pong_decline', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) {
            partnerSocket.emit('system_message', { message: "❌ Seu parceiro recusou o desafio do Pong." });
        }
    });
    
    socket.on('pong_accept', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        
        if (activePongGames.has(socket.id) || activePongGames.has(userData.partnerId)) return;
        
        // Player 2 (o que aceitou) e Player 1 (o que convidou)
        const newGame = new PongGame(userData.partnerId, socket.id);
        newGame.start();
    });
    
    socket.on('pong_move', (data) => {
        const game = activePongGames.get(socket.id);
        if (game) {
            game.movePaddle(socket.id, data.paddleX);
        }
    });
    
    socket.on('pong_leave', () => {
        const game = activePongGames.get(socket.id);
        if (game) {
            game.end('player_left');
        }
    });


    function pairRealUsers(socket1, socket2) {
        const user1Data = connectedUsers.get(socket1.id);
        const user2Data = connectedUsers.get(socket2.id);
        if (user1Data) user1Data.partnerId = socket2.id;
        if (user2Data) user2Data.partnerId = socket1.id;
        socket1.emit('chat_start', { partnerId: socket2.id });
        socket2.emit('chat_start', { partnerId: socket1.id });
        console.log(`Usuários ${socket1.id} e ${socket2.id} pareados.`);
    }
    
    function endUserChat(socketId) {
        const userData = connectedUsers.get(socketId);
        if (!userData || !userData.partnerId) return;

        const partnerId = userData.partnerId;
        userData.partnerId = null;

        const game = activePongGames.get(socketId);
        if (game) {
            game.end('chat_ended');
        }

        if (activeBots.has(partnerId)) {
            const bot = activeBots.get(partnerId);
            if (bot) bot.disconnect();
        } else {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                partnerSocket.emit('chat_ended');
                const partnerData = connectedUsers.get(partnerId);
                if(partnerData) partnerData.partnerId = null;
            }
        }
        const userSocket = io.sockets.sockets.get(socketId);
        if(userSocket) userSocket.emit('chat_ended');
    }
});

function broadcastDynamicOnlineCount() {
    const realUsers = connectedUsers.size;
    const baseCount = fakeOnlineBase + realUsers;
    const fluctuation = Math.floor(Math.random() * 12) - 4;
    let totalOnline = baseCount + fluctuation;
    if (totalOnline < realUsers) totalOnline = realUsers;
    io.emit('users_online', totalOnline);
}

setInterval(broadcastDynamicOnlineCount, 4500);

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
