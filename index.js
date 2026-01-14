require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');

// =======================
// VERIFICAÇÃO DA API KEY
// =======================
if (!process.env.GPT_API_KEY) {
    console.error('❌ ERRO: GPT_API_KEY não encontrada no .env');
    process.exit(1);
}

const openai = new OpenAI({ 
    apiKey: process.env.GPT_API_KEY,
    timeout: 30000
});

// =======================
// CONFIGURAÇÃO DE PASTAS
// =======================
const dadosDir = path.join(__dirname, 'dados');
const publicDir = path.join(__dirname, 'public');
const agendamentosDir = path.join(__dirname, 'mensagens_agendadas');

// Criar pastas se não existirem
[ dadosDir, publicDir, agendamentosDir ].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Pasta criada: ${dir}`);
    }
});

// =======================
// ARQUIVOS ESSENCIAIS
// =======================
const conversasFile = path.join(dadosDir, 'conversas.json');
const treinoFile = path.join(dadosDir, 'treino.txt');
const usuariosFile = path.join(dadosDir, 'usuarios.txt');
const promptsLogFile = path.join(dadosDir, 'prompts_log.txt');

// Criar arquivos com conteúdo padrão
if (!fs.existsSync(conversasFile)) fs.writeFileSync(conversasFile, '[]');
if (!fs.existsSync(treinoFile)) fs.writeFileSync(treinoFile, 'Você é um assistente útil chamado SalvoRadaBot.\n');
if (!fs.existsSync(usuariosFile)) fs.writeFileSync(usuariosFile, 'admin|admin123\n');
if (!fs.existsSync(promptsLogFile)) fs.writeFileSync(promptsLogFile, '=== LOG DE PROMPTS ===\n');

// =======================
// FUNÇÕES DO SISTEMA
// =======================

// Função para listar conversas
function listarConversas(limite = 100, filtroNumero = '', modo = 'todas') {
    try {
        let conversas = JSON.parse(fs.readFileSync(conversasFile, 'utf8'));
        
        // Aplicar filtro de número se fornecido
        if (filtroNumero && filtroNumero.trim() !== '') {
            const filtro = filtroNumero.trim();
            conversas = conversas.filter(conv => 
                conv.numero && conv.numero.includes(filtro)
            );
        }
        
        // Ordenar por data (mais recentes primeiro)
        conversas.sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));
        
        // Limitar quantidade
        conversas = conversas.slice(0, limite);
        
        return conversas;
    } catch (error) {
        console.error('❌ Erro ao listar conversas:', error);
        return [];
    }
}

// Função para salvar conversa
function salvarConversa(numero, mensagem, autor, tipo) {
    try {
        const conversas = JSON.parse(fs.readFileSync(conversasFile, 'utf8'));
        
        const novaConversa = {
            id: Date.now() + Math.random(),
            numero: numero,
            mensagem: mensagem,
            autor: autor,
            tipo: tipo,
            dataHora: new Date().toISOString(),
            dataFormatada: new Date().toLocaleString('pt-BR'),
            origem: autor === 'bot' ? '🤖 Bot' : '👤 Usuário'
        };
        
        conversas.unshift(novaConversa);
        if (conversas.length > 2000) conversas.length = 2000;
        
        fs.writeFileSync(conversasFile, JSON.stringify(conversas, null, 2));
        console.log(`💾 Conversa salva: ${autor} -> ${numero}`);
    } catch (error) {
        console.error('❌ Erro ao salvar conversa:', error);
    }
}

// Função para listar agendamentos
function listarAgendamentos() {
    try {
        if (!fs.existsSync(agendamentosDir)) return [];
        const arquivos = fs.readdirSync(agendamentosDir);
        const agendamentos = [];

        for (const arquivo of arquivos) {
            if (!arquivo.endsWith('.txt')) continue;
            const caminho = path.join(agendamentosDir, arquivo);
            const dados = fs.readFileSync(caminho, 'utf8');
            
            const agendamento = { 
                arquivo: arquivo, 
                status: 'pendente',
                criado: new Date().toISOString()
            };
            
            // Extrair dados do arquivo
            dados.split('\n').forEach(l => {
                const idx = l.indexOf('=');
                if (idx > -1) {
                    const k = l.slice(0, idx).trim();
                    const v = l.slice(idx + 1).trim();
                    agendamento[k] = v;
                }
            });
            
            // Adicionar data de criação do arquivo
            try {
                const stats = fs.statSync(caminho);
                agendamento.criado = stats.birthtime.toISOString();
            } catch (e) {
                // Se não conseguir pegar a data de criação, usa a atual
            }
            
            agendamentos.push(agendamento);
        }
        
        // Ordenar por data e hora mais próximas
        return agendamentos.sort((a, b) => {
            const dataA = new Date(`${a.data}T${a.hora}`);
            const dataB = new Date(`${b.data}T${b.hora}`);
            return dataA - dataB;
        });
    } catch (error) {
        console.error('❌ Erro ao listar agendamentos:', error);
        return [];
    }
}

// =======================
// EXPRESS + SOCKET.IO
// =======================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.static('public'));

// =======================
// LOGIN - FUNÇÃO DE VALIDAÇÃO
// =======================
const usuariosLogados = new Map();

function validarLogin(usuario, senha) {
    try {
        const conteudo = fs.readFileSync(usuariosFile, 'utf8');
        const linhas = conteudo.split('\n');
        
        for (let linha of linhas) {
            linha = linha.trim();
            if (!linha) continue;
            
            const partes = linha.split('|');
            if (partes.length >= 2) {
                const u = partes[0].trim();
                const s = partes[1].trim();
                if (u === usuario && s === senha) {
                    return true;
                }
            }
        }
        return false;
    } catch (error) {
        console.error('❌ Erro ao validar login:', error);
        return false;
    }
}

// =======================
// SOCKET.IO - EVENTOS COMPLETOS
// =======================
let currentQR = null;
let whatsappPronto = false;

io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado:', socket.id);

    // =====================
    // 1. LOGIN
    // =====================
    socket.on('login', ({ usuario, senha }) => {
        console.log(`🔐 Tentativa de login: ${usuario}`);
        
        if (validarLogin(usuario, senha)) {
            usuariosLogados.set(socket.id, usuario);
            const token = Buffer.from(`${usuario}:${Date.now()}`).toString('base64');
            socket.emit('login_ok', { token });
            
            // Auto-login para prompts.html
            socket.emit('sessao_valida');
            
            console.log(`✅ Login bem-sucedido: ${usuario}`);
            
            if (whatsappPronto) {
                socket.emit('ready');
            } else if (currentQR) {
                socket.emit('qr', currentQR);
            }
        } else {
            socket.emit('login_erro', 'Credenciais inválidas');
        }
    });

    // =====================
    // 2. VALIDAR SESSÃO
    // =====================
    socket.on('validar_sessao', (token) => {
        try {
            const decoded = Buffer.from(token, 'base64').toString();
            if (decoded.includes(':')) {
                usuariosLogados.set(socket.id, 'admin');
                socket.emit('sessao_valida');
                console.log(`✅ Sessão válida para ${socket.id}`);
                
                if (whatsappPronto) {
                    socket.emit('ready');
                } else if (currentQR) {
                    socket.emit('qr', currentQR);
                }
            } else {
                socket.emit('login_erro', 'Sessão inválida');
            }
        } catch (error) {
            socket.emit('login_erro', 'Sessão inválida');
        }
    });

    // =====================
    // 3. EDITOR DE PROMPTS
    // =====================
    
    // 3.1 LISTAR ARQUIVOS
    socket.on('listar_arquivos_prompts', () => {
        if (!usuariosLogados.has(socket.id)) {
            console.log('⚠️ Não autenticado para listar arquivos');
            socket.emit('arquivos_lista', []);
            return;
        }

        fs.readdir(dadosDir, (err, files) => {
            if (err) {
                socket.emit('arquivos_lista', []);
                return;
            }
            
            const txtFiles = files.filter(f => f.endsWith('.txt'));
            console.log(`📁 Arquivos encontrados: ${txtFiles.length}`);
            socket.emit('arquivos_lista', txtFiles);
        });
    });

    // 3.2 CARREGAR ARQUIVO
    socket.on('carregar_arquivo', (data) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('erro_arquivo', 'Não autenticado');
            return;
        }

        const filePath = path.join(dadosDir, data.nome);
        
        fs.readFile(filePath, 'utf8', (err, conteudo) => {
            if (err) {
                console.log(`❌ Erro ao ler ${data.nome}:`, err.message);
                socket.emit('erro_arquivo', 'Arquivo não encontrado');
                return;
            }
            
            console.log(`📄 Conteúdo carregado: ${data.nome} (${conteudo.length} chars)`);
            socket.emit('conteudo_arquivo', {
                nome: data.nome,
                conteudo: conteudo
            });
        });
    });

    // 3.3 SALVAR ARQUIVO
    socket.on('salvar_arquivo', (data) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('erro_salvar', 'Não autenticado');
            return;
        }

        const filePath = path.join(dadosDir, data.nome);
        
        fs.writeFile(filePath, data.conteudo, 'utf8', (err) => {
            if (err) {
                socket.emit('erro_salvar', 'Erro ao salvar');
                return;
            }
            
            console.log(`💾 Arquivo salvo: ${data.nome}`);
            socket.emit('arquivo_salvo', { nome: data.nome });
        });
    });

    // =====================
    // 4. SALVAR PROMPT (Treinar IA)
    // =====================
    socket.on('salvar_prompt', ({ prompt }) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('prompt_erro', 'Não autenticado');
            return;
        }

        try {
            fs.appendFileSync(treinoFile, `\n${prompt}\n`);
            fs.appendFileSync(promptsLogFile, `[${new Date().toLocaleString()}] ${prompt}\n---\n`);
            socket.emit('prompt_salvo');
            console.log(`📝 Prompt salvo por ${socket.id}`);
        } catch (error) {
            console.error('❌ Erro ao salvar prompt:', error);
            socket.emit('prompt_erro', 'Erro ao salvar');
        }
    });

    // =====================
    // 5. AGENDAR MENSAGEM
    // =====================
    socket.on('agendar_mensagem', ({ numero, mensagem, data, hora }) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('erro_agendamento', 'Não autenticado');
            return;
        }

        try {
            const nomeArquivo = `${data}_${hora.replace(':', '-')}_${numero}.txt`;
            const caminho = path.join(agendamentosDir, nomeArquivo);

            const conteudo = `numero=${numero}
data=${data}
hora=${hora}
mensagem=${mensagem}
status=pendente
criado=${new Date().toISOString()}
`;

            fs.writeFileSync(caminho, conteudo);
            console.log('📆 Mensagem agendada:', caminho);
            socket.emit('mensagem_agendada');
        } catch (error) {
            console.error('❌ Erro ao agendar mensagem:', error);
            socket.emit('erro_agendamento', 'Erro interno');
        }
    });

    // =====================
    // 6. LISTAR AGENDAMENTOS
    // =====================
    socket.on('listar_agendamentos', () => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('agendamentos_erro', 'Não autenticado');
            return;
        }

        try {
            const agendamentos = listarAgendamentos();
            socket.emit('agendamentos_lista', agendamentos);
            console.log(`📋 Lista de agendamentos enviada para ${socket.id}`);
        } catch (error) {
            console.error('❌ Erro ao listar agendamentos:', error);
            socket.emit('agendamentos_erro', 'Erro ao carregar lista');
        }
    });

    // =====================
    // 7. LISTAR CONVERSAS
    // =====================
    socket.on('listar_conversas', ({ filtroNumero, limite, modo }) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('conversas_erro', 'Não autenticado');
            return;
        }

        try {
            const conversas = listarConversas(
                parseInt(limite) || 100, 
                filtroNumero, 
                modo || 'todas'
            );
            
            socket.emit('conversas_lista', { 
                conversas: conversas, 
                modo: modo || 'todas',
                total: conversas.length
            });
            
            console.log(`💬 Lista de conversas enviada para ${socket.id} (${conversas.length} itens)`);
        } catch (error) {
            console.error('❌ Erro ao listar conversas:', error);
            socket.emit('conversas_erro', 'Erro ao carregar conversas');
        }
    });

    // =====================
    // 8. EXPORTAR CONVERSAS
    // =====================
    socket.on('exportar_conversas', ({ filtroNumero, limite }, callback) => {
        if (!usuariosLogados.has(socket.id)) {
            callback({ erro: 'Não autenticado' });
            return;
        }

        try {
            let conversas = listarConversas(parseInt(limite) || 100, filtroNumero, 'todas');
            
            callback({ 
                success: true, 
                conversas: conversas,
                total: conversas.length 
            });
        } catch (error) {
            console.error('❌ Erro ao exportar conversas:', error);
            callback({ erro: 'Erro ao exportar' });
        }
    });

    // =====================
    // 9. LIMPAR CONVERSAS
    // =====================
    socket.on('limpar_conversas', () => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('conversas_erro', 'Não autenticado');
            return;
        }

        try {
            fs.writeFileSync(conversasFile, '[]');
            socket.emit('conversas_limpas');
            console.log(`🗑️ Conversas limpas por ${socket.id}`);
        } catch (error) {
            console.error('❌ Erro ao limpar conversas:', error);
            socket.emit('conversas_erro', 'Erro ao limpar conversas');
        }
    });

    // =====================
    // 10. CRIAR NOVO ARQUIVO (opcional)
    // =====================
    socket.on('criar_arquivo', (data) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('erro_criar', 'Não autenticado');
            return;
        }

        const filePath = path.join(dadosDir, data.nome);
        
        // Verificar se já existe
        if (fs.existsSync(filePath)) {
            socket.emit('erro_criar', 'Arquivo já existe');
            return;
        }
        
        fs.writeFile(filePath, data.conteudo || '', 'utf8', (err) => {
            if (err) {
                socket.emit('erro_criar', 'Erro ao criar arquivo');
                return;
            }
            
            socket.emit('arquivo_criado', { nome: data.nome });
        });
    });

    // =====================
    // 11. EXCLUIR ARQUIVO (opcional)
    // =====================
    socket.on('excluir_arquivo', (data) => {
        if (!usuariosLogados.has(socket.id)) {
            socket.emit('erro_excluir', 'Não autenticado');
            return;
        }

        const filePath = path.join(dadosDir, data.nome);
        
        // Não permitir excluir arquivos essenciais
        const arquivosProtegidos = ['treino.txt', 'usuarios.txt', 'prompts_log.txt', 'conversas.json'];
        if (arquivosProtegidos.includes(data.nome)) {
            socket.emit('erro_excluir', 'Este arquivo é protegido');
            return;
        }
        
        fs.unlink(filePath, (err) => {
            if (err) {
                socket.emit('erro_excluir', 'Erro ao excluir arquivo');
                return;
            }
            
            socket.emit('arquivo_excluido', { nome: data.nome });
        });
    });

    // =====================
    // DESCONEXÃO
    // =====================
    socket.on('disconnect', () => {
        usuariosLogados.delete(socket.id);
        console.log('🔌 Cliente desconectado:', socket.id);
    });
});

// =======================
// WHATSAPP CLIENT
// =======================
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Evento QR Code
client.on('qr', async qr => {
    console.log('📱 QR Code recebido');
    try {
        const img = await QRCode.toDataURL(qr);
        currentQR = img;
        
        // Enviar QR para todos logados
        usuariosLogados.forEach((usuario, socketId) => {
            io.to(socketId).emit('qr', img);
        });
    } catch (error) {
        console.error('❌ Erro ao gerar QR Code:', error);
    }
});

// Evento WhatsApp pronto
client.on('ready', () => {
    whatsappPronto = true;
    console.log('✅ WhatsApp conectado e pronto!');
    
    usuariosLogados.forEach((usuario, socketId) => {
        io.to(socketId).emit('ready');
    });
});

// Evento desconexão WhatsApp
client.on('disconnected', (reason) => {
    whatsappPronto = false;
    currentQR = null;
    console.log('❌ WhatsApp desconectado:', reason);
    
    // Notificar todos os usuários logados
    usuariosLogados.forEach((usuario, socketId) => {
        io.to(socketId).emit('disconnected');
    });
});

// =======================
// CAPTURA DE MENSAGENS
// =======================

// Capturar todas as mensagens recebidas
client.on('message', async msg => {
    console.log(`💬 Mensagem detectada de ${msg.from}: "${msg.body?.substring(0, 50) || '[sem texto]'}..."`);
    
    // Extrair número
    let numero = msg.from.replace(/\D/g, '');
    
    // Salvar mensagem do usuário
    if (!msg.fromMe) {
        salvarConversa(numero, msg.body || '[mídia]', 'usuario', 'recebida');
        
        // Tentar responder automaticamente
        try {
            const resposta = await gerarRespostaIA(msg.body);
            
            // Enviar resposta
            await msg.reply(resposta);
            console.log(`🤖 Resposta enviada para ${msg.from}`);
            
            // Salvar resposta do bot
            salvarConversa(numero, resposta, 'bot', 'enviada');
            
        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error.message);
            
            // Enviar mensagem de erro
            try {
                const erroMsg = 'Desculpe, estou com problemas técnicos. Tente novamente em alguns instantes.';
                await msg.reply(erroMsg);
                salvarConversa(numero, erroMsg, 'bot', 'enviada');
            } catch (e) {
                console.error('❌ Não foi possível enviar mensagem de erro:', e.message);
            }
        }
    } else {
        // Mensagem enviada pelo bot
        salvarConversa(numero, msg.body || '[mídia]', 'bot', 'enviada');
    }
});

// Capturar mensagens criadas
client.on('message_create', async (msg) => {
    if (msg.fromMe) {
        console.log(`📝 Mensagem criada pelo bot: ${msg.body?.substring(0, 50) || '[mídia]'}...`);
        
        // Extrair número do destinatário
        const numero = msg.to.replace(/\D/g, '');
        
        // Determinar conteúdo
        let conteudo = msg.body || '';
        if (!conteudo && msg.hasMedia) {
            conteudo = '[ARQUIVO DE MÍDIA]';
            if (msg.type === 'image') conteudo = '[IMAGEM]';
            if (msg.type === 'video') conteudo = '[VÍDEO]';
            if (msg.type === 'audio') conteudo = '[ÁUDIO]';
            if (msg.type === 'document') conteudo = '[DOCUMENTO]';
        }
        
        // Salvar mensagem enviada pelo bot
        salvarConversa(numero, conteudo, 'bot', 'enviada');
    }
});

// =======================
// INICIALIZAR WHATSAPP
// =======================
client.initialize().catch(error => {
    console.error('❌ Erro ao inicializar WhatsApp:', error);
});

// =======================
// AGENDADOR DE MENSAGENS
// =======================
setInterval(async () => {
    if (!whatsappPronto) {
        console.log('⏳ WhatsApp ainda não pronto para envios agendados');
        return;
    }

    try {
        const arquivos = fs.readdirSync(agendamentosDir);
        
        for (const arquivo of arquivos) {
            if (!arquivo.endsWith('.txt')) continue;
            
            const caminho = path.join(agendamentosDir, arquivo);
            const dados = fs.readFileSync(caminho, 'utf8');

            // Pular se já foi enviado
            if (dados.includes('status=enviado')) continue;

            // Extrair dados
            const map = {};
            dados.split('\n').forEach(l => {
                const idx = l.indexOf('=');
                if (idx > -1) {
                    const k = l.slice(0, idx).trim();
                    const v = l.slice(idx + 1).trim();
                    map[k] = v;
                }
            });

            // Verificar dados necessários
            if (!map.data || !map.hora || !map.numero || !map.mensagem) {
                console.log(`⚠️ Arquivo ${arquivo} com dados incompletos`);
                continue;
            }

            // Converter data/hora
            const [ano, mes, dia] = map.data.split('-').map(Number);
            const [hora, minuto] = map.hora.split(':').map(Number);
            const dataHoraEnvio = new Date(Date.UTC(
                ano,
                mes - 1,
                dia,
                hora + 3, // ajuste Brasil UTC-3
                minuto,
                0
            ));

            // Verificar se é hora de enviar
            if (new Date() >= dataHoraEnvio) {
                console.log(`⏰ Enviando mensagem agendada para ${map.numero}`);
                
                try {
                    const numberId = await client.getNumberId(map.numero);
                    if (!numberId) {
                        console.log(`❌ Número ${map.numero} não encontrado no WhatsApp`);
                        continue;
                    }

                    await client.sendMessage(numberId._serialized, map.mensagem);
                    
                    // Atualizar status
                    const novoConteudo = dados.replace('status=pendente', 'status=enviado');
                    fs.writeFileSync(caminho, novoConteudo);
                    
                    console.log(`✅ Mensagem enviada para ${map.numero}`);
                } catch (err) {
                    console.error(`❌ Falha no envio para ${map.numero}:`, err.message);
                }
            }
        }
    } catch (error) {
        console.error('❌ Erro no agendador:', error.message);
    }
}, 30000); // 30 segundos

// =======================
// IA (GPT-4o-mini)
// =======================
async function gerarRespostaIA(mensagem) {
    try {
        // Ler treino atual
        let treino = '';
        if (fs.existsSync(treinoFile)) {
            treino = fs.readFileSync(treinoFile, 'utf8');
        }

        // Preparar mensagem para o GPT-4o-mini
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: treino + "\n\nVocê é um assistente útil chamado SalvoRadaBot. Seja amigável e direto nas respostas." 
                },
                { role: "user", content: mensagem }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('❌ Erro na IA (GPT-4o-mini):', error.message);
        
        if (error.code === 'insufficient_quota') {
            return 'Desculpe, minha cota de API está esgotada no momento. Entre em contato com o administrador.';
        } else if (error.code === 'rate_limit_exceeded') {
            return 'Estou recebendo muitas solicitações. Por favor, aguarde um momento e tente novamente.';
        } else {
            return 'Desculpe, estou tendo problemas técnicos no momento. Tente novamente mais tarde.';
        }
    }
}

// =======================
// SERVIDOR
// =======================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🤖 Modelo de IA: GPT-4o-mini`);
    console.log(`📁 Dados em: ${dadosDir}`);
    console.log(`💾 Conversas em: ${conversasFile}`);
    console.log(`📆 Agendamentos em: ${agendamentosDir}`);
    console.log(`🔐 Login padrão: admin / admin123`);
    console.log('='.repeat(50));
    console.log('✅ Sistema pronto! Acesse: http://localhost:' + PORT);
});