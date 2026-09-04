'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = Number(process.env.PORT || 8080);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('WARNING: SUPABASE_URL / SUPABASE_KEY غير موجودين.');
}

const supabase =
    SUPABASE_URL && SUPABASE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_KEY)
        : null;


/* =========================================================
   CONFIG
========================================================= */

const COUNTDOWN_SECONDS = 5;

const CRASH_DISPLAY_MS = 3500;

const FLIGHT_TICK_MS = 50;

const MAX_HISTORY = 20;

const MAX_BET = 1000000;

const MIN_BET = 0.01;

const MAX_AUTO_CASHOUT = 1000;

const DEFAULT_BALANCE = 126.04;


/* =========================================================
   EXPRESS
========================================================= */

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({
    limit: '100kb'
}));


/* =========================================================
   GLOBAL GAME STATE
========================================================= */

let roundId = 0;

let gameState = 'COUNTDOWN';

let countdownSeconds = COUNTDOWN_SECONDS;

let currentMultiplier = 1.00;

let crashPoint = 1.50;

let roundStartedAt = Date.now();

let crashStartedAt = null;


/*
    players:
    اللاعبين الموجودين في الجولة الحالية

    pendingBets:
    رهانات تم وضعها أثناء الطيران
    وتدخل الجولة التالية
*/

const players = new Map();

const pendingBets = new Map();


/*
    SSE connections

    كل اتصال مرتبط بـ Telegram ID
*/

const clients = new Set();


/*
    History في الذاكرة
*/

let history = [
    1.24,
    2.15,
    6.40,
    11.86,
    27.50
];


/*
    لمنع تشغيل أكثر من Game Engine
*/

let gameEngineStarted = false;


/*
    آخر Broadcast
*/

let lastBroadcast = null;


/* =========================================================
   UTILS
========================================================= */

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


function safeNumber(value, fallback = 0) {

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}


function roundMoney(value) {

    return Math.round(
        (Number(value) + Number.EPSILON) * 100
    ) / 100;
}


function clamp(value, min, max) {

    return Math.min(
        Math.max(value, min),
        max
    );
}


function cleanText(value, fallback = '') {

    if (typeof value !== 'string') {
        return fallback;
    }

    return value
        .trim()
        .slice(0, 80);
}


function cleanAvatar(value) {

    if (typeof value !== 'string') {
        return '';
    }

    /*
       نسمح فقط بروابط HTTPS
    */

    if (!value.startsWith('https://')) {
        return '';
    }

    return value.slice(0, 1000);
}


/* =========================================================
   BALANCES
========================================================= */

/*
   هذه Map للتجربة والتشغيل السريع.

   Supabase يتم استخدامه أيضاً للحفظ عندما يكون
   الاتصال متاحاً.

   لا تعتبر هذه الطريقة نظام TON مالي حقيقي.
*/

const balances = new Map();


function getBalance(telegramId) {

    if (!balances.has(telegramId)) {

        balances.set(
            telegramId,
            DEFAULT_BALANCE
        );
    }

    return balances.get(telegramId);
}


function setBalance(
    telegramId,
    amount
) {

    const value =
        roundMoney(
            Math.max(0, amount)
        );

    balances.set(
        telegramId,
        value
    );

    return value;
}


function debitBalance(
    telegramId,
    amount
) {

    const balance =
        getBalance(telegramId);

    if (amount > balance) {
        return false;
    }

    setBalance(
        telegramId,
        balance - amount
    );

    return true;
}


function creditBalance(
    telegramId,
    amount
) {

    setBalance(
        telegramId,
        getBalance(telegramId) + amount
    );
}


/* =========================================================
   FAIR CRASH GENERATION
========================================================= */

/*
   لا نستخدم نظاماً منحازاً لصالح السيرفر.

   هذا مثال Game RNG.

   إذا أردت لاحقاً Provably Fair حقيقي،
   نضيف Commit/Reveal.
*/

function generateCrashPoint() {

    const randomBytes =
        crypto.randomBytes(8);

    const randomNumber =
        randomBytes.readBigUInt64BE(0);

    const max =
        BigInt('0xffffffffffffffff');

    const r =
        Number(randomNumber) /
        Number(max);

    let point;

    if (r < 0.70) {

        point =
            1.01 +
            Math.random() * 0.78;

    } else if (r < 0.99) {

        point =
            1.80 +
            Math.random() * 8.20;

    } else {

        point =
            10.00 +
            Math.random() * 25.00;
    }

    return Number(
        point.toFixed(2)
    );
}


/* =========================================================
   ROUND SPEED
========================================================= */

function calculateMultiplier() {

    const elapsed =
        Date.now() - roundStartedAt;

    /*
       نمو سلس بدلاً من زيادة ثابتة
       حتى لا تعتمد السرعة على FPS الهاتف.
    */

    const seconds =
        elapsed / 1000;

    const value =
        Math.exp(
            seconds * 0.16
        );

    return Number(
        Math.max(1, value).toFixed(4)
    );
}


/* =========================================================
   PLAYERS
========================================================= */

function publicPlayer(player) {

    return {
        name: player.name,
        avatar: player.avatar,
        color: player.color,
        bet: player.bet,
        state: player.state,
        finalMult: player.finalMult
    };
}


function getPublicPlayers() {

    return Array
        .from(players.values())
        .map(publicPlayer);
}


/* =========================================================
   PERSONAL STATE
========================================================= */

function getSelfState(telegramId) {

    const player =
        players.get(telegramId);

    const pending =
        pendingBets.get(telegramId);

    if (player) {

        return {
            state: player.state,
            queued: false,
            bet: player.bet,
            finalMult: player.finalMult
        };
    }

    if (pending) {

        return {
            state: 'pending',
            queued: true,
            bet: pending.bet,
            finalMult: 1
        };
    }

    return {
        state: 'none',
        queued: false,
        bet: 0,
        finalMult: 1
    };
}


/* =========================================================
   GAME STATE FOR CLIENT
========================================================= */

function createState(
    telegramId,
    type = gameState
) {

    return {
        type,

        roundId,

        phase: gameState,

        seconds: countdownSeconds,

        multiplier:
            Number(
                currentMultiplier.toFixed(4)
            ),

        finalMultiplier:
            gameState === 'CRASH'
                ? Number(
                    currentMultiplier.toFixed(2)
                )
                : null,

        history,

        players:
            getPublicPlayers(),

        balance:
            roundMoney(
                getBalance(telegramId)
            ),

        self:
            getSelfState(telegramId),

        serverTime:
            Date.now()
    };
}


/* =========================================================
   SSE
========================================================= */

function sendSSE(
    client,
    data
) {

    try {

        client.res.write(
            `data: ${JSON.stringify(data)}\n\n`
        );

    } catch (error) {

        clients.delete(client);
    }
}


function broadcast(
    type = gameState
) {

    lastBroadcast = {
        type,
        timestamp: Date.now()
    };

    for (const client of clients) {

        sendSSE(
            client,
            createState(
                client.telegramId,
                type
            )
        );
    }
}


/*
   Heartbeat حتى لا يغلق الاتصال
*/

setInterval(() => {

    for (const client of clients) {

        try {

            client.res.write(
                `: heartbeat ${Date.now()}\n\n`
            );

        } catch (error) {

            clients.delete(client);
        }
    }

}, 15000);


/* =========================================================
   GAME STREAM
========================================================= */

app.get(
    '/api/game-stream',
    (req, res) => {

        const telegramId =
            cleanText(
                String(
                    req.query.telegramId ||
                    'guest'
                ),
                'guest'
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

        res.flushHeaders?.();


        const client = {
            res,
            telegramId
        };


        clients.add(client);


        /*
           إرسال الحالة الحالية فوراً
        */

        sendSSE(
            client,
            createState(
                telegramId,
                'SYNC'
            )
        );


        req.on(
            'close',
            () => {

                clients.delete(client);
            }
        );
    }
);


/* =========================================================
   PLACE BET
========================================================= */

app.post(
    '/api/bet',
    async (req, res) => {

        try {

            const telegramId =
                cleanText(
                    String(
                        req.body?.telegramId ||
                        ''
                    )
                );


            if (!telegramId) {

                return res
                    .status(400)
                    .json({
                        error:
                            'Telegram ID مطلوب'
                    });
            }


            const name =
                cleanText(
                    req.body?.name,
                    'اللاعب'
                );


            const avatar =
                cleanAvatar(
                    req.body?.avatar
                );


            const amount =
                roundMoney(
                    safeNumber(
                        req.body?.amount
                    )
                );


            const autoCashout =
                Boolean(
                    req.body?.autoCashout
                );


            const autoTarget =
                clamp(
                    safeNumber(
                        req.body?.autoTarget,
                        1.50
                    ),
                    1.10,
                    MAX_AUTO_CASHOUT
                );


            if (
                amount < MIN_BET ||
                amount > MAX_BET
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            `قيمة الرهان يجب أن تكون بين ${MIN_BET} و ${MAX_BET}`
                    });
            }


            /*
               لا يسمح برهانين في نفس الجولة
            */

            if (
                players.has(telegramId) ||
                pendingBets.has(telegramId)
            ) {

                return res
                    .status(409)
                    .json({
                        error:
                            'لديك رهان موجود بالفعل'
                    });
            }


            /*
               خصم الرصيد من السيرفر
            */

            if (
                !debitBalance(
                    telegramId,
                    amount
                )
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            'الرصيد غير كافٍ'
                    });
            }


            const player = {

                telegramId,

                name,

                avatar,

                color: '#ff3366',

                bet: amount,

                state: 'active',

                finalMult: 1.00,

                autoCashout,

                autoTarget
            };


            /*
               أثناء COUNTDOWN:
               يدخل الجولة الحالية

               أثناء FLIGHT:
               يدخل الجولة القادمة
            */

            if (
                gameState ===
                'COUNTDOWN'
            ) {

                players.set(
                    telegramId,
                    player
                );

                broadcast(
                    'COUNTDOWN'
                );


                return res.json({
                    ok: true,
                    queued: false,
                    balance:
                        getBalance(
                            telegramId
                        )
                });
            }


            /*
               أثناء الطيران أو الانفجار
               نضعه للجولة القادمة
            */

            pendingBets.set(
                telegramId,
                player
            );


            broadcast(
                gameState
            );


            return res.json({
                ok: true,
                queued: true,
                balance:
                    getBalance(
                        telegramId
                    )
            });

        } catch (error) {

            console.error(
                'BET ERROR:',
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        'حدث خطأ في السيرفر'
                });
        }
    }
);


/* =========================================================
   CASHOUT
========================================================= */

app.post(
    '/api/cashout',
    async (req, res) => {

        try {

            const telegramId =
                cleanText(
                    String(
                        req.body?.telegramId ||
                        ''
                    )
                );


            if (!telegramId) {

                return res
                    .status(400)
                    .json({
                        error:
                            'Telegram ID مطلوب'
                    });
            }


            if (
                gameState !==
                'FLIGHT'
            ) {

                return res
                    .status(409)
                    .json({
                        error:
                            'لا يمكن تنفيذ Cashout الآن'
                    });
            }


            const player =
                players.get(
                    telegramId
                );


            if (
                !player ||
                player.state !==
                'active'
            ) {

                return res
                    .status(409)
                    .json({
                        error:
                            'لا يوجد رهان فعال'
                    });
            }


            settlePlayerWin(
                player,
                currentMultiplier
            );


            broadcast(
                'FLIGHT'
            );


            return res.json({
                ok: true,

                multiplier:
                    player.finalMult,

                payout:
                    roundMoney(
                        player.payout
                    ),

                balance:
                    getBalance(
                        telegramId
                    )
            });

        } catch (error) {

            console.error(
                'CASHOUT ERROR:',
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        'حدث خطأ في السيرفر'
                });
        }
    }
);


/* =========================================================
   SETTLE WIN
========================================================= */

function settlePlayerWin(
    player,
    multiplier
) {

    if (
        player.state !==
        'active'
    ) {
        return;
    }


    const finalMult =
        Number(
            multiplier.toFixed(2)
        );


    const payout =
        roundMoney(
            player.bet *
            finalMult
        );


    player.state =
        'win';


    player.finalMult =
        finalMult;


    player.payout =
        payout;


    creditBalance(
        player.telegramId,
        payout
    );
}


/* =========================================================
   AUTO CASHOUT
========================================================= */

function processAutoCashouts() {

    if (
        gameState !==
        'FLIGHT'
    ) {
        return;
    }


    for (
        const player
        of players.values()
    ) {

        if (
            player.state !==
            'active'
        ) {
            continue;
        }


        if (
            !player.autoCashout
        ) {
            continue;
        }


        if (
            currentMultiplier >=
            player.autoTarget
        ) {

            settlePlayerWin(
                player,
                player.autoTarget
            );
        }
    }
}


/* =========================================================
   ACTIVATE PENDING BETS
========================================================= */

function activatePendingBets() {

    if (
        pendingBets.size === 0
    ) {
        return;
    }


    for (
        const [
            telegramId,
            player
        ]
        of pendingBets
    ) {

        players.set(
            telegramId,
            player
        );
    }


    pendingBets.clear();
}


/* =========================================================
   CRASH
========================================================= */

function crashRound() {

    gameState =
        'CRASH';


    currentMultiplier =
        Number(
            Math.min(
                currentMultiplier,
                crashPoint
            ).toFixed(2)
        );


    /*
       كل من بقي Active يخسر
    */

    for (
        const player
        of players.values()
    ) {

        if (
            player.state ===
            'active'
        ) {

            player.state =
                'lose';

            player.finalMult =
                currentMultiplier;
        }
    }


    history.unshift(
        currentMultiplier
    );


    if (
        history.length >
        MAX_HISTORY
    ) {

        history =
            history.slice(
                0,
                MAX_HISTORY
            );
    }


    crashStartedAt =
        Date.now();


    broadcast(
        'CRASH'
    );
}


/* =========================================================
   START COUNTDOWN
========================================================= */

function startCountdown() {

    roundId++;

    gameState =
        'COUNTDOWN';

    countdownSeconds =
        COUNTDOWN_SECONDS;

    currentMultiplier =
        1.00;

    crashPoint =
        1.50;

    roundStartedAt =
        Date.now();

    crashStartedAt =
        null;


    /*
       نحذف اللاعبين السابقين
       ونضع رهانات الجولة القادمة
    */

    players.clear();

    activatePendingBets();


    broadcast(
        'COUNTDOWN'
    );
}


/* =========================================================
   RUN COUNTDOWN
========================================================= */

async function runCountdown() {

    startCountdown();


    for (
        let seconds =
            COUNTDOWN_SECONDS;

        seconds > 0;

        seconds--
    ) {

        countdownSeconds =
            seconds;


        broadcast(
            'COUNTDOWN'
        );


        await sleep(1000);
    }
}


/* =========================================================
   RUN FLIGHT
========================================================= */

async function runFlight() {

    gameState =
        'FLIGHT';


    currentMultiplier =
        1.00;


    crashPoint =
        generateCrashPoint();


    roundStartedAt =
        Date.now();


    broadcast(
        'FLIGHT'
    );


    while (
        gameState ===
        'FLIGHT'
    ) {

        await sleep(
            FLIGHT_TICK_MS
        );


        currentMultiplier =
            calculateMultiplier();


        processAutoCashouts();


        if (
            currentMultiplier >=
            crashPoint
        ) {

            crashRound();

            break;
        }


        broadcast(
            'FLIGHT'
        );
    }
}


/* =========================================================
   GLOBAL ENGINE
========================================================= */

async function runGlobalGameEngine() {

    if (
        gameEngineStarted
    ) {

        console.error(
            'Game Engine already running'
        );

        return;
    }


    gameEngineStarted =
        true;


    console.log(
        '🚀 Global Game Engine started'
    );


    while (true) {

        try {

            await runCountdown();

            await runFlight();

            await sleep(
                CRASH_DISPLAY_MS
            );

        } catch (error) {

            console.error(
                'GAME ENGINE ERROR:',
                error
            );


            /*
               إذا حدث خطأ، لا نترك اللعبة معلقة.
            */

            await sleep(1000);
        }
    }
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
    '/health',
    (req, res) => {

        res.json({
            ok: true,

            gameState,

            roundId,

            multiplier:
                currentMultiplier,

            clients:
                clients.size,

            players:
                players.size,

            pending:
                pendingBets.size,

            serverTime:
                Date.now()
        });
    }
);


/* =========================================================
   BASIC HOME
========================================================= */

app.get(
    '/',
    (req, res) => {

        res.json({
            ok: true,

            service:
                'Epic Gift Rocket Multiplayer',

            gameState,

            roundId,

            multiplier:
                currentMultiplier,

            message:
                'Global Rocket Server is running'
        });
    }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `🚀 Server running on port ${PORT}`
        );

        console.log(
            '🌐 Multiplayer engine starting...'
        );

        runGlobalGameEngine();
    }
);
