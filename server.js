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

// --- NOVAS CONSTANTES E VARIÁVEIS ---
const connectedUsers = new Map();
const activeBots = new Map(); // Gerencia os bots ativos
// Base para o contador de usuários online, adicionando um número aleatório inicial
const fakeOnlineBase = Math.floor(Math.random() * (500 - 250 + 1)) + 250;

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
    fallbacks: [
        "Interessante...", "Hmm, me conte mais.", "Não sei muito sobre isso.", "Entendi.", "Mudar de assunto... que tal o clima, hein?", "Sério?", "Legal."
    ]
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
        // Simula o início da conversa
        connectedUsers.get(this.partnerId).partnerId = this.id;
        this.partnerSocket.emit('chat_start', { partnerId: this.id });

        // Envia uma saudação inicial após um pequeno atraso
        setTimeout(() => {
            const greeting = botConversationLogic.greetings[Math.floor(Math.random() * botConversationLogic.greetings.length)];
            this.sendMessage(greeting);
        }, 1500);
    }

    handleMessage(text) {
        clearTimeout(this.messageTimeout);
        
        // Simula o "digitando..."
        this.partnerSocket.emit('typing', { isTyping: true });

        this.messageTimeout = setTimeout(() => {
            let response = this.findResponse(text);
            this.sendMessage(response);
        }, 1000 + Math.random() * 1500); // Responde em um tempo variado
    }

    findResponse(text) {
        const lowerText = text.toLowerCase();
        for (const keyword in botConversationLogic.keywords) {
            if (lowerText.includes(keyword)) {
                const possibleResponses = botConversationLogic.keywords[keyword];
                return possibleResponses[Math.floor(Math.random() * possibleResponses.length)];
            }
        }
        // Se não encontrar keyword, pode fazer uma pergunta ou usar um fallback
        if (Math.random() > 0.6) {
             return botConversationLogic.questions[Math.floor(Math.random() * botConversationLogic.questions.length)];
        }
        return botConversationLogic.fallbacks[Math.floor(Math.random() * botConversationLogic.fallbacks.length)];
    }
    
    sendMessage(text) {
        this.partnerSocket.emit('typing', { isTyping: false });
        this.partnerSocket.emit('message', {
            text: text,
            senderId: this.id,
            location: this.location
        });
    }

    disconnect(farewellMessage) {
        if (farewellMessage) {
            this.sendMessage(farewellMessage);
        }
        
        setTimeout(() => {
            // Apenas emite 'chat_ended' se o parceiro ainda existir e estiver pareado com ESTE bot
            const partnerData = connectedUsers.get(this.partnerId);
            if (partnerData && partnerData.partnerId === this.id) {
                this.partnerSocket.emit('chat_ended');
                partnerData.partnerId = null;
            }
            activeBots.delete(this.id);
            console.log(`Bot ${this.id} desconectado.`);
        }, 1000); // Dá um tempo para a mensagem de despedida ser lida
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

        // Lógica de pareamento atualizada
        // 1. Verificar se há algum usuário conversando com um bot.
        let userWithBot = null;
        for (const [userId, userData] of connectedUsers) {
            if (userData.partnerId && activeBots.has(userData.partnerId)) {
                userWithBot = io.sockets.sockets.get(userId);
                break;
            }
        }

        if (userWithBot) {
            // **ATUALIZAÇÃO:** Lógica corrigida para transição de bot para usuário real.
            const botId = connectedUsers.get(userWithBot.id).partnerId;
            
            // 1. Remove o bot silenciosamente sem enviar 'chat_ended'.
            activeBots.delete(botId);
            console.log(`Bot ${botId} removido para dar lugar a um usuário real.`);

            // 2. Informa ao usuário que estava com o bot que um parceiro real foi encontrado.
            userWithBot.emit('system_message', { message: '✔️ Um parceiro real foi encontrado! Conectando...' });
            
            // 3. Libera o usuário que estava com o bot para pareamento.
            connectedUsers.get(userWithBot.id).partnerId = null;
            
            // 4. Pareia os dois usuários reais.
            pairRealUsers(socket, userWithBot);
            return;
        }

        // 2. Procurar por um parceiro real que não esteja em um chat
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
            // 3. Se não houver ninguém, cria um bot
            socket.emit('waiting'); // Mostra a mensagem de "procurando" rapidamente
            setTimeout(() => {
                 // Verifica novamente se o usuário ainda está sozinho antes de criar o bot
                if (connectedUsers.has(socket.id) && !connectedUsers.get(socket.id).partnerId) {
                    const bot = new Bot(socket);
                    bot.startConversation();
                }
            }, 3000); // Atraso para simular busca
        }
    });

    socket.on('message', (data) => {
        const senderData = connectedUsers.get(socket.id);
        if (!senderData || !senderData.partnerId) return;

        const partnerId = senderData.partnerId;

        if (activeBots.has(partnerId)) {
            // Mensagem é para um bot
            const bot = activeBots.get(partnerId);
            bot.handleMessage(data.text);
        } else {
            // Mensagem é para um usuário real
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

    socket.on('typing', (data) => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId && !activeBots.has(partnerId)) { // Não envia typing para bots
            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
               partnerSocket.emit('typing', { isTyping: data.isTyping });
            }
        }
    });

    socket.on('end_chat', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData || !userData.partnerId) return;

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

    socket.on('disconnect', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData) return;

        const partnerId = userData.partnerId;
        if (partnerId) {
            if (activeBots.has(partnerId)) {
                const bot = activeBots.get(partnerId);
                if (bot) activeBots.delete(bot.id); // Apenas deleta o bot se o usuário desconectar
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

    function pairRealUsers(socket1, socket2) {
        const user1Data = connectedUsers.get(socket1.id);
        const user2Data = connectedUsers.get(socket2.id);

        if (user1Data) user1Data.partnerId = socket2.id;
        if (user2Data) user2Data.partnerId = socket1.id;

        socket1.emit('chat_start', { partnerId: socket2.id });
        socket2.emit('chat_start', { partnerId: socket1.id });
        console.log(`Usuários ${socket1.id} e ${socket2.id} pareados.`);
    }
});

// **ATUALIZAÇÃO:** Lógica de variação do contador de usuários online.
function broadcastDynamicOnlineCount() {
    const realUsers = connectedUsers.size;
    const baseCount = fakeOnlineBase + realUsers;
    // Gera uma flutuação aleatória, por exemplo, entre -4 e +7
    const fluctuation = Math.floor(Math.random() * 12) - 4;
    let totalOnline = baseCount + fluctuation;

    // Garante que o número nunca seja menor que o número real de usuários
    if (totalOnline < realUsers) {
        totalOnline = realUsers;
    }

    io.emit('users_online', totalOnline);
}

// Emite o contador atualizado a cada 4.5 segundos
setInterval(broadcastDynamicOnlineCount, 4500);


server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
