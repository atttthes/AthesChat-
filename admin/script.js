const socket = io();
let currentModule = 'dashboard';
let chatMonitorActive = false;

// Verificar autenticação
async function checkAuth() {
    try {
        const res = await fetch('/admin/check-auth');
        const data = await res.json();
        if (data.authenticated) {
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('admin-panel').style.display = 'flex';
            loadDashboard();
            startAutoRefresh();
        }
    } catch(e) { console.log('Não autenticado'); }
}

// Login
document.getElementById('login-btn').onclick = async () => {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');
    
    try {
        const res = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            location.reload();
        } else {
            errorDiv.textContent = 'Credenciais inválidas!';
        }
    } catch(e) { errorDiv.textContent = 'Erro ao conectar'; }
};

// Logout
document.getElementById('logout-btn').onclick = async () => {
    await fetch('/admin/logout', { method: 'POST' });
    location.reload();
};

// Navegação
document.querySelectorAll('.sidebar-nav li').forEach(item => {
    item.onclick = () => {
        document.querySelectorAll('.sidebar-nav li').forEach(l => l.classList.remove('active'));
        item.classList.add('active');
        currentModule = item.dataset.module;
        document.querySelectorAll('.module').forEach(m => m.classList.remove('active'));
        document.getElementById(`${currentModule}-module`).classList.add('active');
        document.getElementById('module-title').textContent = item.textContent.trim();
        loadModule(currentModule);
    };
});

async function loadModule(module) {
    if (module === 'dashboard') loadDashboard();
    if (module === 'reports') loadReports();
    if (module === 'bans') loadBans();
    if (module === 'chat-monitor') initChatMonitor();
    if (module === 'ads') loadAds();
    if (module === 'config') loadConfig();
    if (module === 'stats') loadStats();
    if (module === 'logs') loadLogs();
}

async function loadDashboard() {
    try {
        const res = await fetch('/admin/dashboard');
        const data = await res.json();
        document.getElementById('online-count').textContent = data.online;
        document.getElementById('bots-count').textContent = data.botsAtivos;
        document.getElementById('msgs-today').textContent = data.mensagensHoje;
        document.getElementById('reports-pending').textContent = data.denunciasPendentes;
        document.getElementById('games-active').textContent = data.jogosAtivos;
        document.getElementById('bans-total').textContent = data.totalBanidos;
        document.getElementById('ads-active').textContent = data.anunciosAtivos;
        document.getElementById('peak-users').textContent = data.picoMaximo;
    } catch(e) { console.error(e); }
}

async function loadReports() {
    try {
        const res = await fetch('/admin/reports');
        const reports = await res.json();
        const container = document.getElementById('reports-list');
        container.innerHTML = reports.map(r => `
            <div class="report-card ${r.prioridade}">
                <strong>"${r.mensagem.substring(0, 100)}"</strong>
                <div>👤 Denunciado: ${r.denunciado}</div>
                <div>📊 Denunciado por: ${r.denuncias} usuários</div>
                <div>🕐 ${new Date(r.data).toLocaleString()}</div>
                <div class="report-actions">
                    <button class="btn-ban" onclick="handleReport(${r.id}, 'banir')">🚫 Banir</button>
                    <button class="btn-ignore" onclick="handleReport(${r.id}, 'ignorar')">✅ Ignorar</button>
                    <button class="btn-warn" onclick="handleReport(${r.id}, 'avisar')">💬 Avisar</button>
                </div>
            </div>
        `).join('');
    } catch(e) { console.error(e); }
}

window.handleReport = async (id, action) => {
    await fetch(`/admin/report/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
    });
    loadReports();
};

async function loadBans() {
    try {
        const res = await fetch('/admin/bans');
        const bans = await res.json();
        const container = document.getElementById('bans-list');
        container.innerHTML = bans.map(b => `
            <div class="ban-card">
                <strong>${b.usuario}</strong> - ${b.permanente ? '🚫 Permanente' : '⏰ Temporário'}
                <div>Motivo: ${b.motivo}</div>
                <div>Banido por: ${b.admin} em ${new Date(b.data).toLocaleDateString()}</div>
                ${!b.permanente ? `<div>Expira: ${new Date(b.expira).toLocaleDateString()}</div>` : ''}
                <button onclick="unban(${b.id})" class="btn-small">🔓 Desbanir</button>
            </div>
        `).join('');
    } catch(e) { console.error(e); }
}

window.unban = async (id) => {
    await fetch(`/admin/unban/${id}`, { method: 'POST' });
    loadBans();
};

document.getElementById('add-ban-btn').onclick = () => {
    document.getElementById('add-ban-modal').style.display = 'flex';
};
document.getElementById('cancel-ban').onclick = () => {
    document.getElementById('add-ban-modal').style.display = 'none';
};
document.getElementById('confirm-ban').onclick = async () => {
    const usuario = document.getElementById('ban-user').value;
    const motivo = document.getElementById('ban-reason').value;
    const permanente = document.getElementById('ban-permanent').checked;
    await fetch('/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario, motivo, permanente })
    });
    document.getElementById('add-ban-modal').style.display = 'none';
    loadBans();
};

document.getElementById('ban-permanent').onchange = (e) => {
    document.getElementById('temp-days').style.display = e.target.checked ? 'none' : 'block';
};

function initChatMonitor() {
    if (!chatMonitorActive) {
        socket.emit('admin_watch_chat');
        chatMonitorActive = true;
    }
    
    socket.on('admin_chat_message', (msg) => {
        const feed = document.getElementById('chat-feed');
        const offensiveWords = ['lixo', 'bosta', 'merda'];
        const isOffensive = offensiveWords.some(w => msg.text?.toLowerCase().includes(w));
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${isOffensive ? 'offensive' : ''}`;
        msgDiv.innerHTML = `<span style="color:#888">${new Date(msg.timestamp).toLocaleTimeString()}</span> - <strong>${msg.senderId === socket.id ? 'Você' : 'Anônimo'}</strong>: ${msg.text}`;
        feed.appendChild(msgDiv);
        feed.scrollTop = feed.scrollHeight;
        
        if (isOffensive) {
            const alertBox = document.getElementById('alert-box');
            alertBox.style.display = 'block';
            alertBox.innerHTML = `⚠️ ALERTA: Mensagem ofensiva detectada! <button onclick="banFromMonitor('${msg.senderId}')">🚫 Banir</button>`;
            setTimeout(() => alertBox.style.display = 'none', 5000);
        }
    });
    
    setInterval(async () => {
        const res = await fetch('/admin/dashboard');
        const data = await res.json();
        document.getElementById('online-users-count').textContent = data.online;
    }, 3000);
}

window.banFromMonitor = async (userId) => {
    await fetch('/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: userId, motivo: 'Ofensa no chat', permanente: false })
    });
    alert('Usuário banido!');
};

async function loadAds() {
    const res = await fetch('/admin/ads');
    const ads = await res.json();
    const container = document.getElementById('ads-list');
    container.innerHTML = ads.map(ad => `
        <div class="ad-card">
            <strong>${ad.nome}</strong> - ${ad.ativa ? '🟢 Ativo' : '🔴 Pausado'}
            <div>${ad.texto}</div>
            <div>👁️ ${ad.visualizacoes} views | 🖱️ ${ad.cliques} cliques (${((ad.cliques/ad.visualizacoes)*100 || 0).toFixed(1)}% CTR)</div>
            <button onclick="toggleAd(${ad.id})" class="btn-small">${ad.ativa ? '⏸️ Pausar' : '▶️ Ativar'}</button>
        </div>
    `).join('');
}

window.toggleAd = async (id) => {
    await fetch(`/admin/ad/${id}/toggle`, { method: 'POST' });
    loadAds();
};

async function loadConfig() {
    const res = await fetch('/admin/config');
    const config = await res.json();
    document.getElementById('bad-words').value = config.palavrasProibidas.join(', ');
    document.getElementById('bots-enabled').checked = config.botsAtivos;
    document.getElementById('bot-wait-time').value = config.tempoEsperaBot;
    document.getElementById('pong-goals').value = config.pongGolsVencer;
    document.getElementById('drawing-time').value = config.desenhoTempoRodada;
    document.getElementById('theme-color').value = config.corPrincipal;
    document.getElementById('site-name').value = config.nomeSite;
}

document.getElementById('save-config').onclick = async () => {
    const config = {
        palavrasProibidas: document.getElementById('bad-words').value.split(',').map(w => w.trim()),
        botsAtivos: document.getElementById('bots-enabled').checked,
        tempoEsperaBot: parseInt(document.getElementById('bot-wait-time').value),
        pongGolsVencer: parseInt(document.getElementById('pong-goals').value),
        desenhoTempoRodada: parseInt(document.getElementById('drawing-time').value),
        corPrincipal: document.getElementById('theme-color').value,
        nomeSite: document.getElementById('site-name').value
    };
    await fetch('/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    alert('Configurações salvas!');
};

async function loadStats() {
    const res = await fetch('/admin/stats');
    const stats = await res.json();
    document.getElementById('stats-details').innerHTML = `
        <p>📊 Total de mensagens: ${stats.totalMensagens}</p>
        <p>🚨 Total de denúncias: ${stats.totalDenuncias}</p>
        <p>🚫 Total de bans: ${stats.totalBans}</p>
        <p>🎮 Partidas de Pong: ${stats.totalPartidas.pong}</p>
        <p>🎮 Partidas da Velha: ${stats.totalPartidas.velha}</p>
        <p>🎨 Partidas de Desenho: ${stats.totalPartidas.desenho}</p>
    `;
}

async function loadLogs() {
    const res = await fetch('/admin/logs');
    const logs = await res.json();
    document.getElementById('logs-list').innerHTML = logs.map(log => `
        <div class="log-entry">
            [${new Date(log.data).toLocaleString()}] ${log.acao}: ${log.detalhe}
        </div>
    `).join('');
}

document.getElementById('send-broadcast').onclick = async () => {
    const titulo = document.getElementById('broadcast-title').value;
    const mensagem = document.getElementById('broadcast-message').value;
    const tipo = document.getElementById('broadcast-type').value;
    await fetch('/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titulo, mensagem, tipo })
    });
    alert('Mensagem enviada para todos os usuários!');
    document.getElementById('broadcast-title').value = '';
    document.getElementById('broadcast-message').value = '';
};

document.getElementById('export-csv').onclick = () => {
    window.location.href = '/admin/export-stats';
};

function startAutoRefresh() {
    setInterval(() => {
        if (currentModule === 'dashboard') loadDashboard();
        if (currentModule === 'reports') loadReports();
        if (currentModule === 'bans') loadBans();
        if (currentModule === 'ads') loadAds();
        if (currentModule === 'logs') loadLogs();
    }, 5000);
}

checkAuth();
