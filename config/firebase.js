const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

let db = null;

try {
  let serviceAccount = null;

  // 1. Try environment variable FIREBASE_SERVICE_ACCOUNT
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;
    } catch (e) {
      console.warn('⚠️ Could not parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
    }
  }

  // 2. Fall back to local firebase-key.json file if exists
  if (!serviceAccount) {
    let serviceAccountPath = path.join(__dirname, '..', 'firebase-key.json');
    if (!fs.existsSync(serviceAccountPath)) {
      const doubleExtPath = path.join(__dirname, '..', 'firebase-key.json.json');
      if (fs.existsSync(doubleExtPath)) {
        serviceAccountPath = doubleExtPath;
      }
    }

    if (fs.existsSync(serviceAccountPath)) {
      try {
        serviceAccount = require(serviceAccountPath);
      } catch (e) {
        console.warn('⚠️ Could not require firebase key file:', e.message);
      }
    }
  }

  // 3. Initialize Firebase if credentials exist
  if (serviceAccount && admin.getApps().length === 0) {
    admin.initializeApp({
      credential: admin.cert(serviceAccount)
    });
  }

  if (admin.getApps().length > 0) {
    db = typeof admin.firestore === 'function' ? admin.firestore() : getFirestore();
  } else {
    console.warn('⚠️ Firebase Admin not initialized (no service account found). Local fallback enabled.');
  }
} catch (err) {
  console.error('⚠️ Firebase Initialization Error:', err.message);
}

module.exports = { db, admin };

