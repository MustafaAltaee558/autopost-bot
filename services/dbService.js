const fs = require('fs');
const path = require('path');
const { db } = require('../config/firebase');

const DB_PATH = path.join(__dirname, '..', 'data', 'users.json');
let inMemoryStore = { users: {} };

function ensureDbExists() {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({ users: {} }, null, 2), 'utf-8');
    }
  } catch (err) {
    // Read-only filesystem (e.g. Vercel serverless environment)
  }
}

function readDb() {
  ensureDbExists();
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed.users) parsed.users = {};
      inMemoryStore = parsed;
      return parsed;
    }
  } catch (err) {
    console.warn('⚠️ Error reading users.json database, using memory fallback:', err.message);
  }
  return inMemoryStore;
}

function writeDb(data) {
  inMemoryStore = data;
  try {
    ensureDbExists();
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    // Read-only filesystem on Vercel
    return true;
  }
}

// Save document to Firestore asynchronously
async function saveToFirestore(userId, userData) {
  if (!db) return;
  try {
    const usersCol = db.collection('users');
    await usersCol.doc(String(userId)).set(userData, { merge: true });
  } catch (err) {
    console.error(`⚠️ خطأ أثناء كتابة بيانات المستخدم ${userId} في Firestore:`, err.message);
  }
}

// Initial Sync from Firestore at app startup
(async function syncFromFirestore() {
  if (!db) return;
  try {
    const usersCol = db.collection('users');
    const snapshot = await usersCol.get();
    const localData = readDb();
    let count = 0;
    snapshot.forEach(doc => {
      localData.users[doc.id] = { ...localData.users[doc.id], ...doc.data(), id: doc.id };
      count++;
    });
    writeDb(localData);
    console.log(`🔥 تم المزامنة بنجاح من Firebase Firestore (${count} مستخدم).`);
  } catch (err) {
    console.error('⚠️ تعذر جلب المستخدمين من Firebase Firestore عند البدء:', err.message);
  }
})();

function getAllUsers() {
  const localDb = readDb();
  return Object.values(localDb.users);
}

function getUser(id) {
  const localDb = readDb();
  return localDb.users[String(id)] || null;
}

function getOrCreateUser(telegramId, userInfo = {}) {
  const localDb = readDb();
  const key = String(telegramId);
  const now = new Date().toISOString();

  let user = localDb.users[key];

  if (!user) {
    user = {
      id: key,
      username: userInfo.username || '',
      first_name: userInfo.first_name || 'مستخدم',
      balance: 3, // 3 initial test posts
      subscription: 'free', // 'free' | 'starter' | 'pro' | 'enterprise'
      status: 'active', // 'active' | 'frozen'
      connectedPlatforms: [],
      createdAt: now,
      lastActive: now,
    };
    localDb.users[key] = user;
    writeDb(localDb);
    saveToFirestore(key, user);
  } else {
    let modified = false;
    if (userInfo.username && user.username !== userInfo.username) {
      user.username = userInfo.username;
      modified = true;
    }
    if (userInfo.first_name && user.first_name !== userInfo.first_name) {
      user.first_name = userInfo.first_name;
      modified = true;
    }
    if (!Array.isArray(user.connectedPlatforms)) {
      user.connectedPlatforms = [];
      modified = true;
    }
    user.lastActive = now;
    localDb.users[key] = user;
    if (modified) writeDb(localDb);
    saveToFirestore(key, user);
  }

  return user;
}

function updateUser(id, updates) {
  const localDb = readDb();
  const key = String(id);
  if (!localDb.users[key]) return null;

  localDb.users[key] = {
    ...localDb.users[key],
    ...updates,
    lastActive: new Date().toISOString(),
  };

  const updatedUser = localDb.users[key];
  writeDb(localDb);
  saveToFirestore(key, updatedUser);
  return updatedUser;
}

function deductBalance(id, amount) {
  const localDb = readDb();
  const key = String(id);
  const user = localDb.users[key];
  if (!user) return false;

  if (user.subscription === 'enterprise') {
    user.lastActive = new Date().toISOString();
    writeDb(localDb);
    saveToFirestore(key, user);
    return true;
  }

  if (user.balance < amount) {
    return false;
  }

  user.balance -= amount;
  user.lastActive = new Date().toISOString();
  writeDb(localDb);
  saveToFirestore(key, user);
  return true;
}

function quickActivateUser(id, tier = 'pro') {
  const localDb = readDb();
  const key = String(id);
  if (!localDb.users[key]) return null;

  const user = localDb.users[key];
  user.status = 'active';

  if (tier === 'starter') {
    user.subscription = 'starter';
    user.balance = (user.balance || 0) + 30;
  } else if (tier === 'enterprise') {
    user.subscription = 'enterprise';
    user.balance = 999999;
  } else {
    user.subscription = 'pro';
    user.balance = (user.balance || 0) + 150;
  }

  user.lastActive = new Date().toISOString();
  writeDb(localDb);
  saveToFirestore(key, user);
  return user;
}

function toggleUserStatus(id) {
  const localDb = readDb();
  const key = String(id);
  if (!localDb.users[key]) return null;

  localDb.users[key].status = localDb.users[key].status === 'frozen' ? 'active' : 'frozen';
  localDb.users[key].lastActive = new Date().toISOString();

  const updatedUser = localDb.users[key];
  writeDb(localDb);
  saveToFirestore(key, updatedUser);
  return updatedUser;
}

/**
 * Platform Binding Logic
 */
function connectPlatform(id, platformKey) {
  const localDb = readDb();
  const key = String(id);
  const user = localDb.users[key];
  if (!user) return { success: false, reason: 'not_found' };

  if (!Array.isArray(user.connectedPlatforms)) {
    user.connectedPlatforms = [];
  }

  // Tier limit check:
  // Starter (and free): max 1 platform
  // Pro / Enterprise: unlimited (up to 4)
  const maxAllowed = (user.subscription === 'starter' || user.subscription === 'free') ? 1 : 4;

  if (user.connectedPlatforms.includes(platformKey)) {
    return { success: true, message: 'المنصة مربوكة بالفعل', platforms: user.connectedPlatforms };
  }

  if (user.connectedPlatforms.length >= maxAllowed) {
    return {
      success: false,
      reason: 'tier_limit',
      maxAllowed,
      currentCount: user.connectedPlatforms.length,
    };
  }

  user.connectedPlatforms.push(platformKey);
  user.lastActive = new Date().toISOString();

  writeDb(localDb);
  saveToFirestore(key, user);

  return { success: true, platforms: user.connectedPlatforms };
}

function disconnectPlatform(id, platformKey) {
  const localDb = readDb();
  const key = String(id);
  const user = localDb.users[key];
  if (!user) return { success: false, reason: 'not_found' };

  if (!Array.isArray(user.connectedPlatforms)) {
    user.connectedPlatforms = [];
  }

  user.connectedPlatforms = user.connectedPlatforms.filter(p => p !== platformKey);
  user.lastActive = new Date().toISOString();

  writeDb(localDb);
  saveToFirestore(key, user);

  return { success: true, platforms: user.connectedPlatforms };
}

function removeConnectedAccount(id, pageId) {
  const localDb = readDb();
  const key = String(id);
  const user = localDb.users[key];
  if (!user) return { success: false, reason: 'not_found' };

  if (!Array.isArray(user.connectedAccounts)) {
    user.connectedAccounts = [];
  }

  user.connectedAccounts = user.connectedAccounts.filter(acc => acc.pageId !== pageId && acc.igAccountId !== pageId);
  user.lastActive = new Date().toISOString();

  writeDb(localDb);
  saveToFirestore(key, user);

  return { success: true, connectedAccounts: user.connectedAccounts };
}

function saveConnectedAccount(id, accountData) {
  const localDb = readDb();
  const key = String(id);
  const user = localDb.users[key];
  if (!user) return { success: false, reason: 'not_found' };

  if (!Array.isArray(user.connectedAccounts)) {
    user.connectedAccounts = [];
  }

  // Tier check for connected accounts count
  const maxAllowed = (user.subscription === 'starter' || user.subscription === 'free') ? 1 : 10;
  
  const existingIndex = user.connectedAccounts.findIndex(acc => 
    (accountData.pageId && acc.pageId === accountData.pageId) ||
    (accountData.igAccountId && acc.igAccountId === accountData.igAccountId)
  );

  if (existingIndex >= 0) {
    user.connectedAccounts[existingIndex] = {
      ...user.connectedAccounts[existingIndex],
      ...accountData,
      updatedAt: new Date().toISOString(),
    };
  } else {
    if (user.connectedAccounts.length >= maxAllowed) {
      return {
        success: false,
        reason: 'tier_limit',
        maxAllowed,
        currentCount: user.connectedAccounts.length,
      };
    }
    user.connectedAccounts.push({
      ...accountData,
      createdAt: new Date().toISOString(),
    });
  }

  user.lastActive = new Date().toISOString();
  writeDb(localDb);
  saveToFirestore(key, user);

  return { success: true, connectedAccounts: user.connectedAccounts };
}

module.exports = {
  getAllUsers,
  getUser,
  getOrCreateUser,
  updateUser,
  deductBalance,
  quickActivateUser,
  toggleUserStatus,
  connectPlatform,
  disconnectPlatform,
  saveConnectedAccount,
  removeConnectedAccount,
};
