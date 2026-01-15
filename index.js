require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');

/* ======================= */
/* VERIFICAÇÃO API KEY     */
/* ======================= */
if (!process.env.GPT_API_KEY) {
    console.error('❌ ERRO: GPT_API_KEY não encontrada no .env');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: process.env.GPT_API_KEY,
    timeout: 30000
});

/* ======================= */
/* CONFIGURAÇÃO DE PASTAS  */
/* ======================= */
const dadosDir = path.join(__dirname, 'dados');
const publicDir = path.join(__dirname, 'public');
const agendamentosDir = path.join(__dirname, 'mensagens_agendadas');

[dadosDir, publicDir, agendamentosDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ======================= */
/* ARQUIVOS ESSENCIAIS     */
/* ======================= */
const conversasFile = path.join(dadosDir, 'conversas.json');
const treinoFile = path.join(dadosDir, 'treino.txt');
const usuariosFile = path.join(dadosDir, 'usuarios.txt');
const promptsLogFile = path.join(dadosDir, 'prompts_log.txt');

if (!fs.existsSync(conversasFile)) fs.writeFileSync(conversasFile, '[]');
if (!fs.existsSync(treinoFile)) fs.writeFileSync(treinoFile, 'Você é um assistente útil chamado SalvoRadaBot.\n');
if (!fs.existsSync(usuariosFile)) fs.writeFileSync(usuariosFile, 'admin|admin123\n');
if (!fs.existsSync(promptsLogFile)) fs.writeFileSync(promptsLogFile, '=== LOG DE PROMPTS ===\n');

/* ======================= */
/* EXPRESS + SOCKET.IO     */
/* ======================= */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.json());
app.use(express.static('public'));

/* ======================= */
/* SOCKET / LOGIN          */
/* ======================= */
const usuariosLogados = new Map();
let currentQR = null;
let whatsappPronto = false;

/* ======================= */
/* WHATSAPP CLIENT (FIX)   */
/* ======================= */
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
        executablePath: puppeteer.executablePath(), // 🔥 FIX DEFINITIVO
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

/* ======================= */
/* EVENTOS WHATSAPP        */
/* ======================= */
client.on('qr', async qr => {
    const img = await QRCode.toDataURL(qr);
    currentQR = img;
    usuariosLogados.forEach((_, socketId) => io.to(socketId).emit('qr', img));
});

client.on('ready', () => {
    whatsappPronto = true;
    console.log('✅ WhatsApp conectado');
    usuariosLogados.forEach((_, socketId) => io.to(socketId).emit('ready'));
});

client.on('disconnected', () => {
    whatsappPronto = false;
    currentQR = null;
});

/* ======================= */
/* INICIALIZAÇÃO           */
/* ======================= */
client.initialize().catch(err => {
    console.error('❌ Erro ao inicializar WhatsApp:', err);
});

/* ======================= */
/* SERVIDOR                */
/* ======================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
