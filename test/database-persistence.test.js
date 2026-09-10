'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-persist-'));

require('../test-helpers/no-network');

// Loads a fresh database module instance bound to the given DATABASE_PATH.
function loadDatabaseAt(databasePath) {
    process.env.DATABASE_PATH = databasePath;
    delete require.cache[require.resolve('../database')];
    return require('../database');
}

function closeDatabase(databaseModule) {
    return new Promise((resolve, reject) => {
        databaseModule.db.close(error => error ? reject(error) : resolve());
    });
}

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('DATABASE_PATH pointing at a not-yet-existing mounted directory is created automatically', async () => {
    // Mirrors Railway's /data volume path before the directory exists in the container.
    const mountedDir = path.join(tempRoot, 'data-not-created-yet');
    const databasePath = path.join(mountedDir, 'rocket.db');
    assert.equal(fs.existsSync(mountedDir), false, 'precondition: directory must not exist yet');

    const databaseModule = loadDatabaseAt(databasePath);
    await databaseModule.initDatabase();

    assert.equal(fs.existsSync(mountedDir), true, 'parent directory must be created for the volume path');
    assert.equal(fs.existsSync(databasePath), true, 'sqlite file must be created at DATABASE_PATH');

    await closeDatabase(databaseModule);
});

test('data written at DATABASE_PATH survives reopening the same file (volume persistence)', async () => {
    const databasePath = path.join(tempRoot, 'persistent', 'rocket.db');

    const firstSession = loadDatabaseAt(databasePath);
    await firstSession.initDatabase();
    const createdUser = await firstSession.findOrCreateUser('persistence-check-user');
    await firstSession.updateUserBalance(createdUser.id, 12.5, 'add');
    await firstSession.savePersistedBusinessConnection({
        connectionId: 'persisted-connection-for-test',
        businessUserId: 'business-user-for-test',
        canViewGiftsAndStars: true,
        isEnabled: true
    });
    await closeDatabase(firstSession);

    // Simulates a Railway restart/redeploy: brand new process, same mounted file.
    const secondSession = loadDatabaseAt(databasePath);
    await secondSession.initDatabase();

    const survivingUser = await secondSession.get('SELECT * FROM users WHERE telegram_id = ?', ['persistence-check-user']);
    assert.ok(survivingUser, 'user must survive a restart when DATABASE_PATH is on a persistent volume');
    assert.equal(survivingUser.balance, 12.5, 'balance must survive the restart');

    const survivingConnection = await secondSession.getPersistedBusinessConnection();
    assert.ok(survivingConnection, 'business connection must survive the restart');
    assert.equal(survivingConnection.can_view_gifts_and_stars, 1);
    assert.equal(survivingConnection.is_enabled, 1);

    await closeDatabase(secondSession);
});

test('default local behaviour is unchanged when DATABASE_PATH is not set', async () => {
    delete process.env.DATABASE_PATH;
    delete require.cache[require.resolve('../database')];
    const databaseModule = require('../database');

    // Falls back to the repository-local rocket.db exactly as before the persistence change.
    const expectedDefault = path.join(path.dirname(require.resolve('../database')), 'rocket.db');
    assert.equal(fs.existsSync(expectedDefault), true, 'default local rocket.db path must still be used');

    await closeDatabase(databaseModule);
});
