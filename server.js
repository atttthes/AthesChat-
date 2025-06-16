// server.js ATUALIZADO

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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


// --- LÓGICA DO JOGO PONG (NOVO) ---
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
};

class PongGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.ball = { x: PONG_CONFIG.CANVAS_WIDTH / 2, y: PONG_CONFIG.CANVAS_HEIGHT / 2, vx: PONG_CONFIG.INITIAL_BALL_SPEED_X, vy: PONG_CONFIG.INITIAL_BALL_SPEED_Y, speedMultiplier: 1.0 };
        this.rallyCount = 0;

        activePongGames.set(player1Id, this);
        activePongGames.set(player2Id, this);
        
        this.gameLoop = null;
        this.gameTimer = null;
    }

    start() {
        // Envia o evento para os clientes iniciarem o jogo, informando quem é o jogador 1 e 2
        this.player1.socket.emit('pong_start', { opponentId: this.player2.id, isPlayerOne: true });
        this.player2.socket.emit('pong_start', { opponentId: this.player1.id, isPlayerOne: false });
        
        this.gameTimer = setTimeout(() => this.end('time_up'), PONG_CONFIG.GAME_DURATION_MS);
        this.resetBall();
        this.gameLoop = setInterval(() => this.update(), PONG_CONFIG.UPDATE_INTERVAL);
    }
    
    resetBall(loser) {
        this.ball.x = PONG_CONFIG.CANVAS_WIDTH / 2;
        this.ball.y = PONG_CONFIG.CANVAS_HEIGHT / 2;
        this.ball.speedMultiplier = 1.0;
        this.rallyCount = 0;
        
        this.ball.vx = (Math.random() > 0.5 ? 1 : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_X;
        // A bola vai em direção a quem perdeu o ponto
        this.ball.vy = loser === this.player1 ? PONG_CONFIG.INITIAL_BALL_SPEED_Y : -PONG_CONFIG.INITIAL_BALL_SPEED_Y;
    }

    update() {
        // Move a bola
        this.ball.x += this.ball.vx * this.ball.speedMultiplier;
        this.ball.y += this.ball.vy * this.ball.speedMultiplier;

        // Colisão com paredes laterais
        if (this.ball.x - PONG_CONFIG.BALL_RADIUS < 0 || this.ball.x + PONG_CONFIG.BALL_RADIUS > PONG_CONFIG.CANVAS_WIDTH) {
            this.ball.vx *= -1;
        }

        // Colisão com raquetes
        // Raquete do Jogador 1 (embaixo)
        if (this.ball.y + PONG_CONFIG.BALL_RADIUS > PONG_CONFIG.CANVAS_HEIGHT - PONG_CONFIG.PADDLE_HEIGHT &&
            this.ball.x > this.player1.paddleX && this.ball.x < this.player1.paddleX + PONG_CONFIG.PADDLE_WIDTH &&
            this.ball.vy > 0) {
            this.ball.vy *= -1;
            this.increaseRally();
        }
        // Raquete do Jogador 2 (em cima)
        if (this.ball.y - PONG_CONFIG.BALL_RADIUS < PONG_CONFIG.PADDLE_HEIGHT &&
            this.ball.x > this.player2.paddleX && this.ball.x < this.player2.paddleX + PONG_CONFIG.PADDLE_WIDTH &&
            this.ball.vy < 0) {
            this.ball.vy *= -1;
            this.increaseRally();
        }

        // Pontuação
        if (this.ball.y > PONG_CONFIG.CANVAS_HEIGHT) { // Ponto para Jogador 2
            this.player2.score++;
            this.checkWinOrReset(this.player1);
        } else if (this.ball.y < 0) { // Ponto para Jogador 1
            this.player1.score++;
            this.checkWinOrReset(this.player2);
        } else {
             this.broadcastState();
        }
    }
    
    increaseRally() {
        this.rallyCount++;
        // Aumenta a velocidade a cada 5 rebatidas
        if (this.rallyCount > 0 && this.rallyCount % 5 === 0) {
            this.ball.speedMultiplier = Math.min(2.5, this.ball.speedMultiplier + 0.1);
        }
    }

    checkWinOrReset(loser) {
         if (this.player1.score >= PONG_CONFIG.MAX_GOALS || this.player2.score >= PONG_CONFIG.MAX_GOALS) {
            this.end('score_limit');
        } else {
            this.broadcastState(); // Envia o estado com o placar atualizado
            this.resetBall(loser);
        }
    }

    movePaddle(playerId, paddleX) {
        if (playerId === this.player1.id) {
            this.player1.paddleX = paddleX;
        } else if (playerId === this.player2.id) {
            this.player2.paddleX = paddleX;
        }
    }

    broadcastState() {
        const gameState = {
            ball: this.ball,
            p1: { score: this.player1.score, paddleX: this.player1.paddleX },
            p2: { score: this.player2.score, paddleX: this.player2.paddleX },
        };
        this.player1.socket.emit('pong_update', gameState);
        this.player2.socket.emit('pong_update', gameState);
    }

    end(reason) {
        clearInterval(this.gameLoop);
        clearTimeout(this.gameTimer);

        const result = {
            reason: reason,
            scores: { p1: this.player1.score, p2: this.player2.score }
        };
        
        this.player1.socket.emit('pong_end', result);
        this.player2.socket.emit('pong_end', result);

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

        // Lógica de pareamento... (inalterada)
        let userWithBot = null;
        for (const [userId, userData] of connectedUsers) {
            if (userData.partnerId && activeBots.has(userData.partnerId)) {
                userWithBot = io.sockets.sockets.get(userId);
                break;
            }
        }
        if (userWithBot) {
            const botId = connectedUsers.get(userWithBot.id).partnerId;
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
        // Encerra qualquer jogo de pong ativo
        if (activePongGames.has(socket.id)) {
            const game = activePongGames.get(socket.id);
            game.end('partner_disconnected');
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
    
    // --- NOVOS EVENTOS DE PONG ---
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
        
        // Previne que um jogo comece se um já estiver ativo com esses jogadores
        if (activePongGames.has(socket.id) || activePongGames.has(userData.partnerId)) return;
        
        const newGame = new PongGame(userData.partnerId, socket.id);
        newGame.start();
    });
    
    socket.on('pong_move', (data) => {
        if (activePongGames.has(socket.id)) {
            const game = activePongGames.get(socket.id);
            game.movePaddle(socket.id, data.paddleX);
        }
    });
    
    socket.on('pong_leave', () => {
         if (activePongGames.has(socket.id)) {
            const game = activePongGames.get(socket.id);
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

        if (activePongGames.has(socketId)) {
            const game = activePongGames.get(socketId);
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
        io.sockets.sockets.get(socketId)?.emit('chat_ended');
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
