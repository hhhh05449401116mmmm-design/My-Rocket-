const express = require('express');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 8080;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json());

let roundId = 0;
let currentMultiplier = 1.00;
let gameState = 'COUNTDOWN';
let countdownSeconds = 5;

const clients = new Set();

let history = [1.24, 2.15, 6.40, 11.86, 27.50];

function send(client, data) {
    try {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
        clients.delete(client);
    }
}

function getState(type = gameState) {
    return {
        type,
        phase: gameState,
        roundId,
        seconds: countdownSeconds,
        multiplier: Number(currentMultiplier.toFixed(4)),
        history,
        serverTime: Date.now()
    };
}

function broadcast(type = gameState) {
    for (const client of clients) {
        send(client, getState(type));
    }
}

app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'Epic Gift Rocket Multiplayer',
        gameState,
        roundId,
        multiplier: currentMultiplier
    });
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        gameState,
        roundId,
        multiplier: currentMultiplier,
        clients: clients.size
    });
});

app.get('/api/game-stream', (req, res) => {
    res.status(200);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (res.flushHeaders) {
        res.flushHeaders();
    }

    clients.add(res);

    send(res, getState('SYNC'));

    req.on('close', () => {
        clients.delete(res);
    });
});

setInterval(() => {
    for (const client of clients) {
        try {
            client.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
            clients.delete(client);
        }
    }
}, 15000);

function generateCrashPoint() {
    const r = Math.random();

    if (r < 0.70) {
        return Number((1.01 + Math.random() * 0.78).toFixed(2));
    }

    if (r < 0.99) {
        return Number((1.80 + Math.random() * 8.20).toFixed(2));
    }

    return Number((10.00 + Math.random() * 25.00).toFixed(2));
}

function runCountdown() {
    roundId++;

    gameState = 'COUNTDOWN';
    countdownSeconds = 5;
    currentMultiplier = 1.00;

    broadcast('COUNTDOWN');

    const timer = setInterval(() => {
        countdownSeconds--;

        if (countdownSeconds > 0) {
            broadcast('COUNTDOWN');
            return;
        }

        clearInterval(timer);
        startFlight();
    }, 1000);
}

function startFlight() {
    gameState = 'FLIGHT';
    currentMultiplier = 1.00;

    const crashPoint = generateCrashPoint();
    const startedAt = Date.now();

    broadcast('FLIGHT');

    const timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;

        currentMultiplier = Number(
            Math.exp(elapsed * 0.16).toFixed(4)
        );

        if (currentMultiplier >= crashPoint) {
            clearInterval(timer);

            currentMultiplier = crashPoint;
            gameState = 'CRASH';

            history.unshift(crashPoint);

            if (history.length > 5) {
                history = history.slice(0, 5);
            }

            broadcast('CRASH');

            setTimeout(() => {
                runCountdown();
            }, 3500);

            return;
        }

        broadcast('FLIGHT');

    }, 50);
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Rocket Server running on port ${PORT}`);
    console.log(`🌐 Port: ${PORT}`);

    runCountdown();
});
