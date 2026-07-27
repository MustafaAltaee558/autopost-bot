const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

// Determine path to service account key
let serviceAccountPath = path.join(__dirname, '..', 'firebase-key.json');
if (!fs.existsSync(serviceAccountPath)) {
  const doubleExtPath = path.join(__dirname, '..', 'firebase-key.json.json');
  if (fs.existsSync(doubleExtPath)) {
    serviceAccountPath = doubleExtPath;
  }
}

const serviceAccount = require(serviceAccountPath);

// Initialize Firebase Admin SDK if not already initialized
if (admin.getApps().length === 0) {
  admin.initializeApp({
    credential: admin.cert(serviceAccount)
  });
}

const db = typeof admin.firestore === 'function' ? admin.firestore() : getFirestore();

module.exports = { db, admin };
