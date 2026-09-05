const express = require('express');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 8080;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json());

/*
==================================================
GAME STATE
==================================================
*/

let roundId = 0;
let currentMultiplier = 1.00;
let gameState = 'COUNTDOWN';
let countdownSeconds = 5;

const clients = new Set();

let history = [1.24, 2.15, 6.40, 11.86, 27.50];

/*
==================================================
PLAYERS / BETS
==================================================
*/

const players = new Map();

/*
player structure:

{
    telegramId,
    name,
    avatar,

    balance,

    currentBet: {
        roundId,
        amount,
        autoCashout,
        autoTarget,
        status
    }
}
*/

/*
==================================================
HELPERS
==================================================
*/

function send(client, data) {
    try {
        client.write(
            `data: ${JSON.stringify(data)}\n\n`
        );
    } catch {
        clients.delete(client);
    }
}

function getPublicPlayers() {

    const result = [];

    for (const player of players.values()) {

        if (!player.currentBet) {
            continue;
        }

        if (
            player.currentBet.roundId !== roundId
        ) {
            continue;
        }

        result.push({
            telegramId: player.telegramId,
            name: player.name,
            avatar: player.avatar || '',
            amount: Number(
                player.currentBet.amount.toFixed(4)
            ),
            status: player.currentBet.status,
            multiplier:
                player.currentBet.status === 'CASHED_OUT'
                    ? player.currentBet.cashoutMultiplier
                    : null
        });
    }

    return result;
}

function getSelfState(telegramId) {

    const player = players.get(
        String(telegramId)
    );

    if (!player || !player.currentBet) {
        return {
            state: 'none'
        };
    }

    const bet = player.currentBet;

    if (bet.roundId !== roundId) {
        return {
            state: 'none'
        };
    }

    if (bet.status === 'ACTIVE') {
        return {
            state: 'active',
            amount: bet.amount,
            roundId: bet.roundId,
            autoCashout: bet.autoCashout,
            autoTarget: bet.autoTarget
        };
    }

    if (bet.status === 'CASHED_OUT') {
        return {
            state: 'win',
            amount: bet.amount,
            payout: bet.payout,
            multiplier: bet.cashoutMultiplier,
            roundId: bet.roundId
        };
    }

    if (bet.status === 'LOST') {
        return {
            state: 'lose',
            amount: bet.amount,
            roundId: bet.roundId
        };
    }

    return {
        state: 'none'
    };
}

function getState(type = gameState, telegramId = null) {

    return {
        type,
        phase: gameState,

        roundId,

        seconds: countdownSeconds,

        multiplier:
            Number(
                currentMultiplier.toFixed(4)
            ),

        history,

        players:
            getPublicPlayers(),

        self:
            telegramId
                ? getSelfState(telegramId)
                : null,

        serverTime: Date.now()
    };
}

function broadcast(
    type = gameState
) {

    for (const client of clients) {

        send(
            client,
            getState(
                type,
                client.telegramId
            )
        );
    }
}

function broadcastPlayers() {

    for (const client of clients) {

        send(
            client,
            {
                type: 'PLAYERS',
                players: getPublicPlayers(),
                self: getSelfState(
                    client.telegramId
                ),
                serverTime: Date.now()
            }
        );
    }
}

function sendBalance(client) {

    const player =
        players.get(
            String(client.telegramId)
        );

    if (!player) {
        return;
    }

    send(client, {
        type: 'BALANCE',

        /*
        Temporary internal balance.
        This is NOT blockchain money.
        */

        balance:
            Number(
                player.balance.toFixed(4)
            ),

        serverTime: Date.now()
    });
}

/*
==================================================
HOME
==================================================
*/

app.get('/', (req, res) => {

    res.json({
        ok: true,
        service:
            'Epic Gift Rocket Multiplayer',

        gameState,

        roundId,

        multiplier:
            currentMultiplier,

        players:
            players.size
    });
});

/*
==================================================
HEALTH
==================================================
*/

app.get('/health', (req, res) => {

    res.json({
        ok: true,

        gameState,

        roundId,

        multiplier:
            currentMultiplier,

        clients:
            clients.size,

        players:
            players.size
    });
});

/*
==================================================
GAME STREAM
==================================================
*/

app.get(
    '/api/game-stream',
    (req, res) => {

        const telegramId =
            String(
                req.query.telegramId ||
                'guest'
            );

        const name =
            String(
                req.query.name ||
                'اللاعب'
            );

        const avatar =
            String(
                req.query.avatar ||
                ''
            );

        res.status(200);

        res.setHeader(
            'Content-Type',
            'text/event-stream'
        );

        res.setHeader(
            'Cache-Control',
            'no-cache, no-transform'
        );

        res.setHeader(
            'Connection',
            'keep-alive'
        );

        res.setHeader(
            'X-Accel-Buffering',
            'no'
        );

        if (res.flushHeaders) {
            res.flushHeaders();
        }

        /*
        Create player if necessary
        */

        if (!players.has(telegramId)) {

            players.set(
                telegramId,
                {
                    telegramId,

                    name,

                    avatar,

                    /*
                    Temporary testing balance.
                    We will remove this when
                    real Supabase balance is enabled.
                    */

                    balance: 126.04,

                    currentBet: null
                }
            );

        } else {

            const player =
                players.get(
                    telegramId
                );

            player.name = name || player.name;
            player.avatar = avatar || player.avatar;
        }

        /*
        Attach telegramId to SSE client
        */

        res.telegramId = telegramId;

        clients.add(res);

        send(
            res,
            getState(
                'SYNC',
                telegramId
            )
        );

        sendBalance(res);

        req.on(
            'close',
            () => {
                clients.delete(res);
            }
        );
    }
);

/*
==================================================
GAME ACTION
==================================================
*/

app.post(
    '/api/game-action',
    (req, res) => {

        try {

            const {
                type,
                telegramId,
                name,
                avatar,
                amount,
                roundId: requestedRoundId,
                autoCashout,
                autoTarget
            } = req.body || {};

            const id =
                String(
                    telegramId || ''
                );

            if (!id) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'telegramId is required'
                });

            }

            /*
            Create player if not already connected
            */

            if (!players.has(id)) {

                players.set(
                    id,
                    {
                        telegramId: id,

                        name:
                            name ||
                            'اللاعب',

                        avatar:
                            avatar ||
                            '',

                        balance: 126.04,

                        currentBet: null
                    }
                );

            }

            const player =
                players.get(id);

            if (name) {
                player.name = name;
            }

            if (avatar) {
                player.avatar = avatar;
            }

            /*
            ======================================
            BET
            ======================================
            */

            if (type === 'BET') {

                if (
                    gameState !==
                    'COUNTDOWN'
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'Betting is closed for this round'
                    });

                }

                if (
                    Number(
                        requestedRoundId
                    ) !== roundId
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'Round has changed'
                    });

                }

                const betAmount =
                    Number(amount);

                if (
                    !Number.isFinite(
                        betAmount
                    ) ||
                    betAmount <= 0
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'Invalid bet amount'
                    });

                }

                if (
                    player.currentBet &&
                    player.currentBet.roundId === roundId &&
                    (
                        player.currentBet.status === 'ACTIVE' ||
                        player.currentBet.status === 'CASHED_OUT'
                    )
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'You already have a bet this round'
                    });

                }

                if (
                    betAmount >
                    player.balance
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'Insufficient balance'
                    });

                }

                /*
                Deduct temporary balance
                */

                player.balance =
                    Number(
                        (
                            player.balance -
                            betAmount
                        ).toFixed(4)
                    );

                player.currentBet = {

                    roundId,

                    amount:
                        betAmount,

                    autoCashout:
                        Boolean(
                            autoCashout
                        ),

                    autoTarget:
                        Number(
                            autoTarget
                        ) || null,

                    status:
                        'ACTIVE',

                    payout: 0,

                    cashoutMultiplier: null
                };

                broadcastPlayers();

                /*
                Update the bettor's balance
                */

                for (const client of clients) {

                    if (
                        String(
                            client.telegramId
                        ) === id
                    ) {

                        sendBalance(client);
                    }
                }

                return res.json({
                    ok: true,

                    action: 'BET',

                    roundId,

                    amount: betAmount,

                    balance:
                        player.balance
                });
            }

            /*
            ======================================
            CASHOUT
            ======================================
            */

            if (type === 'CASHOUT') {

                if (
                    gameState !==
                    'FLIGHT'
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'Cashout is not available'
                    });

                }

                if (
                    Number(
                        requestedRoundId
                    ) !== roundId
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'Round has changed'
                    });

                }

                const bet =
                    player.currentBet;

                if (
                    !bet ||
                    bet.roundId !== roundId ||
                    bet.status !== 'ACTIVE'
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'No active bet'
                    });

                }

                const cashoutMultiplier =
                    Number(
                        currentMultiplier.toFixed(4)
                    );

                const payout =
                    Number(
                        (
                            bet.amount *
                            cashoutMultiplier
                        ).toFixed(4)
                    );

                player.balance =
                    Number(
                        (
                            player.balance +
                            payout
                        ).toFixed(4)
                    );

                bet.status =
                    'CASHED_OUT';

                bet.cashoutMultiplier =
                    cashoutMultiplier;

                bet.payout =
                    payout;

                broadcastPlayers();

                for (const client of clients) {

                    if (
                        String(
                            client.telegramId
                        ) === id
                    ) {

                        sendBalance(client);
                    }
                }

                return res.json({
                    ok: true,

                    action: 'CASHOUT',

                    roundId,

                    multiplier:
                        cashoutMultiplier,

                    payout,

                    balance:
                        player.balance
                });
            }

            return res.status(400).json({
                ok: false,
                error:
                    'Unknown action'
            });

        } catch (error) {

            console.error(
                'GAME ACTION ERROR:',
                error
            );

            return res.status(500).json({
                ok: false,
                error:
                    'Internal server error'
            });
        }
    }
);

/*
==================================================
HEARTBEAT
==================================================
*/

setInterval(() => {

    for (const client of clients) {

        try {

            client.write(
                `: heartbeat ${Date.now()}\n\n`
            );

        } catch {

            clients.delete(client);
        }
    }

}, 15000);

/*
==================================================
CRASH POINT
==================================================
*/

/*
DEMO ONLY.
Do NOT use this distribution for real money.
*/

function generateCrashPoint() {

    const r =
        Math.random();

    if (r < 0.70) {

        return Number(
            (
                1.01 +
                Math.random() *
                0.78
            ).toFixed(2)
        );
    }

    if (r < 0.99) {

        return Number(
            (
                1.80 +
                Math.random() *
                8.20
            ).toFixed(2)
        );
    }

    return Number(
        (
            10.00 +
            Math.random() *
            25.00
        ).toFixed(2)
    );
}

/*
==================================================
COUNTDOWN
==================================================
*/

function runCountdown() {

    roundId++;

    gameState =
        'COUNTDOWN';

    countdownSeconds = 5;

    currentMultiplier =
        1.00;

    /*
    Clear old round bets.
    Bets from previous round remain
    recorded in memory but are no
    longer active.
    */

    for (const player of players.values()) {

        if (
            player.currentBet &&
            player.currentBet.roundId !== roundId
        ) {

            player.currentBet = null;
        }
    }

    broadcast(
        'COUNTDOWN'
    );

    const timer =
        setInterval(
            () => {

                countdownSeconds--;

                if (
                    countdownSeconds > 0
                ) {

                    broadcast(
                        'COUNTDOWN'
                    );

                    return;
                }

                clearInterval(timer);

                startFlight();

            },
            1000
        );
}

/*
==================================================
FLIGHT
==================================================
*/

function startFlight() {

    gameState =
        'FLIGHT';

    currentMultiplier =
        1.00;

    const crashPoint =
        generateCrashPoint();

    const startedAt =
        Date.now();

    broadcast(
        'FLIGHT'
    );

    const timer =
        setInterval(
            () => {

                const elapsed =
                    (
                        Date.now() -
                        startedAt
                    ) / 1000;

                currentMultiplier =
                    Number(
                        Math.exp(
                            elapsed *
                            0.16
                        ).toFixed(4)
                    );

                /*
                ==================================
                AUTO CASHOUT
                ==================================
                */

                for (
                    const player
                    of players.values()
                ) {

                    const bet =
                        player.currentBet;

                    if (
                        !bet ||
                        bet.roundId !== roundId ||
                        bet.status !== 'ACTIVE'
                    ) {

                        continue;
                    }

                    if (
                        bet.autoCashout &&
                        Number.isFinite(
                            bet.autoTarget
                        ) &&
                        currentMultiplier >=
                        bet.autoTarget
                    ) {

                        const multiplier =
                            Number(
                                bet.autoTarget.toFixed(4)
                            );

                        const payout =
                            Number(
                                (
                                    bet.amount *
                                    multiplier
                                ).toFixed(4)
                            );

                        player.balance =
                            Number(
                                (
                                    player.balance +
                                    payout
                                ).toFixed(4)
                            );

                        bet.status =
                            'CASHED_OUT';

                        bet.cashoutMultiplier =
                            multiplier;

                        bet.payout =
                            payout;
                    }
                }

                if (
                    currentMultiplier >=
                    crashPoint
                ) {

                    clearInterval(timer);

                    currentMultiplier =
                        crashPoint;

                    gameState =
                        'CRASH';

                    /*
                    Lose all remaining active bets
                    */

                    for (
                        const player
                        of players.values()
                    ) {

                        const bet =
                            player.currentBet;

                        if (
                            bet &&
                            bet.roundId === roundId &&
                            bet.status === 'ACTIVE'
                        ) {

                            bet.status =
                                'LOST';
                        }
                    }

                    history.unshift(
                        crashPoint
                    );

                    if (
                        history.length > 5
                    ) {

                        history =
                            history.slice(
                                0,
                                5
                            );
                    }

                    broadcast(
                        'CRASH'
                    );

                    broadcastPlayers();

                    for (
                        const client
                        of clients
                    ) {

                        sendBalance(client);
                    }

                    setTimeout(
                        () => {
                            runCountdown();
                        },
                        3500
                    );

                    return;
                }

                broadcast(
                    'FLIGHT'
                );

            },
            50
        );
}

/*
==================================================
START SERVER
==================================================
*/

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `🚀 Rocket Server running on port ${PORT}`
        );

        console.log(
            `🌐 Port: ${PORT}`
        );

        runCountdown();
    }
);
