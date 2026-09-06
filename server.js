// =========================================================
// server.js - السيرفر الرئيسي المتكامل
// متوافق مع database.js ومع الـ Frontend القادم
// =========================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

// =========================================================
// استيراد قاعدة البيانات
// =========================================================
const {
    db,
    initDatabase,
    seedDatabase,
    query,
    get,
    run,
    transaction,
    findOrCreateUser,
    getUserBalance,
    updateUserBalance,
    getUserGifts,
    getGiftById,
    addGiftToUser,
    updateGiftStatus,
    placeGiftBet,
    cashoutGiftBet,
    placeTonBet,
    cashoutTonBet,
    openLootbox,
    createDeposit,
    updateDepositStatus,
    updateUserStats,
    createNotification,
    getNotifications
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// Middleware
// =========================================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// =========================================================
// 1. المصادقة والتحقق من Telegram
// =========================================================
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

function verifyTelegramData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();

        const computedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        return computedHash === hash;
    } catch (error) {
        console.error('Verification error:', error);
        return false;
    }
}

// =========================================================
// 2. Middleware للمصادقة
// =========================================================
async function authenticate(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        const user = await get('SELECT * FROM users WHERE id = ?', [token]);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'User not found' });
        }
        req.user = user;
        next();
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
}

// =========================================================
// 3. دوال حالة اللعبة (Game State)
// =========================================================
let currentGameState = {
    roundId: 1,
    phase: 'COUNTDOWN', // COUNTDOWN, FLIGHT, CRASH
    multiplier: 1.00,
    seconds: 5,
    history: []
};

// جلب الحالة الحالية
function getCurrentRoundId() {
    return currentGameState.roundId;
}

function getCurrentMultiplier() {
    return currentGameState.multiplier;
}

function getGamePhase() {
    return currentGameState.phase;
}

// تحديث الحالة (يتم استدعاؤها من حلقة اللعبة)
function updateGameState(newState) {
    currentGameState = { ...currentGameState, ...newState };
}

// =========================================================
// 4. حلقة اللعبة (Game Loop)
// =========================================================
function startGameLoop() {
    setInterval(() => {
        // محاكاة تقدم الجولة
        if (currentGameState.phase === 'FLIGHT') {
            currentGameState.multiplier += 0.01 + Math.random() * 0.02;
            currentGameState.multiplier = Math.round(currentGameState.multiplier * 100) / 100;
            
            // محاكاة التحطم العشوائي (احتمال 2%)
            if (Math.random() < 0.02 && currentGameState.multiplier > 1.5) {
                currentGameState.phase = 'CRASH';
                currentGameState.history.unshift(currentGameState.multiplier);
                if (currentGameState.history.length > 10) {
                    currentGameState.history.pop();
                }
                console.log(`💥 Round ${currentGameState.roundId} crashed at ${currentGameState.multiplier}x`);
                
                // بدء جولة جديدة بعد 3 ثوانٍ
                setTimeout(() => {
                    currentGameState.roundId++;
                    currentGameState.phase = 'COUNTDOWN';
                    currentGameState.multiplier = 1.00;
                    currentGameState.seconds = 5;
                    console.log(`🔄 Starting round ${currentGameState.roundId}`);
                }, 3000);
            }
        } else if (currentGameState.phase === 'COUNTDOWN') {
            currentGameState.seconds--;
            if (currentGameState.seconds <= 0) {
                currentGameState.phase = 'FLIGHT';
                currentGameState.multiplier = 1.00;
                console.log(`🚀 Round ${currentGameState.roundId} launched!`);
            }
        }
    }, 1000);
}

// =========================================================
// 5. API Routes
// =========================================================

// ===== 5.1 المصادقة =====
app.post('/api/auth', async (req, res) => {
    try {
        const { initData } = req.body;
        
        if (!initData) {
            return res.status(400).json({ ok: false, error: 'initData required' });
        }

        if (!verifyTelegramData(initData)) {
            return res.status(401).json({ ok: false, error: 'Invalid Telegram data' });
        }

        const params = new URLSearchParams(initData);
        const userData = JSON.parse(params.get('user'));
        
        const user = await findOrCreateUser(userData.id, {
            username: userData.username,
            first_name: userData.first_name,
            last_name: userData.last_name,
            avatar_url: userData.photo_url
        });

        // تحديث initData في قاعدة البيانات
        await run('UPDATE users SET init_data = ? WHERE id = ?', [initData, user.id]);

        res.json({ 
            ok: true, 
            user: {
                id: user.id,
                telegram_id: user.telegram_id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                avatar_url: user.avatar_url,
                balance: user.balance
            },
            token: user.id 
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.2 جلب حالة اللعبة =====
app.get('/api/game/state', authenticate, async (req, res) => {
    try {
        res.json({
            ok: true,
            state: {
                roundId: currentGameState.roundId,
                phase: currentGameState.phase,
                multiplier: currentGameState.multiplier,
                seconds: currentGameState.seconds,
                history: currentGameState.history
            }
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.3 جلب هدايا المستخدم =====
app.get('/api/gifts', authenticate, async (req, res) => {
    try {
        const gifts = await getUserGifts(req.user.id);
        res.json({ ok: true, gifts });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.4 جلب رصيد المستخدم =====
app.get('/api/balance', authenticate, async (req, res) => {
    try {
        const balance = await getUserBalance(req.user.id);
        res.json({ ok: true, balance });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.5 الرهان بالهدية =====
app.post('/api/bet/gift', authenticate, async (req, res) => {
    try {
        const { giftId, autoCashoutTarget } = req.body;
        
        if (!giftId) {
            return res.status(400).json({ ok: false, error: 'giftId required' });
        }

        // التحقق من أن الجولة في مرحلة COUNTDOWN
        if (currentGameState.phase !== 'COUNTDOWN') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN' });
        }

        const roundId = currentGameState.roundId;
        const result = await placeGiftBet(req.user.id, giftId, roundId, autoCashoutTarget);
        
        res.json({ 
            ok: true, 
            bet: result,
            roundId: roundId
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.6 سحب الهدية (Cash Out) =====
app.post('/api/cashout/gift', authenticate, async (req, res) => {
    try {
        const { betId } = req.body;
        
        if (!betId) {
            return res.status(400).json({ ok: false, error: 'betId required' });
        }

        // التحقق من أن الجولة في مرحلة FLIGHT
        if (currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Cashout only allowed during FLIGHT' });
        }

        const multiplier = currentGameState.multiplier;
        const result = await cashoutGiftBet(betId, req.user.id, multiplier);
        
        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'BET_WON',
            `🎉 You cashed out! ${result.payout.toFixed(2)} TON from gift`,
            { betId, payout: result.payout, multiplier: result.multiplier }
        );
        
        res.json({ 
            ok: true, 
            payout: result.payout, 
            multiplier: result.multiplier,
            giftValue: result.giftValue
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.7 الرهان بـ TON =====
app.post('/api/bet/ton', authenticate, async (req, res) => {
    try {
        const { amount, autoCashoutTarget } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid amount' });
        }

        // التحقق من أن الجولة في مرحلة COUNTDOWN
        if (currentGameState.phase !== 'COUNTDOWN') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN' });
        }

        const roundId = currentGameState.roundId;
        const result = await placeTonBet(req.user.id, amount, roundId, autoCashoutTarget);
        
        res.json({ 
            ok: true, 
            bet: result,
            roundId: roundId
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.8 سحب TON (Cash Out) =====
app.post('/api/cashout/ton', authenticate, async (req, res) => {
    try {
        const { betId } = req.body;
        
        if (!betId) {
            return res.status(400).json({ ok: false, error: 'betId required' });
        }

        // التحقق من أن الجولة في مرحلة FLIGHT
        if (currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Cashout only allowed during FLIGHT' });
        }

        const multiplier = currentGameState.multiplier;
        const result = await cashoutTonBet(betId, req.user.id, multiplier);
        
        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'BET_WON',
            `💰 You cashed out! ${result.payout.toFixed(2)} TON`,
            { betId, payout: result.payout, multiplier: result.multiplier }
        );
        
        res.json({ 
            ok: true, 
            payout: result.payout, 
            multiplier: result.multiplier,
            amount: result.amount
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.9 فتح صندوق الحظ =====
app.post('/api/lootbox/open', authenticate, async (req, res) => {
    try {
        const { boxId } = req.body;
        
        if (!boxId) {
            return res.status(400).json({ ok: false, error: 'boxId required' });
        }

        const result = await openLootbox(req.user.id, boxId);
        
        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'GIFT_WON',
            `🎁 You won ${result.gift.name} from ${result.boxName}!`,
            { giftId: result.gift.id, boxName: result.boxName }
        );
        
        res.json({ 
            ok: true, 
            gift: result.gift,
            userGiftId: result.userGiftId,
            boxName: result.boxName
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.10 إنشاء إيداع =====
app.post('/api/deposit/create', authenticate, async (req, res) => {
    try {
        const { walletAddress, amount, payload } = req.body;
        
        if (!walletAddress || !amount || amount <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid deposit data' });
        }

        const deposit = await createDeposit(req.user.id, walletAddress, amount, payload);
        res.json({ 
            ok: true, 
            deposit: {
                id: deposit.id,
                amount: deposit.amount,
                walletAddress: deposit.wallet_address,
                status: deposit.status,
                createdAt: deposit.created_at
            }
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.11 التحقق من حالة الإيداع =====
app.get('/api/deposit/status', authenticate, async (req, res) => {
    try {
        const { depositId } = req.query;
        
        if (!depositId) {
            return res.status(400).json({ ok: false, error: 'depositId required' });
        }

        const deposit = await get(
            'SELECT * FROM deposits WHERE id = ? AND user_id = ?', 
            [depositId, req.user.id]
        );
        
        if (!deposit) {
            return res.status(404).json({ ok: false, error: 'Deposit not found' });
        }
        
        res.json({ 
            ok: true, 
            deposit: {
                id: deposit.id,
                amount: deposit.amount,
                status: deposit.status,
                failureReason: deposit.failure_reason,
                createdAt: deposit.created_at,
                updatedAt: deposit.updated_at
            }
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.12 جلب إشعارات المستخدم =====
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const notifications = await getNotifications(req.user.id);
        res.json({ ok: true, notifications });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.13 جلب إحصائيات المستخدم =====
app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const stats = await get('SELECT * FROM user_stats WHERE user_id = ?', [req.user.id]);
        res.json({ ok: true, stats: stats || { total_rounds: 0, total_wins: 0, total_losses: 0 } });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.14 جلب جميع الهدايا المتاحة (للعرض) =====
app.get('/api/gifts/all', authenticate, async (req, res) => {
    try {
        const gifts = await query('SELECT * FROM gifts ORDER BY value DESC');
        res.json({ ok: true, gifts });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.15 جلب جميع الصناديق =====
app.get('/api/lootboxes', authenticate, async (req, res) => {
    try {
        const boxes = await query('SELECT * FROM lootboxes ORDER BY price ASC');
        res.json({ ok: true, boxes });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// =========================================================
// 6. بدء تشغيل السيرفر
// =========================================================
async function startServer() {
    try {
        // تهيئة قاعدة البيانات
        await initDatabase();
        await seedDatabase();
        console.log('✅ Database initialized and seeded');

        // بدء حلقة اللعبة
        startGameLoop();
        console.log('🎮 Game loop started');

        // بدء السيرفر
        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
            console.log(`📊 Database: rocket.db`);
            console.log(`🤖 BOT_TOKEN: ${BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE' ? '⚠️ NOT SET' : '✅ SET'}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

// =========================================================
// 7. التعامل مع إغلاق السيرفر
// =========================================================
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    db.close(() => {
        console.log('✅ Database closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down server...');
    db.close(() => {
        console.log('✅ Database closed');
        process.exit(0);
    });
});
