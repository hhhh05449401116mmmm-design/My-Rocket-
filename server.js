const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Address, beginCell, Cell } = require('@ton/core');

const app = express();

const PORT = process.env.PORT || 8080;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json({ limit: '1mb' }));

/*
==================================================
CONFIG
==================================================
*/

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SUPABASE_KEY =
    process.env.SUPABASE_KEY;

const TON_RECEIVER_ADDRESS =
    process.env.TON_RECEIVER_ADDRESS || '';

/*
Optional.
If not provided, TON Center still allows limited
requests. We scan every 15 seconds.
*/
const TONCENTER_API_KEY =
    process.env.TONCENTER_API_KEY || '';

const TONCENTER_BASE_URL =
    process.env.TONCENTER_BASE_URL ||
    'https://toncenter.com/api/v2';

if (!SUPABASE_URL || !SUPABASE_KEY) {

    console.error(
        '❌ Missing SUPABASE_URL or SUPABASE_KEY'
    );
}

if (!TON_RECEIVER_ADDRESS) {

    console.error(
        '❌ Missing TON_RECEIVER_ADDRESS'
    );
}

const supabase =
    SUPABASE_URL && SUPABASE_KEY
        ? createClient(
            SUPABASE_URL,
            SUPABASE_KEY,
            {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false
                }
            }
        )
        : null;

let normalizedReceiverAddress = null;

try {

    if (TON_RECEIVER_ADDRESS) {

        normalizedReceiverAddress =
            Address.parse(
                TON_RECEIVER_ADDRESS
            ).toRawString();
    }

} catch (error) {

    console.error(
        '❌ Invalid TON_RECEIVER_ADDRESS:',
        error.message
    );
}

/*
==================================================
GAME STATE
==================================================
*/

let roundId = 0;

let currentMultiplier = 1.00;

let gameState =
    'COUNTDOWN';

let countdownSeconds = 5;

const clients =
    new Set();

let history = [
    1.24,
    2.15,
    6.40,
    11.86,
    27.50
];

/*
==================================================
PLAYERS / BETS
==================================================
*/

const players =
    new Map();

/*
Player structure:

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
        status,
        payout,
        cashoutMultiplier
    }
}
*/

/*
==================================================
GENERAL HELPERS
==================================================
*/

function send(
    client,
    data
) {

    try {

        client.write(
            `data: ${JSON.stringify(data)}\n\n`
        );

    } catch {

        clients.delete(client);
    }
}

function roundMoney(
    value
) {

    const n =
        Number(value);

    if (
        !Number.isFinite(n)
    ) {
        return 0;
    }

    return Number(
        n.toFixed(4)
    );
}

function normalizeTonAddress(
    address
) {

    try {

        return Address.parse(
            String(address || '').trim()
        ).toRawString();

    } catch {

        return null;
    }
}

function isNumericTelegramId(
    id
) {

    return /^\d+$/.test(
        String(id || '')
    );
}

/*
==================================================
SUPABASE PLAYER HELPERS
==================================================
*/

async function loadPlayerFromDatabase(
    telegramId,
    name = 'اللاعب',
    avatar = ''
) {

    const id =
        String(telegramId);

    if (
        !supabase ||
        !isNumericTelegramId(id)
    ) {
        return null;
    }

    const numericId =
        Number(id);

    const {
        data,
        error
    } =
        await supabase
            .from('players')
            .select(
                'telegram_id, username, balance'
            )
            .eq(
                'telegram_id',
                numericId
            )
            .maybeSingle();

    if (error) {

        console.error(
            'SUPABASE LOAD PLAYER ERROR:',
            error
        );

        return null;
    }

    if (!data) {

        const {
            data: created,
            error: createError
        } =
            await supabase
                .from('players')
                .insert({
                    telegram_id:
                        numericId,

                    username:
                        name ||
                        'اللاعب',

                    balance: 0
                })
                .select(
                    'telegram_id, username, balance'
                )
                .single();

        if (createError) {

            console.error(
                'SUPABASE CREATE PLAYER ERROR:',
                createError
            );

            return null;
        }

        return {

            telegramId: id,

            name:
                name ||
                created.username ||
                'اللاعب',

            avatar:
                avatar ||
                '',

            balance:
                roundMoney(
                    created.balance
                ),

            currentBet:
                null
        };
    }

    return {

        telegramId: id,

        name:
            name ||
            data.username ||
            'اللاعب',

        avatar:
            avatar ||
            '',

        balance:
            roundMoney(
                data.balance
            ),

        currentBet:
            null
    };
}

async function savePlayerBalance(
    telegramId,
    balance,
    username = null
) {

    if (
        !supabase ||
        !isNumericTelegramId(
            telegramId
        )
    ) {
        return false;
    }

    const numericId =
        Number(telegramId);

    const payload = {

        telegram_id:
            numericId,

        balance:
            roundMoney(balance)
    };

    if (username) {

        payload.username =
            String(username)
                .slice(0, 100);
    }

    const {
        error
    } =
        await supabase
            .from('players')
            .upsert(
                payload,
                {
                    onConflict:
                        'telegram_id'
                }
            );

    if (error) {

        console.error(
            'SUPABASE SAVE BALANCE ERROR:',
            error
        );

        return false;
    }

    return true;
}

async function ensurePlayer(
    telegramId,
    name = 'اللاعب',
    avatar = ''
) {

    const id =
        String(telegramId);

    if (
        players.has(id)
    ) {

        const player =
            players.get(id);

        if (name) {
            player.name = name;
        }

        if (avatar) {
            player.avatar = avatar;
        }

        return player;
    }

    const dbPlayer =
        await loadPlayerFromDatabase(
            id,
            name,
            avatar
        );

    if (dbPlayer) {

        players.set(
            id,
            dbPlayer
        );

        return dbPlayer;
    }

    /*
    Guest is view-only.
    Real Telegram players must have a numeric ID.
    */

    const guestPlayer = {

        telegramId: id,

        name:
            name ||
            'اللاعب',

        avatar:
            avatar ||
            '',

        balance: 0,

        currentBet:
            null
    };

    players.set(
        id,
        guestPlayer
    );

    return guestPlayer;
}

async function refreshPlayerBalance(
    player
) {

    if (
        !supabase ||
        !isNumericTelegramId(
            player.telegramId
        )
    ) {
        return player;
    }

    const {
        data,
        error
    } =
        await supabase
            .from('players')
            .select(
                'balance, username'
            )
            .eq(
                'telegram_id',
                Number(
                    player.telegramId
                )
            )
            .maybeSingle();

    if (
        !error &&
        data
    ) {

        player.balance =
            roundMoney(
                data.balance
            );

        if (
            data.username &&
            !player.name
        ) {

            player.name =
                data.username;
        }
    }

    return player;
}

/*
==================================================
GAME HELPERS
==================================================
*/

function getPublicPlayers() {

    const result = [];

    for (
        const player
        of players.values()
    ) {

        if (
            !player.currentBet
        ) {
            continue;
        }

        if (
            player.currentBet.roundId !==
            roundId
        ) {
            continue;
        }

        result.push({

            telegramId:
                player.telegramId,

            name:
                player.name,

            avatar:
                player.avatar || '',

            amount:
                roundMoney(
                    player.currentBet.amount
                ),

            status:
                player.currentBet.status,

            multiplier:
                player.currentBet.status ===
                    'CASHED_OUT'
                    ? player.currentBet
                        .cashoutMultiplier
                    : null
        });
    }

    return result;
}

function getSelfState(
    telegramId
) {

    const player =
        players.get(
            String(telegramId)
        );

    if (
        !player ||
        !player.currentBet
    ) {

        return {
            state: 'none'
        };
    }

    const bet =
        player.currentBet;

    if (
        bet.roundId !==
        roundId
    ) {

        return {
            state: 'none'
        };
    }

    if (
        bet.status ===
        'ACTIVE'
    ) {

        return {

            state: 'active',

            amount:
                bet.amount,

            roundId:
                bet.roundId,

            autoCashout:
                bet.autoCashout,

            autoTarget:
                bet.autoTarget
        };
    }

    if (
        bet.status ===
        'CASHED_OUT'
    ) {

        return {

            state: 'win',

            amount:
                bet.amount,

            payout:
                bet.payout,

            multiplier:
                bet.cashoutMultiplier,

            roundId:
                bet.roundId
        };
    }

    if (
        bet.status ===
        'LOST'
    ) {

        return {

            state: 'lose',

            amount:
                bet.amount,

            roundId:
                bet.roundId
        };
    }

    return {
        state: 'none'
    };
}

function getState(
    type = gameState,
    telegramId = null
) {

    return {

        type,

        phase:
            gameState,

        roundId,

        seconds:
            countdownSeconds,

        multiplier:
            Number(
                currentMultiplier.toFixed(4)
            ),

        history,

        players:
            getPublicPlayers(),

        self:
            telegramId
                ? getSelfState(
                    telegramId
                )
                : null,

        serverTime:
            Date.now()
    };
}

function broadcast(
    type = gameState
) {

    for (
        const client
        of clients
    ) {

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

    for (
        const client
        of clients
    ) {

        send(
            client,
            {

                type:
                    'PLAYERS',

                players:
                    getPublicPlayers(),

                self:
                    getSelfState(
                        client.telegramId
                    ),

                serverTime:
                    Date.now()
            }
        );
    }
}

function sendBalance(
    client
) {

    const player =
        players.get(
            String(
                client.telegramId
            )
        );

    if (!player) {
        return;
    }

    send(
        client,
        {

            type:
                'BALANCE',

            balance:
                roundMoney(
                    player.balance
                ),

            serverTime:
                Date.now()
        }
    );
}

function sendBalanceToPlayer(
    telegramId
) {

    for (
        const client
        of clients
    ) {

        if (
            String(
                client.telegramId
            ) ===
            String(telegramId)
        ) {

            sendBalance(client);
        }
    }
}

/*
==================================================
TON DEPOSIT HELPERS
==================================================
*/

/*
Creates the same comment format that the frontend
will later put inside a TON comment cell.

Example:

rocket-deposit:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
*/

function createCommentPayload(
    commentText
) {

    return beginCell()
        .storeUint(
            0,
            32
        )
        .storeStringTail(
            String(commentText)
        )
        .endCell()
        .toBoc()
        .toString('base64');
}

/*
Read plaintext TON comment from a Cell.
TON comments use opcode 0 followed by UTF-8 text.
*/
function extractCommentFromCell(
    cell,
    maxDepth = 16
) {

    if (
        !cell ||
        maxDepth < 0
    ) {
        return null;
    }

    try {

        const slice =
            cell.beginParse();

        if (
            slice.remainingBits <
            32
        ) {
            return null;
        }

        const op =
            slice.loadUint(32);

        if (
            op !== 0
        ) {
            return null;
        }

        let text = '';

        function readSnake(
            currentSlice,
            depth
        ) {

            if (
                !currentSlice ||
                depth > maxDepth
            ) {
                return;
            }

            const bits =
                currentSlice.remainingBits;

            if (
                bits > 0
            ) {

                const byteLength =
                    Math.floor(
                        bits / 8
                    );

                if (
                    byteLength > 0
                ) {

                    const buffer =
                        currentSlice
                            .loadBuffer(
                                byteLength
                            );

                    text +=
                        buffer.toString(
                            'utf8'
                        );
                }
            }

            while (
                currentSlice.remainingRefs >
                0
            ) {

                const nextCell =
                    currentSlice.loadRef();

                readSnake(
                    nextCell.beginParse(),
                    depth + 1
                );
            }
        }

        readSnake(
            slice,
            0
        );

        return (
            text ||
            null
        );

    } catch {

        return null;
    }
}

function extractCommentFromMessage(
    message
) {

    if (!message) {
        return null;
    }

    /*
    Some TON Center responses expose
    decoded message text directly.
    */
    if (
        typeof message.message ===
        'string' &&
        message.message.trim()
    ) {

        return message.message.trim();
    }

    /*
    Raw message body.
    */
    if (
        typeof message
            .msg_data
            ?.body ===
        'string'
    ) {

        try {

            const cell =
                Cell.fromBase64(
                    message
                        .msg_data
                        .body
                );

            return extractCommentFromCell(
                cell
            );

        } catch {
            // Continue.
        }
    }

    /*
    Some indexed responses use message_content.
    */
    if (
        typeof message
            .message_content
            ?.body ===
        'string'
    ) {

        try {

            const cell =
                Cell.fromBase64(
                    message
                        .message_content
                        .body
                );

            return extractCommentFromCell(
                cell
            );

        } catch {
            // Continue.
        }
    }

    return null;
}

function toNanotons(
    tonAmount
) {

    const value =
        Number(tonAmount);

    if (
        !Number.isFinite(value) ||
        value <= 0
    ) {
        return null;
    }

    const fixed =
        value.toFixed(9);

    const parts =
        fixed.split('.');

    return (
        BigInt(parts[0]) *
        1000000000n +
        BigInt(
            parts[1] || '0'
        )
    );
}

function transactionHash(
    tx
) {

    return (
        tx?.transaction_id?.hash ||
        tx?.hash ||
        tx?.id?.hash ||
        null
    );
}

function transactionSucceeded(
    tx
) {

    /*
    Explicitly reject aborted transactions
    if this information is available.
    */

    if (
        tx?.description?.aborted ===
        true
    ) {
        return false;
    }

    if (
        tx?.description?.compute_ph?.success ===
        false
    ) {
        return false;
    }

    if (
        tx?.description?.action?.success ===
        false
    ) {
        return false;
    }

    return true;
}

async function fetchReceiverTransactions() {

    if (
        !TON_RECEIVER_ADDRESS
    ) {
        return [];
    }

    const url =
        new URL(
            `${TONCENTER_BASE_URL}/getTransactions`
        );

    url.searchParams.set(
        'address',
        TON_RECEIVER_ADDRESS
    );

    url.searchParams.set(
        'limit',
        '50'
    );

    const headers = {};

    if (
        TONCENTER_API_KEY
    ) {

        headers['X-API-Key'] =
            TONCENTER_API_KEY;
    }

    const response =
        await fetch(
            url,
            {
                method:
                    'GET',

                headers
            }
        );

    if (
        !response.ok
    ) {

        throw new Error(
            `TON Center HTTP ${response.status}`
        );
    }

    const json =
        await response.json();

    if (
        !json.ok
    ) {

        throw new Error(
            json.error ||
            'TON Center returned ok=false'
        );
    }

    return Array.isArray(
        json.result
    )
        ? json.result
        : [];
}

async function markDepositFailed(
    depositId,
    reason
) {

    if (!supabase) {
        return;
    }

    await supabase
        .from('deposits')
        .update({

            status:
                'failed',

            failure_reason:
                String(reason)
                    .slice(0, 500)

        })
        .eq(
            'id',
            depositId
        )
        .eq(
            'status',
            'pending'
        );
}

/*
==================================================
DEPOSIT CREDIT
==================================================
*/

async function creditConfirmedDeposit(
    deposit
) {

    if (!supabase) {

        throw new Error(
            'Supabase is not configured'
        );
    }

    const telegramId =
        Number(
            deposit.telegram_id
        );

    const amount =
        Number(
            deposit.amount
        );

    if (
        !Number.isSafeInteger(
            telegramId
        )
    ) {

        throw new Error(
            'Invalid telegram_id'
        );
    }

    if (
        !Number.isFinite(amount) ||
        amount <= 0
    ) {

        throw new Error(
            'Invalid deposit amount'
        );
    }

    const {
        data: player,
        error: playerError
    } =
        await supabase
            .from('players')
            .select(
                'telegram_id, username, balance'
            )
            .eq(
                'telegram_id',
                telegramId
            )
            .maybeSingle();

    if (playerError) {
        throw playerError;
    }

    let newBalance;

    if (!player) {

        newBalance =
            roundMoney(amount);

        const {
            error
        } =
            await supabase
                .from('players')
                .insert({

                    telegram_id:
                        telegramId,

                    username:
                        'اللاعب',

                    balance:
                        newBalance
                });

        if (error) {
            throw error;
        }

    } else {

        newBalance =
            roundMoney(
                Number(
                    player.balance || 0
                ) +
                amount
            );

        const {
            error
        } =
            await supabase
                .from('players')
                .update({

                    balance:
                        newBalance

                })
                .eq(
                    'telegram_id',
                    telegramId
                );

        if (error) {
            throw error;
        }
    }

    const {
        error: creditError
    } =
        await supabase
            .from('deposits')
            .update({

                status:
                    'credited',

                credited_at:
                    new Date()
                        .toISOString()

            })
            .eq(
                'id',
                deposit.id
            )
            .eq(
                'status',
                'confirmed'
            );

    if (creditError) {
        throw creditError;
    }

    const localPlayer =
        players.get(
            String(
                telegramId
            )
        );

    if (localPlayer) {

        localPlayer.balance =
            newBalance;

        sendBalanceToPlayer(
            telegramId
        );
    }

    return newBalance;
}

/*
==================================================
VERIFY ONE PENDING DEPOSIT
==================================================
*/

async function verifyOneDeposit(
    deposit,
    transactions
) {

    const expectedAmount =
        toNanotons(
            deposit.amount
        );

    const expectedWallet =
        normalizeTonAddress(
            deposit.wallet_address
        );

    if (!expectedAmount) {

        await markDepositFailed(
            deposit.id,
            'Invalid deposit amount'
        );

        return;
    }

    if (!expectedWallet) {

        await markDepositFailed(
            deposit.id,
            'Invalid wallet address'
        );

        return;
    }

    const expectedReceiver =
        normalizedReceiverAddress;

    if (!expectedReceiver) {
        return;
    }

    for (
        const tx
        of transactions
    ) {

        const txHash =
            transactionHash(tx);

        if (!txHash) {
            continue;
        }

        const inMsg =
            tx.in_msg;

        if (!inMsg) {
            continue;
        }

        const destination =
            normalizeTonAddress(
                inMsg.destination ||
                tx.account
            );

        if (
            !destination ||
            destination !==
                expectedReceiver
        ) {
            continue;
        }

        const source =
            normalizeTonAddress(
                inMsg.source
            );

        if (
            !source ||
            source !==
                expectedWallet
        ) {
            continue;
        }

        const value =
            BigInt(
                String(
                    inMsg.value ||
                    '0'
                )
            );

        if (
            value !==
            expectedAmount
        ) {
            continue;
        }

        if (
            !transactionSucceeded(tx)
        ) {
            continue;
        }

        const comment =
            extractCommentFromMessage(
                inMsg
            );

        /*
        IMPORTANT:
        The deposit ID is the full comment,
        e.g. rocket-deposit:UUID
        */
        if (
            comment !==
            deposit.deposit_id
        ) {
            continue;
        }

        /*
        Prevent reuse of an already credited
        blockchain transaction.
        */
        const {
            data: existingTx
        } =
            await supabase
                .from('deposits')
                .select(
                    'id, status'
                )
                .eq(
                    'tx_hash',
                    txHash
                )
                .maybeSingle();

        if (
            existingTx &&
            existingTx.id !==
                deposit.id
        ) {

            await markDepositFailed(
                deposit.id,
                'Transaction already used'
            );

            return;
        }

        /*
        Mark as detected.
        */
        const {
            error
        } =
            await supabase
                .from('deposits')
                .update({

                    tx_hash:
                        txHash,

                    status:
                        'detected',

                    detected_at:
                        new Date()
                            .toISOString()

                })
                .eq(
                    'id',
                    deposit.id
                )
                .eq(
                    'status',
                    'pending'
                );

        if (error) {

            console.error(
                'DEPOSIT DETECT UPDATE ERROR:',
                error
            );
        }

        return;
    }
}

/*
==================================================
CONFIRM DETECTED DEPOSITS
==================================================
*/

async function confirmDetectedDeposits() {

    if (!supabase) {
        return;
    }

    const {
        data: deposits,
        error
    } =
        await supabase
            .from('deposits')
            .select('*')
            .eq(
                'status',
                'detected'
            )
            .not(
                'tx_hash',
                'is',
                null
            )
            .order(
                'detected_at',
                {
                    ascending:
                        true
                }
            )
            .limit(20);

    if (error) {

        console.error(
            'LOAD DETECTED DEPOSITS ERROR:',
            error
        );

        return;
    }

    if (
        !deposits ||
        deposits.length === 0
    ) {
        return;
    }

    const transactions =
        await fetchReceiverTransactions();

    for (
        const deposit
        of deposits
    ) {

        const tx =
            transactions.find(
                item =>
                    transactionHash(
                        item
                    ) ===
                    deposit.tx_hash
            );

        if (!tx) {
            continue;
        }

        if (
            !transactionSucceeded(tx)
        ) {

            await supabase
                .from('deposits')
                .update({

                    status:
                        'failed',

                    failure_reason:
                        'Transaction is aborted'

                })
                .eq(
                    'id',
                    deposit.id
                )
                .eq(
                    'status',
                    'detected'
                );

            continue;
        }

        /*
        Verify the same sender, receiver,
        amount and comment again.
        */
        const inMsg =
            tx.in_msg;

        const source =
            normalizeTonAddress(
                inMsg?.source
            );

        const destination =
            normalizeTonAddress(
                inMsg?.destination ||
                tx.account
            );

        const expectedWallet =
            normalizeTonAddress(
                deposit.wallet_address
            );

        const expectedAmount =
            toNanotons(
                deposit.amount
            );

        const value =
            inMsg?.value != null
                ? BigInt(
                    String(
                        inMsg.value
                    )
                )
                : null;

        const comment =
            extractCommentFromMessage(
                inMsg
            );

        if (
            source !==
                expectedWallet ||

            destination !==
                normalizedReceiverAddress ||

            value !==
                expectedAmount ||

            comment !==
                deposit.deposit_id
        ) {

            continue;
        }

        const {
            error:
                confirmError
        } =
            await supabase
                .from('deposits')
                .update({

                    status:
                        'confirmed',

                    confirmed_at:
                        new Date()
                            .toISOString()

                })
                .eq(
                    'id',
                    deposit.id
                )
                .eq(
                    'status',
                    'detected'
                );

        if (confirmError) {

            console.error(
                'CONFIRM DEPOSIT ERROR:',
                confirmError
            );
        }
    }
}

/*
==================================================
CREDIT CONFIRMED DEPOSITS
==================================================
*/

async function creditConfirmedDeposits() {

    if (!supabase) {
        return;
    }

    const {
        data: deposits,
        error
    } =
        await supabase
            .from('deposits')
            .select('*')
            .eq(
                'status',
                'confirmed'
            )
            .not(
                'tx_hash',
                'is',
                null
            )
            .order(
                'confirmed_at',
                {
                    ascending:
                        true
                }
            )
            .limit(20);

    if (error) {

        console.error(
            'LOAD CONFIRMED DEPOSITS ERROR:',
            error
        );

        return;
    }

    for (
        const deposit
        of deposits || []
    ) {

        try {

            const transactions =
                await fetchReceiverTransactions();

            const tx =
                transactions.find(
                    item =>
                        transactionHash(
                            item
                        ) ===
                        deposit.tx_hash
                );

            if (!tx) {
                continue;
            }

            const inMsg =
                tx.in_msg;

            const source =
                normalizeTonAddress(
                    inMsg?.source
                );

            const destination =
                normalizeTonAddress(
                    inMsg?.destination ||
                    tx.account
                );

            const expectedWallet =
                normalizeTonAddress(
                    deposit.wallet_address
                );

            const expectedAmount =
                toNanotons(
                    deposit.amount
                );

            const value =
                inMsg?.value != null
                    ? BigInt(
                        String(
                            inMsg.value
                        )
                    )
                    : null;

            const comment =
                extractCommentFromMessage(
                    inMsg
                );

            if (
                source !==
                    expectedWallet ||

                destination !==
                    normalizedReceiverAddress ||

                value !==
                    expectedAmount ||

                comment !==
                    deposit.deposit_id ||

                !transactionSucceeded(tx)
            ) {
                continue;
            }

            await creditConfirmedDeposit(
                deposit
            );

        } catch (error) {

            console.error(
                'CREDIT DEPOSIT ERROR:',
                error
            );
        }
    }
}

/*
==================================================
DEPOSIT SCANNER
==================================================
*/

async function scanAndVerifyDeposits() {

    if (
        !supabase ||
        !normalizedReceiverAddress
    ) {
        return;
    }

    try {

        const {
            data: pending,
            error
        } =
            await supabase
                .from('deposits')
                .select('*')
                .eq(
                    'status',
                    'pending'
                )
                .order(
                    'created_at',
                    {
                        ascending:
                            true
                    }
                )
                .limit(50);

        if (error) {

            console.error(
                'LOAD PENDING DEPOSITS ERROR:',
                error
            );

            return;
        }

        if (
            pending &&
            pending.length > 0
        ) {

            const transactions =
                await fetchReceiverTransactions();

            for (
                const deposit
                of pending
            ) {

                try {

                    await verifyOneDeposit(
                        deposit,
                        transactions
                    );

                } catch (error) {

                    console.error(
                        'VERIFY DEPOSIT ERROR:',
                        error
                    );
                }
            }
        }

        await confirmDetectedDeposits();

        await creditConfirmedDeposits();

    } catch (error) {

        console.error(
            'DEPOSIT SCANNER ERROR:',
            error
        );
    }
}

/*
==================================================
DEPOSIT API
==================================================
*/

/*
Create a pending deposit.

Frontend will call this BEFORE opening
TON Wallet.

The server returns:
- receiver
- amountNano
- comment
- depositId
*/

app.post(
    '/api/deposit/create',
    async (req, res) => {

        try {

            if (!supabase) {

                return res.status(500).json({
                    ok: false,
                    error:
                        'Supabase is not configured'
                });
            }

            if (
                !normalizedReceiverAddress
            ) {

                return res.status(500).json({
                    ok: false,
                    error:
                        'TON receiver is not configured'
                });
            }

            const {
                telegramId,
                walletAddress,
                amount
            } =
                req.body || {};

            const id =
                String(
                    telegramId || ''
                );

            if (
                !isNumericTelegramId(id)
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'Valid telegramId is required'
                });
            }

            const normalizedWallet =
                normalizeTonAddress(
                    walletAddress
                );

            if (
                !normalizedWallet
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'Invalid TON wallet address'
                });
            }

            const tonAmount =
                Number(amount);

            if (
                !Number.isFinite(
                    tonAmount
                ) ||
                tonAmount <= 0
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'Invalid deposit amount'
                });
            }

            /*
            TON native precision = 9 decimals.
            */
            const amountString =
                tonAmount
                    .toFixed(9)
                    .replace(
                        /\.?0+$/,
                        ''
                    );

            const nano =
                toNanotons(
                    tonAmount
                );

            if (!nano) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'Invalid TON amount'
                });
            }

            const depositId =
                crypto.randomUUID();

            const depositComment =
                `rocket-deposit:${depositId}`;

            /*
            IMPORTANT:
            The database stores the UUID itself.
            The blockchain comment is rocket-deposit:UUID.
            */
            const {
                data,
                error
            } =
                await supabase
                    .from('deposits')
                    .insert({

                        telegram_id:
                            Number(id),

                        wallet_address:
                            normalizedWallet,

                        amount:
                            amountString,

                        status:
                            'pending'

                    })
                    .select(
                        'id, telegram_id, wallet_address, amount, status, created_at'
                    )
                    .single();

            if (error) {

                console.error(
                    'CREATE DEPOSIT ERROR:',
                    error
                );

                return res.status(500).json({
                    ok: false,
                    error:
                        'Could not create deposit'
                });
            }

            return res.json({

                ok: true,

                deposit:
                    data,

                /*
                Blockchain comment.
                */
                depositId:
                    data.id
                        ? `rocket-deposit:${data.id}`
                        : depositComment,

                receiver:
                    TON_RECEIVER_ADDRESS,

                amount:
                    amountString,

                amountNano:
                    nano.toString(),

                comment:
                    data.id
                        ? `rocket-deposit:${data.id}`
                        : depositComment
            });

        } catch (error) {

            console.error(
                'DEPOSIT CREATE ERROR:',
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
Get deposit status.
*/
app.get(
    '/api/deposit/status',
    async (req, res) => {

        try {

            if (!supabase) {

                return res.status(500).json({
                    ok: false,
                    error:
                        'Supabase is not configured'
                });
            }

            const telegramId =
                String(
                    req.query.telegramId ||
                    ''
                );

            const depositId =
                String(
                    req.query.depositId ||
                    ''
                );

            if (
                !isNumericTelegramId(
                    telegramId
                ) ||
                !depositId
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'telegramId and depositId are required'
                });
            }

            const {
                data,
                error
            } =
                await supabase
                    .from('deposits')
                    .select(
                        'id, telegram_id, wallet_address, amount, tx_hash, status, created_at, detected_at, confirmed_at, credited_at, failure_reason'
                    )
                    .eq(
                        'id',
                        depositId
                    )
                    .eq(
                        'telegram_id',
                        Number(
                            telegramId
                        )
                    )
                    .maybeSingle();

            if (error) {

                console.error(
                    'DEPOSIT STATUS ERROR:',
                    error
                );

                return res.status(500).json({
                    ok: false,
                    error:
                        'Could not read deposit'
                });
            }

            if (!data) {

                return res.status(404).json({
                    ok: false,
                    error:
                        'Deposit not found'
                });
            }

            return res.json({

                ok: true,

                deposit:
                    data
            });

        } catch (error) {

            console.error(
                'DEPOSIT STATUS EXCEPTION:',
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
HOME
==================================================
*/

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

            players:
                players.size,

            tonReceiverConfigured:
                Boolean(
                    normalizedReceiverAddress
                ),

            supabaseConfigured:
                Boolean(
                    supabase
                )
        });
    }
);

/*
==================================================
HEALTH
==================================================
*/

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

            tonReceiverConfigured:
                Boolean(
                    normalizedReceiverAddress
                ),

            supabaseConfigured:
                Boolean(
                    supabase
                )
        });
    }
);

/*
==================================================
GAME STREAM
==================================================
*/

app.get(
    '/api/game-stream',
    async (req, res) => {

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

        if (
            res.flushHeaders
        ) {

            res.flushHeaders();
        }

        const player =
            await ensurePlayer(
                telegramId,
                name,
                avatar
            );

        if (
            isNumericTelegramId(
                telegramId
            )
        ) {

            await refreshPlayerBalance(
                player
            );
        }

        res.telegramId =
            telegramId;

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

                clients.delete(
                    res
                );
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
    async (req, res) => {

        try {

            const {
                type,
                telegramId,
                name,
                avatar,
                amount,
                roundId:
                    requestedRoundId,
                autoCashout,
                autoTarget
            } =
                req.body || {};

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

            if (
                !isNumericTelegramId(id)
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        'A real Telegram user id is required'
                });
            }

            const player =
                await ensurePlayer(
                    id,
                    name ||
                        'اللاعب',
                    avatar ||
                        ''
                );

            /*
            Refresh from Supabase before betting.
            */
            await refreshPlayerBalance(
                player
            );

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

            if (
                type ===
                'BET'
            ) {

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
                    ) !==
                    roundId
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
                    player.currentBet.roundId ===
                        roundId &&
                    (
                        player.currentBet.status ===
                            'ACTIVE' ||
                        player.currentBet.status ===
                            'CASHED_OUT'
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

                const newBalance =
                    roundMoney(
                        player.balance -
                        betAmount
                    );

                const saved =
                    await savePlayerBalance(
                        id,
                        newBalance,
                        player.name
                    );

                if (!saved) {

                    return res.status(500).json({
                        ok: false,
                        error:
                            'Could not update balance'
                    });
                }

                player.balance =
                    newBalance;

                player.currentBet = {

                    roundId,

                    amount:
                        roundMoney(
                            betAmount
                        ),

                    autoCashout:
                        Boolean(
                            autoCashout
                        ),

                    autoTarget:
                        Number(
                            autoTarget
                        ) ||
                        null,

                    status:
                        'ACTIVE',

                    payout:
                        0,

                    cashoutMultiplier:
                        null
                };

                broadcastPlayers();

                sendBalanceToPlayer(
                    id
                );

                return res.json({

                    ok: true,

                    action:
                        'BET',

                    roundId,

                    amount:
                        roundMoney(
                            betAmount
                        ),

                    balance:
                        player.balance
                });
            }

            /*
            ======================================
            CASHOUT
            ======================================
            */

            if (
                type ===
                'CASHOUT'
            ) {

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
                    ) !==
                    roundId
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
                    bet.roundId !==
                        roundId ||
                    bet.status !==
                        'ACTIVE'
                ) {

                    return res.status(400).json({
                        ok: false,
                        error:
                            'No active bet'
                    });
                }

                const cashoutMultiplier =
                    Number(
                        currentMultiplier.toFixed(
                            4
                        )
                    );

                const payout =
                    roundMoney(
                        bet.amount *
                        cashoutMultiplier
                    );

                const newBalance =
                    roundMoney(
                        player.balance +
                        payout
                    );

                const saved =
                    await savePlayerBalance(
                        id,
                        newBalance,
                        player.name
                    );

                if (!saved) {

                    return res.status(500).json({
                        ok: false,
                        error:
                            'Could not update balance'
                    });
                }

                player.balance =
                    newBalance;

                bet.status =
                    'CASHED_OUT';

                bet.cashoutMultiplier =
                    cashoutMultiplier;

                bet.payout =
                    payout;

                broadcastPlayers();

                sendBalanceToPlayer(
                    id
                );

                return res.json({

                    ok: true,

                    action:
                        'CASHOUT',

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

setInterval(
    () => {

        for (
            const client
            of clients
        ) {

            try {

                client.write(
                    `: heartbeat ${Date.now()}\n\n`
                );

            } catch {

                clients.delete(
                    client
                );
            }
        }

    },
    15000
);

/*
==================================================
CRASH POINT
==================================================
*/

function generateCrashPoint() {

    const r =
        Math.random();

    if (
        r < 0.70
    ) {

        return Number(
            (
                1.01 +
                Math.random() *
                0.78
            ).toFixed(2)
        );
    }

    if (
        r < 0.99
    ) {

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

    countdownSeconds =
        5;

    currentMultiplier =
        1.00;

    for (
        const player
        of players.values()
    ) {

        if (
            player.currentBet &&
            player.currentBet.roundId !==
                roundId
        ) {

            player.currentBet =
                null;
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
                    countdownSeconds >
                    0
                ) {

                    broadcast(
                        'COUNTDOWN'
                    );

                    return;
                }

                clearInterval(
                    timer
                );

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
            async () => {

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
                        bet.roundId !==
                            roundId ||
                        bet.status !==
                            'ACTIVE'
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
                                bet.autoTarget.toFixed(
                                    4
                                )
                            );

                        const payout =
                            roundMoney(
                                bet.amount *
                                multiplier
                            );

                        const newBalance =
                            roundMoney(
                                player.balance +
                                payout
                            );

                        const saved =
                            await savePlayerBalance(
                                player.telegramId,
                                newBalance,
                                player.name
                            );

                        if (!saved) {

                            console.error(
                                'AUTO CASHOUT BALANCE SAVE FAILED:',
                                player.telegramId
                            );

                            continue;
                        }

                        player.balance =
                            newBalance;

                        bet.status =
                            'CASHED_OUT';

                        bet.cashoutMultiplier =
                            multiplier;

                        bet.payout =
                            payout;

                        sendBalanceToPlayer(
                            player.telegramId
                        );
                    }
                }

                /*
                ==================================
                CRASH
                ==================================
                */

                if (
                    currentMultiplier >=
                    crashPoint
                ) {

                    clearInterval(
                        timer
                    );

                    currentMultiplier =
                        crashPoint;

                    gameState =
                        'CRASH';

                    /*
                    Remaining active bets lose.
                    The stake was already deducted
                    when BET was accepted.
                    */

                    for (
                        const player
                        of players.values()
                    ) {

                        const bet =
                            player.currentBet;

                        if (
                            bet &&
                            bet.roundId ===
                                roundId &&
                            bet.status ===
                                'ACTIVE'
                        ) {

                            bet.status =
                                'LOST';
                        }
                    }

                    history.unshift(
                        crashPoint
                    );

                    if (
                        history.length >
                        5
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

                        sendBalance(
                            client
                        );
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
DEPOSIT SCANNER TIMER
==================================================
*/

let depositScanRunning =
    false;

setInterval(
    async () => {

        if (
            depositScanRunning
        ) {
            return;
        }

        depositScanRunning =
            true;

        try {

            await scanAndVerifyDeposits();

        } catch (error) {

            console.error(
                'DEPOSIT SCANNER UNHANDLED ERROR:',
                error
            );

        } finally {

            depositScanRunning =
                false;
        }

    },
    15000
);

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

        console.log(
            `💰 TON receiver configured: ${
                Boolean(
                    normalizedReceiverAddress
                )
            }`
        );

        console.log(
            `🗄️ Supabase configured: ${
                Boolean(
                    supabase
                )
            }`
        );

        runCountdown();

        /*
        First deposit scan shortly after startup.
        */

        setTimeout(
            async () => {

                if (
                    depositScanRunning
                ) {
                    return;
                }

                depositScanRunning =
                    true;

                try {

                    await scanAndVerifyDeposits();

                } catch (error) {

                    console.error(
                        'INITIAL DEPOSIT SCAN ERROR:',
                        error
                    );

                } finally {

                    depositScanRunning =
                        false;
                }

            },
            5000
        );
    }
);
