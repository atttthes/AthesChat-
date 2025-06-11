// --- NOVO server.js (CORRIGIDO) ---

const express = require('express');
const path = require('path');
const http = require('http'); // 1. Importar o módulo http
const { Server } = require("socket.io"); // 2. Importar o Server do socket.io

const app = express();
const server = http.createServer(app); // 3. Criar um servidor http a partir do app Express
const io = new Server(server); // 4. Iniciar o socket.io no servidor http

const PORT = process.env.PORT || 3000;

// --- ESTRUTURA DE DIRETÓRIOS ---
// Certifique-se que seus arquivos estão assim:
// meu-projeto/
// ├── server.js
// ├── package.json
// └── public/
//     └── index.html

// Serve arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Rota padrão para servir o index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Objeto para armazenar os usuários conectados
const connectedUsers = new Map();

// Objeto para armazenar os pares de chat (não estritamente necessário com a lógica atual, mas mantido)
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
        if (connectedUsers.get(socket.id) && connectedUsers.get(socket.id).partnerId) {
            return;
        }
        
        // Procura por um parceiro disponível
        let partnerFound = false;
        for (const [userId, userData] of connectedUsers) {
            if (userId !== socket.id && !userData.partnerId) {
                // Forma o par de chat
                connectedUsers.get(socket.id).partnerId = userId;
                connectedUsers.get(userId).partnerId = socket.id;
                
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
        const currentUser = connectedUsers.get(socket.id);
        if (currentUser && currentUser.partnerId) {
            io.to(currentUser.partnerId).emit('message', {
                text: data.text,
                senderId: socket.id,
                replyTo: data.replyTo || null
            });
        }
    });
    
    // Quando um usuário está digitando
    socket.on('typing', (data) => {
        const currentUser = connectedUsers.get(socket.id);
        if (currentUser && currentUser.partnerId) {
            io.to(currentUser.partnerId).emit('typing', {
                isTyping: data.isTyping
            });
        }
    });
    
    // Quando um usuário encerra o chat
    socket.on('end_chat', () => {
        const currentUser = connectedUsers.get(socket.id);
        if (currentUser && currentUser.partnerId) {
            const partnerId = currentUser.partnerId;
            const partnerUser = connectedUsers.get(partnerId);

            // Notifica o parceiro que o chat foi encerrado
            io.to(partnerId).emit('chat_ended');
            
            // Remove o par de chat
            chatPairs.delete(socket.id);
            chatPairs.delete(partnerId);
            
            // Atualiza o status dos usuários
            currentUser.partnerId = null;
            if (partnerUser) {
                partnerUser.partnerId = null;
            }
            
            // Notifica o usuário que encerrou
            socket.emit('chat_ended'); // Notifica a si mesmo para atualizar a UI
        }
    });
    
    // Quando um usuário desconecta
    socket.on('disconnect', () => {
        const currentUser = connectedUsers.get(socket.id);

        if (currentUser && currentUser.partnerId) {
            const partnerId = currentUser.partnerId;
            const partnerUser = connectedUsers.get(partnerId);
            
            // Notifica o parceiro que o chat foi encerrado
            io.to(partnerId).emit('partner_disconnected');
            
            // Remove o par de chat
            chatPairs.delete(socket.id);
            chatPairs.delete(partnerId);
            
            // Atualiza o status do parceiro
            if(partnerUser) {
               partnerUser.partnerId = null;
            }
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

// 5. Iniciar o servidor http, não o app Express
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
