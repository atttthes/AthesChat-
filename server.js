const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

let publicPath = __dirname;
if (path.basename(__dirname) === 'src' || !require('fs').existsSync(path.join(__dirname, 'index.html'))) {
    if(require('fs').existsSync(path.join(__dirname, 'public'))) {
        publicPath = path.join(__dirname, 'public');
    } else {
        publicPath = path.join(__dirname, '..');
    }
}
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});


// --- CONSTANTES E VARIÁVEIS ---
const connectedUsers = new Map();
const activeBots = new Map();
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;
const activePongGames = new Map();
const activeTicTacToeGames = new Map();
const activeDrawingGames = new Map();

// --- LÓGICA DO BOT ---
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
        this.id = "bot_" + Date.now();
        this.partnerId = partnerSocket.id;
        this.partnerSocket = partnerSocket;
        this.location = ["São Paulo", "Rio de Janeiro", "Minas Gerais", "Bahia", "Paraná"][Math.floor(Math.random() * 5)];
        this.messageTimeout = null;
        activeBots.set(this.id, this);
        console.log("Bot " + this.id + " criado para o usuário " + this.partnerId);
    }
    startConversation() {
        connectedUsers.get(this.partnerId).partnerId = this.id;
        this.partnerSocket.emit('chat_start', { partnerId: this.id });
        setTimeout(function() {
            const greeting = botConversationLogic.greetings[Math.floor(Math.random() * botConversationLogic.greetings.length)];
            this.sendMessage(greeting);
        }.bind(this), 1500);
    }
    handleMessage(text) {
        clearTimeout(this.messageTimeout);
        this.partnerSocket.emit('typing', { isTyping: true });
        this.messageTimeout = setTimeout(function() {
            let response = this.findResponse(text);
            this.sendMessage(response);
        }.bind(this), 1000 + Math.random() * 1500);
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
        setTimeout(function() {
            const partnerData = connectedUsers.get(this.partnerId);
            if (partnerData && partnerData.partnerId === this.id) {
                this.partnerSocket.emit('chat_ended');
                partnerData.partnerId = null;
            }
            activeBots.delete(this.id);
            console.log("Bot " + this.id + " desconectado.");
        }.bind(this), 1000);
    }
}


// --- LÓGICA DO JOGO PONG ---
const PONG_CONFIG = {
    CANVAS_WIDTH: 300,
    CANVAS_HEIGHT: 400,
    PADDLE_WIDTH: 60,
    PADDLE_HEIGHT: 10,
    BALL_RADIUS: 5,
    INITIAL_BALL_SPEED_X: 2.5,
    INITIAL_BALL_SPEED_Y: 2.5,
    MAX_GOALS: 3,
    GAME_DURATION_MS: 3 * 60 * 1000,
    UPDATE_INTERVAL: 1000 / 60,
    COUNTDOWN_SECONDS: 3,
};

class PongGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), score: 0, paddleX: (PONG_CONFIG.CANVAS_WIDTH - PONG_CONFIG.PADDLE_WIDTH) / 2 };
        this.ball = {};
        this.ball2 = null;
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
        this.player1.socket.emit('pong_start', { opponentId: this.player2.id });
        this.player2.socket.emit('pong_start', { opponentId: this.player1.id });
        
        this.durationTimer = setInterval(function() { this.tick(); }.bind(this), 1000);
        this.startRound();
    }
    
    startRound() {
        this.gamePaused = true;
        clearInterval(this.gameLoop);
        this.broadcastState(); 
        this.broadcast('pong_countdown_start');

        setTimeout(function() {
            this.resetBall(this.ball, this.lastLoser);
            if (this.isSuddenDeath) {
                if (!this.ball2) this.ball2 = {};
                this.resetBall(this.ball2, this.lastLoser, true);
            }
            this.gamePaused = false;
            this.lastLoser = null;
            this.gameLoop = setInterval(function() { this.update(); }.bind(this), PONG_CONFIG.UPDATE_INTERVAL);
        }.bind(this), PONG_CONFIG.COUNTDOWN_SECONDS * 1000);
    }
    
    tick() {
        if(this.gamePaused) return;
        this.timeRemaining -= 1000;
        this.broadcast('pong_time_update', { time: this.timeRemaining });
        if (this.timeRemaining <= 0) {
            this.end('time_up');
        }
    }
    
    resetBall(ball, loserId, isSecondBall) {
        if (isSecondBall === undefined) isSecondBall = false;
        ball.x = PONG_CONFIG.CANVAS_WIDTH / 2;
        ball.y = PONG_CONFIG.CANVAS_HEIGHT / 2;
        ball.speedMultiplier = 1.0;
        ball.rallyCount = 0;
        
        ball.vx = (isSecondBall ? -1 : 1) * (Math.random() > 0.5 ? 1 : -1) * PONG_CONFIG.INITIAL_BALL_SPEED_X;
        
        let verticalDirection;
        if (loserId) {
            verticalDirection = (loserId === this.player1.id ? 1 : -1);
        } else {
            verticalDirection = -1;
        }
        ball.vy = verticalDirection * PONG_CONFIG.INITIAL_BALL_SPEED_Y;
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
        if (!ball || !ball.x) return;
        
        ball.x += ball.vx * ball.speedMultiplier;
        ball.y += ball.vy * ball.speedMultiplier;

        if (ball.x - PONG_CONFIG.BALL_RADIUS < 0 || ball.x + PONG_CONFIG.BALL_RADIUS > PONG_CONFIG.CANVAS_WIDTH) {
            ball.vx *= -1;
        }
        
        const hitPlayer1 = ball.y + PONG_CONFIG.BALL_RADIUS >= PONG_CONFIG.CANVAS_HEIGHT - PONG_CONFIG.PADDLE_HEIGHT && ball.vy > 0 && ball.x >= this.player1.paddleX && ball.x <= this.player1.paddleX + PONG_CONFIG.PADDLE_WIDTH;
        const hitPlayer2 = ball.y - PONG_CONFIG.BALL_RADIUS <= PONG_CONFIG.PADDLE_HEIGHT && ball.vy < 0 && ball.x >= this.player2.paddleX && ball.x <= this.player2.paddleX + PONG_CONFIG.PADDLE_WIDTH;

        if (hitPlayer1 || hitPlayer2) {
            const playerPaddleX = hitPlayer1 ? this.player1.paddleX : this.player2.paddleX;
            const intersectX = (playerPaddleX + (PONG_CONFIG.PADDLE_WIDTH / 2)) - ball.x;
            const normalizedIntersectX = intersectX / (PONG_CONFIG.PADDLE_WIDTH / 2);
            const maxBounceAngle = (5 * Math.PI) / 12; 
            const bounceAngle = normalizedIntersectX * maxBounceAngle;
            const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
            
            ball.vx = currentSpeed * Math.sin(bounceAngle) * -1;
            ball.vy = currentSpeed * Math.cos(bounceAngle) * (hitPlayer1 ? -1 : 1);
            ball.rallyCount++;
            if (ball.rallyCount > 0 && ball.rallyCount % 5 === 0) {
                ball.speedMultiplier = Math.min(2.5, ball.speedMultiplier + 0.15);
            }
        }
        
        if (ball.y > PONG_CONFIG.CANVAS_HEIGHT + PONG_CONFIG.BALL_RADIUS) this.handleGoal(this.player2, this.player1.id);
        else if (ball.y < -PONG_CONFIG.BALL_RADIUS) this.handleGoal(this.player1, this.player2.id);
    }

    handleGoal(winner, loserId) {
        this.lastLoser = loserId;
        winner.score++;
        if (this.isSuddenDeath || winner.score >= PONG_CONFIG.MAX_GOALS) this.end('score_limit');
        else this.startRound();
    }

    movePaddle(playerId, paddleX) {
        if (this.gamePaused) return;
        if (playerId === this.player1.id) this.player1.paddleX = paddleX;
        else if (playerId === this.player2.id) this.player2.paddleX = paddleX;
    }
    
    broadcastState() {
        const stateForP1 = {
            ball: this.ball,
            ball2: this.isSuddenDeath ? this.ball2 : null,
            you: { score: this.player1.score, paddleX: this.player1.paddleX },
            opponent: { score: this.player2.score, paddleX: this.player2.paddleX },
        };
        const socketP1 = io.sockets.sockets.get(this.player1.id);
        if(socketP1) socketP1.emit('pong_update', stateForP1);

        const flipY = function(y) { return PONG_CONFIG.CANVAS_HEIGHT - y; };

        const flippedBall = this.ball.x ? { x: this.ball.x, y: flipY(this.ball.y), vx: this.ball.vx, vy: this.ball.vy, speedMultiplier: this.ball.speedMultiplier, rallyCount: this.ball.rallyCount } : this.ball;
        
        let flippedBall2 = null;
        if (this.isSuddenDeath && this.ball2 && this.ball2.x) {
            flippedBall2 = { x: this.ball2.x, y: flipY(this.ball2.y), vx: this.ball2.vx, vy: this.ball2.vy, speedMultiplier: this.ball2.speedMultiplier, rallyCount: this.ball2.rallyCount };
        }

        const stateForP2 = {
            ball: flippedBall,
            ball2: flippedBall2,
            you: { score: this.player2.score, paddleX: this.player2.paddleX },
            opponent: { score: this.player1.score, paddleX: this.player1.paddleX },
        };
        const socketP2 = io.sockets.sockets.get(this.player2.id);
        if(socketP2) socketP2.emit('pong_update', stateForP2);
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

        const resultForP1 = { reason: reason, yourScore: this.player1.score, opponentScore: this.player2.score };
        const resultForP2 = { reason: reason, yourScore: this.player2.score, opponentScore: this.player1.score };
        
        const socketP1 = io.sockets.sockets.get(this.player1.id);
        if(socketP1) socketP1.emit('pong_end', resultForP1);
        
        const socketP2 = io.sockets.sockets.get(this.player2.id);
        if(socketP2) socketP2.emit('pong_end', resultForP2);

        activePongGames.delete(this.player1.id);
        activePongGames.delete(this.player2.id);
        console.log("Jogo de Pong entre " + this.player1.id + " e " + this.player2.id + " finalizado.");
    }
}

// ================= JOGO DA VELHA =================
const TICTACTOE_CONFIG = {
    BOARD_SIZE: 9,
    WIN_PATTERNS: [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ]
};

class TicTacToeGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), symbol: null };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), symbol: null };
        
        const randomStart = Math.random() < 0.5;
        if (randomStart) {
            this.player1.symbol = 'X';
            this.player2.symbol = 'O';
            this.currentTurn = player1Id;
            this.firstPlayer = player1Id;
        } else {
            this.player1.symbol = 'O';
            this.player2.symbol = 'X';
            this.currentTurn = player2Id;
            this.firstPlayer = player2Id;
        }
        
        this.board = Array(TICTACTOE_CONFIG.BOARD_SIZE).fill(null);
        this.gameActive = true;
        this.winner = null;
        this.isDraw = false;
        
        activeTicTacToeGames.set(player1Id, this);
        activeTicTacToeGames.set(player2Id, this);
        
        console.log("Jogo da Velha criado: P1=" + player1Id + " (" + this.player1.symbol + "), P2=" + player2Id + " (" + this.player2.symbol + ")");
    }

    broadcast(event, data) {
        if(this.player1.socket) this.player1.socket.emit(event, data);
        if(this.player2.socket) this.player2.socket.emit(event, data);
    }

    start() {
        this.player1.socket.emit('tictactoe_start', { 
            opponentId: this.player2.id,
            yourSymbol: this.player1.symbol,
            firstTurn: this.currentTurn === this.player1.id,
            starter: this.firstPlayer === this.player1.id ? 'Você' : 'Oponente'
        });
        
        this.player2.socket.emit('tictactoe_start', { 
            opponentId: this.player1.id,
            yourSymbol: this.player2.symbol,
            firstTurn: this.currentTurn === this.player2.id,
            starter: this.firstPlayer === this.player2.id ? 'Você' : 'Oponente'
        });
        
        this.broadcastState();
        
        const starterName = this.firstPlayer === this.player1.id ? 'Jogador ' + this.player1.symbol : 'Jogador ' + this.player2.symbol;
        this.broadcast('system_message', { message: "🎲 Jogo da Velha iniciado! " + starterName + " começa!" });
    }

    makeMove(playerId, position) {
        if (!this.gameActive) return { success: false, reason: 'Jogo já terminou' };
        if (playerId !== this.currentTurn) return { success: false, reason: 'Não é sua vez' };
        if (position < 0 || position >= TICTACTOE_CONFIG.BOARD_SIZE) return { success: false, reason: 'Posição inválida' };
        if (this.board[position] !== null) return { success: false, reason: 'Posição já ocupada' };
        
        const symbol = playerId === this.player1.id ? this.player1.symbol : this.player2.symbol;
        this.board[position] = symbol;
        
        const winPattern = this.checkWin(symbol);
        if (winPattern) {
            this.gameActive = false;
            this.winner = playerId;
            this.broadcast('tictactoe_game_over', {
                winner: playerId,
                winnerSymbol: symbol,
                winPattern: winPattern,
                isDraw: false
            });
            this.broadcast('system_message', { message: "🏆 VITÓRIA! Jogador " + symbol + " venceu! 🎉" });
            this.end('win');
            return { success: true, move: position, gameOver: true, winner: symbol };
        }
        
        const isDraw = this.board.every(function(cell) { return cell !== null; });
        if (isDraw) {
            this.gameActive = false;
            this.isDraw = true;
            this.broadcast('tictactoe_game_over', {
                winner: null,
                winnerSymbol: null,
                winPattern: null,
                isDraw: true
            });
            this.broadcast('system_message', { message: '🤝 EMPATE! Ninguém venceu. 🤝' });
            this.end('draw');
            return { success: true, move: position, gameOver: true, isDraw: true };
        }
        
        this.currentTurn = (this.currentTurn === this.player1.id) ? this.player2.id : this.player1.id;
        this.broadcastState();
        
        const nextPlayerSymbol = this.currentTurn === this.player1.id ? this.player1.symbol : this.player2.symbol;
        this.broadcast('system_message', { message: "🔄 Vez do jogador " + nextPlayerSymbol });
        
        return { success: true, move: position, gameOver: false };
    }
    
    checkWin(symbol) {
        for (var p = 0; p < TICTACTOE_CONFIG.WIN_PATTERNS.length; p++) {
            const pattern = TICTACTOE_CONFIG.WIN_PATTERNS[p];
            const a = pattern[0], b = pattern[1], c = pattern[2];
            if (this.board[a] === symbol && this.board[b] === symbol && this.board[c] === symbol) {
                return pattern;
            }
        }
        return null;
    }
    
    broadcastState() {
        const state = {
            board: this.board,
            currentTurn: this.currentTurn,
            gameActive: this.gameActive,
            winner: this.winner,
            isDraw: this.isDraw,
            player1Symbol: this.player1.symbol,
            player2Symbol: this.player2.symbol,
            currentTurnSymbol: this.currentTurn === this.player1.id ? this.player1.symbol : this.player2.symbol
        };
        
        this.broadcast('tictactoe_update', state);
    }
    
    end(reason) {
        activeTicTacToeGames.delete(this.player1.id);
        activeTicTacToeGames.delete(this.player2.id);
        console.log("Jogo da Velha finalizado. Motivo: " + reason);
        
        setTimeout(function() {
            if (this.player1.socket) this.player1.socket.emit('tictactoe_close');
            if (this.player2.socket) this.player2.socket.emit('tictactoe_close');
        }.bind(this), 3000);
    }
    
    forceEnd(playerLeftId) {
        const leftPlayer = playerLeftId === this.player1.id ? 'Jogador' : 'Oponente';
        this.broadcast('system_message', { message: "🚪 " + leftPlayer + " saiu do jogo. Partida encerrada." });
        this.end('player_left');
    }
}

// ================= BANCO DE PALAVRAS PARA DESENHO =================
const DRAWING_WORDS = [
    "cachorro", "gato", "elefante", "girafa", "leao", "tigre", "macaco", "pinguim", "golfinho", "cavalo",
    "cadeira", "mesa", "celular", "computador", "televisao", "geladeira", "fogao", "sofá", "cama", "abajur",
    "sol", "lua", "estrela", "chuva", "floresta", "montanha", "rio", "mar", "arvore", "flor",
    "pizza", "hamburguer", "sorvete", "bolo", "macarrao", "arroz", "feijao", "salada", "fruta", "chocolate",
    "medico", "professor", "bombeiro", "policial", "engenheiro", "advogado", "cozinheiro", "motorista", "cantor", "dentista",
    "futebol", "basquete", "tenis", "natacao", "volei", "corrida", "boxe", "skate", "surf", "ginastica",
    "carro", "moto", "bicicleta", "aviao", "helicoptero", "navio", "caminhao", "onibus", "trator", "submarino"
];

// ================= JOGO DE DESENHO =================
class DrawingGame {
    constructor(player1Id, player2Id) {
        this.player1 = { id: player1Id, socket: io.sockets.sockets.get(player1Id), ready: false };
        this.player2 = { id: player2Id, socket: io.sockets.sockets.get(player2Id), ready: false };
        
        const randomDrawer = Math.random() < 0.5;
        if (randomDrawer) {
            this.drawerId = player1Id;
            this.guesserId = player2Id;
        } else {
            this.drawerId = player2Id;
            this.guesserId = player1Id;
        }
        
        const randomIndex = Math.floor(Math.random() * DRAWING_WORDS.length);
        this.currentWord = DRAWING_WORDS[randomIndex];
        
        this.gameActive = false;
        this.countdownActive = false;
        this.timeLeft = 60;
        this.timerInterval = null;
        this.winner = null;
        this.guessHistory = [];
        
        activeDrawingGames.set(player1Id, this);
        activeDrawingGames.set(player2Id, this);
        
        console.log("Jogo de Desenho criado - Drawer: " + this.drawerId + " (" + this.currentWord + ") - Guesser: " + this.guesserId);
    }
    
    broadcast(event, data) {
        if(this.player1.socket) this.player1.socket.emit(event, data);
        if(this.player2.socket) this.player2.socket.emit(event, data);
    }
    
    sendToPlayer(playerId, event, data) {
        const socket = io.sockets.sockets.get(playerId);
        if(socket) socket.emit(event, data);
    }
    
    setReady(playerId) {
        if (playerId === this.player1.id) this.player1.ready = true;
        else if (playerId === this.player2.id) this.player2.ready = true;
        
        if (this.player1.ready && this.player2.ready && !this.gameActive && !this.countdownActive) {
            this.startGame();
        }
        
        if (!this.player1.ready) {
            this.sendToPlayer(this.player2.id, 'drawing_waiting', { player: "Jogador 1" });
        } else if (!this.player2.ready) {
            this.sendToPlayer(this.player1.id, 'drawing_waiting', { player: "Jogador 2" });
        }
    }
    
    startGame() {
        this.gameActive = true;
        this.timeLeft = 60;
        
        this.sendToPlayer(this.drawerId, 'drawing_start', {
            role: 'drawer',
            word: this.currentWord,
            timeLimit: this.timeLeft
        });
        
        this.sendToPlayer(this.guesserId, 'drawing_start', {
            role: 'guesser',
            wordLength: this.currentWord.length,
            timeLimit: this.timeLeft
        });
        
        this.timerInterval = setInterval(function() {
            if (!this.gameActive) return;
            this.timeLeft--;
            this.broadcast('drawing_timer', { timeLeft: this.timeLeft });
            
            if (this.timeLeft <= 0) {
                clearInterval(this.timerInterval);
                this.endGame('timeout', 'Tempo esgotado!', null);
            }
        }.bind(this), 1000);
    }
    
    makeDraw(playerId, drawingData) {
        if (!this.gameActive) return;
        if (playerId !== this.drawerId) return;
        this.sendToPlayer(this.guesserId, 'drawing_update', drawingData);
    }
    
    makeGuess(playerId, guess) {
        if (!this.gameActive) return;
        if (playerId !== this.guesserId) return;
        
        const normalizedGuess = guess.toLowerCase().trim();
        const normalizedWord = this.currentWord.toLowerCase();
        
        const guessEntry = {
            guess: guess,
            isCorrect: normalizedGuess === normalizedWord,
            timestamp: Date.now()
        };
        this.guessHistory.push(guessEntry);
        
        this.broadcast('drawing_chat_update', { history: this.guessHistory });
        
        if (normalizedGuess === normalizedWord) {
            this.endGame('correct_guess', 'Acertou a palavra!', this.guesserId);
        } else {
            this.sendToPlayer(this.guesserId, 'drawing_wrong_guess', { guess: guess });
        }
    }
    
    endGame(reason, message, winnerId) {
        if (!this.gameActive) return;
        this.gameActive = false;
        if (this.timerInterval) clearInterval(this.timerInterval);
        
        this.winner = winnerId;
        
        let winnerRole = "Ninguém";
        if (winnerId === this.drawerId) winnerRole = "Desenhista";
        else if (winnerId === this.guesserId) winnerRole = "Adivinhador";
        
        this.broadcast('drawing_game_over', {
            winnerId: winnerId,
            winnerRole: winnerRole,
            word: this.currentWord,
            reason: reason,
            message: message,
            history: this.guessHistory
        });
        
        const chatMessage = "🏆 " + winnerRole + " venceu o Que Rabisco é esse! Palavra era: " + this.currentWord;
        this.broadcast('system_message', { message: chatMessage });
        
        setTimeout(function() {
            this.cleanup();
        }.bind(this), 5000);
    }
    
    cleanup() {
        activeDrawingGames.delete(this.player1.id);
        activeDrawingGames.delete(this.player2.id);
        console.log("Jogo de Desenho finalizado");
    }
    
    forceEnd(playerLeftId) {
        if (!this.gameActive) return;
        const leftPlayer = playerLeftId === this.drawerId ? 'Desenhista' : 'Adivinhador';
        const winnerId = playerLeftId === this.drawerId ? this.guesserId : this.drawerId;
        this.endGame('player_left', leftPlayer + " saiu do jogo", winnerId);
    }
}

// --- LÓGICA DE CONEXÃO PRINCIPAL ---
io.on('connection', function(socket) {
    console.log("Novo usuário conectado: " + socket.id);
    
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido' });
    
    socket.on('join', function(data) {
        const currentUserData = connectedUsers.get(socket.id);
        if (!currentUserData) return;
        if (data && data.location) currentUserData.location = data.location;
        if (currentUserData.partnerId) return;

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

            console.log("Bot " + botId + " removido para dar lugar a um usuário real.");
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
            setTimeout(function() {
                if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId) {
                    const bot = new Bot(socket);
                    bot.startConversation();
                }
            }, 3000);
        }
    });

    socket.on('message', function(data) {
        const senderData = connectedUsers.get(socket.id);
        if (!senderData || !senderData.partnerId) return;
        const partnerId = senderData.partnerId;

        if (activeBots.has(partnerId)) {
            activeBots.get(partnerId).handleMessage(data.text);
        } else {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                partnerSocket.emit('message', { 
                    text: data.text, 
                    senderId: socket.id, 
                    replyTo: data.replyTo || null, 
                    location: senderData.location 
                });
            }
        }
    });

    socket.on('typing', function(data) {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId && !activeBots.has(partnerId)) {
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) partnerSocket.emit('typing', { isTyping: data.isTyping });
        }
    });

    socket.on('end_chat', function() {
        endUserChat(socket.id);
    });

    socket.on('disconnect', function() {
        if (activePongGames.has(socket.id)) {
            const game = activePongGames.get(socket.id);
            if(game) game.end('partner_disconnected');
        }
        
        if (activeTicTacToeGames.has(socket.id)) {
            const game = activeTicTacToeGames.get(socket.id);
            if(game) game.forceEnd(socket.id);
        }
        
        if (activeDrawingGames.has(socket.id)) {
            const game = activeDrawingGames.get(socket.id);
            if(game) game.forceEnd(socket.id);
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
        console.log("Usuário desconectado: " + socket.id);
    });
    
    // --- EVENTOS DE PONG ---
    socket.on('pong_invite', function() {
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
    
    socket.on('pong_decline', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) {
            partnerSocket.emit('system_message', { message: "❌ Seu parceiro recusou o desafio do Pong." });
        }
    });
    
    socket.on('pong_accept', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        if (activePongGames.has(socket.id) || activePongGames.has(userData.partnerId)) return;
        const newGame = new PongGame(userData.partnerId, socket.id);
        newGame.start();
    });
    
    socket.on('pong_move', function(data) {
        const game = activePongGames.get(socket.id);
        if (game) game.movePaddle(socket.id, data.paddleX);
    });
    
    socket.on('pong_leave', function() {
        const game = activePongGames.get(socket.id);
        if (game) game.end('player_left');
    });

    // --- EVENTOS DO JOGO DA VELHA ---
    socket.on('tictactoe_invite', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId || activeBots.has(userData.partnerId)) {
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
            socket.emit('system_message', { message: "⏳ Convite para Jogo da Velha enviado." });
        }
    });
    
    socket.on('tictactoe_decline', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) partnerSocket.emit('system_message', { message: "❌ Seu parceiro recusou o desafio." });
    });
    
    socket.on('tictactoe_accept', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        if (activeTicTacToeGames.has(socket.id) || activeTicTacToeGames.has(userData.partnerId)) return;
        const newGame = new TicTacToeGame(userData.partnerId, socket.id);
        newGame.start();
    });
    
    socket.on('tictactoe_move', function(data) {
        const game = activeTicTacToeGames.get(socket.id);
        if (game) {
            const result = game.makeMove(socket.id, data.position);
            if (!result.success) socket.emit('system_message', { message: "⚠️ " + result.reason });
        }
    });
    
    socket.on('tictactoe_leave', function() {
        const game = activeTicTacToeGames.get(socket.id);
        if (game) game.forceEnd(socket.id);
    });

    // --- EVENTOS DO JOGO DE DESENHO ---
    socket.on('drawing_invite', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId || activeBots.has(userData.partnerId)) {
            socket.emit('system_message', { message: "⚠️ Você só pode jogar com um parceiro real." });
            return;
        }
        if (activeDrawingGames.has(socket.id)) {
            socket.emit('system_message', { message: "⚠️ Você já está em uma partida de desenho." });
            return;
        }
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) {
            if (activeDrawingGames.has(userData.partnerId)) {
                socket.emit('system_message', { message: "⚠️ Seu parceiro já está em uma partida." });
                return;
            }
            partnerSocket.emit('drawing_invite_received');
            socket.emit('system_message', { message: "⏳ Convite para Que Rabisco é esse? enviado." });
        }
    });
    
    socket.on('drawing_decline', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if (partnerSocket) partnerSocket.emit('system_message', { message: "❌ Seu parceiro recusou o desafio." });
    });
    
    socket.on('drawing_accept', function() {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;
        if (activeDrawingGames.has(socket.id) || activeDrawingGames.has(userData.partnerId)) return;
        const newGame = new DrawingGame(userData.partnerId, socket.id);
        socket.emit('drawing_tutorial_required');
        const partnerSocket = io.sockets.sockets.get(userData.partnerId);
        if(partnerSocket) partnerSocket.emit('drawing_tutorial_required');
    });
    
    socket.on('drawing_tutorial_ready', function() {
        const game = activeDrawingGames.get(socket.id);
        if (game) game.setReady(socket.id);
    });
    
    socket.on('drawing_make_draw', function(data) {
        const game = activeDrawingGames.get(socket.id);
        if (game) game.makeDraw(socket.id, data);
    });
    
    socket.on('drawing_make_guess', function(data) {
        const game = activeDrawingGames.get(socket.id);
        if (game) game.makeGuess(socket.id, data.guess);
    });
    
    socket.on('drawing_leave', function() {
        const game = activeDrawingGames.get(socket.id);
        if (game) game.forceEnd(socket.id);
    });

    function pairRealUsers(socket1, socket2) {
        const user1Data = connectedUsers.get(socket1.id);
        const user2Data = connectedUsers.get(socket2.id);
        if (user1Data) user1Data.partnerId = socket2.id;
        if (user2Data) user2Data.partnerId = socket1.id;
        socket1.emit('chat_start', { partnerId: socket2.id });
        socket2.emit('chat_start', { partnerId: socket1.id });
        console.log("Usuários " + socket1.id + " e " + socket2.id + " pareados.");
    }
    
    function endUserChat(socketId) {
        const userData = connectedUsers.get(socketId);
        if (!userData || !userData.partnerId) return;

        const partnerId = userData.partnerId;
        
        const pongGame = activePongGames.get(socketId);
        if (pongGame) pongGame.end('chat_ended');
        
        const tttGame = activeTicTacToeGames.get(socketId);
        if (tttGame) tttGame.forceEnd(socketId);
        
        const drawingGame = activeDrawingGames.get(socketId);
        if (drawingGame) drawingGame.forceEnd(socketId);
        
        userData.partnerId = null;

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

server.listen(PORT, function() {
    console.log("Servidor rodando na porta " + PORT);
});