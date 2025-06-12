const express = require('express');
const path = require('path');
const http = require('http'); // CORREÇÃO: Módulo http é necessário para o socket.io
const { Server } = require("socket.io"); // CORREÇÃO: Importação moderna do Socket.IO

const app = express();
const server = http.createServer(app); // CORREÇÃO: Criando o servidor http a partir do express
const io = new Server(server); // CORREÇÃO: Inicializando o socket.io no servidor http

const PORT = process.env.PORT || 3000;

// Serve arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Rota padrão para servir o index.html (O express.static já faz isso, mas é uma boa garantia)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Objeto para armazenar os usuários conectados
const connectedUsers = new Map();

// Objeto para armazenar os pares de chat
const chatPairs = new Map();

io.on('connection', (socket) => {
    console.log(`Novo usuário conectado: ${socket.id}`);

    // Adiciona o usuário à lista de conectados
    connectedUsers.set(socket.id, {
        id: socket.id,
        partnerId: null,
        isTyping: false
    });

    // Atualiza a contagem de usuários online para todos
    updateOnlineCount();

    // Quando um usuário quer iniciar um chat
    socket.on('join', () => {
        // Se já estiver em um chat, não faz nada
        if (connectedUsers.get(socket.id)?.partnerId) { // Adicionado '?' para segurança
            return;
        }

        // Procura por um parceiro disponível
        let partnerFound = false;
        for (const [userId, userData] of connectedUsers) {
            if (userId !== socket.id && !userData.partnerId) {
                // Forma o par de chat
                const currentUserData = connectedUsers.get(socket.id);
                if (currentUserData) currentUserData.partnerId = userId;

                const partnerUserData = connectedUsers.get(userId);
                if (partnerUserData) partnerUserData.partnerId = socket.id;

                chatPairs.set(socket.id, userId);
                chatPairs.set(userId, socket.id);

                // Notifica ambos os usuários
                socket.emit('chat_start', { partnerId: userId });
                io.to(userId).emit('chat_start', { partnerId: socket.id });

                partnerFound = true;
                break;
            }
        }

        if (!partnerFound) {
            socket.emit('waiting');
        }
    });

    // Quando um usuário envia uma mensagem
    socket.on('message', (data) => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId) {
            // A validação da mensagem é feita no CLIENTE. O servidor apenas repassa.
            io.to(partnerId).emit('message', {
                text: data.text,
                senderId: socket.id,
                replyTo: data.replyTo || null
            });
        }
    });

    // Quando um usuário está digitando
    socket.on('typing', (data) => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId) {
            const currentUserData = connectedUsers.get(socket.id);
            if (currentUserData) currentUserData.isTyping = data.isTyping;
            
            io.to(partnerId).emit('typing', {
                isTyping: data.isTyping
            });
        }
    });

    // Quando um usuário encerra o chat
    socket.on('end_chat', () => {
        const partnerId = connectedUsers.get(socket.id)?.partnerId;
        if (partnerId) {
            // Notifica o parceiro que o chat foi encerrado
            io.to(partnerId).emit('chat_ended');

            // Remove o par de chat
            chatPairs.delete(socket.id);
            chatPairs.delete(partnerId);

            // Atualiza o status dos usuários
            const currentUserData = connectedUsers.get(socket.id);
            if(currentUserData) currentUserData.partnerId = null;

            const partnerUserData = connectedUsers.get(partnerId);
            if(partnerUserData) partnerUserData.partnerId = null;

            // Notifica o usuário que encerrou
            socket.emit('partner_disconnected');
        }
    });

    // Quando um usuário desconecta
    socket.on('disconnect', () => {
        const userData = connectedUsers.get(socket.id);
        if (!userData) return;

        const partnerId = userData.partnerId;

        if (partnerId) {
            // Notifica o parceiro que o chat foi encerrado
            io.to(partnerId).emit('partner_disconnected');

            // Remove o par de chat
            chatPairs.delete(socket.id);
            chatPairs.delete(partnerId);

            // Atualiza o status do parceiro
            const partnerUserData = connectedUsers.get(partnerId);
            if(partnerUserData) partnerUserData.partnerId = null;
        }

        // Remove o usuário da lista de conectados
        connectedUsers.delete(socket.id);

        // Atualiza a contagem de usuários online
        updateOnlineCount();

        console.log(`Usuário desconectado: ${socket.id}`);
    });

    // Função para atualizar a contagem de usuários online para todos
    function updateOnlineCount() {
        const onlineCount = connectedUsers.size;
        io.emit('users_online', onlineCount);
    }
});

// Inicia o servidor
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
