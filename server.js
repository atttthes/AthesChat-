//server.js COMPLETO E FUNCIONAL

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 5000, 
    pingInterval: 10000
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const connectedUsers = new Map();
const activeBots = new Map();
let waitingUser = null; // Armazena o socket do usuário esperando por um par
const BOT_PAIRING_TIMEOUT = 10000; // 10 segundos para encontrar um par real

const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;

// --- LÓGICA DO BOT (COMPLETA) ---
const botConversationLogic = {
    greetings: ["Olá!", "Oi, tudo bem?", "E aí, como vai?", "Prazer em te conhecer!"],
    keywords: {
        "oi": ["Oie!", "Olá!"],
        "tudo bem": ["Tudo ótimo, e com você?", "Estou bem, obrigado por perguntar!", "Melhor agora falando com você."],
        "qual seu nome": ["Pode me chamar de 'Interlocutor'. É um nome chique, né?", "Eu sou um bot, não tenho nome de verdade.", "Meu nome é Byte, e o seu?"],
        "idade": ["Eu nasci hoje de manhã!", "Sou atemporal, haha.", "Idade é só um número, não acha?"],
        "onde você é": ["Eu vivo na nuvem, em algum servidor por aí.", "Sou de um lugar chamado 'localhost'."],
        "tchau": ["Até mais!", "Tchauzinho!", "Foi bom conversar com você!"],
        "sexo": ["Sou um programa de computador, não tenho gênero.", "Sou feito de código, e você?"],
        "programa": ["Sim, sou um programa de computador, um bot.", "Isso mesmo, fui criado para conversar."],
        "bot": ["Fui descoberto! Sim, sou um bot.", "Sim, sou um bot. Mas podemos conversar mesmo assim, certo?"]
    },
    questions: ["O que você gosta de fazer no seu tempo livre?", "Qual seu filme favorito?", "Você tem algum pet?", "Qual o último lugar que você viajou?", "O que te traz aqui hoje?"],
    fallbacks: ["Interessante...", "Me fale mais sobre isso.", "Entendi.", "Hmm...", "Que legal.", "Não sei o que dizer, mas estou ouvindo."]
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
        this.partnerSocket.emit('chat_start', { partnerId: this.id, location: this.location });
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
        this.partnerSocket.emit('message', { text: text, senderId: this.id });
    }

    disconnect(farewellMessage = "Tchau, preciso ir agora!") {
        if (farewellMessage) {
            this.sendMessage(farewellMessage);
        }
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


// --- LÓGICA DE CONEXÃO E CHAT (COMPLETA) ---
io.on('connection', (socket) => {
    console.log(`Novo usuário conectado: ${socket.id}`);
    
    connectedUsers.set(socket.id, { id: socket.id, partnerId: null, location: 'Desconhecido', inGame: false, waitingTimeout: null });
    
    function handleUserDisconnection() {
        const userData = connectedUsers.get(socket.id);
        if (!userData) return;
        
        // Se o usuário estava na fila de espera, remove-o
        if (waitingUser && waitingUser.id === socket.id) {
            waitingUser = null;
        }

        // Se o usuário estava em um jogo, avise o parceiro
        if (userData.inGame && userData.partnerId) {
            const partnerSocket = io.sockets.sockets.get(userData.partnerId);
            if (partnerSocket) {
                partnerSocket.emit('pong:game_over', { reason: "O parceiro desconectou."});
                const partnerData = connectedUsers.get(userData.partnerId);
                if (partnerData) partnerData.inGame = false;
            }
        }

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
    }

    // --- LÓGICA DE PAREAMENTO (COMPLETA) ---
    socket.on('join', (data) => {
        const currentUserData = connectedUsers.get(socket.id);
        if (!currentUserData || currentUserData.partnerId) return;

        currentUserData.location = data.location || 'Desconhecido';

        if (waitingUser && waitingUser.id !== socket.id) {
            const partnerSocket = waitingUser;
            waitingUser = null; // Limpa a fila de espera
            pairRealUsers(socket, partnerSocket);
        } else {
            waitingUser = socket;
            socket.emit('waiting_for_partner');
            
            // Timeout para parear com um bot se ninguém aparecer
            const timeoutId = setTimeout(() => {
                if (waitingUser && waitingUser.id === socket.id) {
                    waitingUser = null;
                    const bot = new Bot(socket);
                    bot.startConversation();
                }
            }, BOT_PAIRING_TIMEOUT);
            currentUserData.waitingTimeout = timeoutId;
        }
    });

    socket.on('message', (data) => {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;

        if (activeBots.has(userData.partnerId)) {
            const bot = activeBots.get(userData.partnerId);
            if (bot) bot.handleMessage(data.text);
        } else {
            const partnerSocket = io.sockets.sockets.get(userData.partnerId);
            if (partnerSocket) {
                partnerSocket.emit('message', { text: data.text, senderId: socket.id });
            }
        }
    });

    socket.on('typing', (data) => {
        const userData = connectedUsers.get(socket.id);
        if (userData && userData.partnerId && !activeBots.has(userData.partnerId)) {
            const partnerSocket = io.sockets.sockets.get(userData.partnerId);
            if (partnerSocket) {
                partnerSocket.emit('typing', { isTyping: data.isTyping });
            }
        }
    });

    socket.on('end_chat', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;

        if (userData.inGame) {
            const partnerSocket = io.sockets.sockets.get(userData.partnerId);
            if(partnerSocket) partnerSocket.emit('pong:game_over', { reason: "O parceiro encerrou a conversa." });
            userData.inGame = false;
            const partnerData = connectedUsers.get(userData.partnerId);
            if (partnerData) partnerData.inGame = false;
        }

        const partnerId = userData.partnerId;
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
        socket.emit('chat_ended');
    });

    socket.on('disconnect', handleUserDisconnection);
    
    // --- LÓGICA DO JOGO PONG (já estava completa) ---
    function getPartnerSocket(currentSocket) {
        const userData = connectedUsers.get(currentSocket.id);
        if (userData && userData.partnerId && !activeBots.has(userData.partnerId)) {
            return io.sockets.sockets.get(userData.partnerId);
        }
        return null;
    }

    socket.on('pong:invite', () => {
        const partnerSocket = getPartnerSocket(socket);
        if (partnerSocket) partnerSocket.emit('pong:receive_invite');
    });

    socket.on('pong:decline_invite', () => {
        const partnerSocket = getPartnerSocket(socket);
        if (partnerSocket) partnerSocket.emit('pong:invite_declined');
    });

    socket.on('pong:accept_invite', () => {
        const partnerSocket = getPartnerSocket(socket);
        if (partnerSocket) {
            connectedUsers.get(socket.id).inGame = true;
            connectedUsers.get(partnerSocket.id).inGame = true;
            partnerSocket.emit('pong:start_game', { isHost: true });
            socket.emit('pong:start_game', { isHost: false });
        }
    });

    socket.on('pong:move', (data) => {
        const partnerSocket = getPartnerSocket(socket);
        if (partnerSocket) partnerSocket.emit('pong:opponent_move', data);
    });
    
    socket.on('pong:state_sync', (data) => {
        const partnerSocket = getPartnerSocket(socket);
        if (partnerSocket) partnerSocket.emit('pong:update_state', data);
    });

    socket.on('pong:goal', () => { /* Apenas para gatilho de som, etc. */ });
    
    socket.on('pong:end_game', () => {
        const partnerSocket = getPartnerSocket(socket);
        const userData = connectedUsers.get(socket.id);
        if (userData) userData.inGame = false;
        socket.emit('pong:game_over', { reason: "Você encerrou o jogo." });
        if (partnerSocket) {
            partnerSocket.emit('pong:game_over', { reason: "O parceiro encerrou o jogo." });
            const partnerData = connectedUsers.get(partnerSocket.id);
            if (partnerData) partnerData.inGame = false;
        }
    });

    socket.on('pong:game_over_win', (winnerId) => {
        const partnerSocket = getPartnerSocket(socket);
        const userData = connectedUsers.get(socket.id);
        if (userData) userData.inGame = false;
        socket.emit('pong:game_over', { winnerId });
        if(partnerSocket) {
            partnerSocket.emit('pong:game_over', { winnerId });
            const partnerData = connectedUsers.get(partnerSocket.id);
            if (partnerData) partnerData.inGame = false;
        }
    });

    function pairRealUsers(socket1, socket2) {
        const user1Data = connectedUsers.get(socket1.id);
        const user2Data = connectedUsers.get(socket2.id);

        if (!user1Data || !user2Data) return; // Segurança

        // Limpa o timeout do usuário que estava esperando
        if (user2Data.waitingTimeout) {
            clearTimeout(user2Data.waitingTimeout);
            user2Data.waitingTimeout = null;
        }

        user1Data.partnerId = socket2.id;
        user2Data.partnerId = socket1.id;

        console.log(`Pareando usuários: ${socket1.id} e ${socket2.id}`);

        // Envia o evento de início de chat para ambos
        socket1.emit('chat_start', { partnerId: socket2.id, location: user2Data.location });
        socket2.emit('chat_start', { partnerId: socket1.id, location: user1Data.location });
    }
});

// --- CONTADOR DE USUÁRIOS E INICIALIZAÇÃO DO SERVIDOR (COMPLETO) ---
function broadcastDynamicOnlineCount() {
    const realUsers = connectedUsers.size;
    const dynamicCount = fakeOnlineBase + realUsers;
    io.emit('online_count_update', dynamicCount);
}

setInterval(broadcastDynamicOnlineCount, 4500);

server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
